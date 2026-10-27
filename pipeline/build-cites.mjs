// @ts-nocheck
/**
 * 论文云 · 把抓到的引用数据整理成前端用的定长表
 * ============================================================================
 * 输入 `data/cites/<domain>.bin`（抓取器的原始产物：每篇 8 字节，按 docId 索引）
 * 输出 `public/data/cites/<domain>.bin`（加 24 字节头，带统计量）
 *
 *     magic "LUNYCITE"(8) | count(u32) | maxCites(u32) | coveragePct×100(u32) | scaleCites(u32)
 *     然后 count × 8 字节：u32 cites | u16 year | u8 venueTier | u8 flags
 *
 * ## 为什么要在构建期算 `scaleCites`（亮度归一化基准）
 *
 * 绘制时每颗星都要算一次亮度，**不能在那里遍历全库求分位**。
 * 所以在构建期算好一个基准写进头部，运行时只做一次除法。
 *
 * 基准取**第 99 百分位**而不是最大值：实测最高 196,853，而中位数是 0 ——
 * 用最大值归一化会让除极少数几篇之外**全部论文挤在接近 0 的位置**，
 * 等于没有编码。用 P99 之后绝大多数论文落在可分辨区间，
 * 极少数超高分只是"亮到顶"（那正是我们想要的观感）。
 *
 * 用法：node pipeline/build-cites.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants as zc } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DOMAINS } from "../src/data/domains.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const SRC = join(ROOT, "data", "cites");
const OUT = join(ROOT, "public", "data", "cites");
const REC_BYTES = 8;
const HEAD_BYTES = 24;
const MAGIC = "LUNYCITE";
const FLAG_HAS_RECORD = 1;

const log = (m) => process.stdout.write(`${m}\n`);

/**
 * 判断一篇「在数据源里查到了吗」。
 *
 * 正常路径读 flags 的 bit0。但**对早期抓的数据要兜底**：
 * S2 抓取器第一版没写这个位（只在 OpenAlex 版里写了），已经落盘的 29 个分片
 * 全是 0 —— 直接读会把「数据缺失」当成「引用很少」，于是全部画暗。
 *
 * 兜底依据：抓取器对**查不到**的论文写全 0，而查到的会写 `year`。
 * 所以 `year > 0` 基本等价于「查到了」（S2 对已收录论文都会返回年份）。
 * 兜底刻意**宽松**：宁可把极少数年份确实为 0 的论文算作"有记录"，
 * 也不要把成批有引用的论文误判成"无数据"而画暗。
 */
function hasRecord(raw, off) {
  if ((raw.readUInt8(off + 7) & FLAG_HAS_RECORD) !== 0) return true;
  return raw.readUInt16LE(off + 4) > 0;
}

function build(domain, manifestPapers) {
  const src = join(SRC, `${domain}.bin`);
  if (!existsSync(src)) return null;
  const raw = readFileSync(src);
  const count = Math.min(manifestPapers ?? Math.floor(raw.length / REC_BYTES), Math.floor(raw.length / REC_BYTES));

  // ---- 统计 ----
  let withRecord = 0;
  let nonZero = 0;
  let maxCites = 0;
  const cites = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * REC_BYTES;
    const c = raw.readUInt32LE(o);
    cites[i] = c;
    if (hasRecord(raw, o)) withRecord++;
    if (c > 0) nonZero++;
    if (c > maxCites) maxCites = c;
  }

  /*
   * P99：把有记录的论文的引用数排序后取第 99 百分位。
   * ⚠️ 必须**只对"有记录"的**取分位 —— 数据缺失的那些是 0 但并不是"0 引用"，
   *    把它们算进去会把分位整体压低，于是亮度普遍偏亮。
   */
  const recorded = [];
  for (let i = 0; i < count; i++) {
    if (hasRecord(raw, i * REC_BYTES)) recorded.push(cites[i]);
  }
  recorded.sort((a, b) => a - b);
  const p99 = recorded.length ? recorded[Math.min(recorded.length - 1, Math.floor(recorded.length * 0.99))] : 1;

  // ---- 写头部 + 正文 ----
  // ⚠️ 正文要**重写 flags**，把兜底判断出来的"有记录"补进 bit0 ——
  //    否则兜底只在这个脚本里生效，到了浏览器读到的还是旧数据里的 0。
  mkdirSync(OUT, { recursive: true });
  const body = Buffer.from(raw.subarray(0, count * REC_BYTES));
  for (let i = 0; i < count; i++) {
    const o = i * REC_BYTES;
    if (hasRecord(raw, o)) body.writeUInt8(body.readUInt8(o + 7) | FLAG_HAS_RECORD, o + 7);
  }
  const head = Buffer.alloc(HEAD_BYTES);
  head.write(MAGIC, 0, "utf8");
  head.writeUInt32LE(count, 8);
  head.writeUInt32LE(maxCites, 12);
  head.writeUInt32LE(Math.round(((100 * withRecord) / Math.max(1, count)) * 100), 16); // ×100 保留两位
  head.writeUInt32LE(Math.max(1, p99), 20);
  writeFileSync(join(OUT, `${domain}.bin`), Buffer.concat([head, body]));

  return {
    domain,
    count,
    withRecord,
    coveragePct: (100 * withRecord) / Math.max(1, count),
    nonZero,
    nonZeroPct: (100 * nonZero) / Math.max(1, count),
    maxCites,
    p99,
  };
}

function main() {
  const mPath = join(ROOT, "public", "data", "manifest.json");
  const manifest = existsSync(mPath) ? JSON.parse(readFileSync(mPath, "utf8")) : { domains: [] };
  const papers = Object.fromEntries(manifest.domains.map((d) => [d.id, d.papers]));

  const rows = [];
  for (const d of DOMAINS) {
    const r = build(d.id, papers[d.id]);
    if (r) rows.push(r);
    else log(`  ${d.id.padEnd(8)} 跳过（没有 data/cites/${d.id}.bin）`);
  }
  if (rows.length === 0) {
    log("\n没有可用的引用数据。先跑 harvest-cites.mjs 或 harvest-openalex.mjs。");
    return;
  }

  log("\n学科      篇数        有记录     覆盖率    引用非零   最高引用   亮度基准(P99)");
  for (const r of rows) {
    log(
      `${r.domain.padEnd(9)} ${String(r.count).padStart(10)} ${String(r.withRecord).padStart(10)} ` +
        `${r.coveragePct.toFixed(1).padStart(7)}% ${r.nonZeroPct.toFixed(1).padStart(9)}% ` +
        `${String(r.maxCites).padStart(10)} ${String(r.p99).padStart(12)}`,
    );
  }

  const totCount = rows.reduce((a, r) => a + r.count, 0);
  const totRec = rows.reduce((a, r) => a + r.withRecord, 0);
  log(
    `\n合计 ${totCount.toLocaleString()} 篇 · 有引用记录 ${totRec.toLocaleString()} 篇` +
      `（${((100 * totRec) / Math.max(1, totCount)).toFixed(1)}%）`,
  );

  // 把引用数据的可用性写进 manifest —— 界面据此**如实报告覆盖率**，
  // 而不是把"数据缺失"悄悄画成"引用很少"。
  if (manifest.domains?.length) {
    for (const d of manifest.domains) {
      const r = rows.find((x) => x.domain === d.id);
      if (!r) continue;
      d.cites = {
        file: `cites/${d.id}.bin`,
        count: r.count,
        coveragePct: Number(r.coveragePct.toFixed(2)),
        citeNonZeroPct: Number(r.nonZeroPct.toFixed(2)),
        maxCites: r.maxCites,
        scaleCites: r.p99,
      };
    }
    manifest.citesBuiltAt = new Date().toISOString();
    writeFileSync(mPath, JSON.stringify(manifest, null, 2));
    /*
     * ⚠️ **必须同时写 brotli 版**。
     *
     * `deploy/serve.mjs` 对支持 br 的客户端优先发 `manifest.json.br` ——
     * 只写 `.json` 的话浏览器读到的还是**上一次构建的压缩副本**，
     * 表现为"构建脚本说登记成功了、界面上却完全看不到新字段"。
     * 实测踩过：build-cites 明明写了 cites，浏览器里 `manifest.domains[].cites` 全是空。
     */
    writeFileSync(
      `${mPath}.br`,
      brotliCompressSync(readFileSync(mPath), { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }),
    );
    log(`\nmanifest.json 已登记 cites（${rows.length} 个学科）`);
  }
}

main();
