/**
 * 论文云 · **GPU 拾取验收探针**
 * ============================================================================
 * 回答三件事（交付安排 §4① 的验收）：
 *   ① **正确性**：把一颗"当前可见"的星投影到屏幕，用屏幕坐标去拾取，必须点回同一颗；
 *      再走一遍**真实鼠标点击**（CDP Input.dispatchMouseEvent）→ `selection` 必须一致；
 *   ② **性能**：拾取耗时与点数几乎无关 —— 默认演示集（30.5 万点）与「载入全部」
 *      （305 万点）各测 40 次，给出中位 / p95；同时用 Node 复算旧 CPU 投影路径作对照；
 *   ③ **交互语义**：悬停出标签、点虚空不清选中（作者明确要求的两条）。
 *
 * 用法：
 *   node deploy/probe-pick.mjs                  # 默认（硬件 GPU，演示点集）
 *   node deploy/probe-pick.mjs --full           # 等「载入全部」3,052,327 点后再测一遍
 *   node deploy/probe-pick.mjs --software       # 强制 SwiftShader（对照/无独显机器）
 *   node deploy/probe-pick.mjs --skip-cpu       # 跳过 Node 侧 CPU 对照（省 ~3 秒）
 *
 * 输出：控制台摘要 + `shots/pick-probe-<时间戳>.json`（原始读数）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { debugTargetError, headlessArgs, profileDir, resolveBrowser } from "./browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const URL_ = argVal("--url", "http://127.0.0.1:5311");
const PORT = Number(argVal("--port", "9702"));
const SOFTWARE = has("--software");
const WAIT_FULL = has("--full");
const OUT = argVal("--out", `shots/pick-probe-${Date.now()}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* --------------------------------------------------------- ① Node 侧 CPU 对照 */
/**
 * 旧 `StarPicker.pick` 的内层循环：世界矩阵变换 + `Vector3.project` + 屏幕距离。
 * 用 Node（同一台机器的同一个 V8）复算，作为"GPU 拾取替掉了多少 CPU 工作"的对照。
 * ⚠️ 只是**等价基准**（单层、单位世界矩阵），不是逐行复刻旧实现 —— 但两者内层一致。
 */
async function cpuBaseline() {
  const THREE = await import("three");
  const bench = (n, rounds = 3) => {
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() - 0.5) * 60;
    const cam = new THREE.PerspectiveCamera(52, 16 / 9, 0.05, 24000);
    cam.position.set(-3.2, 11.2, 28.8);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const m = new THREE.Matrix4();
    const V = new THREE.Vector3();
    const times = [];
    for (let r = 0; r < rounds; r++) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        V.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(m);
        const depth = V.distanceTo(cam.position);
        V.project(cam);
        const sx = (V.x * 0.5 + 0.5) * 1600;
        const sy = (-V.y * 0.5 + 0.5) * 900;
        if (V.z > 1) continue;
        if (Math.hypot(sx - 800, sy - 450) <= 14) void depth;
      }
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { points: n, medianMs: +times[Math.floor(times.length / 2)].toFixed(2) };
  };
  return [bench(305237), bench(1463590), bench(3052327)];
}

/* --------------------------------------------------------- ② 浏览器 */
const CHROME = resolveBrowser();
const extra = [
  `--remote-debugging-port=${PORT}`,
  "--window-size=1600,1000",
  `--user-data-dir=${profileDir("pickprobe")}`,
];
if (!SOFTWARE) extra.push("--use-angle=d3d11");
const child = spawn(CHROME, [...headlessArgs(extra), URL_], { stdio: ["ignore", "pipe", "pipe"] });
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
    /* 还没起来 */
  }
}
if (!target) {
  console.error(debugTargetError(CHROME, PORT, 48, ROOT));
  child.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
const pageErrors = [];
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
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++msgId;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
    ?.result?.value;
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });

/** 等八个学科就绪 */
for (let i = 0; i < 150; i++) {
  const st = await ev(`(() => {
    const s = window.__lunyun?.getState?.();
    if (!s) return null;
    const r = Object.values(s.runtime);
    return JSON.stringify({ ready: r.filter((x) => x.phase === "ready" || x.phase === "demo").length });
  })()`);
  if (st && JSON.parse(st).ready >= 8) break;
  await sleep(700);
}
await sleep(2500);

const renderer = await ev(`(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  if (!gl) return "no-webgl2";
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return JSON.stringify({ vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) });
})()`);
log("渲染器：", renderer);

/** 页面内的测量函数（注入一次，后面重复调用） */
await ev(`window.__pickProbe = {
  scene: () => window.__three.sceneInfo(),
  timing: (n) => {
    const t = window.__three;
    const rect = document.querySelector("canvas").getBoundingClientRect();
    const ms = [];
    for (let i = 0; i < n; i++) {
      t.pickAt(rect.left + 20 + Math.random() * (rect.width - 40), rect.top + 20 + Math.random() * (rect.height - 40));
      ms.push(t.pickStats().lastMs);
    }
    ms.sort((a, b) => a - b);
    const q = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
    return { n, median: q(0.5), p95: q(0.95), min: ms[0], max: ms[ms.length - 1] };
  },
  correctness: (perDomain) => {
    const t = window.__three, s = window.__lunyun.getState();
    const rect = document.querySelector("canvas").getBoundingClientRect();
    const out = {
      tried: 0,
      exact: 0,
      near2px: 0,   // 选中星画在光标 2px 内（像素取整/邻星遮挡导致，几何正确）
      near14px: 0,  // 选中星画在光标 14px 内（容差内，密集区遮挡换星）
      invisibleHit: [], // ❗ 点到了"不可见"的星 = bug
      miss: [],         // ❗ 可见星中心却点空 = bug
      isolated: 0,
      isolatedTried: 0,
      isolatedWrong: [],
      fixedPointStable: 0,
      fixedPointTried: 0,
      hitDist: [],
    };
    const vis = new Set();
    for (const domain of Object.keys(s.runtime)) {
      const rt = s.runtime[domain];
      const p = rt.points ?? rt.demoPoints;
      if (!p) continue;
      const stride = Math.max(1, Math.floor(p.count / perDomain));
      const ids = t.visibleSample(domain, stride, perDomain) || [];
      const visibleDocIds = new Set(ids);
      for (const docId of ids) {
        const pr = t.projectAnchor(domain, docId);
        if (!pr || !pr.inFront) continue;
        const x = rect.left + pr.x, y = rect.top + pr.y;
        if (x < 30 || y < 30 || x > rect.left + rect.width - 30 || y > rect.top + rect.height - 30) continue;
        out.tried++;
        const win = t.pickWindow(x, y, 10);
        const marks = (win && win.marks) || [];
        const mine = marks.find((m) => m.domain === domain && m.docId === docId);
        const isolated = marks.length === 1 && !!mine;
        if (isolated) out.isolatedTried++;
        const hit = t.pickAt(x, y);
        if (!hit) {
          // 窗口一个像素都没有 → 这颗可见星根本没被画出来（bug）；
          // 窗口里没有它但有别的星 → 它的像素被邻星占了（1px 点同像素只留一颗，可接受）
          if (marks.length === 0) out.miss.push({ domain, docId });
          continue;
        }
        const hv = t.starVisible(hit.domain, hit.docId);
        if (!hv || !hv.visible) {
          out.invisibleHit.push({ want: { domain, docId }, got: hit });
          continue;
        }
        const hitDist = (() => {
          const p2 = t.projectAnchor(hit.domain, hit.docId);
          return p2 ? Math.hypot(rect.left + p2.x - x, rect.top + p2.y - y) : Infinity;
        })();
        out.hitDist.push(+Math.max(0, hitDist).toFixed(1));
        if (isolated) {
          if (hit.domain === domain && hit.docId === docId) out.exact++;
          else out.isolatedWrong.push({ want: { domain, docId }, got: hit, hitDist: +hitDist.toFixed(2) });
        } else if (hit.domain === domain && hit.docId === docId) {
          out.exact++;
          out.fixedPointTried++;
          const again = t.pickAt(rect.left + pr.x, rect.top + pr.y);
          if (again && again.domain === domain && again.docId === docId) out.fixedPointStable++;
        } else if (hitDist <= 2) out.near2px++;
        else if (hitDist <= 14) out.near14px++;
        void visibleDocIds;
      }
    }
    return out;
  },
  /**
   * 找"能被真实鼠标点到"的星：屏幕坐标处**必须暴露 canvas**
   * （HUD 的图例条压在画布上时，点下去命中的是 BUTTON 而不是 canvas —— 之前踩过）。
   */
  clickTest: () => {
    const t = window.__three, s = window.__lunyun.getState();
    const rect = document.querySelector("canvas").getBoundingClientRect();
    for (const domain of Object.keys(s.runtime)) {
      const rt = s.runtime[domain];
      const p = rt.points ?? rt.demoPoints;
      if (!p) continue;
      const stride = Math.max(1, Math.floor(p.count / 40));
      const ids = t.visibleSample(domain, stride, 40) || [];
      for (const docId of ids) {
        const pr = t.projectAnchor(domain, docId);
        if (!pr || !pr.inFront) continue;
        const x = rect.left + pr.x, y = rect.top + pr.y;
        if (x < 40 || y < 40 || x > rect.left + rect.width - 40 || y > rect.top + rect.height - 40) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || el.tagName !== "CANVAS") continue;
        const hit = t.pickAt(x, y);
        if (!hit || hit.domain !== domain || hit.docId !== docId) continue;
        return { domain, docId, x, y };
      }
    }
    return null;
  },
};`);

const report = {
  at: new Date().toISOString(),
  url: URL_,
  mode: SOFTWARE ? "software(SwiftShader)" : "hardware(GPU)",
  renderer: renderer ? JSON.parse(renderer) : null,
  stages: {},
  pageErrors,
};

if (!has("--skip-cpu")) {
  log("Node 侧 CPU 旧路径对照（等价基准）…");
  report.cpuBaseline = await cpuBaseline();
  log("CPU 旧路径：", JSON.stringify(report.cpuBaseline));
}

/** 等「载入全部」：boot() 会把八团从演示点集换成完整点集（约 305 万点） */
async function waitFull(timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const done = await ev(`(() => {
      const rt = window.__lunyun?.getState?.().runtime ?? {};
      const ids = Object.keys(rt);
      return ids.length >= 8 && ids.every((k) => rt[k] && rt[k].full === true);
    })()`);
    if (done === true) return true;
    await sleep(1500);
  }
  return false;
}

async function measure(label) {
  const scene = JSON.parse(await ev("JSON.stringify(window.__pickProbe.scene())"));
  const timing = JSON.parse(await ev("JSON.stringify(window.__pickProbe.timing(40))"));
  const corr = JSON.parse(await ev("JSON.stringify(window.__pickProbe.correctness(12))"));
  log(`\n== ${label} ==`);
  log("点数：", JSON.stringify(scene));
  log("拾取耗时(ms)：", JSON.stringify(timing));
  log(
    `正确性（${corr.tried} 次投影→拾取）：同一颗 ${corr.exact} · 命中星画在 ≤2px ${corr.near2px} · ` +
      `≤14px ${corr.near14px} · 点到不可见星 ${corr.invisibleHit.length} · 点空 ${corr.miss.length}`,
  );
  const iso = corr.isolatedTried;
  log(
    `  孤立星（窗口里只有它一个像素）${iso ? `${iso - corr.isolatedWrong.length}/${iso} 精确命中` : "（本帧没有孤立样本）"}`,
  );
  log(`  固定点稳定性（同一颗再点一次）：${corr.fixedPointStable}/${corr.fixedPointTried}`);
  if (corr.hitDist.length) {
    const d = corr.hitDist.slice().sort((a, b) => a - b);
    log(`  命中星中心距光标：中位 ${d[Math.floor(d.length / 2)]}px · 最大 ${d[d.length - 1]}px（容差 14px）`);
  }
  if (corr.invisibleHit.length) log("  ❗ 点到不可见星：", JSON.stringify(corr.invisibleHit.slice(0, 3)));
  if (corr.miss.length) log("  ❗ 可见星中心点空：", JSON.stringify(corr.miss.slice(0, 3)));
  if (corr.isolatedWrong.length) log("  ❗ 孤立星点错：", JSON.stringify(corr.isolatedWrong.slice(0, 3)));
  const ok = corr.invisibleHit.length === 0 && corr.miss.length === 0 && corr.isolatedWrong.length === 0 && corr.tried > 0;
  log(`  判定：${ok ? "✅ 通过" : "❌ 未通过"}`);
  return { scene, timing, corr, ok };
}

report.stages.demo = await measure("演示点集（默认视图）");

if (WAIT_FULL) {
  log("\n等「载入全部」把八团换成完整点集（最长 5 分钟）…");
  const ok = await waitFull();
  log("载入全部：", ok ? "完成" : "超时（继续按当前点数测）");
  await sleep(3000);
  report.stages.full = await measure("载入全部（305 万点）");
  report.fullLoaded = ok;
}

/* ---- 交互语义 ---- */
log("\n== 真实点击 / 悬停 / 点虚空 ==");
/**
 * 记录 1.2 秒内相机漂移 —— **不要等"停稳"**：默认机位常常落在某个团的引力球里，
 * 相机会持续协转（实测 0.226 世界单位/3s，见 Focus/居中探针），"完全静止"不存在。
 * 这里只量漂移速度，好解释"点击前后星点会动 0.1~1px"。
 */
async function cameraDrift() {
  const read = async () => JSON.parse((await ev("JSON.stringify(window.__three.cameraPos())")) || "null");
  const a = await read();
  await sleep(1200);
  const b = await read();
  if (!a || !b) return null;
  return +Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]).toFixed(3);
}
const drift = await cameraDrift();
log(`相机漂移（1.2s，引力协转/开场缓动）：${drift ?? "?"} 世界单位 —— 屏幕位移约 ${drift ? (drift * 32).toFixed(1) : "?"}px，点击瞬间可能差 1~2px`);
/**
 * ⚠️ **不能 `JSON.stringify(selection)`**：`selection.record` 里有 BigInt
 * （脊柱记录按 BigInt 存 arXiv 号），会抛 "Do not know how to serialize a BigInt"。
 * 只读我们要判定的字段。
 */
const readSelection = async () =>
  JSON.parse(
    (await ev(`(() => {
      const s = window.__lunyun.getState().selection;
      return s ? JSON.stringify({ kind: s.kind, domain: s.domain, docId: s.docId, title: s.title }) : "null";
    })()`)) || "null",
  );
const clickTarget = JSON.parse(await ev("JSON.stringify(window.__pickProbe.clickTest())") || "null");
const interaction = { clickTarget, clickSelection: null, hover: null, emptyClickSelection: null };

if (clickTarget) {
  await clickAt(clickTarget.x, clickTarget.y);
  await sleep(600);
  interaction.clickSelection = await readSelection();
  const sel = interaction.clickSelection;
  interaction.clickExact = !!sel && sel.domain === clickTarget.domain && sel.docId === clickTarget.docId;
  /**
   * 密集中即使"只画中心像素"，也可能有两颗星的中心落在同一像素（此时深度靠前的那颗赢）。
   * 所以判定分两档：**exact**（同一颗）为最强证据；否则要求选中的星**画在点击点 4px 内**
   * 且确实可见（= 点到了那颗星，只是恰好与目标重叠）。
   */
  if (!interaction.clickExact && sel) {
    interaction.clickHit = JSON.parse(
      (await ev(`(() => {
        const t = window.__three;
        const p = t.projectAnchor(${JSON.stringify(sel.domain)}, ${sel.docId});
        const v = t.starVisible(${JSON.stringify(sel.domain)}, ${sel.docId});
        const rect = document.querySelector("canvas").getBoundingClientRect();
        return JSON.stringify({ distPx: p ? Math.hypot(rect.left + p.x - ${clickTarget.x}, rect.top + p.y - ${clickTarget.y}) : null, visible: !!v && v.visible });
      })()`)) || "null",
    );
    /**
     * 容差标准：命中星必须是**可见**的、且画在光标 14px 内（与拾取窗口半径一致）。
     * 300 万点时平均约 2 点/px²，同一像素/相邻像素上叠着好几颗星 ——
     * 点"这颗的中心"选中 1~2px 外的邻星是**设计内**行为，不是点错（见 Focus 探针同样的结论）。
     */
    interaction.clickOk =
      !!interaction.clickHit &&
      interaction.clickHit.visible &&
      interaction.clickHit.distPx !== null &&
      interaction.clickHit.distPx <= 14;
  } else {
    interaction.clickOk = interaction.clickExact;
  }
  log(
    `点击 (${clickTarget.x.toFixed(0)},${clickTarget.y.toFixed(0)}) → 期望 ${clickTarget.domain}/${clickTarget.docId} · 实得 ${sel?.domain}/${sel?.docId} · ` +
      `${interaction.clickExact ? "✅ 同一颗" : interaction.clickOk ? `✅ 容差内邻星（选中星画在 ${interaction.clickHit?.distPx?.toFixed(1)}px 处）` : "❌"}`,
  );

  /** 悬停：在任意一个"暴露 canvas 且能拾取到星"的点停一下，读 store.hover */
  const hoverTarget = JSON.parse(
    (await ev(`(() => {
      const t = window.__three;
      const rect = document.querySelector("canvas").getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.42, 0.58], [0.58, 0.42], [0.35, 0.5], [0.65, 0.55], [0.5, 0.35], [0.5, 0.7]]) {
        const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
        const el = document.elementFromPoint(x, y);
        if (!el || el.tagName !== "CANVAS") continue;
        const hit = t.pickAt(x, y);
        if (hit) return JSON.stringify({ x, y, hit });
      }
      return "null";
    })()`)) || "null",
  );
  if (hoverTarget) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: hoverTarget.x,
      y: hoverTarget.y,
      button: "none",
      clickCount: 0,
    });
    await sleep(400);
    const hv = JSON.parse(await ev("JSON.stringify(window.__lunyun.getState().hover)") || "null");
    interaction.hover = hv;
    interaction.hoverOk = !!hv;
    log("悬停：", hv ? `${hv.domain}/${hv.docId} ✅` : "null ❌");
  } else {
    log("找不到可悬停的 canvas 点，跳过悬停测试");
  }

  /** 点虚空（找一个"暴露 canvas 且拾取为空"的点）：选中必须保持（作者："点击虚空不能有反应"） */
  const emptyPoint = JSON.parse(
    (await ev(`(() => {
      const t = window.__three;
      const rect = document.querySelector("canvas").getBoundingClientRect();
      for (const [fx, fy] of [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98], [0.5, 0.04], [0.04, 0.5], [0.5, 0.96], [0.96, 0.5]]) {
        const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
        const el = document.elementFromPoint(x, y);
        if (!el || el.tagName !== "CANVAS") continue;
        if (t.pickAt(x, y) === null) return JSON.stringify({ x, y, fx, fy });
      }
      return "null";
    })()`)) || "null",
  );
  if (emptyPoint) {
    await clickAt(emptyPoint.x, emptyPoint.y);
    await sleep(400);
    interaction.emptyPoint = emptyPoint;
    interaction.emptyClickSelection = await readSelection();
    interaction.emptyClickOk =
      JSON.stringify(interaction.emptyClickSelection) === JSON.stringify(interaction.clickSelection);
    log(`点虚空 (${emptyPoint.x.toFixed(0)},${emptyPoint.y.toFixed(0)}) 后选中保持：${interaction.emptyClickOk ? "✅" : "❌"}`);
  } else {
    log("找不到暴露 canvas 的空白点，跳过「点虚空」测试");
  }
} else {
  log("找不到「投影中心即命中」的可见星，跳过真实点击测试");
}
report.stages.interaction = interaction;

report.pageErrors = pageErrors;
mkdirSync(resolve(ROOT, dirname(OUT)), { recursive: true });
writeFileSync(resolve(ROOT, OUT), JSON.stringify(report, null, 2));
log(`\n已保存：${OUT}`);

child.kill();
ws.close();
setTimeout(() => process.exit(0), 300);
