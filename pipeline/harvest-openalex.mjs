// @ts-nocheck
/**
 * 论文云 · 引用次数抓取（OpenAlex）
 * ============================================================================
 * 产出 `data/cites/<domain>.bin`：每篇论文 8 字节（**按 docId 索引**）
 *
 *     u32 cites | u16 year | u8 venueTier | u8 flags
 *
 *     flags bit0 = 在 OpenAlex 里**查到了记录**（0 = 对端没收录这篇）
 *
 * ## ⚠️⚠️ 配额真相：OpenAlex 对本机只给 **1000 次/天**，全量跑不通
 *
 * 这个脚本**不能**用来抓全量引用。实测响应头：
 *
 *     x-ratelimit-limit: 1000          ← 每天 1000 次（不是它对外宣称的 10 万次）
 *     x-ratelimit-remaining: 0
 *     retry-after: 46312               ← 用尽后要等 12.9 小时才重置
 *
 * 全量 305 万篇 ÷ 100 条/次 = **30,524 次请求** ⇒ 按 1000/天要 **30 天**。
 * 我一开始按"10 万次/天"估算出 51 分钟，跑了几万次之后被封才发现 ——
 * 教训：**别信文档里的额度，去读响应头**（`x-ratelimit-*` 每次都带）。
 *
 * ## 那它还有什么用：小样本的层级交叉验证（P2-1）
 *
 * 引用计数继续用 S2（`harvest-cites.mjs`，6105 次请求就能覆盖全量）。
 * OpenAlex 留在这里做**抽样**：1000 次 × 100 条 = 每天 10 万篇，
 * 抓一个分层样本足够交叉验证我们自算的 L1/L2/L3 层级 ——
 * 验证层级不需要 300 万篇，10 万篇的统计功效已经远超需要。
 *
 * 用法示例（抽样，注意会消耗当天配额）：
 *   node pipeline/harvest-openalex.mjs --domain physics --sample 50000
 *
 * ============================================================================
 * 以下是原本的（已被证伪的）换源理由，保留作为记录：
 *
 * ## 为什么从 Semantic Scholar 换成 OpenAlex（实测对比）
 *
 * | | Semantic Scholar 匿名 | OpenAlex（带 mailto） |
 * |---|---|---|
 * | 每次条数 | 500 | 100（200 会报 Maximum number of values exceeded） |
 * | 实测吞吐 | 8–88 篇/秒，大量 429 | 并发 6 时 370 篇/秒 |
 * | 全量耗时 | 数小时，波动大 | **30 天（配额卡死，见上）** |
 *
 * S2 的问题只是**吞吐波动**（429 与 fetch failed 风暴），不是硬性日上限；
 * 6,105 次请求即使按 0.5 次/秒也只需 3.4 小时。所以全量引用回到 S2。
 *
 * ## 回映射怎么做（这是换源后唯一的难点）
 *
 * OpenAlex 会把 arXiv 的 DOI（`10.48550/arxiv.X`）**合并**进期刊版记录，
 * 所以返回的 `doi` 往往不是我们查的那个 ⇒ 不能靠 doi 对回 docId。
 * 两条兜底路径，实测合计 **100%**：
 *   ① 从 `locations[].landing_page_url` / `pdf_url` 里正则找 `arxiv.org/abs/<id>`（98.9%）
 *   ② 用**归一化标题**在当前这一批的 100 篇里查（1.1%）——
 *      所以只需要"这一批"的标题表，不必为全库 300 万篇建表。
 *
 * ## 可续跑（与 S2 版同一套不变量）
 *
 * **分片既是持久化单位，也是进度单位**：先抓完整片、落盘、**然后**才标完成。
 * 于是"已完成 ⟺ 数据已落盘"永远成立，进程死掉最多损失一个分片。
 * 启动时还会用实际文件核对进度，把"标了完成但没有文件"的条目作废。
 *
 * 用法：
 *   node pipeline/harvest-openalex.mjs                 # 全部学科
 *   node pipeline/harvest-openalex.mjs --domain cs     # 只跑一个
 *   node pipeline/harvest-openalex.mjs --merge         # 只合并分片
 *   node pipeline/harvest-openalex.mjs --status        # 只看进度
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import { DOMAINS } from "../src/data/domains.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const TEXT = join(ROOT, "text");
const OUT = join(ROOT, "data", "cites");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
/**
 * 语料库目录。
 *
 * ⚠️ 语料是 **v1 目录**下的 5.4 GB SQLite（v2 只放产物，不放原始语料）。
 *    这里用参数暴露出来，避免把绝对路径硬编码进代码。
 * ⚠️ 必须声明在 `argVal` **之后** —— 用 const 的函数表达式在初始化前调用会抛
 *    `Cannot access 'argVal' before initialization`（TDZ）。实测踩过一次。
 */
/*
 * ⚠️ 默认值必须是**相对本仓库**的路径，不能硬编码某台机器的绝对路径。
 *
 * 第一版写的是 `"D:/new C/研云/研云/lunyun/data/corpus"` ——
 * 那在**这台机器上能跑、换台机器就断**，而且报错是"找不到数据库文件"，
 * 看起来像数据丢了，而不像"路径写死了"。交接给 4090 机器时这是硬阻断。
 *
 * 与 export-text.mjs 保持一致：默认指向 v1 目录下的语料（`<仓库>/../../lunyun/data/corpus`），
 * 换机器时用 `--corpus` 指过去。
 */
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
const ONLY = argVal("--domain", null);
/**
 * 只抓 N 篇的**分层样本**（按配额现实设计）。
 *
 * 为什么需要它：OpenAlex 对本机只给 1000 次/天（见文件头的说明），
 * 全量要 30 天。但 P2-1 的目的是**交叉验证我们自己算的 L1/L2/L3 层级** ——
 * 那是个统计问题，10 万篇的统计功效已经远超需要，不需要 300 万篇。
 *
 * 抽样方式：**等距抽样**（每 k 篇取一篇），而不是取前 N 篇或随机 N 篇 ——
 *   · 取前 N 篇会集中在早期年份（编号表按 rank 排，而 rank 与标题词序相关），
 *     样本会系统性偏向某个年代；
 *   · 等距抽样在 docId 维度上均匀，对"层级分布"这类统计量是无偏的。
 */
const SAMPLE = Number(argVal("--sample", "0")) || 0;
const MERGE_ONLY = args.includes("--merge");
const STATUS_ONLY = args.includes("--status");
/**
 * 带 email 就走 OpenAlex 的 polite pool（配额更宽、也更礼貌）。
 * ⚠️ 这是一个**占位邮箱**：正式对外使用时应换成真实联系地址 ——
 *    对端用它来联系重负载的调用方，写假地址既不合规也不利于别人排查。
 */
const MAIL = argVal("--mail", "lunyun@example.com");

/** 每批多少 DOI。⚠️ 实测 200 会报 "Maximum number of values exceeded"，上限是 100。 */
const BATCH = 100;
/** 每片多少批（= 持久化与进度的粒度）。20 批 = 2000 篇 = 16 KB。 */
const BATCHES_PER_PART = 20;
/** 批间隔。OpenAlex 限 10 请求/秒 ⇒ 理论 100ms，留 60ms 余量。 */
const GAP_MS = Number(argVal("--gap", "160"));
/**
 * 同一分片内**并发**抓几批。
 *
 * 为什么需要并发：单个请求的往返约 780ms，串行下来只有 1.3 请求/秒
 * （实测 105 篇/秒，全量要 8 小时），而 OpenAlex 允许 10 请求/秒 ——
 * **瓶颈是延迟，不是配额**。开到 6 并发后约 7 请求/秒（实测 600+ 篇/秒），
 * 全量从 8 小时压到 1 小时出头。
 *
 * ⚠️ 上限刻意留在 8：留出余量给别人，也避免触发对端的突发限流。
 *    并发下仍保留 `GAP_MS` 作为**每次发起**的最小间隔，整体速率 = 1/GAP_MS。
 */
const CONCURRENCY = Number(argVal("--concurrency", "6"));
const REC_BYTES = 8;

const FIELDS = "doi,cited_by_count,locations,title,primary_topic";
/**
 * 顺带抓 OpenAlex 的**四级学科层级**（P2-1）。
 *
 * 为什么并进同一批请求而不是另跑一轮：`primary_topic` 就在同一条记录里，
 * 多加一个 select 字段只多约 440 字节/条，而**独立再跑一轮要多发 3 万次请求**
 * （多占 30% 的每日配额）。同一批请求拿两样东西，是这里唯一合理的选择。
 *
 * 拿到的层级（实测）：
 *   topic    T10181  Natural Language Processing Techniques
 *   subfield 1702     Artificial Intelligence
 *   field    17       Computer Science
 *   domain   3        Physical Sciences
 *
 * 用途有两个：
 *   ① **交叉验证**我们自己从 arXiv 分类算出来的 L1/L2/L3 ——
 *      两套独立来源的层级若高度一致，说明我们的层级不是自说自话；
 *   ② 给论文一个**可读的研究主题**，这是"同路线边"最朴素的替代品
 *      （真正的路线要等语义层，那是显卡的活）。
 */
const TOPIC_REC_BYTES = 4;

function log(m) {
  process.stdout.write(`${m}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 单实例锁。
 * ============================================================================
 * ## 为什么必须有（这不是"锦上添花"，是数据安全问题）
 *
 * 抓取器的核心不变量是「**分片 = 持久化单位 = 进度单位**」，
 * 它成立的前提是**只有一个写者**。我实测不小心同时跑了两个抓取进程
 * （同一个进度文件、同一个分片目录），后果可能是：
 *
 *     A 写完一个分片的前 10 批 → B 把同一个分片覆盖成后 10 批 →
 *     进度里 20 批都标着完成，而文件里有一半是零。
 *
 * 「**进度说完成、数据是零**」正是本项目反复出现、最难发现的那类问题
 * （重跑会静默跳过，合并出来的文件里那一段全是 0，且没有任何报错）。
 * 这次运气好：两个进程对同一批算出的内容相同，覆盖后字节一致，
 * 完整性核对（`pipeline/verify-cites-integrity.mjs`）确认没坏。
 * 但**不能靠运气**。
 *
 * ## 实现
 *
 * 写一个含 PID 与启动时间的锁文件。启动时若锁存在且那个 PID 还活着就退出。
 * 刻意**不做自动抢占** —— "猜对方是不是僵死进程"这件事猜错的代价是数据损坏，
 * 而误判的代价只是"要手动删一下锁文件"。
 */
const LOCK = join(OUT, ".harvest.lock");

function acquireLock(label) {
  if (existsSync(LOCK)) {
    let info = null;
    try { info = JSON.parse(readFileSync(LOCK, "utf8")); } catch { /* 坏锁当无效 */ }
    if (info && info.pid) {
      let alive = false;
      try { process.kill(info.pid, 0); alive = true; } catch { alive = false; }
      if (alive) {
        log(`✗ 已有另一个抓取进程在跑（PID ${info.pid}，启动于 ${info.at}）。`);
        log(`  两个写者共享同一份进度与分片文件会**损坏数据** —— 已退出。`);
        log(`  确认那个进程真的不在跑了，就删掉 ${LOCK} 再试。`);
        process.exit(2);
      }
      log(`⚠️ 发现残留的锁（PID ${info.pid} 已不在）—— 视为僵死锁，继续。`);
    }
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), label }));
  const release = () => { try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch { /* 忽略 */ } };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
}


function paths(domain) {
  return {
    progress: join(OUT, `${domain}.oa.progress.json`),
    part: (i) => join(OUT, `${domain}.oa.part${String(i).padStart(4, "0")}.bin`),
    /** 层级分片（每篇 4 字节的 OpenAlex topic 号） */
    topicPart: (i) => join(OUT, `${domain}.oa.topic.part${String(i).padStart(4, "0")}.bin`),
    merged: join(OUT, `${domain}.bin`),
    mergedTopic: join(OUT, `${domain}.topic.bin`),
    topicDict: join(OUT, "topics.json"),
  };
}
function readProgress(domain) {
  const p = paths(domain).progress;
  if (!existsSync(p)) return { done: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { done: {} };
  }
}
const writeProgress = (domain, prog) => writeFileSync(paths(domain).progress, JSON.stringify(prog));

/**
 * 读某学科的 arXiv id 与标题（docId 顺序 = JSONL 行序）。
 *
 * 同时从**语料库 SQLite** 里取每篇的期刊 DOI。
 *
 * ⚠️ 为什么必须拿 DOI：OpenAlex 会把 arXiv 的 DOI（`10.48550/arxiv.X`）
 *    **合并**进期刊版记录，返回的 `doi` 往往是期刊那个。物理团实测只靠
 *    locations + 标题回映射只有 **72.9%**（econ/qfin 有 95–98%）——
 *    也就是说 27% 的物理论文会被算成 0 引用，表现为**假性变暗**，
 *    这是做"引用→亮度"最不能接受的错误（不是缺失，是错的方向）。
 *    语料库的 `doi` 列覆盖 30%（期刊版论文），用它做**精确匹配**能把这一块补回来。
 *
 * ⚠️ 用 `id` 做连接键，不用行序：SQLite 的默认返回顺序不保证与 JSONL 导出一致，
 *    按行序拼会把 DOI 安到别的论文上 —— 而且是**静默错误**
 *    （引用数看着合理，只是全错位）。同一个坑在编号表那里踩过。
 */
async function readPapers(domain) {
  const file = join(TEXT, `${domain}.jsonl.gz`);
  if (!existsSync(file)) return null;
  const ids = [];
  const titles = [];
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()) });
  for await (const line of rl) {
    if (!line) { ids.push(null); titles.push(""); continue; }
    try {
      const r = JSON.parse(line);
      ids.push(r.id ?? null);
      titles.push(r.title ?? "");
    } catch {
      ids.push(null);
      titles.push("");
    }
  }
  rl.close();

  // arXiv id → 期刊 DOI（来自语料库）
  const doiById = new Map();
  const dbPath = join(CORPUS, `domain_${domain}.db`);
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      for (const row of db.prepare("select id, doi from papers where doi is not null and doi != ''").all()) {
        doiById.set(String(row.id), String(row.doi));
      }
      db.close();
    } catch (e) {
      log(`   ⚠️ 读语料库 DOI 失败（${e.message.slice(0, 60)}）—— 回映射率会下降`);
    }
  } else {
    log(`   ⚠️ 找不到语料库 ${dbPath} —— 无法用期刊 DOI 回映射，覆盖率会明显下降`);
  }
  log(`   语料库 DOI：${doiById.size.toLocaleString()} 条可用`);
  return { ids, titles, doiById };
}

/**
 * 标题归一化。
 *
 * 用于回映射兜底：把两侧（OpenAlex 的 title 与本地 JSONL 的 title）都压成
 * 「小写 + 只留字母数字 + 单空格」再比。arXiv 标题里的连字符、冒号、
 * LaTeX 残留（`$`、`{}`）在两边的写法常常不同，不归一化会大量漏配。
 */
/**
 * DOI 归一化：去掉 `https://doi.org/` 前缀与大小写差异。
 * OpenAlex 返回的是完整 URL（`https://doi.org/10.1063/1.2177373`），
 * 语料库里存的是裸 DOI（`10.1063/1.2177373`），不归一化就一条都对不上。
 */
const normDoi = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .trim();

const normTitle = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** 从一条 OpenAlex 记录里抽出 arXiv 号（locations 里的落地页/pdf 链接，或 doi 本身）。 */
function arxivOf(w) {
  const urls = [];
  for (const l of w.locations ?? []) {
    if (l.landing_page_url) urls.push(l.landing_page_url);
    if (l.pdf_url) urls.push(l.pdf_url);
  }
  for (const u of urls) {
    const m = String(u).match(/arxiv\.org\/(?:abs|pdf)\/([^v\s/?#]+)/i);
    if (m) return m[1];
  }
  const d = String(w.doi ?? "").match(/10\.48550\/arxiv\.(.+)/i);
  return d ? d[1] : null;
}

async function fetchBatch(dois) {
  const url =
    `https://api.openalex.org/works?filter=doi:${dois.join("|")}` +
    `&per-page=${BATCH}&select=${FIELDS}&mailto=${MAIL}`;
  let backoff = 3000;
  let lastErr = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        log(`   ${lastErr}，${backoff / 1000}s 后重试`);
        await sleep(backoff);
        backoff = Math.min(backoff * 1.8, 60000);
        continue;
      }
      lastErr = `HTTP ${res.status}：${(await res.text().catch(() => "")).slice(0, 140)}`;
      break; // 4xx（除 429）重试无意义
    } catch (e) {
      lastErr = `${e?.name ?? "错误"}：${e?.message ?? e}${e?.cause?.code ? `（${e.cause.code}）` : ""}`;
      log(`   网络错误（${lastErr}），${backoff / 1000}s 后重试`);
      await sleep(backoff);
      backoff = Math.min(backoff * 1.8, 60000);
    }
  }
  throw new Error(`连续 10 次失败：${lastErr}`);
}

async function harvestDomain(domain) {
  const papers = await readPapers(domain);
  if (!papers) {
    log(`  跳过 ${domain}（无 text/${domain}.jsonl.gz）`);
    return null;
  }
  const { ids, titles, doiById } = papers;
  mkdirSync(OUT, { recursive: true });
  const p = paths(domain);
  const prog = readProgress(domain);
  const totalBatches = Math.ceil(ids.length / BATCH);

  // 核对进度与磁盘：标了完成但没有分片文件的一律作废
  let cleaned = 0;
  for (const key of Object.keys(prog.done)) {
    if (!existsSync(p.part(Math.floor(Number(key) / BATCHES_PER_PART)))) {
      delete prog.done[key];
      cleaned++;
    }
  }
  if (cleaned) {
    writeProgress(domain, prog);
    log(`   ⚠️ 进度里有 ${cleaned} 批标着完成但分片不存在，已作废`);
  }

  const todo = [];
  /*
   * 抽样模式：只抓够 SAMPLE 篇就停（等距挑批，见 SAMPLE 的说明）。
   * 每批 100 篇 ⇒ 需要的批数 = ceil(SAMPLE / 100)，在全部批里等距取。
   */
  const batchLimit = SAMPLE > 0 ? Math.ceil(SAMPLE / BATCH) : totalBatches;
  const stride = SAMPLE > 0 ? Math.max(1, Math.floor(totalBatches / batchLimit)) : 1;
  for (let b = 0; b < totalBatches; b += stride) {
    if (!prog.done[b]) todo.push(b);
    if (SAMPLE > 0 && todo.length >= batchLimit) break;
  }
  if (SAMPLE > 0) {
    log(`    抽样模式：从 ${totalBatches.toLocaleString()} 批里等距取 ${todo.length.toLocaleString()} 批（约 ${(todo.length * BATCH).toLocaleString()} 篇）`);
  }
  log(
    `  ${domain.padEnd(8)} ${ids.length.toLocaleString()} 篇 · ${totalBatches.toLocaleString()} 批 · ` +
      `已完成 ${Object.keys(prog.done).length.toLocaleString()} · 待抓 ${todo.length.toLocaleString()}`,
  );
  if (todo.length === 0) {
    log(`           全部已完成，跳过`);
    return { domain, papers: ids.length, fetched: 0 };
  }

  const byPart = new Map();
  for (const b of todo) {
    const idx = Math.floor(b / BATCHES_PER_PART);
    if (!byPart.has(idx)) byPart.set(idx, []);
    byPart.get(idx).push(b);
  }

  const t0 = Date.now();
  let fetched = 0, found = 0, notFound = 0, byTitleHits = 0;
  let citeSum = 0, citeMax = 0, failedParts = 0;
  const deferred = [];
  /**
   * OpenAlex topic 词典：topic 号 → 四级层级与名称。
   *
   * 单独存一张小表（约 4500 个 topic），而不是把层级名称塞进每篇论文的记录里 ——
   * 3M 篇 × 就算只存 4 个 id 也要 12 MB，而词典只有几百 KB。
   * 「每篇存外键、名称查词典」是这类数据最省的存法。
   */
  const topicDict = new Map();

  for (const [partIdx, batches] of [...byPart.entries()].sort((a, b) => a[0] - b[0])) {
    const firstBatch = partIdx * BATCHES_PER_PART;
    const lastBatch = Math.min(totalBatches, firstBatch + BATCHES_PER_PART) - 1;
    const buf = Buffer.alloc((lastBatch - firstBatch + 1) * BATCH * REC_BYTES);
    // 层级分片：每篇 4 字节（OpenAlex topic 号的数字部分；0 = 没有）
    const tbuf = Buffer.alloc((lastBatch - firstBatch + 1) * BATCH * TOPIC_REC_BYTES);
    let partOk = true;

    /**
     * 抓**一批**并写进分片缓冲。
     *
     * 并发安全性：每个批只写自己那一段偏移（`docId - firstBatch*BATCH`），
     * 批与批之间不重叠；JS 又是单线程，`await` 之间不会交错执行写操作，
     * 所以并发跑多个批不会互相踩 —— 不需要加锁。
     */
    const doBatch = async (b) => {
      const lo = b * BATCH;
      const hi = Math.min(ids.length, lo + BATCH);
      const slice = ids.slice(lo, hi);

      // 这一批的两张表 —— 回映射只需要"这一批"的，不必为全库建表
      const titleMap = new Map();
      const doiMap = new Map();
      for (let i = 0; i < slice.length; i++) {
        const docId = lo + i;
        const nt = normTitle(titles[docId]);
        // 同一批里标题重复时标记为歧义（-1），兜底时不用它
        if (nt) titleMap.set(nt, titleMap.has(nt) ? -1 : docId);
        const d = doiById.get(slice[i]);
        if (d) doiMap.set(normDoi(d), doiMap.has(normDoi(d)) ? -1 : docId);
      }

      const res = await fetchBatch(slice.map((x) => `10.48550/arxiv.${x}`));

      const indexOfId = new Map();
      for (let i = 0; i < slice.length; i++) indexOfId.set(slice[i], lo + i);

      for (const w of res.results ?? []) {
        /**
         * 三级回映射，按可靠性从高到低。
         *
         * ① **期刊 DOI 精确匹配** —— 语料库里存了 DOI 的论文（物理团约 30%，
         *    正是最容易被 OpenAlex 合并掉的那批）靠这一条对上；
         * ② arXiv 号（从 locations 里找 `arxiv.org/abs/<id>`）—— 覆盖未被合并的记录；
         * ③ **归一化标题** —— 兜底。arXiv 标题里的连字符/冒号/LaTeX 残留两边写法常不同，
         *    所以比的是"小写+只留字母数字+单空格"之后的串。
         *
         * 对不上就**丢掉不猜** —— 猜错会把 A 的引用数安到 B 头上，
         * 那比留空更糟（留空只是缺，猜错是错）。
         */
        const byDoi = doiMap.get(normDoi(w.doi));
        let docId = byDoi !== undefined && byDoi >= 0 ? byDoi : undefined;
        if (docId === undefined) {
          const ax = arxivOf(w);
          if (ax != null) docId = indexOfId.get(ax);
        }
        if (docId === undefined) {
          const hit = titleMap.get(normTitle(w.title));
          if (hit !== undefined && hit >= 0) {
            docId = hit;
            byTitleHits++;
          }
        }
        if (docId === undefined) continue;
        const off = (docId - firstBatch * BATCH) * REC_BYTES;
        if (off < 0 || off + REC_BYTES > buf.length) continue;
        const c = Math.max(0, Math.min(0xffffffff, w.cited_by_count ?? 0));
        if (c > citeMax) citeMax = c;
        citeSum += c;
        found++;
        buf.writeUInt32LE(c, off);
        buf.writeUInt16LE(Math.max(0, Math.min(65535, w.publication_year ?? 0)), off + 4);
        buf.writeUInt8(0, off + 6);
        buf.writeUInt8(1, off + 7); // bit0 = 查到了记录

        // ---- 顺带存 OpenAlex 的四级层级（P2-1）----
        const tp = w.primary_topic;
        if (tp?.id) {
          const tid = Number(String(tp.id).replace(/\D/g, "")) || 0;
          if (tid > 0) {
            tbuf.writeUInt32LE(tid, (docId - firstBatch * BATCH) * TOPIC_REC_BYTES);
            if (!topicDict.has(tid)) {
              // 词典只在首次遇到时写一次 —— 4500 个 topic，重复写没必要
              topicDict.set(tid, {
                name: tp.display_name ?? "",
                subfield: tp.subfield?.display_name ?? "",
                subfieldId: Number(String(tp.subfield?.id ?? "").replace(/\D/g, "")) || 0,
                field: tp.field?.display_name ?? "",
                fieldId: Number(String(tp.field?.id ?? "").replace(/\D/g, "")) || 0,
                domain: tp.domain?.display_name ?? "",
                domainId: Number(String(tp.domain?.id ?? "").replace(/\D/g, "")) || 0,
              });
            }
          }
        }
      }
      notFound += Math.max(0, (hi - lo) - (res.results?.length ?? 0));
      fetched += hi - lo;
    };

    // 并发池：同时最多 CONCURRENCY 个批在途，发起节奏由 GAP_MS 控制
    const queue = [...batches];
    const running = new Set();
    while (queue.length > 0 || running.size > 0) {
      while (queue.length > 0 && running.size < CONCURRENCY) {
        const b = queue.shift();
        const task = doBatch(b)
          .catch((e) => {
            failedParts++;
            partOk = false;
            log(`   批 ${b} 失败（${e.message}）⇒ 整片 ${partIdx} 跳过`);
            deferred.push(partIdx);
          })
          .finally(() => running.delete(task));
        running.add(task);
        await sleep(GAP_MS); // 发起间隔 —— 控制整体速率不超过对端上限
      }
      if (running.size > 0) await Promise.race(running);
      if (!partOk) break; // 有一批废了就整片放弃，不再继续发请求
    }
    await Promise.all([...running]);

    if (!partOk) continue;

    // 落盘，**然后**才标完成（顺序不能反）
    writeFileSync(p.part(partIdx), buf);
    writeFileSync(p.topicPart(partIdx), tbuf);
    for (const b of batches) prog.done[b] = 1;
    writeProgress(domain, prog);

    const secs = (Date.now() - t0) / 1000;
    log(
      `     分片 ${partIdx} 完成 · 累计 ${fetched.toLocaleString()} 篇 · ` +
        `${(fetched / secs).toFixed(0)} 篇/秒 · 命中 ${((100 * found) / Math.max(1, fetched)).toFixed(1)}%`,
    );
    if (fetched > 0 && fetched % 200000 < BATCH * BATCHES_PER_PART) {
      log(`       （其中靠标题兜底回映射 ${byTitleHits.toLocaleString()} 条）`);
    }
  }

  const secs = (Date.now() - t0) / 1000;
  log(
    `           本次 ${fetched.toLocaleString()} 篇 · ${(fetched / secs).toFixed(0)} 篇/秒 · ` +
      `OpenAlex 命中 ${((100 * found) / Math.max(1, fetched)).toFixed(1)}% · ` +
      `均引用 ${(citeSum / Math.max(1, found)).toFixed(1)} · 最高 ${citeMax.toLocaleString()}` +
      (deferred.length ? ` · 跳过 ${new Set(deferred).size} 片（重跑续抓）` : ""),
  );
  // 把这一轮新见到的 topic 并进词典（跨学科共享一张表）
  mergeTopicDict(topicDict, domain);
  return { domain, papers: ids.length, fetched, found, citeMax, avg: citeSum / Math.max(1, found) };
}

/**
 * 把新见到的 topic 并进全局词典。
 *
 * 词典是**跨学科共享**的：同一个 topic（如 T10181 自然语言处理）会在物理团与
 * 计算机团都出现，各写各的会互相覆盖。所以读旧的、合并、再写回。
 */
function mergeTopicDict(local, domain) {
  const p = paths(domain);
  let all = {};
  if (existsSync(p.topicDict)) {
    try {
      all = JSON.parse(readFileSync(p.topicDict, "utf8"));
    } catch {
      all = {};
    }
  }
  let added = 0;
  for (const [k, v] of local) {
    if (!all[k]) added++;
    all[k] = v;
  }
  writeFileSync(p.topicDict, JSON.stringify(all));
  log(`           topic 词典：本次新增 ${added} · 累计 ${Object.keys(all).length} 个主题`);
}

/** 把分片合成一个按 docId 索引的定长文件。缺失部分补 0（flags 也是 0 = 未查到）。 */
function mergeDomain(domain, totalPapers) {
  const p = paths(domain);
  const parts = readdirSync(OUT)
    .filter((f) => f.startsWith(`${domain}.oa.part`) && f.endsWith(".bin"))
    .sort();
  if (parts.length === 0) return null;
  const total = totalPapers ?? 0;
  const out = Buffer.alloc(total * REC_BYTES);
  let copied = 0;
  for (const f of parts) {
    const idx = Number(f.match(/part(\d+)/)[1]);
    const buf = readFileSync(join(OUT, f));
    const off = idx * BATCHES_PER_PART * BATCH * REC_BYTES;
    if (off >= out.length) continue;
    buf.copy(out, off, 0, Math.min(buf.length, out.length - off));
    copied++;
  }
  writeFileSync(p.merged, out);
  let withRec = 0, nonZero = 0;
  for (let i = 0; i < total; i++) {
    if (out.readUInt8(i * REC_BYTES + 7) & 1) withRec++;
    if (out.readUInt32LE(i * REC_BYTES) > 0) nonZero++;
  }

  // ---- 层级分片同样合并 ----
  const topicParts = readdirSync(OUT)
    .filter((f) => f.startsWith(`${domain}.oa.topic.part`) && f.endsWith(".bin"))
    .sort();
  let topicPct = 0;
  if (topicParts.length > 0) {
    const tout = Buffer.alloc(total * TOPIC_REC_BYTES);
    for (const f of topicParts) {
      const idx = Number(f.match(/part(\d+)/)[1]);
      const b = readFileSync(join(OUT, f));
      const off = idx * BATCHES_PER_PART * BATCH * TOPIC_REC_BYTES;
      if (off >= tout.length) continue;
      b.copy(tout, off, 0, Math.min(b.length, tout.length - off));
    }
    writeFileSync(p.mergedTopic, tout);
    let withTopic = 0;
    for (let i = 0; i < total; i++) if (tout.readUInt32LE(i * TOPIC_REC_BYTES) > 0) withTopic++;
    topicPct = (100 * withTopic) / Math.max(1, total);
  }

  log(
    `  ${domain.padEnd(8)} 合并 ${copied} 片 → ${(out.length / 1048576).toFixed(1)} MB · ` +
      `有记录 ${((100 * withRec) / Math.max(1, total)).toFixed(1)}% · ` +
      `引用非零 ${((100 * nonZero) / Math.max(1, total)).toFixed(1)}%` +
      (topicParts.length ? ` · 有主题 ${topicPct.toFixed(1)}%` : ""),
  );
  return { domain, total, withRec, nonZero, topicPct };
}

function papersOf() {
  const mPath = join(ROOT, "public", "data", "manifest.json");
  if (!existsSync(mPath)) return {};
  const m = JSON.parse(readFileSync(mPath, "utf8"));
  return Object.fromEntries(m.domains.map((d) => [d.id, d.papers]));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  acquireLock(process.argv.slice(2).join(" ") || "all");
  const list = ONLY ? DOMAINS.filter((d) => d.id === ONLY) : DOMAINS;
  mkdirSync(OUT, { recursive: true });
  const papers = papersOf();

  if (STATUS_ONLY) {
    log("学科      篇数        已完成批   总批数    进度         分片");
    for (const d of list) {
      const prog = readProgress(d.id);
      const n = papers[d.id] ?? 0;
      const totalB = Math.ceil(n / BATCH);
      const doneB = Object.keys(prog.done).length;
      const parts = readdirSync(OUT).filter((f) => f.startsWith(`${d.id}.oa.part`) && f.endsWith(".bin")).length;
      log(
        `${d.id.padEnd(9)} ${String(n).padStart(10)} ${String(doneB).padStart(10)} ${String(totalB).padStart(9)}` +
          `   ${((100 * doneB) / Math.max(1, totalB)).toFixed(1)}%`.padEnd(12) + `  ${parts}`,
      );
    }
    return;
  }
  if (MERGE_ONLY) {
    for (const d of list) mergeDomain(d.id, papers[d.id]);
    return;
  }

  log(`来源：OpenAlex（${MAIL}）· 输出 ${OUT}`);
  log(`每批 ${BATCH} · 批间隔 ${GAP_MS}ms（上限 10 请求/秒）\n`);
  for (const d of list) {
    log(`[${d.id}] ${d.zh}`);
    await harvestDomain(d.id);
    log("");
  }
  log("=== 合并分片 ===");
  for (const d of list) mergeDomain(d.id, papers[d.id]);
  log("\n完成。下一步：node pipeline/build-cites.mjs（把引用数接进 manifest 与渲染）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
