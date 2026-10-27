// @ts-nocheck
/**
 * 引用功能自检（作者要求的"点星 → 引用线 → 标题 + 中文译名 + 跳转"）。
 *
 * 分两段，**各自证明一件不同的事**：
 *
 *  A. **数据通路**（非浏览器）：直接按 `CitationTable` 的字节布局读
 *     `public/data/citations/<d>.bin` 与 `title-zh/<d>.bin`，断言
 *     magic / 边数 / 某篇的引用列表 / 译名是中文。
 *     这一段挡的是"文件格式或 Range 布局写错了"——那种错在浏览器里表现为
 *     "这个学科没有引用数据"，与"真的没数据"**长得一模一样**。
 *
 *  B. **渲染通路**（浏览器）：面板是否把 `citeRefs` 渲染成 N 行、是否显示中文译名、
 *     是否有跳转链接、空数据时是否显示"尚未抓到"而不是空白。
 *     这一段**注入受控输入**（`setState` 改 `citeRefs`）：要验的是渲染，
 *     不该被"这篇论文恰好有没有引用数据"这种事卡住。
 *     ⚠️ 注入是刻意的，且只在这一段；A 段用的是真实资产，不注入。
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { debugTargetError, profileDir, resolveBrowser, waitStableShot } from "./browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOMAIN = process.argv[2] ?? "physics";
const CSRB = `public/data/citations/${DOMAIN}.bin`;
const ZHB = `public/data/title-zh/${DOMAIN}.bin`;

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fails++;
};

console.log("\n=== A. 数据通路（直接读资产，不经浏览器）===");
let withRefs = [];
if (!existsSync(CSRB)) {
  check("引用表存在", false, CSRB);
} else {
  const buf = readFileSync(CSRB);
  const magic = buf.subarray(0, 8).toString("ascii");
  const count = buf.readUInt32LE(8);
  const edges = buf.readUInt32LE(12);
  check("引用表 magic 正确", magic === "LUNYREF1", magic);
  check("引用表有边", edges > 0, `count=${count} edges=${edges}`);
  for (let d = 0; d < count && withRefs.length < 400; d++) {
    const a = buf.readUInt32LE(28 + d * 4);
    const z = buf.readUInt32LE(28 + (d + 1) * 4);
    if (z > a) withRefs.push({ doc: d, from: a, to: z });
  }
  check("能扫到有引用的论文", withRefs.length > 0, `${withRefs.length} 篇`);
  if (withRefs.length) {
    const { doc, from, to } = withRefs[0];
    const dst = buf.readUInt32LE(28 + (count + 1) * 4 + from * 4);
    check("第一条边两端都是有效 docId", dst < count && dst !== doc, `docId ${doc} → ${dst}（共 ${to - from} 条）`);
  }
}
if (!existsSync(ZHB)) {
  check("译名表存在", false, ZHB);
} else {
  const zb = readFileSync(ZHB);
  const magic = zb.subarray(0, 8).toString("ascii");
  const zcount = zb.readUInt32LE(8);
  const blobBytes = zb.readUInt32LE(12);
  check("译名表 magic 正确", magic === "LUNYTIT1", magic);
  let zh = 0;
  let sample = "";
  for (let d = 0; d < zcount; d++) {
    const a = zb.readUInt32LE(16 + d * 4);
    const z = zb.readUInt32LE(16 + (d + 1) * 4);
    if (z > a) {
      zh++;
      if (!sample) sample = zb.subarray(16 + (zcount + 1) * 4 + a, 16 + (zcount + 1) * 4 + z).toString("utf8");
    }
  }
  check("译名表有译文", zh > 0, `${zh}/${zcount} 条，blob ${(blobBytes / 1024).toFixed(0)} KB`);
  check("译名确实是中文（含 CJK 字符）", /[\u4e00-\u9fff]/.test(sample), sample.slice(0, 40));
}

// ---------------------------------------------------------------- B. 渲染
const BROWSER = resolveBrowser();
const port = 9833;
const child = spawn(BROWSER, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--window-size=1440,900",
  "--no-first-run",
  `--user-data-dir=${profileDir("citations")}`,
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
  if (r?.exceptionDetails) return "ERR:" + (r.exceptionDetails.exception?.description ?? "").slice(0, 200);
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
  const n = await ev(`(() => { const rt = window.__lunyun?.getState?.().runtime ?? {};
    return Object.values(rt).filter((r) => (r.points?.count ?? r.demoPoints?.count ?? 0) > 0).length; })()`);
  if (n >= 8) break;
}

console.log("\n=== B. 渲染通路（浏览器）===");
// 先选中任意一颗星（面板才会出现），再把受控的引用数据注入进去
const picked = await ev(`(() => {
  const s = window.__lunyun.getState();
  const rt0 = s.runtime[${JSON.stringify(DOMAIN)}]; const pts = rt0?.points ?? rt0?.demoPoints;
  if (!pts) return null;
  for (let i = 0; i < pts.count; i += 7) {
    const d = pts.docIds[i];
    if (d > 0) { s.selectPaper(${JSON.stringify(DOMAIN)}, d); return d; }
  }
  return null;
})()`);
check("能选中一颗星并打开面板", typeof picked === "number", `docId=${picked}`);

/**
 * ⚠️ **必须先等 `loadCiteRefs` 落定再注入。**
 *
 * 第一版注入完立刻断言，结果面板 0 行 —— 不是渲染坏了，是**被覆盖了**：
 * `selectPaper` 之后 `Filaments` 的 effect 会发起一次真实的 `loadCiteRefs`，
 * 它拿到 `refsOf(docId) = []`（这篇确实没有引用），几百毫秒后写回 store，
 * 把我注入的 3 条冲掉了。
 *
 * 这正是"等固定时长再断言"那类错误的变体：这次不是等太久或太短的问题，
 * 而是**注入的对象后来被别人改了**。所以判据要问"我注入的值还在不在"，
 * 而不是"过一会儿面板该有 3 行"。先在源头等它落定。
 */
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const done = await ev(`(() => {
    const s = window.__lunyun.getState(); const sel = s.selection;
    if (!sel || sel.kind !== "paper") return false;
    const rt = s.runtime[sel.domain];
    return !!rt && rt.citeRefsLoading === false && rt.citeRefsDoc === sel.docId;
  })()`);
  if (done === true) break;
}
// 注入：本文引用 3 篇（其中 1 篇给了中文译名，1 篇带库外条目）
const injected = await ev(`(() => {
  const st = window.__lunyun.getState();
  const sel = st.selection;
  if (!sel || sel.kind !== "paper") return null;
  const rt = st.runtime[sel.domain];
  const ids = [3, 12, 34];
  window.__lunyun.setState({ runtime: { ...st.runtime, [sel.domain]: {
    ...rt, citeRefsDoc: sel.docId, citeRefs: ids, citeRefsLoading: false,
    citations: rt.citations ?? null,
    citeExt: [{ title: "A Paywalled Paper Nobody Can Read", year: 1999, doi: "10.1103/PhysRevLett.116.061102" }],
  } } });
  return sel.docId;
})()`);
check("注入受控引用数据成功", typeof injected === "number", `docId=${injected}`);
await sleep(1200);

const dom = await ev(`(() => {
  const rows = [...document.querySelectorAll('.pp-cites .pp-cite-row')];
  const ext = [...document.querySelectorAll('.pp-ext .pp-cite-row')];
  return {
    rows: rows.length,
    titles: rows.map((r) => (r.querySelector('.linklike')?.textContent ?? '').slice(0, 50)),
    links: rows.flatMap((r) => [...r.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')),
    extRows: ext.length,
    extLinks: ext.flatMap((r) => [...r.querySelectorAll('a')].map((a) => a.textContent ?? '')),
    label: document.querySelector('.pp-cites')?.closest('.pp-section')?.querySelector('.pp-label')?.textContent ?? '',
  };
})()`);
check("面板列出被引论文（条数 = 注入的 3）", dom?.rows === 3, `实际 ${dom?.rows} 行`);
check("每行都有标题", (dom?.titles ?? []).every((t) => t.length > 3), JSON.stringify((dom?.titles ?? []).slice(0, 2)));
check("库内被引的行有「学术」外链", (dom?.links ?? []).some((h) => h.includes("scholar.google.com")), (dom?.links ?? [])[0]?.slice(0, 50));
check("库外条目列出 DOI / 学术 / 知网 三个入口", (dom?.extRows ?? 0) === 1 && (dom?.extLinks ?? []).length >= 3, JSON.stringify(dom?.extLinks));
check("库外条目的 DOI 链接指向 doi.org", (await ev(`[...document.querySelectorAll('.pp-ext a')].some(a => (a.getAttribute('href')||'').startsWith('https://doi.org/'))`)) === true);
check("分组标题写明了在本库/在库外各几篇", /3 篇在本库/.test(dom?.label ?? "") && /1 篇在库外/.test(dom?.label ?? ""), dom?.label);

// 空数据态：把引用表置空，界面必须说"尚未抓到"，而不是空白
await ev(`(() => { const st = window.__lunyun.getState(); const sel = st.selection;
  const rt = st.runtime[sel.domain];
  window.__lunyun.setState({ runtime: { ...st.runtime, [sel.domain]: { ...rt, citations: null, citeRefs: null } } }); })()`);
await sleep(800);
const emptyText = await ev(`document.querySelector('.pp-section .muted.small')?.textContent ?? ''`);
check("没有引用表时如实说「尚未抓到」，且给出补数据命令", /尚未抓到/.test(emptyText) && /harvest-refs/.test(emptyText), emptyText.slice(0, 60));

mkdirSync("shots", { recursive: true });
const shot = (await waitStableShot(async () => (await send("Page.captureScreenshot", { format: "png" }))?.data ?? null)).data;
if (shot) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`shots/verify-citations.png`, Buffer.from(shot, "base64"));
  console.log("  截图 → shots/verify-citations.png");
}

console.log(`\n结论：${fails === 0 ? "✓ 全部通过" : `✗ ${fails} 项未通过`}`);
ws.close();
child.kill();
process.exit(fails === 0 ? 0 : 1);
