// @ts-nocheck
/**
 * 星空尺寸标定自检 —— 目标 ② 的闸。
 *
 * ## 它要守的是什么
 *
 * 星点尺寸的公式是（`shaders.ts` 的 `STAR_VERT`）：
 *
 *   `gl_PointSize = clamp(aSize·bright·uScale·uSize·(130.0 / max(1,-z)), 0.6, uMaxSize)`
 *
 * 三个环节各自对应一条**必须成立**的性质：
 *
 *   · **`1/z` 衰减** —— 拉远之后星要变小。少了它，画面在拉远时像一张贴纸。
 *   · **下限 0.6** —— 作者的原话是「再小也不能压根不显示，得有亮度吧？」。
 *     这条**真的坏过一次**：曾经给 95% 的点乘了尺寸 ×0.5，默认机位下只剩 0.9~2.8 像素、
 *     单颗峰值 0.048，光栅化之后等于不存在 —— 而那 95% 就是论文本身。
 *     （详见 `STAR_VERT` 里那段"两种粒子已取消"的复盘。）
 *   · **上限 `uMaxSize`** —— 凑近时每颗星都顶到上限，画面就变成一团白云、结构全糊
 *     （64→20→14 就是这么压下来的）。
 *
 * ## 为什么在**低画质档**量
 *
 * 高档开着 bloom（`intensity 1.4`），它会给每个亮点晕出一圈**固定屏幕尺寸**的光晕 ——
 * 于是"点本身多大"被光晕盖住，量面积量不出尺寸标定。低画质档 `intensity = 0`
 * （`verify-bloom` 已经验证过它是真的不贡献），画面上剩下的**就是点本身**。
 * 代价是那一档的 `uMaxSize` 是 7 而不是 14 —— 但被验的是 `1/z` 这条**规律**与**下限**，
 * 两者跨档一致。
 *
 * ## 判据的形式：都写"最坏情况"，不写"当前值"
 *
 * 三个距离各量一次"星点层亮起来的像素占比"，然后要求：
 *   · **单调**：near > mid > far —— 这就是"尺寸真的随距离衰减"；
 *   · **远距离仍然看得见**：far 的占比要 > 一个下限 —— 这是"每一篇论文至少点亮一颗像素"；
 *   · **近距离不糊成一片**：near 的占比要 < 一个上限 —— 这是"上限在起作用"。
 *
 * ⚠️ 那几个比例是**围绕当前标定的回归护栏**，不是物理常数。
 *    改标定（130 / 0.6 / uMaxSize）时它们应该跟着重新标定 ——
 *    所以每条判据都把实测值印出来，方便下次一眼看出"是真坏了还是标定动了"。
 */
import { spawn } from "node:child_process";
import { debugTargetError, profileDir, resolveBrowser, waitStableShot } from "./browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = resolveBrowser();
/** `--calibrate`：只印数，不断言（改标定之后用它重新定阈值） */
const CALIBRATE = process.argv.includes("--calibrate");

const port = 9825;
const child = spawn(BROWSER, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--window-size=1440,900",
  "--no-first-run",
  `--user-data-dir=${profileDir("starsize")}`,
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
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.reload", { ignoreCache: false });
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
await sleep(3500);

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fails++;
};

// ---- 低画质档：bloom 贡献为 0，画面上的点尺寸就是真实尺寸
await ev(`window.__lunyun.getState().setQualityManual("low")`);
await sleep(3000);
const q = await ev(`window.__lunyun.getState().quality`);

// ---- 只留星点层（别的层会盖住它，量出来的不是星点自己的尺寸）
for (const l of ["voidstars", "voiddust", "nebula", "halo", "dome", "field", "wash"]) {
  await ev(`window.__three.setLayer(${JSON.stringify(l)}, false)`);
}
await sleep(600);

/** 拍一张（base64 PNG），给 `waitStableShot` 用 */
const shot = async () => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  return r?.data ?? null;
};

/**
 * **对给定的一帧**统计星点层的"亮起来"占比与平均亮度。
 *
 * ⚠️ 特意把它与"截图"拆开：`waitStableShot` 已经返回了**稳定之后的那一帧**，
 *    若这里再自己截一张，等于在稳定判定之外又开了一个竞态窗口 ——
 *    那正是这个改动想消灭的东西。
 */
const statsOf = async (b64) => {
  if (!b64) return null;
  const r = JSON.parse(
    await ev(`(async () => {
      const load = (b) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b; });
      const im = await load(${JSON.stringify(b64)});
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const n = cv.width * cv.height;
      let lit = 0, sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i+1], d[i+2]);
        if (mx > 40) lit++;
        sum += 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
      }
      return JSON.stringify({ lit: +(100*lit/n).toFixed(3), mean: +(sum/n).toFixed(2) });
    })()`),
  );
  return r;
};

/** 沿默认机位方向放相机（与 `_scratch/probe-dolly.mjs` 同一条方向，保证只改距离） */
const DIR = [-3.2, 11.2, 28.8];
const L0 = Math.hypot(...DIR);
/**
 * 把相机放到某个距离 → **等画面稳定** → 再统计。
 *
 * ⚠️ 原来是 `await sleep(1200)`。这个自检跑在 2~3 fps 的软件渲染上，
 *    1.2 秒只够 2~3 帧，而 `placeCamera` 之后要等下一帧才真正重画 ——
 *    机器一慢就可能截到**移动之前**那一帧，于是"拉远之后星点变小"这条判据会假红。
 *    改用 `waitStableShot`：连拍两张字节相同才认为画面已经反映新机位。
 */
const at = async (dist) => {
  const k = dist / L0;
  await ev(`window.__three.placeCamera(${DIR.map((v) => +(v * k).toFixed(4)).join(",")})`);
  const r = await waitStableShot(shot);
  if (!r.stable) console.log(`  ⚠️ 距离 ${dist} 处画面 15 秒内没有稳定 —— 下面的数不可信`);
  return statsOf(r.data);
};

console.log(`\n=== 星空尺寸标定（低画质档 ${q}，bloom 贡献 0，只留星点层）===`);
/**
 * ⚠️ **三个距离必须都是"在外面看整簇"**。
 *
 * 第一版取了 8 / 31 / 280，结果 `距离 8` 的亮起来占比（16.27%）**比 31（18.41%）还小** ——
 * 那不是尺寸标定坏了，是**取景变了**：距离 8 时相机已经在某一团**内部**，
 * 视野被几颗巨大的星填满，屏幕上星的数量本身就少了很多。
 * 拿"团内"和"团外"比面积占比，比的是构图，不是尺寸。
 *
 * 所以改成 31 / 90 / 280 —— 三个都是"整簇都在视野里"的机位，只差远近，才只差尺寸。
 */
const d1 = await at(31);
const d2 = await at(90);
const d3 = await at(280);
console.log(`  距离  31：亮起来 ${d1.lit}%  平均亮度 ${d1.mean}`);
console.log(`  距离  90：亮起来 ${d2.lit}%  平均亮度 ${d2.mean}`);
console.log(`  距离 280：亮起来 ${d3.lit}%  平均亮度 ${d3.mean}\n`);

/** 结构面：着色器里确实有下限与上限（改标定会让这里先红） */
const shader = await ev(`(() => {
  let src = null;
  window.__lunyunDebug.scene.traverse((o) => {
    if (src || o.userData?.layer !== 'stars' || !o.material?.vertexShader) return;
    src = o.material.vertexShader;
  });
  if (!src) return JSON.stringify(null);
  // ⚠️ 三条结构判据**只看 clamp 那一行**，不看整个源码 ——
  //    第一版扫的是全文，于是"把 0.6 去掉、但在注释里写了一句 0.6"就能骗过它（实测发生过）。
  //    **一条能被注释满足的结构判据等于没有。**
  const line = (src.match(/gl_PointSize\\s*=\\s*clamp[\\s\\S]*?;/) ?? [""])[0];
  return JSON.stringify({
    hasFloor: /,\\s*\\d+(\\.\\d+)?\\s*,/.test(line),
    hasCeil: /uMaxSize/.test(line),
    // ⚠️ 判据只看**公式形态**，不钉死常数：原来写死 130，尺寸常数改成 70 之后
    //    这一条立刻变红，而公式一点没坏。常数是标定值，会随密度/观感调整。
    hasInvZ: /\\d+\\.\\d+\\s*\\/\\s*max\\(\\s*1\\.0\\s*,\\s*-mv\\.z\\s*\\)/.test(line),
    // ⚠️ 必须匹配 clamp(...) 那一行：着色器里另有一句「aSize<0.001 时 gl_PointSize=0.0」的早退，
    //    第一版用 /gl_PointSize[^;]*;/ 匹配到的是它，印出来的公式是假的那一行。
    clampLine: (src.match(/gl_PointSize\\s*=\\s*clamp[\\s\\S]*?;/) ?? [""])[0].replace(/\\s+/g, " ").slice(0, 220),
  });
})()`);
const sh = JSON.parse(shader);
console.log(`  着色器：${sh ? sh.clampLine : "取不到"}`);
check("点尺寸公式里有 1/z 衰减（max(1, -mv.z)）", sh?.hasInvZ === true);
check("点尺寸有下限（跨驱动保险；**可见性由亮度决定，不是它**，见下面的实测）", sh?.hasFloor === true);
check("点尺寸有上限 uMaxSize（凑近不会糊成白云）", sh?.hasCeil === true);

if (CALIBRATE) {
  console.log(`\n（--calibrate 模式：只印数，不断言）`);
  console.log(JSON.stringify({ d31: d1, d90: d2, d280: d3 }));
  ws.close();
  child.kill();
  process.exit(0);
}

/**
 * ⚠️ 下面三个比例是**围绕当前标定的回归护栏**，不是物理常数。
 *    它们保证的是"三件事各自还成立"，不是"像素数必须等于某个值"：
 *      · 拉远必须变小   → near > mid > far
 *      · 远距离仍可见   → far.lit > 0.5%   （≈ 每篇论文还有像素被点亮）
 *      · 凑近不糊成板   → near.lit < 75%   （上限把点压住了）
 */
check(
  "拉远之后星点真的变小（1/z 衰减生效）",
  d1.lit > d2.lit && d2.lit > d3.lit,
  `${d1.lit}% > ${d2.lit}% > ${d3.lit}%（31 → 90 → 280）`,
);
check(
  "拉到极远时星点仍然可见（靠的是亮度不是尺寸 —— 实测把下限去掉这个数一点没变）",
  d3.lit > 0.5,
  `280 处亮起来 ${d3.lit}%`,
);
check("默认取景下星点没有糊成一片（上限在起作用）", d1.lit < 75, `31 处亮起来 ${d1.lit}%`);

/**
 * ⚠️ **这一条才是"看得见"的真正保证 —— 而且它不是尺寸，是亮度。**
 *
 * 实测（本轮）：把尺寸下限 `0.6` 改成 `0.0`、重新构建再量，
 * 拉到极远时"亮起来"的占比**一点没变**（3.397% → 3.394%）——
 * 因为 WebGL 对小于 1 像素的点仍然光栅化出 1 个片元。**尺寸下限不是可见性保证。**
 *
 * 而历史上真正让 95% 的论文消失的，是**尺寸 ×0.5 与亮度 ×0.22 一起**：
 * 单颗峰值掉到 0.048，那个像素低于任何可见阈值。**杀手是亮度那一半。**
 *
 * 所以这里给星点层的平均亮度兜一个下限 —— 它是"整层还看得见"的直接判据。
 * 阈值 8 是围绕当前 24.77 定的：历史那次 0.22× 会把它压到 ~5.4 ⇒ 变红。
 */
check(
  "星点层在默认取景下够亮（不是一片看不见的哑点）",
  d1.mean > 8,
  `31 处平均亮度 ${d1.mean}（阈值 8；历史 bug 的 0.22× 会压到 ~5.4）`,
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
