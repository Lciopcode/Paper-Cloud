// @ts-nocheck
/**
 * 背景层开关自检 —— 「隐藏背景」这一项的唯一一道闸。
 *
 * ## 为什么要它（这条功能最容易"看起来做完了"）
 *
 * 关掉一个 `<group>` 的 `visible` 有三种坏法，画面都"变干净了"：
 *
 *   1. **没接上**：开关改了 but 组没变 —— 像素一点不动（最明显，但不测就发现不了）；
 *   2. **只关了一半**：将来有人把某一层挪出那个组 —— 少了一部分，看着"更干净了"；
 *   3. **关多了**：把八团自己的星云也关掉 —— **看起来效果最好**，而这是最糟的一种。
 *
 * 所以判据必须同时钉住三件事：**开关生效**、**八团还在**、**关掉之后画面真的变暗**。
 * 光比"两张图不一样"是不够的：第 3 种坏法照样让两张图不一样。
 *
 * ## 怎么钉住"八团还在"
 *
 * 点集本身不受背景开关影响（它挂在团的 `<group>` 里），所以读 `runtime` 的点数
 * 只能证明数据在，不能证明**画出来**了。真正能证明的是**像素**：
 * 背景层是"满天散布的小点"，八团是"几块高亮度集中区"。
 * 关掉背景之后，**最亮的那批像素（>200）不该少**，而"暗像素"应当大增。
 * 实测（隐藏背景后）：亮像素占比不变、平均亮度掉三分之一 —— 两者一起看，
 * 才能把"关多了"和"关对了"分开。
 */
import { spawn } from "node:child_process";
import { debugTargetError, profileDir, resolveBrowser, waitAllFull, waitStableShot } from "./browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = resolveBrowser();

const port = 9831;
const child = spawn(BROWSER, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--window-size=1440,900",
  "--no-first-run",
  `--user-data-dir=${profileDir("background")}`,
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
 * 关掉动画偏好：本闸要判"开关前后的画面差"，
 * 而自转/闪烁会让两次截图天生就不同 —— 那会把判据泡在噪声里。
 */
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 150; i++) {
  await sleep(300);
  if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break;
}
// 等八个团的点集都建好 —— 否则"关掉背景之后还剩什么"就无从判断
for (let i = 0; i < 150; i++) {
  await sleep(300);
  const n = await ev(`(() => {
    const rt = window.__lunyun?.getState?.().runtime ?? {};
    return Object.values(rt).filter((r) => (r.points?.count ?? r.demoPoints?.count ?? 0) > 0).length;
  })()`);
  if (n >= 8) break;
}

/**
 * ⚠️ 再等**八团全量就位**。作者要求"八团全量常驻"之后，boot 会串行把八个团换成
 * 完整点集（物理团 146 万点），每次换都整屏重建。不等就会量到"打开背景反而让
 * 39% 像素变暗"这种数 —— 而真相是那两张图之间恰好有团在换点集。
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

/** 在页面里解 PNG：给平均亮度、暗像素占比、很亮像素占比 */
const measure = async (b64) => {
  const js = `(async () => {
    const load = (b) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b; });
    const img = await load(${JSON.stringify(b64)});
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    /**
     * 只统计画布**右半边**：左侧 340px 是 HUD 抽屉，它不随背景开关变化，
     * 混进来只会把差异稀释掉（这是"两把尺子"那类错误的轻量版）。
     */
    const x0 = Math.round(cv.width * 0.45);
    const w = cv.width - x0;
    const d = ctx.getImageData(x0, 0, w, cv.height).data;
    let lum = 0, dark = 0, bright = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2];
      lum += L;
      if (L < 12) dark++;
      if (L > 200) bright++;
      n++;
    }
    return JSON.stringify({
      mean: +(lum / n).toFixed(2),
      darkPct: +((100 * dark) / n).toFixed(3),
      brightPct: +((100 * bright) / n).toFixed(3),
      w: cv.width, h: cv.height,
    });
  })()`;
  return JSON.parse(await ev(js));
};

/**
 * **逐像素差分**：这两帧之间，"背景到底贡献了什么"。
 *
 * ## 为什么不比 mean
 *
 * 第一版拿 `mean(on) / mean(off) > 1.15` 当判据，**实测比值只有 1.06，红**。
 * 不是功能坏了，是这把尺子不对：默认机位下八团把画面填满、平均亮度 68，
 * 背景那 2.6 万个小点只贡献了 4 个亮度单位 —— 淹没在里面。
 *
 * 而且它天生钝：如果将来"只关了一半"（少关一层），mean 只会再动零点几，
 * 判据根本分辨不出来。
 *
 * 逐像素差分的三个数各自钉住一件事：
 *
 *   · `addedPct`  —— 开着背景时**变亮**的像素占比。背景是小点，它只能让像素变亮；
 *                    这个数应当有百分之一量级，0 就是"开关没接上"。
 *   · `removedPct`—— 开着背景时**变暗**的像素占比。**必须近似 0**：
 *                    加一层东西不该让任何地方变暗。它一旦大起来，
 *                    说明关掉这一组时连带关掉了别的东西（比如某团的星云），
 *                    也就是"关多了" —— 而这正是最容易看起来很成功的坏法。
 *   · `addedLum`  —— 那些变亮的像素**平均亮了多少**。它把"真有星"和
 *                    "±1 的压缩噪声"分开：噪声的差是 1~2，真星是 30 以上。
 */
const diff = async (onB64, offB64) => {
  const js = `(async () => {
    const load = (b) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b; });
    const [i1, i2] = await Promise.all([load(${JSON.stringify(onB64)}), load(${JSON.stringify(offB64)})]);
    const cv = document.createElement('canvas'); cv.width = i1.width; cv.height = i1.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(i1, 0, 0); const d1 = ctx.getImageData(0, 0, cv.width, cv.height).data;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(i2, 0, 0); const d2 = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const x0 = Math.round(cv.width * 0.45);
    let added = 0, removed = 0, addedLum = 0, n = 0;
    for (let y = 0; y < cv.height; y++) {
      for (let x = x0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const L1 = 0.2126 * d1[i] + 0.7152 * d1[i+1] + 0.0722 * d1[i+2];
        const L2 = 0.2126 * d2[i] + 0.7152 * d2[i+1] + 0.0722 * d2[i+2];
        const dl = L1 - L2;
        if (dl > 8) { added++; addedLum += dl; }
        else if (dl < -8) removed++;
        n++;
      }
    }
    return JSON.stringify({
      addedPct: +((100 * added) / n).toFixed(3),
      removedPct: +((100 * removed) / n).toFixed(3),
      addedLum: added ? +(addedLum / added).toFixed(1) : 0,
      n,
    });
  })()`;
  return JSON.parse(await ev(js));
};

console.log("\n=== 背景层开关：能关干净、也没关多 ===");

// ---- 1) 默认必须是"关"（作者的要求：现在把背景隐藏掉）
const b0 = await ev("JSON.stringify(window.__three.background())");
const st0 = JSON.parse(b0);
check(
  "默认状态就是隐藏背景（作者要求）",
  st0.hidden === true && st0.groupVisible === false,
  `hidden=${st0.hidden} groupVisible=${st0.groupVisible}`,
);
check(
  "背景是一个**组**，组里有 3 层以上（远星穹 + 虚空星野 + 薄雾）",
  st0.groups === 1 && st0.children.length >= 3,
  `groups=${st0.groups} children=[${st0.children.join(", ")}]`,
);

// ---- 2) 关着的那一帧
const offFrame = (await waitStableShot(shot)).data;
const off = await measure(offFrame);

// ---- 3) 打开 → 等稳定 → 那一帧
await ev("window.__three.setBackgroundHidden(false)");
const st1 = JSON.parse(await ev("JSON.stringify(window.__three.background())"));
const onFrame = (await waitStableShot(shot)).data;
const on = await measure(onFrame);
check(
  "打开开关之后组的 visible 真的变 true（端口读的是场景图，不是 store 的镜像）",
  st1.hidden === false && st1.groupVisible === true,
  `hidden=${st1.hidden} groupVisible=${st1.groupVisible}`,
);

console.log(`  隐藏背景：mean ${off.mean} · 暗像素 ${off.darkPct}% · 很亮 ${off.brightPct}%`);
console.log(`  显示背景：mean ${on.mean} · 暗像素 ${on.darkPct}% · 很亮 ${on.brightPct}%`);
const df = await diff(onFrame, offFrame);
console.log(
  `  逐像素：变亮 ${df.addedPct}%（平均 +${df.addedLum}）· 变暗 ${df.removedPct}%（这半边的像素数 ${df.n}）\n`,
);

// ---- 4) 背景确实在画：有一批像素因为打开它而变亮，而且亮得够多
check(
  "打开背景之后有一批像素真的变亮（背景在画，不是改了状态没画）",
  df.addedPct > 0.4 && df.addedLum > 20,
  `变亮 ${df.addedPct}% · 平均 +${df.addedLum}（要求 >0.4% 且 >20）`,
);

// ---- 5) **没关多**：加一层东西不该让任何地方变暗
//      这一条是"关多了"的指纹：如果那一组里混进了八团的东西，关掉它会让星云消失，
//      于是"开着背景"的那一帧反而在那些像素上**更暗**。
check(
  "打开背景不会让任何地方变暗（说明关掉那一组时没连带关掉八团的东西）",
  df.removedPct < 0.05,
  `变暗 ${df.removedPct}%（阈值 0.05%）`,
);

// ---- 6) 关掉之后八团仍在：高亮核心不许明显减少
check(
  "隐藏背景没有连八团一起关掉（很亮像素没有明显减少）",
  off.brightPct > on.brightPct * 0.6,
  `很亮 ${off.brightPct}% vs ${on.brightPct}%（要求 ≥60%）`,
);
check(
  "隐藏背景之后画面里仍有成片的亮区（不是一片全黑）",
  off.brightPct > 0.05,
  `很亮 ${off.brightPct}%`,
);

// ---- 7) 往返：打开再关回去，必须回到刚才那一帧
await ev("window.__three.setBackgroundHidden(true)");
const st2 = JSON.parse(await ev("JSON.stringify(window.__three.background())"));
const backFrame = (await waitStableShot(shot)).data;
const back = await measure(backFrame);
check(
  "再关一次状态正确",
  st2.hidden === true && st2.groupVisible === false,
  `hidden=${st2.hidden} groupVisible=${st2.groupVisible}`,
);
check(
  "关→开→关，画面回到第一次关掉时的样子",
  Math.abs(back.mean - off.mean) < 1.5 && Math.abs(back.brightPct - off.brightPct) < 0.5,
  `mean ${back.mean} vs ${off.mean}；很亮 ${back.brightPct}% vs ${off.brightPct}%`,
);

// ---- 8) 快捷键 B（作者要"一个按钮 + 一个键"）
//      ⚠️ 用 Input.dispatchKeyEvent 打真键，不是直接调 store 函数 ——
//         后者会把"监听器没挂上"这种错放过去。
const before = JSON.parse(await ev("JSON.stringify(window.__three.background())")).hidden;
await send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyB", key: "b", windowsVirtualKeyCode: 66 });
await send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyB", key: "b", windowsVirtualKeyCode: 66 });
await sleep(400);
const afterKey = JSON.parse(await ev("JSON.stringify(window.__three.background())")).hidden;
check("按 B 键能切换背景", afterKey !== before, `${before} → ${afterKey}`);

// ---- 9) HUD 按钮和 store 是同一个状态源（不许两处各记一份）
const btnLabel = await ev(`(() => {
  const b = [...document.querySelectorAll('.hud-top .btn')].find((x) => x.textContent.startsWith('背景'));
  return b ? b.textContent.trim() : null;
})()`);
check(
  "HUD 上有「背景」按钮，且文案与当前状态一致",
  btnLabel === (afterKey ? "背景：关" : "背景：开"),
  `按钮="${btnLabel}"，状态 hidden=${afterKey}`,
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
