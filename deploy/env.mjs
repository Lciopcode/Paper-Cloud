// @ts-nocheck
/**
 * 论文云 · 读 `.env.local`（本地密钥）
 * ============================================================================
 * 只做一件事：把 `lunyun/.env.local` 里的 `KEY=VALUE` 塞进 `process.env`（**不覆盖已有的**）。
 *
 * ## 为什么自己写三行，不装 dotenv
 *
 * 只用得到三个变量（`S2_API_KEY` / `OPENALEX_API_KEY` / `OPENALEX_MAILTO`），
 * 为它引一个依赖不值得；而且这样没有"生产构建里悄悄读 .env"的可能
 * —— 这个项目是纯静态前端 + 本地服务器，密钥只在服务端脚本里用。
 *
 * ## 为什么绝不打印值
 *
 * 密钥一旦进了日志（`console.log(process.env)`、异常栈、CI 输出）就等于泄露。
 * 这里只在**读到了**的时候打印"已加载"，打印长度都不打印内容。
 *
 * ## 用户自带 key（BYOK）
 *
 * 这里的值只是**内置默认值**；`deploy/api-refs.mjs` 会优先使用请求头里
 * 用户自己贴进来的 key（`x-user-s2-key` / `x-user-openalex-key`）。
 * 所以 `.env.local` 里没有 key 也能跑 —— 用户可以在界面里提供。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(here, "..", ".env.local");

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  if (!existsSync(FILE)) return;
  for (const raw of readFileSync(FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    /**
     * 去掉包裹字符：引号 + 尖括号。
     *
     * ⚠️ 尖括号这一条是**实测踩出来的**：模板里写的是
     * `S2_API_KEY=<在这里粘贴你的key>`，作者很自然地把 key 填在**尖括号里面**
     * （`<abc123…>`）。第一版判据是"以 < 开头就算占位符"，于是 key 明明填了
     * 却被当成没填，报"没读到"。
     * 正确判据是"**去掉包裹之后**还像不像占位符"，而不是"以什么字符开头"。
     */
    v = v.replace(/^["'<]+|["'>]+$/g, "").trim();
    if (!v) continue;
    if (!process.env[k]) process.env[k] = v;
    if (k === "S2_API_KEY" || k === "OPENALEX_API_KEY") console.log(`  ✓ 已从 .env.local 读到 ${k}`);
  }
}

/** 取密钥（没有就返回空串，调用方据此走匿名 / 降级） */
export function s2Key() {
  loadEnv();
  return process.env.S2_API_KEY ?? "";
}

/** OpenAlex key（可选；没有就用匿名额度）。OpenAlex 用 `api_key` 查询参数，不是请求头。 */
export function openAlexKey() {
  loadEnv();
  return process.env.OPENALEX_API_KEY ?? "";
}

/**
 * OpenAlex 的"礼貌池"邮箱（可选）。
 * 默认给一个占位地址：OpenAlex 允许匿名 + mailto 的礼貌用法；
 * 用户可以在「数据源」面板里填自己的邮箱（会随请求头带给本地服务）。
 */
export function openAlexMailto() {
  loadEnv();
  return process.env.OPENALEX_MAILTO ?? "papercloud@example.com";
}
