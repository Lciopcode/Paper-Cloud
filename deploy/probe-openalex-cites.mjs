// @ts-nocheck
/**
 * 论文云 · OpenAlex「谁引用了它」反查探针（`/api/refs` 的 cites 方向）
 * ============================================================================
 * 背景（`交付安排.md` §4④ / §8-3）：
 *   OpenAlex 兜底以前只取 `referenced_works`（**它引用了谁**）。S2 不认的老式号
 *   （`hep-th/9108028` 这种）走 OpenAlex 时，`mode=cites` 永远是空数组 ——
 *   屏幕上"被引用"方向一根线都没有。本探针就是给这条补上的通道留证据。
 *
 * ## 怎么跑
 *
 *   node deploy/probe-openalex-cites.mjs                       # 自己起 5312 → 测 → 关，行为 "after"
 *   node deploy/probe-openalex-cites.mjs --tag baseline        # 同一套测，标成基线
 *   node deploy/probe-openalex-cites.mjs --url http://127.0.0.1:5312   # 对已启动的服务器打请求（不自己起）
 *   node deploy/probe-openalex-cites.mjs --no-clean            # 不清缓存（验缓存命中路径）
 *   node deploy/probe-openalex-cites.mjs --no-direct           # 不做直连 OpenAlex 的原始数据校验
 *
 * 默认端口 **5312**（不要动 5311 那个服务）。证据落 `data/probe-openalex-cites/<tag>.json`。
 *
 * ## 测什么
 *
 *   1. 老式号 `physics/1`（`hep-th/9108028`，1991 综述，S2 batch 不认）：
 *      `mode=cites` / `mode=all` / `mode=refs` 三个方向的 in[] / ext[] 条数与片段。
 *   2. 新式号 `cs/3308`（`0704.0062`，S2 正常）：`mode=all` / `mode=refs` 回归
 *      —— cites 补上后 all 的 in[] 不能变少，refs 方向不能变。
 *   3. 缓存路径 `cs/45678`（`交付安排.md` §9 的验收 URL）：必须仍是 `cached:true` 且毫秒级返回。
 *   4. 缓存按 mode 分开：老式号 `cites/all/refs` 三个方向第二次都要 `cached:true`，
 *      且内容与首次联网结果一致（**不能串方向**）。
 *   5. 暖索引下新式号 `cs/3311` 的 S2 请求耗时（排除首次建 146 万行索引的干扰，
 *      证明 S2 通路没被本次改动拖慢）。
 *   6. 直连 OpenAlex 复核：该 work 的 `cited_by_count` 与 `filter=cites:` 原始结果条数，
 *      证明服务器返回的 in/ext 不是凭空造的。
 *
 * ## 为什么要清缓存
 *
 *   `/api/refs` 结果按 `<domain>/<doc>.<mode>.json` 落盘，**同一篇第二次就是读本地**。
 *   基线（改动前）和 after（改动后）如果共用缓存，第二次会直接命中第一次的缓存，
 *   测到的就是"缓存长什么样"，而不是"新代码发不发得出请求"。所以默认对**样本 doc**
 *   的 all/cites/refs 缓存做精确删除（只删这三个文件名，不动别的学科/别的论文）。
 *
 * ## 对外网的礼貌
 *
 *   OpenAlex 每 request 都带 `mailto`；直连校验之间 700ms 间隔；服务器侧连续 chunk
 *   请求之间也有 400ms 间隔（`api-refs.mjs`）。429 由 `api-refs.mjs` 单次退避，
 *   探针本身不重试（避免风暴）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const CACHE = join(ROOT, "data", "refs-cache");
const EVID = join(ROOT, "data", "probe-openalex-cites");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes(n);
const PORT = Number(argVal("--port", "5312"));
const URL_ARG = argVal("--url", "");
const BASE = URL_ARG.replace(/\/+$/, "") || `http://127.0.0.1:${PORT}`;
const TAG = argVal("--tag", "after");
const CLEAN = !has("--no-clean");
const DIRECT = !has("--no-direct");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 样本（**都是现查过语料的**，不是编的）：
 *   physics doc 1   = hep-th/9108028（1991，Ginsparg 综述；S2 老式号 400）
 *   cs doc 3308     = 0704.0062（2007，新式号；S2 正常）
 *   cs doc 45678    = 交付安排 §9 的验收 URL 那篇（缓存里已有 all）
 */
const OLD = { label: "老式号 physics/1 = hep-th/9108028", domain: "physics", doc: 1, arxivId: "hep-th/9108028" };
const MODERN = { label: "新式号 cs/3308 = 0704.0062", domain: "cs", doc: 3308, arxivId: "0704.0062" };
const MODERN2 = { label: "新式号 cs/3311 = 0704.0090（暖索引耗时对照）", domain: "cs", doc: 3311, arxivId: "0704.0090" };
const CACHED = { label: "缓存样本 cs/45678（交付安排 §9 验收 URL）", domain: "cs", doc: 45678 };

const MAIL = "mailto=papercloud@example.com";
const UA = "papercloud-probe/1.0 (mailto:papercloud@example.com)";

// ---------------------------------------------------------------------------
// 缓存清理（只动样本 doc 的指定 mode 文件）
// ---------------------------------------------------------------------------
function cleanSample(sample, modes) {
  const removed = [];
  for (const m of modes) {
    const f = join(CACHE, sample.domain, `${sample.doc}.${m}.json`);
    if (existsSync(f)) {
      try {
        unlinkSync(f);
        removed.push(f.replace(ROOT, "."));
      } catch {
        /* 删不掉就让它命中缓存，探针里会显示 cached:true 可辨认 */
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 起/停自己的服务器（5312，绝不碰 5311）
// ---------------------------------------------------------------------------
async function ensureServer() {
  if (URL_ARG) {
    const ok = await ping();
    if (!ok) throw new Error(`--url ${BASE} 连不上（/api/refs-stats 无响应）`);
    return { child: null, log: "(使用已启动的 " + BASE + ")" };
  }
  if (await ping()) {
    /**
     * ⚠️ 端口上已有服务：可能上一次探针没关干净。**不接管** —— 直接报错，
     * 免得"以为起了新代码、其实打在旧进程上"，测出一堆假数据。
     */
    throw new Error(`端口 ${PORT} 已有服务在监听。先确认它是谁（Get-NetTCPConnection -LocalPort ${PORT}），或换 --port。`);
  }
  const child = spawn(process.execPath, ["deploy/serve.mjs", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 80; i++) {
    if (await ping()) return { child, log };
    await sleep(250);
  }
  child.kill();
  throw new Error(`5312 服务器 20 秒内没起来。日志：\n${log.slice(0, 1000)}`);
}

async function ping() {
  try {
    const r = await fetch(`${BASE}/api/refs-stats`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 打接口
// ---------------------------------------------------------------------------
/** 第一次 physics 请求要现场建 arXiv↔docId 索引（语料 146 万行，约 17 秒），超时给足。 */
const REQ_TIMEOUT = 240000;

function summarize(j) {
  const inArr = Array.isArray(j.in) ? j.in : null;
  const extArr = Array.isArray(j.ext) ? j.ext : null;
  return {
    cached: !!j.cached,
    arxivId: j.arxivId ?? null,
    source: j.source ?? null,
    mode: j.mode ?? null,
    inCount: inArr ? inArr.length : null,
    extCount: extArr ? extArr.length : null,
    inSample: inArr ? inArr.slice(0, 10) : null,
    extSample: extArr ? extArr.slice(0, 3) : null,
    note: j.note ?? undefined,
    err: j.error ?? undefined,
    warn: j.warn ?? undefined,
  };
}

async function api(qs, label) {
  const url = `${BASE}/api/refs?${qs}`;
  const t = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
    const j = await r.json();
    const out = { label, url, status: r.status, ms: Date.now() - t, ...summarize(j), raw: j };
    console.log(
      `  ${label.padEnd(14)} ${String(out.ms).padStart(6)}ms  status=${out.status}` +
        `  in=${out.inCount ?? "?"} ext=${out.extCount ?? "?"}` +
        `  source=${out.source ?? "-"} arxivId=${out.arxivId ?? "-"}` +
        `${out.cached ? "  [cached]" : ""}${out.err ? "  ERR=" + out.err : ""}`,
    );
    return out;
  } catch (e) {
    const out = { label, url, status: 0, ms: Date.now() - t, error: String(e).slice(0, 300) };
    console.log(`  ${label.padEnd(14)} ${String(out.ms).padStart(6)}ms  FAILED: ${out.error}`);
    return out;
  }
}

// ---------------------------------------------------------------------------
// 直连 OpenAlex 复核（不经服务器，证明原始 count 是多少）
// ---------------------------------------------------------------------------
async function directOpenAlex(sample) {
  const out = { sample: sample.label, doi: `10.48550/arXiv.${sample.arxivId}` };
  const u1 = `https://api.openalex.org/works/doi:${encodeURIComponent(out.doi)}?${MAIL}`;
  const t1 = Date.now();
  const r1 = await fetch(u1, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
  out.workStatus = r1.status;
  out.workMs = Date.now() - t1;
  if (!r1.ok) {
    out.error = `works/doi HTTP ${r1.status}`;
    return out;
  }
  const w = await r1.json();
  out.workId = String(w.id ?? "").split("/").pop();
  out.citedByCount = w.cited_by_count ?? null;
  out.referencedWorksCount = (w.referenced_works ?? []).length;
  out.workDoi = w.doi ?? null;
  await sleep(700);

  // 分页/上限的实测依据：per-page 最大 200，超出会被 API 拒绝（见报告）
  const u2 =
    `https://api.openalex.org/works?filter=cites:${out.workId}&per-page=200` +
    `&sort=publication_date:desc&select=id,doi,display_name,publication_year&${MAIL}`;
  const t2 = Date.now();
  const r2 = await fetch(u2, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
  out.citesStatus = r2.status;
  out.citesMs = Date.now() - t2;
  if (r2.ok) {
    const j = await r2.json();
    out.citesRawCount = j.meta?.count ?? null;
    out.citesPageSize = j.results?.length ?? null;
    out.citesPerPageMeta = j.meta?.per_page ?? null;
    const doiList = (j.results ?? []).map((x) => String(x.doi ?? ""));
    out.arxivDoiInPage = doiList.filter((d) => /10\.48550\/arxiv[.\/]/i.test(d)).length;
    out.firstArxivDois = doiList.filter((d) => /10\.48550\/arxiv[.\/]/i.test(d)).slice(0, 6);
    out.sampleTitles = (j.results ?? []).slice(0, 3).map((x) => ({
      title: String(x.display_name ?? "").slice(0, 80),
      year: x.publication_year ?? 0,
      doi: x.doi ?? null,
    }));
  } else {
    out.citesError = `cites HTTP ${r2.status}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const t0 = Date.now();
if (!existsSync(EVID)) mkdirSync(EVID, { recursive: true });
console.log(`\n=== OpenAlex 反查探针 · tag=${TAG} · ${BASE} ===`);
console.log(`样本：${OLD.label} / ${MODERN.label} / ${CACHED.label}\n`);

const removed = [];
if (CLEAN) {
  removed.push(...cleanSample(OLD, ["all", "cites", "refs"]));
  removed.push(...cleanSample(MODERN, ["all", "refs"]));
  removed.push(...cleanSample(MODERN2, ["all"]));
  // CACHED 不清：就是要验它命中缓存
}
if (removed.length) {
  console.log("已清缓存（保证真的走网络）：");
  for (const f of removed) console.log("  - " + f);
  console.log("");
}

const { child, log } = await ensureServer();
let evidence = null;
const results = {};
const checks = [];
const fails = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (!ok) fails.push(name);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

try {
  // ---- 直连复核（也顺便确认 OpenAlex 此刻可达） ----
  let direct = null;
  if (DIRECT) {
    console.log("[0] 直连 OpenAlex 原始数据（mailto 已带）");
    try {
      direct = await directOpenAlex(OLD);
      console.log(
        `  work=${direct.workId} cited_by=${direct.citedByCount} refs=${direct.referencedWorksCount}` +
          `  cites.count=${direct.citesRawCount} page=${direct.citesPageSize} arxivDoi=${direct.arxivDoiInPage}`,
      );
      if (direct.error || direct.citesError) check("直连 OpenAlex 可用", false, direct.error || direct.citesError);
      else check("直连 OpenAlex 可用", true, `HTTP ${direct.workStatus}/${direct.citesStatus}`);
    } catch (e) {
      console.log(`  直连失败（不阻塞服务器侧测量）：${String(e).slice(0, 160)}`);
      check("直连 OpenAlex 可用", false, String(e).slice(0, 160));
    }
    await sleep(700);
  }

  // ---- 服务器侧：老式号三个方向 ----
  console.log("\n[1] 老式号 physics/1（hep-th/9108028）三个方向");
  results.oldCites = await api(`domain=${OLD.domain}&doc=${OLD.doc}&mode=cites`, "old cites");
  await sleep(400);
  results.oldAll = await api(`domain=${OLD.domain}&doc=${OLD.doc}&mode=all`, "old all");
  await sleep(400);
  results.oldRefs = await api(`domain=${OLD.domain}&doc=${OLD.doc}&mode=refs`, "old refs");

  // ---- 服务器侧：新式号回归 ----
  console.log("\n[2] 新式号 cs/3308（0704.0062）回归");
  results.modernAll = await api(`domain=${MODERN.domain}&doc=${MODERN.doc}&mode=all`, "modern all");
  await sleep(400);
  results.modernRefs = await api(`domain=${MODERN.domain}&doc=${MODERN.doc}&mode=refs`, "modern refs");

  // ---- 缓存路径 ----
  console.log("\n[3] 缓存命中路径 cs/45678（验收 URL）");
  results.cachedAll = await api(`domain=${CACHED.domain}&doc=${CACHED.doc}&mode=all`, "cached all");
  results.cachedAgain = await api(`domain=${CACHED.domain}&doc=${CACHED.doc}&mode=all`, "cached again");

  // ---- 缓存按 mode 分开：不清缓存，把老式号三个方向再打一遍 ----
  console.log("\n[3b] 缓存按 mode 分开（同一个 doc 的 cites/all/refs 三个文件各自命中）");
  results.oldCitesCached = await api(`domain=${OLD.domain}&doc=${OLD.doc}&mode=cites`, "old cites #2");
  results.oldAllCached = await api(`domain=${OLD.domain}&doc=${OLD.doc}&mode=all`, "old all #2");
  results.oldRefsCached = await api(`domain=${OLD.domain}&doc=${OLD.doc}&mode=refs`, "old refs #2");

  // ---- 暖索引下的新式号请求：排除「第一次要建 146 万行索引」的耗时干扰 ----
  console.log("\n[3c] 暖索引下的新式号请求 cs/3311（S2 通路耗时）");
  results.modernWarm = await api(`domain=${MODERN2.domain}&doc=${MODERN2.doc}&mode=all`, "modern warm");

  // ---- 断言 ----
  console.log("\n[4] 检查");
  for (const k of ["oldCites", "oldAll", "oldRefs", "modernAll", "modernRefs", "cachedAll"]) {
    const r = results[k];
    check(`${k} 返回 200`, r.status === 200, r.status === 200 ? `${r.ms}ms` : `status=${r.status} ${r.error ?? ""}`);
  }
  check(
    "缓存路径 cs/45678 仍是 cached:true 且 < 1500ms",
    results.cachedAll.cached === true && results.cachedAll.ms < 1500,
    `cached=${results.cachedAll.cached} ms=${results.cachedAll.ms}`,
  );
  check(
    "缓存按 mode 分开（cites/all/refs 三个文件各自 cached:true）",
    results.oldCitesCached.cached === true &&
      results.oldAllCached.cached === true &&
      results.oldRefsCached.cached === true,
    `cites=${results.oldCitesCached.cached} all=${results.oldAllCached.cached} refs=${results.oldRefsCached.cached}`,
  );
  const sameIO = (a, b) => JSON.stringify([a.raw?.in, a.raw?.ext]) === JSON.stringify([b.raw?.in, b.raw?.ext]);
  check(
    "按 mode 命中缓存的内容与首次联网结果一致（缓存没串方向）",
    sameIO(results.oldCitesCached, results.oldCites) &&
      sameIO(results.oldAllCached, results.oldAll) &&
      sameIO(results.oldRefsCached, results.oldRefs),
    `cites ${results.oldCitesCached.inCount}/${results.oldCitesCached.extCount} vs ${results.oldCites.inCount}/${results.oldCites.extCount}`,
  );
  check(
    "暖索引下新式号 S2 请求 < 8000ms（S2 通路没被改动拖慢）",
    results.modernWarm.status === 200 && results.modernWarm.ms < 8000,
    `${results.modernWarm.ms}ms in=${results.modernWarm.inCount} ext=${results.modernWarm.extCount}`,
  );
  check(
    "新式号 modern all 的 in[] 非空（S2 通路正常）",
    (results.modernAll.inCount ?? 0) > 0,
    `in=${results.modernAll.inCount} ext=${results.modernAll.extCount}`,
  );
  check(
    "新式号 modern refs 的 ext[] 非空（refs 通路正常）",
    (results.modernRefs.inCount ?? 0) + (results.modernRefs.extCount ?? 0) > 0,
    `in=${results.modernRefs.inCount} ext=${results.modernRefs.extCount}`,
  );
  if (results.oldCites.err && results.oldCites.inCount === 0 && results.oldCites.extCount === 0) {
    check("old cites 无错误", false, String(results.oldCites.err));
  }

  // ---- 与基线对比 ----
  const baseFile = join(EVID, "baseline.json");
  let baseline = null;
  if (TAG !== "baseline" && existsSync(baseFile)) {
    try {
      baseline = JSON.parse(readFileSync(baseFile, "utf8"));
    } catch {
      baseline = null;
    }
  }
  const deltas = null;
  console.log("\n[5] 与基线对比");
  if (!baseline) {
    console.log(
      TAG === "baseline"
        ? "  本文件就是基线（tag=baseline）。"
        : "  未找到 data/probe-openalex-cites/baseline.json —— 先跑 `--tag baseline` 再跑 after。",
    );
  } else {
    const sum = (r) => (r ? (r.inCount ?? 0) + (r.extCount ?? 0) : 0);
    const b = baseline.results ?? {};
    const rows = [
      ["old cites in+ext", sum(b.oldCites), sum(results.oldCites)],
      ["old all   in+ext", sum(b.oldAll), sum(results.oldAll)],
      ["old refs  in+ext", sum(b.oldRefs), sum(results.oldRefs)],
      ["modern all in", b.modernAll?.inCount ?? 0, results.modernAll.inCount ?? 0],
      ["modern refs in", b.modernRefs?.inCount ?? 0, results.modernRefs.inCount ?? 0],
      ["cached all in", b.cachedAll?.inCount ?? 0, results.cachedAll.inCount ?? 0],
    ];
    console.log("  " + "指标".padEnd(18) + "基线".padStart(6) + "→ 现在".padStart(8) + "   变化");
    for (const [name, bv, av] of rows) {
      const d = av - bv;
      console.log(`  ${name.padEnd(18)}${String(bv).padStart(6)}→${String(av).padStart(8)}   ${d >= 0 ? "+" : ""}${d}`);
    }
    const oldCitesBefore = sum(b.oldCites);
    const oldCitesAfter = sum(results.oldCites);
    check(
      "老式号 cites 方向变多（补上「谁引用了它」）",
      oldCitesAfter > oldCitesBefore,
      `in+ext ${oldCitesBefore} → ${oldCitesAfter}`,
    );
    check(
      "老式号 all 的 in+ext 不少于基线",
      sum(results.oldAll) >= sum(b.oldAll),
      `in+ext ${sum(b.oldAll)} → ${sum(results.oldAll)}`,
    );
    check(
      "新式号 all 的 in[] 不减少",
      (results.modernAll.inCount ?? 0) >= (b.modernAll?.inCount ?? 0),
      `in ${b.modernAll?.inCount} → ${results.modernAll.inCount}`,
    );
    check(
      "新式号 refs 的 in[] 不变",
      JSON.stringify(results.modernRefs.inSample) === JSON.stringify(b.modernRefs?.inSample) &&
        results.modernRefs.inCount === b.modernRefs?.inCount,
      `in ${b.modernRefs?.inCount} → ${results.modernRefs.inCount}`,
    );
    check(
      "缓存样本 in[] 不变",
      results.cachedAll.inCount === (b.cachedAll?.inCount ?? null),
      `in ${b.cachedAll?.inCount} → ${results.cachedAll.inCount}`,
    );
    evidence = { baselineAt: baseline.startedAt ?? null };
  }

  // ---- 片段打印（报告直接引用） ----
  console.log("\n[6] 原始片段");
  for (const k of ["oldCites", "oldAll", "oldRefs", "modernAll", "modernRefs"]) {
    const r = results[k];
    console.log(
      `  ${k}: in=${JSON.stringify((r.inSample ?? []).slice(0, 8))}` +
        `\n           ext=${JSON.stringify((r.extSample ?? []).slice(0, 2))}`,
    );
  }

  // ---- 落盘证据 ----
  const payload = {
    tag: TAG,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    base: BASE,
    samples: { old: OLD, modern: MODERN, modern2: MODERN2, cached: CACHED },
    cleaned: removed,
    direct,
    results,
    checks,
    fails,
    baselineFrom: evidence,
    serverLog: child ? log.slice(0, 2000) : log,
  };
  const file = join(EVID, `${TAG}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`\n证据：${file.replace(ROOT, ".")}`);
  console.log(`检查：${checks.length - fails.length}/${checks.length} 通过${fails.length ? "，失败：" + fails.join("; ") : ""}`);
  console.log(`结论：${fails.length ? "❌ 有失败项（见上）" : "✅ 全部通过"}`);
  process.exitCode = fails.length ? 1 : 0;
} finally {
  if (child) {
    child.kill();
    await sleep(300);
    console.log("已关 5312 服务器。");
  }
}
