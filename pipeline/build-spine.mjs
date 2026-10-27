#!/usr/bin/env node
/**
 * 论文云 · 词表与编号脊柱构建
 * ============================================================================
 * 把导出的语料变成**编号系统**：词表（V 个词）+ 每篇论文的编号（S 位词槽）。
 *
 * 输入：`text/<domain>.jsonl.gz`（pipeline/export-text.mjs 的产物）
 * 输出：`public/data/<domain>/vocab.json` + `spine.bin` + 全局 `manifest.json`
 *
 * 编号语义（**这是作品的核心机制**）：
 *   目录容量 |C| = V^S      ← 不存任何标题，只存 V 个词与 S 这个数
 *   论文标题 → 词 id 序列 → 编号 ∈ [0, |C|)
 *   编号 → 词 id 序列 → 标题（含从未存在过的）
 *   ⇒ "一切可能的论文标题"由算法穷举，**不被存储**
 *
 * 词表怎么选（**可审计的规则，不是拍脑袋**）：
 *   1. 统计全部标题分词后的词频
 *   2. 按频次降序取前 V 个（V 可配；默认 4000）
 *   3. 平票时按字典序 —— 保证**同一语料永远得到同一份词表**（可复现是硬要求）
 *   为什么取高频词：低频词命中率极低却要占掉词表位数；而高频词覆盖了绝大多数标题。
 *   被丢弃的低频词不会让论文"丢失"，只是它的编号会短一些（少一位）。
 *
 * spine.bin 逐篇存什么（24 字节/篇）：
 *   u64 编号（scatter 之后的"地址"，用于空间位置与虚空占用判定）
 *   u64 编号（rank 原始值，用于"编号反查"与永久链接显示）
 *   u32 docId
 *   u8  tokenCount（实际词数，用于还原"标题被截断到第几个词"）
 *   u8  flags（bit0 = 标题词数超过 S，发生了截断）
 *   u16 保留
 *
 * 为什么不用 JSON：305 万篇 × 24 字节 = 73 MB 二进制（brotli 后约 20 MB）。
 * 用 JSON 会是 1 GB 以上，浏览器扛不住。
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { brotliCompressSync, constants as zc } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DOMAINS } from "../src/data/domains.ts";
import { archiveOf, archiveZh, catZh, crossTagOf, stratumPath, subcatOf } from "../src/data/hierarchy.ts";
import { tokenizeTitle } from "../src/engine/tokenize.ts";
import { catalogDigits, catalogSize, rankSpine, scatter } from "../src/engine/spine.ts";

/**
 * 注意：这里**不写** `import type`。
 * 本文件是 `.mjs`，由 Node 直接执行；虽然 Node 24 能 strip 掉 .ts 里的类型，
 * 但对 .mjs 里的 `import type` 语句不做事先擦除，会在解析阶段报
 * "Unexpected token '{'"。所以类型只作为注释存在（JSDoc 足够表达）。
 * @typedef {import("../src/engine/spine.ts").Catalog} Catalog
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const TEXT = join(ROOT, "text");
const OUT = join(ROOT, "public", "data");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const VOCAB_SIZE = Number(argVal("--vocab", "4000"));
const SLOTS = Number(argVal("--slots", "20"));
const ONLY = argVal("--domain", null);
const LIMIT = Number(argVal("--limit", "0")) || Infinity;

/**
 * arXiv 顶层 archive → 本项目的学科 id。
 *
 * 用途：算**跨学科桥**的强度 —— 一篇挂了 `cs.LG` 的物理论文，
 * 就是物理团与计算机团之间的一座桥。这个矩阵是**真实统计**，不是猜的。
 *
 * ⚠️ 必须与语料的分桶规则一致（v1 的 `build-corpus.mjs` 把论文按 primary_cat 分到八个库）。
 * 不一致的话，"桥"会指到错误的学科对上，而且**看不出错**（数字看起来都合理）。
 */
const DOMAIN_OF_ARCHIVE = {
  physics: "physics",
  "cond-mat": "physics",
  "astro-ph": "physics",
  "hep-ph": "physics",
  "hep-th": "physics",
  "hep-ex": "physics",
  "hep-lat": "physics",
  "quant-ph": "physics",
  "gr-qc": "physics",
  "nucl-th": "physics",
  "nucl-ex": "physics",
  "math-ph": "physics",
  nlin: "physics",
  cs: "cs",
  math: "math",
  eess: "eess",
  stat: "stat",
  "q-bio": "bio",
  econ: "econ",
  "q-fin": "qfin",
};

/**
 * 散射密钥：必须固定，否则同一篇论文在不同构建里会落到不同坐标。
 * 取 splitmix64 的黄金比例常数（与引擎里 Feistel 轮函数用的那个不同，避免相关）。
 */
const SCATTER_KEY = 0x243f6a8885a308d3n;

/**
 * spine.bin 逐篇存什么。
 *
 * ⚠️ **这里踩过一个真 bug，改之前务必看懂**：
 * 编号有 **73 位十进制 ≈ 243 位二进制**，远超 64 位。
 * 最初用 `writeBigUInt64LE` 存它，Node 会**静默取模 2^64**（不报错！），
 * 结果 69% 的编号被截断成 0 —— 数据损坏但不崩溃，很难发现
 * （是靠 `verify-spine.mjs` 把"与原文对照"跑了一遍才抓出来的）。
 *
 * 因此编号与地址一律用**定宽 32 字节大端**（VALUE_BYTES=32，够到 2^256）：
 *   +0   addr   32B 大端（散射后的地址：空间位置 + 虚空占用判定）
 *   +32  rank   32B 大端（原始编号：编号反查 + 永久链接显示）
 *   +64  docId  u32
 *   +68  n      u8 （词表内实际词数）
 *   +69  flag   u8 （bit0 = 词表内词数超过词槽，发生截断）
 *   +70         u16 保留
 * 共 72 字节/篇 → 305 万篇约 220 MB（brotli 后约 60 MB，按学科懒加载）。
 *
 * 为什么定宽而不是变长：定宽才能 O(1) 随机访问（off = docId * REC_BYTES），
 * 这是浏览器里"点一下立刻取那篇"的前提。
 */
const REC_BYTES = 72;
const HEADER_BYTES = 20;
/**
 * 演示版抽样步长（每 N 篇取 1 篇）。
 *
 * 取 50 是在"首屏秒开"与"看得出是一座星系"之间定的：
 *   步长 10 时八团合计 30 万点、压缩后 21 MB，首屏太重；
 *   步长 50 约 6 万点、压缩后约 5 MB。
 * 而星系形态在 1 万点以上就已经看得出来（旋臂形状由几何决定，不靠点数）。
 */
const DEMO_STRIDE = 10;
const VALUE_BYTES = 32;
const MAX_VALUE = 1n << BigInt(VALUE_BYTES * 8);

/** 写定宽大端字段；装不下就**立刻抛错**（绝不静默截断）。 */
function writeValue(buf, offset, v) {
  if (v < 0n) throw new RangeError(`编号不能为负：${v}`);
  if (v >= MAX_VALUE) {
    throw new RangeError(`编号 ${v.toString().slice(0, 40)}… 超过 ${VALUE_BYTES} 字节，定宽字段装不下`);
  }
  buf.fill(0, offset, offset + VALUE_BYTES);
  let x = v;
  for (let i = VALUE_BYTES - 1; i >= 0; i--) {
    buf[offset + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

/** 读定宽大端字段（自检脚本与浏览器共用这套，保证一致）。 */
function readValue(buf, offset) {
  let x = 0n;
  for (let i = 0; i < VALUE_BYTES; i++) x = (x << 8n) | BigInt(buf[offset + i]);
  return x;
}

const log = (...a) => console.log(...a);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** 第一遍：统计词频。 */
async function countTokens(file) {
  const freq = new Map();
  let papers = 0;
  let tokens = 0;
  let hasTitle = 0;
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()) });
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const toks = tokenizeTitle(rec.title ?? "");
    if (toks.length) hasTitle++;
    for (const t of toks) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
      tokens++;
    }
    papers++;
  }
  return { freq, papers, tokens, hasTitle };
}

/** 词表：频次降序，平票按字典序（**保证可复现**）。 */
function buildVocab(freq, size) {
  const entries = [...freq.entries()];
  entries.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.slice(0, size).map(([w, c]) => ({ w, c }));
}

/** 第二遍：为每篇论文算编号并落盘。 */
async function buildSpine(file, dom, vocabList, outDir) {
  const catalog = {
    id: dom.id,
    vocab: vocabList.map((v) => v.w),
    slots: SLOTS,
  };
  const R = catalogSize(catalog);
  /** 词 → id 的 O(1) 查找（比 Set 更好：直接拿到 id，不用再调 idsForTitle） */
  const vocabPos = new Map(catalog.vocab.map((w, i) => [w, i]));

  mkdirSync(outDir, { recursive: true });
  const spinePath = join(outDir, "spine.bin");
  const chunks = [];
  const rec = Buffer.alloc(REC_BYTES);

  let docId = 0;
  let encoded = 0;
  let truncated = 0;
  let oovCount = 0;
  let untitled = 0;
  let addrSum = 0n;
  let crossCount = 0;
  /** 其他学科 id → 本团有多少篇论文挂了那个学科的分类（跨学科桥的强度） */
  const bridgeCount = new Map();
  /**
   * 层注册表：把一个分类码收敛成一个**稳定的 u16 层号**。
   *
   * 层号写进编号表（record 的保留 u16 字段），因此：
   *   · 顺序由**首次出现**决定 ⇒ 同一份语料永远得到同一套层号（可复现）；
   *   · 上限 65535 层 —— 实测物理团 48 层、CS 团 39 层，远远够用。
   */
  const strata = (() => {
    const byId = new Map();
    const list = [];
    return {
      list,
      intern(pathKey, primaryCat, domainId) {
        let idx = byId.get(pathKey.l3);
        if (idx !== undefined) {
          list[idx].papers++;
          return idx;
        }
        idx = list.length;
        byId.set(pathKey.l3, idx);
        const arch = archiveOf(primaryCat);
        list.push({
          id: pathKey.l3,
          l2: pathKey.l2,
          domain: domainId,
          arch,
          zh: `${archiveZh(arch)}·${catZh(primaryCat) || subcatOf(primaryCat)}`,
          en: primaryCat || arch,
          papers: 1,
        });
        return idx;
      },
    };
  })();
  const t0 = Date.now();

  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()) });
  for await (const line of rl) {
    if (!line) continue;
    if (docId >= LIMIT) break;
    let recJson;
    try {
      recJson = JSON.parse(line);
    } catch {
      continue;
    }
    const toks = tokenizeTitle(recJson.title ?? "");
    const fullCount = toks.length;
    if (!fullCount) untitled++;

    // ---- 层级归属（写进编号表：位置必须由编号决定，所以层必须进编号）----
    const path = stratumPath(dom.id, recJson.primaryCat ?? "");
    const l3 = strata.intern(path, recJson.primaryCat ?? "", dom.id);
    const cats = Array.isArray(recJson.cats) ? recJson.cats : [];
    if (crossTagOf(cats)) crossCount++;
    // 跨学科桥：这篇论文的**每个** arXiv 分类都属于某个学科（见 DOMAIN_OF_ARCHIVE）。
    // 只统计"其他学科"的部分 —— 自己不算桥。
    for (const c of cats) {
      const other = DOMAIN_OF_ARCHIVE[archiveOf(c)];
      if (other && other !== dom.id) bridgeCount.set(other, (bridgeCount.get(other) ?? 0) + 1);
    }

    // 只用词表内的词构成编号：**跳过**词表外的词，而不是中止整篇。
    // 否则一篇含生僻词的标题会完全无法编号（那会让"半编号 / 反查"出现空洞）。
    // 代价是编号不再逐字对应原标题，但保住了前缀语义（首词仍是最高位）—— 有意的取舍。
    const inVocab = [];
    let overSlots = false;
    for (const t of toks) {
      const id = vocabPos.get(t);
      if (id === undefined) continue;
      if (inVocab.length >= SLOTS) {
        overSlots = true; // 只统计**真的因为词槽不够而丢词**
        break;
      }
      inVocab.push(id);
    }
    // 两个指标必须分开，混在一起会得出误导性结论：
    //   oovPct       —— 标题含词表外的词（覆盖问题，靠加词表解决）
    //   truncatedPct —— 词表内的词超过词槽数（容量问题，靠加词槽解决）
    if (inVocab.length < fullCount) oovCount++;
    if (overSlots) truncated++;

    // 编号：词表内一个词都没有时落到编号 0（合法的"空标题"位置）
    const rank = inVocab.length ? rankSpine(catalog, inVocab) : 0n;
    const addr = scatter(R, SCATTER_KEY, rank);
    if (inVocab.length) encoded++;
    addrSum ^= addr;

    // 定宽大端写（装不下会抛错，不会静默截断 —— 见 writeValue 的注释）
    writeValue(rec, 0, addr);
    writeValue(rec, VALUE_BYTES, rank);
    rec.writeUInt32LE(docId, VALUE_BYTES * 2);
    rec.writeUInt8(Math.min(255, inVocab.length), VALUE_BYTES * 2 + 4);
    rec.writeUInt8(overSlots ? 1 : 0, VALUE_BYTES * 2 + 5);
    rec.writeUInt16LE(l3, VALUE_BYTES * 2 + 6); // 层号（层级归属进编号）
    chunks.push(Buffer.from(rec)); // 必须拷贝：rec 会被复用
    docId++;

    if (docId % 500000 === 0) log(`    … ${docId.toLocaleString()} 篇`);
  }

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(20);
  head.write("LUNYSPN1", 0, "ascii");
  head.writeUInt32LE(docId, 8);
  head.writeUInt32LE(SLOTS, 12);
  head.writeUInt32LE(REC_BYTES, 16); // 记录长度写进头部，将来改布局时自检能立刻发现不匹配
  const buf = Buffer.concat([head, body]);
  writeFileSync(spinePath, buf);
  const br = brotliCompressSync(buf, {
    params: { [zc.BROTLI_PARAM_QUALITY]: 5, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length },
  });
  writeFileSync(spinePath + ".br", br);

  // ---- 演示版：每 DEMO_STRIDE 篇取 1 篇，保持**原始 docId** ----
  // 为什么需要：完整 spine 最大 105 MB（物理团），首屏等它加载完要几十秒，
  // 而"先看到大概的样子"是这个阶段最重要的目标。
  // 抽样保留原始 docId（不是重新编号），因此点开论文、编号反查全都与完整版一致，
  // 只是首屏画的点少了 —— 数量少不影响"看出是一座星系"。
  const demoChunks = [];
  let demoCount = 0;
  for (let i = 0; i < docId; i += DEMO_STRIDE) {
    demoChunks.push(buf.subarray(HEADER_BYTES + i * REC_BYTES, HEADER_BYTES + (i + 1) * REC_BYTES));
    demoCount++;
  }
  const demoHead = Buffer.alloc(32);
  demoHead.write("LUNYSPD1", 0, "ascii");
  demoHead.writeUInt32LE(demoCount, 8);
  demoHead.writeUInt32LE(SLOTS, 12);
  demoHead.writeUInt32LE(REC_BYTES, 16);
  demoHead.writeUInt32LE(DEMO_STRIDE, 20); // 抽样步长：docId = 第 k 条的下标 × stride
  demoHead.writeUInt32LE(0, 24);
  const demoBuf = Buffer.concat([demoHead, ...demoChunks]);
  writeFileSync(spinePath.replace(/\.bin$/, ".demo.bin"), demoBuf);
  writeFileSync(
    spinePath.replace(/\.bin$/, ".demo.bin.br"),
    brotliCompressSync(demoBuf, { params: { [zc.BROTLI_PARAM_QUALITY]: 6 } }),
  );

  // ---- 编号表：按**编号（rank）升序**排列，用于"这个编号上真有论文吗" ----
  //
  // 为什么需要它（这是"虚空拉取"的判定依据）：
  //   用户点空白处时，我们采样的是**编号空间**（73 位十进制，V^S 个位置），
  //   而不是地址空间。原因很直接：真实论文只占编号空间的 1.46e6 / 1.2e72 ≈ 1e-66，
  //   在地址空间里采样永远命不中，那个功能就没有意义了。
  //   而在编号空间里采样，再拿编号表二分，就能**确定地**回答
  //   "这个编号上真的有一篇论文吗" —— 命中率约等于"论文数 / 采样范围"，
  //   只要把采样范围限制在真实编号的**跨度**内（见 manifest 的 rankSpan），
  //   命中率就是有意义的（物理团实测约 1/3）。
  //
  // 布局：magic "LUNYRANK"(8) | count(u32) | recBytes(u32=8) | minRank(32B 大端) | maxRank(32B 大端) | 记录(count×8)
  //   记录 = [rank 的低 32 位相对偏移? 不 —— 直接存 u32 docId 与 32 字节 rank 太贵]
  //   实测：若存完整 rank 是 40 字节/条 ⇒ 物理团 58 MB（br 后约 20 MB），可接受；
  //   但还可以更省：rank 升序 ⇒ 存**差值**（变长整数）。这里先用定长（40 字节），
  //   因为"可 O(1) 随机访问"比省几 MB 更重要，且 brotli 对定长有序数据压缩得很好。
  const RANK_REC = 40; // u32 docId + 32B 大端 rank + u8 tokens + u8 flags + u16 层号
  const sorted = [];
  for (let i = 0; i < docId; i++) {
    const off = HEADER_BYTES + i * REC_BYTES;
    sorted.push({
      docId: i,
      rank: readValue(buf, off + VALUE_BYTES),
      addr: readValue(buf, off),
      // 词数也带上：虚空拉取要用它把补零的尾部截掉。
      // 否则一个 5 词的标题会显示成 "quantum quantum … quantum"（补了 15 个最高频词）。
      tokens: buf.readUInt8(off + VALUE_BYTES * 2 + 4),
      // 层号也带上：它已经写进 spine 的保留 u16（见上面的 writeUInt16LE(l3, …)）
      stratum: buf.readUInt16LE(off + VALUE_BYTES * 2 + 6),
    });
  }
  sorted.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const rankRec = Buffer.alloc(sorted.length * RANK_REC);
  let rankMin = null;
  let rankMax = 0n;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    // ⚠️ 每条记录的三个字段都必须带上**本条记录的偏移 o**。
    //    曾经漏写这个参数（写成常量 0 / 4），于是每条记录都在覆盖第 0 条 ——
    //    结果编号表里只有第 0 条有值，其余全是 0，而 .br 只有 147 字节。
    //    讽刺的是我的"最小复现"脚本里写对了偏移，所以复现不出来。
    //    教训：**复现要用真实代码路径，不要照抄改写成"应该的样子"**。
    const o = i * RANK_REC;
    rankRec.writeUInt32LE(s.docId, o);
    writeValue(rankRec, o + 4, s.rank);
    rankRec.writeUInt8(s.tokens, o + 4 + VALUE_BYTES);
    rankRec.writeUInt8(0, o + 4 + VALUE_BYTES + 1);
    rankRec.writeUInt16LE(s.stratum, o + 4 + VALUE_BYTES + 2); // 层号（虚空拉取据此知道"最近论文属于哪一层"）
    if (rankMin === null || s.rank < rankMin) rankMin = s.rank;
    if (s.rank > rankMax) rankMax = s.rank;
  }
  if (process.env.SPINE_DEBUG) {
    console.log("    [dbg] rankRec.length =", rankRec.length, " 期望 =", sorted.length * RANK_REC);
    console.log("    [dbg] 写出前 3 条:", [0, 1, 2].map((i) => readValue(rankRec, i * RANK_REC + 4).toString().slice(0, 12)).join(" | "));
  }
  const rankHead = Buffer.alloc(8 + 4 + 4 + VALUE_BYTES * 2);
  rankHead.write("LUNYRANK", 0, "ascii");
  rankHead.writeUInt32LE(sorted.length, 8);
  rankHead.writeUInt32LE(RANK_REC, 12);
  writeValue(rankHead, 16, rankMin ?? 0n);
  writeValue(rankHead, 16 + VALUE_BYTES, rankMax);
  const rankBuf = Buffer.concat([rankHead, rankRec]);
  // 构建期自检：**写完立刻核对**，不要把坏数据写到磁盘上才发现
  {
    let nz = 0;
    let sortedOk = true;
    let prev = -1n;
    for (let i = 0; i < sorted.length; i++) {
      const v = readValue(rankRec, i * RANK_REC + 4);
      if (v !== 0n) nz++;
      if (v < prev) sortedOk = false;
      prev = v;
    }
    const nzSorted = sorted.filter((s) => s.rank !== 0n).length;
    if (nz !== nzSorted || !sortedOk) {
      throw new Error(
        `编号表构建异常：写出的非零 ${nz} 条，源数据非零 ${nzSorted} 条，升序=${sortedOk}`,
      );
    }
  }
  // 写在 outDir（明确传入，避免从 spinePath 反推目录 —— 那样一改路径布局就会写错地方）
  const rankPath = join(outDir, "rank.bin");
  writeFileSync(rankPath, rankBuf);
  const rankBr = brotliCompressSync(rankBuf, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } });
  writeFileSync(rankPath + ".br", rankBr);

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  log(
    `  ${dom.id.padEnd(8)} ${docId.toLocaleString().padStart(10)} 篇 · 可编号 ${((100 * encoded) / Math.max(1, docId)).toFixed(1)}% · ` +
      `超出词槽 ${((100 * truncated) / Math.max(1, docId)).toFixed(2)}% · 含词表外词 ${((100 * oovCount) / Math.max(1, docId)).toFixed(1)}% · 空标题 ${untitled}`,
  );
  log(
    `           完整 ${mb(buf.length)}→br ${mb(br.length)} · 演示 ${demoCount.toLocaleString()} 点(1/${DEMO_STRIDE}) ${mb(demoBuf.length)} · ` +
      `编号表 ${mb(rankBuf.length)}→br ${mb(rankBr.length)} · ${secs}s`,
  );
  log(
    `           层级 L3 共 ${strata.list.length} 个（覆盖 ${strata.list.reduce((a, s) => a + s.papers, 0).toLocaleString()} 篇）· ` +
      `交叉列表 ${((100 * crossCount) / Math.max(1, docId)).toFixed(1)}%`,
  );

  // ---- P0-5 验收：层级计数自洽（子级之和 == 父级 == 该学科总篇数）----
  //
  // 这个不变量必须在这里挡住，不能等前端显示出来才发现：
  // 层级计数一旦对不上，界面上的"占比""半径 ∝ √count"就全是错的，
  // 而且错得很隐蔽 —— 看起来只是"某个方向好像少了一点"。
  {
    const byL2 = new Map();
    let sumL3 = 0;
    for (const s of strata.list) {
      sumL3 += s.papers;
      byL2.set(s.l2, (byL2.get(s.l2) ?? 0) + s.papers);
    }
    const sumL2 = [...byL2.values()].reduce((a, b) => a + b, 0);
    if (sumL3 !== docId) {
      throw new Error(`层级不自洽：L3 之和 ${sumL3} != 该学科总篇数 ${docId}`);
    }
    if (sumL2 !== sumL3) {
      throw new Error(`层级不自洽：L2 之和 ${sumL2} != L3 之和 ${sumL3}`);
    }
    // L1（学科本身）等于 L2 之和 —— 这是链条的最后一环
    if (sumL2 !== docId) {
      throw new Error(`层级不自洽：L1 ${docId} != L2 之和 ${sumL2}`);
    }
    log(`           层级自洽 ✓ L1 ${docId.toLocaleString()} == L2(${byL2.size}) ${sumL2.toLocaleString()} == L3(${strata.list.length}) ${sumL3.toLocaleString()}`);
  }
  return {
    docId, encoded, truncated, oovCount, untitled,
    bytes: buf.length, brBytes: br.length, addrSum,
    demoCount, demoStride: DEMO_STRIDE, demoBytes: demoBuf.length,
    rankCount: sorted.length,
    rankBytes: rankBuf.length,
    rankMin: (rankMin ?? 0n).toString(),
    rankMax: rankMax.toString(),
    strata: strata.list,
    crossPct: Number(((100 * crossCount) / Math.max(1, docId)).toFixed(2)),
    /** 跨学科桥：其他学科 id → 挂靠该学科的论文数（真实数据，不是猜的） */
    bridges: Object.fromEntries([...bridgeCount.entries()].sort((a, b) => b[1] - a[1])),
  };
}


async function main() {
  const list = ONLY ? DOMAINS.filter((d) => d.id === ONLY) : DOMAINS;
  mkdirSync(OUT, { recursive: true });
  const domains = [];

  /**
   * 读**已有的 manifest**，用来在重建时保留"不是本脚本产出"的字段。
   *
   * ⚠️ 为什么必须这么做（实测踩过）：
   *   manifest 是多个构建脚本共同维护的 —— build-spine 写基础字段，
   *   build-relations 追加 `relations`，语义层追加 `semantic`。
   *   而 build-spine 每次都是**整份重写** manifest，于是"重建脊柱"
   *   会把关系数据与语义层的登记一起抹掉，前端报"manifest 里没有任何学科登记关系数据"，
   *   看起来像关系功能坏了，其实只是登记被覆盖。
   *   代价：重建脊柱后不再需要重跑 build-relations（除非关系文件本身也变了）。
   */
  const prevPath = join(OUT, "manifest.json");
  const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, "utf8")) : null;
  const prevByDomain = new Map((prev?.domains ?? []).map((d) => [d.id, d]));
  /**
   * **本脚本自己产出的字段**清单。
   *
   * 除此之外的字段一律从上一版 manifest 原样搬过来 ——
   * 因为 manifest 是多个构建脚本共同维护的（build-meta 写 `meta`，
   * build-relations 写 `relations`，build-search 写 `search`，语义层写 `semantic`）。
   *
   * ⚠️ 这里踩过**两次**坑：第一次只硬编码了 relations/semantic，
   * 第二次加了 meta/search 才发现"每加一个脚本就得回来改这个列表"本身就不对。
   * 所以改成**白名单**：只有本脚本产出的字段会被覆盖，其余一律保留。
   * 这样以后新增构建脚本**不需要**回来改这里。
   */
  const OWN_FIELDS = new Set([
    "id", "zh", "en", "color", "color2", "blurb", "center", "radius", "tilt",
    "papers", "vocabSize", "slots", "cardinalityDigits", "vocabCoverage",
    "encodablePct", "truncatedPct", "oovPct", "spine", "vocab", "rank",
    "strata", "crossPct", "bridges",
  ]);
  const carried = new Map();

  for (const dom of list) {
    const file = join(TEXT, `${dom.id}.jsonl.gz`);
    if (!existsSync(file)) {
      log(`跳过 ${dom.id}（无 ${file}）`);
      continue;
    }
    log(`\n[${dom.id}] ${dom.zh}`);
    const { freq, papers, tokens, hasTitle } = await countTokens(file);
    const vocabList = buildVocab(freq, VOCAB_SIZE);
    const outDir = join(OUT, dom.id);
    mkdirSync(outDir, { recursive: true });
    const vocabPath = join(outDir, "vocab.json");
    writeFileSync(vocabPath, JSON.stringify({ id: dom.id, slots: SLOTS, words: vocabList.map((v) => v.w) }));
    writeFileSync(
      vocabPath + ".br",
      brotliCompressSync(readFileSync(vocabPath), { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }),
    );

    const catalog = { id: dom.id, vocab: vocabList.map((v) => v.w), slots: SLOTS };
    const cover = (() => {
      // 词表覆盖率：语料里有多少比例的**词出现次数**落在词表内
      let inVocab = 0;
      for (const v of vocabList) inVocab += v.c;
      return (100 * inVocab) / Math.max(1, tokens);
    })();
    log(
      `  词频统计：${papers.toLocaleString()} 篇 · ${tokens.toLocaleString()} 个词 · 不同词 ${freq.size.toLocaleString()} · ` +
        `有标题 ${((100 * hasTitle) / Math.max(1, papers)).toFixed(2)}%`,
    );
    log(
      `  词表 V=${vocabList.length} · 覆盖词次 ${cover.toFixed(1)}% · 目录容量 ${catalogSize(catalog).toString().length} 位十进制`,
    );
    log(`  高频词前 12：${vocabList.slice(0, 12).map((v) => `${v.w}(${v.c})`).join(" ")}`);

    const r = await buildSpine(file, dom, vocabList, outDir);
    domains.push({
      id: dom.id,
      zh: dom.zh,
      en: dom.en,
      color: dom.color,
      color2: dom.color2,
      blurb: dom.blurb,
      center: dom.center,
      radius: dom.radius,
      tilt: dom.tilt,
      papers: r.docId,
      vocabSize: vocabList.length,
      slots: SLOTS,
      cardinalityDigits: catalogDigits(catalog),
      vocabCoverage: Number(cover.toFixed(2)),
      encodablePct: Number(((100 * r.encoded) / Math.max(1, r.docId)).toFixed(2)),
      truncatedPct: Number(((100 * r.truncated) / Math.max(1, r.docId)).toFixed(3)),
      oovPct: Number(((100 * r.oovCount) / Math.max(1, r.docId)).toFixed(2)),
      spine: { file: `${dom.id}/spine.bin`, recordBytes: REC_BYTES },
      vocab: { file: `${dom.id}/vocab.json` },
      rank: { file: `${dom.id}/rank.bin`, recordBytes: 40, count: r.rankCount },
      /** 层号 → 层的元信息（顺序即层号；层号已写进编号表） */
      strata: r.strata.map((s, i) => ({
        index: i,
        id: s.id,
        l2: s.l2,
        zh: s.zh,
        en: s.en,
        arch: s.arch,
        papers: s.papers,
      })),
      crossPct: r.crossPct,
      bridges: r.bridges,
    });
    // 通用保留：把上一版里**不是本脚本产出**的字段原样搬过来。
    // 白名单式（见 OWN_FIELDS 的说明）—— 以后新增构建脚本不用回来改这里。
    const before = prevByDomain.get(dom.id);
    const last = domains[domains.length - 1];
    if (before) {
      for (const [k, v] of Object.entries(before)) {
        if (OWN_FIELDS.has(k)) continue;
        last[k] = v;
        carried.set(k, (carried.get(k) ?? 0) + 1);
      }
    }
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    scatterKey: SCATTER_KEY.toString(16),
    vocabSize: VOCAB_SIZE,
    slots: SLOTS,
    domains,
    totalPapers: domains.reduce((a, d) => a + d.papers, 0),
  };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(OUT, "manifest.json.br"),
    brotliCompressSync(readFileSync(join(OUT, "manifest.json")), {
      params: { [zc.BROTLI_PARAM_QUALITY]: 9 },
    }),
  );
  log(`\n合计 ${manifest.totalPapers.toLocaleString()} 篇 · manifest.json 已写`);
  if (carried.size > 0) {
    log(
      "（保留了上一版 manifest 里由其他构建脚本写入的字段：" +
        [...carried.entries()].map(([k, v]) => `${k} ${v} 个学科`).join(" · ") +
        "）",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
