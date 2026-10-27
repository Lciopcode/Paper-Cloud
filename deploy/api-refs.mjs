// @ts-nocheck
/**
 * 论文云 · **按需取引用**接口（`/api/refs?domain=physics&doc=259`）
 * ============================================================================
 * 作者的原话：「不能点击一次拿一次吗？」
 *
 * 能，而且这是比"全量预抓"更实际的一条路 —— 全量要 6,105 次外部请求（约两小时，
 * 还受匿名限流），而**用户一次只会点一颗星**：点一次、问一次、存一次就够了。
 *
 * ## 为什么必须走本地服务器，不能让浏览器直接调 S2
 *
 * Semantic Scholar 的响应**没有 CORS 头**（`docs/04-引用数据获取.md` 实测过），
 * 浏览器直接 `fetch` 会被同源策略挡掉。所以由本地服务器代取，浏览器只跟我们自己说话。
 *
 * ## 一件事只问一次：落盘缓存
 *
 * 抓到的结果写进 `data/refs-cache/<domain>/<docId>.json`，之后同一篇再点就**读本地**，
 * 不发任何外部请求。好处有两个：断网也能看已经看过的；不会把同一篇反复打给外部接口
 * （那是被限流的主要原因）。
 *
 * ## 缓存里存什么
 *
 *     { "at": 1770000000000,
 *       "in":  [docId, ...],                    // 库内被引（有坐标，能画线）
 *       "ext": [[标题, 年, DOI], ...] }         // 库外（没坐标，只进面板）
 *
 * `in` 只保留**同团**的：八个学科各是独立的 `<group>`、各有各的局部坐标，
 * 跨团的边画出来会落在虚空里。
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openAlexKey, openAlexMailto, s2Key } from "./env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const TEXT = join(ROOT, "text");
const CACHE = join(ROOT, "data", "refs-cache");

/**
 * ============================================================================
 * **用户自带 key（BYOK）**
 * ============================================================================
 * 内置的那份 key 是"让大家都能用"的公共额度：S2 匿名/低配额会 429，OpenAlex 匿名
 * 只有 $0.10/天。所以前端「数据源」面板允许用户粘贴**自己的** key ——
 * 由这个文件在**每次请求**里优先使用它（用户 key > 内置 key > 匿名）。
 *
 * ## 三条安全规则
 *
 *   1. key 只从**请求头**来：`x-user-s2-key` / `x-user-openalex-key` /
 *      `x-user-openalex-mailto`（前端 localStorage → 同源 `/api/*`）；
 *   2. **绝不写日志、绝不回显、绝不落盘**：缓存与响应里只有 `auth: "user"|"builtin"|"anonymous"`；
 *   3. 只接受合理的长度/字符；异常头按"没提供"处理（不是报错 —— 不能因为用户
 *      多粘贴了一个换行就整条链路失败）。
 */
const USER_KEY_HEADER = {
  s2: "x-user-s2-key",
  openalex: "x-user-openalex-key",
  mailto: "x-user-openalex-mailto",
};

/** 头值清洗：去控制字符/首尾空白，限制长度。异常（数组、非字符串）当空。 */
function headerValue(req, name, maxLen = 400) {
  const raw = req?.headers?.[name];
  const s = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLen);
}

/** 取这次请求携带的用户 key（没有就是空串） */
function userKeysFrom(req) {
  return {
    s2: headerValue(req, USER_KEY_HEADER.s2),
    openalex: headerValue(req, USER_KEY_HEADER.openalex),
    mailto: headerValue(req, USER_KEY_HEADER.mailto, 200),
  };
}

/**
 * 这次请求"实际能用谁"的三档凭据。只报档位、不报 key 本身。
 * 前端把它显示成「你的 key / 内置 key / 匿名」，用户据此确认自己的 key 有没有生效。
 */
function authLabels(user) {
  return {
    s2: user.s2 ? "user" : s2Key() ? "builtin" : "anonymous",
    openalex: user.openalex ? "user" : openAlexKey() ? "builtin" : "anonymous",
  };
}

/** arXiv 号 → docId（每个学科一份，首次用到时建，之后常驻内存） */
const indexes = new Map();
/** docId → arXiv 号 */
const idLists = new Map();
/** 正在构建的索引（同一学科并发请求不能各扫一遍 1.46M 行 —— 内存会翻倍） */
const indexInFlight = new Map();
/** 标题索引（同上） */
const titleInFlight = new Map();

/**
 * 全局**串行队列**：建索引是几个 GB 级内存的活，同时跑两个学科会直接把 Node 堆撑爆
 * （实测：默认 4GB 堆在 physics 索引 + 标题索引期间 OOM，服务直接退出）。
 * 所以所有大索引构建排成一队，一个跑完再跑下一个。
 */
let serial = Promise.resolve();
function runSerial(fn) {
  const next = serial.then(fn, fn);
  serial = next.catch(() => {});
  return next;
}

/** DOI 兜底：10.48550/arXiv.2312.05296 -> 2312.05296；10.48550/arXiv.cs/9712101 -> cs/9712101 */
function doiToArxiv(doi) {
  const m = /10\.48550\/arxiv\.(.+)$/i.exec(String(doi ?? ""));
  return m ? normArxiv(m[1]) : null;
}

const normArxiv = (s) =>
  s ? String(s).trim().replace(/^arxiv:/i, "").replace(/v\d+$/i, "") || null : null;

/**
 * 建某个学科的 arXiv↔docId 双表。
 *
 * ⚠️ 只读 `id` 字段、不做 JSON.parse —— 语料 1.46M 行、每行还带摘要，
 * 整行解析要多花十几秒（`export-text.mjs` 的格式是定序的，这里按字符串切就够）。
 */
async function loadIndex(domain) {
  const hit = indexes.get(domain);
  if (hit) return hit;
  const f = join(TEXT, `${domain}.jsonl.gz`);
  if (!existsSync(f)) return null;
  // 同一学科并发请求共享同一次扫描（否则 N 个请求 = N 份 1.46M 行 × 2 张表）
  const inflight = indexInFlight.get(domain);
  if (inflight) return inflight;
  const p = runSerial(async () => {
    const fwd = [];
    const rev = new Map();
    let docId = 0;
    const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) {
        fwd.push("");
        docId++;
        continue;
      }
      const i = line.indexOf('"id":"');
      const j = i >= 0 ? line.indexOf('"', i + 6) : -1;
      const ax = j > 0 ? normArxiv(line.slice(i + 6, j)) : null;
      fwd.push(ax ?? "");
      if (ax && !rev.has(ax)) rev.set(ax, docId);
      docId++;
    }
    const rec = { fwd, rev, count: docId };
    indexes.set(domain, rec);
    idLists.set(domain, fwd);
    return rec;
  }).finally(() => indexInFlight.delete(domain));
  indexInFlight.set(domain, p);
  return p;
}

/**
 * 调 S2 批量接口问"这篇引用了谁"（单篇也走 batch，因为 GET 端点被匿名池 429）
 *
 * ## key 是可选的，但**有和没有差别很大**（实测）
 *
 * 匿名池：连续几次就 429，`retry-after` 经常 5–10 秒，点几颗星就卡住；
 * 带 key：同一时段同一查询 200/0.5–1.3 秒（`_scratch/probe-key2.mjs` 连跑 5 次全成功）。
 *
 * key 从 `.env.local` 读（`deploy/env.mjs`，**不打印值**）。读不到就退回匿名池 —— 
 * 这样"没配 key 的机器"仍然能用，只是慢；"配了 key 的机器"立刻变快。
 *
 * `keyOverride` 是**用户自带的 key**（来自请求头，见文件头的 BYOK 说明）：
 * 它优先于内置 key —— 用户用自己的配额，不在我们的公共额度上排队。
 */
async function askS2(arxivId, tries = 4, keyOverride = "") {
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/batch" +
    "?fields=references.externalIds,references.title,references.year,citations.externalIds,citations.title,citations.year";
  const body = JSON.stringify({ ids: [`ARXIV:${arxivId}`] });
  const key = keyOverride || s2Key();
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "x-api-key": key } : {}),
        },
        body,
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 2000 * (i + 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const json = await res.json();
      const row = json?.[0];
      return { refs: row?.references ?? [], cites: row?.citations ?? [] };
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      if (i === tries - 1) return { error: String(e).slice(0, 120) };
    }
  }
  return { error: "外部接口限流（429）" };
}

/**
 * 老式 arXiv 号（2007 年以前）：`cs/9712101`、`hep-th/9201018`。
 *
 * S2 的 batch 接口**不认这种写法**（实测 `ARXIV:cs/9712101` → 400 "No valid paper ids given"），
 * 而语料里这类论文占了相当一部分，所以必须有另一条路。
 */
const isOldStyle = (id) => String(id).includes("/");

/**
 * OpenAlex 兜底（按 DOI 查，**不需要 key，配额与 S2 完全独立**）。
 *
 * ## 两个方向，别只做一半
 *
 * 原来的实现只做①，也就是**这篇引用了谁**。但作者问的是"点击一颗星，把它的
 * 引用关系牵出来" —— 对老论文来说，它引用的 1980 年代文献几乎全在语料外，
 * 屏幕上**一根线都没有**；真正在语料里的是"谁引用了它"（近年 arXiv 新论文）。
 * 所以必须补②：
 *
 *   ① **refs**：`works/doi:10.48550/arXiv.<id>` → `referenced_works`（它引用了谁）；
 *      再把那些 W 编号分批（50 个/批）取回标题/年份/DOI。
 *   ② **cites**：同一个 work 的 `id`（W…）→
 *      `works?filter=cites:W…&per-page=200&sort=publication_date:desc`
 *      —— 谁引用了它。**上限 200**：一是够画线（面板也只显示 40 条库外），
 *      二是控制单次点击的外部请求量与延迟；按发表时间倒序取，近年论文更可能
 *      在 arXiv 语料内（能真的连成线），而不是一堆 1990 年代的期刊引用。
 *
 * 两条都返回与 `askS2` 完全对齐的条目结构
 * `{ title, year, externalIds: { Arxiv, DOI } }`，所以 `handleRefs` 里
 * "arXiv 号 → docId / DOI → arXiv / 标题索引" 的映射**一行都不用改**。
 *
 * ## 失败隔离 & 礼貌
 *
 *   · 两个方向各自 try/catch：一边超时/429 只丢这一边，另一边照常返回；
 *     只有**两个方向都失败**才把 `error` 抛给外层去走另一条通道（S2）。
 *   · 每个 OpenAlex 请求都带 `mailto`（作者可联系，限流时对方能给宽限）；
 *     连续分页请求间 sleep 400–500ms，不做并发轰炸。
 *   · 429 / 5xx **只退避重试一次**（最多等 3 秒），不重试风暴；超时 20s。
 *   · 这里不读、不打印任何 key（OpenAlex 不收 key；S2 的 key 只在 askS2 里用）。
 *
 * 参数 `want` 让调用方按 `mode` 只取需要的方向（`mode=cites` 就不去拉 refs，
 * 省掉最多 4 次分页请求）。
 *
 * `auth` 是**用户自带的 OpenAlex key / mailto**（BYOK）：
 *   · key 走 OpenAlex 的 `api_key` 查询参数（它不收请求头），有 key 时预算 ×10；
 *   · mailto 也优先用用户填的（礼貌池按邮箱归属）；没填就用内置默认值。
 * 两者都**不回显、不落盘**。
 */
async function askOpenAlex(arxivId, want = { refs: true, cites: true }, auth = { key: "", mailto: "" }) {
  const base = "https://api.openalex.org";
  const mailtoddr = auth.mailto || openAlexMailto();
  const key = auth.key || openAlexKey();
  const doi = `10.48550/arXiv.${arxivId}`;
  const out = {};
  const errors = [];

  /** 统一拼 OpenAlex URL：mailto / api_key 总是带上（有就用，没有就不发空参数）。 */
  const oaUrl = (path, params = {}) => {
    const u = new URL(base + path);
    if (mailtoddr) u.searchParams.set("mailto", mailtoddr);
    if (key) u.searchParams.set("api_key", key);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  };

  /** 拉一批 W 编号的元数据，按 `askS2` 的条目结构返回（两个方向共用）。 */
  const entryOf = (w) => {
    const d = String(w?.doi ?? "").replace(/^https?:\/\/doi\.org\//i, "");
    // arXiv DOI 有两种写法：新式 `10.48550/arXiv.2401.00001`、老式 `10.48550/arxiv.hep-th/9108028`
    const m = /10\.48550\/arxiv[.\/](.+)$/i.exec(d);
    return {
      title: w?.display_name ?? "",
      year: w?.publication_year ?? 0,
      externalIds: { Arxiv: m ? normArxiv(m[1]) : undefined, DOI: d },
    };
  };

  try {
    // ---- ① 先把这个 arXiv 号解析成 OpenAlex work（GET 一次，两个方向都要用）
    const wRes = await oaFetch(oaUrl(`/works/doi:${encodeURIComponent(doi)}`), "work");
    const work = await wRes.json();
    const workId = String(work?.id ?? "").split("/").pop();

    // ---- ② refs：它引用了谁（保持原来的分批补标题逻辑）
    if (want.refs) {
      try {
        const refIds = (work?.referenced_works ?? [])
          .map((u) => String(u).split("/").pop())
          .filter(Boolean)
          .slice(0, 200);
        const refs = [];
        for (let i = 0; i < refIds.length; i += 50) {
          if (i > 0) await sleep(450); // 连续分页之间让一让，别把对方当 CDN 刷
          const chunk = refIds.slice(i, i + 50);
          const q = oaUrl("/works", {
            filter: `openalex_id:${chunk.join("|")}`,
            select: "doi,display_name,publication_year",
            "per-page": 50,
          });
          const rRes = await oaFetch(q, `refs#${i / 50 + 1}`);
          const page = await rRes.json();
          for (const w of page?.results ?? []) refs.push(entryOf(w));
        }
        out.refs = refs;
      } catch (e) {
        errors.push(`refs: ${String(e).slice(0, 140)}`);
      }
    }

    // ---- ③ cites：谁引用了它（这就是本次补的方向）
    if (want.cites) {
      try {
        if (!/^W\d+$/.test(workId)) throw new Error(`work id 异常：${workId || "(空)"}`);
        if (want.refs && out.refs?.length) await sleep(450); // 别接着上一条请求立刻打
        const q = oaUrl("/works", {
          filter: `cites:${workId}`,
          "per-page": 200,
          sort: "publication_date:desc",
          select: "id,doi,display_name,publication_year",
        });
        const cRes = await oaFetch(q, "cites");
        const page = await cRes.json();
        out.cites = (page?.results ?? []).map(entryOf);
      } catch (e) {
        errors.push(`cites: ${String(e).slice(0, 140)}`);
      }
    }
  } catch (e) {
    // work 都解析不出来 ⇒ 整个 OpenAlex 通道失败，让外层退到 S2
    return { error: `OpenAlex ${String(e).slice(0, 120)}` };
  }

  const wanted = ["refs", "cites"].filter((k) => want[k]);
  // 要的方向一个都没拿到 ⇒ 整体失败；拿到一部分就把成功的那部分交出去
  if (wanted.length && wanted.every((k) => out[k] === undefined)) {
    return { error: `OpenAlex ${errors.join("; ") || "两个方向都失败"}` };
  }
  if (errors.length) out.warn = errors;
  return out;
}

/** sleep 的小包装（OpenAlex 请求之间做礼貌间隔用，不影响 S2 路径）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * OpenAlex 单次 HTTP：20s 超时；429/5xx **只退避重试一次**（避免重试风暴）。
 *
 * 失败时抛 Error（由 `askOpenAlex` 的 try/catch 按方向隔离），成功返回 Response。
 */
async function oaFetch(url, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "papercloud/1.0 (mailto:papercloud@example.com)" },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      if (attempt === 0) {
        await sleep(1200);
        continue;
      }
      throw new Error(`${label} 网络失败：${String(e).slice(0, 100)}`);
    }
    if (res.ok) return res;
    // 限流/服务端错误：读 retry-after（最多等 3s）重试一次；4xx（除 429）直接失败
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 1500;
      await sleep(Math.min(wait, 3000));
      continue;
    }
    const body = await res.text().catch(() => "");
    throw new Error(`${label} HTTP ${res.status}：${body.slice(0, 160)}`);
  }
  throw new Error(`${label} 失败`);
}

export async function handleRefs(req, res, query) {
  const domain = query.get("domain") ?? "";
  const doc = Number(query.get("doc") ?? -1);
  /** 关系方向：refs = 这篇引用了谁；cites = 谁引用了这篇；all = 两者 */
  const mode = query.get("mode") ?? "all";
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (!domain || !Number.isFinite(doc) || doc < 0) return send(400, { error: "参数不对" }), true;

  // ---- 1. 缓存命中就立刻返回（不碰网络）
  const dir = join(CACHE, domain);
  const cf = join(dir, `${doc}.${mode}.json`);
  if (existsSync(cf)) {
    try {
      const c = JSON.parse(readFileSync(cf, "utf8"));
      return send(200, { ...c, cached: true }), true;
    } catch {
      /* 缓存坏了就当没有 */
    }
  }

  // ---- 2. 取这篇的 arXiv 号
  const idx = await loadIndex(domain);
  if (!idx) return send(404, { error: `没有 ${domain} 的语料` }), true;
  const arxivId = idx.fwd[doc];
  if (!arxivId) return send(200, { in: [], ext: [], note: "这一篇没有 arXiv 号" }), true;

  // ---- 3. 问外部接口（S2 优先；老式号或 S2 失败时用 OpenAlex 兜底）
  /**
   * 路由规则（两条都踩过坑，所以写死在这里）：
   *   · **老式号**（`cs/9712101`）：S2 的 batch 直接 400 拒绝 ⇒ 先走 OpenAlex；
   *   · **新式号**（`2401.00001`）：S2 优先（它有 key，映射也更全）；
   *     但 S2 一旦 429 / 网络失败，也退回 OpenAlex —— 配额是两套，能互为备份。
   */
  /**
   * 只向外部通道要**当前 mode 需要的方向**：`mode=cites` 不必去拉 refs
   * （OpenAlex 一个方向最多 4 次分页，省下来的就是点一次星的等待时间）。
   */
  const want = { refs: mode !== "cites", cites: mode !== "refs" };
  /** 用户自带 key（BYOK）：优先于内置；只用于这次请求，不落盘 */
  const user = userKeysFrom(req);
  const auth = authLabels(user);
  const oaAuth = { key: user.openalex, mailto: user.mailto };
  let r;
  let source;
  if (isOldStyle(arxivId)) {
    r = await askOpenAlex(arxivId, want, oaAuth);
    source = "openalex";
    if (r.error) {
      r = await askS2(arxivId, 4, user.s2);
      source = "s2";
    }
  } else {
    r = await askS2(arxivId, 4, user.s2);
    source = "s2";
    if (r.error) {
      r = await askOpenAlex(arxivId, want, oaAuth);
      source = "openalex";
    }
  }
  if (r.error) {
    return send(200, { in: [], ext: [], error: r.error, arxivId, source, mode, auth }), true;
  }

  const inIds = [];
  const ext = [];
  const seen = new Set();
  /**
   * 除了「它引用了谁」，也把「谁引用了它」映射进来。
   * 只画 references 时，老论文的引用几乎全在库外（1980 年代文献）⇒ 屏幕上**一根线都没有**；
   * citations 方向的新论文大概率在语料内，两者合并后绝大多数星都能画出真实连通的线。
   */
  /**
   * 关系方向（作者要求可切换）：
   *   refs  —— 只画「这篇引用了谁」
   *   cites —— 只画「谁引用了这篇」
   *   all   —— 两者都画（默认）
   */
  /**
   * 标题索引：只有 DOI 的引用靠它拉回语料。
   * **不在请求路径里 await** —— 第一次会扫一整份语料，await 会让这次点击等十几秒。
   * 没建好就先跳过（arXiv 号 / DOI 映射仍然生效），后台继续建，下次点就有。
   */
  const byTitle = titleIndexes.get(domain) ?? (void loadTitleIndex(domain), null);
  const related =
    mode === "refs" ? [...(r.refs ?? [])]
    : mode === "cites" ? [...(r.cites ?? [])]
    : [...(r.refs ?? []), ...(r.cites ?? [])];
  for (const ref of related) {
    const ax = normArxiv(ref?.externalIds?.Arxiv ?? ref?.externalIds?.ArXiv) ?? doiToArxiv(ref?.externalIds?.DOI);
    const hitDoc = ax ? idx.rev.get(ax) : byTitle ? byTitle.get(normTitle(ref?.title)) : undefined;
    if (hitDoc !== undefined) {
      if (hitDoc === doc || seen.has(hitDoc)) continue;
      seen.add(hitDoc);
      inIds.push(hitDoc);
    } else {
      const title = String(ref?.title ?? "").trim();
      if (title) ext.push([title.slice(0, 300), ref?.year ?? 0, ref?.externalIds?.DOI ?? ""]);
    }
  }
  const payload = {
    at: Date.now(),
    arxivId,
    source,
    mode,
    /** 这次用的是谁的凭据：`user` / `builtin` / `anonymous`（**不含 key 本身**） */
    auth,
    in: inIds,
    ext: ext.slice(0, 40),
    /** 有部分方向失败时留痕（如 cites 429），但不影响另一个方向的可用结果 */
    ...(r.warn ? { warn: r.warn } : {}),
  };

  // ---- 4. 落盘（下次同一篇不再问外部）
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cf, JSON.stringify(payload));
  } catch {
    /* 缓存写不进去不影响本次返回 */
  }
  return send(200, payload), true;
}

/** 诊断：缓存里已经有多少篇了（`/api/refs-stats`） */
/** 每个学科一份"规范化标题 → docId"，首次用到时建，之后常驻内存 */
const titleIndexes = new Map();

/** 标题规范化：小写、去标点、压缩空白（跨库匹配用） */
function normTitle(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

/**
 * 建标题索引（**独立于 loadIndex**，避免动到已在用的 fwd/rev 结构）。
 *
 * 存在的理由：S2 / OpenAlex 返回的引用条目里，很多只有期刊 DOI 和标题，
 * 没有 arXiv 号 —— 只靠 arXiv 号映射就会全部落到"库外"，屏幕上一根线都没有。
 * 有了标题索引，这类条目能按标题匹配回语料，变成真实可连的星。
 */
async function loadTitleIndex(domain) {
  const hit = titleIndexes.get(domain);
  if (hit) return hit;
  const f = join(TEXT, `${domain}.jsonl.gz`);
  if (!existsSync(f)) return new Map();
  // 同上：同一学科只扫一次；且与 arXiv 索引共用串行队列（同时跑两个学科会撑爆堆）
  const inflight = titleInFlight.get(domain);
  if (inflight) return inflight;
  const p = runSerial(async () => {
    const map = new Map();
    const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
    let docId = 0;
    let n = 0;
    for await (const line of rl) {
      /**
       * ⚠️ **每 2 万行让出一次事件循环**。
       *
       * 不然这趟扫描（cs 语料 800 MB gz，实测 21 秒）会把 Node 单线程占满，
       * 期间所有 HTTP 请求都排队 —— 表现就是"点一下卡二十秒"。这不是渲染卡，是服务端阻塞。
       */
      if (++n % 20000 === 0) await new Promise((r) => setImmediate(r));
      if (line) {
        const i = line.indexOf('"title":"');
        const j = i >= 0 ? line.indexOf('"', i + 9) : -1;
        if (j > 0) {
          /**
           * ⚠️ `normTitle` 末尾的 `replace` 会生成**新字符串**（不是 sliced view）——
           * 这一点很重要：否则 146 万条标题会各自保留 2KB 的整行父串，直接吃掉几个 GB 内存。
           */
          const t = normTitle(line.slice(i + 9, j));
          if (t.length >= 12 && !map.has(t)) map.set(t, docId);
        }
      }
      docId++;
    }
    titleIndexes.set(domain, map);
    return map;
  }).finally(() => titleInFlight.delete(domain));
  titleInFlight.set(domain, p);
  return p;
}

export function refsStats() {
  const out = {};
  if (!existsSync(CACHE)) return out;
  for (const d of readdirSync(CACHE)) {
    try {
      out[d] = readdirSync(join(CACHE, d)).filter((f) => f.endsWith(".json")).length;
    } catch {
      out[d] = 0;
    }
  }
  return out;
}

/* ============================================================================
 * 数据源清单 / 密钥自检 —— 用户自带 key（BYOK）的两个 GET 接口
 * ============================================================================
 * 前端「数据源」面板靠这两个接口回答用户两个问题：
 *   ① "这里有哪些数据库可用？哪一条是我自己的 key 在起作用？" → `/api/sources`
 *   ② "我刚粘贴的 key 到底能不能用？"                     → `/api/key-check?provider=`
 *
 * 两个接口都**只回档位（user/builtin/anonymous）与探测结果，绝不回显 key**。
 */

const JSON_HEAD = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function sendJson(res, code, obj) {
  res.writeHead(code, JSON_HEAD);
  res.end(JSON.stringify(obj));
}

/**
 * 数据源清单。`builtin` 只表示"这台机器的 .env.local 里有没有内置 key"，
 * **不是**把 key 发出去。`freeWithoutKey` 说明不填 key 也能用（只是额度/速度差）。
 */
export function handleSources(req, res) {
  const user = userKeysFrom(req);
  sendJson(res, 200, {
    at: Date.now(),
    providers: [
      {
        id: "corpus",
        label: "arXiv 本地语料",
        kind: "local",
        builtin: true,
        freeWithoutKey: true,
        note: "3,052,327 篇：星点坐标、标题、摘要、编号反查都在本地，不需要 key（星图不靠外部数据库扩充）。",
        docsUrl: "https://arxiv.org",
      },
      {
        id: "s2",
        label: "Semantic Scholar",
        kind: "http",
        builtin: !!s2Key(),
        freeWithoutKey: true,
        keyHeader: USER_KEY_HEADER.s2,
        docsUrl: "https://www.semanticscholar.org/product/api",
        note: "点星取「引用/被引」关系；匿名池常 429，自带 key 的配额与稳定性都更好（请求头 x-api-key）。",
        rateNote: "匿名：共享池，容易 429；带 key：按你的 key 配额。",
      },
      {
        id: "openalex",
        label: "OpenAlex",
        kind: "http",
        builtin: !!openAlexKey(),
        freeWithoutKey: true,
        keyParam: "api_key",
        docsUrl: "https://help.openalex.org/api/authentication/",
        note: "两个方向都支持（它引用了谁 / 谁引用了它），老式 arXiv 号也能查；匿名每天约 $0.10，免费 key 约 $1/天。",
        rateNote: "匿名：每 IP 约 $0.10/天；免费 key：约 $1/天（10×）且每秒上限更高。",
      },
    ],
    /** 这次请求头里确实带了哪些用户 key（只报有没有，不报内容） */
    userKeysConfigured: { s2: !!user.s2, openalex: !!user.openalex, mailto: !!user.mailto },
    /** 服务端此刻会给每条通道用什么凭据档位 */
    auth: authLabels(user),
  });
}

/** 探测 S2：用 batch 接口查一篇固定存在的论文（HEP 综述，2007） */
async function checkS2(key) {
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,year,externalIds";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify({ ids: ["ARXIV:0704.0062"] }),
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 429) {
    return { status: "rate_limited", httpStatus: 429, note: "被限流（429）—— 等一会儿再试，或换自己的 key。" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      status: "error",
      httpStatus: res.status,
      note: `HTTP ${res.status}：${body.slice(0, 140) || "（无响应体）"}`,
    };
  }
  const json = await res.json().catch(() => null);
  const row = Array.isArray(json) ? json[0] : null;
  if (!row) return { status: "error", httpStatus: res.status, note: "请求成功但没有返回论文记录（key 可能无效或接口变了）。" };
  return {
    status: "ok",
    httpStatus: res.status,
    note: "连接正常，key 可用。",
    sample: { title: row.title ?? "", year: row.year ?? 0 },
  };
}

/** 探测 OpenAlex：取同一篇固定论文的 title / 被引数 */
async function checkOpenAlex(key, mailto) {
  const u = new URL("https://api.openalex.org/works/doi:10.48550/arXiv.0704.0062");
  if (mailto) u.searchParams.set("mailto", mailto);
  if (key) u.searchParams.set("api_key", key);
  u.searchParams.set("select", "id,doi,display_name,publication_year,cited_by_count");
  const res = await fetch(u, { signal: AbortSignal.timeout(12000) });
  if (res.status === 429) {
    return { status: "rate_limited", httpStatus: 429, note: "额度/频率受限（429）—— 匿名额度每天约 $0.10，建议填自己的免费 key。" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      status: "error",
      httpStatus: res.status,
      note: `HTTP ${res.status}：${body.slice(0, 140) || "（无响应体）"}`,
    };
  }
  const j = await res.json().catch(() => null);
  if (!j?.id) return { status: "error", httpStatus: res.status, note: "请求成功但没有返回 work 记录。" };
  return {
    status: "ok",
    httpStatus: res.status,
    note: "连接正常；下面的被引数是这条通道真实返回的数据。",
    sample: { title: j.display_name ?? "", year: j.publication_year ?? 0, citedBy: j.cited_by_count ?? 0 },
  };
}

/**
 * 密钥自检：`/api/key-check?provider=s2|openalex`
 *
 * 用**这次请求头里的用户 key**（没有就内置，再没有就匿名）发一次最小请求。
 * 12 秒超时、不重试、不缓存 —— 它只回答"现在能不能用"，不做数据获取。
 */
export async function handleKeyCheck(req, res, query) {
  const provider = (query.get("provider") ?? "").trim().toLowerCase();
  const user = userKeysFrom(req);
  const t0 = Date.now();
  try {
    if (provider === "s2") {
      const using = user.s2 ? "user" : s2Key() ? "builtin" : "anonymous";
      const key = user.s2 || s2Key();
      const r = await checkS2(key);
      return sendJson(res, 200, {
        provider,
        usingUserKey: using === "user",
        using,
        ...r,
        ms: Date.now() - t0,
      });
    }
    if (provider === "openalex") {
      const using = user.openalex ? "user" : openAlexKey() ? "builtin" : "anonymous";
      const key = user.openalex || openAlexKey();
      const r = await checkOpenAlex(key, user.mailto || openAlexMailto());
      return sendJson(res, 200, {
        provider,
        usingUserKey: using === "user",
        using,
        ...r,
        ms: Date.now() - t0,
      });
    }
    return sendJson(res, 400, { error: "provider 只支持 s2 / openalex", ms: Date.now() - t0 });
  } catch (e) {
    // 网络异常也要给界面一句人话，而不是 500
    return sendJson(res, 200, {
      provider,
      usingUserKey: provider === "s2" ? !!user.s2 : !!user.openalex,
      using: provider === "s2" ? (user.s2 ? "user" : s2Key() ? "builtin" : "anonymous") : user.openalex ? "user" : openAlexKey() ? "builtin" : "anonymous",
      status: "error",
      httpStatus: 0,
      note: `网络错误：${String(e).slice(0, 140)}`,
      ms: Date.now() - t0,
    });
  }
}
