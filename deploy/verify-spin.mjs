// @ts-nocheck
/**
 * 自转自检：**刚性**与**背景差速**。
 *
 * ## 为什么这条判据必须存在（它补的是原来的一个空档）
 *
 * `_scratch/probe-spin.mjs` 只验了"论文层的时钟在走"，差速那半条它自己写着
 * 「星云层读的是 decorAngle（不对外暴露）…**差速由常量保证**」——
 * 而**常量对不等于接线对**：`SpinGroup` 的 `useFrame`、`kind` 的分派、
 * reducedMotion 的分支，任何一处接错，常量照样是对的。
 *
 * 自转有两条**不报错**的坏法，画面上几乎看不出来（0.012 rad/s 在两三秒里只有两三度）：
 *
 *   ① **刚性破了**：八个学科的组读到的角不一致 —— 画面上只是"有点不对"，
 *      但**拾取会与画面错开**（点到的星不是看到的那颗），那种错极难查；
 *   ② **差速没了**：星云与论文同速 ⇒ 整片星海像一个刚体风车（诗云专门避免这件事）。
 *
 * 所以这里读的是**每一组图层的真实 `rotation.y`**（桥上 `spinReport()`），不是时钟。
 *
 * ## 为什么要关掉"减少动态效果"
 *
 * 那条偏好会把角**冻结在 0**（`SpinGroup` 里 `reduced ? 0 : …`）。
 * 第一版没管这件事，量出来两组角都是 0.0000，看起来像"自转彻底坏了"——
 * **其实是偏好生效、产品行为正确**。所以这个脚本显式切到 `no-preference` 再重载；
 * 其余自检脚本需要的是相反的值（减少动态效果），两边都别互相抄。
 */
import { spawn } from "node:child_process";
import { debugTargetError, profileDir, resolveBrowser, waitForApp } from "./browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = resolveBrowser();

const port = 9818;
const child = spawn(BROWSER, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--window-size=1280,800",
  "--no-first-run",
  `--user-data-dir=${profileDir("spin")}`,
  "http://127.0.0.1:5311",
]);

let target = null;
for (let i = 0; i < 90 && !target; i++) {
  await sleep(400);
  try {
    const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = l.find((x) => x.type === "page" && x.url.startsWith("http"));
  } catch {
    /* 等 */
  }
}
if (!target) {
  console.error(debugTargetError(BROWSER, port, 36));
  child.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result ?? m.error);
    pend.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 300);
  return r?.result?.value;
};

await send("Runtime.enable");

/** 等应用就绪（八个团都有点） */
const waitReady = async () => {
  for (let i = 0; i < 150; i++) {
    await sleep(300);
    if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break;
  }
  for (let i = 0; i < 150; i++) {
    await sleep(300);
    const n = await ev(`(() => {
      const rt = window.__lunyun?.getState?.().runtime ?? {};
      return Object.values(rt).filter((r) => (r.points?.count ?? r.demoPoints?.count ?? 0) > 0).length;
    })()`);
    if (n >= 8) break;
  }
  await sleep(1500);
};

/**
 * ⚠️ 显式切成"**不**减少动态效果"—— 这条偏好会把自转角冻结在 0，见文件头。
 *    切完必须重载：偏好是挂载时读的，改它不会让已经冻结的组动起来。
 */
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
await send("Page.reload", { ignoreCache: false });
await waitReady();

let fails = 0;
const note = (ok, m) => {
  console.log(`  ${ok ? "✓" : "✗"} ${m}`);
  if (!ok) fails++;
};

const hasBridge = await ev("!!(window.__three && window.__three.spinReport)");
if (!hasBridge) {
  console.error("  ✗ 调试桥没有 spinReport() —— 读不到真实角度就无法验证刚性与差速");
  child.kill();
  process.exit(1);
}

const report = async () => JSON.parse(await ev("JSON.stringify(window.__three.spinReport())"));
const t0 = Date.now();
const A = await report();
await sleep(5000);
const B = await report();
const dt = (Date.now() - t0) / 1000;

const mains = (r) => r.groups.filter((g) => g.kind === "main").map((g) => g.rotY);
const decors = (r) => r.groups.filter((g) => g.kind === "decor").map((g) => g.rotY);
const dAngle = B.angle - A.angle;
const dDecor = B.decorAngle - A.decorAngle;

console.log(`\n=== 自转：刚性 + 背景差速 ===`);
console.log(`  两组读数相隔 ${dt.toFixed(1)} 秒 · 共 ${A.groups.length} 个自转组`);
console.log(`  angle      ${A.angle.toFixed(4)} → ${B.angle.toFixed(4)}   （Δ${dAngle.toFixed(4)}，${(dAngle / dt).toFixed(4)} rad/s）`);
console.log(`  decorAngle ${A.decorAngle.toFixed(4)} → ${B.decorAngle.toFixed(4)}   （Δ${dDecor.toFixed(4)}，${(dDecor / dt).toFixed(4)} rad/s）\n`);

// 1) 两个时钟都在走，且速率照诗云（0.012 / 0.019 rad/s）
//
// ⚠️ 容差取 **25%**，不是"实测多少就是多少"：这里的分母是**挂钟**，
//    而时钟累加的是每帧的 `dt`，两者在软件渲染下对不齐（实测 5.0 秒挂钟只累出 4.4 秒的 dt，
//    差的那 12% 是启动首帧与卡顿帧）。所以**绝对值只能粗判"确实在这个量级"**；
//    真正精确、且与实现意图一一对应的不变量是下面第 2 条的**比值**（1.583）。
note(Math.abs(dAngle / dt - 0.012) < 0.003, `论文层速率 ≈ 0.012 rad/s（实测 ${(dAngle / dt).toFixed(4)}）`);
note(Math.abs(dDecor / dt - 0.019) < 0.005, `星云层速率 ≈ 0.019 rad/s（实测 ${(dDecor / dt).toFixed(4)}）`);

// 2) **差速真的存在**（这一条原来只由"常量保证"，从没有实测过）
//
// 比值不受"挂钟 vs 累加 dt"那件事影响（两个角用同一个分母），所以这里可以卡得很紧。
const ratio = dDecor / dAngle;
note(ratio > 1.5 && ratio < 1.67, `背景差速存在：decor/main = ${ratio.toFixed(4)}（照诗云 0.019/0.012 = 1.5833）`);

// 3) **刚性**：八个学科的主组必须同角
const m = mains(B);
const spread = m.length ? Math.max(...m) - Math.min(...m) : Infinity;
note(m.length >= 8, `main 组有 ${m.length} 个（八个学科各一组）`);
note(spread < 1e-6, `刚性：${m.length} 个 main 组的 rotation.y 极差 ${spread.toExponential(2)}（要求 < 1e-6）`);

// 4) **每一组都跟上了时钟**（不是"只有一组在转、别的停在 0"）
note(
  m.length > 0 && m.every((v) => Math.abs(v - B.angle) < 1e-6),
  `每一组 main 的角都等于时钟角（最大偏差 ${m.length ? Math.max(...m.map((v) => Math.abs(v - B.angle))).toExponential(2) : "n/a"}）`,
);
const d = decors(B);
note(
  d.length >= 8 && d.every((v) => Math.abs(v - B.decorAngle) < 1e-6),
  `每一组 decor 的角都等于时钟角（${d.length} 组，最大偏差 ${d.length ? Math.max(...d.map((v) => Math.abs(v - B.decorAngle))).toExponential(2) : "n/a"}）`,
);

// 5) 反证：两类组必须**不同角**，否则"差速"在画面上等于没有
note(
  Math.abs(B.angle - B.decorAngle) > 1e-4,
  `main 与 decor 确实不同角（相差 ${Math.abs(B.angle - B.decorAngle).toFixed(4)} rad）`,
);

console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
ws.close();
child.kill();
process.exit(fails === 0 ? 0 : 1);
