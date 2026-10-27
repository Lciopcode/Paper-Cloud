// @ts-nocheck
/**
 * 关系线自检：**生命周期（生长 / 保持 / 淡出）+ 沿线脉冲 + 端点淡出**。
 *
 * 对应目标 ⑤「连接线（生长/保持/淡出生命周期、自转、平面坐标系样式、赤道环）」里的前两项。
 * 从 `_scratch/probe-filaments.mjs` 提升上来，原因是它**已经被一次真实回归悄悄打坏过**，
 * 而坏掉时输出的是"三条判据失败"，看起来完全像产品坏了 —— 那种事必须由常驻自检兜住。
 *
 * ## ⚠️ 这个脚本里最贵的一条经验：**认对象只能靠显式标记**
 *
 * 它踩过两次同一个坑，两次都是"探针认错了对象"，而两次的症状都像产品 bug：
 *
 *   ① 关系线是**每个学科各挂一个**（八个实例），而选中的那篇只属于其中一个。
 *      第一版取遍历到的**最后一个**实例 ⇒ 量到别的团（uEnv 恒 0、drawRange 恒 0）
 *      ⇒ 结论"线根本没画出来"。修法：收集全部、取最大。
 *   ② 后来加了一层**常驻关系线场**（`FilamentField`），它复用同一套着色器、**同样有 `aT`**、
 *      也是 `<lineSegments>` ⇒ 它也匹配了"有 aT 就是关系线"这个过滤条件。
 *      它的 drawRange 是 2600×6 = **15600**（比选中扇形大），"取最大"就选中了它；
 *      而它的 `uEnv` **恒为 1**（常驻层不做生命周期）⇒ 三条判据全线失败，
 *      看起来像"取消选中后线不淡出"——**产品是对的**。
 *
 * 所以现在只用 `userData.layer === "filaments"` 认它（常驻那层是 `"field"`）。
 * **形状相近的两个对象，只能靠显式标记区分。**
 *
 * ## ⚠️ 脉冲不能用像素差来判
 *
 * 实测：只留 8 条线时，"脉冲停住"与"脉冲在动"两帧的像素差是 141k / 143k ——
 * 无头浏览器的合成噪声本底就有 5–14 万且不稳定。信号（8 条 1px 线上的小段高亮）
 * 低于噪声。**一条测不出它声称要测的东西的判据比没有更糟**，所以改判两件事：
 * `uTime` 在两种偏好下的行为，以及 `aT` 属性 / 片元着色器里的脉冲代码是否真的在。
 */
import { spawn } from "node:child_process";
import { debugTargetError, profileDir, resolveBrowser } from "./browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = resolveBrowser();

const port = 9819;
const child = spawn(BROWSER, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--window-size=1280,800",
  "--no-first-run",
  `--user-data-dir=${profileDir("fil")}`,
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
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result ?? m.error);
    pend.delete(m.id);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    errors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
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
/**
 * ⚠️ 一开始就要声明"减少动态效果"并**在声明后重载**：
 *    `uTime` 与自转都是在挂载时读这条偏好的，改偏好不会让已经跑起来的时钟停下来。
 */
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 150; i++) {
  await sleep(300);
  if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break;
}
await sleep(2500);

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fails++;
};

const lineInfo = async () =>
  JSON.parse(
    await ev(`(() => {
    const all = [];
    window.__lunyunDebug.scene.traverse((o) => {
      if (!o.isLineSegments) return;
      if (o.userData?.layer !== 'filaments') return; // ← 只认选中扇形，不认常驻线场
      const g = o.geometry;
      all.push({
        drawRange: g.drawRange.count,
        hasA: ['position','aCenter','aColor','aPhase','aSrc','aT'].every((k) => !!g.getAttribute(k)),
        uEnv: o.material.uniforms.uEnv ? o.material.uniforms.uEnv.value : null,
        uGrow: o.material.uniforms.uGrow ? o.material.uniforms.uGrow.value : null,
      });
    });
    if (!all.length) return JSON.stringify(null);
    const pick = (f) => all.reduce((a, b) => (f(b) > f(a) ? b : a));
    return JSON.stringify({ ...pick((x) => x.drawRange), instances: all.length });
  })()`),
  );

console.log("\n=== 关系线：生命周期 / 脉冲 / 端点淡出 ===");

const before = await lineInfo();
if (!before) {
  console.error("  ✗ 场景里找不到 userData.layer='filaments' 的线层");
  child.kill();
  process.exit(1);
}
check("线层几何体带齐了 6 个属性（含 aT）", before.hasA === true, `实例 ${before.instances} 个`);
check("未选中时不画线（drawRange 0）", before.drawRange === 0, `drawRange ${before.drawRange}`);

// 选一颗**确实有关系边、而且在当前点集里**的星（bridge 的 sampleSourceWithEdges 保证这两条）
await ev(`window.__lunyun.getState().loadFilaments('physics')`);
let docId = null;
for (let i = 0; i < 40 && docId === null; i++) {
  await sleep(500);
  docId = await ev(`window.__three.sampleSourceWithEdges('physics')`);
}
if (docId === null) {
  console.error("  ✗ 关系表没能在 20 秒内就绪");
  child.kill();
  process.exit(1);
}
console.log(`  → 选中 physics:${docId}（由 sampleSourceWithEdges 挑出，保证有边）`);
await ev(`window.__lunyun.getState().selectPaper('physics', ${docId})`);

// ---- 生长段
const samples = [];
for (const wait of [150, 450, 800]) {
  await sleep(wait);
  samples.push(await lineInfo());
}
const last = samples[samples.length - 1];
check("选中之后线层真的画出来了", last.drawRange > 0, `drawRange ${last.drawRange}（=${last.drawRange / 6} 条线 × 6 顶点）`);
const envs = samples.map((s) => Number(s.uEnv));
check("生命周期在推进（uEnv 单调升到 1）", envs[0] <= envs[1] && envs[1] <= envs[2], `uEnv ${envs.map((v) => v.toFixed(2)).join(" → ")}`);

await sleep(2500);
const held = await lineInfo();
check("保持段 uEnv = 1、uGrow = 1", held.uEnv === 1 && held.uGrow === 1, `env=${held.uEnv} grow=${held.uGrow}`);

/**
 * ---- 赤道环（目标 ⑤ 里"平面坐标系样式 / 赤道环"那一半）
 *
 * 它只在**选中时**才 `visible`，而以前从来没人量过它到底画没画出来 ——
 * 这和本会话里抓到的另外两个"声明了却不生效"的层（`wash` 不透明度恒 0、`dome` size 太小）
 * 是同一类风险。
 *
 * 好在它的形状是**可以精确判**的（`Filaments.tsx` 里那段写死的公式）：
 *   绕选中星、落在**赤道面**（y 恒定）、半径 `fan.ringR`、96 段。
 * 所以这里验五件事：在不在、可见不可见、是不是 96 段、**是不是正圆**、圆心是不是那颗星。
 */
const ring = JSON.parse(
  await ev(`(() => {
    let out = null;
    window.__lunyunDebug.scene.traverse((o) => {
      if (out || o.userData?.layer !== 'equator') return;
      const g = o.geometry;
      const attr = g.getAttribute('position');
      const p = attr.array;
      const n = attr.count;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += p[i*3]; cy += p[i*3+1]; cz += p[i*3+2]; }
      cx /= n; cy /= n; cz /= n;
      const rs = [], ys = [];
      for (let i = 0; i < n; i++) {
        rs.push(Math.hypot(p[i*3] - cx, p[i*3+2] - cz));
        ys.push(p[i*3+1]);
      }
      out = {
        visible: o.visible,
        n,
        rMin: Math.min(...rs), rMax: Math.max(...rs),
        ySpread: Math.max(...ys) - Math.min(...ys),
        center: [cx, cy, cz],
      };
    });
    return JSON.stringify(out);
  })()`),
);
if (!ring) {
  check("场景里有赤道环这一层（userData.layer='equator'）", false);
} else {
  check("选中时赤道环可见", ring.visible === true, `visible=${ring.visible}`);
  check("赤道环是 96 段（照诗云 buildEquatorRing）", ring.n === 96, `顶点 ${ring.n}`);
  check(
    "赤道环是正圆（所有顶点到质心等距）",
    ring.rMax - ring.rMin < 1e-4 && ring.rMax > 0.01,
    `半径 ${ring.rMin.toFixed(4)} ~ ${ring.rMax.toFixed(4)}`,
  );
  check("赤道环落在赤道面上（y 恒定）", ring.ySpread < 1e-4, `y 跨度 ${ring.ySpread.toExponential(2)}`);
  /**
   * 圆心必须**就是选中那颗星**的位置：否则环框住的是别处，"这颗星的关系范围"就指错了。
   *
   * ⚠️ store 里的字段是 `selection`（一个联合类型），**不是** `selectedPaper` ——
   *    第一版写错过，得到 `Cannot read properties of undefined (reading 'docId')`。
   *    取不到就直接判失败，不要让它变成"看起来只是没测"。
   */
  const starPos = JSON.parse(
    await ev(`(() => {
      const st = window.__lunyun.getState();
      const sel = st.selection;
      if (!sel || sel.kind !== 'paper') return JSON.stringify({ err: '没有 paper 选中态' });
      const pts = st.runtime[sel.domain].demoPoints || st.runtime[sel.domain].points;
      for (let i = 0; i < pts.count; i++) if (pts.docIds[i] === sel.docId) {
        return JSON.stringify({ pos: [pts.positions[i*3], pts.positions[i*3+1], pts.positions[i*3+2]] });
      }
      return JSON.stringify({ err: '选中那篇不在当前点集里' });
    })()`),
  );
  const dc = starPos.pos
    ? Math.hypot(ring.center[0] - starPos.pos[0], ring.center[1] - starPos.pos[1], ring.center[2] - starPos.pos[2])
    : Infinity;
  check("赤道环的圆心就是选中那颗星", dc < 1e-4, starPos.pos ? `圆心偏差 ${dc.toExponential(2)}` : starPos.err);
}

// ---- 脉冲：读 uniform 与结构，不靠像素差（理由见文件头）
const grabU = () =>
  ev(`(() => { let v = null; window.__lunyunDebug.scene.traverse((o) => { if (o.isLineSegments && o.userData?.layer === 'filaments') v = o.material.uniforms.uTime.value; }); return v; })()`);
const t1 = await grabU();
await sleep(420);
const t2 = await grabU();
check("减少动态效果下脉冲时钟停住（uTime 恒为 0）", Number(t1) === 0 && Number(t2) === 0, `uTime ${t1} → ${t2}`);

const pulseStruct = JSON.parse(
  await ev(`(() => {
    let out = null;
    window.__lunyunDebug.scene.traverse((o) => {
      if (out || !o.isLineSegments || o.userData?.layer !== 'filaments') return;
      const t = o.geometry.getAttribute('aT').array;
      const want = [0, 1/3, 1/3, 2/3, 2/3, 1];
      const n = Math.min(12, o.geometry.drawRange.count);
      let ok = true;
      for (let i = 0; i < n; i++) if (Math.abs(t[i] - want[i % 6]) > 1e-6) ok = false;
      out = {
        alternating: ok,
        first: Array.from(t.slice(0, 6)),
        hasPulse: /uTime/.test(o.material.fragmentShader),
        hasFade: /sin\\(3\\.14159265/.test(o.material.fragmentShader),
      };
    });
    return JSON.stringify(out);
  })()`),
);
check("aT 是每条线 6 顶点、0/⅓/⅔/1 的常量（端点淡出与脉冲都靠它）", pulseStruct?.alternating === true, JSON.stringify(pulseStruct?.first));
check("片元着色器里确实有端点淡出与沿线脉冲", pulseStruct?.hasPulse === true && pulseStruct?.hasFade === true);

// ---- 关掉"减少动态效果"，脉冲应当动起来（一正一反两个方向都量，才说明测的是脉冲本身）
//
// ⚠️ 同样不能"等一个固定时长"：改偏好 → store 的 `reducedMotion` 更新 → 组件重渲 →
//    `uTime` 才开始推进，这条链在 2~3 fps 下要走好几帧。固定等 600ms 时实测出现过
//    `uTime 0 → 0`（看起来像"脉冲坏了"，其实是还没轮到那一帧）。
//    所以改成**轮询到它开始动**为止，再判。
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
let n1 = 0;
let n2 = 0;
/** 最后一次读到的**原始** store 值（用来打日志；别把"标志位"当成它印出去） */
let reducedNow = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  reducedNow = await ev(`window.__lunyun.getState().reducedMotion`);
  // 偏好必须先传到 store（store 里 `reducedMotion === false` 才说明"动态已恢复"）
  if (reducedNow !== false) continue;
  n1 = Number(await grabU());
  await sleep(420);
  n2 = Number(await grabU());
  if (n2 > n1) break;
}
check(
  "正常动态下脉冲时钟在推进（uTime 递增）",
  n2 > n1,
  `store.reducedMotion=${reducedNow}（false 才对）· uTime ${n1} → ${n2}`,
);

// ---- 淡出段
//
// ⚠️ **不能"等一个固定时长再看"**：淡出是**按帧**推进的（`uEnv` 每帧减 `dt/FADE`），
//    而 SwiftShader 下 2~3 fps ⇒ 挂钟 2 秒只推进了零点几秒的动画。
//    实测固定等 2 秒时 `uEnv` 还剩 0.030（离阈值 0.02 差一点点）—— 那是**环境慢**，不是产品错。
//    所以改成**轮询到收敛**：一直等到 `uEnv < 0.02` 或超时，再判。
//    "淡出什么时候结束"本来就取决于帧率，判据该问的是"它最终会不会归零"。
await ev("window.__lunyun.getState().clearSelection()");
await sleep(200);
const o1 = await lineInfo();
const trace = [Number(o1.uEnv)];
let o3 = o1;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  o3 = await lineInfo();
  trace.push(Number(o3.uEnv));
  if (Number(o3.uEnv) < 0.02) break;
}
check(
  "取消选中后是淡出而不是瞬间清空（drawRange 保持、uEnv 递减）",
  o1.drawRange > 0 && Number(o1.uEnv) > 0 && Number(o3.uEnv) < Number(o1.uEnv),
  `env ${Number(o1.uEnv).toFixed(2)} → … → ${Number(o3.uEnv).toFixed(3)}（采样 ${trace.length} 次）`,
);
check("淡出结束后停止绘制", Number(o3.uEnv) < 0.02, `env=${Number(o3.uEnv).toFixed(3)}`);

/**
 * 赤道环也要跟着收起：它是"这次选中"的一部分，留在场上会让人以为还选中着。
 * 与线层不同的是它没有淡出（LineLoop 用的是普通材质），所以直接判 `visible`。
 */
const ringAfter = JSON.parse(
  await ev(`(() => {
    let out = null;
    window.__lunyunDebug.scene.traverse((o) => { if (out === null && o.userData?.layer === 'equator') out = o.visible; });
    return JSON.stringify(out);
  })()`),
);
check("取消选中后赤道环收起", ringAfter === false, `visible=${ringAfter}`);

if (errors.length) {
  console.log(`\n  console 错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 6)) console.log("    " + e);
  fails += errors.length;
}
console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
ws.close();
child.kill();
process.exit(fails === 0 ? 0 : 1);
