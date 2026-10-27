// @ts-nocheck
/**
 * 分片完整性核对
 * ============================================================================
 * 为什么需要它：抓取器允许"分片 = 持久化单位 = 进度单位"，前提是**只有一个写者**。
 * 实际上我不小心同时跑了**两个**抓取进程（都带同一个进度文件），
 * 于是可能出现：A 写完一个分片的前半、B 写完后半，谁后写谁覆盖 ——
 * **进度说"完成"，文件里却有一段是零**。
 *
 * 这正是本项目反复出现的那类问题（"已完成 ⟺ 已落盘"被破坏），
 * 所以必须能**独立核对**，而不是相信进度文件。
 *
 * 判据（对每个分片、每一批）：
 *   · 该批标记为完成时，这 500 条记录里**至少有 1 条非零**（否则整批是零 = 没写进去）；
 *   · 全零批的比例为 0（允许极少数"真的一篇都没引用"的批，但那也该有 year 非零）。
 *
 * 用法：node pipeline/verify-cites-integrity.mjs [--fix]
 *   --fix：把有问题的分片对应的批从进度里删掉，让它们重抓。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DOMAINS } from "../src/data/domains.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const SRC = join(ROOT, "data", "cites");
const REC = 8;
const BATCH = 500;
const BATCHES_PER_PART = 20;
const FIX = process.argv.includes("--fix");

const log = (m) => process.stdout.write(`${m}\n`);

let totalShards = 0;
let badShards = 0;
let badBatches = 0;
const report = [];

for (const d of DOMAINS) {
  const progPath = join(SRC, `${d.id}.progress.json`);
  if (!existsSync(progPath)) continue;
  const prog = JSON.parse(readFileSync(progPath, "utf8")).done ?? {};
  const doneBatches = Object.keys(prog).map(Number);
  if (doneBatches.length === 0) continue;

  // 按分片分组
  const byPart = new Map();
  for (const b of doneBatches) {
    const p = Math.floor(b / BATCHES_PER_PART);
    if (!byPart.has(p)) byPart.set(p, []);
    byPart.get(p).push(b);
  }

  const badParts = [];
  for (const [partIdx, batches] of [...byPart.entries()].sort((a, b) => a[0] - b[0])) {
    const f = join(SRC, `${d.id}.part${String(partIdx).padStart(4, "0")}.bin`);
    totalShards++;
    if (!existsSync(f)) {
      // 分片不存在但进度说完成了 —— 抓取器启动时的清理会处理，这里只报
      badParts.push(partIdx);
      badShards++;
      continue;
    }
    const buf = readFileSync(f);
    const firstBatch = partIdx * BATCHES_PER_PART;
    let partBad = 0;
    for (const b of batches) {
      const off = (b - firstBatch) * BATCH;
      let nonZero = 0;
      let at = off * REC;
      for (let i = 0; i < BATCH; i++, at += REC) {
        if (at + REC > buf.length) break;
        // 引用数或年份任一非零 = 这批真的写进去了
        if (buf.readUInt32LE(at) > 0 || buf.readUInt16LE(at + 4) > 0) nonZero++;
      }
      if (nonZero === 0) {
        partBad++;
        badBatches++;
      }
    }
    if (partBad > 0) {
      badShards++;
      badParts.push(partIdx);
      report.push(`  ${d.id} 分片 ${partIdx}：已标完成的 ${batches.length} 批里有 ${partBad} 批**整批全零**`);
    }
  }
}

log(`核对了 ${totalShards} 个分片`);
if (badBatches === 0) {
  log(`✓ 没有发现"标了完成但整批全零"的批 —— 进度可信`);
  process.exit(0);
}
log(`\n✗ 发现 ${badBatches} 个可疑批（分布在 ${badShards} 个分片）：`);
for (const r of report) log(r);

if (FIX) {
  log(`\n--fix：把这些批从进度里删掉，它们会被重抓`);
  let removed = 0;
  for (const d of DOMAINS) {
    const progPath = join(SRC, `${d.id}.progress.json`);
    if (!existsSync(progPath)) continue;
    const prog = JSON.parse(readFileSync(progPath, "utf8"));
    const done = prog.done ?? {};
    // 重新按上面的判据找坏批
    const byPart = new Map();
    for (const b of Object.keys(done).map(Number)) {
      const p = Math.floor(b / BATCHES_PER_PART);
      if (!byPart.has(p)) byPart.set(p, []);
      byPart.get(p).push(b);
    }
    for (const [partIdx, batches] of byPart) {
      const f = join(SRC, `${d.id}.part${String(partIdx).padStart(4, "0")}.bin`);
      const firstBatch = partIdx * BATCHES_PER_PART;
      const buf = existsSync(f) ? readFileSync(f) : null;
      for (const b of batches) {
        let nonZero = 0;
        if (buf) {
          const off = (b - firstBatch) * BATCH;
          let at = off * REC;
          for (let i = 0; i < BATCH; i++, at += REC) {
            if (at + REC > buf.length) break;
            if (buf.readUInt32LE(at) > 0 || buf.readUInt16LE(at + 4) > 0) nonZero++;
          }
        }
        if (nonZero === 0) {
          delete done[b];
          removed++;
        }
      }
    }
    writeFileSync(progPath, JSON.stringify({ ...prog, done }));
  }
  log(`  已删掉 ${removed} 个批的完成标记（重跑抓取器会自动补）`);
}
process.exit(1);
