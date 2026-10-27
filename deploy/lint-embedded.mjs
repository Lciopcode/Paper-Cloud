// @ts-nocheck
/**
 * 论文云 · 自检脚本的**模板字符串守卫**
 * ============================================================================
 * 为什么需要它（同一个坑踩了三次）：
 *
 * `deploy/*.mjs` 里到处是这种结构 —— 把一段代码当字符串塞进浏览器执行：
 *
 *     const x = await ev(`(async () => {
 *       ...
 *     })()`);
 *
 * 于是在这段模板字符串**内部**写一个反引号（最常见的是在注释里给标识符加着重号），
 * 就会把字符串提前切断。症状是 `SyntaxError: missing ) after argument list`，
 * 而且报在**模板开头那一行**（不是真正出问题的那一行），非常难找。
 *
 * 更坑的是：一行里写**两个**反引号时奇偶性不变，于是"数反引号个数"的检查会放过它 ——
 * 但字符串已经被切成两段又接上，解析照样出错。
 *
 * ## 判定规则（收紧过一次：初版把每个模板的收尾行都报出来了，太吵）
 *
 * 模板**内部**的一行：
 *   · 注释行出现反引号            → **错误**（一定是笔误）
 *   · 非注释行，恰好 1 个反引号   → 正常，那是模板的**闭合符**
 *   · 非注释行，≥ 2 个反引号      → 警告，需要人看一眼（可能是 `${}` 里的嵌套模板）
 *
 * 用法：node deploy/lint-embedded.mjs        （检查 deploy/ 下全部 .mjs）
 *      node deploy/lint-embedded.mjs 文件…   （只查指定文件）
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/**
 * 默认要扫的文件。
 *
 * ⚠️ 不只扫 deploy/*.mjs —— `src/three/shaders.ts` 里的 GLSL 也是模板字符串，
 *    而且**真的在那里踩过一次**（给 aCites 写注释时用了反引号）。
 *    凡是有"把代码当字符串"的地方都会中这个坑，所以按扩展名扫整个 src/。
 */
function defaultTargets() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(full);
      } else if (/\.(mjs|ts|tsx|glsl)$/.test(e.name) && !e.name.startsWith("_") && e.name !== "lint-embedded.mjs") {
        out.push(full);
      }
    }
  };
  walk(here);
  walk(resolve(here, "..", "src"));
  for (const d of ["pipeline", "pipeline_gpu"]) {
    const p = resolve(here, "..", d);
    try { walk(p); } catch { /* 目录可能不存在 */ }
  }
  return out;
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaultTargets();

let errors = 0;
let warns = 0;
for (const file of targets) {
  const lines = readFileSync(resolve(file), "utf8").split("\n");
  let inTpl = false;
  let openedAt = 0;
  lines.forEach((line, i) => {
    const ticks = (line.match(/`/g) || []).length;
    if (!inTpl) {
      if (ticks % 2 === 1) {
        inTpl = true;
        openedAt = i + 1;
      }
      return;
    }
    if (ticks === 0) return; // 模板内的普通一行，安全

    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
    if (isComment) {
      console.log(`${file}:${i + 1}  ✗ 模板（起于第 ${openedAt} 行）内的**注释**里出现了反引号`);
      console.log(`    ${line.trim().slice(0, 100)}`);
      errors++;
      if (ticks % 2 === 1) inTpl = false; // 它把模板提前结束了
      return;
    }
    if (ticks === 1) {
      inTpl = false; // 正常的闭合符
      return;
    }
    console.log(`${file}:${i + 1}  ⚠ 模板（起于第 ${openedAt} 行）内的非注释行有 ${ticks} 个反引号`);
    console.log(`    ${line.trim().slice(0, 100)}`);
    warns++;
    if (ticks % 2 === 1) inTpl = false;
  });
  if (inTpl) {
    console.log(`${file}: ✗ 第 ${openedAt} 行开始的模板没有闭合`);
    errors++;
  }
}

if (errors === 0 && warns === 0) {
  console.log(`✓ 检查了 ${targets.length} 个文件，模板字符串内没有可疑的反引号`);
  process.exit(0);
}
if (errors > 0) {
  console.log(`\n✗ ${errors} 处错误 —— 这会让语法检查报在**模板开头那一行**，很难定位。`);
  process.exit(1);
}
console.log(`\n⚠ ${warns} 处需要人工确认（非注释行里的多个反引号）。`);
process.exit(0);
