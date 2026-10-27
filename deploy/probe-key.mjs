/**
 * 探针：确认 env.mjs 能读到 .env.local 里的 key（**只打印长度，不打印密钥**）。
 */
import { s2Key } from "./env.mjs";

const k = s2Key();
console.log(k && k.length > 20 ? `✓ 读到 key（长度 ${k.length}）` : "✗ 没读到 key（检查 .env.local）");
