// @ts-nocheck
/**
 * 无障碍自检：系统「减少动态效果」偏好是否**一路传到着色器**
 *
 * 为什么需要单独一个脚本：
 * 这条偏好最容易只做一半 —— 在 CSS 里写个 `@media (prefers-reduced-motion)`
 * 就以为做完了，而**星点闪烁是在顶点着色器里做的**（6 万个点各自呼吸），
 * CSS 管不到它。第一版就是这样：CSS 过渡确实关了，但满屏仍然在闪。
 *
 * 判据：
 *   1. 系统偏好被读到（`reducedMotion === true`）；
 *   2. 星点材质的 `uTwinkle` **归零**（不是"调小" —— 这条偏好的语义是"别动"）；
 *   3. 抽屉的 CSS 过渡也被关掉（两条路都要覆盖）。
 *
 * ⚠️ 用 Chrome 的 `--force-prefers-reduced-motion` 模拟该偏好。
 */
import { spawn } from "node:child_process";
import { debugTargetError, profileDir, resolveBrowser, waitForApp } from "./browser.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 浏览器路径：由公共解析器找。
 *
 * ⚠️ 不要在这里写死绝对路径 —— 第一版 11 个脚本各自硬编码
 *    `D:\\chrome\\Application\\chrome.exe`，在开发机上能跑、**换台机器就断**，
 *    而报错是 spawn ENOENT，看起来像脚本坏了。
 *    解析顺序：--chrome 参数 → CHROME_PATH 环境变量 → 常见位置 → 注册表 → Edge 备选。
 */
const BROWSER = resolveBrowser();

const port = 9826;
const child = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  // 模拟"用户明确要求减少动态效果"
  "--force-prefers-reduced-motion",
  "--window-size=1280,800", "--no-first-run",
  `--user-data-dir=${profileDir("a11y")}`, "http://127.0.0.1:5311",
]);
let t = null;
for (let i = 0; i < 90 && !t; i++) {
  await sleep(400);
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); t = l.find((x) => x.type === "page" && x.url.startsWith("http")); } catch { /* 等 */ }
}
/*
 * ⚠️ 必须显式检查，不能让下面那句自己抛。
 *
 * 原来直接写 `new WebSocket(t.webSocketDebuggerUrl)` —— 启动失败时
 * 抛的是 **`Cannot read properties of null (reading 'webSocketDebuggerUrl')`**，
 * 完全看不出"浏览器没起来"这件事，更看不出该检查什么。
 * ⚠️ 实测（Edge 155）：**Edge 的 CDP 完全可用**。当时"连不上"的真因是
 * `--user-data-dir` 用了相对路径 —— 相对路径下浏览器会静默忽略
 * `--remote-debugging-port`（见 browser.mjs 的 profileDir()）。
 * 所以"换个浏览器"是错误的方向，参数才是。
 */
if (!t) {
  console.error(debugTargetError(BROWSER, port, 36));
  child.kill();
  process.exit(1);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 250);
  return r?.result?.value;
};
await send("Runtime.enable");
/**
 * 等首屏就绪。
 *
 * ⚠️ **2026-10 把等待从 45 秒提到 120 秒，并且"等不到"要显式失败。**
 * 起因：默认点密度提到每 20 篇取 1（八团 15.2 万点）之后，这个脚本在
 * `verify-all` 里超时失败（跑了 51.5 秒），而**单独跑又全绿** ——
 * 典型的"等待预算没跟着数据量走"：
 *   原来是 150 × 300ms = 45 秒，而软件渲染（SwiftShader）下 15 万点 + 21 MB 关系边的首屏
 *   已经逼近甚至超过这个数。
 * 更要紧的是**原来等不到就默默往下走**，于是失败会以"某个断言不对"的形式出现，
 * 让人去查那条断言，而真正的原因是"页面还没就绪"。
 */
const booted = await (async () => {
  for (let i = 0; i < 400; i++) {
    if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) return true;
    await sleep(300);
  }
  return false;
})();
if (!booted) {
  console.error("✗ 120 秒内没有 booted —— 首屏没就绪，下面的断言没有意义（不是断言本身的问题）");
  process.exit(1);
}
await sleep(4000);

let fails = 0;
const note = (ok, m) => { console.log(`  ${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };

// 1) 偏好被读到（先确认模拟真的生效，否则下面两条是空判据）
const mm = await ev(`window.matchMedia("(prefers-reduced-motion: reduce)").matches`);
console.log(`\n  浏览器报告的偏好：prefers-reduced-motion: reduce = ${mm}`);
note(mm === true, `模拟生效（否则下面两条会变成空判据）`);

const rm = await ev("window.__lunyun.getState().reducedMotion");
note(rm === true, `应用读到了这条偏好（reducedMotion=${rm}）`);

// 2) 星点闪烁归零
const tw = await ev(`(() => {
  const b = window.__lunyunDebug; const out = [];
  b.scene.traverse((o) => {
    if (!o.isPoints) return;
    const u = o.material && o.material.uniforms;
    if (u && u.uMaxSize) out.push(u.uTwinkle.value);   // 只取星点层（有 uMaxSize 的）
  });
  return JSON.stringify(out);
})()`);
const tws = JSON.parse(tw);
console.log(`  星点层的 uTwinkle：${JSON.stringify(tws)}`);
note(tws.length > 0, `找到了星点层（${tws.length} 个）—— 判据不是空的`);
note(tws.every((v) => v === 0), `全部归零（闪烁完全停止，而不是"调小"）`);

// 3) CSS 过渡也关了（两条路都要覆盖）
const css = await ev(`(() => {
  const el = document.querySelector('.hud');
  if (!el) return 'no-hud';
  return getComputedStyle(el).transitionProperty + ' / ' + getComputedStyle(el).transitionDuration;
})()`);
console.log(`  .hud 的过渡：${css}`);
note(String(css).includes("none") || String(css).includes("0s"), `.hud 的过渡被关掉（${css}）`);

console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
child.kill();
process.exit(fails === 0 ? 0 : 1);
