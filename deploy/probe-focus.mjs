/**
 * 论文云 · **居中探针**：证明「点一颗星之后，相机真的飞到那颗星、并把它放到画面中央」
 * ============================================================================
 *
 * ## 这个脚本回答什么问题
 *
 * 交接文档 §4② / §8-2 留的题目：*选中星"居中"未验证*。
 * 代码链路是「StarPicker.onUp → selectPaper → FocusOnSelect（写 focusTarget）→ FlyCamera
 * 的锁定轨道分支」，但**没有任何真机读数**证明它真的发生了 —— 而这一条链上任何一环断了，
 * 画面上都只是"好像没飞"或"好像飞了但没对准"，靠截图分辨不出来。
 *
 * 所以这里走**真机 + 真鼠标**：无头 Edge + CDP，用 `Input.dispatchMouseEvent` 在
 * `__three.projectAnchor(domain, docId)` 给出的**屏幕像素**上真按一下，然后逐时刻读
 * `cameraPos / cameraQuat / cameraAnchorDist / projectAnchor / fly()`，把"飞过去"这件事
 * 变成一串可比对的数字。
 *
 * ## 为什么必须"真鼠标"而不是直接调 `selectPaper`
 *
 * 直接调 store 只能证明 `FocusOnSelect + FlyCamera` 这一段；而用户遇到的问题是
 * **"点了星星没反应"**，那一段（`StarPicker` 的 300 万点 CPU 投影拾取）恰恰最可疑。
 * 所以断言的第一条就是"点击真的选中了我们瞄准的那篇（docId 一致）"。
 *
 * ## 为什么"瞄准"要迭代（本脚本最关键的一处实测教训）
 *
 * `StarPicker` 的拾取规则是"光标 14px 内**屏幕上最近**的那颗星"（`StarPicker.tsx:35`）。
 * 默认视图里八团全量约 300 万个点，屏幕上平均每平方像素就有 2 个点 —— 直接按候选星的
 * 投影像素点下去，赢的常常是**旁边那颗**（实测第一次尝试就选中了 14px 内的邻星）。
 * 所以这里用"**点 → 看实际选中了谁 → 再瞄准那篇的投影点一次**"的迭代：
 * 最终写入 `selection` 的 docId 一定等于**这一次**瞄准的 docId，
 * 这才既证明了真实点击链路、又不会被像素遮挡伪判为"没选中"。
 *
 * ## 判据（全部落进 JSON，控制台打印同样内容）
 *
 *   ① 点击命中：`selection.docId === 瞄准的 docId`（来自真实指针事件，不是直接调 API）；
 *   ② `focusTarget` 被写入：`at` 晚于点击，`pos` 与"相机最终位置 + 视线 × 距离"一致；
 *   ③ 相机真的动了：点击前后 `cameraPos` 距离 **> 1 世界单位**，且远大于"环境漂移"；
 *   ④ 距离收敛到锁值：`cameraAnchorDist` 收敛到 `FlyCamera.LOCK_DIST`（`src/three/FlyCamera.tsx:89`，= 18），
 *      终值 ±1.0，并打印 0.3/0.5/1/2/3s（以及 4/6/8s）的时间序列；
 *   ⑤ 真的**居中**：飞行结束后 `projectAnchor` 与画布中心的像素偏差 ≤ 25px 且 ≤ 2.5% 短边；
 *   ⑥ 对照组：**无选中**时 3 秒相机不动（< 0.5 世界单位）——在**引力球外**测，
 *      因为星团有"引力协转"（相机在球内会跟着星系转，那是设计，不是 bug，单独量并解释）。
 *
 * ## 三个只有真机才看得见的坑（都在这份脚本里处理了）
 *
 *   1. **背景全量加载会阻塞主线程十几秒**：`cloud.ts` 的 boot 会串行把八团从演示点集升级成
 *      全量点集（物理团 146 万点）。这期间 `setTimeout(3000)` 实测要 12.7 秒才回来 ——
 *      于是"3 秒对照"变成"12.7 秒对照"。所以脚本先 `waitAllFull()`（有上限）再开始量。
 *   2. **默认机位在 CS 引力球里**：无选中时相机会跟星系一起转（3 秒约 1.3 世界单位）。
 *      这是 `FlyCamera.tsx:532-559` 的引力协转，不是 bug。脚本把"引力球外 3s 不动"作为
 *      严格对照，另把"默认机位 3s 的 1.3 单位"单独量出来并与公式预测对照。
 *   3. **hover 拾取要 0.3~0.5 秒（300 万点 CPU 投影）**，而星点随自转约 9px/s（FlyCamera
 *      文件头算过）。所以点击**不先 dispatch mouseMoved**：pointerdown/up 不依赖 hover，
 *      少等 300ms 就少偏 3px。
 *
 * ## 可复跑（Lead 重建 dist 后直接重跑）
 *
 *   node deploy/probe-focus.mjs --url http://127.0.0.1:5311 --port 9711
 *
 * 常用参数：
 *   --url <地址>       默认 http://127.0.0.1:5311
 *   --port <端口>      CDP 端口，默认 9711（避开 snap.mjs 的 9701）
 *   --out <文件>       证据 JSON，默认 shots/probe-focus-<时间戳>.json
 *   --attempts <N>     最多真实点击几次，默认 8
 *   --full-wait <ms>   等八团全量点集的上限，默认 240000；0 = 不等（不推荐，计时会被阻塞污染）
 *   --png              额外保存飞行前/后两张快照（shots/probe-focus-*.png，软件渲染下慢，默认关）
 *   --chrome <路径>    浏览器路径（默认走 deploy/browser.mjs 的 resolveBrowser）
 *
 * 退出码：0 = 全部判据通过；1 = 有判据失败（附失败环节 + file:line）；2 = 环境问题。
 *
 * ## 约束（刻意写死在脚本里）
 *
 *   · 不改 src / 不 build / 不重启服务器 —— 只连已经在跑的 5311；
 *   · CDP 端口 9711，profile 用 browser.mjs 的 profileDir()（**绝对路径**：
 *     相对路径会让 Edge 静默忽略 --remote-debugging-port）；
 *   · 所有读数来自页面自己的只读桥 `window.__three` 与 `window.__lunyun`，
 *     **不在探针里重算投影/位置**，否则验的是探针自己；
 *   · 唯一的写操作是 `__three.placeCamera()`（应用自己提供的诊断入口）—— 用来把相机放到
 *     引力球外做对照，测完再放回原机位。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { debugTargetError, headlessArgs, profileDir, resolveBrowser, waitAllFull, waitForApp } from "./browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const argv = process.argv.slice(2);
const argVal = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

if (has("--help") || has("-h")) {
  console.log(
    [
      "居中探针：真实点击一颗星，证明相机飞到它、并把它放到画面中央",
      "",
      "  node deploy/probe-focus.mjs [--url http://127.0.0.1:5311] [--port 9711]",
      "                             [--out shots/probe-focus-<ts>.json] [--attempts 8]",
      "                             [--full-wait 240000] [--png] [--chrome <路径>]",
      "",
      "证据：shots/probe-focus-<时间戳>.json（并同步 shots/probe-focus-latest.json）",
      "退出码：0 全部通过 / 1 有判据失败 / 2 环境问题（浏览器起不来、服务器不响应、dist 没调试桥）",
    ].join("\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 参数与常量
// ---------------------------------------------------------------------------
const URL_ = argVal("--url", "http://127.0.0.1:5311");
const PORT = Number(argVal("--port", "9711"));
const MAX_CLICKS = Math.max(1, Number(argVal("--attempts", "8")));
const FULL_WAIT = Math.max(0, Number(argVal("--full-wait", "240000")));
const WANT_PNG = has("--png");
/** `FlyCamera.LOCK_DIST`（src/three/FlyCamera.tsx:89）—— 期望终值；页面里的 fly().lockDist 会交叉核对 */
const LOCK_DIST_SRC = 18;
/** 居中的像素容差：min(25px, 2.5% 短边) */
const CENTER_PX_TOL = 25;
const CENTER_PCT_TOL = 2.5;
/** 严格对照（引力球外、无选中）3 秒允许的相机位移 */
const CONTROL_MOVE_TOL = 0.5;
const STAMP = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
const OUT = argVal("--out", `shots/probe-focus-${STAMP}.json`);
const OUT_LATEST = "shots/probe-focus-latest.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist3 = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : null);
const r3 = (v, n = 3) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(n)));
const vec3 = (v) => (Array.isArray(v) ? v.map((x) => r3(x)) : null);
/** 四元数 (x,y,z,w) → 相机视线（-Z 轴）的世界方向 */
function quatForward(q) {
  if (!q) return null;
  const [x, y, z, w] = q;
  return [-2 * w * y - 2 * z * x, 2 * w * x - 2 * z * y, -1 + 2 * x * x + 2 * y * y];
}
function quatAngleDeg(a, b) {
  if (!a || !b) return null;
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return r3((2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI, 2);
}
function centerOffset(proj) {
  if (!proj || !proj.w || !proj.h) return null;
  const dx = proj.x - proj.w / 2;
  const dy = proj.y - proj.h / 2;
  return { dx: r3(dx, 2), dy: r3(dy, 2), px: r3(Math.hypot(dx, dy), 2) };
}
/** 在若干天体里找"把 p 包含进去"的那一个（用于解释引力协转） */
function bodyContaining(bodies, p) {
  if (!p || !Array.isArray(bodies)) return null;
  let best = null;
  for (const b of bodies) {
    if (!b || !b.center || b.axis == null) continue;
    const d = Math.hypot(p[0] - b.center[0], p[1] - b.center[1], p[2] - b.center[2]);
    if (d < b.gravityR && (!best || d < best.d)) best = { id: b.id, d, gravityR: b.gravityR, center: b.center, axis: b.axis };
  }
  return best;
}
/**
 * 预测"相机跟着星系自转 Δθ"产生的位移（引力协转）。
 * 相机绕天体轴转 Δθ，位移 = |R_perp(Δθ) − R_perp(0)|；R_perp 是"相机−球心"垂直于转轴的分量。
 */
function predictedCoRotation(body, p, dA) {
  if (!body || !p || dA == null) return null;
  const v = [p[0] - body.center[0], p[1] - body.center[1], p[2] - body.center[2]];
  const a = body.axis;
  const dot = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
  const perp = [v[0] - a[0] * dot, v[1] - a[1] * dot, v[2] - a[2] * dot];
  const rPerp = Math.hypot(perp[0], perp[1], perp[2]);
  return { rPerp: r3(rPerp), chord: r3(2 * rPerp * Math.abs(Math.sin(dA / 2))) };
}

// ============================================================================
// 页面侧表达式（在页面里执行，只读 __three / __lunyun；唯一写操作是 placeCamera）
// ============================================================================

/** 等 n 个渲染帧（带 1.5s 兜底，防止页面被节流时永久挂住） */
const exprWaitFrames = (n) => `(async () => {
  const frame = () => new Promise((done) => {
    let fired = false;
    const t = setTimeout(() => { if (!fired) { fired = true; done(); } }, 1500);
    requestAnimationFrame(() => { if (!fired) { fired = true; clearTimeout(t); done(); } });
  });
  for (let i = 0; i < ${n}; i++) await frame();
  return 1;
})()`;

/** 清空选中 */
const EXPR_CLEAR = `(() => { const s = window.__lunyun.getState(); if (s.selection) s.clearSelection(); return 1; })()`;

/** 把相机放到指定世界坐标（应用自己暴露的诊断入口，用于对照组） */
const exprPlace = (x, y, z) => `(() => { window.__three.placeCamera(${x}, ${y}, ${z}); return 1; })()`;

/** 相机/选中/fly 的当前状态 */
const EXPR_STATE = `(() => {
  const T = window.__three, s = window.__lunyun.getState();
  const c = document.querySelector("canvas");
  return JSON.stringify({
    pos: T.cameraPos(), quat: T.cameraQuat(),
    fly: T.fly(),
    selection: s.selection ? { kind: s.selection.kind, domain: s.selection.domain, docId: s.selection.docId, snapDistance: s.selection.snapDistance } : null,
    focusTarget: s.focusTarget ? { pos: s.focusTarget.pos, at: s.focusTarget.at } : null,
    canvas: c ? { w: c.clientWidth, h: c.clientHeight, left: c.getBoundingClientRect().left, top: c.getBoundingClientRect().top } : null,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, hidden: document.visibilityState },
  });
})()`;

/** 对照组：从现在这一刻起量 durationMs，无选中 */
const exprControl = (durationMs) => `(async () => {
  const T = window.__three;
  const a = { pos: T.cameraPos(), quat: T.cameraQuat(), spin: T.spinAngle ? T.spinAngle() : null, t: performance.now() };
  await new Promise((r) => setTimeout(r, ${durationMs}));
  const b = { pos: T.cameraPos(), quat: T.cameraQuat(), spin: T.spinAngle ? T.spinAngle() : null, t: performance.now() };
  return JSON.stringify({ a, b, fly: T.fly(), selection: window.__lunyun.getState().selection ? 1 : null });
})()`;

/**
 * 候选星扫描。
 *
 * 从 store 的 `runtime[d].points ?? demoPoints`（屏幕上**真正画出来的那批点**）里
 * 按随机起点、固定步长抽 ~260 个 docId/学科，用 `__three.projectAnchor` 投影成屏幕坐标；
 * 只保留：在视口中央 80% 区域、在相机前方、`document.elementFromPoint` 命中的就是 canvas
 * （否则点到 HUD 上了）。
 *
 * 再按两个偏好排序：
 *   · **离相机越远越好**（`cameraAnchorDist ≥ 28`）—— 飞到 18 的位移才够大，胜过环境漂移；
 *   · 离画布中心约 30% 短边 —— 点击前明显偏，飞行后应当落回中心，前后对比才有说服力。
 */
const exprScan = (perDomain, maxPool) => `(async () => {
  const T = window.__three, S = () => window.__lunyun.getState();
  const canvas = document.querySelector("canvas");
  if (!T || !canvas) return JSON.stringify({ error: "页面没有 __three 或 canvas" });
  const rect = canvas.getBoundingClientRect();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const st = S();
  const domains = [];
  const pool = [];
  let projected = 0, inView = 0, blocked = 0, behind = 0;
  for (const d of st.visibleDomains) {
    const rt = st.runtime[d];
    const pts = rt && (rt.points || rt.demoPoints);
    if (!pts || !pts.docIds) continue;
    const n = pts.docIds.length;
    const step = Math.max(1, Math.floor(n / ${perDomain}));
    domains.push({ domain: d, count: n, step, phase: rt.phase, full: !!rt.full });
    const off = Math.floor(Math.random() * step);
    for (let i = off; i < n; i += step) {
      const docId = pts.docIds[i];
      const p = T.projectAnchor(d, docId);
      projected++;
      if (!p) continue;
      if (!p.inFront) { behind++; continue; }
      if (p.x < W * 0.10 || p.x > W * 0.90 || p.y < H * 0.10 || p.y > H * 0.90) continue;
      const cx = rect.left + p.x, cy = rect.top + p.y;
      if (cx < 2 || cy < 2 || cx > window.innerWidth - 2 || cy > window.innerHeight - 2) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top !== canvas) { blocked++; continue; }
      inView++;
      const ad = T.cameraAnchorDist(d, docId);
      pool.push({ domain: d, docId: docId, sx: +p.x.toFixed(2), sy: +p.y.toFixed(2), cx: +cx.toFixed(2), cy: +cy.toFixed(2), anchorDist: ad == null ? null : +ad.toFixed(2) });
    }
  }
  const mx = W / 2, my = H / 2, targetR = Math.min(W, H) * 0.30;
  for (const c of pool) { c.off = +Math.hypot(c.sx - mx, c.sy - my).toFixed(2); }
  pool.sort((a, b) => {
    const fa = a.anchorDist != null && a.anchorDist >= 28 ? 0 : 1;
    const fb = b.anchorDist != null && b.anchorDist >= 28 ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return Math.abs(a.off - targetR) - Math.abs(b.off - targetR);
  });
  return JSON.stringify({
    canvas: { w: W, h: H, left: +rect.left.toFixed(2), top: +rect.top.toFixed(2) },
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    domains, projected, inView, blocked, behind, farPool: pool.filter((c) => c.anchorDist != null && c.anchorDist >= 28).length,
    pool: pool.slice(0, ${maxPool}),
  });
})()`;

/** 某个 docId 此刻的屏幕投影（含视口坐标） */
const exprProject = (domain, docId) => `(() => {
  const T = window.__three;
  const p = T.projectAnchor(${JSON.stringify(domain)}, ${docId});
  if (!p) return null;
  const r = document.querySelector("canvas").getBoundingClientRect();
  return JSON.stringify({ x: p.x, y: p.y, w: p.w, h: p.h, ndcZ: p.ndcZ, inFront: p.inFront, cx: r.left + p.x, cy: r.top + p.y });
})()`;

/** 点击目标像素上最顶层的 DOM 是谁（确认点在 canvas 上，而不是 HUD） */
const exprTopEl = (x, y) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  const canvas = document.querySelector("canvas");
  return JSON.stringify({ tag: el ? el.tagName : null, cls: el ? String(el.className || "").slice(0, 100) : null, isCanvas: el === canvas });
})()`;

/** 点击前的完整读数 */
const exprBefore = (domain, docId) => `(() => {
  const T = window.__three, s = window.__lunyun.getState();
  const d = ${JSON.stringify(domain)}, doc = ${docId};
  const p = T.projectAnchor(d, doc);
  const sel = s.selection;
  return JSON.stringify({
    pos: T.cameraPos(), quat: T.cameraQuat(),
    anchorDist: T.cameraAnchorDist(d, doc),
    fly: T.fly(), spin: T.spinAngle ? T.spinAngle() : null,
    proj: p ? { x: p.x, y: p.y, w: p.w, h: p.h, inFront: p.inFront } : null,
    selection: sel ? { kind: sel.kind, domain: sel.domain, docId: sel.docId, snapDistance: sel.snapDistance } : null,
    focusTarget: s.focusTarget ? { pos: s.focusTarget.pos, at: s.focusTarget.at } : null,
    t: performance.now(),
  });
})()`;

/**
 * 点击后的时间序列采样（在页面里定时采样，避免 CDP 往返抖动）。
 *
 * t=0 是"点击事件处理完、主线程空出来的那一刻"（300 万点的 CPU 投影会阻塞主线程
 * 数秒，真实点击→首个采样点之间隔着这段拾取耗时，单独记成 pickLatencyMs）。
 * 0.15s 之后若选中还不一致 ⇒ 提前结束（省掉剩余的采样）。
 *
 * 采样窗口是**自适应**的：软件渲染只有 1~3 fps，而 `FlyCamera` 每帧 dt 被封顶 0.1s
 * （`damp(dt)`），所以"收敛"是按**帧数**而不是按秒数 —— 帧越少需要越长的时间。
 * 每采一个点都检查"离锁定距离 ≤0.5 且比上一点变化 ≤0.15"（连续两次算收敛），
 * 收敛后再采到 ≥3s 就停；否则一直采到 25s 上限。这样既保证了 0.3/0.5/1/2/3s 的序列，
 * 又不会在 1fps 的机器上过早判"没收敛"。
 */
const exprSampler = (domain, docId) => `(async () => {
  const T = window.__three, S = () => window.__lunyun.getState();
  const domain = ${JSON.stringify(domain)}, docId = ${docId};
  const marks = [0.05, 0.15, 0.3, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 15, 18, 21, 25];
  const t0 = performance.now();
  let frames = 0, stop = false;
  const tick = () => { if (stop) return; frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const out = [];
  let aborted = false, settled = null;
  for (let k = 0; k < marks.length; k++) {
    const wait = t0 + marks[k] * 1000 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const st = S();
    const sel = st.selection && st.selection.kind === "paper" ? { domain: st.selection.domain, docId: st.selection.docId } : null;
    const p = T.projectAnchor(domain, docId);
    const fly = T.fly();
    const sample = {
      t: +((performance.now() - t0) / 1000).toFixed(3),
      frames,
      pos: T.cameraPos(),
      quat: T.cameraQuat(),
      anchorDist: T.cameraAnchorDist(domain, docId),
      proj: p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), w: p.w, h: p.h, inFront: p.inFront } : null,
      locked: fly.locked, lockDist: fly.lockDist,
      spin: T.spinAngle ? T.spinAngle() : null,
      sel,
    };
    out.push(sample);
    const matched = sel && sel.domain === domain && sel.docId === docId;
    if (marks[k] >= 0.15 && k < marks.length - 1 && !matched) { aborted = true; break; }
    if (settled == null && marks[k] >= 0.5 && sample.anchorDist != null && sample.lockDist != null) {
      const prev = out.length > 1 ? out[out.length - 2] : null;
      if (Math.abs(sample.anchorDist - sample.lockDist) <= 0.5 && prev && prev.anchorDist != null && Math.abs(prev.anchorDist - sample.anchorDist) <= 0.15) {
        settled = sample.t;
      }
    }
    if (settled != null && marks[k] >= 3) break;
  }
  stop = true;
  const ft = S().focusTarget;
  const c = document.querySelector("canvas");
  return JSON.stringify({
    aborted, settled, frames, elapsed: +((performance.now() - t0) / 1000).toFixed(3),
    out,
    focusTarget: ft ? { pos: ft.pos, at: ft.at } : null,
    now: Date.now(),
    canvas: c ? { w: c.clientWidth, h: c.clientHeight } : null,
  });
})()`;

/** 环境总览（证据的 env 段） */
const EXPR_ENV = `(() => {
  const T = window.__three, s = window.__lunyun.getState();
  const runtime = {};
  for (const [d, r] of Object.entries(s.runtime || {})) {
    runtime[d] = { phase: r.phase, full: !!r.full, points: r.points ? r.points.count : null, demo: r.demoPoints ? r.demoPoints.count : null, error: r.error || null };
  }
  return JSON.stringify({
    scene: T.sceneInfo ? T.sceneInfo() : null,
    cameraPos: T.cameraPos(), cameraQuat: T.cameraQuat(), fly: T.fly(), spin: T.spinAngle ? T.spinAngle() : null,
    starMode: s.starMode, layoutMode: s.layoutMode, visibleDomains: s.visibleDomains,
    runtime,
    selection: s.selection ? { kind: s.selection.kind, domain: s.selection.domain, docId: s.selection.docId } : null,
    focusTarget: s.focusTarget ? { pos: s.focusTarget.pos, at: s.focusTarget.at } : null,
    bridge: Object.keys(T).sort(),
    canvas: (() => { const c = document.querySelector("canvas"); return c ? { w: c.clientWidth, h: c.clientHeight } : null; })(),
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, hidden: document.visibilityState },
  });
})()`;

// ============================================================================
// 主流程
// ============================================================================
const startedAt = Date.now();
const log = (...a) => console.log(...a);
const evidence = {
  meta: {
    tool: "lunyun/deploy/probe-focus.mjs",
    purpose: "证明点星之后相机真的飞到该星并居中（交接文档 §4② / §8-2）",
    startedAt: new Date(startedAt).toISOString(),
    url: URL_, port: PORT, node: process.version, cwd: ROOT,
    argv: process.argv.slice(1),
    lockDistSource: { value: LOCK_DIST_SRC, file: "src/three/FlyCamera.tsx", line: 89 },
  },
  srcRefs: {
    pickRule: "src/three/StarPicker.tsx:35（PICK_RADIUS_PX=14，取光标半径内屏幕上最近的那颗）",
    pickHandler: "src/three/StarPicker.tsx:62-81（pointerup 且位移 <5px 才算点击，命中才 selectPaper）",
    selectPaper: "src/state/cloud.ts:748-784（spine 解析 + 写 selection）",
    focusOnSelect: "src/three/FocusOnSelect.tsx:30-39（resolveAnchor 成功 → 写 focusTarget，最多 40 帧重试）",
    lockBranch: "src/three/FlyCamera.tsx:471-511（selection 且 resolveAnchor 成功 ⇒ 进入锁定轨道分支）",
    lockDist: "src/three/FlyCamera.tsx:89（LOCK_DIST=18）",
    lockReinit: "src/three/FlyCamera.tsx:474-488（换目标时从当前视角反解 yaw/pitch，第一帧零跳变）",
    lockLerp: "src/three/FlyCamera.tsx:494-495（camera.position.lerp 到 target+offset*dist）",
    lockLookAt: "src/three/FlyCamera.tsx:496-500（lookAt 目标 + slerp ⇒ 目标应落在画面正中）",
    gravityCoRot: "src/three/FlyCamera.tsx:532-559（相机在引力球内会跟着星系一起转 —— 对照组要解释的就是它）",
  },
  env: null, canvas: null, controlFar: null, controlDefault: null, scan: null, attempts: [],
  success: null, controlB: null, derived: null, assertions: [], verdict: null, failureStage: null, failureHint: null,
};

let child = null;
let ws = null;
let stderrTail = "";
const killBrowser = () => {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (child && child.exitCode == null) child.kill(); } catch { /* 忽略 */ }
};
process.on("exit", killBrowser);
process.on("SIGINT", () => { killBrowser(); process.exit(130); });

function writeEvidence(rel, obj) {
  const abs = resolve(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(obj, null, 2));
  return abs;
}

function finish(code, failStage = null) {
  evidence.meta.finishedAt = new Date().toISOString();
  evidence.meta.durationMs = Date.now() - startedAt;
  if (failStage) evidence.failureStage = failStage;
  evidence.verdict = code === 0 ? "PASS" : "FAIL";
  const tsPath = writeEvidence(OUT, evidence);
  writeEvidence(OUT_LATEST, evidence);
  const d = evidence.derived || {};

  console.log("\n" + "=".repeat(80));
  console.log(`==== 居中探针结论：${evidence.verdict} ====`);
  if (evidence.success) {
    const s = evidence.success;
    console.log(`点击：${s.aim.domain}/${s.aim.docId}  屏幕 (${s.click.x}, ${s.click.y})  真实点击 ${evidence.attempts.filter((a) => a.clicked).length} 次（其中重瞄 ${s.aim.reaim} 次）`);
    console.log(`相机：点击前 (${(d.beforePos || []).map((x) => r3(x)).join(", ")})`);
    console.log(`      → 终值 (${(d.finalPos || []).map((x) => r3(x)).join(", ")})   移动 ${d.movedWorld} 世界单位   四元数变化 ${d.quatAngleDeg}°`);
    console.log(`cameraAnchorDist：${(d.anchorDistSeries || []).map((p) => `${p.t}s=${p.d}`).join("  ")}`);
    console.log(`  点击前 ${d.anchorDistBefore} → 终值 ${d.anchorDistFinal}（锁定距离 ${d.lockDist}，src LOCK_DIST=${LOCK_DIST_SRC}，差 ${d.lockErr}）`);
    console.log(`  收敛到 ±1.0：${d.convergeAt != null ? `${d.convergeAt}s` : "未在采样窗口内达到"}`);
    console.log(`居中：投影 (${d.finalProj ? d.finalProj.x + ", " + d.finalProj.y : "?"}) vs 画布中心 (${d.finalProj ? d.finalProj.w / 2 + ", " + d.finalProj.h / 2 : "?"})  偏差 ${d.centerOffsetPx}px（${d.centerOffsetPct}% 短边）；点击前偏差 ${d.centerOffsetBeforePx}px`);
    console.log(`fly()：locked=${d.flyLocked} lockDist=${d.lockDist}  focusTarget 写入延迟 ${d.focusDelayMs}ms  pos 误差 ${d.focusPosVsEstimate}`);
    console.log(`环境漂移（引力协转预测）：${d.ambient ? `${d.ambient.chord} 世界单位 / ${d.ambient.windowSec}s（在 ${d.ambient.body} 引力球内，R⊥=${d.ambient.rPerp}）` : "无"}   fps≈${d.fps}  拾取耗时≈${d.pickLatencyMs}ms`);
  } else {
    console.log(`失败环节：${evidence.failureStage || "未知"}`);
    console.log(`提示：${evidence.failureHint || "见 evidence"}`);
  }
  if (evidence.controlDefault) console.log(`对照（默认机位 · 无选中 3s）：移动 ${evidence.controlDefault.moved}${evidence.controlDefault.explained ? `（解释：在 ${evidence.controlDefault.insideBody} 引力球内跟着自转，公式预测 ${evidence.controlDefault.predicted}）` : ""}`);
  if (evidence.controlFar) console.log(`对照（引力球外 · 无选中 3s）：移动 ${evidence.controlFar.moved} 世界单位`);
  if (evidence.controlB) console.log(`对照（清空选中 · 引力球外 3s）：移动 ${evidence.controlB.moved} 世界单位`);
  for (const x of evidence.assertions) console.log(`  ${x.ok ? "✔" : "✘"} ${x.name}：${x.detail}`);
  console.log(`证据：${tsPath}（并同步 ${OUT_LATEST}）`);
  console.log("=".repeat(80) + "\n");

  killBrowser();
  process.exit(code);
}

try {
  // --------------------------------------------------------------------------
  // 0. 环境自检：CDP 端口 / 浏览器
  // --------------------------------------------------------------------------
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      console.error(
        `✗ CDP 端口 ${PORT} 已被占用（可能是上次没退干净的浏览器）。\n` +
          `  先确认没有别的探针在跑；必要时结束残留的 msedge.exe 再重试，或换 --port。`,
      );
      process.exit(2);
    }
  } catch { /* 端口空闲，正常 */ }

  if (!/^https?:/.test(URL_)) {
    console.error(`✗ --url 必须是 http(s) 地址：${URL_}`);
    process.exit(2);
  }
  const BROWSER = resolveBrowser();
  evidence.meta.browser = BROWSER;
  const PROFILE = profileDir("snap-focus"); // 绝对路径：相对路径 Edge 会静默忽略 --remote-debugging-port
  evidence.meta.profile = PROFILE;

  log(`居中探针：${URL_}  ·  CDP ${PORT}  ·  ${BROWSER}`);
  child = spawn(
    BROWSER,
    headlessArgs([
      `--remote-debugging-port=${PORT}`,
      "--window-size=1600,1000",
      "--force-device-scale-factor=1",
      // 计时类读数需要页面真的在跑 rAF：禁止后台节流
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--mute-audio",
      `--user-data-dir=${PROFILE}`,
      URL_,
    ]),
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.on("data", (b) => { stderrTail = (stderrTail + String(b)).slice(-4000); });
  child.on("error", (e) => console.error(`✗ 浏览器启动失败：${e.message}\n  路径：${BROWSER}`));

  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page" && t.url.startsWith("http"));
    } catch { /* 还没起来 */ }
  }
  if (!target) {
    console.error(debugTargetError(BROWSER, PORT, 40, ROOT));
    if (stderrTail) console.error(`\n浏览器 stderr（尾部）：\n${stderrTail}`);
    process.exit(2);
  }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((r) => (ws.onopen = r)),
    sleep(10000).then(() => { throw new Error("CDP WebSocket 10s 内没打开"); }),
  ]);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve: res, reject: rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message}${m.error.data ? "：" + m.error.data : ""}`));
      else res(m.result);
    }
  };
  ws.onclose = () => {
    for (const { reject: rej } of pending.values()) rej(new Error("CDP 连接已关闭"));
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++seq;
      pending.set(i, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (pending.has(i)) { pending.delete(i); rej(new Error(`CDP ${method} 超时（120s）`)); }
      }, 120000);
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "未知异常";
      throw new Error(`页面求值异常：${String(d).slice(0, 500)}`);
    }
    return r?.result?.value;
  };
  const evJson = async (expression) => {
    const v = await ev(expression);
    if (v == null) return null;
    return typeof v === "string" ? JSON.parse(v) : v;
  };

  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  // --------------------------------------------------------------------------
  // 1. 等应用挂载 + 八团就绪 + 八团全量点集就位（否则后台构建会阻塞主线程、污染计时）
  // --------------------------------------------------------------------------
  const tReady0 = Date.now();
  const mounted = await waitForApp(ev, { timeoutMs: 90000 });
  evidence.meta.appMounted = mounted;
  evidence.meta.appMountMs = Date.now() - tReady0;
  if (!mounted) {
    evidence.failureHint = "应用 90s 内没有挂载完成（#root 空 / 样式表没解析）——先确认 5311 返回的是能跑的前端";
    evidence.assertions.push({ name: "应用挂载", ok: false, detail: "waitForApp 超时" });
    finish(1, "环境：应用未挂载");
  }

  let domainsReady = null;
  for (let i = 0; i < 180; i++) {
    const st = await evJson(`(() => {
      const s = window.__lunyun && window.__lunyun.getState ? window.__lunyun.getState() : null;
      if (!s) return null;
      const r = Object.values(s.runtime || {});
      return JSON.stringify({ total: r.length, ready: r.filter((x) => x.phase === "ready" || x.phase === "demo").length });
    })()`);
    if (st && st.ready >= 8) { domainsReady = st; break; }
    await sleep(700);
  }
  if (!domainsReady) {
    evidence.failureHint = "8 个学科 126s 内没有全部进入 ready/demo —— 服务器或资产有问题（先跑 node deploy/snap.mjs）";
    evidence.assertions.push({ name: "八团就绪", ok: false, detail: "超时" });
    finish(1, "环境：八团未就绪");
  }
  log(`八团就绪（${domainsReady.total} 个，全部 ready/demo），等八团全量点集（后台串行升级）…`);

  let allFull = false;
  if (FULL_WAIT > 0) {
    const tFull0 = Date.now();
    allFull = await waitAllFull(ev, FULL_WAIT);
    evidence.meta.allFull = allFull;
    evidence.meta.fullWaitMs = Date.now() - tFull0;
    log(`全量点集：${allFull ? "八团就位" : `等待超时（${FULL_WAIT}ms）——继续跑，但后段可能有构建卡顿`}，用时 ${evidence.meta.fullWaitMs}ms`);
  } else {
    evidence.meta.allFull = null;
    log("（--full-wait 0：不等全量点集，计时可能被后台构建阻塞污染）");
  }

  // 几何点数连续稳定（防止"正在换点集"的帧里开始测）
  let lastPoints = -1, stable = 0, sceneInfo = null;
  for (let i = 0; i < 60; i++) {
    sceneInfo = await evJson(`JSON.stringify(window.__three && window.__three.sceneInfo ? window.__three.sceneInfo() : null)`);
    const p = sceneInfo ? sceneInfo.points : -1;
    if (p > 0 && p === lastPoints) stable++;
    else stable = 0;
    lastPoints = p;
    if (stable >= 2) break;
    await sleep(1200);
  }
  await sleep(2000);

  const env = await evJson(EXPR_ENV);
  evidence.env = env;
  evidence.canvas = env ? env.canvas : null;
  if (!env || !env.bridge || !env.bridge.includes("cameraAnchorDist") || !env.bridge.includes("projectAnchor") || !env.bridge.includes("placeCamera")) {
    evidence.failureHint =
      "页面没有 __three 调试桥（或缺少 cameraAnchorDist/projectAnchor/placeCamera）—— 当前 dist 可能不是最新构建。" +
      "需要 Lead 重建 dist 后重跑；本探针不允许改 src / 跑 build。";
    evidence.assertions.push({ name: "调试桥可用", ok: false, detail: JSON.stringify((env && env.bridge) || null) });
    finish(2, "环境：dist 缺调试桥");
  }
  const coarse = {};
  for (const [d, r] of Object.entries(env.runtime || {})) coarse[d] = `${r.phase}${r.full ? "/full" : ""}:${r.points ?? r.demo}`;
  log(`场景：points=${sceneInfo ? sceneInfo.points : "?"} groups=${sceneInfo ? sceneInfo.groups : "?"} lines=${sceneInfo ? sceneInfo.lines : "?"}`);
  log(`点集：${Object.entries(coarse).map(([d, v]) => `${d}=${v}`).join("  ")}`);
  if (env.viewport && env.viewport.hidden !== "visible") log(`⚠ 页面 visibilityState=${env.viewport.hidden}，rAF 可能被节流`);

  const initialPos = env.cameraPos;
  if (!initialPos) {
    evidence.failureHint = "读不到 cameraPos —— __three.cameraPos() 返回 null（_bridge 还没挂上？）";
    finish(2, "环境：读不到相机");
  }

  // --------------------------------------------------------------------------
  // 2. 对照组：先到"引力球外"验证无选中时相机真的不动
  //    （默认机位在 CS 引力球内，会被引力协转带着转 —— 那是设计，不是 bug；单独量并解释）
  // --------------------------------------------------------------------------
  // 对照组的"引力球外"位置：默认 [0,0,220]（八团球心都在原点附近 ±20、半径 ≤27，远在球外）。
  // 若将来布局变大导致它落进某个引力球里，就沿 Z 倍推，保证对照点一定在球外。
  let FAR = [0, 0, 220];
  for (let i = 0; i < 3 && bodyContaining(env.fly.bodies, FAR); i++) FAR = [FAR[0], FAR[1], FAR[2] * 2];
  const farBody = bodyContaining(env.fly.bodies, FAR);
  await ev(EXPR_CLEAR);
  await ev(exprPlace(FAR[0], FAR[1], FAR[2]));
  await ev(exprWaitFrames(2));
  const ctrlFar = await evJson(exprControl(3000));
  const ctrlFarMoved = dist3(ctrlFar.a.pos, ctrlFar.b.pos);
  evidence.controlFar = {
    where: FAR, insideBody: farBody ? farBody.id : null,
    posBefore: vec3(ctrlFar.a.pos), posAfter: vec3(ctrlFar.b.pos),
    moved: r3(ctrlFarMoved), durationMs: r3(ctrlFar.b.t - ctrlFar.a.t, 1),
    spinDelta: r3(ctrlFar.b.spin - ctrlFar.a.spin, 5),
    selection: ctrlFar.selection,
  };
  log(`对照（引力球外 · 无选中）：相机移动 ${evidence.controlFar.moved} 世界单位（${evidence.controlFar.durationMs}ms，Δθ=${evidence.controlFar.spinDelta} rad）`);

  // 回到默认机位，量"默认机位无选中"的漂移（用于解释，不作为严格判据）
  await ev(exprPlace(initialPos[0], initialPos[1], initialPos[2]));
  await ev(exprWaitFrames(2));
  const ctrlDef = await evJson(exprControl(3000));
  const ctrlDefMoved = dist3(ctrlDef.a.pos, ctrlDef.b.pos);
  const defBody = bodyContaining(ctrlDef.fly.bodies, ctrlDef.a.pos);
  const defPred = defBody ? predictedCoRotation(defBody, ctrlDef.a.pos, ctrlDef.b.spin - ctrlDef.a.spin) : null;
  evidence.controlDefault = {
    insideBody: defBody ? defBody.id : null,
    bodyDist: defBody ? r3(defBody.d) : null, bodyR: defBody ? r3(defBody.gravityR) : null,
    posBefore: vec3(ctrlDef.a.pos), posAfter: vec3(ctrlDef.b.pos),
    moved: r3(ctrlDefMoved), durationMs: r3(ctrlDef.b.t - ctrlDef.a.t, 1),
    spinDelta: r3(ctrlDef.b.spin - ctrlDef.a.spin, 5),
    predicted: defPred ? defPred.chord : null, predictedPerp: defPred ? defPred.rPerp : null,
    explained: !!(defBody && defPred && Math.abs(ctrlDefMoved - defPred.chord) <= Math.max(0.35, 0.35 * defPred.chord)),
    selection: ctrlDef.selection,
  };
  log(`对照（默认机位 · 无选中）：相机移动 ${evidence.controlDefault.moved} 世界单位` + (defBody ? `，在 ${defBody.id} 引力球内（距球心 ${r3(defBody.d)} / R ${r3(defBody.gravityR)}），公式预测协转 ${defPred ? defPred.chord : "?"}` : ""));

  // 回到默认机位，开始找星
  await ev(exprPlace(initialPos[0], initialPos[1], initialPos[2]));
  await ev(exprWaitFrames(2));
  const startPos = await evJson(`JSON.stringify(window.__three.cameraPos())`);

  // --------------------------------------------------------------------------
  // 3. 候选星扫描 + 真实点击（含"点偏了就改瞄实际选中的那颗"的迭代）
  // --------------------------------------------------------------------------
  let scan = await evJson(exprScan(260, 40));
  evidence.scan = {
    canvas: scan.canvas, viewport: scan.viewport, domains: scan.domains,
    projected: scan.projected, inView: scan.inView, blocked: scan.blocked, behind: scan.behind,
    farPool: scan.farPool, poolSize: scan.pool.length, poolHead: scan.pool.slice(0, 8),
  };
  log(`候选扫描：投影 ${scan.projected} 个 · 视口中央可点 ${scan.inView} 个（HUD 挡住 ${scan.blocked}）· 其中远景(≥28) ${scan.farPool} 个 · 候选池 ${scan.pool.length}`);

  /** 每次尝试前：清空选中 → 相机放回默认机位 → 等 2 帧（返回值是实际落点，用于核对） */
  async function prepare(pos) {
    await ev(EXPR_CLEAR);
    await ev(exprWaitFrames(2));
    await ev(exprPlace(pos[0], pos[1], pos[2]));
    await ev(exprWaitFrames(1));
    return await evJson(`JSON.stringify(window.__three.cameraPos())`);
  }

  const tried = new Set();
  let poolIdx = 0;
  let rescans = 0;
  let clicks = 0;
  let goal = null; // 当前瞄准 { domain, docId, reaim(第几次重瞄), fromPool }
  let skipped = 0;
  let guard = 0;

  while (!evidence.success && clicks < MAX_CLICKS && guard++ < 80) {
    if (!goal) {
      // 从候选池里取一个没试过的；池子用完就重扫（随机起点不同 ⇒ 新的一批）
      while (poolIdx < scan.pool.length && tried.has(scan.pool[poolIdx].domain + ":" + scan.pool[poolIdx].docId)) poolIdx++;
      if (poolIdx >= scan.pool.length) {
        if (rescans >= 3) break;
        rescans++;
        await prepare(startPos);
        scan = await evJson(exprScan(260, 40));
        poolIdx = 0;
        evidence.scan.rescans = rescans;
        continue;
      }
      const c = scan.pool[poolIdx++];
      const key = c.domain + ":" + c.docId;
      if (tried.has(key)) continue;
      tried.add(key);
      goal = { domain: c.domain, docId: c.docId, reaim: 0, fromPool: true, pool: c };
    }

    const placedAt = await prepare(startPos);
    const placeErr = dist3(placedAt, startPos);
    const proj = await evJson(exprProject(goal.domain, goal.docId));
    if (!proj || !proj.inFront) {
      evidence.attempts.push({ n: evidence.attempts.length + 1, aim: goal, skipped: "投影失败 / 在相机后方", placeErr: r3(placeErr) });
      goal = null; skipped++;
      continue;
    }
    const vp = scan.viewport;
    if (proj.cx < 2 || proj.cy < 2 || proj.cx > vp.w - 2 || proj.cy > vp.h - 2) {
      evidence.attempts.push({ n: evidence.attempts.length + 1, aim: goal, skipped: `投影在视口外 (${r3(proj.cx, 1)}, ${r3(proj.cy, 1)})`, placeErr: r3(placeErr) });
      goal = null; skipped++;
      continue;
    }
    const top = await evJson(exprTopEl(r3(proj.cx, 2), r3(proj.cy, 2)));
    if (!top || !top.isCanvas) {
      evidence.attempts.push({ n: evidence.attempts.length + 1, aim: goal, skipped: `该像素被 HUD 盖住（${top ? top.tag + "." + top.cls : "?"}）`, placeErr: r3(placeErr) });
      goal = null; skipped++;
      continue;
    }

    const before = await evJson(exprBefore(goal.domain, goal.docId));
    const att = {
      n: evidence.attempts.length + 1, aim: goal, clicked: true,
      placeErr: r3(placeErr), proj: { x: r3(proj.x, 2), y: r3(proj.y, 2), cx: r3(proj.cx, 2), cy: r3(proj.cy, 2) },
      topElement: top,
      before: {
        pos: vec3(before.pos), quat: before.quat,
        anchorDist: r3(before.anchorDist),
        proj: before.proj ? { x: r3(before.proj.x, 2), y: r3(before.proj.y, 2) } : null,
        selection: before.selection, spin: r3(before.spin, 5),
      },
    };
    evidence.attempts.push(att);
    clicks++;

    if (WANT_PNG) {
      try {
        const png = await ev(`window.__three.snapshot(0.7)`);
        if (typeof png === "string" && png.startsWith("data:image/png")) {
          const p = resolve(ROOT, `shots/probe-focus-before-${STAMP}.png`);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, Buffer.from(png.split(",")[1], "base64"));
          att.pngBefore = p;
        }
      } catch (e) { att.pngBeforeError = String(e.message || e); }
    }

    // ---- 真实鼠标：直接按下/抬起，**不先 dispatch mouseMoved** ----
    // hover 拾取在 300 万点上要 0.3~0.5s，而星点随自转约 9px/s；多等 300ms 就多偏 3px。
    // pointerdown/up 不依赖 hover，所以省掉它能显著提高点击命中率。
    const x = r3(proj.cx, 2);
    const y = r3(proj.cy, 2);
    const tPress = Date.now();
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    const tDispatchAck = Date.now();
    att.click = { x, y, tPress, dispatchAckMs: tDispatchAck - tPress };

    const sample = await evJson(exprSampler(goal.domain, goal.docId));
    att.pickLatencyMs = tDispatchAck - tPress;
    const last = sample.out.length ? sample.out[sample.out.length - 1] : null;
    const matched = !sample.aborted && sample.out.some((s) => s.sel && s.sel.domain === goal.domain && s.sel.docId === goal.docId);
    att.matched = matched;
    att.sampleSummary = { aborted: sample.aborted, elapsed: sample.elapsed, frames: sample.frames, firstSel: sample.out[0] ? sample.out[0].sel : null, lastSel: last ? last.sel : null };
    att.sample = sample;

    if (matched) {
      evidence.success = { aim: goal, before, sample, click: att.click, pickLatencyMs: att.pickLatencyMs };
      break;
    }

    // 没命中：记录实际选中了谁；若选中了别的星 ⇒ 下一次就瞄它（像素遮挡的自我纠正）
    const obs = last ? last.sel : null;
    att.observedSelection = obs;
    if (obs) {
      // 注意：此时相机已经朝 obs 飞了 0.15~0.5s，所以这里**不能**用它当"点击那一刻的投影"；
      // 只用来记"点到了谁"，重瞄前会重新投影。
      log(`  点击 ${clicks}：瞄准 ${goal.domain}/${goal.docId} 未命中（${sample.aborted ? "选中了" : "选中了"} ${obs.domain}/${obs.docId}），改为瞄准它再点一次`);
      goal = { domain: obs.domain, docId: obs.docId, reaim: goal.reaim + 1, fromPool: false };
      if (goal.reaim > 6) goal = null;
    } else {
      log(`  点击 ${clicks}：瞄准 ${goal.domain}/${goal.docId} 点空（该像素没拾取到任何星），换下一颗候选`);
      goal = null;
    }
  }

  if (!evidence.success) {
    const clicked = evidence.attempts.filter((a) => a.clicked);
    const anySel = clicked.filter((a) => a.observedSelection).length;
    evidence.assertions.push({
      name: "① 点击命中瞄准的星（docId 一致）",
      ok: false,
      detail: `${clicked.length} 次真实点击中，${anySel} 次选中了别的星、${clicked.length - anySel} 次点空（跳过 ${skipped} 个不可点候选）`,
    });
    evidence.failureHint =
      "没有一次点击命中瞄准的 docId。若 attempts[].observedSelection 非空，说明**拾取→选中这条路是通的**，" +
      "只是 300 万点在 14px 半径内互相遮挡（或星点自转位移）导致像素归属漂移；" +
      "若全部点空，查 StarPicker 的 pointerup 拾取（src/three/StarPicker.tsx:62-81）与画布是否真的收到事件（attempts[].topElement）。";
    finish(1, "① 点击没选中");
  }

  const succ = evidence.success;
  const series = succ.sample.out;
  const final = series[series.length - 1];
  const before = succ.before;

  // 趁选中还在，把 store 里的 selection 原文（含 snapDistance）读出来 —— 后面 controlB 会清空它。
  let selNow = null;
  try {
    selNow = await evJson(`(() => { const s = window.__lunyun.getState().selection; return s ? JSON.stringify({ kind: s.kind, domain: s.domain, docId: s.docId, snapDistance: s.snapDistance, requestedDocId: s.requestedDocId, title: s.title }) : null; })()`);
  } catch { /* 忽略 */ }

  // --------------------------------------------------------------------------
  // 4. 对照组 B：清空选中 + 引力球外，再量 3 秒
  //    ⚠️ 顺序很重要：必须先 clearSelection 并等两帧，**再** placeCamera(FAR)。
  //    反过来先放远再清，FlyCamera 的锁定分支还活着，会把相机从 FAR 往星那边拉，
  //    实测"对照组起点"会变成 (-1.9, 1.9, 66.7) —— 那不是 FAR，读数就不可信了。
  // --------------------------------------------------------------------------
  try {
    await ev(EXPR_CLEAR);
    await ev(exprWaitFrames(2));
    await ev(exprPlace(FAR[0], FAR[1], FAR[2]));
    await ev(exprWaitFrames(2));
    const post = await evJson(exprControl(3000));
    const postBody = bodyContaining(post.fly.bodies, post.a.pos);
    evidence.controlB = {
      where: FAR, posBefore: vec3(post.a.pos), posAfter: vec3(post.b.pos),
      insideBody: postBody ? postBody.id : null,
      moved: r3(dist3(post.a.pos, post.b.pos)), durationMs: r3(post.b.t - post.a.t, 1),
      spinDelta: r3(post.b.spin - post.a.spin, 5),
      selectionAfterClear: post.selection,
    };
    log(`对照（清空选中 · 引力球外）：相机移动 ${evidence.controlB.moved} 世界单位（起点 ${vec3(post.a.pos)}）`);
  } catch (e) {
    evidence.controlB = { error: String((e && e.message) || e) };
  }

  // --------------------------------------------------------------------------
  // 5. 推导指标 + 断言
  // --------------------------------------------------------------------------
  const expectedLock = before.fly && before.fly.lockDist != null ? before.fly.lockDist : LOCK_DIST_SRC;
  const anchorSeries = series.map((s) => ({ t: s.t, d: s.anchorDist == null ? null : r3(s.anchorDist) })).filter((p) => p.d != null);
  const nearestMark = (m) => {
    let best = null;
    for (const s of series) if (!best || Math.abs(s.t - m) < Math.abs(best.t - m)) best = s;
    return best;
  };
  const pickMarks = [0.3, 0.5, 1, 2, 3, 4, 6, 8].map(nearestMark);
  const offsetBefore = centerOffset(before.proj);
  const offsetFinal = centerOffset(final.proj);
  const forward = quatForward(final.quat);
  const estAnchor = forward && final.pos && final.anchorDist != null
    ? [final.pos[0] + forward[0] * final.anchorDist, final.pos[1] + forward[1] * final.anchorDist, final.pos[2] + forward[2] * final.anchorDist]
    : null;
  const ft = succ.sample.focusTarget;
  const ftPosErr = ft && estAnchor ? dist3(ft.pos, estAnchor) : null;
  const movedWorld = dist3(before.pos, final.pos);
  const lockErr = final.anchorDist != null ? final.anchorDist - expectedLock : null;
  const centerPx = offsetFinal ? offsetFinal.px : null;
  const shortSide = final.proj ? Math.min(final.proj.w, final.proj.h) : null;
  const centerPct = centerPx != null && shortSide ? r3((100 * centerPx) / shortSide, 3) : null;
  const fps = series.length && succ.sample.elapsed ? r3(succ.sample.frames / Math.max(0.001, succ.sample.elapsed), 2) : null;
  const focusWritten = !!(ft && Array.isArray(ft.pos) && ft.at >= succ.click.tPress - 100);
  const focusDelayMs = ft ? ft.at - succ.click.tPress : null;
  /** 第一次进入 ±1.0 的时刻（按采样点）；若采样器已判"稳定"，优先用它的判定 */
  const conv = anchorSeries.find((p) => Math.abs(p.d - expectedLock) <= 1.0);
  const convergeAt = succ.sample.settled != null ? succ.sample.settled : conv ? conv.t : null;
  /** 环境漂移：用引力球内的公式预测（相机锁在星附近，通常仍在同一引力球内） */
  const ambBody = bodyContaining(before.fly.bodies, series[0].pos);
  const spinDelta = series.length && series[0].spin != null && final.spin != null ? final.spin - series[0].spin : null;
  const ambient = ambBody && spinDelta != null ? predictedCoRotation(ambBody, series[0].pos, spinDelta) : null;

  evidence.derived = {
    beforePos: vec3(before.pos), finalPos: vec3(final.pos), movedWorld: r3(movedWorld),
    beforeQuat: before.quat, finalQuat: final.quat,
    quatAngleDeg: quatAngleDeg(before.quat, final.quat),
    anchorDistBefore: r3(before.anchorDist),
    anchorDistSeries: anchorSeries,
    anchorDistAt: pickMarks.map((s) => (s ? { t: s.t, d: s.anchorDist == null ? null : r3(s.anchorDist), pos: vec3(s.pos), locked: s.locked } : null)),
    anchorDistFinal: r3(final.anchorDist),
    lockDist: expectedLock, lockDistSrc: LOCK_DIST_SRC, lockErr: r3(lockErr),
    lockDistFromFly: final.lockDist, flyLocked: final.locked,
    convergeAt, settledAt: succ.sample.settled,
    centerOffsetBeforePx: offsetBefore ? offsetBefore.px : null,
    centerOffsetPx: centerPx, centerOffsetPct: centerPct,
    finalProj: final.proj ? { x: final.proj.x, y: final.proj.y, w: final.proj.w, h: final.proj.h, inFront: final.proj.inFront } : null,
    focusTarget: ft, focusWritten, focusDelayMs, focusPosVsEstimate: r3(ftPosErr), estAnchor: vec3(estAnchor),
    fps, sampleFrames: succ.sample.frames, sampleElapsed: succ.sample.elapsed,
    pickLatencyMs: succ.pickLatencyMs,
    selectionDocId: final.sel ? final.sel.docId : null,
    selectionNow: selNow,
    selectionSnapDistance: selNow ? selNow.snapDistance : null,
    ambient: ambient ? { body: ambBody.id, rPerp: ambient.rPerp, chord: ambient.chord, windowSec: r3(final.t, 3), spinDelta: r3(spinDelta, 5) } : null,
  };
  evidence.derived.baselineSelection = before.selection;

  const A = [];
  const push = (name, ok, detail) => A.push({ name, ok: !!ok, detail });
  push(
    "① 点击命中瞄准的星（docId 一致）",
    !!final.sel && final.sel.domain === succ.aim.domain && final.sel.docId === succ.aim.docId,
    `selection=${final.sel ? final.sel.domain + "/" + final.sel.docId : "null"}，瞄准 ${succ.aim.domain}/${succ.aim.docId}；真实点击 ${clicks} 次（重瞄 ${succ.aim.reaim} 次），跳过 ${skipped} 个不可点候选`,
  );
  push(
    "② focusTarget 被写入（点击之后）",
    focusWritten,
    ft ? `写入时刻比按下鼠标晚 ${focusDelayMs}ms，pos=(${ft.pos.map((x) => r3(x)).join(", ")})，与"相机 + 视线×距离"估算相差 ${r3(ftPosErr)}` : "focusTarget 为空 —— FocusOnSelect 的 effect 没跑（src/three/FocusOnSelect.tsx:30-39）",
  );
  push("③ FlyCamera 进入锁定轨道（fly().locked）", final.locked === true, `fly().locked=${final.locked}，0.5s 时 locked=${(nearestMark(0.5) || {}).locked}`);
  push(
    "④ 相机真的移动（>1 世界单位，且远大于环境漂移）",
    movedWorld != null && movedWorld > 1 && (ambient == null || movedWorld > Math.max(1, 3 * ambient.chord)),
    `移动 ${r3(movedWorld)} 世界单位：(${vec3(before.pos)}) → (${vec3(final.pos)})；环境漂移预测 ${ambient ? ambient.chord : "无"}（${ambient ? ambBody.id + " 引力球内 " + r3(ambient.chord) + " 单位/" + r3(final.t, 2) + "s" : "不在引力球内"}）`,
  );
  push(
    `⑤ cameraAnchorDist 收敛到锁定距离 ${expectedLock}（终值 ±1.0）`,
    lockErr != null && Math.abs(lockErr) <= 1.0,
    `点击前 ${r3(before.anchorDist)} → 终值 ${r3(final.anchorDist)}（差 ${r3(lockErr)}），首次进入 ±1.0 于 ${convergeAt != null ? convergeAt + "s" : "未达到"}；序列 ${anchorSeries.map((p) => `${p.t}s=${p.d}`).join(" ")}`,
  );
  push(
    `⑥ 选中星居中（偏差 ≤${CENTER_PX_TOL}px 且 ≤${CENTER_PCT_TOL}% 短边）`,
    centerPx != null && centerPx <= CENTER_PX_TOL && centerPct != null && centerPct <= CENTER_PCT_TOL,
    `偏差 ${centerPx}px / ${centerPct}% 短边；点击前偏差 ${offsetBefore ? offsetBefore.px : "?"}px；投影 (${final.proj ? final.proj.x + ", " + final.proj.y : "?"}) vs 画布中心 (${final.proj ? final.proj.w / 2 + ", " + final.proj.h / 2 : "?"})`,
  );
  push(
    "⑦ 对照组：无选中时 3s 相机不动（引力球外，<0.5）",
    evidence.controlFar && evidence.controlFar.moved != null && evidence.controlFar.moved < CONTROL_MOVE_TOL,
    `引力球外移动 ${evidence.controlFar ? evidence.controlFar.moved : "?"} 世界单位 / ${evidence.controlFar ? evidence.controlFar.durationMs : "?"}ms；默认机位（引力球内）移动 ${evidence.controlDefault ? evidence.controlDefault.moved : "?"}（${evidence.controlDefault && evidence.controlDefault.explained ? "与引力协转公式相符" : "未能用协转解释"}）`,
  );
  push(
    "⑧ 对照组：清空选中后 3s 相机不动（引力球外，<0.5）",
    evidence.controlB && evidence.controlB.moved != null && evidence.controlB.moved < CONTROL_MOVE_TOL,
    `清空选中后移动 ${evidence.controlB ? evidence.controlB.moved : "?"} 世界单位 / ${evidence.controlB ? evidence.controlB.durationMs : "?"}ms，起点 (${evidence.controlB ? (evidence.controlB.posBefore || []).map((x) => r3(x)).join(", ") : "?"})`,
  );
  evidence.assertions.push(...A);

  if (A.some((x) => !x.ok)) {
    const stage = A.filter((x) => !x.ok).map((x) => x.name)[0];
    if (stage.startsWith("②")) evidence.failureHint = "focusTarget 没写入：查 FocusOnSelect.tsx:30-39（visible.includes / resolveAnchor 是否成功）。";
    else if (stage.startsWith("③")) evidence.failureHint = "FlyCamera 没进入锁定分支：查 FlyCamera.tsx:471 的条件与 useCloud 订阅刷新。";
    else if (stage.startsWith("④")) evidence.failureHint = "相机没动/动得比环境漂移还小：查 FlyCamera.tsx:494-495 的 lerp 目标。";
    else if (stage.startsWith("⑤")) evidence.failureHint = "距离没收敛到锁定值：查 FlyCamera.tsx:474-488 的 lk.dist 与 494-495 的阻尼（帧率低时 dt 封顶 0.1s，收敛按帧数算）。";
    else if (stage.startsWith("⑥")) evidence.failureHint = "距离对了但没居中：查 FlyCamera.tsx:496-500 的 lookAt/slerp。";
    else if (stage.startsWith("⑦") || stage.startsWith("⑧")) evidence.failureHint = "对照组没过：无选中时相机自己在动，看 controlFar/controlB 的 insideBody / fly().bodies。";
    finish(1, stage);
  }

  finish(0);
} catch (e) {
  evidence.error = { message: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 2000) };
  evidence.failureHint = "探针自身异常（不是判据失败），看 evidence.error / 浏览器 stderr";
  if (stderrTail) evidence.browserStderrTail = stderrTail.slice(-2000);
  console.error("✗ 探针异常：", e);
  try { finish(2, "探针异常"); } catch { process.exit(2); }
}
