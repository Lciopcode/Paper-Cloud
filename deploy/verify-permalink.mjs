// 验证永久链接：三种链接打开后能还原，且地址栏会随操作更新
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

const port = 9809;
const child = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--no-first-run", `--user-data-dir=${profileDir("pl")}`, "http://127.0.0.1:5311",
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
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 200);
  return r?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");
for (let i = 0; i < 120; i++) {
  if (await evv("!!(window.__lunyun&&window.__lunyun.getState().booted)")) break;
  await sleep(400);
}
await sleep(3000);

let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) fails++; };

// ---- 1. 操作后地址栏应当更新 ----
await evv(`(() => {
  const s = window.__lunyun.getState();
  const id = s.visibleDomains.find((d) => s.runtime[d]?.demoPoints || s.runtime[d]?.points);
  const pts = s.runtime[id].points || s.runtime[id].demoPoints;
  s.selectPaper(id, pts.docIds[Math.floor(pts.count / 2)]);
  return 1;
})()`);
await sleep(700);
const h1 = await evv("location.hash");
console.log(`\n选中后 hash = ${h1}`);
check(/^#p=\w+\.\d+/.test(String(h1)), "选星后地址栏出现 #p=<学科>.<docId>");

// ---- 2. 切模式后地址栏应当追加 m= ----
await evv("window.__lunyun.getState().setLayoutMode('time')");
await sleep(2000);
const h2 = await evv("location.hash");
console.log(`切时间模式后 hash = ${h2}`);
check(String(h2).includes("m=time"), "切模式后 hash 含 m=time");

// ---- 3. 检索后地址栏应当追加 q= ----
await evv(`(async () => { await window.__lunyun.getState().search('quantum'); return 1; })()`);
await sleep(2500);
const h3 = await evv("location.hash");
console.log(`检索后 hash = ${h3}`);
check(String(h3).includes("q=quantum"), "检索后 hash 含 q=quantum");

// ---- 4. 用那个 hash 重新加载页面，应当还原 ----
const target = String(h3);
await send("Page.navigate", { url: `http://127.0.0.1:5311/${target}` });
await sleep(1500);
for (let i = 0; i < 200; i++) {
  if (await evv("!!(window.__lunyun&&window.__lunyun.getState().booted)")) break;
  await sleep(300);
}

/**
 * ⚠️ **不能"固定等 7 秒然后断言"**（2026-10 改）。
 *
 * 原来这里写的是 `await sleep(7000); // 等 mode / search / paper 三件事都还原`。
 * 全量跑的时候实测翻红过一次，而那一次这一项跑了 **88.5 秒**（平时 29 秒）——
 * 机器整体慢了约 20%（同一次全量 602 秒 vs 平时 496 秒），7 秒就不够了：
 * 检索结果（`hits` 要跑一遍语料，这里是 138802 条）是 **IO/CPU 相关**的，
 * 不会按挂钟准时完成。
 *
 * 所以改成**轮询到三件事都还原**为止（最多 30 秒）。这样：
 *   · 机器慢 ⇒ 多等几轮，不会假红；
 *   · 真的坏 ⇒ 轮询用完就用**当时的真实值**去断言，红得又快又能看出是哪一件没还原。
 *
 * ⚠️ 这是本项目第四次踩"按挂钟猜时长"（前三次：`verify-keys` 的按键、
 *    `verify-filaments` 的淡出、`verify-spin` 的速率）。**规律是同一句话：
 *    判据该问"最终会不会成立"，不该问"若干秒后成没成立"。**
 */
let r = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  r = JSON.parse(
    await evv(`(() => {
      const s = window.__lunyun.getState();
      return JSON.stringify({
        mode: s.layoutMode,
        query: s.searchQuery,
        hits: s.searchHits ? s.searchHits.total : null,
        selKind: s.selection ? s.selection.kind : null,
        selDomain: s.selection && s.selection.domain,
        selDocId: s.selection && s.selection.docId,
        hash: location.hash,
      });
    })()`),
  );
  if (r.mode === "time" && r.query === "quantum" && r.hits > 0 && r.selKind === "paper") break;
}
console.log(`\n重新加载后：${JSON.stringify(r)}`);
check(r.mode === "time", `排列模式还原为 time（实际 ${r.mode}）`);
check(r.query === "quantum", `检索词还原（实际 ${r.query}）`);
check(r.hits > 0, `检索结果已算出（${r.hits}）`);
check(r.selKind === "paper", `选中的论文已还原（${r.selKind}）`);

// ---- 5.（已删除）虚空链接 ----
//
// `#v=<学科>.<编号>` 这个格式随「虚空拉取」一起去掉了，所以这里不再有用例。
// 老链接（别人手里可能还留着）不会让应用崩：`decodePermalink` 把无法识别的参数直接忽略，
// 那一点由 `src/state/permalink.test.ts` 里的兼容性用例守着。

console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
child.kill();
process.exit(fails === 0 ? 0 : 1);
