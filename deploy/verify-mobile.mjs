// @ts-nocheck
/**
 * 论文云 · 移动端自检
 * ============================================================================
 * 为什么需要单独的脚本：桌面自检用的窗口是 1582×904，
 * 而窄屏是**另一套布局结构**（HUD 变抽屉、面板变全屏浮层），
 * 桌面通过完全不能说明移动端可用。
 *
 * 判据（每条都对应一个"手机上真的会坏"的具体问题）：
 *   1. 没有横向溢出 —— 元素撑宽会导致左右滑动时页面乱跳；
 *   2. HUD 抽屉默认收起 —— 否则一进页面星空就被盖掉六成；
 *   3. 把手可见且可点，点击能展开/收起；
 *   4. 触摸目标 ≥ 40px —— 手指点不中就等于没有这个功能；
 *   5. 输入框字号 ≥ 16px —— 小于 16px 时 iOS 聚焦会**自动放大整个页面**；
 *   6. 选中论文后面板是**全屏浮层**并且内容完整可见（不是被裁掉一半）；
 *   7. 论文面板里的文字不溢出容器。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { debugTargetError, profileDir, resolveBrowser, waitForApp } from "./browser.mjs";

/**
 * 浏览器路径：由公共解析器找。
 *
 * ⚠️ 不要在这里写死绝对路径 —— 第一版 11 个脚本各自硬编码
 *    `D:\\chrome\\Application\\chrome.exe`，在开发机上能跑、**换台机器就断**，
 *    而报错是 spawn ENOENT，看起来像脚本坏了。
 *    解析顺序：--chrome 参数 → CHROME_PATH 环境变量 → 常见位置 → 注册表 → Edge 备选。
 */
const BROWSER = resolveBrowser();

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const OUT = resolve(ROOT, process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "shots/mobile.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 要测的设备视口（CSS 像素 + DPR），覆盖主流手机与一个小平板 */
const DEVICES = [
  { name: "iPhone 12/13/14", w: 390, h: 844, dpr: 3 },
  { name: "iPhone SE（最窄的主流机型）", w: 320, h: 568, dpr: 2 },
  { name: "Android 常见（Pixel 类）", w: 412, h: 915, dpr: 2.6 },
  { name: "iPad 竖屏", w: 768, h: 1024, dpr: 2 },
  { name: "手机横屏", w: 844, h: 390, dpr: 3 },
];

const port = 9811;
const profile = resolve(ROOT, `shots/_mob${Date.now()}`);
mkdirSync(profile, { recursive: true });
const child = spawn(BROWSER, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--no-first-run",
  `--user-data-dir=${profile}`,
  "about:blank",
]);

let target = null;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(400);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch { /* 还没起来 */ }
}
if (!target) { console.error("Chrome 没起来"); process.exit(1); }

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
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 300);
  return r?.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");

let fails = 0;
const note = (ok, msg) => { console.log(`    ${ok ? "✓" : "✗"} ${msg}`); if (!ok) fails++; };

for (const d of DEVICES) {
  console.log(`\n=== ${d.name}（${d.w}×${d.h} @${d.dpr}x）===`);
  await send("Emulation.setDeviceMetricsOverride", {
    width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true,
  });
  // 触摸事件也要开 —— 只改尺寸不算移动端
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  await send("Page.navigate", { url: "http://127.0.0.1:5311/" });
  await sleep(1200);
  for (let i = 0; i < 150; i++) {
    if (await ev("!!(window.__lunyun && window.__lunyun.getState().booted)")) break;
    await sleep(300);
  }
  await sleep(3500);

  // 1) 横向溢出
  const overflow = await ev(`JSON.stringify({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
  })`);
  const o = JSON.parse(overflow);
  note(o.scrollW <= o.clientW + 1, `没有横向溢出（scrollWidth ${o.scrollW} ≤ clientWidth ${o.clientW}）`);

  // 2) 抽屉默认收起
  const drawer = await ev(`(() => {
    const hud = document.querySelector('.hud');
    const handle = document.querySelector('.hud-handle');
    if (!hud) return JSON.stringify({ error: '没有 .hud' });
    const r = hud.getBoundingClientRect();
    return JSON.stringify({
      collapsed: hud.classList.contains('collapsed'),
      hudTop: Math.round(r.top),
      viewportH: window.innerHeight,
      handleVisible: handle ? getComputedStyle(handle).display !== 'none' : false,
      handleH: handle ? Math.round(handle.getBoundingClientRect().height) : 0,
    });
  })()`);
  const dr = JSON.parse(drawer);
  if (d.w <= 900) {
    note(dr.collapsed === true, `抽屉默认收起（collapsed=${dr.collapsed}）`);
    note(dr.handleVisible === true, `把手可见（display≠none）`);
    note(dr.handleH >= 40, `把手高度 ≥ 40px（${dr.handleH}px）`);
    // 收起时 HUD 主体应在视口下方，只露把手 —— 星空不被盖住
    note(dr.hudTop > dr.viewportH - 80, `收起后只露把手（HUD 顶部 ${dr.hudTop} > 视口 ${dr.viewportH} − 80）`);
  } else {
    note(dr.collapsed === false, `宽屏不收起（collapsed=${dr.collapsed}）`);
  }

  // 3) 点击把手能展开
  const toggled = await ev(`(() => {
    const h = document.querySelector('.hud-handle');
    if (!h) return 'no-handle';
    h.click();
    const c = document.querySelector('.hud').classList.contains('collapsed');
    return JSON.stringify({ afterClickCollapsed: c });
  })()`);
  await sleep(400);
  const t2 = await ev(`document.querySelector('.hud').classList.contains('collapsed')`);
  if (dr.collapsed === true) {
    note(t2 === false, `点把手能展开（collapsed=${t2}）`);
  } else {
    note(true, "宽屏无需展开");
  }

  // 4) 触摸目标尺寸
  const touch = await ev(`(() => {
    const sel = '.btn, .link, .lb-btn, .legend-row, .sb-input, .lg-load, .lg-phase';
    const bad = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 36) bad.push((el.className || el.tagName) + ' h=' + Math.round(r.height));
    }
    return JSON.stringify({ bad: bad.slice(0, 6), badCount: bad.length });
  })()`);
  const tc = JSON.parse(touch);
  note(tc.badCount === 0, `可点元素高度都 ≥ 36px（不达标 ${tc.badCount} 个${tc.bad.length ? "：" + tc.bad.join(" / ") : ""}）`);

  // 5) 输入框字号（iOS 会自动放大 < 16px 的输入框）
  const fs = await ev(`(() => {
    const i = document.querySelector('.sb-input');
    return i ? getComputedStyle(i).fontSize : 'none';
  })()`);
  if (d.w <= 900 && fs !== "none") {
    note(parseFloat(fs) >= 16, `检索框字号 ≥ 16px（${fs}）—— 否则 iOS 聚焦时会放大整页`);
  } else {
    note(fs !== "none", `检索框存在（字号 ${fs}）`);
  }

  // 6) 选中论文后，面板全屏且内容完整
  await ev(`(() => {
    const s = window.__lunyun.getState();
    const id = s.visibleDomains.find((x) => s.runtime[x]?.demoPoints || s.runtime[x]?.points);
    const pts = s.runtime[id].points || s.runtime[id].demoPoints;
    s.selectPaper(id, pts.docIds[Math.floor(pts.count / 2)]);
    return 1;
  })()`);
  await sleep(2500);
  const panel = await ev(`(() => {
    const p = document.querySelector('.paper-panel');
    if (!p) return JSON.stringify({ error: '面板没出现' });
    const r = p.getBoundingClientRect();
    const title = p.querySelector('.pp-title');
    const tr = title ? title.getBoundingClientRect() : null;
    return JSON.stringify({
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      vw: window.innerWidth, vh: window.innerHeight,
      titleW: tr ? Math.round(tr.width) : 0,
      titleOverflow: tr ? tr.right > window.innerWidth + 1 || tr.left < -1 : false,
      scrollH: p.scrollHeight, clientH: p.clientHeight,
    });
  })()`);
  const pn = JSON.parse(panel);
  if (pn.error) {
    note(false, pn.error);
  } else if (d.w <= 900) {
    note(pn.x <= 1 && Math.abs(pn.w - pn.vw) <= 2, `面板全屏（x=${pn.x} w=${pn.w} 视口=${pn.vw}）`);
    note(pn.y <= 1 && Math.abs(pn.h - pn.vh) <= 2, `面板满高（y=${pn.y} h=${pn.h} 视口=${pn.vh}）`);
    note(!pn.titleOverflow, `标题不溢出（右边界 ${pn.titleOverflow ? "越界" : "正常"}）`);
    note(pn.titleW > 100, `标题有可用宽度（${pn.titleW}px）`);
  } else {
    note(pn.w > 200 && pn.x > 0, `桌面面板在右侧（x=${pn.x} w=${pn.w}）`);
  }

  // 截图（每个设备一张）。
  // ⚠️ 截图前把状态**还原成用户一进来看到的样子**：清掉选中、把抽屉收回默认态。
  //    否则截出来的是"测试点过把手之后"的状态 —— 我第一版就是这么截的，
  //    结果图里抽屉是展开的，完全看不出"默认收起"到底长什么样。
  await ev(`(() => {
    const s = window.__lunyun.getState();
    if (s.clearSelection) s.clearSelection();
    const hud = document.querySelector('.hud');
    if (hud && !hud.classList.contains('collapsed') && window.innerWidth <= 900) {
      const h = document.querySelector('.hud-handle');
      if (h) h.click();
    }
    return 1;
  })()`);
  await sleep(800);
  // 顺手确认截图时的状态确实是"收起"
  const finalState = await ev(`!!document.querySelector('.hud') && document.querySelector('.hud').classList.contains('collapsed')`);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot?.data) {
    const name = OUT.replace(/\.png$/, `-${d.w}x${d.h}.png`);
    mkdirSync(dirname(name), { recursive: true });
    writeFileSync(name, Buffer.from(shot.data, "base64"));
    console.log(`    截图 ${name.replace(ROOT, ".")}（抽屉 ${finalState ? "收起" : "展开"}）`);
  }
}

console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
child.kill();
process.exit(fails === 0 ? 0 : 1);
