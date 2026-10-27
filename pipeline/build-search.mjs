// @ts-nocheck
/**
 * 论文云 · 关键词检索索引
 * ============================================================================
 * 产出 `public/data/search/<domain>.idx.bin`：倒排索引（词 → 论文列表）。
 *
 * ## 为什么能做进浏览器（而不是做成服务端查询）
 *
 * 先量了真实分布再决定（`_measure-words.mjs`，物理团 30 万篇实测）：
 *   · 标题平均只有 **6.3 个不同词** —— 标题短，所以索引天然小；
 *   · 收录 df ∈ [5, 300000] 的词只需 **16,225 个词 / 179 万条倒排**；
 *   · 折算到全量 305 万篇约 **90 MB**（八团合计），可以整份给浏览器。
 *
 * 这一点很关键：如果做成"请求服务器查"，用户的每一次输入都要一次往返；
 * 而**数据本来就在本地**，做成浏览器内索引就能做到"边打字边变暗"。
 * （这与元数据不同：元数据是 2.5 GB，只能按 Range 取。）
 *
 * ## 文件布局（全部小端）
 *
 *   magic "LUNYIDX1"(8) | wordCount(u32) | postingCount(u32) | domainIndex(u32) | 保留(u32)
 *   词表：wordCount × 40 字节（UTF-8，不足补 0）
 *   词头：wordCount × 12 字节 = firstPosting(u32) | postingCount(u32) | df(u32)
 *   倒排：postingCount × 6 字节 = docId(u32) | tf(u16)
 *   docLen：count × 2 字节（每篇论文的词数，BM25 要用）
 *
 * 倒排里只存 **局部 docId**（不是全局 uid）：因为全局 uid 需要 30 位、
 * 装不进 u32 还得额外拆位；而检索本来就按学科分开做，
 * 跨学科的合并交给上层的 `(domainIndex, docId)` 处理更清楚。
 *
 * 用法：node pipeline/build-search.mjs [--domain physics]
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zc, createGunzip } from "node:zlib";

import { DOMAINS } from "../src/data/domains.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const TEXT = join(ROOT, "text");
const OUT = join(ROOT, "public", "data", "search");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ONLY = argVal("--domain", null);
/** df 下限：只出现 1–4 次的词基本是拼写变体与专有名词，收了只会让索引变大而检索变慢 */
const MIN_DF = Number(argVal("--min-df", "5"));
/** df 上限：出现在绝大多数论文里的词没有区分度（在任何学科里 df 都不会到 30 万） */
const MAX_DF = Number(argVal("--max-df", "300000"));

const WORD_BYTES = 40;
const HEAD_BYTES = 24;
const POSTING_BYTES = 6;

/**
 * 停用词。
 *
 * 注意：**只砍真正没有检索价值的词**。像 "quantum" "learning" "model" 这类
 * 虽然高频但正是用户会搜的词，绝不能砍 —— 它们靠 df 上限与 BM25 的 IDF 自然降权。
 */
const STOP = new Set(
  `a an the of for and to in on with by from using via based new novel study analysis approach method
   methods model models results result paper we our this that these those its their can may show shows
   proposed present presents investigate investigated towards toward high low large small two three one
   first second also such are was were is be been has have had not but more most other others than then
   when where which who whom under over between during within without across about into through after
   before while same different used use uses case cases general specific number total due set sets
   its it its upon toward per via non yet thus hence therefore however moreover furthermore additionally
   respectively ie eg etc et al`.split(/\s+/).filter(Boolean),
);

const WORD_RE = /[a-z][a-z0-9-]{1,}/g;

function log(m) {
  process.stdout.write(`${m}\n`);
}

function buildDomain(dom, domainIndex) {
  const file = join(TEXT, `${dom.id}.jsonl.gz`);
  if (!existsSync(file)) {
    log(`  跳过 ${dom.id}（无 ${file}）`);
    return null;
  }
  const t0 = Date.now();

  // 第一遍：词 → (docId, tf) 列表。用 Map<string, number[]> 存扁平数组 [docId, tf, docId, tf, …]
  const postings = new Map();
  const docLens = [];
  let docId = 0;

  return (async () => {
    const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()) });
    for await (const line of rl) {
      if (!line) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        docLens.push(0);
        docId++;
        continue;
      }
      const title = String(r.title ?? "").toLowerCase();
      const tf = new Map();
      for (const m of title.matchAll(WORD_RE)) {
        const w = m[0];
        if (w.length < 3 || STOP.has(w)) continue;
        tf.set(w, (tf.get(w) ?? 0) + 1);
      }
      docLens.push(tf.size);
      for (const [w, c] of tf) {
        let arr = postings.get(w);
        if (!arr) {
          arr = [];
          postings.set(w, arr);
        }
        arr.push(docId, c);
      }
      docId++;
      if (docId % 500000 === 0) log(`    … ${docId.toLocaleString()} 篇`);
    }
    rl.close();

    // 第二遍：按 df 过滤 + 排序（词按字典序，方便前端二分查找）
    const words = [];
    for (const [w, arr] of postings) {
      const df = arr.length / 2;
      if (df < MIN_DF || df > MAX_DF) continue;
      words.push([w, arr]);
    }
    words.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const wordCount = words.length;
    let postingCount = 0;
    for (const [, arr] of words) postingCount += arr.length / 2;

    const head = Buffer.alloc(HEAD_BYTES);
    head.write("LUNYIDX1", 0, "ascii");
    head.writeUInt32LE(wordCount, 8);
    head.writeUInt32LE(postingCount, 12);
    head.writeUInt32LE(domainIndex, 16);
    head.writeUInt32LE(0, 20);

    const wordBuf = Buffer.alloc(wordCount * WORD_BYTES);
    const wordHeadBuf = Buffer.alloc(wordCount * 12);
    const postBuf = Buffer.alloc(postingCount * POSTING_BYTES);
    const docLenBuf = Buffer.alloc(docId * 2);

    let postOff = 0;
    for (let i = 0; i < wordCount; i++) {
      const [w, arr] = words[i];
      const wb = Buffer.from(w, "utf8").subarray(0, WORD_BYTES - 1);
      wb.copy(wordBuf, i * WORD_BYTES);
      const df = arr.length / 2;
      wordHeadBuf.writeUInt32LE(postOff, i * 12);
      wordHeadBuf.writeUInt32LE(df, i * 12 + 4);
      wordHeadBuf.writeUInt32LE(df, i * 12 + 8);
      // 倒排按 docId 升序写：合并多个词的倒排时可以直接做"归并"，不必排序
      const pairs = [];
      for (let k = 0; k < arr.length; k += 2) pairs.push([arr[k], arr[k + 1]]);
      pairs.sort((a, b) => a[0] - b[0]);
      for (const [d, c] of pairs) {
        postBuf.writeUInt32LE(d, postOff * POSTING_BYTES);
        postBuf.writeUInt16LE(Math.min(65535, c), postOff * POSTING_BYTES + 4);
        postOff++;
      }
    }
    for (let i = 0; i < docId; i++) docLenBuf.writeUInt16LE(Math.min(65535, docLens[i]), i * 2);

    mkdirSync(OUT, { recursive: true });
    const buf = Buffer.concat([head, wordBuf, wordHeadBuf, postBuf, docLenBuf]);
    const p = join(OUT, `${dom.id}.idx.bin`);
    writeFileSync(p, buf);

    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const avgDf = postingCount / Math.max(1, wordCount);
    log(
      `  ${dom.id.padEnd(8)} ${docId.toLocaleString().padStart(10)} 篇 · ${wordCount.toLocaleString().padStart(7)} 词 · ` +
        `${postingCount.toLocaleString().padStart(10)} 条倒排（均 df ${avgDf.toFixed(0)}）· ${mb(buf.length)} · ${secs}s`,
    );
    return {
      file: `search/${dom.id}.idx.bin`,
      count: docId,
      words: wordCount,
      postings: postingCount,
      bytes: buf.length,
    };
  })();
}

async function main() {
  const list = ONLY ? DOMAINS.filter((d) => d.id === ONLY) : DOMAINS;
  mkdirSync(OUT, { recursive: true });
  const results = {};

  for (const dom of list) {
    log(`\n[${dom.id}] ${dom.zh}`);
    const domainIndex = DOMAINS.findIndex((d) => d.id === dom.id);
    results[dom.id] = await buildDomain(dom, domainIndex);
  }

  // 登记进 manifest（保留其他脚本写入的字段）
  const mPath = join(ROOT, "public", "data", "manifest.json");
  if (existsSync(mPath)) {
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    for (const d of m.domains) {
      const r = results[d.id];
      if (r) {
        d.search = {
          file: r.file,
          count: r.count,
          words: r.words,
          postings: r.postings,
          wordBytes: WORD_BYTES,
          postingBytes: POSTING_BYTES,
        };
      }
    }
    m.searchBuiltAt = new Date().toISOString();
    writeFileSync(mPath, JSON.stringify(m, null, 2));
    writeFileSync(
      `${mPath}.br`,
      brotliCompressSync(readFileSync(mPath), { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }),
    );
    const total = Object.values(results).reduce((a, r) => a + (r?.bytes ?? 0), 0);
    log(`\nmanifest.json 已登记 search · 八团索引合计 ${(total / 1048576).toFixed(0)} MB（未压缩，供浏览器 mmap 式读取）`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
