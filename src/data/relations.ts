/**
 * 论文云 · 关系数据契约
 * ============================================================================
 * 用户要的是"论文与论文之间的关系"，并明确分了三类：
 *   ① **应用与被应用**  → 引用边（有向）
 *   ② **同一领域**      → 同领域边（无向，零额外抓取：直接用层级）
 *   ③ **同一路线**      → 同路线边（无向，需要语义聚类或引用社区，P1/P2）
 *
 * ## 为什么要有这份契约（而不是各处随手定义）
 *
 * 三类边的**来源、方向、成本完全不同**，混在一起写会让"这条边到底是什么"变得含糊。
 * 契约把它们分开，并要求每条边都能溯源到数据 —— 不允许"猜出来的关系"。
 *
 * ## 全局 UID
 *
 * 论文原本用 `(domain, docId)` 标识，但建图需要**单一整数键**。这里定义：
 *   uid = (domainIndex << 24) | docId
 * 24 位给 docId ⇒ 单学科上限 16,777,216 篇（实测最大物理团 1,463,588 篇，余量充足）。
 * domainIndex 来自 `manifest.domains` 的下标，**顺序一旦发布不可改**。
 */

/** 每条边的类型（写进二进制时只占 2 位）。 */
export const EDGE_KIND = {
  /** 引用：应用与被应用（有向） */
  cites: 0,
  /** 同领域：同一 L3 研究方向（无向） */
  sameField: 1,
  /** 同路线：同一 L3 内的同一语义路线（无向，P2 产出） */
  sameRoute: 2,
} as const;

export type EdgeKind = (typeof EDGE_KIND)[keyof typeof EDGE_KIND];

/** 边类型的中文名（界面展示）。 */
export const EDGE_ZH: Readonly<Record<number, string>> = {
  [EDGE_KIND.cites]: "引用",
  [EDGE_KIND.sameField]: "同领域",
  [EDGE_KIND.sameRoute]: "同路线",
};

/** 单学科 docId 的位数。24 位 ⇒ 单学科上限 16,777,216 篇。 */
export const DOCID_BITS = 24;
export const DOCID_MASK = (1 << DOCID_BITS) - 1;

/** 把 (学科下标, docId) 合成全局 uid。 */
export function makeUid(domainIndex: number, docId: number): number {
  if (domainIndex < 0 || domainIndex > 127) throw new RangeError(`学科下标越界：${domainIndex}`);
  if (docId < 0 || docId > DOCID_MASK) throw new RangeError(`docId 越界（上限 ${DOCID_MASK}）：${docId}`);
  return (domainIndex << DOCID_BITS) | docId;
}

/** 拆回 (学科下标, docId)。 */
export function splitUid(uid: number): { domainIndex: number; docId: number } {
  return { domainIndex: uid >>> DOCID_BITS, docId: uid & DOCID_MASK };
}

/**
 * 邻接表文件的布局（`relations/<domain>.nbr.bin`）。
 *
 * 设计要点（**不要改成"存变长边表"**）：
 *   · **定长**：每篇论文恰好 `K` 条邻居记录 ⇒ 按 docId O(1) 随机访问。
 *     "点开一篇论文立刻看到它的邻居"必须是常数时间，否则交互会卡。
 *   · **不存全量同领域边**：同一层里有几十万篇论文，全量边是 O(n²)（物理团 10¹¹ 条）。
 *     这里对每篇只取 K 个**确定性采样**的邻居 —— 展示"同领域"足够，
 *     而且**同一篇论文每次取到的邻居都一样**（可复现，不做随机推荐）。
 *   · **类型与 uid 打包进一个 u32**：低 2 位是边类型，高 30 位是 (学科下标 6 位 + docId 24 位)。
 *     30 位 = 6 + 24，正好装得下，且省掉一次内存访问。
 *
 * 头部：magic "LUNYNBR1"(8) | count(u32) | k(u32) | recBytes(u32=4) | domainIndex(u32) | 保留(u32) = 24 字节
 * 记录：u32 × (k + 1)：第一条是**自己**（便于自检），其余 k 条是邻居。
 */
export const NBR_MAGIC = "LUNYNBR1";
export const NBR_HEAD_BYTES = 24;
export const NBR_REC_BYTES = 4;

/** 解析一条打包的邻居记录。 */
export function unpackNeighbor(packed: number): { kind: number; uid: number } {
  return { kind: packed & 0b11, uid: packed >>> 2 };
}

/** 打包一条邻居记录。 */
export function packNeighbor(kind: number, uid: number): number {
  if (uid >>> 30 !== 0) throw new RangeError(`uid 超出 30 位：${uid}`);
  return ((uid << 2) | (kind & 0b11)) >>> 0;
}
