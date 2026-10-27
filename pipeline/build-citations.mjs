// @ts-nocheck
/**
 * 论文云 · 把抓回来的引用列表编成**可随机访问**的资产
 * ============================================================================
 * 输入：`data/refs/<domain>.jsonl`（每行一篇：`{"d":docId,"in":[docId...],"ext":[[标题,年,DOИ]...]}`）
 * 输出（`public/data/citations/`）：
 *
 *   · `<d>.bin`     —— **库内引用边**的 CSR：
 *       magic "LUNYREF1"(8) | u32 count | u32 edgeCount | u32 coveragePct | u32 maxRefs
 *       | u32 offsets[count+1] | u32 dst[edgeCount]
 *   · `<d>.ext.bin` —— **库外引用**（只有被引次数靠前的那批论文才有）：
 *       magic "LUNYEXT1"(8) | u32 count | u32 blobBytes | u32 offsets[count+1] | blob
 *       blob 里每篇是若干行 `年\ttitle\tDOI`，用 \n 分隔（**不压缩**，否则 Range 取不了）
 *
 * ## 为什么必须能被"随机访问"，而不是整份下载
 *
 * 全量库内边约几千万条（物理团一家就 2000 万级）⇒ 每团几十 MB。
 * 但界面一次只点**一颗星**，要的只是它那几十条边。所以用 CSR
 * （压缩稀疏行）布局：给定 docId，先读 `offsets[docId..docId+1]`（8 字节），
 * 再读 `dst[o0..o1)`（N×4 字节）—— **两次 HTTP Range 请求、不到 1 KB**。
 * 这套做法与摘要池（2.9 GB 照样按需取）同源，见 `src/data/assets.ts` 的 `getRange`。
 *
 * ⚠️ 文件**不能压缩**（`.br`）：压缩之后"第 5 亿字节"不再是内存里的第 5 亿字节，
 *    Range 就取不到了。这条教训写在 `assets.ts` 的 `getRange` 注释里。
 *
 * ## 只保留同团的边
 *
 * 八个学科各是一个 `<group>`，坐标是**各自的局部坐标**（中心/倾角不同）。
 * 跨团的边画出来会是"从这团射到那团的坐标"—— 那条线落在虚空里，什么也不指着。
 * 所以建图时就丢掉（harvest 那边也丢过一次，这里再丢一次是**故意**的：
 * 换了数据源、换了抓取脚本，这条不变量都不该靠上游记得）。
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DOMAINS } from "../src/data/domains.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const REFS = join(ROOT, "data", "refs");
const TEXT = join(ROOT, "text");
const OUT = join(ROOT, "public", "data", "citations");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ONLY = argVal("--domain", null);
/** 单篇最多保留多少条引用（防止个别综述型论文把文件撑爆；超出部分如实丢弃并计数） */
const MAX_REFS = Number(argVal("--maxRefs", "200"));

mkdirSync(OUT, { recursive: true });

/** 论文总数（= docId 上界）—— 直接数语料行数，别信 progress 文件 */
async function countPapers(domain) {
  const f = join(TEXT, `${domain}.jsonl.gz`);
  if (!existsSync(f)) return 0;
  const { createGunzip } = await import("node:zlib");
  const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) if (line) n++;
  rl.close();
  return n;
}

async function buildDomain(domain) {
  const src = join(REFS, `${domain}.jsonl`);
  if (!existsSync(src)) {
    console.log(`  ${domain}: 没有 ${src}，跳过`);
    return;
  }
  const count = await countPapers(domain);
  if (!count) {
    console.log(`  ${domain}: 语料为空，跳过`);
    return;
  }
  console.log(`  ${domain}: ${count} 篇，读 ${src} …`);

  /**
   * 第一遍：数每条边、每篇多少条 —— 为了给 offsets 定长。
   * 一遍扫描同时把 `in` 与 `ext` 都收进内存的**紧凑数组**：
   * 全量边数在千万级，用 `number[]` 存会吃掉上 GB，所以先数再填。
   */
  const refs = new Map(); // docId -> number[]（只记有引用的，稀疏）
  const exts = new Map(); // docId -> string（拼好的 ext 块）
  let edgeTotal = 0;
  let dropped = 0;
  let covered = 0;
  let maxRefs = 0;
  let lines = 0;
  const rl = createInterface({ input: createReadStream(src), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const d = o.d | 0;
    if (d < 0 || d >= count) continue;
    let inIds = Array.isArray(o.in) ? o.in : [];
    if (inIds.length > MAX_REFS) {
      dropped += inIds.length - MAX_REFS;
      inIds = inIds.slice(0, MAX_REFS);
    }
    // 去重 + 去自环 + 去越界（上游已经做过一次，这里再做一次是故意的：换数据源也不该坏）
    const seen = new Set();
    const clean = [];
    for (const x of inIds) {
      const v = x | 0;
      if (v <= 0 || v >= count || v === d || seen.has(v)) continue;
      seen.add(v);
      clean.push(v);
    }
    if (clean.length) {
      refs.set(d, clean);
      edgeTotal += clean.length;
      covered++;
      if (clean.length > maxRefs) maxRefs = clean.length;
    }
    if (Array.isArray(o.ext) && o.ext.length) {
      const block = o.ext
        .map((e) => {
          const title = String(e?.[0] ?? "").replace(/[\t\r\n]/g, " ").trim();
          if (!title) return null;
          return `${e?.[1] | 0}\t${title}\t${String(e?.[2] ?? "").replace(/[\t\r\n]/g, "")}`;
        })
        .filter(Boolean)
        .join("\n");
      if (block) exts.set(d, block);
    }
  }
  rl.close();
  console.log(`    行 ${lines} · 有引用 ${covered} 篇 · 边 ${edgeTotal} 条 · 单篇最多 ${maxRefs} 条 · 超限丢弃 ${dropped} 条`);

  // ---- 写 CSR
  const headerBytes = 8 + 4 * 5;
  const offsets = new Uint32Array(count + 1);
  const dst = new Uint32Array(edgeTotal);
  let edge = 0;
  for (let d = 0; d < count; d++) {
    offsets[d] = edge;
    const list = refs.get(d);
    if (list) {
      for (const v of list) dst[edge++] = v;
    }
  }
  offsets[count] = edge;
  const buf = Buffer.alloc(headerBytes + offsets.byteLength + dst.byteLength);
  buf.write("LUNYREF1", 0, "ascii");
  buf.writeUInt32LE(count, 8);
  buf.writeUInt32LE(edgeTotal, 12);
  buf.writeUInt32LE(Math.round((100 * covered) / count), 16);
  buf.writeUInt32LE(maxRefs, 20);
  buf.writeUInt32LE(0, 24); // 保留
  Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength).copy(buf, headerBytes);
  Buffer.from(dst.buffer, dst.byteOffset, dst.byteLength).copy(buf, headerBytes + offsets.byteLength);
  const outFile = join(OUT, `${domain}.bin`);
  writeFileSync(outFile, buf);

  // ---- 写 ext
  const extCount = count;
  const extBlob = [];
  const extOffsets = new Uint32Array(extCount + 1);
  let byte = 0;
  for (let d = 0; d < extCount; d++) {
    extOffsets[d] = byte;
    const b = exts.get(d);
    if (b) {
      extBlob.push(Buffer.from(b + "\n", "utf8"));
      byte += Buffer.byteLength(b + "\n");
    }
  }
  extOffsets[extCount] = byte;
  const extHeader = 8 + 4 * 2;
  const extBuf = Buffer.alloc(extHeader + extOffsets.byteLength + byte);
  extBuf.write("LUNYEXT1", 0, "ascii");
  extBuf.writeUInt32LE(extCount, 8);
  extBuf.writeUInt32LE(byte, 12);
  Buffer.from(extOffsets.buffer, extOffsets.byteOffset, extOffsets.byteLength).copy(extBuf, extHeader);
  let at = extHeader + extOffsets.byteLength;
  for (const b of extBlob) {
    b.copy(extBuf, at);
    at += b.length;
  }
  const extFile = join(OUT, `${domain}.ext.bin`);
  writeFileSync(extFile, extBuf);

  const csrMB = (statSync(outFile).size / 1048576).toFixed(2);
  const extMB = (statSync(extFile).size / 1048576).toFixed(2);
  console.log(`    → ${outFile} ${csrMB} MB（覆盖 ${((100 * covered) / count).toFixed(1)}%）· ${extFile} ${extMB} MB`);
}

for (const d of DOMAINS) {
  if (ONLY && d.id !== ONLY) continue;
  await buildDomain(d.id);
}
console.log("\n完成。前端读 `src/data/citations.ts`（HTTP Range，不整份下载）。");
