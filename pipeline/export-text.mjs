#!/usr/bin/env node
/**
 * 论文云 · 语料导出（v1 SQLite → 可搬迁 JSONL）
 * ============================================================================
 * 为什么需要这一步：GPU 那台机器只需要**标题与摘要**，不应该让它扛 10.7 GB 的 SQLite。
 * 导出成按学科分文件的 gzip JSONL（约 2 GB），搬过去就能直接跑 embedding。
 *
 * 输入：`<v1>/data/corpus/domain_<id>.db`（表 papers，见 v1 的 build-corpus.mjs）
 * 输出：`text/<id>.jsonl.gz` + `text/manifest.json`
 *
 * 用法：
 *   node pipeline/export-text.mjs --limit 2000        # 每学科只导 2000 条（试跑）
 *   node pipeline/export-text.mjs                     # 全量
 *   node pipeline/export-text.mjs --force             # 覆盖已有产物
 *
 * 设计要点：
 *   · **流式**：用 sqlite 的 iterate() 逐行读、逐行写 gzip，内存恒定（305 万篇不会 OOM）。
 *   · **幂等**：产物已存在且未加 --force 时跳过，避免重复 2 GB 写入。
 *   · **可校验**：写完后统计并写进 manifest（篇数、字节数、字段完整率）。
 */
import { DatabaseSync } from "node:sqlite";
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DOMAINS } from "../src/data/domains.ts";
import { venueInfo } from "../src/data/venue.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = join(ROOT, "text");

/**
 * 语料库位置。
 *
 * ⚠️ 本项目**不复制** 10.7 GB 语料，而是引用 v1 里已建好的那一份（`../../lunyun/data/corpus`）。
 * 理由：语料可由 pipeline 完整重建（arXiv 抓取 78 分钟 + 分桶 12 分钟），
 * 复制一份只浪费磁盘，还会让"哪一份是权威"变含糊。
 * 搬到别的机器时用 `--corpus` 指过去即可。
 */
const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
/**
 * 解析语料库目录。
 * ============================================================================
 * ## 为什么要"依次尝试多个候选位置"而不是只认一个
 *
 * 开发机上的布局是：
 *
 *     D:\new C\研云\研云\
 *     ├── lunyun\data\corpus\        ← 语料（5.4 GB，不可再生）
 *     └── v2\lunyun\                  ← 仓库
 *
 * 于是默认路径写成 `<仓库>/../../lunyun/data/corpus`。但**交接包的布局不一样**：
 *
 *     交付到4090\
 *     ├── lunyun\      ← 仓库
 *     └── corpus\      ← 语料
 *
 * 只认一个默认路径的话，包里就跑不起来 —— 而报错是"找不到数据库文件"，
 * 看起来像数据丢了，不像"路径不对"。**换机器时这是硬阻断**（实测踩过）。
 *
 * 所以按候选列表依次找，找到就用；一个都找不到时报出**试过哪些路径**。
 *
 * @param explicit 命令行 `--corpus` 给的值（最优先，不做任何猜测）
 */
function resolveCorpus(explicit) {
  if (explicit) return resolve(explicit);
  const candidates = [
    // 开发机布局：<仓库>/../../lunyun/data/corpus
    join(ROOT, "..", "..", "lunyun", "data", "corpus"),
    // 交接包布局：<仓库>/../corpus
    join(ROOT, "..", "corpus"),
    // 仓库上一级旁的 corpus/
    join(ROOT, "..", "..", "corpus"),
    // 仓库内的 corpus/（有人习惯把数据放项目里）
    join(ROOT, "corpus"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return resolve(candidates[0]); // 都不存在时指向最可能的位置，让下面的报错有意义
}


const CORPUS = resolveCorpus(argVal("--corpus", null));
const LIMIT = Number(argVal("--limit", "0")) || Infinity;
const FORCE = args.includes("--force");
const ONLY = argVal("--domain", null);

const log = (...a) => console.log(...a);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * 一行 JSONL 的字段选择原则：**GPU 与前端都需要的才带**。
 *   id/title/abstract —— 语义层与展示的核心
 *   authors            —— 展示（作者列表）与将来的作者维度分析
 *   cats/primaryCat    —— 层级骨架（arXiv 分类，与 OpenAlex 层级交叉验证）
 *   year               —— 三种排列模式的"时间顺序"依据
 *   cites              —— 引用次数（**实测全库为 0，从未填充过**；留着是为了将来接了
 *                          Semantic Scholar / OpenAlex 之后不用改格式）
 *   venueTier / venue  —— 发表去处等级与去处名（"星球大小"的依据，见 src/data/venue.ts）
 *
 * ⚠️ `venueTier` 必须由本脚本**算好再写**，不能把 `journal_ref` / `comments` 原文带上：
 *    实测物理团 44% 有 journal_ref、92% 有 comments，原文合计约 400 MB，
 *    而分级结果只有 1 字节 + 十来字节的去处名。前端要的是结论，不是原文。
 *
 * 刻意**不**带 doi / license / report_no / msc —— 展示用不上，省体积。
 */
function rowToRecord(row, cites) {
  const authors = safeJson(row.authors);
  const cats = safeJson(row.cats);
  // 评级依据：journal_ref 是"发表在哪"的直接证据；comments 常写
  // "accepted at NeurIPS" / "to appear in PRL" 这类同样有效的信息。
  const venueText = `${row.journal_ref ?? ""} ${row.comments ?? ""}`.trim();
  const info = venueInfo(venueText);
  return {
    id: row.id,
    title: row.title ?? "",
    abstract: row.abstract ?? "",
    authors,
    cats,
    primaryCat: row.primary_cat ?? "",
    year: Number(String(row.created ?? "").slice(0, 4)) || 0,
    cites,
    venueTier: info.tier,
    venue: info.zh || shortVenue(row.journal_ref),
  };
}

/**
 * 识别不出等级时，退而显示 journal_ref 的**开头**（截短）。
 * 这样界面至少能显示"Journal of Physics A"这种真实去处，
 * 而不是一片空白 —— 但**不**因此提高等级（等级只由规则表决定）。
 */
function shortVenue(journalRef) {
  const s = String(journalRef ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 48) : "";
}

function safeJson(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 读 v1 的引用分片（若存在）。
 * 格式：magic "LUNYCITE"(8) | count(u32) | 每条 8 字节（u32 cites | u8 venueTier | u8 citeTier | u16 保留）
 * 顺序 = docId 顺序 = (created, id) 排序，与导出顺序一致，因此可以直接按下标取。
 */
async function loadCitations(domId) {
  const p = join(ROOT, "..", "lunyun", "data", "citations", `${domId}.bin`);
  if (!existsSync(p)) return null;
  const { readFileSync } = await import("node:fs");
  const buf = readFileSync(p);
  if (buf.subarray(0, 8).toString("ascii") !== "LUNYCITE") return null;
  return buf.subarray(12);
}

async function exportDomain(dom) {
  const dbPath = join(CORPUS, `domain_${dom.id}.db`);
  if (!existsSync(dbPath)) {
    log(`  跳过 ${dom.id}（无 ${dbPath}）`);
    return null;
  }
  const outPath = join(OUT, `${dom.id}.jsonl.gz`);
  if (existsSync(outPath) && !FORCE) {
    const size = statSync(outPath).size;
    log(`  跳过 ${dom.id}（已有 ${mb(size)}，加 --force 覆盖）`);
    return { id: dom.id, file: `${dom.id}.jsonl.gz`, bytes: size, skipped: true };
  }

  const cites = await loadCitations(dom.id);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const total = db.prepare("SELECT COUNT(*) AS n FROM papers").get().n;
  const take = Math.min(LIMIT, total);

  let n = 0;
  let withAbstract = 0;
  let withCites = 0;
  let bytes = 0;
  let minYear = 9999;
  let maxYear = 0;
  const t0 = Date.now();

  async function* lines() {
    const rows = db.prepare("SELECT * FROM papers ORDER BY created, id").iterate();
    let docId = 0;
    for (const row of rows) {
      if (n >= take) break;
      const c = cites && docId * 8 + 8 <= cites.length ? cites.readUInt32LE(docId * 8) : 0;
      const rec = rowToRecord(row, c);
      if (rec.abstract) withAbstract++;
      if (c > 0) withCites++;
      if (rec.year > 0) {
        if (rec.year < minYear) minYear = rec.year;
        if (rec.year > maxYear) maxYear = rec.year;
      }
      n++;
      docId++;
      yield JSON.stringify(rec) + "\n";
    }
  }

  mkdirSync(OUT, { recursive: true });
  await pipeline(Readable.from(lines()), createGzip({ level: 6 }), createWriteStream(outPath));
  db.close();

  bytes = statSync(outPath).size;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(
    `  ${dom.id.padEnd(8)} ${n.toLocaleString().padStart(10)} 篇 · ${mb(bytes).padStart(9)} · ` +
      `摘要 ${((100 * withAbstract) / Math.max(1, n)).toFixed(1)}% · 有引用 ${((100 * withCites) / Math.max(1, n)).toFixed(1)}% · ` +
      `${minYear || "-"}–${maxYear || "-"} · ${secs}s`,
  );
  return {
    id: dom.id,
    zh: dom.zh,
    file: `${dom.id}.jsonl.gz`,
    bytes,
    papers: n,
    withAbstract,
    withCites,
    minYear: minYear === 9999 ? 0 : minYear,
    maxYear,
  };
}

async function main() {
  const list = ONLY ? DOMAINS.filter((d) => d.id === ONLY) : DOMAINS;
  if (!list.length) throw new Error(`未知学科 ${ONLY}`);
  log(`语料库：${CORPUS}`);
  log(`导出到：${OUT}${LIMIT === Infinity ? "" : `（每学科限 ${LIMIT} 条）`}`);
  const out = [];
  for (const dom of list) {
    const r = await exportDomain(dom);
    if (r) out.push(r);
  }
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    limit: LIMIT === Infinity ? null : LIMIT,
    domains: out,
    totalPapers: out.reduce((a, d) => a + (d.papers ?? 0), 0),
    totalBytes: out.reduce((a, d) => a + (d.bytes ?? 0), 0),
  };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(
    `\n合计 ${manifest.totalPapers.toLocaleString()} 篇 · ${mb(manifest.totalBytes)} · manifest.json 已写`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
