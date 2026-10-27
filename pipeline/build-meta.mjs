// @ts-nocheck
/**
 * 论文云 · 论文元数据索引
 * ============================================================================
 * 产出（三个文件，配合 HTTP Range 使用）：
 *
 *   1. `public/data/meta/<domain>.idx.bin`   定长索引，**按 docId O(1) 随机访问**
 *   2. `public/data/meta/<domain>.txt.bin`   文本池（标题 + 作者），UTF-8
 *   3. `public/data/meta/<domain>.abs.bin`   摘要池（UTF-8，**按需用 Range 取**）
 *
 * ## 为什么不整份给浏览器
 *
 * 标题 188 MB + 摘要 2.1 GB + 作者 ≈ 2.5 GB。整份下载不可能，
 * 但"点开一篇论文看它的标题/作者/摘要"只需要几百字节。
 * 所以这两件事一起做：
 *   · 定长索引 ⇒ 给定 docId，**直接算出偏移**，不需要任何查找；
 *   · 文本池**不压缩** ⇒ 服务器按 `Range` 头返回精确字节区间，浏览器只取需要的那一段。
 *
 * 为什么不用 gzip/brotli 压文本池：压缩后无法随机访问（必须先解压前面全部内容）。
 * 实测：物理团 146 万篇 × 平均 128 字节标题+作者 ≈ 190 MB，
 * 单次点开只取其中 300 字节 —— 不压缩换来 O(1) 随机访问，这个取舍是值得的。
 *
 * ## 索引记录布局（48 字节）
 *
 *   docId(u32) | titleOff(u32) | titleLen(u16) | absOff(u32) | absLen(u32)
 *   | year(u16) | cites(u32) | venueTier(u8) | authorCount(u8) | flags(u8) | 保留(u8)
 *   | titleHead: 17 字节（标题前缀，UTF-8 截断）
 *
 * `titleHead` 是为了**首屏零请求**：点开一颗星时先用这 17 字节立刻出字，
 * 完整标题随后从文本池补齐。17 字节能覆盖绝大多数标题的开头，
 * 足以让"面板立刻有内容"而不是空着等网络。
 *
 * 为什么用 **docId 做下标**：与 `spine.bin`、`rank.bin`、`nbr.bin` 完全一致，
 * 全文只有一套索引约定，不会出现"这里按 docId、那里按记录号"的错位。
 *
 * 用法：node pipeline/build-meta.mjs [--domain physics] [--limit 100000]
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zc, createGunzip } from "node:zlib";

import { DOMAINS } from "../src/data/domains.ts";
// 年份范围从布局模块导入 —— **单一事实来源**：时间排列模式的刻度与此处的直方图
// 必须用同一个范围，否则环的位置与直方图的区间会对不上（而且是静默错位）。
import { YEAR_MAX, YEAR_MIN } from "../src/three/layout.ts";
import { stratumPath } from "../src/data/hierarchy.ts";


const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const TEXT = join(ROOT, "text");
const OUT = join(ROOT, "public", "data", "meta");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ONLY = argVal("--domain", null);
const LIMIT = Number(argVal("--limit", "0")) || Infinity;

/**
 * 索引记录长度。改动时必须同步 `src/data/assets.ts` 的 `META_REC_BYTES`。
 *
 * 布局（64 字节，逐字段显式偏移，避免对齐歧义）：
 *   0  docId(u32)        4  titleOff(u32)     8  titleLen(u16)
 *   10 absOff(u32)       14 absLen(u32)       18 year(u16)
 *   20 cites(u32)        24 venueTier(u8)     25 authorCount(u8)
 *   26 flags(u8)         27 venueLen(u8)      28 venueOff(u32)
 *   32 titleHead(17B)    49 保留(4B)          53 venueHead(11B)
 */
const REC = 64;
/** 标题前缀字节数（放在记录里，用于"零请求先出字"） */
const HEAD = 17;
/** 去处名前缀字节数（界面直接显示"PRL"这类短名，不必再取一次） */
const VENUE_HEAD = 11;
// 年份范围从 ../src/three/layout.ts 导入（见文件头的 import 说明）

function log(m) {
  process.stdout.write(`${m}\n`);
}

/** 按 UTF-8 边界安全截断到最多 n 字节。 */
function utf8Slice(s, n) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= n) return buf;
  // 从 n 往前找到第一个不在多字节序列中间的位置
  let end = n;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

function buildDomain(domain) {
  const file = join(TEXT, `${domain}.jsonl.gz`);
  if (!existsSync(file)) {
    log(`  跳过 ${domain}（无 ${file}）`);
    return null;
  }
  const t0 = Date.now();

  // 第一遍：只知道篇数会更好，但为了省一次全量解压，这里用可增长的 Buffer 列表
  const idxChunks = [];
  const txtChunks = [];
  const absChunks = [];
  /** 去处名池（很短，但单独一池，界面把"标题"与"去处"当两个字段用） */
  const venChunks = [];
  let idxLen = 0;
  let txtLen = 0;
  let absLen = 0;
  let venLen = 0;

  let rec = Buffer.alloc(REC);
  let docId = 0;
  let withAbs = 0;
  let withVenue = 0;
  let citeNonZero = 0;
  let noTitle = 0;
  const tierHist = new Uint32Array(8);
  const yearHist = new Map();
  /** L3 层 id → 年份直方图（超新星遗迹的依据；见上面统计处的说明） */
  const stratumYearHist = new Map();

  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()) });
  const lines = (async () => {
    for await (const line of rl) {
      if (!line) continue;
      if (docId >= LIMIT) break;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // 坏行跳过（与 build-spine 的处理一致，保证 docId 对齐）
      }

      const title = String(r.title ?? "").replace(/\s+/g, " ").trim();
      if (!title) noTitle++;
      const authors = Array.isArray(r.authors) ? r.authors.join(", ") : String(r.authors ?? "");
      const abs = String(r.abstract ?? "").replace(/\s+/g, " ").trim();

      // ---- 文本池：标题 \n 作者 \n ----
      const tb = Buffer.from(`${title}\n${authors}\n`, "utf8");
      const titleLen = utf8Slice(title, 0xffff).length; // titleLen 只记标题，作者跟在后面
      const titleOff = txtLen;
      txtChunks.push(tb);
      txtLen += tb.length;

      // ---- 摘要池 ----
      let absOff = 0xffffffff;
      let absLenField = 0;
      if (abs) {
        const ab = Buffer.from(`${abs}\n`, "utf8");
        absOff = absLen;
        absLenField = ab.length;
        absChunks.push(ab);
        absLen += ab.length;
        withAbs++;
      }

      // ---- 年份 / 评级 ----
      const year = Number.isFinite(r.year) ? Math.max(0, Math.min(65535, r.year | 0)) : 0;
      yearHist.set(year, (yearHist.get(year) ?? 0) + 1);
      // 按 **L3 层**再统计一次：这是"超新星遗迹"的依据 ——
      // 只有分层的直方图才能回答"**哪个研究方向**在什么时候爆发"，
      // 全团合在一起只会看到一条平滑的指数曲线，看不出任何"爆发"。
      if (year >= YEAR_MIN && year <= YEAR_MAX) {
        // ⚠️ 必须传**真实的学科 id**（`domain`），不能传空串 ——
        // 层 id 的格式是 `${domain}/${arch}/${sub}`，与 build-spine.mjs 写进编号表的
        // 那一份**必须逐字一致**。曾经这里传了 ""，于是层 id 变成 `/eess/iv`，
        // 而 manifest.strata 里是 `eess/eess/iv`，前端查不到层、
        // 报"找不到层 /eess/iv"（实测踩过）。两处各写一遍约定就一定会不一致。
        const key = stratumPath(domain, r.primaryCat ?? "").l3;
        let h = stratumYearHist.get(key);
        if (!h) {
          h = new Uint32Array(YEAR_MAX - YEAR_MIN + 1);
          stratumYearHist.set(key, h);
        }
        h[year - YEAR_MIN]++;
      }
      // 评级由 export-text.mjs 算好写在 JSONL 里（那里能拿到 journal_ref / comments 原文，
      // 而导出时已经把原文压成一个字节 + 一个短去处名，不必在这里重算）。
      const tier = Number.isFinite(r.venueTier) ? Math.max(0, Math.min(255, r.venueTier | 0)) : 0;
      tierHist[tier]++;
      if (tier > 0) withVenue++;
      const cites = Number.isFinite(r.cites) ? Math.max(0, r.cites | 0) : 0;
      if (cites > 0) citeNonZero++;

      // ---- 去处名池（很短：多为 "PRL" "Phys. Rev. D" "NeurIPS" 之类）----
      // 单独放一个小池而不是并入标题池：界面要把"标题"与"去处"当两个字段用，
      // 合并存储会让读取端必须知道偏移才能切开。
      // 必须 trim：去处名可能是纯空白（识别不出但 journal_ref 有空格），
      // 不 trim 就会在界面上显示一个空白的"发表"徽标。
      const venueName = String(r.venue ?? "").replace(/\s+/g, " ").trim();
      const vb = Buffer.from(venueName, "utf8");
      const venueOff = venLen;
      const venueLenField = Math.min(255, vb.length);
      // flags（见下方 writeUInt8(venueFlags, 26) 的说明）
      const cats = Array.isArray(r.cats) ? r.cats : [];
      const venueFlags = (cats.length > 1 ? 1 : 0) | (tier > 0 ? 2 : 0);
      if (vb.length) {
        venChunks.push(vb);
        venLen += vb.length;
      }

      // ---- 写索引记录 ----
      const head = utf8Slice(title, HEAD);
      const vhead = utf8Slice(venueName, VENUE_HEAD);
      rec.fill(0);
      rec.writeUInt32LE(docId, 0);
      rec.writeUInt32LE(titleOff, 4);
      rec.writeUInt16LE(titleLen, 8);
      rec.writeUInt32LE(absOff, 10);
      rec.writeUInt32LE(absLenField, 14);
      rec.writeUInt16LE(year, 18);
      rec.writeUInt32LE(cites, 20);
      rec.writeUInt8(tier, 24);
      rec.writeUInt8(Math.min(255, Array.isArray(r.authors) ? r.authors.length : 0), 25);
      // flags 位约定（与前端 `src/data/assets.ts` 的 MetaReader.flagsOf 对应）：
      //   bit0 = 交叉列表（挂了多个 arXiv 分类）—— 即"跨学科论文"
      //   bit1 = 有正式发表去处（venueTier > 0）
      //
      // 为什么值得占位：有了这两个位，前端**不必解析任何文本**就能筛出"跨学科论文"这一群体，
      // 于是"星尘流"（把构成星桥的那些论文高亮出来）可以零额外请求实现 ——
      // 否则要么重跑一遍语料，要么在浏览器里为每篇论文取一次分类，两者都不现实。
      rec.writeUInt8(venueFlags, 26);
      rec.writeUInt8(venueLenField, 27);
      rec.writeUInt32LE(venueOff, 28);
      head.copy(rec, 32);
      vhead.copy(rec, 53);
      idxChunks.push(Buffer.from(rec)); // 必须拷贝：rec 会被复用
      idxLen += REC;
      docId++;

      if (docId % 500000 === 0) log(`    … ${docId.toLocaleString()} 篇`);
    }
  })();

  return lines.then(() => {
    mkdirSync(OUT, { recursive: true });
    const idxBuf = Buffer.concat(idxChunks, idxLen);
    const txtBuf = Buffer.concat(txtChunks, txtLen);
    const absBuf = Buffer.concat(absChunks, absLen);
    const venBuf = Buffer.concat(venChunks, venLen);

    // 头部：magic + count + recBytes + 文本池长度 + 摘要池长度（自检用）
    const head = Buffer.alloc(32);
    head.write("LUNYMETA", 0, "ascii");
    head.writeUInt32LE(docId, 8);
    head.writeUInt32LE(REC, 12);
    head.writeUInt32LE(txtLen, 16);
    head.writeUInt32LE(absLen, 20);
    head.writeUInt32LE(HEAD, 24);
    head.writeUInt32LE(venLen, 28); // 去处名池长度

    const pIdx = join(OUT, `${domain}.idx.bin`);
    const pTxt = join(OUT, `${domain}.txt.bin`);
    const pAbs = join(OUT, `${domain}.abs.bin`);
    const pVen = join(OUT, `${domain}.venue.bin`);
    // 索引与文本池**都不压缩**：要支持 HTTP Range 随机访问。
    // （压缩后无法随机访问，必须先解压前面全部内容 —— 那样点开一篇论文要下几十 MB。）
    //
    // ⚠️ 也不要生成 `.idx.bin.br`：服务器会对同名的 `.br` 优先下发，
    //    一旦下发压缩流，Range 就失效了，而且拿到的字节是压缩流的一段 ——
    //    报错会非常难懂（看起来像"索引内容坏了"）。服务器侧也加了显式排除做双保险。
    writeFileSync(pIdx, Buffer.concat([head, idxBuf]));
    writeFileSync(pTxt, txtBuf);
    writeFileSync(pAbs, absBuf);
    writeFileSync(pVen, venBuf);

    const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    log(
      `  ${domain.padEnd(8)} ${docId.toLocaleString().padStart(10)} 篇 · ` +
        `索引 ${mb(idxBuf.length + 32)} · 文本池 ${mb(txtBuf.length)} · 摘要池 ${mb(absBuf.length)} · 去处名池 ${mb(venBuf.length)} · ${secs}s`,
    );
    log(
      `           有摘要 ${((100 * withAbs) / docId).toFixed(1)}% · ` +
        `有期刊信息 ${((100 * withVenue) / docId).toFixed(1)}% · ` +
        `引用非零 ${((100 * citeNonZero) / docId).toFixed(1)}% · 空标题 ${noTitle}`,
    );
    log(
      `           评级分布 T0/T1/T2/T3 = ${tierHist[0]}/${tierHist[1]}/${tierHist[2]}/${tierHist[3]}` +
        `（T1 顶刊级 ${tierHist[1] ? ((100 * tierHist[1]) / docId).toFixed(2) : 0}%）`,
    );

    const years = [...yearHist.entries()].filter(([y]) => y >= YEAR_MIN).sort((a, b) => a[0] - b[0]);
    if (years.length) {
      log(`           年份 ${years[0][0]}–${years[years.length - 1][0]}（缺失 ${(yearHist.get(0) ?? 0).toLocaleString()} 篇）`);
    }

    /**
     * 年份直方图：**每个年份一篇**，索引 = year − YEAR_MIN。
     *
     * 为什么要写进 manifest（而不是让前端自己扫 89 MB 的索引去统计）：
     * 时间排列模式需要知道"每个年代有多少论文"，才能把刻度环画成
     * **等论文量**分区 —— 而不是等年份宽度。
     *
     * 这个区别很实际：arXiv 的论文量随时间是**指数增长**的
     * （物理团 1991 年几百篇、2024 年十几万篇）。若按年份等宽画环，
     * 1990 年代会被压成看不见的一小段，而整个盘会呈现为一个"甜甜圈"——
     * 数据是对的，但读不出任何东西。按论文量等分之后盘是均匀的，
     * 环的位置直接告诉你"第 20% 的论文出现在哪一年之前"。
     */
    const yearCounts = [];
    for (let y = YEAR_MIN; y <= YEAR_MAX; y++) yearCounts.push(yearHist.get(y) ?? 0);

    /**
     * 爆发点检测（"超新星遗迹"的依据）。
     *
     * 判据：某一年该方向的产出 ≥ 前三年均值的 `BURST_RATIO` 倍，
     * 且当年绝对量 ≥ `BURST_MIN`、**前三年均值 ≥ `MIN_PREV`**。
     *
     * ⚠️ `MIN_PREV` 是必须的，这是实测踩出来的：
     * 第一版只要求"前三年均值 > 0"，于是最强的"爆发"是
     *     `/cond-mat/other 2004 年 495 篇（前三年均值 0.33，**1485×**）`
     * 1485 倍毫无意义 —— 它是"一个几乎不存在的分类突然有了 495 篇"，
     * 不是"一个活跃方向突然起飞"。**比值只有在基数足够时才可读。**
     *
     * ⚠️ 另一个必须对用户说明的事：**arXiv 建分库的年份会造成假爆发**。
     * 实测 `eess` 2017 年 180×、`econ` 2018 年 18.75× ——
     * 那是电子工程与经济分库**刚建立**、论文从别的分类迁过来，不是研究爆发。
     * 这类点会打上 `archiveArtifact` 标记，界面上单独说明，不与真爆发混在一起。
     *
     * 同一层连续多年爆发时只留**第一年**（起爆点），
     * 否则 2018/2019/2020 会各占一条把清单刷满。
     */
    const BURST_RATIO = 2.2;
    const BURST_MIN = 40;
    const MIN_PREV = 8;
    /** arXiv 各分库的建立年份（早于这些年份的"爆发"多半是分库迁移） */
    const ARCHIVE_BORN = { eess: 2017, econ: 2018, "q-fin": 2008, "q-bio": 2003, stat: 2007, cs: 1998 };
    const allBursts = [];
    for (const [key, hist] of stratumYearHist) {
      let sum = 0;
      for (const v of hist) sum += v;
      if (sum < BURST_MIN * 4) continue; // 小样本不看
      let lastBurstYear = -9;
      for (let i = 3; i < hist.length; i++) {
        if (hist[i] < BURST_MIN) continue;
        const prev = (hist[i - 1] + hist[i - 2] + hist[i - 3]) / 3;
        if (prev < MIN_PREV) continue;
        const ratio = hist[i] / prev;
        if (ratio < BURST_RATIO) continue;
        const year = YEAR_MIN + i;
        if (year - lastBurstYear <= 2) continue; // 同一次爆发的后续年份
        lastBurstYear = year;
        const arch = key.split("/")[1] ?? "";
        const born = ARCHIVE_BORN[arch];
        allBursts.push({
          stratum: key,
          year,
          papers: hist[i],
          prevAvg: Math.round(prev),
          ratio: Number(ratio.toFixed(2)),
          /** 该爆发是否可能只是"分库刚建立"（见上面的说明） */
          archiveArtifact: born !== undefined && year <= born + 1,
        });
      }
    }
    allBursts.sort((a, b) => b.ratio - a.ratio);
    const bursts = allBursts.slice(0, 24);
    if (bursts.length) {
      const real = bursts.filter((x) => !x.archiveArtifact);
      log(
        `           爆发点 ${allBursts.length} 处（其中真实起爆 ${real.length}）· 最强 ` +
          `${bursts[0].stratum} ${bursts[0].year} 年 ${bursts[0].papers} 篇` +
          `（前三年均值 ${bursts[0].prevAvg}，${bursts[0].ratio}×${bursts[0].archiveArtifact ? "，疑为分库迁移" : ""}）`,
      );
    }

    return {
      count: docId,
      idxBytes: idxBuf.length + 32,
      txtBytes: txtBuf.length,
      absBytes: absBuf.length,
      withAbsPct: Number(((100 * withAbs) / Math.max(1, docId)).toFixed(2)),
      withVenuePct: Number(((100 * withVenue) / Math.max(1, docId)).toFixed(2)),
      citeNonZeroPct: Number(((100 * citeNonZero) / Math.max(1, docId)).toFixed(2)),
      tierHist: [...tierHist],
      yearMin: YEAR_MIN,
      yearCounts,
      bursts,
    };
  });
}

async function main() {
  const list = ONLY ? DOMAINS.filter((d) => d.id === ONLY) : DOMAINS;
  mkdirSync(OUT, { recursive: true });
  const results = {};

  for (const dom of list) {
    log(`\n[${dom.id}] ${dom.zh}`);
    results[dom.id] = await buildDomain(dom.id);
  }

  // 登记进 manifest（保留其他脚本写入的字段 —— 见 build-spine.mjs 里那段注释的教训）
  const mPath = join(ROOT, "public", "data", "manifest.json");
  if (existsSync(mPath)) {
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    for (const d of m.domains) {
      const r = results[d.id];
      if (r) {
        d.meta = {
          index: `meta/${d.id}.idx.bin`,
          text: `meta/${d.id}.txt.bin`,
          abstract: `meta/${d.id}.abs.bin`,
          venue: `meta/${d.id}.venue.bin`,
          recordBytes: REC,
          headBytes: HEAD,
          count: r.count,
          withAbstractPct: r.withAbsPct,
          withVenuePct: r.withVenuePct,
          citeNonZeroPct: r.citeNonZeroPct,
          yearMin: r.yearMin,
          yearCounts: r.yearCounts,
          bursts: r.bursts,
        };
      }
    }
    m.metaBuiltAt = new Date().toISOString();
    writeFileSync(mPath, JSON.stringify(m, null, 2));
    writeFileSync(
      `${mPath}.br`,
      brotliCompressSync(readFileSync(mPath), { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }),
    );
    log(`\nmanifest.json 已登记 meta`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
