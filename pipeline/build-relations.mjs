// @ts-nocheck
/**
 * 论文云 · 邻近表构建（关系数据结构的第一步）
 * ============================================================================
 * 产出 `public/data/relations/<domain>.nbr.bin`：每篇论文的 K 个**同领域邻居**。
 *
 * ## 为什么不是"全量边表"
 *
 * 同领域边的完整集合是 O(n²)：物理团最大的层（凝聚态·材料科学）有 7 万篇，
 * 层内全连接是 2.4×10⁹ 条；八团合计超过 10¹¹ 条 —— 存不下，也没有意义。
 * 而且交互需要的是"**点开一篇论文，立刻看到几篇相关的**"，不是"遍历整个邻域图"。
 *
 * 所以这里取**每篇 K 个确定性采样的邻居**：
 *   · 定长记录 ⇒ 按 docId **O(1) 随机访问**（交互必须常数时间）；
 *   · 邻居在层内**均匀跨步**取，而不是取相邻序号 ——
 *     相邻序号的论文往往是同作者的连续投稿（标题几乎一样），看起来像重复；
 *     跨步取能覆盖整层，列表更有信息量；
 *   · 完全确定（同一份数据每次构建结果相同）⇒ 可复现、可缓存、不做随机推荐。
 *
 * ## 为什么"同领域"是零额外抓取
 *
 * 层号（L3 研究方向）已经写进编号表的每条记录（见 build-spine.mjs）。
 * 所以同领域边**直接从本地数据算出来**，不需要任何 API —— 这是先做层级带来的红利。
 *
 * 用法：node pipeline/build-relations.mjs [--domain physics] [--k 3]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zc } from "node:zlib";

import { DOMAINS } from "../src/data/domains.ts";
import { EDGE_KIND, NBR_HEAD_BYTES, NBR_MAGIC, NBR_REC_BYTES, packNeighbor } from "../src/data/relations.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const DATA = join(ROOT, "public", "data");

const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ONLY = argVal("--domain", null);
/** 每篇取几个同领域邻居。4 个在"看得出相关性"与"面板放得下"之间比较平衡。 */
const K = Number(argVal("--k", "4"));

/** 编号表的字段布局（必须与 build-spine.mjs 一致） */
const VALUE_BYTES = 32;
const RANK_BASE = 16 + VALUE_BYTES * 2;
const RANK_REC = 40;

function log(m) {
  process.stdout.write(`${m}\n`);
}

/**
 * 读编号表里的 (docId, 层号)。
 *
 * 只取这两个字段 —— 不需要 rank（建同领域边不用编号距离），
 * 也就不必碰那 32 字节的大整数，速度更快。
 */
function readStratumAndDocId(domain) {
  const path = join(DATA, domain, "rank.bin");
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).toString("ascii") !== "LUNYRANK") {
    throw new Error(`${path} 魔法数不对 —— 编号表格式变了？`);
  }
  const count = buf.readUInt32LE(8);
  const recBytes = buf.readUInt32LE(12);
  if (recBytes !== RANK_REC) throw new Error(`编号表记录长度应为 ${RANK_REC}，实际 ${recBytes}`);
  const need = RANK_BASE + count * recBytes;
  if (buf.length < need) throw new Error(`编号表长度不足：需要 ${need}，实际 ${buf.length}`);

  const docIds = new Uint32Array(count);
  const strata = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const o = RANK_BASE + i * recBytes;
    docIds[i] = buf.readUInt32LE(o);
    strata[i] = buf.readUInt16LE(o + 4 + VALUE_BYTES + 2);
  }

  // ⚠️ **必须建 docId → 层号 的直查表**。
  //    编号表是按 **rank 升序**排的，而邻接表是按 **docId** 索引的（要 O(1) 随机访问），
  //    两者顺序不同 —— 直接拿编号表的位置当下标会让"自检条"全错
  //    （实测 qfin：13,543 条里错了 13,542 条，因为 docId 0 恰好不是编号表第 0 条）。
  const maxDocId = docIds.reduce((a, b) => (b > a ? b : a), 0);
  const stratumOfDoc = new Uint16Array(maxDocId + 1).fill(0xffff);
  for (let i = 0; i < count; i++) stratumOfDoc[docIds[i]] = strata[i];

  return { count, docIds, strata, stratumOfDoc, maxDocId };
}

/**
 * 为一篇论文在**同层的成员列表**里选 K 个邻居。
 *
 * 用"均匀跨步 + 确定性回绕"而不是随机：
 *   · 随机 ⇒ 每次构建结果不同，无法复现，也无法缓存；
 *   · 只取相邻序号 ⇒ 全是同作者的连续投稿，看起来像重复。
 *
 * @param members 同层成员（按 docId 升序的下标数组）
 * @param pos     自己在 members 里的位置
 */
function pickNeighbors(members, pos) {
  const n = members.length;
  const out = [];
  for (let j = 1; j <= K; j++) {
    // 跨步 = 层大小 / (K+1)，保证 K 个邻居在整层范围内均匀铺开
    const step = Math.max(1, Math.floor(n / (K + 1)));
    const idx = (pos + j * step) % n;
    if (idx !== pos) out.push(members[idx]);
  }
  // 层太小（成员数 ≤ K）时上面可能取不满，用顺序补齐（仍然确定）
  for (let j = 0; out.length < Math.min(K, Math.max(0, n - 1)); j++) {
    const idx = (pos + 1 + j) % n;
    if (idx !== pos && !out.includes(idx)) out.push(idx);
    if (j > n) break;
  }
  return out;
}

function buildDomain(dom, domainIndex) {
  const t = readStratumAndDocId(dom.id);
  if (!t) {
    log(`  跳过 ${dom.id}（无 rank.bin）`);
    return null;
  }
  const { count, docIds, strata, stratumOfDoc, maxDocId } = t;

  // 按层号分桶（桶内保持 docId 升序 —— 编号表是按编号排序的，
  // 所以这里要显式排一次，否则邻居的语义不可控）
  const buckets = new Map();
  for (let i = 0; i < count; i++) {
    const s = strata[i];
    let arr = buckets.get(s);
    if (!arr) {
      arr = [];
      buckets.set(s, arr);
    }
    arr.push(docIds[i]); // 直接存 **docId**（输出按 docId 索引）
  }
  // 桶内按 docId 升序，保证"跨步取邻居"是确定的
  for (const arr of buckets.values()) arr.sort((a, b) => a - b);

  /**
   * 记录区按 **docId** 索引（不是编号表位置）。
   *
   * 这是邻接表能 O(1) 随机访问的前提：给定 docId 直接算偏移，不需要任何查找。
   * docId 在 [0, maxDocId] 上可能有空洞（空标题等极端情况），所以：
   *   · 区域大小按 **maxDocId + 1** 开（保证任何合法 docId 都有位置）；
   *   · 空洞的记录整条保持 0 ⇒ 读出来就知道"这篇没有数据"，而不是读到别人的邻居。
   */
  const recCount = maxDocId + 1;
  const buf = Buffer.alloc(NBR_HEAD_BYTES + recCount * (K + 1) * NBR_REC_BYTES);
  buf.write(NBR_MAGIC, 0, "ascii");
  buf.writeUInt32LE(recCount, 8);
  buf.writeUInt32LE(K, 12);
  buf.writeUInt32LE(NBR_REC_BYTES, 16);
  buf.writeUInt32LE(domainIndex, 20);

  let selfWritten = 0;
  let withNbr = 0;
  let edgeCount = 0;
  let holes = 0;
  let perStratumMax = { id: "", n: 0 };
  for (const [s, members] of buckets) {
    if (members.length > perStratumMax.n) perStratumMax = { id: s, n: members.length };
    for (let pos = 0; pos < members.length; pos++) {
      const docId = members[pos];
      const o = NBR_HEAD_BYTES + docId * (K + 1) * NBR_REC_BYTES;
      // 第 0 条写**自己**：自检与调试时能立刻确认"这条记录是不是我要的那篇"
      buf.writeUInt32LE(packNeighbor(EDGE_KIND.sameField, (domainIndex << 24) | docId), o);
      selfWritten++;
      const nbrs = pickNeighbors(members, pos);
      if (nbrs.length) withNbr++;
      for (let j = 0; j < K; j++) {
        const slot = o + (j + 1) * NBR_REC_BYTES;
        if (j < nbrs.length) {
          buf.writeUInt32LE(packNeighbor(EDGE_KIND.sameField, (domainIndex << 24) | nbrs[j]), slot);
          edgeCount++;
        }
        // 不写 = 保持 0 = 空槽。真实边的最低两位是类型（sameField=1），所以 0 不会与边混淆。
      }
    }
  }
  // 统计空洞（docId 有编号表记录但…其实不会有；真正的空洞是 docId 跳号）
  for (let d = 0; d <= maxDocId; d++) if (stratumOfDoc[d] === 0xffff) holes++;

  const outDir = join(DATA, "relations");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${dom.id}.nbr.bin`);
  writeFileSync(outPath, buf);
  const br = brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 6 } });
  writeFileSync(`${outPath}.br`, br);

  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  log(
    `  ${dom.id.padEnd(8)} ${count.toLocaleString().padStart(10)} 篇 · ${buckets.size} 层 · ` +
      `K=${K} · 边 ${edgeCount.toLocaleString()} 条 · 记录 ${recCount.toLocaleString()} 条（空洞 ${holes}）· ${mb(buf.length)}→br ${mb(br.length)}`,
  );
  log(`           最大层 ${perStratumMax.n.toLocaleString()} 篇（跨步邻居铺满整层）· 有邻居的论文 ${withNbr.toLocaleString()}`);

  return {
    file: `relations/${dom.id}.nbr.bin`,
    count,
    records: recCount,
    k: K,
    bytes: buf.length,
    brBytes: br.length,
    strata: buckets.size,
    edges: edgeCount,
    selfWritten,
    holes,
  };
}

function main() {
  const list = ONLY ? DOMAINS.filter((d) => d.id === ONLY) : DOMAINS;
  const results = {};
  for (const dom of list) {
    // domainIndex 必须是**全量 DOMAINS 里的下标**，不能是过滤后的下标
    // —— 否则 uid 的含义会随命令行参数变化，永久链接就失效了。
    const domainIndex = DOMAINS.findIndex((d) => d.id === dom.id);
    results[dom.id] = buildDomain(dom, domainIndex);
  }

  // 把关系文件登记进 manifest（前端据此按需加载）
  const mPath = join(DATA, "manifest.json");
  if (existsSync(mPath)) {
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    for (const d of m.domains) {
      const r = results[d.id];
      if (r) {
        d.relations = { file: r.file, k: r.k, count: r.count, kinds: ["sameField"] };
      }
    }
    m.relationsBuiltAt = new Date().toISOString();
    writeFileSync(mPath, JSON.stringify(m, null, 2));
    writeFileSync(
      `${mPath}.br`,
      brotliCompressSync(readFileSync(mPath), { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }),
    );
    log(`\nmanifest.json 已更新（登记 relations）`);
  }
}

main();
