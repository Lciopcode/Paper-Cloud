/**
 * 论文云 · **BYOK（用户自带 key）+「数据源」面板 验收探针**
 * ============================================================================
 * 一次跑完 task-7 的 10 条验收，并落盘数字/文本/截图证据：
 *
 *   ① 打开页面（等 8 学科 ready/demo）→ 点 HUD `[data-testid=open-source-panel]`
 *      → `[data-testid=source-panel]` 出现，输入框/测试按钮/状态行/开关/清除按钮齐全；
 *   ② `/api/sources`：corpus/s2/openalex 三项齐全；`s2.builtin===true`（.env.local 有内置 key）、
 *      `openalex.builtin===false`；响应文本里**不出现**任何 key；
 *   ③ 把假 key（`probe-fake-s2-key-<时间戳>`）打进 S2 输入框 → `localStorage["lunyun.s2Key"]`
 *      立刻等于它（store → localStorage 链路）；
 *   ④ 点 `test-s2` → `[data-testid=key-status-s2]` 出结论（≤20s）：必须含「你的 key」且
 *      状态为失败/限流（假 key ⇒ HTTP 403）；并与 Node 侧同请求头的原始 JSON 互证；
 *   ⑤ 刷新页面再开面板：输入框 value 仍是假 key（localStorage 持久化）；
 *   ⑥ 不填 OpenAlex key → `test-openalex` 走匿名（≤35s）：状态行含「匿名」且有明确结论
 *      （可用 / 限流 / 失败都如实记录）；
 *   ⑦ 关面板 → `source-panel` 消失；再开 → `clear-keys` → `lunyun.s2Key` 被移除、输入框空；
 *   ⑧ 服务端不回显：对 `/api/refs?domain=physics&doc=4&mode=cites` 带假 key 请求头
 *      （该 doc 已有缓存，秒回）→ 响应 JSON 含 `auth.s2==="user"`，且**整个响应文本**里
 *      不含假 key、也不含 .env.local 里的内置 key；`/api/sources`、`/api/key-check` 同样检查；
 *   ⑨ 实时引用端到端：localStorage["lunyun.allowLiveRefs"]="1" → 刷新 → 用
 *      __three.visibleSample + projectAnchor 选一颗 **math（或 bio/eess）** 的可见星
 *      （坐标处 elementFromPoint 必须是 CANVAS，HUD 会挡）→ CDP 真实鼠标点击 →
 *      轮询 __lunyun.getState().runtime[domain]，等 citeRefsDoc===docId && !citeRefsLoading
 *      && citeSource（≤120s，首次要建该学科编号索引）→ 记录 citeSource、citeRefs /
 *      citeExt 条数、用时，并检查论文面板 [data-testid=cite-source] 文本含「数据源」；
 *   ⑩ `Page.captureScreenshot` 存 `shots/source-panel.png`（面板打开 + S2 结论可见）；
 *      全部读数写 `shots/probe-source-keys-<时间戳>.json`，控制台打印 PASS/FAIL 汇总。
 *
 * ----------------------------------------------------------------------------
 * ## 判定口径（写死，避免"看起来过了"）
 *
 *   · **假 key 失败是预期**：第 ④ 条验的不是"key 能用"，而是"**确实用了用户的 key**，
 *     并且失败原因如实显示"。服务端已手工验证：假 key ⇒ `using:"user"`、`httpStatus:403`、
 *     `status:"error"`。所以 UI 结论行必须同时出现「你的 key」与「失败/限流」。
 *   · 第 ⑥ 条匿名 OpenAlex 可能 200 也可能 429 —— 两种都算"有明确结论"，
 *     只要状态行给出档位（匿名）+ 三档之一（可用/限流/失败）。
 *   · 第 ⑨ 条是**唯一会等十几秒**的一步（服务端首次建某学科的 arXiv 编号索引，10–60s）。
 *     超时（默认 120s）就如实记录 `citeRefsLoading` / `citeSource` / `citeRefs` 当前值，
 *     绝不伪造成 PASS。选星时主动避开 `data/refs-cache/<domain>/` 里已有缓存的 docId，
 *     保证这一条是真的走了一次"取 → 映射 → 回填"的实时链路。
 *   · 第 ⑧ 条的内置 key 值从仓库 `.env.local` 读入，**只用于 `String.includes` 断言**，
 *     既不打印也不写进证据 JSON（JSON 里只有 key 名与长度）。
 *   · 清理：结束时清掉本探针写进 localStorage 的 key/开关，`localStorage.clear()` 后刷新一次，
 *     再 kill 浏览器、删掉本次专用的 profile 目录，避免污染后续人工演示。
 *
 * ## 用法
 *
 *   node deploy/probe-source-keys.mjs                    # 全量（含第 9 条实时引用）
 *   node deploy/probe-source-keys.mjs --skip-live        # 跳过第 9 条（不触发建索引）
 *   node deploy/probe-source-keys.mjs --url http://127.0.0.1:5311 --port 9717
 *   node deploy/probe-source-keys.mjs --out shots/xxx.json --shot shots/xxx.png
 *
 * 约束：只新增本文件 + 写 `shots/` 产物；不改 `src/`、不改 `deploy/` 其它文件、
 * 不 build、不重启 5311、不 git commit / git add。
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { debugTargetError, headlessArgs, profileDir, resolveBrowser } from "./browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const URL_ = argVal("--url", "http://127.0.0.1:5311");
const PORT = Number(argVal("--port", "9717"));
const SKIP_LIVE = has("--skip-live");
const LIVE_TIMEOUT = Number(argVal("--live-timeout", "120000"));
/** 时间戳（本地 ISO，去掉冒号/点，Windows 文件名安全） */
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = argVal("--out", `shots/probe-source-keys-${STAMP}.json`);
const SHOT = argVal("--shot", "shots/source-panel.png");
const LIVE_SHOT = argVal("--live-shot", "shots/source-live-refs.png");
/** 假 S2 key：每轮唯一，既用来验"确实用了用户 key"，也用来验"服务端不回显" */
const FAKE = `probe-fake-s2-key-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
/** `data-testid` → CSS 选择器字面量 */
const sel = (id) => `[data-testid="${id}"]`;

/* ============================================================================
 * 0. `.env.local` 里的内置 key —— 只读长度/布尔，**绝不打印、绝不落盘**
 * ========================================================================== */
function readEnvLocal() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* 没有 .env.local 也能跑：只是少了"不回显内置 key"这条断言的目标 */
  }
  return out;
}
const ENV = readEnvLocal();
const BUILTIN_SECRETS = [
  ["S2_API_KEY", String(ENV.S2_API_KEY ?? "").trim()],
  ["OPENALEX_API_KEY", String(ENV.OPENALEX_API_KEY ?? "").trim()],
  ["OPENALEX_MAILTO", String(ENV.OPENALEX_MAILTO ?? "").trim()],
].filter(([, v]) => v.length >= 8);
/** 响应文本里出现了哪些内置凭据（**只回名字**） */
function leakedBuiltinKeys(text) {
  const s = String(text ?? "");
  return BUILTIN_SECRETS.filter(([, v]) => s.includes(v)).map(([n]) => n);
}

/* ============================================================================
 * 1. 证据骨架 + 辅助函数
 * ========================================================================== */
const report = {
  at: new Date().toISOString(),
  url: URL_,
  fakeKey: FAKE,
  mode: "hardware(GPU, --use-angle=d3d11)",
  envLocal: {
    hasS2Key: BUILTIN_SECRETS.some(([n]) => n === "S2_API_KEY"),
    s2KeyLength: String(ENV.S2_API_KEY ?? "").trim().length,
    hasOpenAlexKey: !!String(ENV.OPENALEX_API_KEY ?? "").trim(),
    hasOpenAlexMailto: !!String(ENV.OPENALEX_MAILTO ?? "").trim(),
  },
  browser: null,
  renderer: null,
  evidence: { api: {}, ui: {} },
  checks: [],
  pageErrors: [],
  summary: [],
  fatal: null,
};
let child = null;
let ws = null;
let profile = null;

function check(step, name, pass, detail = "") {
  const d = typeof detail === "string" ? detail : JSON.stringify(detail);
  report.checks.push({ step, name, pass: !!pass, detail: d });
  log(`  ${pass ? "✅" : "❌"} [第${step}条] ${name}${d ? " — " + d : ""}`);
}

const STEP_TITLES = {
  1: "面板可打开 + 必需 data-testid 齐全",
  2: "/api/sources：三源 + builtin 标志 + 不回显 key",
  3: "假 key 写入 localStorage",
  4: "test-s2：确实用了用户 key，失败原因如实（403）",
  5: "刷新后假 key 仍在（持久化）",
  6: "test-openalex：匿名通道给出明确结论",
  7: "关面板 / 清除所有密钥",
  8: "服务端不回显 key（refs / sources / key-check）",
  9: "实时引用端到端：点星 → citeSource + citeRefs",
  10: "截图 + 证据 JSON 落盘",
};

function summarize() {
  const steps = [];
  for (const id of Object.keys(STEP_TITLES).map(Number)) {
    const cs = report.checks.filter((c) => c.step === id);
    const failed = cs.filter((c) => !c.pass).map((c) => c.name);
    steps.push({
      id,
      title: STEP_TITLES[id],
      checks: cs.length,
      passed: cs.length - failed.length,
      failed,
      pass: cs.length > 0 && failed.length === 0,
    });
  }
  return steps;
}
function writeReport() {
  const abs = resolve(ROOT, OUT);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(report, null, 2));
  return abs;
}
function printSummary() {
  log("\n==================== BYOK 验收汇总 ====================");
  for (const s of report.summary) {
    log(
      `${s.pass ? "✅ PASS" : "❌ FAIL"}  第${String(s.id).padStart(2)}条  ${s.title}` +
        (s.checks ? `  （${s.passed}/${s.checks} 检查项）` : ""),
    );
    if (s.failed.length) log(`         未过：${s.failed.join(" · ")}`);
  }
  const ok = report.summary.filter((s) => s.pass).length;
  log(`\n结论：${ok}/${report.summary.length} 条通过`);
  log(`证据 JSON：${OUT}`);
  log(`面板截图：${SHOT}${existsSync(resolve(ROOT, LIVE_SHOT)) ? ` · 实时引用截图：${LIVE_SHOT}` : ""}`);
  if (report.fatal) log(`\n⚠️ 探针异常提前结束：${report.fatal.split("\n")[0]}`);
}

/* ------------------------------------------------------------------ CDP 基础 */
let msgId = 0;
const pending = new Map();
const pageErrors = [];

async function send(method, params = {}) {
  return new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      pending.delete(id);
      res({ error: String(e) });
    }
  });
}
/**
 * `Runtime.evaluate` 包装：刷新瞬间执行上下文会被销毁（返回 error / 空结果），
 * 所以失败重试几次 —— 否则第 ⑤/⑨ 条的 reload 之后会读到一串 undefined 假失败。
 */
async function ev(expr) {
  for (let i = 0; i < 3; i++) {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r && r.result) return r.result.value;
    await sleep(300);
  }
  return undefined;
}
async function evJson(expr) {
  const raw = await ev(expr);
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
/**
 * 等某个条件成立；fn 返回 falsy = 还没好，返回真值 = 好了（并作为 last 返回）。
 * 超时不抛错 —— 调用方按 `ok` 决定记 PASS/FAIL，这样卡住时也能把当前读数写进证据。
 */
async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await fn();
    } catch {
      last = null;
    }
    if (last) return { ok: true, elapsedMs: Date.now() - t0, last };
    await sleep(intervalMs);
  }
  return { ok: false, elapsedMs: Date.now() - t0, last };
}

/* ------------------------------------------------------------------ DOM 辅助 */
const domClickExpr = (id) =>
  `(() => { const el = document.querySelector(${JSON.stringify(sel(id))}); if (el) el.click(); return !!el; })()`;

async function elementInfo(id) {
  const raw = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel(id))});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return JSON.stringify({
      x, y, w: r.width, h: r.height,
      topTag: top ? top.tagName : null,
      topTestId: top && top.getAttribute ? top.getAttribute("data-testid") : null,
      topIsSelf: !!top && (top === el || el.contains(top)),
      inViewport: x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight,
      disabled: !!el.disabled,
    });
  })()`);
  return raw ? JSON.parse(raw) : null;
}

/**
 * 视口内且未被遮挡 → **CDP 真实鼠标**（mouseMoved/Pressed/Released）；
 * 否则退回 DOM `.click()`（React onClick 同一条路径）。
 *
 * ⚠️ 对"开关型"按钮（open-source-panel）**不做无条件双点**：先看效果再决定要不要重试，
 * 否则真实点击 + DOM 点击各来一次会把面板打开又关上。
 */
async function realClick(id) {
  const info = await elementInfo(id);
  if (!info) return { ok: false, method: "none", info: null, reason: "element-not-found" };
  if (info.disabled) return { ok: false, method: "none", info, reason: "disabled" };
  if (info.inViewport && info.topIsSelf) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y, button: "none", clickCount: 0 });
    await sleep(60);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: info.x, y: info.y, button: "left", clickCount: 1 });
    await sleep(20);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: info.x, y: info.y, button: "left", clickCount: 1 });
    return { ok: true, method: "cdp-mouse", info };
  }
  await ev(domClickExpr(id));
  return { ok: true, method: "dom-click", info };
}

/** 真实鼠标点击一组视口坐标（点星专用，见第 ⑨ 条） */
async function clickAt(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await sleep(80);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(20);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const elText = async (id) =>
  ev(`(() => { const el = document.querySelector(${JSON.stringify(sel(id))}); return el ? el.textContent.trim() : null; })()`);

async function panelState() {
  const raw = await ev(`(() => {
    const p = document.querySelector(${JSON.stringify(sel("source-panel"))});
    if (!p) return JSON.stringify({ exists: false });
    const r = p.getBoundingClientRect();
    return JSON.stringify({
      exists: true,
      visible: r.width > 0 && r.height > 0,
      w: Math.round(r.width),
      h: Math.round(r.height),
      textLen: p.textContent.length,
    });
  })()`);
  return raw ? JSON.parse(raw) : { exists: false };
}
async function waitPanelVisible(timeoutMs) {
  return waitFor(async () => {
    const s = await panelState();
    return s.exists && s.visible ? s : null;
  }, timeoutMs, 200);
}
async function openPanel() {
  const click = await realClick("open-source-panel");
  const tried = [click.method];
  let vis = await waitPanelVisible(5000);
  // 视口内但被别的东西挡住时，真实点击会落在遮挡物上 → 用 DOM click 重试一次
  if (!vis.ok && click.method === "cdp-mouse") {
    await ev(domClickExpr("open-source-panel"));
    tried.push("dom-click-retry");
    vis = await waitPanelVisible(3000);
  }
  return { click, tried, visible: vis.ok, elapsedMs: vis.elapsedMs, state: vis.last ?? (await panelState()) };
}
async function closePanel() {
  const click = await realClick("close-source-panel");
  let gone = await waitFor(async () => {
    const s = await panelState();
    return !s.exists ? { closed: true } : null;
  }, 4000, 200);
  if (!gone.ok) {
    await ev(domClickExpr("close-source-panel"));
    gone = await waitFor(async () => {
      const s = await panelState();
      return !s.exists ? { closed: true } : null;
    }, 2000, 200);
  }
  return { click, gone: gone.ok, state: await panelState() };
}

const PANEL_TESTIDS = [
  "source-panel",
  "s2-key-input",
  "openalex-key-input",
  "openalex-mailto-input",
  "allow-live-refs",
  "test-s2",
  "test-openalex",
  "key-status-s2",
  "key-status-openalex",
  "clear-keys",
  "close-source-panel",
];
async function panelTestIds() {
  const raw = await ev(`(() => {
    const out = {};
    for (const id of ${JSON.stringify(PANEL_TESTIDS)}) {
      out[id] = !!document.querySelector('[data-testid="' + id + '"]');
    }
    return JSON.stringify(out);
  })()`);
  return raw ? JSON.parse(raw) : {};
}

/** 键盘录入：优先 CDP `Input.insertText`（最接近真实粘贴），失败退回原生 setter + input 事件 */
async function typeInto(id, text) {
  const focused = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel(id))});
    if (!el) return null;
    el.focus();
    if (el.select) el.select();
    return JSON.stringify({ tag: el.tagName, type: el.type });
  })()`);
  if (!focused) return { ok: false, method: "none", reason: "input-not-found", value: null };
  await send("Input.insertText", { text });
  await sleep(400);
  let value = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel(id))}); return el ? el.value : null; })()`);
  let method = "cdp-input-insertText";
  if (value !== text) {
    await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel(id))});
      if (!el) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    })()`);
    await sleep(350);
    value = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel(id))}); return el ? el.value : null; })()`);
    method = "native-setter+input-event";
  }
  return { ok: value === text, method, value, focused: focused ? JSON.parse(focused) : null };
}

async function statusSnapshot(provider) {
  return evJson(`(() => {
    const el = document.querySelector(${JSON.stringify(sel("key-status-" + provider))});
    if (!el) return null;
    return JSON.stringify({
      text: el.textContent.trim(),
      status: el.getAttribute("data-status") || "",
      cls: el.className,
    });
  })()`);
}
async function waitStatus(provider, timeoutMs) {
  return waitFor(async () => {
    const s = await statusSnapshot(provider);
    return s && s.status ? s : null;
  }, timeoutMs, 250);
}

/**
 * 点「测试连接」并等结论。第一次点击可能被遮挡/没落地 —— 只有确认按钮**不在测试中**
 * （文案还没变成「测试中…」）时才重试，避免对正在跑的请求再点一次。
 */
async function runProviderTest(provider, timeoutMs) {
  const t0 = Date.now();
  const methods = [];
  const first = await realClick("test-" + provider);
  methods.push(first.method);
  let w = await waitStatus(provider, timeoutMs);
  if (!w.ok) {
    const label = await elText("test-" + provider);
    if (label && label.indexOf("测试中") < 0) {
      const again = await realClick("test-" + provider);
      methods.push(again.method + "-retry");
      w = await waitStatus(provider, timeoutMs);
    }
  }
  return { methods, ok: w.ok, status: w.last, elapsedMs: Date.now() - t0 };
}

/* ------------------------------------------------------------------ 页面探针 */
async function waitApp(timeoutMs = 120000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const raw = await ev(`(() => {
      const s = window.__lunyun?.getState?.();
      if (!s) return null;
      const r = Object.values(s.runtime ?? {});
      return JSON.stringify({
        n: r.length,
        ready: r.filter((x) => x && (x.phase === "ready" || x.phase === "demo")).length,
      });
    })()`);
    if (raw) {
      try {
        last = JSON.parse(raw);
      } catch {
        /* 忽略半截 JSON */
      }
    }
    if (last && last.ready >= 8) {
      await sleep(2500); // 与 probe-pick 一致：挂载后再给两帧半的稳定时间
      return { ok: true, elapsedMs: Date.now() - t0, last };
    }
    await sleep(700);
  }
  return { ok: false, elapsedMs: Date.now() - t0, last };
}

async function reloadAndWaitApp() {
  await send("Page.reload", { ignoreCache: false });
  await waitFor(async () => (await ev("document.readyState")) === "complete", 30000, 300);
  return waitApp(120000);
}

async function readSelection() {
  return evJson(`(() => {
    const s = window.__lunyun?.getState?.();
    const se = s ? s.selection : null;
    if (!se) return JSON.stringify(null);
    return JSON.stringify({
      kind: se.kind,
      domain: se.domain,
      docId: se.docId,
      title: String(se.title ?? "").slice(0, 100),
    });
  })()`);
}

async function runtimeCite(domain, docId) {
  return evJson(`(() => {
    const rt = window.__lunyun?.getState?.().runtime[${JSON.stringify(domain)}];
    if (!rt) return null;
    const cs = rt.citeSource;
    return JSON.stringify({
      citeRefsDoc: rt.citeRefsDoc ?? null,
      citeRefsLoading: !!rt.citeRefsLoading,
      citeSource: cs ? { source: cs.source ?? null, auth: cs.auth ?? null, error: cs.error ?? null } : null,
      citeRefsLen: Array.isArray(rt.citeRefs) ? rt.citeRefs.length : null,
      citeExtLen: Array.isArray(rt.citeExt) ? rt.citeExt.length : null,
      phase: rt.phase ?? null,
    });
  })()`);
}

/** `data/refs-cache/<domain>/<doc>.<mode>.json` 里已缓存的 docId（选星时避开，保证真实时） */
function cachedDocsFor(domains) {
  const out = {};
  for (const d of domains) {
    const ids = new Set();
    try {
      for (const f of readdirSync(resolve(ROOT, "data", "refs-cache", d))) {
        const m = /^(\d+)\./.exec(f);
        if (m) ids.add(Number(m[1]));
      }
    } catch {
      /* 没有该学科的缓存目录 */
    }
    out[d] = [...ids];
  }
  return out;
}

/** 在页面里找一颗"可见 + 拾取回同一颗 + 坐标处暴露 canvas"的星（避开已缓存 doc） */
async function findStar(cached) {
  return evJson(`(() => {
    const cached = ${JSON.stringify(cached)};
    const t = window.__three, s = window.__lunyun?.getState?.();
    const canvas = document.querySelector("canvas");
    if (!t || !s || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const order = ["math", "bio", "eess"];
    const skip = (d, docId) => Array.isArray(cached[d]) && cached[d].indexOf(docId) >= 0;
    let fallback = null;
    for (const d of order) {
      const rt = s.runtime[d];
      const p = rt && (rt.points || rt.demoPoints);
      if (!p) continue;
      const stride = Math.max(1, Math.floor(p.count / 600));
      const ids = t.visibleSample(d, stride, 40) || [];
      for (const docId of ids) {
        if (skip(d, docId)) continue;
        const pr = t.projectAnchor(d, docId);
        if (!pr || !pr.inFront) continue;
        const x = rect.left + pr.x, y = rect.top + pr.y;
        if (x < 40 || y < 40 || x > window.innerWidth - 40 || y > window.innerHeight - 40) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || el.tagName !== "CANVAS") continue;
        const hit = t.pickAt(x, y);
        if (!hit || hit.domain !== d || hit.docId !== docId) continue;
        const cand = { domain: d, docId, x: Math.round(x), y: Math.round(y), points: p.count, stride };
        if (d === "math") return JSON.stringify(cand);
        if (!fallback) fallback = cand;
      }
    }
    return fallback ? JSON.stringify(fallback) : null;
  })()`);
}

async function capture(path) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const data = res && res.data;
  if (!data) return { ok: false, bytes: 0, path, error: "captureScreenshot 无数据" };
  const abs = resolve(ROOT, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.from(data, "base64"));
  const bytes = statSync(abs).size;
  return { ok: bytes > 1024, bytes, path };
}

/* ============================================================================
 * 2. Node 侧接口验收（不需要浏览器）
 * ========================================================================== */
async function apiGet(path, headers = {}, timeoutMs = 60000) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL_ + path, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 不是 JSON 就只留文本摘要 */
    }
    return { ok: true, httpStatus: res.status, ms: Date.now() - t0, text, json };
  } catch (e) {
    return { ok: false, httpStatus: 0, ms: Date.now() - t0, text: "", json: null, error: String(e && e.message ? e.message : e) };
  }
}

async function nodeApiPhase() {
  log("\n=== ① Node 侧接口：/api/sources · /api/key-check · /api/refs ===");
  const api = report.evidence.api;

  /* ---- 第 ② 条：/api/sources（无用户 key） ---- */
  const sources = await apiGet("/api/sources");
  const providers = (sources.json && sources.json.providers) || [];
  api.sources = {
    httpStatus: sources.httpStatus,
    ms: sources.ms,
    textLen: sources.text.length,
    providers: providers.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      builtin: p.builtin,
      keyHeader: p.keyHeader ?? null,
      keyParam: p.keyParam ?? null,
    })),
    auth: sources.json?.auth ?? null,
    userKeysConfigured: sources.json?.userKeysConfigured ?? null,
    leakedBuiltin: leakedBuiltinKeys(sources.text),
    leakedFake: sources.text.includes(FAKE),
  };
  const ids = providers.map((p) => p.id);
  const s2p = providers.find((p) => p.id === "s2");
  const oap = providers.find((p) => p.id === "openalex");
  const corpus = providers.find((p) => p.id === "corpus");
  check(2, "providers 里 corpus / s2 / openalex 三项齐全", ["corpus", "s2", "openalex"].every((x) => ids.includes(x)), ids.join(","));
  check(2, "corpus 是本地语料（kind=local，无需 key）", corpus?.kind === "local" && corpus?.builtin === true, JSON.stringify(corpus));
  check(2, "s2.builtin === true（本机 .env.local 有内置 S2 key）", s2p?.builtin === true, `builtin=${s2p?.builtin} keyHeader=${s2p?.keyHeader}`);
  check(2, "openalex.builtin === false（没有内置 OpenAlex key）", oap?.builtin === false, `builtin=${oap?.builtin} keyParam=${oap?.keyParam}`);
  check(2, "/api/sources 响应文本不含内置 key / 假 key", api.sources.leakedBuiltin.length === 0 && !api.sources.leakedFake, JSON.stringify({ leakedBuiltin: api.sources.leakedBuiltin, leakedFake: api.sources.leakedFake }));
  check(2, "默认凭据档位 auth = {s2:builtin, openalex:anonymous}", sources.json?.auth?.s2 === "builtin" && sources.json?.auth?.openalex === "anonymous", JSON.stringify(sources.json?.auth ?? null));

  // 带假 key 头再问一次：服务端确实把请求头读成了 user（只报档位，不回值）
  const sourcesWithFake = await apiGet("/api/sources", { "x-user-s2-key": FAKE });
  api.sourcesWithFakeHeader = {
    httpStatus: sourcesWithFake.httpStatus,
    ms: sourcesWithFake.ms,
    auth: sourcesWithFake.json?.auth ?? null,
    userKeysConfigured: sourcesWithFake.json?.userKeysConfigured ?? null,
  };
  check(
    2,
    "带 x-user-s2-key 请求头时 /api/sources auth.s2 === \"user\"",
    sourcesWithFake.json?.auth?.s2 === "user" && sourcesWithFake.json?.userKeysConfigured?.s2 === true,
    JSON.stringify(sourcesWithFake.json?.auth ?? null),
  );

  /* ---- 第 ④ 条互证：/api/key-check?provider=s2 带假 key ---- */
  const kcS2 = await apiGet("/api/key-check?provider=s2", { "x-user-s2-key": FAKE }, 40000);
  api.keyCheckS2 = {
    httpStatus: kcS2.httpStatus,
    ms: kcS2.ms,
    json: kcS2.json,
    textLen: kcS2.text.length,
    leakedFake: kcS2.text.includes(FAKE),
    leakedBuiltin: leakedBuiltinKeys(kcS2.text),
  };
  check(
    4,
    "Node 侧同一请求头：using=\"user\" 且 usingUserKey=true",
    kcS2.json?.using === "user" && kcS2.json?.usingUserKey === true,
    JSON.stringify({ using: kcS2.json?.using, usingUserKey: kcS2.json?.usingUserKey }),
  );
  check(
    4,
    "Node 侧假 key 结论：status=error、httpStatus=403（与手工验证一致）",
    kcS2.json?.status === "error" && kcS2.json?.httpStatus === 403,
    JSON.stringify({ status: kcS2.json?.status, httpStatus: kcS2.json?.httpStatus, ms: kcS2.json?.ms }),
  );

  /* 对照：不带用户 key 时用内置 key（证明"上面那次确实是用户 key 生效"） */
  const kcS2Builtin = await apiGet("/api/key-check?provider=s2", {}, 40000);
  api.keyCheckS2Builtin = {
    httpStatus: kcS2Builtin.httpStatus,
    ms: kcS2Builtin.ms,
    json: kcS2Builtin.json,
    leakedBuiltin: leakedBuiltinKeys(kcS2Builtin.text),
  };
  log(
    `  ↳ 对照（不带用户 key）：using=${kcS2Builtin.json?.using ?? "?"} status=${kcS2Builtin.json?.status ?? "?"} http=${kcS2Builtin.json?.httpStatus ?? "?"} ms=${kcS2Builtin.json?.ms ?? "?"}`,
  );

  /* ---- 第 ⑥ 条互证：/api/key-check?provider=openalex（匿名） ---- */
  const kcOA = await apiGet("/api/key-check?provider=openalex", {}, 40000);
  api.keyCheckOpenAlex = {
    httpStatus: kcOA.httpStatus,
    ms: kcOA.ms,
    json: kcOA.json,
    textLen: kcOA.text.length,
    leakedFake: kcOA.text.includes(FAKE),
    leakedBuiltin: leakedBuiltinKeys(kcOA.text),
  };
  check(
    6,
    "Node 侧匿名 OpenAlex：using=anonymous 且给出明确结论（ok / rate_limited）",
    kcOA.json?.using === "anonymous" && (kcOA.json?.status === "ok" || kcOA.json?.status === "rate_limited"),
    JSON.stringify({ using: kcOA.json?.using, status: kcOA.json?.status, httpStatus: kcOA.json?.httpStatus, ms: kcOA.json?.ms }),
  );

  /* ---- 第 ⑧ 条：/api/refs（已有缓存、假 key 头）不回显 ---- */
  const refs = await apiGet("/api/refs?domain=physics&doc=4&mode=cites", { "x-user-s2-key": FAKE }, 90000);
  api.refs = {
    httpStatus: refs.httpStatus,
    ms: refs.ms,
    cached: refs.json?.cached ?? false,
    auth: refs.json?.auth ?? null,
    source: refs.json?.source ?? null,
    mode: refs.json?.mode ?? null,
    inLen: Array.isArray(refs.json?.in) ? refs.json.in.length : null,
    extLen: Array.isArray(refs.json?.ext) ? refs.json.ext.length : null,
    note: refs.json?.error ?? null,
    textLen: refs.text.length,
    leakedFake: refs.text.includes(FAKE),
    leakedBuiltin: leakedBuiltinKeys(refs.text),
  };
  check(
    8,
    "/api/refs（带假 key 头）响应 auth.s2 === \"user\"（请求头被读到并落档）",
    refs.json?.auth?.s2 === "user",
    JSON.stringify({ auth: refs.json?.auth ?? null, cached: api.refs.cached, source: api.refs.source }),
  );
  check(8, "/api/refs 响应文本不含假 key", !api.refs.leakedFake, `textLen=${api.refs.textLen}`);
  check(8, "/api/refs 响应文本不含内置 key", api.refs.leakedBuiltin.length === 0, JSON.stringify({ leakedBuiltin: api.refs.leakedBuiltin }));
  check(8, "/api/key-check 响应文本不含假 key / 内置 key", !api.keyCheckS2.leakedFake && api.keyCheckS2.leakedBuiltin.length === 0, JSON.stringify({ leakedFake: api.keyCheckS2.leakedFake, leakedBuiltin: api.keyCheckS2.leakedBuiltin }));
  check(8, "/api/sources 响应文本不含假 key / 内置 key（含带假头那次）", !api.sources.leakedFake && api.sources.leakedBuiltin.length === 0 && !sourcesWithFake.text.includes(FAKE) && leakedBuiltinKeys(sourcesWithFake.text).length === 0, JSON.stringify({ leakedFake: api.sources.leakedFake, leakedBuiltin: api.sources.leakedBuiltin }));

  log(
    `  ↳ refs：HTTP ${api.refs.httpStatus} · cached=${api.refs.cached} · auth=${JSON.stringify(api.refs.auth)} · in=${api.refs.inLen} ext=${api.refs.extLen} · ${api.refs.ms}ms`,
  );
}

/* ============================================================================
 * 3. 浏览器：启动无头 Edge + 连 CDP
 * ========================================================================== */
async function launchBrowser() {
  log("\n=== ② 启动无头 Edge（硬件 GPU / CDP " + PORT + "） ===");
  const CHROME = resolveBrowser();
  profile = profileDir("srckeys");
  report.browser = { path: CHROME, port: PORT, profile, mode: report.mode };
  const extra = [
    `--remote-debugging-port=${PORT}`,
    "--window-size=1600,1000",
    `--user-data-dir=${profile}`,
  ];
  // headlessArgs() 里默认是 SwiftShader；追加 d3d11 让它走硬件 GPU（与 probe-pick 同一套参数）
  extra.push("--use-angle=d3d11");
  child = spawn(CHROME, [...headlessArgs(extra), URL_], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => {
    const s = String(d);
    if (s.includes("DevTools listening")) log("[browser]", s.trim());
  });

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(400);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = l.find((t) => t.type === "page" && t.url.startsWith("http"));
    } catch {
      /* 浏览器还没起来 */
    }
  }
  if (!target) {
    console.error(debugTargetError(CHROME, PORT, 48, ROOT));
    throw new Error(`启动浏览器后没找到可调试页面（端口 ${PORT}）`);
  }
  report.browser.target = target.url;

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    setTimeout(() => rej(new Error("CDP WebSocket 连接超时")), 10000);
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? m.error);
      pending.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(String(m.params.exceptionDetails?.exception?.description ?? "").slice(0, 300));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      pageErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    }
  };
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  const app = await waitApp(120000);
  report.evidence.ui.appReady = app;
  if (!app.ok) {
    check(1, "页面 8 学科 ready/demo 就绪", false, JSON.stringify(app.last));
    throw new Error("页面未在 120s 内让 8 个学科 ready/demo");
  }
  const gl = await evJson(`(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl) return JSON.stringify({ webgl2: false });
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return JSON.stringify({
      webgl2: true,
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
    });
  })()`);
  report.renderer = gl;
  log("渲染器：", JSON.stringify(gl));
  const bridges = await evJson(`(() => JSON.stringify({
    lunyun: !!window.__lunyun?.getState,
    three: !!window.__three?.projectAnchor,
    canvas: !!document.querySelector("canvas"),
  }))()`);
  report.evidence.ui.bridges = bridges;
  log("调试桥：", JSON.stringify(bridges));
}

/* ============================================================================
 * 4. UI 验收步骤
 * ========================================================================== */
async function uiPhase() {
  const ui = report.evidence.ui;

  /* ---------------------------------------------------------------- 第 ① 条 */
  log("\n=== ③ 第 1 条：HUD「数据源」按钮 → 面板 + data-testid ===");
  const hudReady = await waitFor(
    async () => (await ev(`!!document.querySelector(${JSON.stringify(sel("open-source-panel"))})`)) === true,
    20000,
    300,
  );
  check(1, "HUD 出现 [data-testid=open-source-panel]", hudReady.ok, `elapsed=${hudReady.elapsedMs}ms`);
  const open = await openPanel();
  ui.open = { method: open.click.method, tried: open.tried, info: open.click.info ?? null, elapsedMs: open.elapsedMs };
  const panel = open.state;
  check(1, "点击后面板 [data-testid=source-panel] 出现且可见", panel.exists === true && panel.visible === true, JSON.stringify(panel));
  const tids = await panelTestIds();
  ui.panelTestIds = tids;
  const requiredTids = PANEL_TESTIDS;
  const missing = requiredTids.filter((id) => !tids[id]);
  check(1, "11 个必需 data-testid 全部存在", missing.length === 0, missing.length ? `缺：${missing.join(",")}` : "全部找到");
  const panelText = (await elText("source-panel")) || "";
  ui.panelTextLen = panelText.length;
  ui.panelTextHead = panelText.slice(0, 600);
  check(1, "面板渲染出三条数据源（arXiv 本地语料 / Semantic Scholar / OpenAlex）", ["arXiv 本地语料", "Semantic Scholar", "OpenAlex"].every((t) => panelText.includes(t)), `textLen=${panelText.length}`);
  check(1, "面板如实标出内置 key 配置：S2 已配置 / OpenAlex 未配置", panelText.includes("内置 key 已配置") && panelText.includes("内置 key 未配置"), "两档标签都在");
  const openBtnText = (await elText("open-source-panel")) || "";
  ui.openButtonText = openBtnText;
  check(1, "HUD 按钮文案含「数据源」", openBtnText.includes("数据源"), JSON.stringify(openBtnText));

  if (!panel.exists) {
    check(3, "面板未打开，后续输入步骤无法进行", false, "跳过 3~7 条 UI 操作");
    return;
  }

  /* ---------------------------------------------------------------- 第 ③ 条 */
  log("\n=== ④ 第 3 条：把假 key 打进 S2 输入框 ===");
  const initialLs = await ev(`localStorage.getItem("lunyun.s2Key")`);
  ui.initialS2LocalStorage = initialLs;
  const typed = await typeInto("s2-key-input", FAKE);
  const lsAfterType = await ev(`localStorage.getItem("lunyun.s2Key")`);
  const inputAfterType = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel("s2-key-input"))}); return el ? { value: el.value, type: el.type } : null; })()`);
  ui.type = { method: typed.method, focused: typed.focused, value: typed.value, inputAfterType, lsAfterType, initialLs };
  check(3, "输入框接受假 key（值完全一致）", typed.ok === true, `${typed.method}`);
  check(3, "localStorage[\"lunyun.s2Key\"] === 假 key", lsAfterType === FAKE, `len=${String(lsAfterType ?? "").length}`);
  log(`  ↳ 输入方式=${typed.method} · input type=${inputAfterType ? inputAfterType.type : "?"} · localStorage 值长度=${String(lsAfterType ?? "").length}`);

  /* ---------------------------------------------------------------- 第 ④ 条 */
  log("\n=== ⑤ 第 4 条：点 test-s2，等结论（≤20s） ===");
  const testS2 = await runProviderTest("s2", 20000);
  ui.testS2 = testS2;
  const st4 = testS2.status;
  check(4, "key-status-s2 出结论（≤20s，data-status 非空）", !!(st4 && st4.status), JSON.stringify({ elapsedMs: testS2.elapsedMs, status: st4?.status ?? null }));
  check(4, "结论行写明「你的 key」（auth=user）", !!(st4 && st4.text.includes("你的 key")), JSON.stringify(st4?.text ?? null));
  check(4, "结论为失败/限流（假 key 预期失败），并带 HTTP 状态", !!(st4 && ["error", "rate_limited"].includes(st4.status) && /HTTP\s*\d{3}/.test(st4.text)), JSON.stringify({ status: st4?.status ?? null }));
  log(`  ↳ 完整结论：「${st4 ? st4.text : "（无）"}」`);
  log(`  ↳ 点击方式：${testS2.methods.join(" → ")} · 用时 ${testS2.elapsedMs}ms`);
  ui.panelTextAfterS2Test = (await elText("source-panel"))?.slice(0, 900) ?? null;

  /* ---------------------------------------------------------------- 第 ⑩ 条（截图 A） */
  log("\n=== ⑥ 第 10 条：截图（面板打开 + S2 结论可见） ===");
  // 把结论行滚进可视区再截，保证截图里看得到结论
  await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel("key-status-s2"))}); if (el) el.scrollIntoView({ block: "center" }); return 1; })()`);
  await sleep(400);
  const shot = await capture(SHOT);
  ui.screenshotPanel = shot;
  check(10, "面板截图落盘 shots/source-panel.png（>1KB）", shot.ok, `${shot.bytes} bytes`);
  if (!shot.ok) log("  ⚠️ 截图失败：", shot.error ?? shot.bytes);

  /* ---------------------------------------------------------------- 第 ⑤ 条 */
  log("\n=== ⑦ 第 5 条：刷新页面 → 假 key 持久化 ===");
  const reload1 = await reloadAndWaitApp();
  ui.reload1 = reload1;
  check(5, "刷新后页面回到 8 学科 ready/demo", reload1.ok, `elapsed=${reload1.elapsedMs}ms`);
  const reopen = await openPanel();
  ui.reopenAfterReload = { method: reopen.click.method, visible: reopen.visible };
  const persistedInput = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel("s2-key-input"))}); return el ? { value: el.value, type: el.type } : null; })()`);
  const persistedLs = await ev(`localStorage.getItem("lunyun.s2Key")`);
  ui.persistence = { input: persistedInput, ls: persistedLs };
  check(5, "刷新后 S2 输入框 value 仍是假 key（store 从 localStorage 恢复）", !!persistedInput && persistedInput.value === FAKE, JSON.stringify({ len: persistedInput ? String(persistedInput.value).length : null }));
  check(5, "刷新后 localStorage[\"lunyun.s2Key\"] 仍是假 key", persistedLs === FAKE, `len=${String(persistedLs ?? "").length}`);

  /* ---------------------------------------------------------------- 第 ⑥ 条 */
  log("\n=== ⑧ 第 6 条：点 test-openalex（不填 key，走匿名；≤35s） ===");
  const oaInputBefore = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel("openalex-key-input"))}); return el ? el.value : null; })()`);
  ui.openalexInputBefore = oaInputBefore;
  check(6, "OpenAlex key 输入框为空（走匿名）", !oaInputBefore, JSON.stringify(oaInputBefore));
  const testOA = await runProviderTest("openalex", 35000);
  ui.testOpenAlex = testOA;
  const st6 = testOA.status;
  check(6, "key-status-openalex 出结论（≤35s，data-status 非空）", !!(st6 && st6.status), JSON.stringify({ elapsedMs: testOA.elapsedMs, status: st6?.status ?? null }));
  check(6, "结论行标明「匿名」（auth=anonymous）", !!(st6 && st6.text.includes("匿名")), JSON.stringify(st6?.text ?? null));
  check(6, "结论为可用/限流/失败三档之一（有明确结论）", !!(st6 && ["ok", "rate_limited", "error"].includes(st6.status)), JSON.stringify({ status: st6?.status ?? null }));
  log(`  ↳ 完整结论：「${st6 ? st6.text : "（无）"}」`);
  log(`  ↳ 点击方式：${testOA.methods.join(" → ")} · 用时 ${testOA.elapsedMs}ms`);
  ui.panelTextAfterOaTest = (await elText("source-panel"))?.slice(0, 900) ?? null;

  /* ---------------------------------------------------------------- 第 ⑦ 条 */
  log("\n=== ⑨ 第 7 条：关面板 → 再开 → 清除所有密钥 ===");
  const closed = await closePanel();
  ui.close = closed;
  check(7, "点 close-source-panel 后面板消失", closed.gone === true, JSON.stringify(closed.state));
  const reopened = await openPanel();
  ui.reopenForClear = { method: reopened.click.method, visible: reopened.visible };
  check(7, "再次打开面板成功", reopened.visible === true, JSON.stringify(reopened.state));
  const clearClick = await realClick("clear-keys");
  const clearWait = await waitFor(async () => {
    const ls = await ev(`localStorage.getItem("lunyun.s2Key")`);
    const val = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel("s2-key-input"))}); return el ? el.value : null; })()`);
    return ls === null && val === "" ? { ls: null, value: val } : null;
  }, 5000, 250);
  if (!clearWait.ok) {
    // 真实点击可能没落地：DOM 兜底一次（清完后按钮变 disabled，重复点击无害）
    await ev(domClickExpr("clear-keys"));
    await waitFor(async () => {
      const ls = await ev(`localStorage.getItem("lunyun.s2Key")`);
      const val = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel("s2-key-input"))}); return el ? el.value : null; })()`);
      return ls === null && val === "" ? { ls: null, value: val } : null;
    }, 3000, 250);
  }
  const clearState = await evJson(`(() => JSON.stringify({
    s2: localStorage.getItem("lunyun.s2Key"),
    openalex: localStorage.getItem("lunyun.openAlexKey"),
    mailto: localStorage.getItem("lunyun.openAlexMailto"),
    inputValue: (function () { const el = document.querySelector(${JSON.stringify(sel("s2-key-input"))}); return el ? el.value : null; })(),
  }))()`);
  const panelTextAfterClear = (await elText("source-panel")) || "";
  ui.clear = { clickMethod: clearClick.method, state: clearState, feedbackVisible: panelTextAfterClear.includes("已清除") };
  check(7, "clear-keys 后 localStorage.lunyun.s2Key 被移除、S2 输入框为空", !!clearState && clearState.s2 === null && clearState.inputValue === "", JSON.stringify(clearState));
  check(7, "clear-keys 后 OpenAlex key / mailto 也一并清掉", !!clearState && clearState.openalex === null && clearState.mailto === null, JSON.stringify(clearState));
  check(7, "面板给出「已清除」反馈", panelTextAfterClear.includes("已清除"), panelTextAfterClear.includes("已清除") ? "有" : "无");

  /* ---------------------------------------------------------------- 第 ⑨ 条 */
  if (SKIP_LIVE) {
    log("\n=== ⑩ 第 9 条：--skip-live，跳过实时引用端到端 ===");
    ui.live = { skipped: true };
    check(9, "实时引用端到端（本次 --skip-live 跳过）", false, "跳过 —— 不算通过，需全量跑一次");
    return;
  }
  log("\n=== ⑩ 第 9 条：实时引用端到端（allowLiveRefs=1 → 点星 → citeSource） ===");
  const liveFlag = await ev(`(() => { localStorage.setItem("lunyun.allowLiveRefs", "1"); return localStorage.getItem("lunyun.allowLiveRefs"); })()`);
  ui.liveFlagSet = liveFlag;
  check(9, "localStorage[\"lunyun.allowLiveRefs\"] === \"1\"（已写入）", liveFlag === "1", JSON.stringify(liveFlag));
  const reload2 = await reloadAndWaitApp();
  ui.reload2 = reload2;
  check(9, "开启实时引用后刷新，页面回到 8 学科 ready/demo", reload2.ok, `elapsed=${reload2.elapsedMs}ms`);

  const cached = cachedDocsFor(["math", "bio", "eess"]);
  ui.liveCachedDocs = cached;
  const live = { cachedDocs: cached, attempts: [], selection: null, runtime: null, samples: [], domCiteSource: null, error: null };
  ui.live = live;
  let picked = null;
  for (let attempt = 1; attempt <= 3 && !picked; attempt++) {
    const cand = await findStar(cached);
    if (!cand) {
      live.attempts.push({ attempt, candidate: null, note: "找不到同时满足 可见/可拾取/暴露 canvas 的星" });
      break;
    }
    await clickAt(cand.x, cand.y);
    const selWait = await waitFor(async () => {
      const s = await readSelection();
      return s && s.kind === "paper" ? s : null;
    }, 4000, 150);
    const sel = selWait.last;
    live.attempts.push({
      attempt,
      candidate: cand,
      clickMethod: "cdp-mouse",
      selected: sel,
      exact: !!(sel && sel.domain === cand.domain && sel.docId === cand.docId),
    });
    log(
      `  ↳ 尝试 ${attempt}：点 (${cand.x},${cand.y}) → 期望 ${cand.domain}/${cand.docId} · 实得 ${sel ? sel.domain + "/" + sel.docId : "（未选中）"}`,
    );
    // 同一颗最好；同一学科的邻星也可接受（真正的端到端看的是"选中后有没有去取引用"），但要如实记 exact
    if (sel && sel.domain === cand.domain) picked = { selection: sel, candidate: cand };
  }
  if (!picked && live.attempts.length && live.attempts[live.attempts.length - 1].selected) {
    const s = live.attempts[live.attempts.length - 1].selected;
    picked = { selection: s, candidate: live.attempts[live.attempts.length - 1].candidate };
  }
  live.selection = picked ? picked.selection : null;
  check(9, "真实鼠标点星后选中了论文（selection.kind=paper）", !!picked, picked ? `${picked.selection.domain}/${picked.selection.docId} · exact=${live.attempts.some((a) => a.exact)}` : JSON.stringify(live.attempts));

  if (picked) {
    const selDomain = picked.selection.domain;
    const selDocId = picked.selection.docId;
    live.selected = { domain: selDomain, docId: selDocId };
    const t0 = Date.now();
    let final = null;
    while (Date.now() - t0 < LIVE_TIMEOUT) {
      const snap = await runtimeCite(selDomain, selDocId);
      if (snap) {
        const prev = live.samples[live.samples.length - 1];
        if (
          !prev ||
          prev.citeRefsDoc !== snap.citeRefsDoc ||
          prev.citeRefsLoading !== snap.citeRefsLoading ||
          (prev.citeSource?.source ?? null) !== (snap.citeSource?.source ?? null)
        ) {
          live.samples.push({ t: Date.now() - t0, ...snap });
        }
        final = snap;
        if (snap.citeRefsDoc === selDocId && !snap.citeRefsLoading && snap.citeSource) break;
      }
      await sleep(700);
    }
    const elapsed = Date.now() - t0;
    live.elapsedMs = elapsed;
    live.runtime = final;
    live.timedOut = !(final && final.citeRefsDoc === selDocId && !final.citeRefsLoading && final.citeSource);
    log(`  ↳ 运行时：${JSON.stringify(final)}（用时 ${elapsed}ms）`);
    if (live.timedOut) {
      check(9, `实时引用在 ${LIVE_TIMEOUT / 1000}s 内给出结论`, false, JSON.stringify(final));
    } else {
      const cs = final.citeSource;
      check(9, "citeRefsDoc===docId 且 citeRefsLoading=false 且有 citeSource", true, JSON.stringify({ citeRefsDoc: final.citeRefsDoc, citeRefsLoading: final.citeRefsLoading, citeSource: cs }));
      check(9, "citeSource 里有来源通道（s2/openalex/static）", !!(cs && cs.source), JSON.stringify(cs));
      check(9, "citeSource 没有 error（实时取引用成功）", !(cs && cs.error), JSON.stringify(cs));
      check(9, `citeRefs/citeExt 已回填（in=${final.citeRefsLen} ext=${final.citeExtLen}）`, final.citeRefsLen !== null && final.citeExtLen !== null, JSON.stringify({ citeRefsLen: final.citeRefsLen, citeExtLen: final.citeExtLen, source: cs?.source, auth: cs?.auth }));
    }
    // 论文面板上的「数据源：Semantic Scholar · 你的 key / 内置 key / 匿名」那一行
    const domWait = await waitFor(async () => {
      const t = await elText("cite-source");
      return t ? t : null;
    }, 15000, 300);
    live.domCiteSource = domWait.last ?? null;
    check(9, "论文面板 [data-testid=cite-source] 出现且文本含「数据源」", !!(domWait.last && domWait.last.includes("数据源")), JSON.stringify(domWait.last ?? null));
    const liveShot = await capture(LIVE_SHOT);
    ui.screenshotLive = liveShot;
    check(10, "实时引用截图落盘 shots/source-live-refs.png（>1KB）", liveShot.ok, `${liveShot.bytes} bytes`);
  }
}

/* ============================================================================
 * 5. 清理：清掉本探针写进 localStorage 的东西，再刷新一次
 * ========================================================================== */
async function cleanupPage() {
  log("\n=== ⑪ 清理：localStorage.clear() + 刷新一次 ===");
  const before = await evJson(`(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      // 只记键名与值长度 —— 绝不把 key 值写进证据
      out[k] = (localStorage.getItem(k) || "").length;
    }
    return JSON.stringify(out);
  })()`);
  report.evidence.ui.localStorageBeforeCleanup = before;
  await ev(`(() => { localStorage.clear(); return true; })()`);
  const reload = await reloadAndWaitApp();
  const after = await evJson(`(() => JSON.stringify({
    keys: Object.keys(localStorage),
    s2: localStorage.getItem("lunyun.s2Key"),
    openalex: localStorage.getItem("lunyun.openAlexKey"),
    mailto: localStorage.getItem("lunyun.openAlexMailto"),
    allowLiveRefs: localStorage.getItem("lunyun.allowLiveRefs"),
  }))()`);
  report.cleanup = {
    cleared: true,
    reloadOk: reload.ok,
    reloadElapsedMs: reload.elapsedMs,
    localStorageAfter: after,
    probeKeysGone: !after || (after.s2 === null && after.openalex === null && after.mailto === null && after.allowLiveRefs === null),
  };
  check(9, "清理：localStorage.clear() 并刷新后，探针写入的 key/开关全部消失", report.cleanup.probeKeysGone === true, JSON.stringify(after));
}

/* ============================================================================
 * 6. 浏览器收尾：kill 进程 / 释放端口 / 删 profile
 * ========================================================================== */
async function closeBrowser() {
  const out = { killed: false, portReleased: false, profileRemoved: false, notes: [] };
  try {
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    if (child) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      await sleep(900);
      if (child.exitCode === null) {
        try {
          execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", timeout: 15000 });
        } catch (e) {
          out.notes.push("taskkill: " + String(e && e.message ? e.message : e).slice(0, 120));
        }
      }
      await sleep(600);
      out.killed = child.exitCode !== null || child.killed === true;
      child = null;
    }
    // 端口释放
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(800) });
        await res.text().catch(() => "");
      } catch {
        out.portReleased = true;
        break;
      }
      await sleep(300);
    }
    // 删本次专用 profile（绝对路径 + 必须位于 shots/ 下，防手滑）
    if (profile) {
      const abs = resolve(profile);
      const shotsRoot = resolve(ROOT, "shots") + sep;
      if (abs.startsWith(shotsRoot) && existsSync(abs)) {
        try {
          rmSync(abs, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
          out.profileRemoved = !existsSync(abs);
        } catch (e) {
          out.notes.push("rm profile: " + String(e && e.message ? e.message : e).slice(0, 120));
        }
      }
      out.profile = profile;
      profile = null;
    }
  } catch (e) {
    out.notes.push(String(e && e.message ? e.message : e));
  }
  return out;
}

/* ============================================================================
 * 7. 主流程
 * ========================================================================== */
async function main() {
  log("论文云 · BYOK 验收探针");
  log(`目标：${URL_} · CDP 端口：${PORT} · 假 key：${FAKE}`);
  log(`内置 S2 key：${report.envLocal.hasS2Key ? "已配置（长度 " + report.envLocal.s2KeyLength + "，不打印值）" : "未配置"}`);

  // 0) 5311 活着吗（先给一句人话，而不是让浏览器白等 48 秒）
  try {
    const ping = await apiGet("/", {}, 8000);
    if (!ping.ok) throw new Error(ping.error ?? "无响应");
    log(`5311 就绪：HTTP ${ping.httpStatus} · ${ping.ms}ms`);
  } catch (e) {
    check(1, "5311 服务器可用", false, String(e && e.message ? e.message : e));
    throw new Error("5311 不响应，先启动 `node deploy/serve.mjs --port 5311`（探针不负责重启它）");
  }

  await nodeApiPhase();
  await launchBrowser();
  await uiPhase();
  await cleanupPage();
}

let finalized = false;
try {
  await main();
} catch (e) {
  report.fatal = String(e && e.stack ? e.stack : e);
  console.error("\n探针异常：", report.fatal);
} finally {
  try {
    report.browserClose = await closeBrowser();
  } catch (e) {
    report.browserClose = { error: String(e && e.message ? e.message : e) };
  }
  report.pageErrors = pageErrors.slice(0, 30);
  try {
    // 先写一版；再补第 10 条「JSON 落盘」检查后写终版
    writeReport();
    const abs = resolve(ROOT, OUT);
    const jsonBytes = existsSync(abs) ? statSync(abs).size : 0;
    check(10, "证据 JSON 落盘", jsonBytes > 0, `${OUT} · ${jsonBytes} bytes`);
    report.summary = summarize();
    writeReport();
    finalized = true;
  } catch (e) {
    console.error("写证据失败：", e);
  }
  printSummary();
  if (!finalized || report.fatal || report.summary.some((s) => !s.pass)) process.exitCode = 1;
}
