/**
 * 浏览器可执行文件的位置解析（自检脚本共用）
 * ============================================================================
 * ## 为什么需要它
 *
 * 11 个自检脚本原本各自硬编码 `D:\\chrome\\Application\\chrome.exe` ——
 * **那在开发这台机器上能跑、换台机器就断**，而且报错是
 * "spawn ENOENT"，看起来像脚本坏了，而不像"浏览器不在那个路径"。
 * 交接给别的机器时这是硬阻断。
 *
 * ## 解析顺序（从最明确到最宽松）
 *
 *   1. `--chrome <路径>` 命令行参数（最明确，优先）
 *   2. 环境变量 `CHROME_PATH`（适合在 CI 或另一台机器上一次性设好）
 *   3. 常见安装位置（Chrome 各版本路径 + Edge 作为备选）
 *   4. Windows 注册表里 Chrome 的安装路径
 *   5. PATH 里的 `chrome` / `msedge`
 *
 * 找不到就**抛一个说清尝试过哪些路径的错误** —— 而不是让 `spawn` 抛
 * 一个看不出原因的 ENOENT。
 *
 * 为什么把 Edge 也作为备选：两者都是 Chromium 内核，
 * 自检用到的 CDP 接口与 WebGL 行为一致。
 *
 * ⚠️ 关于 Edge 的一段历史结论（**已被实测推翻，留档以免再传错**）：
 *    有一次的记录写着"Edge 在本机不能用于自检 —— 四种参数组合下 /json/list
 *    一个目标都不返回"。后来实测（Edge 155）发现**Edge 的 CDP 完全可用**，
 *    四种组合都返回 6 个目标；当时失败的真因是**别的**东西：
 *    `--user-data-dir` 用了**相对路径**，而相对路径下 Edge 会静默忽略
 *    `--remote-debugging-port`（详见下面 `profileDir()` 的说明）。
 *    所以"换个浏览器"是错误的方向 —— 参数才是。
 */
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 常见安装位置。顺序 = 优先尝试顺序。 */
const CANDIDATES = [
  // Chrome
  "D:\\chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    : null,
  // Edge（Chromium 内核，同样支持本项目用到的 CDP 与 WebGL）
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`
    : null,
].filter(Boolean);

/** 从注册表问 Chrome 装在哪（覆盖非默认安装盘）。 */
function fromRegistry() {
  if (process.platform !== "win32") return null;
  for (const hive of ["HKLM", "HKCU"]) {
    for (const key of [
      `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`,
      `${hive}\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`,
    ]) {
      try {
        const out = execFileSync("reg", ["query", key, "/ve"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const m = out.match(/REG_SZ\s+(.+\.exe)/i);
        if (m && existsSync(m[1].trim())) return m[1].trim();
      } catch {
        /* 键不存在，继续 */
      }
    }
  }
  return null;
}

/**
 * 解析浏览器路径。
 * @param {string[]} argv 进程参数（用于读 `--chrome`）
 * @returns {string} 可执行文件的绝对路径
 */
export function resolveBrowser(argv = process.argv) {
  const i = argv.indexOf("--chrome");
  const fromArg = i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  if (fromArg) {
    if (!existsSync(fromArg)) {
      throw new Error(`--chrome 指定的路径不存在：${fromArg}`);
    }
    return fromArg;
  }

  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  for (const c of CANDIDATES) {
    if (existsSync(c)) return c;
  }

  const reg = fromRegistry();
  if (reg) return reg;

  throw new Error(
    "找不到 Chromium 内核的浏览器（Chrome 或 Edge）。\n" +
      "自检需要它做无头渲染。三种解决办法：\n" +
      "  1. 用参数指定：node deploy/verify.mjs --chrome \"<浏览器路径>\"\n" +
      "  2. 设环境变量：set CHROME_PATH=<浏览器路径>\n" +
      "  3. 装一个 Chrome 或 Edge\n" +
      `已尝试过的位置：\n  ${CANDIDATES.join("\n  ")}\n` +
      "  注册表：HKLM/HKCU 的 App Paths\\chrome.exe",
  );
}

/** 自检脚本用的公共 spawn 参数（无头 + 软件渲染，保证在没有独显的机器上也能跑）。 */
export function headlessArgs(extra = []) {
  return [
    "--headless=new",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--no-first-run",
    ...extra,
  ];
}

/**
 * 本次运行专属的浏览器 profile 目录 —— **返回绝对路径，这是硬要求**。
 *
 * ## 为什么必须绝对
 *
 * 8 个自检脚本原本写的是相对路径（`--user-data-dir=shots/_css<时间戳>`）。
 * 实测（Edge 155，Windows）：**相对路径下浏览器完全不做 CDP 监听** ——
 * `/json/version` 与 `/json/list` 都不响应，脚本轮询 36 秒后报
 * "启动浏览器后没找到可调试的页面"，而那句报错把它归因成
 * "该浏览器不支持 --remote-debugging-port → 装一个 Chrome"，
 * **把人引向完全错误的方向**。
 *
 * 隔离实验（同样参数，只改这一项）：
 *
 * | 用例 | `--user-data-dir` | 结果 |
 * |---|---|---|
 * | A | `shots/_probeA`（相对） | ❌ 0 个目标 |
 * | B | 绝对路径 | ✅ 6 个目标 |
 * | C | 相对 | ❌ 0 个目标 |
 * | D | 绝对 | ✅ CDP 正常 |
 * | E | 相对（去掉 --window-size） | ❌ 0 个目标 |
 * | F | 相对（加 --no-default-browser-check） | ❌ 0 个目标 |
 *
 * 所以它与参数组合无关，只看路径是不是绝对。**新脚本一律用这个函数，别自己拼。**
 *
 * @param tag 短标签，用于区分是哪个脚本产生的（如 "css"、"mob"）
 */
export function profileDir(tag) {
  const dir = resolve(ROOT, "shots", `_${tag}${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 轮询等待**应用真的挂载完**，而不是固定 `sleep` 几秒。
 *
 * ## 为什么不能用固定等待
 *
 * 本机是软件渲染（SwiftShader），首次 WebGL 初始化较慢：实测应用挂载**约需 8 秒**。
 * 而自检脚本原来普遍是"连上浏览器 → `sleep(3000)` → 开始读 DOM"。
 * 3 秒时 `document.styleSheets` 还是空的，于是 `verify-css.mjs` 的 9 条判据
 * **全部**报"被 CSS 解析器吞了" —— 一个纯粹由等待不足造成的**假失败**，
 * 而且它的报错方向会让人去查源码里的注释/括号配对，纯属南辕北辙。
 *
 * @param ev   CDP 求值函数 `(expr) => Promise<any>`
 * @param opts.timeoutMs 最长等多久（默认 30 秒）
 * @returns 是否在超时前就绪（调用方应据此决定是否继续，或至少提示结果不可信）
 */
export async function waitForApp(ev, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const probe = `(() => {
    const root = document.getElementById("root");
    const sheets = [...document.styleSheets];
    const hasRules = sheets.some((s) => { try { return s.cssRules.length > 0; } catch { return false; } });
    return !!root && root.children.length > 0 && hasRules;
  })()`;
  while (Date.now() < deadline) {
    if ((await ev(probe)) === true) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * **等画面稳定下来**（连拍两张字节完全相同为止）—— 给"截图之后要拿它做判据"的脚本用。
 *
 * ## 为什么需要它
 *
 * 本项目的自检跑在**软件渲染**上，2~3 fps；而"切画质档 / 移动相机"这类动作会触发
 * 几何体重建（尘埃 12 万↔4.5 万、星野 2.6 万↔1 万），重建期间截到的画是**半截的**。
 *
 * 原来各处都是 `await sleep(3000)` 一刀切。机器一慢（实测全量跑 602 秒 vs 平时 496 秒），
 * 3 秒就不够了 —— 而**这个假失败的方向极其危险**：
 * `verify-bloom` 的判据是"画质档往返之后画面要和第一次逐像素相同"，
 * 如果第二次截图截在重建当中，它就**会在正确的代码上红**，
 * 而它守的恰恰是"切回高画质拿不回辉光"那个真 bug ——
 * **一个会假阳性的回归闸，比没有闸更糟**（会训练人忽略它）。
 *
 * 所以改成问"画面稳了没有"，而不是"过了几秒"：
 * 连拍两张 `Page.captureScreenshot`，字节完全相同才算稳。
 * 静止场景（减少动态效果下）两张必然相同；重建/动画期间必然不同。
 *
 * @param shot 返回 base64 PNG 的函数（通常是 `() => send("Page.captureScreenshot", {format:"png"}).then(r => r?.data)`）
 * @param opts.timeoutMs 最长等多久（默认 15 秒）
 * @param opts.gapMs     两次连拍之间隔多久（默认 350ms）
 * @returns {{ stable: boolean, tries: number, data: string | null }} 最后一帧的 base64 也一并返回，省一次截图
 */
export async function waitStableShot(shot, { timeoutMs = 15000, gapMs = 350 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let prev = await shot();
  let tries = 1;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, gapMs));
    const cur = await shot();
    tries++;
    if (cur && prev && cur === prev) return { stable: true, tries, data: cur };
    prev = cur;
  }
  return { stable: false, tries, data: prev };
}

/**
 * "连不上可调试页面"时报什么 —— 8 个自检脚本共用，避免各写一份且都写错方向。
 *
 * 原来每个脚本都写的是：
 *   "该浏览器不支持 --remote-debugging-port（实测 Edge 在本机不行）→ 装一个 Chrome"
 * 这句话**把人引向错误的方向**：实测 Edge 的 CDP 完全可用，
 * 真因是 `--user-data-dir` 用了相对路径（见 `profileDir()`）。
 * 所以按"实际踩到的概率"重排原因，并把最容易踩的那条放第一位。
 */
export function debugTargetError(browser, port, waitSec, rootDir) {
  return (
    `\n✗ 启动浏览器后 ${waitSec} 秒内没找到可调试的页面（端口 ${port}）。\n` +
    `  浏览器路径：${browser}\n` +
    "  常见原因（按实测踩到的概率排序）：\n" +
    "    1. **--user-data-dir 用了相对路径** → 浏览器会静默忽略 --remote-debugging-port，\n" +
    "       CDP 端口根本不监听（实测：相对路径 0 个目标 · 绝对路径立刻 6 个目标）。\n" +
    "       本仓库统一用 browser.mjs 的 profileDir() 生成绝对路径。\n" +
    "    2. **服务器没起来** → 自检需要一个静态服务在 5311 上：\n" +
    "       node deploy/serve.mjs --port 5311\n" +
    "    3. 端口被别的进程占用 → 换一个（脚本里的 port 常量）\n" +
    "    4. 浏览器路径不对 → 用 --chrome \"<路径>\" 或设 CHROME_PATH\n" +
    (rootDir ? `  仓库根目录：${rootDir}\n` : "")
  );
}

/**
 * 等**八团全量点集都就位**（`runtime[d].full === true`）。
 *
 * ## 为什么每个量像素的自检都得先等它
 *
 * 作者要求"每篇论文一个点、八团全量常驻"之后，`boot()` 会自动串行把八个团
 * 从演示点集换成完整点集。每换一个团，整屏就重建一次几何（物理团 146 万点）。
 * 在这个窗口里截到的任何两张图都**不可比**：
 *
 *   · `verify-bloom` 报"画质档往返之后画面回到原样"差 **17.282**（阈值 1.5），
 *     而那个 17.5 是历史上"辉光丢失"这个真 bug 的指纹 —— 差点被误判成回归；
 *   · `verify-background` 报"打开背景反而让 39% 的像素变暗"，
 *     而真相是那两张图之间恰好有团在换点集。
 *
 * 所以判据必须问"最终会不会就位"，而不是"过 N 秒该就位"。
 */
export async function waitAllFull(ev, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const done = await ev(`(() => {
      const rt = window.__lunyun?.getState?.().runtime ?? {};
      const ids = Object.keys(rt);
      if (ids.length < 8) return false;
      return ids.every((k) => rt[k] && rt[k].full === true);
    })()`);
    if (done === true) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}