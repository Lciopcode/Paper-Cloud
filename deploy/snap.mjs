/**
 * 论文云 · 截取离屏渲染快照
 * ============================================================================
 * 无头 + SwiftShader 下 CDP 的 `Page.captureScreenshot` 常常拍不到 WebGL 合成结果，
 * 因此用页面里的 `__three.snapshot()`（渲染到 RenderTarget 再读像素）取图。
 *
 * 用法：node deploy/snap.mjs [--out shots/papercloud.png] [--all]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { debugTargetError, headlessArgs, profileDir, resolveBrowser, waitForApp } from "./browser.mjs";

const BROWSER = resolveBrowser();

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const URL_ = argVal("--url", "http://127.0.0.1:5311");
const OUT = argVal("--out", "shots/papercloud.png");
const CHROME = resolveBrowser();
const PORT = Number(argVal("--port", "9701"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1600,1000",
   "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
   "--no-first-run", `--user-data-dir=${resolve(ROOT, "shots/_snap_" + Date.now())}`, URL_],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let target = null;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(400);
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = l.find((t) => t.type === "page" && t.url.startsWith("http"));
  } catch { /* 还没起来 */ }
}
/*
 * ⚠️ 显式检查并给出可操作的报错。
 *
 * 原来写的是 console.error("无法连接无头 Chrome") —— 没说是哪个浏览器、
 * 没给原因、没给下一步。而且直接抛 `target.webSocketDebuggerUrl` 会得到
 * **`Cannot read properties of null`**，看不出跟浏览器有关。
 * ⚠️ 实测（Edge 155）：**Edge 的 CDP 完全可用**。当时"连不上"的真因是
 * `--user-data-dir` 用了相对路径 —— 相对路径下浏览器会静默忽略
 * `--remote-debugging-port`（见 browser.mjs 的 profileDir()）。
 * 所以"换个浏览器"是错误的方向，参数才是。
 */
if (!target) {
  console.error(debugTargetError(BROWSER, PORT, 36));
  child.kill();
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });

// 等全部学科就绪（或超时）
for (let i = 0; i < 150; i++) {
  const st = await ev(`(() => {
    const s = window.__lunyun?.getState?.();
    if (!s) return null;
    const r = Object.values(s.runtime);
    return JSON.stringify({ total: r.length, ready: r.filter(x => x.phase === "ready" || x.phase === "demo").length });
  })()`);
  if (st) {
    const p = JSON.parse(st);
    if (p.ready >= 8) break;
  }
  await sleep(700);
}
await sleep(2500);

const dir = resolve(ROOT, dirname(OUT));
mkdirSync(dir, { recursive: true });
const info = await ev("JSON.stringify({ info: window.__three?.sceneInfo?.(), probe: window.__three?.probeGL?.() })");
console.log("场景：", info);

const shot = await ev("window.__three ? window.__three.snapshot(1.0) : null");
if (typeof shot === "string" && shot.startsWith("data:image/png")) {
  writeFileSync(resolve(ROOT, OUT), Buffer.from(shot.split(",")[1], "base64"));
  console.log(`已保存 ${OUT}`);
} else {
  console.log("截图失败：", typeof shot, String(shot).slice(0, 80));
}

// ---- 可选：选中一篇论文 + 打开相关论文，再拍一张 UI 截图（用 CDP，能拍到 DOM） ----
if (args.includes("--hier") || args.includes("--paper")) {
  if (args.includes("--hier")) {
    // 点第一个图例行的"演示/完整"标签来打开层级面板（那里绑了 onClick）
    await ev(`(() => {
      const rows = document.querySelectorAll('.legend-row');
      if (rows.length) rows[0].querySelector('.lg-phase').click();
      return rows.length;
    })()`);
    await sleep(600);
    const uiShot = await send("Page.captureScreenshot", { format: "png" });
    if (uiShot?.data) {
      writeFileSync(resolve(ROOT, OUT.replace(/\.png$/, "-hier.png")), Buffer.from(uiShot.data, "base64"));
      console.log(`层级面板截图已保存 ${OUT.replace(/\.png$/, "-hier.png")}`);
    }
  }

  if (args.includes("--paper")) {
    // 选一篇物理团的论文（挑靠中间的，避免极端索引）
    await ev(`(() => {
      const s = window.__lunyun.getState();
      const id = s.visibleDomains.find((d) => { const r = s.runtime[d]; return r && (r.points || r.demoPoints); });
      const rt = s.runtime[id];
      const pts = rt.points || rt.demoPoints;
      const docId = pts.docIds[Math.floor(pts.count / 2)];
      s.selectPaper(id, docId);
      return docId;
    })()`);
    // 等元数据（Range 请求）补齐 —— 不等的话截图里永远是"正在取作者与摘要…"
    await ev(`(async () => {
      for (let i = 0; i < 120; i++) {
        const sel = window.__lunyun.getState().selection;
        if (sel && sel.kind === 'paper' && !sel.metaLoading) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return 1;
    })()`);
    // 再等邻接表 + 邻居标题（邻居标题是 4 次 Range 请求，串行取完要一点时间）
    await ev(`(async () => {
      const s = window.__lunyun.getState();
      const id = s.visibleDomains.find((d) => s.runtime[d] && s.runtime[d].catalog);
      await window.__lunyun.getState().loadRelations(id);
      return 1;
    })()`);
    await sleep(3000);
    const paperShot = await send("Page.captureScreenshot", { format: "png" });
    if (paperShot?.data) {
      writeFileSync(resolve(ROOT, OUT.replace(/\.png$/, "-paper.png")), Buffer.from(paperShot.data, "base64"));
      console.log(`论文面板截图已保存 ${OUT.replace(/\.png$/, "-paper.png")}`);
    }
  }
}

// ---- 可选：检索一个词并把效果拍下来（未命中的星压暗、命中的亮着） ----
const searchArg = args.indexOf("--search");
if (searchArg >= 0 && args[searchArg + 1]) {
  const word = args[searchArg + 1];
  await ev(`(async () => {
    await window.__lunyun.getState().search(${JSON.stringify(word)});
    for (let i = 0; i < 150; i++) {
      if (!window.__lunyun.getState().searchBusy) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 1;
  })()`);
  await sleep(1500);
  const stats = await ev(`(() => {
    const h = window.__lunyun.getState().searchHits;
    return JSON.stringify({ hits: h ? h.total : 0, terms: h ? h.terms : [] });
  })()`);
  console.log(`检索「${word}」：${stats}`);
  const sShot = await send("Page.captureScreenshot", { format: "png" });
  if (sShot?.data) {
    writeFileSync(resolve(ROOT, OUT.replace(/\.png$/, "-search.png")), Buffer.from(sShot.data, "base64"));
    console.log(`检索截图已保存 ${OUT.replace(/\.png$/, "-search.png")}`);
  }
}

// ---- 可选：切到某个排列模式并拍下来 ----
const layoutArg = args.indexOf("--layout");
if (layoutArg >= 0 && args[layoutArg + 1]) {
  const mode = args[layoutArg + 1];
  await ev(`(async () => {
    await window.__lunyun.getState().setLayoutMode(${JSON.stringify(mode)});
    return 1;
  })()`);
  // 时间模式要等年份表（每团一张，物理团 2.9 MB）
  await sleep(mode === "time" ? 6000 : 1800);
  const st = await ev(`JSON.stringify({
    mode: window.__lunyun.getState().layoutMode,
    yearTables: Object.keys(window.__lunyun.getState().yearTables).length,
    err: window.__lunyun.getState().layoutError ?? null,
  })`);
  console.log(`排列模式：${st}`);
  const lShot = await send("Page.captureScreenshot", { format: "png" });
  if (lShot?.data) {
    writeFileSync(resolve(ROOT, OUT.replace(/\.png$/, `-${mode}.png`)), Buffer.from(lShot.data, "base64"));
    console.log(`排列模式截图已保存 ${OUT.replace(/\.png$/, `-${mode}.png`)}`);
  }
}

// ---- 可选：打开"星尘流"（只留跨学科论文亮着）并拍下来 ----
if (args.includes("--cross")) {
  const st = await ev(`(async () => {
    await window.__lunyun.getState().toggleCrossOnly();
    for (let i = 0; i < 150; i++) {
      const t = window.__lunyun.getState().crossTables;
      if (Object.keys(t).length >= window.__lunyun.getState().visibleDomains.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const s = window.__lunyun.getState();
    return JSON.stringify({
      on: s.showCrossOnly,
      tables: Object.keys(s.crossTables).length,
      err: s.layoutError ?? null,
    });
  })()`);
  await sleep(1500);
  console.log(`星尘流：${st}`);
  const cShot = await send("Page.captureScreenshot", { format: "png" });
  if (cShot?.data) {
    writeFileSync(resolve(ROOT, OUT.replace(/\.png$/, "-cross.png")), Buffer.from(cShot.data, "base64"));
    console.log(`星尘流截图已保存 ${OUT.replace(/\.png$/, "-cross.png")}`);
  }
}

// ---- 可选：打开"超新星遗迹"面板并选中最强的一次爆发 ----
if (args.includes("--burst")) {
  const st = await ev(`(async () => {
    // 点"遗迹"按钮打开面板（与用户操作同一条路径）
    const btns = [...document.querySelectorAll('.btn.tiny')];
    const b = btns.find((x) => x.textContent.trim() === '遗迹');
    if (!b) return JSON.stringify({ error: '找不到遗迹按钮' });
    b.click();
    await new Promise((r) => setTimeout(r, 400));
    // 选中第一条（倍率最高的一次爆发）
    const row = document.querySelector('.burst-row');
    if (!row) return JSON.stringify({ error: '爆发清单为空' });
    const label = row.textContent;
    row.click();
    for (let i = 0; i < 120; i++) {
      const s2 = window.__lunyun.getState();
      if (s2.selectedBurst && s2.stratumTables[s2.selectedBurst.domain]) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const s = window.__lunyun.getState();
    return JSON.stringify({ picked: label.slice(0, 60), burst: s.selectedBurst, err: s.layoutError ?? null });
  })()`);
  await sleep(2500);
  console.log(`超新星遗迹：${st}`);
  const bShot = await send("Page.captureScreenshot", { format: "png" });
  if (bShot?.data) {
    writeFileSync(resolve(ROOT, OUT.replace(/\.png$/, "-burst.png")), Buffer.from(bShot.data, "base64"));
    console.log(`遗迹截图已保存 ${OUT.replace(/\.png$/, "-burst.png")}`);
  }
}

child.kill();
process.exit(0);
