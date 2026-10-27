// @ts-nocheck
/** 引用亮度自检：数据接线、覆盖率如实显示、亮度真的分档 */
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

const port = 9813;
const child = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--window-size=1280,800", "--no-first-run",
  `--user-data-dir=${profileDir("ct")}`, "http://127.0.0.1:5311",
]);
let target = null;
for (let i = 0; i < 90 && !target; i++) {
  await sleep(400);
  try {
    const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = l.find((x) => x.type === "page" && x.url.startsWith("http"));
  } catch { /* 等 */ }
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
  console.error(debugTargetError(BROWSER, port, 36));
  child.kill();
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 300);
  return r?.result?.value;
};
await send("Runtime.enable");
for (let i = 0; i < 150; i++) {
  if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break;
  await sleep(300);
}
let fails = 0;
const note = (ok, m) => { console.log(`  ${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };

// 等引用表自动加载完（boot 之后后台拉，不阻塞首屏）
for (let i = 0; i < 120; i++) {
  const n = await ev("Object.keys(window.__lunyun.getState().citeTables||{}).length");
  if (n > 0) break;
  await sleep(300);
}
await sleep(2500);

const r = await ev(`(() => {
  const s = window.__lunyun.getState();
  const ids = Object.keys(s.citeTables || {});
  if (!ids.length) return JSON.stringify({ error: '没有加载到引用表' });
  const id = ids[0];
  const t = s.citeTables[id];
  // 取一批真实 docId 看亮度分布
  const pts = s.runtime[id].points || s.runtime[id].demoPoints;
  const buckets = { noRecord: 0, zero: 0, low: 0, mid: 0, high: 0 };
  let maxCite = 0, maxBright = 0, minBright = 9;
  for (let i = 0; i < pts.count; i++) {
    const d = pts.docIds[i];
    const b = t.brightOf(d);
    const c = t.citesOf(d);
    if (c > maxCite) maxCite = c;
    if (b > maxBright) maxBright = b;
    if (b < minBright) minBright = b;
    if (!t.hasRecordOf(d)) buckets.noRecord++;
    else if (c === 0) buckets.zero++;
    else if (b < 1.4) buckets.low++;
    else if (b < 2.0) buckets.mid++;
    else buckets.high++;
  }
  return JSON.stringify({
    domain: id, count: t.count, coveragePct: +t.coveragePct.toFixed(2),
    scaleCites: t.scaleCites, maxCites: t.maxCites,
    buckets, maxCiteSeen: maxCite, minBright: +minBright.toFixed(3), maxBright: +maxBright.toFixed(3),
    total: pts.count,
  });
})()`);
const o = JSON.parse(r);
if (o.error) { note(false, o.error); }
else {
  console.log(`\n  ${o.domain}：${o.count.toLocaleString()} 篇 · 覆盖率 ${o.coveragePct}% · 最高引用 ${o.maxCites.toLocaleString()} · 亮度基准 P99=${o.scaleCites}`);
  console.log(`  可见 ${o.total.toLocaleString()} 点的亮度分布：`);
  console.log(`     无记录 ${o.buckets.noRecord} · 0 引用 ${o.buckets.zero} · 低 ${o.buckets.low} · 中 ${o.buckets.mid} · 高 ${o.buckets.high}`);
  note(o.coveragePct > 0, `覆盖率被算出来（${o.coveragePct}%）—— 界面据此如实显示，不会把缺失画成"引用少"`);
  note(o.scaleCites > 1, `亮度基准 P99 = ${o.scaleCites}（>1，说明真的按分位归一化，不是用最大值）`);
  note(o.buckets.noRecord > 0, `确实存在"无记录"的点（${o.buckets.noRecord}）—— 它们与"0 引用"分开统计`);
  note(o.maxBright > 1.05, `有星的亮度高于中性（最高 ${o.maxBright}）`);
  note(o.minBright >= 0.74, `最暗不低于 0.75（"无记录"不被画成黑：${o.minBright}）`);
  note(o.buckets.low + o.buckets.mid + o.buckets.high > 0, `亮度真的分档（低+中+高 = ${o.buckets.low + o.buckets.mid + o.buckets.high}）`);
}
// 界面上有没有如实显示覆盖率
const ui = await ev(`(() => {
  const n = [...document.querySelectorAll('.lb-note')].map(e=>e.textContent).join(' | ');
  return n;
})()`);
console.log(`\n  界面提示：${String(ui).slice(0, 200)}`);
note(/引用亮度已开/.test(String(ui)) && /%/.test(String(ui)), "界面如实显示了引用覆盖率");
console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
child.kill();
process.exit(fails === 0 ? 0 : 1);
