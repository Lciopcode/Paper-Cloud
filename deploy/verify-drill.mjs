// @ts-nocheck
/** 下潜自检：点 L3 真的只留那个方向的论文亮着；取消能恢复 */
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

const port = 9819;
const child = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--window-size=1582,904", "--no-first-run",
  `--user-data-dir=${profileDir("dr")}`, "http://127.0.0.1:5311",
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
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 250);
  return r?.result?.value;
};
await send("Runtime.enable");
for (let i = 0; i < 150; i++) { if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break; await sleep(300); }
await sleep(3000);
let fails = 0;
const note = (ok, m) => { console.log(`  ${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };

// 打开层级面板并点第一个 L3
const clicked = await ev(`(async () => {
  const s = window.__lunyun.getState();
  const id = s.visibleDomains[0];
  // 打开层级面板
  const rows = [...document.querySelectorAll('.legend-row')];
  const phase = rows[0]?.querySelector('.lg-phase');
  if (!phase) return JSON.stringify({ error: '找不到层级入口' });
  phase.click();
  await new Promise(r => setTimeout(r, 600));
  const l3 = document.querySelector('.hier-l3');
  if (!l3) return JSON.stringify({ error: '面板里没有 L3 行' });
  const label = l3.querySelector('.hier-l3-zh')?.textContent ?? '';
  l3.click();
  for (let i = 0; i < 100; i++) {
    const s2 = window.__lunyun.getState();
    if (s2.highlightStratum && s2.stratumTables[s2.highlightStratum.domain]) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return JSON.stringify({ domain: id, label, drill: window.__lunyun.getState().highlightStratum });
})()`);
console.log(`\n  点击结果：${clicked}`);
const c = JSON.parse(clicked);
if (c.error) note(false, c.error);
else {
  note(!!c.drill, `已进入下潜（${c.label}）`);
  note(!!c.drill && typeof c.drill.stratum === "number", `层号已解析为下标 ${c.drill?.stratum}`);
  await sleep(1200);
  // 统计几何里 aDim 的分布：应当有"亮"与"暗"两档，且亮的占比明显小于 100%
  const stat = await ev(`(() => {
    const b = window.__lunyunDebug;
    const out = [];
    b.scene.traverse((o) => {
      if (!o.isPoints || !o.geometry.getAttribute('aDim') || !o.geometry.getAttribute('aCites')) return;
      const dim = o.geometry.getAttribute('aDim').array;
      let lit = 0, dark = 0;
      for (let i = 0; i < dim.length; i++) { if (dim[i] > 0.5) lit++; else dark++; }
      out.push({ total: dim.length, lit, dark });
    });
    return JSON.stringify(out);
  })()`);
  console.log(`  aDim 分布：${stat}`);
  const g = JSON.parse(stat);
  const target = g.find((x) => x.lit > 0 && x.dark > 0);
  note(!!target, "存在「亮/暗」两档（说明筛选真的生效了）");
  if (target) {
    const pct = (100 * target.lit) / target.total;
    note(pct < 95, `亮着的只占 ${pct.toFixed(1)}%（不是"全都亮"）`);
    note(pct > 0.01, `亮着的占 ${pct.toFixed(1)}%（不是"全都暗"）`);
  }
  // 取消下潜
  const cleared = await ev(`(async () => {
    const btn = [...document.querySelectorAll('.hier-drill-bar .btn')][0];
    if (!btn) return 'no-button';
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    return JSON.stringify(window.__lunyun.getState().highlightStratum);
  })()`);
  note(String(cleared) === "null", `取消下潜后状态清空（${cleared}）`);
  await sleep(800);
  const after = await ev(`(() => {
    const b = window.__lunyunDebug; let dark = 0, total = 0;
    b.scene.traverse((o) => {
      if (!o.isPoints || !o.geometry.getAttribute('aDim') || !o.geometry.getAttribute('aCites')) return;
      const dim = o.geometry.getAttribute('aDim').array;
      for (let i = 0; i < dim.length; i++) { total++; if (dim[i] < 0.5) dark++; }
    });
    return JSON.stringify({ total, dark });
  })()`);
  const a2 = JSON.parse(after);
  note(a2.dark === 0, `取消后没有压暗的点（暗 ${a2.dark}/${a2.total}）`);
}
console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
child.kill();
process.exit(fails === 0 ? 0 : 1);
