// @ts-nocheck
/**
 * 后期（Bloom）自检 —— 目标 ③ 的唯一一道闸。
 *
 * ## 为什么这一条最该补
 *
 * 七个目标里只有 ③ **完全没有自检**，而本项目最贵的一个 bug 恰好长在这里：
 *
 * > **点「仍然用高画质」拿不回辉光**（`EffectComposer` 的 `enabled` 从 true→false→true
 * > 之后不再接管渲染循环）。表现是"几何、uniform、store 状态逐项相同，画面却暗了 17.5 的 mean、
 * > 过曝少 3.3 倍"，**不报任何错**。它在没人量的情况下活了整整一轮，
 * > 还把作者挑档用的那张扫描表整张污染成了"没有辉光"的数。
 *
 * ## 判据怎么设计（都是"行为"而不是"读配置"）
 *
 * 1. **高画质档真的有辉光**：高/低两档的过曝像素占比要差得开（bloom 会把亮点晕开）。
 *    只读 `quality === "high"` 这个布尔量没用 —— 它一直是 high。
 * 2. **画质档往返一次，画面必须回到原样**：`high → low → high`，第三张与第一张
 *    逐像素比，平均绝对差要 < 1.5。**这一条就是这个回归的指纹**：
 *    坏的时候实测差 **17.5**（而且不是局部，是整块画布），好的时候差 **≈0**。
 * 3. **低画质档真的更省**：粒子数降下来（点精灵上限、尘埃数量）—— 这一半由
 *    `verify-perf-auto` 覆盖，这里只顺带记一笔，不重复判。
 *
 * ## 为什么像素比要放在页面里做
 *
 * `deploy/` 下的脚本不该依赖 `_scratch/`（那里不进 git）。所以两张截图都以 base64
 * 传回页面，用 `Image` + `canvas2d` 解出像素再比 —— 这套写法 `_scratch/probe-filaments.mjs`
 * 已经在用。信号量级是 17.5 vs <1.5，合成噪声（1e-2 级）完全淹不掉。
 */
import { spawn } from "node:child_process";
import { debugTargetError, profileDir, resolveBrowser, waitAllFull, waitStableShot } from "./browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = resolveBrowser();

const port = 9822;
const child = spawn(BROWSER, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--window-size=1440,900",
  "--no-first-run",
  `--user-data-dir=${profileDir("bloom")}`,
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
 * 固定"减少动态效果"：闪烁与自转会让两帧天生不同，而这里要判的是**后期**是否一致。
 * 声明后必须重载 —— 这条偏好是挂载时读的。
 */
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 150; i++) {
  await sleep(300);
  if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break;
}
// 等八个团的点集都建好，否则截到的还是空场景
for (let i = 0; i < 150; i++) {
  await sleep(300);
  const n = await ev(`(() => {
    const rt = window.__lunyun?.getState?.().runtime ?? {};
    return Object.values(rt).filter((r) => (r.points?.count ?? r.demoPoints?.count ?? 0) > 0).length;
  })()`);
  if (n >= 8) break;
}
/**
 * ⚠️ 先等八团全量就位再量。不等的话会在"加载风暴"里截图 ——
 * 两张图之间恰好有团在换完整点集，于是"往返差"从 0 跳到 17.282
 * （而 17.5 正是历史上"辉光丢失"那个真 bug 的指纹，差点被误判成回归）。
 */
const allFull = await waitAllFull(ev);
if (!allFull) console.log("  ⚠️ 180 秒内八团没有全部切到全量 —— 下面的数不可信");
await sleep(1200);

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fails++;
};

const shot = async () => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  return r?.data ?? null;
};

/**
 * 在页面里解两张 PNG 并给三个数：平均绝对差、各自的过曝占比、各自的平均亮度。
 *
 * ⚠️ 解出来的像素是**整页**（含 HUD）。HUD 是静态的，在 A/C 的差里会**互相抵消**，
 *    所以"往返差"这条判据不受它影响；而过曝占比是被它稀释过的 ——
 *    这里只做**高/低两档的相对比较**，不做绝对值判据。
 */
const compare = async (a, b) => {
  const js = `(async () => {
    const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64; });
    const [i1, i2] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
    const cv = document.createElement('canvas'); cv.width = i1.width; cv.height = i1.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(i1, 0, 0); const d1 = ctx.getImageData(0, 0, cv.width, cv.height).data;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(i2, 0, 0); const d2 = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const n = cv.width * cv.height;
    let sumAbs = 0, blown1 = 0, blown2 = 0, lum1 = 0, lum2 = 0;
    for (let i = 0; i < d1.length; i += 4) {
      const r1 = d1[i], g1 = d1[i+1], b1 = d1[i+2];
      const r2 = d2[i], g2 = d2[i+1], b2 = d2[i+2];
      sumAbs += Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
      if (Math.max(r1, g1, b1) > 250) blown1++;
      if (Math.max(r2, g2, b2) > 250) blown2++;
      lum1 += 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
      lum2 += 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
    }
    return JSON.stringify({
      meanAbsDiff: +(sumAbs / (n * 3)).toFixed(3),
      blown1: +((100 * blown1) / n).toFixed(3),
      blown2: +((100 * blown2) / n).toFixed(3),
      mean1: +(lum1 / n).toFixed(2),
      mean2: +(lum2 / n).toFixed(2),
      w: cv.width, h: cv.height,
    });
  })()`;
  const r = JSON.parse(await ev(js));
  return r;
};

/**
 * 切画质档 → **等画面真的稳定下来** → 返回那一帧。
 *
 * ⚠️ 原来是 `await sleep(3000)` 一刀切。切档会重建几何体（尘埃 12 万↔4.5 万、
 *    星野 2.6 万↔1 万），机器一慢 3 秒就不够，于是截到半截画面 ——
 *    而本脚本的判据是"往返之后画面要和第一次逐像素相同"，
 *    截在半截就会**在正确的代码上红**。**会假阳性的回归闸比没有闸更糟。**
 *    所以改用 `waitStableShot`：连拍两张字节相同才算稳。
 */
const setQ = async (q) => {
  await ev(`window.__lunyun.getState().setQualityManual(${JSON.stringify(q)})`);
  const r = await waitStableShot(shot);
  if (!r.stable) console.log(`  ⚠️ 切到 ${q} 之后画面 15 秒内没有稳定（连拍 ${r.tries} 次）—— 下面的比较不可信`);
  return { quality: await ev(`window.__lunyun.getState().quality`), frame: r.data };
};

console.log("\n=== 后期（Bloom）：高画质真的有辉光 + 画质档往返不改变画面 ===");

// `setQ` 已经把"稳定之后的那一帧"一起返回了，不必再截一次（少一次竞态窗口）
const h1 = await setQ("high");
const A = h1.frame;
const l1 = await setQ("low");
const B = l1.frame;
const h2 = await setQ("high");
const C = h2.frame;
const qh = h1.quality;
const ql = l1.quality;
const qh2 = h2.quality;

if (!A || !B || !C) {
  console.error("  ✗ 截图失败");
  child.kill();
  process.exit(1);
}

const AB = await compare(A, B);
const AC = await compare(A, C);
console.log(
  `  高 ${qh}：mean ${AB.mean1} · 过曝 ${AB.blown1}%   低 ${ql}：mean ${AB.mean2} · 过曝 ${AB.blown2}%   再切回 ${qh2}`,
);
console.log(`  高↔低 平均绝对差 ${AB.meanAbsDiff}（应变大）   高↔高 平均绝对差 ${AC.meanAbsDiff}（应≈0）\n`);

// 1) store 的档位确实切过去了（这不是"后期生效"的证据，只是前置条件）
check("画质档切换真的生效（high → low → high）", qh === "high" && ql === "low" && qh2 === "high", `${qh} / ${ql} / ${qh2}`);

// 2) **高画质档真的有辉光**：过曝占比要明显高于低画质档。
//    bloom 把离散亮点晕开 ⇒ 过曝像素变多；低档 `intensity = 0` ⇒ 没有这一步。
check(
  "高画质档的辉光确实生效（过曝占比明显高于低档）",
  AB.blown1 > AB.blown2 * 1.25 && AB.blown1 - AB.blown2 > 0.2,
  `过曝 ${AB.blown1}% vs ${AB.blown2}%（比值 ${(AB.blown1 / Math.max(0.001, AB.blown2)).toFixed(2)}）`,
);

// 3) **回归指纹**：往返一次之后画面必须回到原样。
//    坏的时候实测差 17.5（整块画布都变），好的时候 ≈0 —— 阈值 1.5 把两者干净分开。
check(
  "画质档往返之后画面回到原样（不会丢掉辉光）",
  AC.meanAbsDiff < 1.5,
  `高↔高 平均绝对差 ${AC.meanAbsDiff}（阈值 1.5；这个 bug 犯的时候是 17.5）`,
);

// 4) 反证：高↔高的差必须**远小于**高↔低，否则上一条的"≈0"可能是两帧都没画东西
check(
  "高↔高 的差远小于 高↔低（说明上一条的'≈0'是真的一致，不是两张空图）",
  AC.meanAbsDiff * 5 < AB.meanAbsDiff,
  `${AC.meanAbsDiff} × 5 < ${AB.meanAbsDiff}`,
);

if (errors.length) {
  console.log(`\n  console 错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 6)) console.log("    " + e);
  fails += errors.length;
}
console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
ws.close();
child.kill();
process.exit(fails === 0 ? 0 : 1);
