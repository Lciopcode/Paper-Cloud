// @ts-nocheck
/**
 * CSS 结构守卫：确认每条规则真的在浏览器的 CSSOM 里
 *
 * 为什么需要：源码完全正常、构建也不报错，但**一条规则可能因为前面的注释/
 * 括号不配对而被解析器吞掉**（实测：桌面端冒出了移动端的抽屉把手，
 * 根因是一段悬在注释外的正文让紧随其后的规则被吃掉）。
 * 这种问题只看源码和构建日志永远发现不了，只有问浏览器才知道。
 *
 * 判据：一批"必须在窄屏/宽屏分别生效"的关键规则，逐一确认存在于 CSSOM 且媒体条件正确。
 */
import { spawn } from "node:child_process";
import { debugTargetError, profileDir, resolveBrowser, waitForApp } from "./browser.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每条：[选择器, 期望的媒体条件（null = 无媒体条件）, 必须存在的属性片段] */
const EXPECT = [
  [".hud-handle", null, "display: none"],
  [".hud-handle", "(max-width: 900px)", "display: flex"],
  [".hud", "(max-width: 900px)", "inset"],
  [".pp-panel", "(max-width: 900px)", "inset"],
  [".sb-input", "(max-width: 900px)", "font-size: 16px"],
  [".legend", "(max-width: 900px)", "flex"],
  [".legend-row", null, "display"],
  [".lb-btn", "(max-width: 900px)", "min-height: 40px"],
  [".sb-title", null, "font-size"],
];

/**
 * 浏览器路径：由公共解析器找。
 *
 * ⚠️ 不要在这里写死绝对路径 —— 第一版 11 个脚本各自硬编码
 *    `D:\\chrome\\Application\\chrome.exe`，在开发机上能跑、**换台机器就断**，
 *    而报错是 spawn ENOENT，看起来像脚本坏了。
 *    解析顺序：--chrome 参数 → CHROME_PATH 环境变量 → 常见位置 → 注册表 → Edge 备选。
 */
const BROWSER = resolveBrowser();

const port = 9818;
const child = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--window-size=1582,904", "--no-first-run",
  `--user-data-dir=${profileDir("css")}`, "http://127.0.0.1:5311",
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
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 300);
  return r?.result?.value;
};
await send("Runtime.enable");

/*
 * 等**应用真的挂载完**，不要用固定的 `await sleep(3000)`。
 * 理由与实测数据见 browser.mjs 的 `waitForApp()`。
 */
const ready = await waitForApp(ev);
console.log(ready ? "页面就绪（应用已挂载 + 样式表已解析）\n" : "⚠️ 等待 30 秒后仍未就绪，下面结果可能不准\n");

const rules = JSON.parse(await ev(`(() => {
  const out = [];
  for (const sh of document.styleSheets) {
    let list; try { list = sh.cssRules; } catch { continue; }
    const walk = (ls, media) => {
      for (const r of ls) {
        if (r.type === CSSRule.MEDIA_RULE) { walk(r.cssRules, r.conditionText); continue; }
        if (r.selectorText) out.push({ media: media || null, sel: r.selectorText, css: r.style.cssText });
      }
    };
    walk(list, null);
  }
  return JSON.stringify(out);
})()`));
console.log(`浏览器 CSSOM 里共 ${rules.length} 条规则\n`);

let fails = 0;
for (const [sel, media, need] of EXPECT) {
  // 用"选择器列表包含"而不是全等 —— CSS 常把多个选择器合成一条规则
  // （例如 `.pp-panel, .paper-panel, .burst-panel { ... }`），全等会误报缺失。
  const hit = rules.find(
    (r) => r.sel.split(",").some((s) => s.trim() === sel) && (r.media ?? null) === media && r.css.includes(need),
  );
  const ok = !!hit;
  console.log(`  ${ok ? "✓" : "✗"} ${sel}${media ? " @ " + media : ""}  需含「${need}」`);
  if (!ok) {
    fails++;
    const near = rules.filter((r) => r.sel.split(",").some((s) => s.trim() === sel));
    console.log(`      实际找到 ${near.length} 条：${near.map((r) => `${r.media ?? "(无)"} → ${r.css.slice(0, 60)}`).join(" | ") || "（一条都没有 ⇒ 被解析器吞了）"}`);
  }
}
console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 条规则缺失或被吞`}`);
child.kill();
process.exit(fails === 0 ? 0 : 1);
