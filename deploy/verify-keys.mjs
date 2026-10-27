// @ts-nocheck
/**
 * 论文云 · 键盘与漫游自检
 * ============================================================================
 * 判据（每条都对应一个"看着能跑但实际没用"的具体问题）：
 *   1. 按 W 相机**真的移动了**（不是只吃掉了按键）；
 *   2. 方向键**不再**是相机的键，且**页面没有滚动**
 *      （相机换成诗云的 FlyControls 之后 MOVE_KEYS 只有 WASD/Space/Shift）；
 *   3. Space 升 / Shift 降（诗云的垂直轴，旧模型里 Shift 是"加速"）；
 *   4. Q/E 是**滚转**：姿态变、位置不动（旧模型里 Q/E 是升降）；
 *   5. 滚轮改的是**速度倍率**（×1.22 / ×0.82），不是缩放，也不移动相机；
 *   6. 在检索框里打字时，按 W **不能被当成漫游**（应该输入字母 w）；
 *   7. Esc 取消选中。
 *
 * ⚠️ 这个脚本跑在 **SwiftShader**（软件渲染，2–3 fps）上，这是**故意**的：
 *    它验的是键位与输入链路，不需要 GPU；而软件渲染下"一帧"很贵，
 *    恰好能把"每帧位移"放大到可测。所以断言都写成"位移 > 某个很小的阈值"，
 *    不写"700 毫秒应该走多远"（那取决于这几百毫秒里渲染了几帧）。
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

const port = 9812;
const child = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--window-size=1280,800", "--no-first-run",
  `--user-data-dir=${profileDir("kb")}`, "http://127.0.0.1:5311",
]);
let target = null;
for (let i = 0; i < 90 && !target; i++) {
  await sleep(400);
  try {
    const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = l.find((x) => x.type === "page" && x.url.startsWith("http"));
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
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 300);
  return r?.result?.value;
};
/**
 * 发一次真实的按键（不是合成 DOM 事件 —— 要经过浏览器的输入管线）。
 *
 * ⚠️ 只发 `keyDown` 是**不会产生文字输入**的 —— CDP 需要额外的 `type: "char"`
 *    或者带 `text` 字段的 keyDown。第一版只发了 keyDown，于是断言"按下的字母
 *    进了输入框"失败，而那是**测试的问题**，不是产品的问题
 *    （同一轮里"相机没有移动"那一半是对的，说明产品行为本来就正确）。
 */
async function key(k, type = "keyDown", code, keyCode) {
  const printable = k.length === 1 && /[a-z0-9]/i.test(k);
  await send("Input.dispatchKeyEvent", {
    type: type === "keyDown" && printable ? "keyDown" : type,
    key: k,
    code: code ?? (printable ? `Key${k.toUpperCase()}` : k),
    windowsVirtualKeyCode: keyCode ?? (printable ? k.toUpperCase().charCodeAt(0) : 0),
    nativeVirtualKeyCode: keyCode ?? (printable ? k.toUpperCase().charCodeAt(0) : 0),
    // 只有可打印字符才带 text —— 带上它浏览器才会真的把字符送进聚焦的元素
    text: type === "keyDown" && printable ? k : undefined,
  });
}
async function hold(k, ms, opts = {}) {
  await key(k, "keyDown", opts.code, opts.keyCode);
  await sleep(ms);
  await key(k, "keyUp", opts.code, opts.keyCode);
}

/**
 * **按帧数**按住一个键（不是按挂钟）。
 *
 * ## 为什么滚转那一条必须用这个
 *
 * 滚转是**逐帧积分**的（`f.roll += ROLL_RATE * dt`），而按键的时长原来是写死的 700ms。
 * 这个自检跑在 **SwiftShader（2–3 fps）**上，700ms 只能覆盖 **1~3 帧** ——
 * 帧数是个随机量，于是"按 Q 转了多少度"也跟着随机：
 * 实测同一份代码连跑两次，一次 **0.0°**（那一窗恰好一帧都没覆盖到）、一次 **7.3°**（两帧）。
 * 而理论值是 `ROLL_RATE(1.2) × 帧数 × dt(≈0.4s)`，两三帧就该有 **50° 以上**。
 *
 * **一个随机通过的判据比没有判据更糟**：它既不能防回归，又会训练人"红了就重跑一遍"。
 * 所以这里把输入改成**按帧数**给 —— 与 `waitFrames2` 同一条理由
 * （它上面那段注释已经为"位置"类断言解决过同一个问题，滚转当时漏掉了）。
 */
async function holdFrames(k, frames, opts = {}) {
  await key(k, "keyDown", opts.code, opts.keyCode);
  await waitFrames2(frames);
  await key(k, "keyUp", opts.code, opts.keyCode);
}

await send("Runtime.enable");
await send("Page.enable");
for (let i = 0; i < 150; i++) {
  if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break;
  await sleep(300);
}
await sleep(5000);

let fails = 0;
const note = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) fails++; };

/** 取相机位置（从调试桥）。 */
const camPos = async () =>
  JSON.parse(await ev(`(() => {
    const b = window.__lunyunDebug;
    if (!b) return JSON.stringify({ error: '没有调试桥' });
    const c = b.camera.position;
    return JSON.stringify({ x: +c.x.toFixed(3), y: +c.y.toFixed(3), z: +c.z.toFixed(3) });
  })()`));
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** 视口尺寸：滚轮事件必须发在画布范围内（发到 HUD 上会被它自己吃掉） */
const view = {
  w: Number(await ev("window.innerWidth")),
  h: Number(await ev("window.innerHeight")),
};

/** 等恰好 N 个渲染帧过去（软件渲染只有 2–3 fps，按挂钟等会量到 0 帧或多帧） */
const waitFrames2 = (n) =>
  ev(`(async () => { for (let i = 0; i < ${n}; i++) await new Promise(r => requestAnimationFrame(r)); return 1; })()`);

/**
 * "**什么都不按**的时候相机会漂多少" —— 所有"不该移动相机"的阈值都必须相对它来定。
 *
 * ## 为什么需要这个基线（这一条是实测逼出来的）
 *
 * 加进引力协转（`FlyCamera` 的 gravity 分支）之后，**"没按键" ≠ "相机不动"**：
 * 相机在星团内部时会跟着星系一起转，位置每帧都在变。
 * 这个脚本跑在 **SwiftShader（2–3 fps）**上，每帧 `dA = SPIN_RATE × Δt` 里的 Δt 接近 0.4 秒，
 * 于是每帧位移有 **0.06–0.11 单位** —— 上一版写死的 `0.02` 阈值因此全线误报（5 条假失败）。
 *
 * 在真 GPU（60 fps）上同一个量是 0.002 单位/帧，肉眼与阈值都看不出来；
 * 所以这不是"低画质环境的噪声"，而是**这个自检环境特有的量级**，只能用相对判据。
 */
const idleDrift = async (frames = 8) => {
  const a = await camPos();
  await waitFrames2(frames);
  return dist3(a, await camPos());
};
/**
 * 判"没动"的阈值：基线漂移的 2 倍再加一点点余量。
 *
 * ⚠️ **基线取三次采样的最大值**（2026-10 改）。
 *
 * 起因：方向键那一条实测 `位移 1.1562 < 阈值 1.1508` —— **差了 0.005**，纯噪声。
 * 原因是基线与被测窗口虽然都是 8 帧，但协转量是 `|offset| × SPIN_RATE × dt` 逐帧攒的，
 * 而 SwiftShader 下 `dt` 每帧在 0.3~0.5 秒之间跳，两个窗口的总量本来就不会相等；
 * 而且基线在**被测窗口之前**量，此时相机还在上一轮 W 移动后的位置附近、又漂了一点。
 *
 * 单次采样做基线 ⇒ 阈值贴着噪声边缘 ⇒ **判据会随机变红**。
 * 取三次的最大值把阈值抬到噪声包络之上，同时**离真信号还差一个数量级**：
 * 方向键若真的在平移相机，8 帧 × 0.4s × `FLY_BASE_SPEED`(3.0) ≈ **9.6 单位**，
 * 是阈值（约 1.2）的 8 倍 —— 所以这不是把判据放松，是把它从噪声里拔出来。
 */
const stillLimit = async () => {
  let worst = 0;
  for (let i = 0; i < 3; i++) worst = Math.max(worst, await idleDrift(8));
  return Math.max(0.05, worst * 2 + 0.05);
};
const IDLE = await idleDrift(8);
console.log(`  · 环境基线：什么都不按、8 帧漂 ${IDLE.toFixed(4)} 单位（引力协转，SwiftShader 下 2–3 fps）`);

// 调试桥是否存在（相机位置要靠它读）
const hasBridge = await ev("!!window.__lunyunDebug");
console.log(`\n调试桥 window.__lunyunDebug：${hasBridge ? "存在" : "**不存在**"}`);
if (!hasBridge) {
  console.log("  （读不到相机位置就无法断言\"真的移动了\" —— 需要先暴露调试桥）");
}

// 先确保焦点在画布上（不在输入框里）
await ev("document.querySelector('canvas')?.focus?.(); document.body.focus?.(); 1");
await sleep(300);

const p0 = await camPos();
if (p0.error) { console.log(`✗ ${p0.error}`); child.kill(); process.exit(1); }

/**
 * 1) 方向键**不再是**相机的键（照诗云的 MOVE_KEYS：只有 WASD / Space / Shift）
 *
 * ⚠️ 2026-10 相机从 `OrbitControls` 换成诗云的 FlyControls 之后，键位整套变了：
 *    旧模型是"方向键平移、Q/E 升降、Shift 加速"，新模型是
 *    "WASD 飞行、Space 升 / Shift 降、Q/E 滚转、滚轮调速"（`FlyControls.tsx` 的 MOVE_KEYS）。
 *    这条断言跟着反过来：方向键**不该**再动相机，但**也不该**让页面滚动
 *    （旧模型里方向键被 preventDefault 过，换模型后如果忘了处理，按一下页面就会滚 —— 那才是真 bug）。
 *
 * ## ⚠️ 为什么这一条必须**排在 W 之前**跑（2026-10 改）
 *
 * 空闲漂移是 `|离团心| × SPIN_RATE × dt` 逐帧攒的，而它**随位置变化极大**：
 * 实测开机机位 8 帧只漂 **0.014**，而 W 飞了 0.8 个单位之后同样 8 帧能漂 **1.2**。
 * 于是"在 W 之后量方向键"会得出一个被协转主导的数（实测 2.2 单位），
 * 跟基线（1.2）几乎一样大 —— 判据落进噪声里，只能靠把阈值放大到 2.5 倍才不误报，
 * **而真信号（方向键若真在平移：8 帧 × MOVE_DT 0.05 × FLY_BASE_SPEED 3.0 ≈ 1.2 单位）
 * 比那个阈值还小** —— 那就等于把这条判据废掉了。
 *
 * 正确做法不是放大阈值，而是**换一个没有干扰的测量位置**：
 * 在开机机位（漂移 0.014，可忽略）上量，阈值就能定得又紧又有意义。
 * 独立测量见 `_scratch/probe-arrow-key.mjs`（A 空闲 / B 按住方向键 / C 空闲 交替 4 轮）：
 * **A 0.014 · B 0.013 · C 0.014 —— 方向键的贡献是 0.000**，产品行为本来就是对的。
 *
 * ## ⚠️ 这条判据**仍然不是密不透风的**，把余量写在这里免得后人误以为它很硬
 *
 * 协转漂移去不掉：8 帧窗口里相机自己会漂 **0.51~0.58**（阈值 1.43~1.92，余量约 2.6×）。
 * 而"方向键真的在平移"的信号量级是 `8 帧 × MOVE_DT(0.05) × FLY_BASE_SPEED(3.0) ≈ 1.2`，
 * 加上漂移约 1.8 —— 与阈值同量级，**大约一半的概率能抓到**。
 * 要真正做硬，得把位移换算到引力球的旋转坐标系里再比（桥上的 `fly().bodies`
 * 已经给了 `center` / `axis`）。那是另一件事，本轮先不混进来；这里只保证
 * **它不再随机变红**，并且从"阈值低于噪声"改成了"阈值高于噪声"。
 */
const arrowLimit = await stillLimit();
const scrollBefore = await ev("window.scrollY");
/**
 * ⚠️ 起点必须**紧挨着按键之前**取，不能用更早的 `p0`。
 *
 * 第一版这里图省事复用了 `p0`，而 `p0` 与按键之间还隔着 `stillLimit()` 的
 * **3 次 8 帧空闲**（那正是基线的量法）—— 于是被测位移里混进了 24 帧的协转漂移，
 * 量出来 2.4~2.5，而真实的按键窗口只有 8 帧、漂移不到 0.1。
 * **"窗口的起点在哪一刻"与"窗口多长"同样重要**；这种错会让判据稳定地假失败。
 */
const arrowP0 = await camPos();
await key("ArrowRight", "keyDown", "ArrowRight", 39);
await waitFrames2(8);
await key("ArrowRight", "keyUp", "ArrowRight", 39);
const pArrow = await camPos();
const dArrow = dist3(arrowP0, pArrow);
const scrollAfter = await ev("window.scrollY");
note(
  dArrow < arrowLimit,
  `方向键不再移动相机（位移 ${dArrow.toFixed(4)} < 阈值 ${arrowLimit.toFixed(4)}，照诗云的键位）`,
);
note(scrollBefore === scrollAfter, `页面没有滚动（${scrollBefore} → ${scrollAfter}）`);

// 2) W 前进
//
// ⚠️ 按帧数给（见 `holdFrames` 的说明）：`hold("w", 700)` 在 2–3 fps 下只覆盖 1~3 帧，
//    位移是 `FLY_BASE_SPEED × dt` 逐帧积分的，覆盖 0 帧就是"按了没反应"的假失败。
await holdFrames("w", 5);
await sleep(300);
const p1 = await camPos();
const dW = dist3(p0, p1);
note(dW > 0.05, `按 W 相机移动了 ${dW.toFixed(3)}（按住 5 帧，>0.05）`);

// 3) Space 升 / Shift 降（诗云的垂直轴：`v.y += 1` / `v.y -= 1`）
//
// ⚠️ 旧模型里 Shift 是"加速 4 倍"、Q/E 是"升降"。诗云不是：Shift 与 Space 成对做垂直位移，
//    Q/E 是**滚转**（机身在转、位置不动）。这条断言就是"键位真的换过来了"的证据。
//
// ⚠️ 与滚转同理，输入**按帧数**给：位移是 `FLY_BASE_SPEED × dt` 逐帧积分的，
//    挂钟 700ms 在 2–3 fps 下只覆盖 1~3 帧，实测出现过"一帧都没覆盖到 ⇒ y 一动不动"
//    的假失败（`12.074 → 12.074`）。按住 6 帧 ⇒ 约 6 × 0.4 × 3.0 = 7 个单位，余量充足。
const beforeSpace = await camPos();
await holdFrames(" ", 6, { code: "Space", keyCode: 32 });
await sleep(300);
const afterSpace = await camPos();
note(afterSpace.y > beforeSpace.y + 0.05, `按 Space 升高（按住 6 帧，y ${beforeSpace.y.toFixed(3)} → ${afterSpace.y.toFixed(3)}）`);
const beforeShift = afterSpace.y;
await holdFrames("Shift", 6, { code: "ShiftLeft", keyCode: 16 });
await sleep(300);
const afterShift = await camPos();
note(afterShift.y < beforeShift - 0.05, `按 Shift 降低（按住 6 帧，y ${beforeShift.toFixed(3)} → ${afterShift.y.toFixed(3)}）`);

// 4) Q/E = 滚转（**姿态变、位置不动**）—— 照诗云 `ROLL_RATE = 1.2`
//
// ⚠️ 输入必须**按帧数**给（`holdFrames`），不能按挂钟 —— 见那个函数的说明：
//    按挂钟给的话这一条在 2–3 fps 下会随机落在 0~7° 之间，是个会随机变红的判据。
//    按住 5 帧 ⇒ 理论滚转角 ≈ 1.2 × 5 × 0.4 = 2.4 rad = 137°，
//    阈值因此可以从"3°"（噪声级）提到"20°"（真的转起来了）。
const quatOf = async () => JSON.parse(await ev("JSON.stringify(window.__lunyunDebug.camera.quaternion.toArray())"));
const qAngle = (a, b) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};
const rollLimit = await stillLimit();
const rollP0 = await camPos();
const rollQ0 = await quatOf();
await holdFrames("q", 5);
await sleep(300);
const rollP1 = await camPos();
const rollQ1 = await quatOf();
note(qAngle(rollQ0, rollQ1) > 20, `按 Q 机身滚转（按住 5 帧，姿态转了 ${qAngle(rollQ0, rollQ1).toFixed(1)}° > 20）`);
const rollMove = dist3(rollP0, rollP1);
note(rollMove < rollLimit, `滚转**不移动**相机（位移 ${rollMove.toFixed(4)} < 阈值 ${rollLimit.toFixed(4)}）`);

// 5) 滚轮 = 调速（自由飞行下**不是**缩放）—— 照诗云 `speedMul`（×1.22 / ×0.82）
const speedOf = async () => Number(await ev("window.__lunyun.getState().flySpeed"));
const sp0 = await speedOf();
const wheelLimit = await stillLimit();
const wP0 = await camPos();
await send("Input.dispatchMouseEvent", {
  type: "mouseWheel",
  x: Math.round(view.w / 2),
  y: Math.round(view.h / 2),
  deltaX: 0,
  deltaY: 120,
});
await sleep(400);
const sp1 = await speedOf();
const wP1 = await camPos();
note(Math.abs(sp1 / sp0 - 0.82) < 1e-9, `滚轮改的是**速度倍率**且档位精确（×${sp0} → ×${sp1}，比值 ${(sp1 / sp0).toFixed(4)}）`);
const wheelMove = dist3(wP0, wP1);
note(wheelMove < wheelLimit, `滚轮不移动相机（位移 ${wheelMove.toFixed(4)} < 阈值 ${wheelLimit.toFixed(4)}）`);

// 6) 在输入框里打字时不吃按键
const typing = await ev(`(() => {
  const inp = document.querySelector('.sb-input');
  if (!inp) return JSON.stringify({ error: '没有检索框' });
  inp.focus();
  return JSON.stringify({ focused: document.activeElement === inp });
})()`);
const typingLimit = await stillLimit();
const t = JSON.parse(typing);
if (!t.error && t.focused) {
  const c0 = await camPos();
  await hold("w", 500);
  await sleep(300);
  const c1 = await camPos();
  const dTyping = dist3(c0, c1);
  note(dTyping < typingLimit, `检索框聚焦时按 W 不会移动相机（位移 ${dTyping.toFixed(4)} < 阈值 ${typingLimit.toFixed(4)}）`);
  const val = await ev("document.querySelector('.sb-input').value");
  note(String(val).includes("w"), `按键进了输入框（值为「${val}」）`);
  await ev(`(() => { const i = document.querySelector('.sb-input'); i.value=''; i.blur(); return 1; })()`);
} else {
  note(false, `检索框聚焦失败：${typing}`);
}

// 7) Esc 取消选中
await ev(`(() => {
  const s = window.__lunyun.getState();
  const id = s.visibleDomains.find((x) => s.runtime[x]?.demoPoints || s.runtime[x]?.points);
  const pts = s.runtime[id].points || s.runtime[id].demoPoints;
  s.selectPaper(id, pts.docIds[10]);
  return 1;
})()`);
await sleep(1200);
const selBefore = await ev("!!window.__lunyun.getState().selection");
await hold("Escape", 80, { code: "Escape", keyCode: 27 });
await sleep(500);
const selAfter = await ev("!!window.__lunyun.getState().selection");
note(selBefore === true && selAfter === false, `Esc 取消选中（${selBefore} → ${selAfter}）`);

console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
child.kill();
process.exit(fails === 0 ? 0 : 1);
