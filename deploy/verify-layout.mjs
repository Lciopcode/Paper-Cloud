// 程序化验证：面板在多种视口宽度下都不被裁
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

const port = 9805;
const child = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--no-first-run", `--user-data-dir=${profileDir("d5")}`, "http://127.0.0.1:5311",
]);
let t = null;
for (let i = 0; i < 80 && !t; i++) {
  await sleep(400);
  try {
    const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    t = l.find((x) => x.type === "page" && x.url.startsWith("http"));
  } catch { /* 还没起来 */ }
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
let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); }
};
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evv = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.text ?? "");
  return r?.result?.value;
};
await send("Runtime.enable");
for (let i = 0; i < 120; i++) {
  if (await evv("!!(window.__lunyun&&window.__lunyun.getState().manifest)")) break;
  await sleep(400);
}
await sleep(5000);

// 选中一篇论文，让论文面板出现
await evv(`(() => {
  const s = window.__lunyun.getState();
  const id = s.visibleDomains.find((d) => { const r = s.runtime[d]; return r && (r.points || r.demoPoints); });
  const rt = s.runtime[id];
  const pts = rt.points || rt.demoPoints;
  s.selectPaper(id, pts.docIds[Math.floor(pts.count / 2)]);
  return 1;
})()`);
await sleep(500);

console.log("视口宽度   论文面板 [左, 右]                 层级面板 [左, 右]              结论");
let allOk = true;
for (const w of [762, 900, 1024, 1280, 1440, 1600, 1920]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const r = await evv(`(() => {
    const g = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; };
    return JSON.stringify({ vw: window.innerWidth, paper: g('.paper-panel'), hier: g('.hier-panel') });
  })()`);
  const o = JSON.parse(r);
  const ok = (a) => !a || (a[0] >= 0 && a[1] <= o.vw + 1);
  const pass = ok(o.paper) && ok(o.hier);
  if (!pass) allOk = false;
  const f = (a) => (a ? `[${String(a[0]).padStart(4)}, ${String(a[1]).padStart(4)}]` : "  (未显示)  ");
  console.log(`${String(o.vw).padStart(6)}   ${f(o.paper)}                ${f(o.hier)}            ${pass ? "✓ 完整可见" : "✗ 被裁"}`);
}
await send("Emulation.clearDeviceMetricsOverride");
console.log(`\n结论：${allOk ? "✓ 所有视口宽度下面板都完整可见" : "✗ 存在被裁的视口"}`);

child.kill();
process.exit(allOk ? 0 : 1);
