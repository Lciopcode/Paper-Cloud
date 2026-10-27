// @ts-nocheck
/**
 * 一次跑完全部自检
 * ============================================================================
 * 为什么需要它：自检脚本已经到 9 个，逐个手敲容易漏 ——
 * 而**漏掉的那个正好是发现问题的那一个**是最坏的情况。
 *
 * 顺序是**从快到慢、从便宜到贵**：
 *   静态检查（秒级）→ 单元测试 → 端到端 → 各专项（每个要起一次无头浏览器）
 *
 * 退出码：任一失败即非零，并列出失败清单。
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

/** 递归算一个目录占多少字节（只为打印"回收了多少"，失败就返回 0）。 */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else total += statSync(p).size;
    } catch { /* 跳过读不到的 */ }
  }
  return total;
}

/** [显示名, 命令, 参数]。顺序 = 执行顺序。 */
const STEPS = [
  ["模板字符串守卫", process.execPath, ["deploy/lint-embedded.mjs"]],
  ["类型检查", process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]],
  ["单元测试", process.execPath, ["node_modules/vitest/vitest.mjs", "run"]],
  ["端到端自检", process.execPath, ["deploy/verify.mjs"]],
  ["面板布局（7 种视口）", process.execPath, ["deploy/verify-layout.mjs"]],
  ["移动端（5 种设备）", process.execPath, ["deploy/verify-mobile.mjs"]],
  ["键盘漫游", process.execPath, ["deploy/verify-keys.mjs"]],
  ["引用亮度", process.execPath, ["deploy/verify-cites.mjs"]],
  /**
   * 自转（**刚性 + 背景差速**）。
   *
   * ⚠️ 这一项**故意不跟着"减少动态效果"走**：那条偏好会把自转角冻结在 0，
   *    而它要验的正是"转不转、各层同不同角"。所以脚本自己显式切到 `no-preference` 再重载
   *    （见 `verify-spin.mjs` 的文件头）。它与"无障碍"那一项是**相反的前提**，别互相抄。
   */
  /**
   * 后期（Bloom）——目标 ③ 的**唯一一道闸**。
   *
   * ⚠️ 它守的是本项目最贵的那类 bug：**`EffectComposer` 的 `enabled` 从 true→false→true
   *    之后不再接管渲染循环**，表现是"几何与 uniform 全对、画面却暗 17.5 的 mean"，**不报错**。
   *    那条 bug 在没人量的情况下活了整整一轮，还把作者挑档用的扫描表整张污染成"没有辉光"的数。
   *
   * ⚠️ 这一条**已经被反向验证过**：把代码临时改回会出 bug 的条件挂载之后，
   *    "往返之后画面回到原样"实测差 **16.787**（阈值 1.5）⇒ 判据变红；
   *    改回来之后差 **0** ⇒ 通过。**判据自己不会骗人，这点必须证明过再留在套件里。**
   */
  ["后期（Bloom）与档位往返", process.execPath, ["deploy/verify-bloom.mjs"]],
  /**
   * 星空尺寸标定（目标 ②）。
   *
   * ⚠️ 它在**低画质档**量：高档开着 bloom，光晕是固定屏幕尺寸的，会把"点本身多大"盖住。
   * ⚠️ 三个距离必须都是"在外面看整簇"（31 / 90 / 280）——
   *    拿"团内"和"团外"比面积比的是构图，不是尺寸（第一版就栽在这）。见脚本注释。
   */
  ["星空尺寸标定", process.execPath, ["deploy/verify-star-size.mjs"]],
  ["自转刚性与差速", process.execPath, ["deploy/verify-spin.mjs"]],
  /**
   * 关系线的生命周期 / 脉冲 / 端点淡出（目标 ⑤）。
   *
   * ⚠️ 它从 `_scratch/probe-filaments.mjs` 提升上来，因为**已经被一次真实回归悄悄打坏过**：
   *    后来加的常驻关系线场也带 `aT`、也是 lineSegments，于是探针认错了对象，
   *    输出"取消选中后线不淡出"——产品是对的，探针错了。那种事必须由常驻自检兜住。
   */
  ["关系线生命周期", process.execPath, ["deploy/verify-filaments.mjs"]],
  /**
   * 背景层开关（作者新增：「你现在把背景隐藏掉，增加背景隐藏功能」）。
   *
   * ⚠️ 这一条**已经被反向验证过**：把 `<group visible={!hideBg}>` 改成 `visible={true}` 之后，
   *    "默认状态就是隐藏背景"、"打开背景之后有一批像素真的变亮"（实测 **0%**）、
   *    "再关一次状态正确" 三项一起变红；改回来之后全绿。
   * ⚠️ 判据不是比 mean 的高低，而是**逐像素差分**：`removedPct`（打开背景反而变暗的像素）
   *    必须近似 0 —— 那是"关多了"的指纹。第一版比 mean，实测比值 1.06，红在了尺子上不是产品上。
   */
  /**
   * 引用功能（作者要求的 ②：点星 → 引用线 → 标题 + 中文译名 + 跳转）。
   *
   * 两段：A 段直接读资产（不经浏览器）挡"格式/布局写错"，B 段验渲染（注入受控输入）。
   *
   * ⚠️ B 段第一版红过，而**红的不是产品**：注入之后 `loadCiteRefs` 才落定，
   *    把注入的 3 条覆盖成真实的 0 条 ⇒ 面板 0 行。修法是"先在源头等它落定再注入"。
   *    这是"等固定时长再断言"的变体：这次不是时长问题，是**注入的对象后来被别人改了**。
   */
  ["引用列表与中文译名", process.execPath, ["deploy/verify-citations.mjs"]],
  ["CSS 结构（CSSOM）", process.execPath, ["deploy/verify-css.mjs"]],
  ["研究方向下潜", process.execPath, ["deploy/verify-drill.mjs"]],
  ["性能与降级", process.execPath, ["deploy/verify-perf-auto.mjs"]],
  ["永久链接", process.execPath, ["deploy/verify-permalink.mjs"]],
  ["无障碍（减少动态效果）", process.execPath, ["deploy/verify-a11y.mjs"]],
];

/**
 * 跑一步。
 *
 * ⚠️ 用 `stdio: "inherit"` 而不是默认的 pipe。
 *    在受限沙箱下，通过管道捕获子进程输出会得到 EPERM；
 *    而这里本来也不需要解析输出 —— 只看退出码 + 自己抓"结论"那一行。
 *    代价是子脚本的输出直接进终端（信息更全，反而更好）。
 */
function runStep(name, cmd, args) {
  return new Promise((res) => {
    const t0 = Date.now();
    process.stdout.write(`\n${"─".repeat(70)}\n▶ ${name}\n`);
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.on("close", (code) => {
      res({ name, code, secs: (Date.now() - t0) / 1000 });
    });
    child.on("error", (e) => {
      process.stdout.write(`  ✗ 启动失败：${e.message}\n`);
      res({ name, code: 127, secs: 0 });
    });
  });
}

const only = process.argv.slice(2);
const steps = only.length ? STEPS.filter((s) => only.some((o) => s[0].includes(o))) : STEPS;

/*
 * ---------------------------------------------------------------------------
 * 服务器管理：10 个浏览器自检都需要 5311 上有一个静态服务。
 *
 * ⚠️ 原来这一步**必须手动先做**（文档里写着 `node deploy/serve.mjs --port 5311`），
 *    忘了做的话，10 个浏览器自检会以「启动浏览器后 36 秒内没找到可调试的页面」
 *    失败 —— 而这个症状与"--user-data-dir 用了相对路径"**一模一样**，
 *    于是很容易误诊成浏览器有问题、去折腾浏览器，而真正的原因只是服务器没起。
 *    （实测：第一次跑 verify-all 就是这么得到 3/13 的，而数据与代码都是好的。）
 *
 * 现在改成自动：先探测 5311，已经有服务就沿用（**不动别人起的进程**），
 * 没有就自己拉起来，跑完再收掉自己起的那个。
 * ---------------------------------------------------------------------------
 */
const SERVE_PORT = 5311;
const SERVE_URL = `http://127.0.0.1:${SERVE_PORT}/manifest.json`;

async function serverAlive() {
  try {
    const ctl = AbortSignal.timeout(1500);
    const r = await fetch(SERVE_URL, { signal: ctl });
    return r.ok;
  } catch {
    return false;
  }
}

let serverChild = null;
let startedServer = false;

if (await serverAlive()) {
  console.log(`检测到 ${SERVE_PORT} 上已有服务，沿用它（不会动它）。`);
} else {
  console.log(`${SERVE_PORT} 上没有服务，自动启动 deploy/serve.mjs …`);
  serverChild = spawn(process.execPath, ["deploy/serve.mjs", "--port", String(SERVE_PORT)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  startedServer = true;
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serverAlive()) { ok = true; break; }
  }
  if (!ok) {
    console.error(`✗ 自动启动服务器失败（${SERVE_URL} 无响应）。请手动跑：node deploy/serve.mjs --port ${SERVE_PORT}`);
    serverChild.kill();
    process.exit(1);
  }
  console.log("服务器已就绪。");
}

console.log(`将运行 ${steps.length} 项自检（沙箱下子进程输出直接进终端）`);
const results = [];
for (const [name, cmd, args] of steps) {
  results.push(await runStep(name, cmd, args));
}

if (startedServer && serverChild) {
  serverChild.kill();
  console.log(`\n（已收掉本次自动启动的服务器，端口 ${SERVE_PORT}）`);
}

/*
 * ---------------------------------------------------------------------------
 * 清理无头浏览器的 profile 残骸。
 *
 * 每跑一次自检，浏览器都会在 `shots/_<tag><时间戳>` 留下一个 profile 目录。
 * 一轮 13 项里 11 项要开浏览器，实测**每个 profile 约 100–250 MB**，
 * 于是一轮就是 **1.5–2 GB**。文档里写了"shots/_* 可随时删"，
 * 但没人会记得手动删 —— 实测接手时 `shots/` 已经攒到 **6.4 GB / 44 个 profile**
 * （交付清单上写的是 16 MB，差了 400 倍）。
 *
 * 所以在这里收尾自动清掉：**只删 `_` 开头的目录**，`shots/*.png` 那些
 * 截图留证一个都不动。清不掉也只是打印一行提示，不影响退出码。
 * ---------------------------------------------------------------------------
 */
try {
  const shotsDir = join(ROOT, "shots");
  if (existsSync(shotsDir)) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let freed = 0;
    let removed = 0;
    const skipped = [];
    for (const name of readdirSync(shotsDir)) {
      if (!name.startsWith("_")) continue;            // 截图 .png 一律保留
      const p = join(shotsDir, name);
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch { continue; }
      const size = dirSize(p);
      // ⚠️ **必须重试。** 最后一项自检的浏览器这时往往**还在退出中**，
      //    profile 里的文件仍被占用，`rmSync` 会抛 EBUSY/EPERM。
      //    原来这里一句 `catch {}` 就当没这回事 —— 后果是每轮**固定漏掉最后一个 profile**
      //    （实测漏了 90.2 MB / 420 个文件），而打印出来只有"已清理 10 个"，
      //    **泄漏是静默的**。所以：重试几次，并把没删掉的**明确报出来**。
      let ok = false;
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        try {
          rmSync(p, { recursive: true, force: true });
          ok = true;
        } catch {
          await sleep(400);
        }
      }
      if (ok) {
        freed += size;
        removed++;
      } else {
        skipped.push(`${name}（${(size / 1e6).toFixed(1)} MB）`);
      }
    }
    if (removed) {
      console.log(`\n（已清理 ${removed} 个浏览器 profile，回收 ${(freed / 1e6).toFixed(1)} MB）`);
    }
    if (skipped.length) {
      console.log(`（${skipped.length} 个 profile 重试 5 次仍被占用，未删除：${skipped.join("、")}` +
        `\n  下次运行会再试；也可以直接删 shots\\_* —— 它只影响磁盘占用，不影响结论）`);
    }
  }
} catch { /* 清理失败不影响结论 */ }

console.log(`\n${"═".repeat(70)}\n汇总\n`);
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${r.name.padEnd(24)} ${r.secs.toFixed(1).padStart(7)}s${ok ? "" : `   退出码 ${r.code}`}`);
}
const total = results.reduce((a, r) => a + r.secs, 0);
console.log(`\n  ${results.length - failed}/${results.length} 通过 · 合计 ${total.toFixed(0)}s`);
if (failed) {
  console.log(`\n结论：✗ ${failed} 项失败 —— 上面有 ✗ 的那几项的**具体数值**才是线索，别只看结论行。`);
  process.exit(1);
}
console.log(`\n结论：✓ 全部通过`);
