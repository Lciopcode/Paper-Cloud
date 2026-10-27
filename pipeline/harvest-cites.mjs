// @ts-nocheck
/**
 * 论文云 · 引用次数抓取（Semantic Scholar 批量接口）
 * ============================================================================
 * 产出 `data/cites/<domain>.bin`：每篇论文 8 字节（**按 docId 索引**）
 *
 *     u32 cites | u16 year | u8 venueTier | u8 flags
 *
 * ## 为什么最终回到 Semantic Scholar（中途换去过 OpenAlex，又换回来了）
 *
 * | | Semantic Scholar batch | OpenAlex |
 * |---|---|---|
 * | 单次条数 | **500** | 100（200 会报 Maximum number of values exceeded） |
 * | 实测吞吐 | 8–500 篇/秒，**波动大** | 并发 6 时 370 篇/秒，但… |
 * | **日配额** | 匿名共享池，**无硬性日上限** | **1000 次/天**（读响应头才知道） |
 * | 全量 305 万篇 | 6,105 次请求 ⇒ 数小时 | 30,524 次请求 ⇒ **30 天，跑不通** |
 * | 能否对回 docId | ✅ **原样回显同一个 id** | ❌ 期刊版合并掉 arXiv DOI，需三级回映射 |
 *
 * ⚠️ **OpenAlex 那条 1000 次/天 是实测踩出来的**：我按它对外宣称的"10 万次/天"
 *    估算出 51 分钟，跑了几万次之后被 429 挡住，读响应头才看到
 *    `x-ratelimit-limit: 1000` + `retry-after: 46312`（12.9 小时后重置）。
 *    教训：**别信文档里的额度，去读响应头**。
 *    `harvest-openalex.mjs` 保留下来做**小样本**的层级交叉验证（P2-1 只需 10 万篇）。
 *
 * S2 的问题只是**吞吐波动**（429 与 fetch failed 风暴），不是硬性日上限 ——
 * 6,105 次请求即使按 0.5 次/秒也只需 3.4 小时，所以全量引用用它。
 *
 * ⚠️ **不要混用两个来源**：两家的引用计数有系统性差异（同一篇实测 S2 196,853
 *    vs OpenAlex 24,501 是对不同版本），混起来做"亮度"编码会让明暗对比失去意义。
 *
 * ## 可续跑（这是必须的，不是加分项）
 *
 * 全量要跑 4–6 小时，中途断掉（限速、断网、手滑关窗口）是常态。
 * 所以：
 *   · 每完成一批就把进度写进 `<domain>.progress.json`（已完成的批号）；
 *   · 结果**分片**写成 `<domain>.part<NNNN>.bin`（每片 20 万篇），
 *     最后再由 `merge` 合成一个完整文件；
 *   · 重跑同一条命令会自动跳过已完成的批。
 *
 * ## 限速处理
 *
 * S2 匿名池是全共享的（文档：1000 req/s 跨所有匿名用户），所以吞吐会波动。
 * 遇到 429 就**指数退避**（从 5 秒退到最多 5 分钟），而不是硬失败 ——
 * 一失败就退出会让这个 6 小时的任务永远跑不完。
 *
 * 用法：
 *   node pipeline/harvest-cites.mjs                    # 全部学科
 *   node pipeline/harvest-cites.mjs --domain cs        # 只跑一个
 *   node pipeline/harvest-cites.mjs --merge            # 只合并分片
 *   node pipeline/harvest-cites.mjs --status           # 只看进度
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

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
const ONLY = argVal("--domain", null);
const MERGE_ONLY = args.includes("--merge");
const STATUS_ONLY = args.includes("--status");

/** 每批多少篇。S2 上限 500。 */
const BATCH = 500;
/**
 * 一个分片含多少批。
 *
 * ⚠️ **这个数字同时决定"持久化"与"进度"的粒度，不能随便调大。**
 * 曾经取 400（20 万篇），后果是实测踩到的：
 * 进程死在某个分片的第 220 批时，**整个分片一个字节都没落盘**，
 * 而进度文件里那 220 批已经标记完成 —— 重跑会跳过它们，
 * 合并出来的文件里这 11 万篇全是 0，**而且没有任何报错**。
 * （比崩溃严重得多：崩溃至少看得见。）
 *
 * 现在：**分片既是持久化单位，也是进度单位** ——
 * 先抓完一个分片的所有批、落盘，然后才把它标为完成。
 * 于是"已完成 ⟺ 数据已落盘"永远成立，进程死掉最多损失**一个分片**。
 */
const BATCHES_PER_PART = 20;
/** 批间隔（毫秒）。S2 匿名池是**全共享**的，礼貌间隔能显著降低被限速的概率。 */
const GAP_MS = Number(argVal("--gap", "1500"));
/** 首次重试等待 */
const BASE_BACKOFF_MS = 6000;
/**
 * 退避上限。
 *
 * 定在 30 秒而不是 60：单批最多重试 `MAX_ATTEMPTS` 次，
 * 上限太高会让"一次坏时段"直接耗尽重试次数、把整片作废。
 * 与其在单批上死等，不如**早点失败、让整片重来**（分片粒度已经很小，代价可控）。
 */
const MAX_BACKOFF_MS = 30000;
/** 单批最多重试几次（16 次 × 平均约 20s ≈ 5 分钟） */
const MAX_ATTEMPTS = 16;
/**
 * 连续多少次限速就触发**全局冷却**。
 *
 * 为什么逐批退避不够：S2 匿名池是**全共享**的，遇到坏时段时
 * 逐批退避只是"每个批次各自撞墙"，整体请求速率几乎没降下来。
 * 全局冷却直接停几分钟让池子恢复，比在每一批上分别重试有效得多。
 */
const RATE_LIMIT_STREAK_FOR_COOLDOWN = 6;
const COOLDOWN_MS = 180000;
/**
 * **网络故障**（不是限速）连续多少次就长冷却。
 *
 * 为什么必须把这两类分开：实测遇到过一阵 `TypeError: fetch failed` 风暴
 * （连 TCP 都连不上，不是 429），当时客户端的行为是"每批重试 16 次、整片作废、原地磨"，
 * 结果速度从 75 篇/秒掉到 8 篇/秒、白跑 49 个分片 —— **越磨越糟**。
 * 网络故障和限速的应对完全不同：限速要降速，网络故障要**停久一点等它恢复**。
 */
const NET_FAIL_STREAK_FOR_COOLDOWN = 3;
const NET_COOLDOWN_MS = 600000;
/**
 * 一个学科里网络故障累计超过这个数就**干净地停下来**（进度已存，可续跑）。
 *
 * 为什么不是"死磕到底"：如果是 IP 被临时封禁这类问题，磕几个小时也不会有进展，
 * 反而持续冲击对方的服务。停下来并把话说清楚，比假装在工作好。
 */
const NET_FAIL_GIVE_UP = 30;
/** 连续限速计数（成功一次就清零） */
let rateLimitStreak = 0;
/** 连续**网络故障**计数（成功一次就清零） */
let netFailStreak = 0;
const REC_BYTES = 8;
const FIELDS = "citationCount,externalIds,year";

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
    progress: join(OUT, `${domain}.progress.json`),
    part: (i) => join(OUT, `${domain}.part${String(i).padStart(4, "0")}.bin`),
    merged: join(OUT, `${domain}.bin`),
  };
}

function readProgress(domain) {
  const p = paths(domain).progress;
  if (!existsSync(p)) return { done: {}, count: 0 };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { done: {}, count: 0 };
  }
}

function writeProgress(domain, prog) {
  writeFileSync(paths(domain).progress, JSON.stringify(prog));
}

/** 读某学科全部 arXiv id（docId 顺序 = JSONL 行序）。 */
async function readArxivIds(domain) {
  const file = join(TEXT, `${domain}.jsonl.gz`);
  if (!existsSync(file)) return null;
  const ids = [];
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()) });
  for await (const line of rl) {
    if (!line) {
      ids.push(null);
      continue;
    }
    try {
      ids.push(JSON.parse(line).id ?? null);
    } catch {
      ids.push(null);
    }
  }
  rl.close();
  return ids;
}

/**
 * 抓一批。
 *
 * ⚠️ 用 `ARXIV:<id>` 作为请求 id，S2 会**原样回显同一个 id**（实测确认），
 * 所以结果与输入是**按位置一一对应**的 —— 这是整个抓取能可靠落地的前提。
 * 若换成 OpenAlex 的 DOI 批量，期刊版会合并掉 arXiv DOI，就再也对不回来了。
 *
 * ## 重试必须覆盖"读响应体"，不只是 `fetch()` 本身
 *
 * 实测踩过：`fetch()` 外面有 try/catch，但 `res.json()` 没有 ——
 * 连接在中途被重置时（ECONNRESET）`res.json()` 抛 `TypeError: terminated`，
 * 直接冒泡出去把整个任务干掉。**跑了 10 万篇之后进程死掉**，
 * 而日志里只有一行 "TypeError: terminated"，看不出是网络问题。
 * 现在读体也在重试范围内。
 */
async function fetchBatch(arxivIds) {
  const body = JSON.stringify({ ids: arxivIds.map((id) => (id ? `ARXIV:${id}` : "ARXIV:0000.00000")) });
  const url = `https://api.semanticscholar.org/graph/v1/paper/batch?fields=${FIELDS}`;
  let backoff = BASE_BACKOFF_MS;
  let lastErr = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.status === 200) {
        // 读体也在这里面 —— 中途断连会抛在这里（见上面的说明）
        const j = await res.json();
        rateLimitStreak = 0;
        netFailStreak = 0;
        return j;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        if (res.status === 429) {
          rateLimitStreak++;
          if (rateLimitStreak >= RATE_LIMIT_STREAK_FOR_COOLDOWN) {
            log(
              `   连续 ${rateLimitStreak} 次限速 ⇒ 全局冷却 ${COOLDOWN_MS / 1000}s（让共享池恢复，` +
                `比逐批退避有效）`,
            );
            await sleep(COOLDOWN_MS);
            rateLimitStreak = 0;
            continue; // 冷却不计入本次重试次数
          }
        }
        log(`   ${lastErr}（限速/服务端），${backoff / 1000}s 后重试`);
        await sleep(backoff);
        backoff = Math.min(backoff * 1.7, MAX_BACKOFF_MS);
        continue;
      }
      // 4xx（除 429）是请求本身的问题，重试没有意义
      lastErr = `HTTP ${res.status}：${(await res.text().catch(() => "")).slice(0, 160)}`;
      break;
    } catch (e) {
      // ---- 网络故障：与限速分开处理 ----
      lastErr = `${e?.name ?? "错误"}：${e?.message ?? e}${e?.cause?.code ? `（${e.cause.code}）` : ""}`;
      netFailStreak++;
      if (netFailStreak >= NET_FAIL_STREAK_FOR_COOLDOWN) {
        log(
          `   连续 ${netFailStreak} 次**网络故障**（不是限速）⇒ 长冷却 ` +
            `${NET_COOLDOWN_MS / 60000} 分钟。实测这类风暴会持续几分钟，` +
            `在原地快速重试只会越磨越糟（曾经 75 篇/秒掉到 8 篇/秒）。`,
        );
        await sleep(NET_COOLDOWN_MS);
        netFailStreak = 0;
        continue; // 长冷却不计入重试次数
      }
      log(`   网络/读取错误（${lastErr}），${backoff / 1000}s 后重试`);
      await sleep(backoff);
      backoff = Math.min(backoff * 1.7, MAX_BACKOFF_MS);
    }
  }
  // 把失败原因分类带出去，让上层能决定"作废片"还是"该停下了"
  const err = new Error(`连续 ${MAX_ATTEMPTS} 次失败：${lastErr}`);
  err.isNetwork = /fetch failed|terminated|ECONNRESET|ETIMEDOUT|socket/i.test(lastErr);
  throw err;
}

async function harvestDomain(domain) {
  const ids = await readArxivIds(domain);
  if (!ids) {
    log(`  跳过 ${domain}（无 text/${domain}.jsonl.gz）`);
    return null;
  }
  mkdirSync(OUT, { recursive: true });

  const p = paths(domain);
  const prog = readProgress(domain);
  const totalBatches = Math.ceil(ids.length / BATCH);

  /**
   * **核对进度与磁盘**：进度里标了完成、但对应分片文件不存在的条目一律作废。
   *
   * 为什么必须做：早期版本把 400 批作为一个分片，进程死在片中间时
   * 分片没落盘、而进度已经把那些批标成完成 —— 重跑会**跳过它们**，
   * 合并结果里那一段全是 0，且没有任何报错。
   * 现在每次启动都对照实际文件清理一遍，"已完成"才真的可信。
   */
  {
    let cleaned = 0;
    for (const key of Object.keys(prog.done)) {
      const b = Number(key);
      const partIdx = Math.floor(b / BATCHES_PER_PART);
      if (!existsSync(p.part(partIdx))) {
        delete prog.done[key];
        cleaned++;
      }
    }
    if (cleaned) {
      writeProgress(domain, prog);
      log(`   ⚠️ 进度里有 ${cleaned} 批标着完成但分片文件不存在，已作废（会重新抓）`);
    }
  }
  const todo = [];
  for (let b = 0; b < totalBatches; b++) if (!prog.done[b]) todo.push(b);

  log(
    `  ${domain.padEnd(8)} ${ids.length.toLocaleString()} 篇 · ${totalBatches.toLocaleString()} 批 · ` +
      `已完成 ${Object.keys(prog.done).length.toLocaleString()} · 待抓 ${todo.length.toLocaleString()}`,
  );
  if (todo.length === 0) {
    log(`           全部已完成，跳过`);
    return { domain, papers: ids.length, batches: totalBatches, done: totalBatches };
  }

  // 按分片聚合：同一片的批一起抓、一起写
  const byPart = new Map();
  for (const b of todo) {
    const partIdx = Math.floor(b / BATCHES_PER_PART);
    if (!byPart.has(partIdx)) byPart.set(partIdx, []);
    byPart.get(partIdx).push(b);
  }

  const t0 = Date.now();
  let fetched = 0;
  let citeSum = 0;
  let citeMax = 0;
  let nonNull = 0;
  /** 本次会话里失败的分片数（会被记录、重跑时自动重试） */
  let failedParts = 0;
  /** 网络故障累计（与限速分开计 —— 见 NET_FAIL_GIVE_UP 的说明） */
  let netFails = 0;
  /**
   * 失败的分片**先记下来、不阻塞后面的**。
   *
   * 为什么：实测遇到网络故障风暴时，按顺序硬磕会把整个后半段都耗在同一个坏时段上
   * （当时白跑 49 个分片、速度掉到 8 篇/秒）。
   * 先跳过、把能做的做完，最后再回头补 —— 同样时间里能多抓很多。
   */
  const deferred = [];

  for (const [partIdx, batches] of [...byPart.entries()].sort((a, b) => a[0] - b[0])) {
    const firstBatch = partIdx * BATCHES_PER_PART;
    const lastBatch = Math.min(totalBatches, firstBatch + BATCHES_PER_PART) - 1;
    const partPapers = (lastBatch - firstBatch + 1) * BATCH;
    const buf = Buffer.alloc(partPapers * REC_BYTES);

    /**
     * 先把这一片的**所有批**抓完，中途不写进度。
     *
     * 这是"done ⟺ 已落盘"的关键：任何一批彻底失败就**整片作废**
     * （不落盘、不标完成），重跑时整片重来。
     * 代价是重试时浪费几批的请求，换来的是**绝不会出现"进度说完成、数据是零"**。
     */
    let partOk = true;
    for (const b of batches) {
      const slice = ids.slice(b * BATCH, (b + 1) * BATCH);
      let res;
      try {
        res = await fetchBatch(slice);
      } catch (e) {
        failedParts++;
        partOk = false;
        if (e.isNetwork) netFails++;
        log(`   批 ${b} 失败（${e.message}）⇒ 整片 ${partIdx} 跳过，稍后或下次重跑补`);
        deferred.push(partIdx);
        await sleep(GAP_MS * 2);
        break;
      }
      for (let i = 0; i < slice.length; i++) {
        const rec = res[i];
        const docId = b * BATCH + i;
        if (docId >= ids.length) break;
        const off = (docId - firstBatch * BATCH) * REC_BYTES;
        if (!rec) {
          // 没查到（撤稿 / S2 未收录）：写 0，**不编造**
          buf.writeUInt32LE(0, off);
          continue;
        }
        nonNull++;
        const cites = Math.max(0, Math.min(0xffffffff, rec.citationCount ?? 0));
        if (cites > citeMax) citeMax = cites;
        citeSum += cites;
        buf.writeUInt32LE(cites, off);
        buf.writeUInt16LE(Math.max(0, Math.min(65535, rec.year ?? 0)), off + 4);
        buf.writeUInt8(0, off + 6);
        // ⚠️ bit0 = "在数据源里查到了这篇"。
        //    必须区分「查到 0 引用」与「根本没有记录」—— 两者数值都是 0，
        //    但前者该画得很暗、后者只是**我们不知道**，不该假装它很暗。
        //    第一版这里写了 0，于是界面把"数据缺失"当成了"引用很少"。
        buf.writeUInt8(1, off + 7);
      }
      fetched += slice.length;
      await sleep(GAP_MS);
    }

    if (!partOk) {
      // 不落盘、不标完成 —— 下次重跑整片重来。
      // 网络故障累计太多就**干净地停下来**：如果是 IP 被临时封禁这类问题，
      // 再磕几个小时也不会有进展，反而持续冲击对方的服务。
      // 停下来并把话说清楚（进度已存，续跑即可），比假装在工作好。
      if (netFails >= NET_FAIL_GIVE_UP) {
        log(
          `\n   ⚠️ 网络故障已累计 ${netFails} 次，停止本学科。` +
            `\n      已抓到的分片都**完好保存在磁盘上**，直接重跑本命令即可续抓。` +
            `\n      （不要立刻重跑 —— 若是对端在限流，等十几分钟更有效。）`,
        );
        writeProgress(domain, prog);
        return { domain, papers: ids.length, fetched, nonNull, citeMax, aborted: true };
      }
      continue;
    }

    // 落盘，**然后**才标记完成（顺序不能反）
    writeFileSync(p.part(partIdx), buf);
    for (const b of batches) prog.done[b] = 1;
    writeProgress(domain, prog);

    const secs = (Date.now() - t0) / 1000;
    log(
      `     分片 ${partIdx} 完成（${(buf.length / 1048576).toFixed(2)} MB）· ` +
        `累计 ${fetched.toLocaleString()} 篇 · ${(fetched / secs).toFixed(0)} 篇/秒 · ` +
        `均引用 ${(citeSum / Math.max(1, nonNull)).toFixed(1)}` +
        (deferred.length ? ` · 待补 ${deferred.length} 片` : ""),
    );
  }

  const secs = (Date.now() - t0) / 1000;
  log(
    `           本次 ${fetched.toLocaleString()} 篇 · ${(fetched / secs).toFixed(0)} 篇/秒 · ` +
      `S2 命中率 ${((100 * nonNull) / Math.max(1, fetched)).toFixed(1)}% · ` +
      `均引用 ${(citeSum / Math.max(1, nonNull)).toFixed(1)} · 最高 ${citeMax.toLocaleString()}`,
  );
  // 跳过的分片**再回头补一轮** —— 第一轮跳过是为了不被一个坏时段卡住，
  // 补一轮是因为网络故障往往是暂时的（实测：风暴过去后单次请求立刻恢复 200）。
  if (deferred.length && netFails < NET_FAIL_GIVE_UP) {
    log(`\n   回头补 ${deferred.length} 个跳过的分片…`);
    let recovered = 0;
    for (const partIdx of [...new Set(deferred)]) {
      const firstBatch = partIdx * BATCHES_PER_PART;
      const lastBatch = Math.min(totalBatches, firstBatch + BATCHES_PER_PART) - 1;
      const buf = Buffer.alloc((lastBatch - firstBatch + 1) * BATCH * REC_BYTES);
      let ok = true;
      for (let b = firstBatch; b <= lastBatch; b++) {
        if (prog.done[b]) continue;
        const slice = ids.slice(b * BATCH, (b + 1) * BATCH);
        try {
          const res = await fetchBatch(slice);
          for (let i = 0; i < slice.length; i++) {
            const docId = b * BATCH + i;
            if (docId >= ids.length) break;
            const off = (docId - firstBatch * BATCH) * REC_BYTES;
            const rec = res[i];
            if (!rec) continue;
            nonNull++;
            const c = Math.max(0, Math.min(0xffffffff, rec.citationCount ?? 0));
            if (c > citeMax) citeMax = c;
            citeSum += c;
            buf.writeUInt32LE(c, off);
            buf.writeUInt16LE(Math.max(0, Math.min(65535, rec.year ?? 0)), off + 4);
            buf.writeUInt8(1, off + 7); // bit0 = 查到了记录
          }
          fetched += slice.length;
          await sleep(GAP_MS);
        } catch (e) {
          ok = false;
          if (e.isNetwork) netFails++;
          log(`   补片 ${partIdx} 的批 ${b} 仍失败，留待下次重跑`);
          break;
        }
      }
      if (ok) {
        writeFileSync(p.part(partIdx), buf);
        for (let b = firstBatch; b <= lastBatch; b++) prog.done[b] = 1;
        writeProgress(domain, prog);
        recovered++;
        log(`     补片 ${partIdx} 完成`);
      }
      if (netFails >= NET_FAIL_GIVE_UP) {
        log(`   网络故障累计 ${netFails} 次，停止补片。已完成的都已落盘，重跑即可续抓。`);
        break;
      }
    }
    log(`   补回 ${recovered} / ${new Set(deferred).size} 片`);
  }
  return { domain, papers: ids.length, fetched, nonNull, citeMax, avg: citeSum / Math.max(1, nonNull) };
}

/** 把分片合成一个定长文件（按 docId 索引）。缺失的部分补 0。 */
function mergeDomain(domain, totalPapers) {
  const p = paths(domain);
  const parts = readdirSync(OUT)
    .filter((f) => f.startsWith(`${domain}.part`) && f.endsWith(".bin"))
    .sort();
  if (parts.length === 0) return null;
  const total = totalPapers ?? (() => {
    // 没有篇数时按最大分片推：分片序号 × 每片篇数
    const last = parts[parts.length - 1];
    const idx = Number(last.match(/part(\d+)/)[1]);
    return (idx + 1) * BATCHES_PER_PART * BATCH;
  })();
  const out = Buffer.alloc(total * REC_BYTES);
  let written = 0;
  for (const f of parts) {
    const idx = Number(f.match(/part(\d+)/)[1]);
    const buf = readFileSync(join(OUT, f));
    const off = idx * BATCHES_PER_PART * BATCH * REC_BYTES;
    buf.copy(out, Math.min(off, out.length), 0, Math.min(buf.length, out.length - off));
    written += buf.length;
  }
  writeFileSync(p.merged, out);
  let nonZero = 0;
  for (let i = 0; i < total; i++) if (out.readUInt32LE(i * REC_BYTES) > 0) nonZero++;
  log(
    `  ${domain.padEnd(8)} 合并 ${parts.length} 片 → ${p.merged.replace(ROOT, ".")} · ` +
      `${(out.length / 1048576).toFixed(1)} MB · 引用非零 ${((100 * nonZero) / total).toFixed(1)}%`,
  );
  return { domain, total, nonZero, pct: (100 * nonZero) / total };
}

/** 读各学科篇数（从 manifest，避免再扫一遍 JSONL）。 */
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
    log("学科      篇数        已完成批   总批数    进度");
    for (const d of list) {
      const prog = readProgress(d.id);
      const n = papers[d.id] ?? 0;
      const totalB = Math.ceil(n / BATCH);
      const doneB = Object.keys(prog.done).length;
      // 实际落盘的分片数（比进度更可信 —— 进度可能被清理过）
      const parts = readdirSync(OUT).filter((f) => f.startsWith(`${d.id}.part`) && f.endsWith(".bin")).length;
      log(
        `${d.id.padEnd(9)} ${String(n).padStart(10)} ${String(doneB).padStart(10)} ${String(totalB).padStart(9)}` +
          `   ${((100 * doneB) / Math.max(1, totalB)).toFixed(1)}%` +
          `   分片 ${String(parts).padStart(4)}`,
      );
    }
    return;
  }

  if (MERGE_ONLY) {
    for (const d of list) mergeDomain(d.id, papers[d.id]);
    return;
  }

  log(`输出：${OUT}`);
  log(`每批 ${BATCH} 篇 · 批间隔 ${GAP_MS}ms\n`);
  const summary = [];
  for (const d of list) {
    log(`[${d.id}] ${d.zh}`);
    const r = await harvestDomain(d.id);
    if (r) summary.push(r);
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
