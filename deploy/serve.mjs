#!/usr/bin/env node
/**
 * 论文云 · 本地静态服务器
 * ============================================================================
 * 为什么不能直接用 `vite preview` 或 `vite dev`：
 *   我们的资产是**预压缩**的（`*.br`）。浏览器**不支持** `DecompressionStream('brotli')`，
 *   所以必须由服务器带 `Content-Encoding: br` 下发，让浏览器**透明解压**。
 *   vite 的静态服务不会这么做，于是 fetch 拿到的是压缩后的乱码。
 *
 * 行为：
 *   · `/`             → dist/index.html（前端）
 *   · `/data/...`     → public/data/...（若存在 .br 且客户端接受 br，则下发 .br 并带头）
 *   · 缺失的 /data/   → **404**（不做 SPA 回退：数据缺失要立刻暴露，而不是悄悄返回 HTML）
 *
 * 用法：node deploy/serve.mjs --port 5311
 */
import { createServer } from "node:http";
import { handleKeyCheck, handleRefs, handleSources, refsStats } from "./api-refs.mjs";
import v8 from "node:v8";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const DIST = join(ROOT, "dist");
const DATA = join(ROOT, "public", "data");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(argVal("--port", "5311"));
const HOST = argVal("--host", "127.0.0.1");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** 防目录穿越：解析后必须仍在 root 之内。 */
function safeJoin(root, urlPath) {
  const p = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  const full = resolve(root, p);
  return full.startsWith(resolve(root)) ? full : null;
}

/**
 * 这些后缀**不走 brotli**，因为浏览器要用 `Range` 随机访问它们。
 *
 * ⚠️ 为什么必须显式排除：一个 400 MB 的文本池不可能整份下载，但"点开一篇论文
 * 看标题/作者/摘要"只需要几百字节。所以元数据文件是**故意不压缩**的（压缩后无法
 * 随机访问），服务器必须原样下发。若不排除，`.idx.bin` 存在 `.br` 副本时就会被
 * 压缩下发，Range 立刻失效，而且**报错很难懂**（拿到的字节是压缩流的一段）。
 */
const RANGE_EXTS = [".idx.bin", ".txt.bin", ".abs.bin"];
/**
 * 引用表（`/data/citations/<学科>.bin` 与 `<学科>.ext.bin`）也必须是 Range 资产。
 *
 * ⚠️ 这一条**漏过一次，而且漏得毫无声息**：引用表叫 `physics.bin`，
 *    不在上面的后缀白名单里 ⇒ `isRangeAsset` 返回 false ⇒ 服务器对 Range 请求
 *    直接回 **200 + 整个文件**（5.6 MB）。前端 `CitationTable` 里有 206 校验，
 *    于是它把整件事判成"这个学科没有引用数据"，界面显示"尚未抓到引用数据" ——
 *    **数据明明在，却整条通路静默失效**，而且没有任何报错。
 *
 *    教训：白名单式 design 每加一族资产就必须同步加一条，否则失败方向是"静默降级"。
 *    所以这里按**路径**判，而不是再往数组里追加两个扩展名 ——
 *    `citations/` 目录下的东西天然都是给 Range 用的。
 */
const isCitationAsset = (file) => /[\\/]data[\\/]citations[\\/][^\\/]+\.bin$/.test(file);

function isRangeAsset(file) {
  return RANGE_EXTS.some((e) => file.endsWith(e)) || isCitationAsset(file);
}

/** 解析 `Range: bytes=start-end`。返回 null 表示不是可满足的范围请求。 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start;
  let end;
  if (a === "" && b === "") return null;
  if (a === "") {
    // 后缀范围：bytes=-N 表示最后 N 字节
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Number(b);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null; // 不可满足 ⇒ 416
  return { start, end: Math.min(end, size - 1) };
}

function sendFile(res, file, req, { allowBr = false, range = false } = {}) {
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const headers = { "content-type": type, "cache-control": "no-cache" };
  let target = file;

  if (allowBr && !range) {
    const acceptsBr = /\bbr\b/.test(req.headers["accept-encoding"] ?? "");
    if (acceptsBr && existsSync(file + ".br")) {
      target = file + ".br";
      headers["content-encoding"] = "br";
    }
  }
  const st = statSync(target);

  // 支持 Range 的资产：声明支持，并按请求返回 206 部分内容。
  // 这是"点开一篇论文只取几百字节"能成立的前提。
  if (range) {
    headers["accept-ranges"] = "bytes";
    const r = parseRange(req.headers.range, st.size);
    if (r) {
      headers["content-length"] = String(r.end - r.start + 1);
      headers["content-range"] = `bytes ${r.start}-${r.end}/${st.size}`;
      res.writeHead(206, headers);
      if (req.method === "HEAD") return res.end();
      createReadStream(target, { start: r.start, end: r.end }).pipe(res);
      return;
    }
    if (req.headers.range) {
      // 有 Range 头但不可满足 ⇒ 416（明确告诉客户端范围非法，而不是悄悄给全量）
      res.writeHead(416, { "content-range": `bytes */${st.size}` });
      return res.end();
    }
  }

  headers["content-length"] = String(st.size);
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(target).pipe(res);
}

const server = createServer((req, res) => {
  const [url, qs] = (req.url ?? "/").split("?");
  /**
   * **按需取引用**（作者："不能点击一次拿一次吗？"）。
   *
   * 浏览器不能直接调 Semantic Scholar —— 它没有 CORS 头。所以由这里代取，
   * 结果落盘缓存，同一篇再点就是读本地。实现见 `deploy/api-refs.mjs`。
   */
  if (url === "/api/refs") {
    void handleRefs(req, res, new URLSearchParams(qs ?? "")).catch((e) => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e).slice(0, 200) }));
    });
    return;
  }
  if (url === "/api/refs-stats") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(refsStats()));
    return;
  }
  /**
   * **数据源清单 / 密钥自检**（用户自带 key 面板用）。
   *
   * 两个都只读、无副作用；key 由前端从 localStorage 通过请求头带来，
   * 服务端只用于本次上游请求，不回显、不落盘（实现见 `deploy/api-refs.mjs`）。
   */
  if (url === "/api/sources") {
    handleSources(req, res);
    return;
  }
  if (url === "/api/key-check") {
    void handleKeyCheck(req, res, new URLSearchParams(qs ?? "")).catch((e) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ status: "error", httpStatus: 0, note: String(e).slice(0, 160) }));
    });
    return;
  }

  // ---- 数据资产（预压缩） ----
  if (url.startsWith("/data/")) {
    const file = safeJoin(DATA, url.slice("/data/".length));
    if (!file || !existsSync(file) || statSync(file).isDirectory()) {
      // 数据缺失必须 404：不要 SPA 回退（否则前端会把 HTML 当二进制解析，报错难懂）
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`404 资产不存在：${url}\n提示：先跑 pnpm export:text && pnpm build:spine`);
      return;
    }
    sendFile(res, file, req, { allowBr: true, range: isRangeAsset(file) });
    return;
  }

  // ---- 前端 ----
  const rel = url === "/" ? "index.html" : url;
  const file = safeJoin(DIST, rel);
  if (file && existsSync(file) && !statSync(file).isDirectory()) {
    sendFile(res, file, req);
    return;
  }
  // SPA 回退：只对非数据路径生效
  const index = join(DIST, "index.html");
  if (existsSync(index)) {
    sendFile(res, index, req);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("404 尚未构建：请先跑 pnpm build");
});

server.listen(PORT, HOST, () => {
  console.log(`论文云 · 本地服务  http://${HOST}:${PORT}`);
  console.log(`  前端：${DIST}`);
  console.log(`  资产：${DATA}（带 Content-Encoding: br）`);
  if (!existsSync(join(DIST, "index.html"))) console.log("  ⚠️ dist/index.html 不存在，请先 pnpm build");
  if (!existsSync(join(DATA, "manifest.json"))) console.log("  ⚠️ public/data/manifest.json 不存在，请先 pnpm build:spine");
  /**
   * ⚠️ **堆上限检查**：真实引用要按学科建 100–150 万行的 arXiv↔docId 双表 + 标题索引，
   * 一个学科约 1–1.5GB，多学科叠加会超过 Node 默认的 ~4GB 堆。
   * 实测（2026-10-21）：默认堆在 physics 索引 + 标题索引期间 OOM，服务直接退出。
   * 所以启动命令建议 `node --max-old-space-size=8192 deploy/serve.mjs`（package.json 的 serve 已是）。
   */
  const heapGB = v8.getHeapStatistics().heap_size_limit / 1024 ** 3;
  if (heapGB < 6) {
    console.log(
      `  ⚠️ V8 堆上限仅 ${heapGB.toFixed(1)} GB：对多个学科做「实时引用」（建索引）可能 OOM。` +
        `\n     建议用：node --max-old-space-size=8192 deploy/serve.mjs --port ${PORT}`,
    );
  }
});
