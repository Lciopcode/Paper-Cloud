// @ts-nocheck
/**
 * 论文云 · 引用边抓取（OpenAlex **反向查询**版，用作 S2 匿名限流时的通路）
 * ============================================================================
 * 产出与 `harvest-refs.mjs` **完全相同的格式**（`data/refs/<d>.jsonl`），
 * 所以下游 `build-citations.mjs` 与前端一个字都不用改。
 *
 * ## 为什么不用 OpenAlex 的 `referenced_works`（docs/04 已经判过死刑）
 *
 * 正向查（本篇 → 它引用了谁）拿到的是一串 OpenAlex ID，要把每个 ID 变回 arXiv 号
 * 得**再来一次请求**；而题库是纯 arXiv，DOI 口径对不上，历史实测映射率个位数百分比。
 * 更致命的是配额：实测响应头 `x-ratelimit-limit: 1000`（**每 24 小时 1000 次**，
 * 不是文档里写的 10 万）。全量 305 万篇 × 两次请求 = 天文数字。
 *
 * ## 反向查询为什么能绕过去
 *
 * `filter=cites:W<id>` 一次就给出**"谁引用了这篇"**，而且每条结果自带
 * `locations[].landing_page_url` —— arXiv 论文的那条就是 `arxiv.org/abs/<号>`。
 * 于是：**一次请求直接拿到"引用方 → 被引方"的完整边**，不需要任何反查。
 *
 * 代价是边的方向反了：这样抓到的是**射向热门论文的边**。但对界面毫无影响 ——
 * 界面要的是"某篇论文引用了谁"，而一条 `A 引用 B` 的边在 A 的扇形里就是一条线。
 * 于是这批数据能点亮的是**所有引用过这些热门论文的论文**（几十万篇），
 * 而不是"只有热门论文自己能被点开"。这个选择是用覆盖率换请求数，划算得多。
 *
 * ## 配额
 *
 * 每 24 小时 1000 次。脚本按 `--budget` 停手，并把用掉的次数记在
 * `data/refs/.openalex-usage.json` 里（含重置时间），下次接着算 ——
 * 不靠"我记得今天跑过"。
 *
 * 用法：
 *   node pipeline/harvest-refs-openalex.mjs --targets 40 --budget 900
 *   node pipeline/harvest-refs-openalex.mjs --status
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
const USAGE = join(OUT, ".openalex-usage.json");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const STATUS_ONLY = args.includes("--status");
const ONLY = argVal("--domain", null);
/** 每个学科挑多少篇"最热门"的论文当靶子 */
const TARGETS = Number(argVal("--targets", "40"));
/** 本次最多发多少次请求 */
const BUDGET = Number(argVal("--budget", "900"));
/** 每个靶子最多取多少条引用方（OpenAlex 单页上限 200） */
const PER_TARGET = Math.min(200, Number(argVal("--per", "200")));
const MAILTO = argVal("--mailto", "dev@example.com");
const GAP_MS = Number(argVal("--gap", "130"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

/** 规范化 arXiv 号（去前缀、去版本号） */
function normArxiv(s) {
  if (!s) return null;
  const v = String(s).trim().replace(/^arxiv:/i, "").replace(/v\d+$/i, "");
  return v || null;
}
/** 从 landing_page_url 里抠 arXiv 号 */
function arxivFromUrl(u) {
  const m = /arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})/i.exec(u ?? "");
  return m ? m[1] : null;
}

let used = 0;
function readUsage() {
  if (!existsSync(USAGE)) return { spent: 0, resetAt: 0 };
  try {
    return JSON.parse(readFileSync(USAGE, "utf8"));
  } catch {
    return { spent: 0, resetAt: 0 };
  }
}
function writeUsage(o) {
  writeFileSync(USAGE, JSON.stringify(o));
}

/** 发一次请求（带配额记账与 429 处理） */
async function oa(path) {
  if (used >= BUDGET) return { skip: true };
  const u = `https://api.openalex.org/${path}${path.includes("?") ? "&" : "?"}mailto=${MAILTO}`;
  used++;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(u);
    const limit = Number(res.headers.get("x-ratelimit-limit") ?? 0);
    const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? NaN);
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
    if (limit || !Number.isNaN(remaining)) {
      const now = readUsage();
      writeUsage({ spent: now.spent + 1, resetAt: reset });
    }
    if (res.status === 429) {
      const wait = 5000 * (attempt + 1);
      console.log(`    429（剩余 ${remaining}，${reset}s 后重置），等 ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      console.log(`    HTTP ${res.status}`);
      return { err: res.status };
    }
    return { json: await res.json(), remaining };
  }
  return { err: "retry" };
}

/** arXiv 号 → 打包的 (学科序号, docId) */
async function buildIdIndex() {
  const map = new Map();
  for (let di = 0; di < DOMAINS.length; di++) {
    const d = DOMAINS[di];
    const f = join(TEXT, `${d.id}.jsonl.gz`);
    if (!existsSync(f)) continue;
    let docId = 0;
    const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line) {
        const i = line.indexOf('"id":"');
        if (i >= 0) {
          const j = line.indexOf('"', i + 6);
          const id = normArxiv(line.slice(i + 6, j));
          if (id && !map.has(id)) map.set(id, di * 4194304 + docId);
        }
      }
      docId++;
    }
  }
  return map;
}

/** 各学科 docId → arXiv 号（挑靶子时用） */
async function arxivIdsOf(domain) {
  const f = join(TEXT, `${domain}.jsonl.gz`);
  const out = [];
  const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    const i = line.indexOf('"id":"');
    if (i < 0) {
      out.push("");
      continue;
    }
    const j = line.indexOf('"', i + 6);
    out.push(normArxiv(line.slice(i + 6, j)) ?? "");
  }
  return out;
}

/** 被引次数表 → 前 N 名 docId */
function topCited(domain, n) {
  const f = join(CITE_DIR, `${domain}.bin`);
  if (!existsSync(f)) return [];
  const buf = readFileSync(f);
  const count = buf.readUInt32LE(8);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const c = buf.readUInt32LE(24 + i * 8);
    if (c > 0) rows.push([c, i]);
  }
  rows.sort((a, b) => b[0] - a[0]);
  return rows.slice(0, n).map((r) => r[1]);
}

const usage = readUsage();
if (STATUS_ONLY) {
  console.log(`OpenAlex 配额：已用 ${usage.spent}（重置倒计时 ${usage.resetAt}s）`);
  process.exit(0);
}
console.log(`OpenAlex 配额：历史已用 ${usage.spent}，重置倒计时 ${usage.resetAt}s；本次预算 ${BUDGET}\n`);

const idIndex = await buildIdIndex();
console.log(`arXiv 号索引 ${idIndex.size} 条`);

let totalEdges = 0;
for (let di = 0; di < DOMAINS.length; di++) {
  const d = DOMAINS[di];
  if (ONLY && d.id !== ONLY) continue;
  const ids = await arxivIdsOf(d.id);
  const tops = topCited(d.id, TARGETS);
  if (!tops.length) {
    console.log(`${d.id}: 没有被引数据，跳过`);
    continue;
  }
  console.log(`=== ${d.id}：${tops.length} 个靶子（被引最高）`);

  /** 靶子 → OpenAlex ID：按 DOI 批量查，一次 50 个 */
  const doiBatch = [];
  for (const docId of tops) {
    const ax = ids[docId];
    if (ax) doiBatch.push({ docId, doi: `10.48550/arxiv.${ax}` });
  }
  const targetW = new Map(); // docId -> W id
  for (let i = 0; i < doiBatch.length; i += 50) {
    const chunk = doiBatch.slice(i, i + 50);
    const filter = chunk.map((c) => c.doi).join("|");
    const r = await oa(`works?filter=doi:${filter}&select=id,doi&per-page=50`);
    if (r.skip || r.err) break;
    const byDoi = new Map((r.json.results ?? []).map((w) => [String(w.doi ?? "").toLowerCase(), w.id]));
    for (const c of chunk) {
      const hit = byDoi.get(`https://doi.org/${c.doi}`.toLowerCase());
      if (hit) targetW.set(c.docId, hit.split("/").pop());
    }
    await sleep(GAP_MS);
  }
  console.log(`  查到 OpenAlex 记录 ${targetW.size}/${doiBatch.length}`);

  /** 每个靶子查"谁引用了它" */
  const outFile = join(OUT, `${d.id}.openalex.jsonl`);
  const lines = [];
  let edges = 0;
  for (const [targetDoc, wid] of targetW) {
    const r = await oa(
      `works?filter=cites:${wid}&select=id,doi,locations,publication_year&per-page=${PER_TARGET}`,
    );
    if (r.skip) {
      console.log("  预算用完，停手");
      break;
    }
    if (r.err) continue;
    for (const w of r.json.results ?? []) {
      // 引用方必须是**我们库里的**论文，否则没有坐标
      let ax = normArxiv((w.doi ?? "").replace(/^https:\/\/doi\.org\//i, "").replace(/^10\.48550\/arxiv\./i, ""));
      if (!ax) {
        for (const loc of w.locations ?? []) {
          const v = arxivFromUrl(loc?.landing_page_url) ?? arxivFromUrl(loc?.pdf_url);
          if (v) {
            ax = normArxiv(v);
            break;
          }
        }
      }
      if (!ax) continue;
      const hit = idIndex.get(ax);
      if (hit === undefined) continue;
      const srcDi = Math.floor(hit / 4194304);
      const srcDoc = hit % 4194304;
      if (srcDi !== di || srcDoc === targetDoc) continue;
      lines.push(JSON.stringify({ d: srcDoc, in: [targetDoc] }));
      edges++;
    }
    await sleep(GAP_MS);
    if (used >= BUDGET) break;
  }
  // 同一篇论文可能出现多行（它引用了多个靶子）—— 合并成一行，下游按 d 覆盖
  const merged = new Map();
  for (const l of lines) {
    const o = JSON.parse(l);
    const cur = merged.get(o.d) ?? new Set();
    for (const x of o.in) cur.add(x);
    merged.set(o.d, cur);
  }
  const body = [...merged.entries()].map(([k, v]) => JSON.stringify({ d: k, in: [...v] })).join("\n");
  writeFileSync(outFile, body + (body ? "\n" : ""));
  console.log(`  → ${outFile}：${merged.size} 篇引用方 · ${edges} 条边`);
  totalEdges += edges;
  if (used >= BUDGET) break;
}
console.log(`\n本次请求 ${used} 次，共 ${totalEdges} 条边。下次接着跑会自动累加。`);
