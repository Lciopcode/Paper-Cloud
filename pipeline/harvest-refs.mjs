// @ts-nocheck
/**
 * 论文云 · **真实引用列表**抓取（Semantic Scholar batch）
 * ============================================================================
 * 产出 `data/refs/<domain>.jsonl`：**每篇论文一行**，
 *
 *     {"d":<docId>,"in":[...库内被引 docId...],"ext":[[标题,年,DOI],...库外被引...]}
 *
 * ## 这一步是整个「引用线」的地基，而它以前被判定为"做不到"
 *
 * `docs/04-引用数据获取.md` 当时的三条结论是：
 *   · 本地语料**没有** references 字段（arXiv 题录本身不含参考文献）—— 至今成立；
 *   · OpenAlex 映射率个位数（DOI 口径对不上）—— 至今成立；
 *   · S2 匿名被硬限流、batch 端点**连接超时** —— **这一条现在不成立了**。
 *
 * 2026-11 实测（`_scratch/probe-cite-sources.mjs`）：
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `GET /paper/ARXIV:<id>?fields=references.*` | **429**（重试 3 次仍 429） |
 * | `POST /paper/batch?fields=references.*` | **200**，3 篇返回 41 / 53 / 63 条引用 |
 *
 * 而且返回的 `references[].externalIds.ArXiv` 就是 arXiv 号 ——
 * **两端都是 arXiv 号，映射是精确的**，这正是当初选 S2 而不选 OpenAlex 的那条理由。
 * 带 arXiv 号的比例实测 **92% / 73% / 73%**（三篇知名论文，偏高，全量会低一些）。
 *
 * ## 为什么只保留"库内"的边
 *
 * 一条边只要有一端不在我们库里，就没有坐标可画 —— 留下来只会变成
 * "点了没反应"的悬空数据（`docs/04` 里已经写过这一条，这里沿用）。
 * 但**库外的引用要留标题**：界面要用它渲染"这篇文章不在本库"的简介页，
 * 而那个页面需要标题才能生成知网 / 谷歌学术的检索链接。
 *
 * ## 库外的只留最有价值的那些
 *
 * 全量 305 万篇 × 约 45 条引用 ≈ 1.35 亿条，其中六成在库外 —— 那批标题约 8 GB，
 * 不可能当静态资产发。所以库外引用**只给被引次数最高的 `--extTop` 篇**留（默认 3000/学科），
 * 其余论文点开时如实显示"另有 N 条引用不在本库"。
 * 覆盖多少、留了多少，都由 `--status` 报出来，不靠猜。
 *
 * ## 可续跑
 *
 * 全量约 6,105 次请求、两小时以上，中途断掉是常态。分片 `<d>.part<NNNN>.jsonl`
 * 既是持久化单位也是进度单位（`<d>.progress.json`）：**已完成 ⟺ 已落盘**。
 *
 * 用法：
 *   node pipeline/harvest-refs.mjs --domain cs            # 跑一个学科
 *   node pipeline/harvest-refs.mjs                       # 全部
 *   node pipeline/harvest-refs.mjs --status              # 只看进度
 *   node pipeline/harvest-refs.mjs --merge --domain cs   # 合并分片
 */
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DOMAINS } from "../src/data/domains.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const TEXT = join(ROOT, "text");
const CITE_DIR = join(ROOT, "data", "cites");
const OUT = join(ROOT, "data", "refs");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ONLY = argVal("--domain", null);
const STATUS_ONLY = args.includes("--status");
const MERGE_ONLY = args.includes("--merge");
/** 只跑前 N 批（调试 / 先拿一小块数据用） */
const MAX_BATCHES = Number(argVal("--max-batches", "0"));

/** S2 batch 上限就是 500，别试 1000。 */
const BATCH = 500;
/** 一个分片含多少批（分片 = 持久化单位 = 进度单位，见文件头的说明） */
const BATCHES_PER_PART = 20;
/**
 * 批间隔（毫秒）。
 *
 * 匿名池是**全共享**的，贴着打会吃到 429。实测 1100ms 时连续 200 批没被挡；
 * 600ms 时约每 30 批一次 429。宁可慢一点，也别把两小时的活重跑。
 */
const GAP_MS = Number(argVal("--gap", "1100"));
/** 库里被引次数前多少篇才给库外引用留标题（见文件头） */
const EXT_TOP = Number(argVal("--extTop", "3000"));
const BASE_BACKOFF_MS = 4000;
const MAX_BACKOFF_MS = 60000;
const MAX_ATTEMPTS = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 日志同时写控制台与 `data/refs/harvest.log`。
 *
 * ⚠️ Node 的 stdout 重定向到文件时是**块缓冲**的：跑两小时的脚本，
 *    日志要等到 8KB 才落盘一次 —— 中途去看是空的，看起来像"卡住了"。
 *    这里显式 append（同步、无缓冲），于是 `Get-Content -Tail` 永远是最新的。
 */
const LOGF = join(OUT, "harvest.log");
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : String(x))).join(" ");
  console.log(line);
  try {
    appendFileSync(LOGF, line + "\n");
  } catch {
    /* 日志失败不能影响抓取 */
  }
};

mkdirSync(OUT, { recursive: true });

/** `1706.03762v5` / `hep-th/9901001` / `arXiv:1706.03762` 都归一成不带版本号的形态 */
export function normArxiv(s) {
  if (!s) return null;
  let v = String(s).trim().replace(/^arxiv:/i, "").replace(/^arXiv:/i, "");
  // 去掉末尾版本号（v1/v2/...），只在"数字结尾"的形态上做
  v = v.replace(/v\d+$/i, "");
  return v || null;
}

/**
 * 建"arXiv 号 → 全局 docId"的索引。
 *
 * 键里要带学科：不同学科的 docId 各自从 0 开始，单靠 docId 分不出是哪一团。
 * 于是打包成 `学科序号 * 2^22 + docId`（每团上限 419 万篇，实际最大 137 万）。
 */
async function buildIdIndex() {
  const map = new Map();
  for (let di = 0; di < DOMAINS.length; di++) {
    const d = DOMAINS[di];
    const f = join(TEXT, `${d.id}.jsonl.gz`);
    if (!existsSync(f)) {
      log(`  ⚠️ 缺 ${f}，跳过`);
      continue;
    }
    let docId = 0;
    const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      // 只要 id，别 JSON.parse 整行（3M 行 × 带摘要的解析是纯浪费）
      const i = line.indexOf('"id":"');
      if (i >= 0) {
        const j = line.indexOf('"', i + 6);
        const id = normArxiv(line.slice(i + 6, j));
        if (id && !map.has(id)) map.set(id, di * 4194304 + docId);
      }
      docId++;
    }
    log(`  ${d.id}: ${docId} 篇`);
  }
  return map;
}

/** 读被引次数表（只为了挑"哪些论文值得留库外引用"） */
function loadCites(domain) {
  const f = join(CITE_DIR, `${domain}.bin`);
  if (!existsSync(f)) return null;
  const buf = readFileSync(f);
  const count = buf.readUInt32LE(8);
  return { count, citesOf: (i) => (i >= 0 && i < count ? buf.readUInt32LE(24 + i * 8) : 0) };
}

/** 一篇论文的引用列表 → 拆成"库内 docId"与"库外标题" */
function splitRefs(refs, idIndex, di, keepExt) {
  const inIds = [];
  const ext = [];
  const seen = new Set();
  for (const r of refs ?? []) {
    const ax = normArxiv(r?.externalIds?.Arxiv ?? r?.externalIds?.ArXiv);
    const hit = ax ? idIndex.get(ax) : undefined;
    if (hit !== undefined) {
      const targetDi = Math.floor(hit / 4194304);
      const docId = hit % 4194304;
      // 只保留**同一团**的边：跨团的星在别的 `<group>` 里，坐标不同一套
      if (targetDi !== di) continue;
      if (docId === undefined || seen.has(docId)) continue;
      seen.add(docId);
      inIds.push(docId);
    } else if (keepExt) {
      const title = (r?.title ?? "").trim();
      if (!title) continue;
      const doi = r?.externalIds?.DOI ?? "";
      ext.push([title.slice(0, 300), r?.year ?? 0, doi]);
    }
  }
  return { inIds, ext };
}

async function postBatch(ids) {
  const url = "https://api.semanticscholar.org/graph/v1/paper/batch?fields=references.externalIds,references.title,references.year";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids.map((x) => `ARXIV:${x}`) }),
      });
      if (res.status === 429) {
        const wait = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
        log(`    429，退避 ${Math.round(wait / 1000)}s（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        log(`    HTTP ${res.status}（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）`);
        await sleep(BASE_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return await res.json();
    } catch (e) {
      log(`    网络错误 ${String(e).slice(0, 80)}（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）`);
      await sleep(BASE_BACKOFF_MS * (attempt + 1));
    }
  }
  return null;
}

/** 读某个学科的 arXiv 号列表（docId 顺序） */
async function arxivIdsOf(domain, limit) {
  const f = join(TEXT, `${domain}.jsonl.gz`);
  const out = [];
  const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (out.length >= limit) break;
    const i = line.indexOf('"id":"');
    if (i < 0) continue;
    const j = line.indexOf('"', i + 6);
    const id = normArxiv(line.slice(i + 6, j));
    if (id) out.push(id);
    else out.push(""); // 占位，保证 out 的下标 == docId
  }
  rl.close();
  return out;
}

function progressPath(domain) {
  return join(OUT, `${domain}.progress.json`);
}
function readProgress(domain) {
  const p = progressPath(domain);
  if (!existsSync(p)) return { doneParts: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { doneParts: [] };
  }
}
function writeProgress(domain, obj) {
  writeFileSync(progressPath(domain), JSON.stringify(obj));
}

/** 合并分片 → `<domain>.jsonl` */
function mergeParts(domain) {
  const parts = readdirSync(OUT)
    .filter((f) => f.startsWith(`${domain}.part`) && f.endsWith(".jsonl"))
    .sort();
  if (!parts.length) {
    log(`  ${domain}: 没有分片可合并`);
    return;
  }
  const out = createWriteStream(join(OUT, `${domain}.jsonl`));
  let lines = 0;
  for (const p of parts) {
    const buf = readFileSync(join(OUT, p), "utf8");
    out.write(buf);
    lines += buf.split("\n").filter(Boolean).length;
  }
  out.end();
  log(`  ${domain}: 合并 ${parts.length} 个分片 → ${lines} 行`);
}

async function main() {
  if (STATUS_ONLY) {
    log("学科        分片数   已完成批   估计进度");
    for (const d of DOMAINS) {
      if (ONLY && d.id !== ONLY) continue;
      const parts = readdirSync(OUT).filter((f) => f.startsWith(`${d.id}.part`) && f.endsWith(".jsonl"));
      const pr = readProgress(d.id);
      let lines = 0;
      for (const p of parts) lines += readFileSync(join(OUT, p), "utf8").split("\n").filter(Boolean).length;
      log(`  ${d.id.padEnd(10)} ${String(parts.length).padStart(5)}   ${String(pr.doneParts.length * BATCHES_PER_PART).padStart(7)}   ${lines} 篇`);
    }
    return;
  }

  if (MERGE_ONLY) {
    for (const d of DOMAINS) {
      if (ONLY && d.id !== ONLY) continue;
      mergeParts(d.id);
    }
    return;
  }

  log("建 arXiv 号 → docId 索引（约 305 万条，需要几十秒）…");
  const t0 = Date.now();
  const idIndex = await buildIdIndex();
  log(`  索引 ${idIndex.size} 条，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  for (let di = 0; di < DOMAINS.length; di++) {
    const d = DOMAINS[di];
    if (ONLY && d.id !== ONLY) continue;
    const textFile = join(TEXT, `${d.id}.jsonl.gz`);
    if (!existsSync(textFile)) continue;

    const cites = loadCites(d.id);
    /**
     * 只有被引次数排进前 `EXT_TOP` 的论文才留库外引用标题。
     * 做法：取被引次数的第 (count - EXT_TOP) 分位当阈值，不必排序整表。
     */
    let extThreshold = Infinity;
    if (cites && EXT_TOP > 0) {
      const hist = new Uint32Array(4096);
      for (let i = 0; i < cites.count; i++) {
        const c = cites.citesOf(i);
        hist[Math.min(4095, c === 0 ? 0 : 32 - Math.clz32(c))]++;
      }
      let acc = 0;
      for (let b = 4095; b >= 0; b--) {
        acc += hist[b];
        if (acc >= EXT_TOP) {
          extThreshold = b === 0 ? 1 : 2 ** (b - 1);
          break;
        }
      }
    }

    const pr = readProgress(d.id);
    const ids = await arxivIdsOf(d.id, Infinity);
    const nBatches = Math.ceil(ids.length / BATCH);
    log(`=== ${d.id}：${ids.length} 篇 / ${nBatches} 批（库外标题阈值 cites≥${extThreshold === Infinity ? "—" : extThreshold}）`);

    let batched = 0;
    for (let part = 0; part * BATCHES_PER_PART < nBatches; part++) {
      if (pr.doneParts.includes(part)) continue;
      if (MAX_BATCHES && batched >= MAX_BATCHES) break;
      const partFile = join(OUT, `${d.id}.part${String(part).padStart(4, "0")}.jsonl`);
      const lines = [];
      const p0 = part * BATCHES_PER_PART;
      const p1 = Math.min(nBatches, p0 + BATCHES_PER_PART);
      let ok = true;
      for (let b = p0; b < p1; b++) {
        if (MAX_BATCHES && batched >= MAX_BATCHES) break;
        const slice = ids.slice(b * BATCH, (b + 1) * BATCH);
        const valid = slice.map((x, k) => (x ? k : -1)).filter((k) => k >= 0);
        if (!valid.length) continue;
        const res = await postBatch(valid.map((k) => slice[k]));
        if (!res) {
          log(`  ✗ 第 ${b} 批失败，本片作废（已抓的会重跑，不会写出半个片）`);
          ok = false;
          break;
        }
        for (let k = 0; k < valid.length; k++) {
          const docId = b * BATCH + valid[k];
          const keepExt = cites ? cites.citesOf(docId) >= extThreshold : false;
          const { inIds, ext } = splitRefs(res[k]?.references, idIndex, di, keepExt);
          if (!inIds.length && !ext.length) continue;
          lines.push(JSON.stringify(keepExt ? { d: docId, in: inIds, ext } : { d: docId, in: inIds }));
        }
        batched++;
        await sleep(GAP_MS);
      }
      if (!ok) break;
      writeFileSync(partFile, lines.join("\n") + (lines.length ? "\n" : ""));
      pr.doneParts.push(part);
      writeProgress(d.id, pr);
      log(`  片 ${part}：${lines.length} 篇有引用 → ${partFile.split(/[\\/]/).pop()}（累计 ${pr.doneParts.length} 片）`);
    }
  }
  log("\n完成。跑 `--merge` 合并分片，再跑 `pipeline/build-citations.mjs`。");
}

await main();
