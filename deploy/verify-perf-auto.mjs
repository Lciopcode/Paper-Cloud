// @ts-nocheck
/**
 * 性能降级自检（P3-5）
 *
 * ⚠️ 判据的**顺序**很关键。第一版把"手动切画质"放在"自动降级"之前，
 *    结果自动降级在背后把画质改掉了，测手动切换时读到的值是错的 ——
 *    表现为"uMaxSize 两档都是 14"。那不是产品坏了，是**判据互相污染**。
 *    现在按"先让自动降级发生、再验证用户能接管"的真实使用顺序来测。
 *
 * 判据：
 *   1. 「载入全部」**真的加载全部**（这一条盯一个已修的 bug：按钮写着"全部"，
 *      实际被 12 万点的上限截断，只画了 11.2 万点）。
 *   2. 帧率偏低时**自动降级**触发，且界面如实告知、给出"仍然用高画质"的出口。
 *   3. 用户手动选过画质之后 **整个会话不再被自动改回去**（否则开关像坏的）。
 *   4. 低画质档**真的降负载**（点精灵像素上限 30px → 14px；比例 1.0 → 0.5）——
 *      原来的 1.0 → 0.8 实测帧率变化 **1.00 倍**，等于没有降级。
 *
 * ⚠️ 无头环境是 SwiftShader **软件渲染**，绝对帧率远低于真机独显。
 *    所以判据只断言"相对关系"与"状态机正确"，不断言绝对 fps。
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

const port = 9824;
const child = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--window-size=1280,800", "--no-first-run",
  `--user-data-dir=${profileDir("pa2")}`, "http://127.0.0.1:5311",
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
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 250);
  return r?.result?.value;
};
await send("Runtime.enable");
for (let i = 0; i < 150; i++) { if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break; await sleep(300); }
await sleep(5000);

let fails = 0;
const note = (ok, m) => { console.log(`  ${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const state = async () => JSON.parse(await ev(`JSON.stringify({
  q: window.__lunyun.getState().quality,
  auto: window.__lunyun.getState().perfAutoDegraded,
  chosen: window.__lunyun.getState().qualityUserChosen,
})`));
/** 从场景里读星点材质的 uniforms（只取带 uMaxSize 的那些 = StarLayer） */
const uni = async () => JSON.parse(await ev(`(() => {
  const b = window.__lunyunDebug; const out = [];
  b.scene.traverse((o) => {
    if (!o.isPoints) return;
    const u = o.material && o.material.uniforms;
    if (u && u.uMaxSize) out.push({ max: u.uMaxSize.value, scale: u.uScale.value });
  });
  return JSON.stringify({ n: out.length, max: out[0] ? out[0].max : null, scale: out[0] ? out[0].scale : null,
    allSame: out.every((x) => x.max === out[0].max) });
})()`));

/**
 * 按**图层名**数粒子数。
 *
 * 为什么要单独一条：`uMaxSize`/`uScale` 只说明"材质参数变了"，而**低画质档真正省的是粒子数**
 * （照诗云的分档：它 high/low 的 DUST 是 120k/42k）。纹理参数变了、粒子数没变，
 * 在弱机器上一样会卡 —— 那是"看着有降级、其实没省负载"的经典假动作。
 */
const layerCount = async (layer) =>
  Number(await ev(`(() => {
    let n = 0;
    window.__lunyunDebug.scene.traverse((o) => {
      if (o.userData && o.userData.layer === ${JSON.stringify(layer)} && o.geometry) {
        const p = o.geometry.getAttribute('position');
        if (p) n += p.count;
      }
    });
    return n;
  })()`));

// ---- 判据 1：载入全部 = 真的全部 ----
console.log("\n=== 判据 1：「载入全部」真的加载全部 ===");
const t0 = Date.now();
/**
 * 判据改成**等终态**，不再自己驱动 `loadFull`。
 *
 * 原来这里是 `await loadFull('physics')` —— 那时全量是用户点按钮才发生的。
 * 作者后来要求「每篇论文一个点、八团全量常驻」，`boot()` 里会自动串行加载全部团，
 * 于是自检再手动调一次就和那条自动链**并发**了：两个 `loadFull` 同时跑，
 * 自检读到的可能是还没写入 `points` 的空档 ⇒ `rt.points` undefined ⇒ 崩。
 *
 * 判据该问的是"最终会不会全都铺满"，所以改成轮询终态（这也是那条老规矩）。
 */
let load = null;
for (let i = 0; i < 240; i++) {
  await sleep(500);
  const raw = await ev(`(() => {
    const rt = window.__lunyun.getState().runtime.physics;
    if (!rt || !rt.points) return "";
    const d = window.__lunyun.getState().manifest.domains.find((x) => x.id === "physics");
    return JSON.stringify({ count: rt.points.count, truncated: rt.points.truncated,
      papers: d.papers, demo: rt.demoPoints.count, full: rt.full });
  })()`);
  if (raw) { load = JSON.parse(raw); break; }
}
if (!load) {
  console.error("  ✗ 120 秒内 physics 没有切到全量点集");
  process.exit(1);
}
console.log(`  ${load.count.toLocaleString()} 点 / ${load.papers.toLocaleString()} 篇（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，演示点集 ${load.demo.toLocaleString()}）`);
note(load.count === load.papers, `点数 == 论文数（${load.count.toLocaleString()}）`);
note(load.truncated === false, `truncated=false（没被点数上限截断）`);
/**
 * ⚠️ **这条判据原来写的是 `> 10`（写死的），密度提到"每 10 篇取 1"之后全量/演示正好 = 10 ⇒ 假失败。**
 *
 * 它想验的是"「载入全部」加载的**不是**演示那一份"，而**全量/演示的比值就等于抽样步长**
 * （演示 = 每 N 篇取 1 ⇒ 比值 ≈ N）。所以判据应该是"比值明显大于 1 且与步长一致"，
 * 而不是某个当时写下的数 —— 与 `uMaxSize` 那次（写死 30/14）是同一类错。
 * 这里取"≥ 10"作下界，并在输出里把比值打出来；步长再改时它只会更宽松、不会假红。
 */
note(
  load.count / load.demo > 9,
  `是演示点集的 ${(load.count / load.demo).toFixed(2)} 倍（≈ 抽样步长；演示数是 ceil(N/步长)，所以比值不会正好等于步长）`,
);

// ---- 判据 2：自动降级 ----
console.log("\n=== 判据 2：帧率偏低时自动降级（且如实告知）===");
const boot = await state();
console.log(`  载入前：${JSON.stringify(boot)}`);
console.log(`\n  载入后点精灵上限：${JSON.stringify(await uni())}`);
console.log("  等待自动降级（软件渲染下 146 万点约 0.3fps，阈值 12fps 必然触发）…");
let after = boot;
for (let i = 0; i < 45; i++) {
  await sleep(700);
  after = await state();
  if (after.auto) break;
}
console.log(`  等待后：${JSON.stringify(after)}`);
note(after.q === "low" && after.auto === true, `自动降到了低画质并打上标记（${after.q} / ${after.auto}）`);
const uiText = String(await ev("document.body.innerText"));
note(uiText.includes("已自动降到低画质"), `界面如实告知了（不是默默改掉）`);
note(uiText.includes("仍然用高画质"), `提供了"仍然用高画质"的出口（自动降级是建议不是强制）`);

// ---- 判据 3：用户手动选择不被覆盖 ----
console.log("\n=== 判据 3：用户手动选过之后不再被自动改回去 ===");
await ev("window.__lunyun.getState().setQualityManual('high')");
await sleep(600);
const justAfter = await state();
console.log(`  刚切换：${JSON.stringify(justAfter)}`);
note(justAfter.q === "high", `切到高画质成功（${justAfter.q}）`);
note(justAfter.chosen === true, `记下了"用户表过态"（chosen=${justAfter.chosen}）`);
console.log("  再等 6 秒，看会不会被自动降级覆盖（这是第一版的 bug：2 秒后就被改回去）…");
await sleep(6000);
const held = await state();
console.log(`  6 秒后：${JSON.stringify(held)}`);
note(held.q === "high" && held.auto === false, `仍然是高画质、没有被自动覆盖（${held.q} / ${held.auto}）`);

// ---- 判据 4：低画质真的降负载 ----
console.log("\n=== 判据 4：低画质档真的降负载 ===");
const hi = await uni();
console.log(`  高画质：${JSON.stringify(hi)}`);
/**
 * ⚠️ 粒子数必须在**切档之前**量一次、切档之后再量一次 ——
 * 这一层是 `useMemo(..., [quality])` 重建的，只在依赖变化时才重建；
 * 若哪天有人把 `quality` 从依赖里去掉，这条断言就会红（那正是它存在的意义）。
 */
const hiDust = await layerCount("voiddust");
const hiStars = await layerCount("stars");
await ev("window.__lunyun.getState().setQualityManual('low')");
await sleep(2000);
const lo = await uni();
console.log(`  低画质：${JSON.stringify(lo)}`);
const loDust = await layerCount("voiddust");
const loStars = await layerCount("stars");
console.log(`  虚空尘埃粒子数：${hiDust} → ${loDust}；论文星点粒子数：${hiStars} → ${loStars}`);
/**
 * ⚠️ 这里断言的是**关系**，不是那两个具体数字。
 *
 * 上一版写的是 `hi.max === 30 && lo.max === 14` —— 把"当时调出来的两个值"当成了规格。
 * 结果是：视觉迭代把点精灵上限从 30/14 改成 20/8（`b76f2e4`，照诗云重标定星星大小）之后，
 * 这条断言就变成了**假失败**：功能完全正常，数字过期了。
 * 判据要盯的是"低画质档**真的把负载降下来了**"这件事，所以改成：
 *   · 两档都在合理范围（4–40：再小就看不清星，再大就是纯烧填充率）；
 *   · 低画质的上限**明显更小**（< 高画质的 60%，否则省不下多少填充率）。
 * 这样以后再调视觉参数不会误报，而"低画质档失效"（比如两档写成同一个值）仍然抓得住。
 */
note(
  hi.max >= 4 && hi.max <= 40 && lo.max >= 4 && lo.max <= 40,
  `两档的像素上限都在合理范围（${hi.max} / ${lo.max}，应在 4–40）`,
);
note(lo.max < hi.max * 0.6, `像素上限真的降了（${hi.max} → ${lo.max}，降幅 ${(100 * (1 - lo.max / hi.max)).toFixed(0)}%）`);
note(hi.scale === 1 && lo.scale === 0.5, `尺寸系数真的降了（${hi.scale} → ${lo.scale}）`);
note(hi.allSame && lo.allSame, `全部星团的材质都跟着变（不是只改了一个）`);
/** 粒子数：装饰层砍得下去（诗云的分档是 35%），而**论文星点一颗都不能少** */
note(loDust > 0 && loDust < hiDust * 0.6, `低画质真的少画粒子（虚空尘埃 ${hiDust} → ${loDust}，降到 ${(100 * loDust / hiDust).toFixed(0)}%）`);
note(loStars === hiStars, `论文星点一颗都没少（${hiStars} → ${loStars}）—— 每一颗都是一篇论文，不能靠丢数据省性能`);

console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
child.kill();
process.exit(fails === 0 ? 0 : 1);
