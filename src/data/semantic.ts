/**
 * 论文云 · 语义层资产（GPU 管线的产物）
 * ============================================================================
 * 读 `public/data/semantic/` 下的四个文件，格式见 `pipeline_gpu/README.md`：
 *
 *   `<domain>.emb.bin`     LUNYEMB1 · 256 维 int8 嵌入（每篇 dim 字节）
 *   `<domain>.clu.bin`     LUNYCLU1 · 第 5 层簇归属（每篇 4 字节：u16 簇号 + u16 保留）
 *   `<domain>.route.bin`   LUNYROU1 · 第三类关系「同路线」边（每边 12 字节）
 *   `<domain>.labels.json`          · 第 5/6 层的中文名（c-TF-IDF 关键词）
 *
 * ## 为什么这些文件都能"整份进浏览器"
 *
 * 设计时就按"可整份加载"定的体积：256 维 int8 ⇒ 每篇 256 字节，
 * 物理团 146 万篇 ≈ 374 MB —— 太大，所以**按需加载、单学科一份**；
 * 而 econ 这种 1.2 万篇的团只有 3.2 MB。加载后一律**按 docId 直接下标寻址**，
 * 与 `rank.bin`、邻接表同一套约定，于是"点开一篇论文看它属于哪个研究点"是 O(1)。
 *
 * ## 两个刻意的设计
 *
 * 1. **缺文件不是错误，是"这个学科还没跑 GPU"**。所有 loader 都先看 manifest
 *    登记（`DomainEntry.semantic`），没登记就直接返回 null / 抛可读的错，
 *    而不是让界面显示一个点了没反应的按钮。
 * 2. **保留位当哨兵**。`clu.bin` 的每条第 2 个 u16 恒为 0；
 *    加载时校验它，一旦写出端错位（曾经真的按 2 字节写过）就能立刻发现，
 *    而不是画出满屏乱簇之后才有人察觉。
 */
import type { DomainEntry, SemanticAssets } from "./contract";

/** 嵌入文件头长度：magic 8 + count 4 + dim 4 + quant 4 + scale 4 = 24 */
const EMB_HEAD = 24;
/** 聚类文件头长度：magic 8 + count 4 + k 4 + recBytes 4 = 20 */
const CLU_HEAD = 20;
/** 同路线文件头长度：magic 8 + count 4 = 12 */
const ROUTE_HEAD = 12;
const ROUTE_REC = 12;

/** int8 反量化的默认比例（文件头里的 scale 缺失时用）。 */
const DEFAULT_SCALE = 1 / 127;

// ---------------------------------------------------------------- 嵌入

/**
 * 一份嵌入表。**按 docId O(1) 取向量，且不分配**（绘制/相似度计算会大量调用）。
 */
export class SemanticEmbedding {
  private readonly bytes: Uint8Array;
  readonly count: number;
  readonly dim: number;
  readonly scale: number;

  constructor(buf: ArrayBuffer) {
    const all = new Uint8Array(buf);
    const magic = String.fromCharCode(...all.subarray(0, 8));
    if (magic !== "LUNYEMB1") throw new Error(`嵌入魔法数不对：期望 LUNYEMB1，实际 ${magic}`);
    const view = new DataView(buf);
    this.count = view.getUint32(8, true);
    this.dim = view.getUint32(12, true);
    const quant = view.getUint32(16, true);
    if (quant !== 1) {
      // 不猜：格式未知时猜着读会得到"看起来像向量"的垃圾，比直接报错难查得多
      throw new Error(`嵌入量化方式未知（quant=${quant}）；只支持 int8（quant=1）`);
    }
    const scale = view.getFloat32(20, true);
    this.scale = scale > 0 ? scale : DEFAULT_SCALE;
    const need = EMB_HEAD + this.count * this.dim;
    if (all.byteLength !== need) {
      throw new Error(`嵌入长度不对：文件 ${all.byteLength}，应为 ${EMB_HEAD} + ${this.count}×${this.dim} = ${need}`);
    }
    this.bytes = all;
  }

  /** 第 docId 篇的**原始 int8 向量**（视图，不复制；越界返回 null）。 */
  rawVectorOf(docId: number): Uint8Array | null {
    if (docId < 0 || docId >= this.count) return null;
    const o = EMB_HEAD + docId * this.dim;
    return this.bytes.subarray(o, o + this.dim);
  }

  /**
   * 两篇论文的余弦相似度。
   *
   * 嵌入是**归一化后**再量化的，所以内积即余弦；int8 量化会让模长略微偏离 1，
   * 这里除以两个模长把它校正回来（否则相似度会系统性地偏小）。
   */
  cosine(docIdA: number, docIdB: number): number | null {
    const a = this.rawVectorOf(docIdA);
    const b = this.rawVectorOf(docIdB);
    if (!a || !b) return null;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < this.dim; i++) {
      const x = a[i];
      const y = b[i];
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? null : dot / denom;
  }
}

// ---------------------------------------------------------------- 聚类（第 5 层）

/**
 * 第 5 层「具体研究点」：**层内**聚类的簇归属，按 docId O(1)。
 */
export class SemanticClusters {
  private readonly view: DataView;
  readonly count: number;
  /** **全局最大**层内簇数（不是每层都用这么大 —— 见 contract.ts 的说明） */
  readonly k: number;
  readonly recordBytes: number;
  /** 实际出现过的不同簇号个数（用于如实报告"分出了多少个研究点"） */
  readonly distinct: number;

  constructor(buf: ArrayBuffer) {
    const all = new Uint8Array(buf);
    const magic = String.fromCharCode(...all.subarray(0, 8));
    if (magic !== "LUNYCLU1") throw new Error(`聚类魔法数不对：期望 LUNYCLU1，实际 ${magic}`);
    this.view = new DataView(buf);
    this.count = this.view.getUint32(8, true);
    this.k = this.view.getUint32(12, true);
    this.recordBytes = this.view.getUint32(16, true);
    if (this.recordBytes !== 4) {
      throw new Error(`聚类记录长度应为 4（u16 簇号 + u16 保留），实际 ${this.recordBytes} —— 格式变了吗？`);
    }
    const need = CLU_HEAD + this.count * this.recordBytes;
    if (all.byteLength !== need) {
      throw new Error(`聚类长度不对：文件 ${all.byteLength}，应为 ${need}`);
    }

    // 保留位是**哨兵**：写出端曾经按 2 字节写，于是读取端整体错位。
    // 这里显式校验，让那种错在加载时就炸，而不是画出乱簇之后才发现。
    let reservedNonZero = -1;
    const seen = new Set<number>();
    for (let i = 0; i < this.count; i++) {
      const o = CLU_HEAD + i * 4;
      if (reservedNonZero < 0 && this.view.getUint16(o + 2, true) !== 0) reservedNonZero = i;
      seen.add(this.view.getUint16(o, true));
    }
    if (reservedNonZero >= 0) {
      throw new Error(
        `聚类文件第 ${reservedNonZero} 条的保留位不是 0 —— 说明写出端按 2 字节错位了（见 pipeline_gpu/cluster.py）`,
      );
    }
    this.distinct = seen.size;
  }

  /** 第 docId 篇的簇号（越界返回 -1）。 */
  clusterOf(docId: number): number {
    if (docId < 0 || docId >= this.count) return -1;
    return this.view.getUint16(CLU_HEAD + docId * 4, true);
  }
}

// ---------------------------------------------------------------- 同路线边

export interface RouteNeighbor {
  readonly docId: number;
  readonly weight: number;
}

/**
 * 第三类关系「同路线」边（无向）。
 *
 * 文件本身是**边表**（按 a 升序），而界面要的是"某篇论文的同路线邻居"，
 * 所以加载时建一次 CSR 索引。用 CSR 而不是 `Map<number, []>`：
 * 路线边在物理团量级下可以有几十万条、涉及上万个节点，
 * 每个节点一个 JS 数组的对象开销比两个 TypedArray 大一个数量级。
 */
export class SemanticRoutes {
  readonly edgeCount: number;
  /** CSR：节点 docId 的邻居落在 [offsets[docId], offsets[docId+1]) */
  private readonly offsets: Uint32Array;
  private readonly neighbors: Uint32Array;
  private readonly weights: Float32Array;
  /** 有同路线边的最大 docId + 1（= 索引表的长度） */
  readonly nodeCapacity: number;
  /** 真正带边的节点数（用于如实报告覆盖） */
  readonly nodesWithRoutes: number;

  constructor(buf: ArrayBuffer) {
    const all = new Uint8Array(buf);
    const magic = String.fromCharCode(...all.subarray(0, 8));
    if (magic !== "LUNYROU1") {
      throw new Error(`同路线魔法数不对：期望 LUNYROU1（8 字节），实际 "${magic}"`);
    }
    const view = new DataView(buf);
    this.edgeCount = view.getUint32(8, true);
    const need = ROUTE_HEAD + this.edgeCount * ROUTE_REC;
    if (all.byteLength !== need) {
      throw new Error(`同路线长度不对：文件 ${all.byteLength}，应为 ${need}`);
    }

    // 先扫一遍求节点上界（边保证 a < b，所以最大节点就是最大的 b）
    let maxNode = -1;
    for (let i = 0; i < this.edgeCount; i++) {
      const o = ROUTE_HEAD + i * ROUTE_REC;
      const b = view.getUint32(o + 4, true);
      if (b > maxNode) maxNode = b;
    }
    this.nodeCapacity = maxNode + 1;

    // 度 → 前缀和 → 填充（标准 CSR 三步，O(E)）
    const deg = new Uint32Array(this.nodeCapacity + 1);
    for (let i = 0; i < this.edgeCount; i++) {
      const o = ROUTE_HEAD + i * ROUTE_REC;
      deg[view.getUint32(o, true)]++;
      deg[view.getUint32(o + 4, true)]++;
    }
    // 头两个 u32 存"有没有边"的标记不必要 —— 有 deg 就够
    this.offsets = new Uint32Array(this.nodeCapacity + 1);
    let acc = 0;
    let withRoutes = 0;
    for (let n = 0; n < this.nodeCapacity; n++) {
      this.offsets[n] = acc;
      acc += deg[n];
      if (deg[n] > 0) withRoutes++;
    }
    this.offsets[this.nodeCapacity] = acc;
    this.nodesWithRoutes = withRoutes;

    this.neighbors = new Uint32Array(acc);
    this.weights = new Float32Array(acc);
    const cursor = this.offsets.slice(0, this.nodeCapacity); // 可变副本
    for (let i = 0; i < this.edgeCount; i++) {
      const o = ROUTE_HEAD + i * ROUTE_REC;
      const a = view.getUint32(o, true);
      const b = view.getUint32(o + 4, true);
      const w = view.getFloat32(o + 8, true);
      this.neighbors[cursor[a]] = b;
      this.weights[cursor[a]] = w;
      cursor[a]++;
      this.neighbors[cursor[b]] = a;
      this.weights[cursor[b]] = w;
      cursor[b]++;
    }
  }

  /** 某篇论文的同路线邻居（按权重降序），最多 `limit` 个。 */
  routesOf(docId: number, limit = 50): RouteNeighbor[] {
    if (docId < 0 || docId >= this.nodeCapacity) return [];
    const s = this.offsets[docId];
    const e = this.offsets[docId + 1];
    const out: RouteNeighbor[] = [];
    for (let i = s; i < e; i++) out.push({ docId: this.neighbors[i], weight: this.weights[i] });
    out.sort((x, y) => y.weight - x.weight);
    return out.slice(0, limit);
  }

  /** 有没有边（界面用它决定要不要显示"同路线"这一项）。 */
  hasRoutes(docId: number): boolean {
    if (docId < 0 || docId >= this.nodeCapacity) return false;
    return this.offsets[docId + 1] > this.offsets[docId];
  }
}

// ---------------------------------------------------------------- 第 5/6 层标签

export interface ClusterLabel {
  readonly id: number;
  readonly papers: number;
  readonly zh: string;
  readonly top: readonly string[];
}

export class SemanticLabels {
  readonly method: string;
  readonly globalK: number;
  private readonly byStratum: Map<number, Map<number, ClusterLabel>>;
  /** 一共起了多少个名字 */
  readonly named: number;

  constructor(json: unknown) {
    const d = (json ?? {}) as {
      method?: string;
      globalK?: number;
      strata?: Record<string, ClusterLabel[]>;
    };
    this.method = d.method ?? "unknown";
    this.globalK = d.globalK ?? 0;
    this.byStratum = new Map();
    let named = 0;
    for (const [key, list] of Object.entries(d.strata ?? {})) {
      const s = Number(key);
      if (!Number.isFinite(s) || !Array.isArray(list)) continue;
      const inner = new Map<number, ClusterLabel>();
      for (const c of list) {
        if (typeof c?.id !== "number") continue;
        inner.set(c.id, {
          id: c.id,
          papers: c.papers ?? 0,
          zh: c.zh ?? "",
          top: Array.isArray(c.top) ? c.top : [],
        });
        named++;
      }
      this.byStratum.set(s, inner);
    }
    this.named = named;
  }

  /** 某个层里某个簇的名字（没有则返回 null —— 界面据此显示"未命名"而不是编一个）。 */
  labelOf(stratum: number, cluster: number): ClusterLabel | null {
    return this.byStratum.get(stratum)?.get(cluster) ?? null;
  }

  /** 某个层里所有已命名的研究点（层不参与聚类时为空）。 */
  labelsOfStratum(stratum: number): ClusterLabel[] {
    const m = this.byStratum.get(stratum);
    return m ? [...m.values()].sort((a, b) => b.papers - a.papers) : [];
  }

  get stratumCount(): number {
    return this.byStratum.size;
  }
}

// ---------------------------------------------------------------- 第 6 层：技术路线

/** 归属表里表示"这一篇不属于任何路线"的哨兵（没有同路线边的论文就是这样）。 */
export const NO_COMMUNITY = 0xffffffff;

/**
 * 第 6 层「技术路线」：Leiden 社区划分。
 *
 * 与 `clu.bin`（第 5 层）的区别值得说清，否则很容易混：
 *   · 第 5 层 `clu.bin` 是**层内**聚类 —— "某个研究方向内部的具体研究点"，
 *     所以簇号必须配合层号才有意义；
 *   · 第 6 层这里是**跨层**的社区发现 —— 在整团的同路线边上跑 Leiden，
 *     一个社区可以横跨多个研究方向，那正是"技术路线"的语义
 *     （例如"扩散模型"这条路会同时出现在 cv / lg / ml 几个方向里）。
 */
export class SemanticCommunities {
  readonly count: number;
  /** 社区（技术路线）条数 */
  readonly routeCount: number;
  readonly membershipCount: number;
  readonly degraded: boolean;
  readonly degradedReason: string | null;
  readonly modularity: number;
  readonly threshold: number;
  readonly evidence: readonly string[];
  /** 真正非空的社区数（`routeCount` 是算法声明的数量，可能含空社区） */
  readonly presentRoutes: number;

  private readonly view: DataView;
  private readonly sizes: Uint32Array;

  constructor(buf: ArrayBuffer, meta: unknown) {
    const all = new Uint8Array(buf);
    const magic = String.fromCharCode(...all.subarray(0, 8));
    if (magic !== "LUNYCMU1") throw new Error(`社区表魔法数不对：期望 LUNYCMU1，实际 ${magic}`);
    this.view = new DataView(buf);
    this.count = this.view.getUint32(8, true);
    this.routeCount = this.view.getUint32(12, true);
    const rec = this.view.getUint32(16, true);
    if (rec !== 4) {
      throw new Error(`社区记录长度应为 4（u32 社区号），实际 ${rec} —— 格式变了吗？`);
    }
    const need = 20 + this.count * rec;
    if (all.byteLength !== need) {
      throw new Error(`社区表长度不对：文件 ${all.byteLength}，应为 ${need}`);
    }

    const m = (meta ?? {}) as {
      membershipCount?: number;
      modularity?: number;
      threshold?: number;
      evidence?: string[];
      degraded?: boolean;
      degradedReason?: string | null;
    };
    this.membershipCount = m.membershipCount ?? 0;
    this.modularity = m.modularity ?? 0;
    this.threshold = m.threshold ?? 0;
    this.evidence = Array.isArray(m.evidence) ? m.evidence : [];
    // ⚠️ 降级状态**如实透传**，不在前端"补一个默认值"：
    //    共被引证据目前缺席，脚本会把 degraded 记为 true，
    //    界面必须能说出"这只是语义证据"，而不是显示成一个已验证的结论。
    this.degraded = m.degraded !== false;
    this.degradedReason = m.degradedReason ?? null;

    // 社区规模：扫一遍即可（物理团 146 万条也就十几毫秒）。
    // 用 Map 统计而不是直接写 `Uint32Array(routeCount)` ——
    // 万一表里的社区号超出声明的 k，定长数组会**静默越界截断**；
    // Map 不会，而且能顺便算出真实的最大社区号。
    const sizes = new Map<number, number>();
    for (let i = 0; i < this.count; i++) {
      const c = this.view.getUint32(20 + i * 4, true);
      if (c === NO_COMMUNITY) continue;
      sizes.set(c, (sizes.get(c) ?? 0) + 1);
    }
    let maxId = -1;
    for (const id of sizes.keys()) if (id > maxId) maxId = id;
    this.sizes = new Uint32Array(maxId + 1);
    for (const [id, n] of sizes) this.sizes[id] = n;
    this.presentRoutes = sizes.size;
  }

  /** 第 docId 篇所属的技术路线（-1 = 不属于任何路线；越界也返回 -1）。 */
  communityOf(docId: number): number {
    if (docId < 0 || docId >= this.count) return -1;
    const c = this.view.getUint32(20 + docId * 4, true);
    return c === NO_COMMUNITY ? -1 : c;
  }

  /** 某条路线有多少篇论文。 */
  sizeOf(community: number): number {
    if (community < 0 || community >= this.sizes.length) return 0;
    return this.sizes[community];
  }

  /** 规模最大的前 N 条路线（界面列"这个学科有哪些技术路线"用）。 */
  topRoutes(n = 10): { id: number; papers: number }[] {
    const out: { id: number; papers: number }[] = [];
    for (let id = 0; id < this.sizes.length; id++) {
      if (this.sizes[id] > 0) out.push({ id, papers: this.sizes[id] });
    }
    out.sort((x, y) => y.papers - x.papers);
    return out.slice(0, n);
  }
}

// ---------------------------------------------------------------- loader

export interface SemanticBundle {
  readonly entry: SemanticAssets;
  readonly clusters: SemanticClusters | null;
  readonly routes: SemanticRoutes | null;
  readonly labels: SemanticLabels | null;
  readonly communities: SemanticCommunities | null;
  /**
   * 嵌入**不随 bundle 一起下载**，要用的时候再调（结果会记住，重复调只下载一次）。
   *
   * ## 为什么必须懒加载
   *
   * 嵌入是这一族里**唯一按"全学科 × 256 维"增长**的资产：
   * 物理团 146 万篇 ⇒ **374 MB**；而面板要显示的东西（研究点是 `clu.bin`、
   * 技术路线是 `cmu.bin`、同路线邻居是 `route.bin`、名字是 `labels.json`）
   * **一个字节都不需要它**。
   *
   * 一开始是随 bundle 一起取的，于是"点一下「加载语义层」"在物理团上会白下 374 MB ——
   * 而它连一个消费者都没有（`src/ui/` 下搜不到 `bundle.embedding` 的使用）。
   * 这类"实现比需要多拉了几百 MB"的问题不会报错，只会让人觉得"这功能怎么这么慢"。
   *
   * 将来要做"语义近邻"（unlinked mentions）时，再显式调它。
   */
  loadEmbedding(): Promise<SemanticEmbedding | null>;
}

async function getBuf(base: string, path: string): Promise<ArrayBuffer> {
  const res = await fetch(`${base}/${path}`, { cache: "force-cache" });
  if (!res.ok) throw new Error(`加载 ${path} 失败：HTTP ${res.status}`);
  return await res.arrayBuffer();
}

async function getJson(base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}/${path}`, { headers: { accept: "application/json" }, cache: "force-cache" });
  if (!res.ok) throw new Error(`加载 ${path} 失败：HTTP ${res.status}`);
  return await res.json();
}

const cache = new Map<string, Promise<SemanticBundle>>();

/** 这个学科登记过语义层吗（没登记 = GPU 还没跑，不是"跑了但为空"）。 */
export function hasSemantic(entry: DomainEntry): boolean {
  const s = entry.semantic;
  return !!s && !!(s.embedding || s.clusters || s.routes || s.labels || s.communities);
}

/**
 * 加载某学科的语义层（带缓存）。
 *
 * **缺哪一份就返回 null，不抛错** —— 八个文件是七个独立步骤产出的，
 * 中途停下是完全正常的状态；界面据此显示"第 5 层可用、第 6 层还没有"，
 * 而不是整个学科都不可用。
 *
 * ⚠️ 只有 manifest 里**根本没登记** semantic 时才说明"还没跑 GPU"；
 * 登记了但某个文件 404，那是**构建不完整**，会被如实报出来（不静默降级）。
 */
export function loadSemantic(entry: DomainEntry, base = "/data"): Promise<SemanticBundle> {
  const dom = entry.id;
  const hit = cache.get(dom);
  if (hit) return hit;
  const p = (async (): Promise<SemanticBundle> => {
    const s = entry.semantic ?? {};

    // ⚠️ 这里**故意不**取嵌入 —— 见 SemanticBundle.loadEmbedding 的说明：
    //    物理团 374 MB，而面板要显示的东西一个字节都不需要它。
    //    它只在这个闭包里被记住，直到有人真的调 loadEmbedding()。
    let embPromise: Promise<SemanticEmbedding | null> | null = null;
    const loadEmbedding = (): Promise<SemanticEmbedding | null> => {
      if (!s.embedding) return Promise.resolve(null);
      embPromise ??= getBuf(base, s.embedding.file).then((b) => new SemanticEmbedding(b));
      return embPromise;
    };

    // 其余四份是**面板真的要用**的，并行取（原来是一个个 await，白白串行化）。
    const [clusters, routes, labels, communities] = await Promise.all([
      s.clusters ? getBuf(base, s.clusters.file).then((b) => new SemanticClusters(b)) : null,
      s.routes ? getBuf(base, s.routes.file).then((b) => new SemanticRoutes(b)) : null,
      s.labels ? getJson(base, s.labels.file).then((j) => new SemanticLabels(j)) : null,
      // 第 6 层要**两个文件一起**才有意义：表给归属、meta 给"是否降级"这类说明。
      // 缺一个就整体不加载 —— 只拿到表会让界面把"仅语义证据"说成一条已验证的路线。
      s.communities
        ? Promise.all([getBuf(base, s.communities.table), getJson(base, s.communities.meta)]).then(
            ([tab, meta]) => new SemanticCommunities(tab, meta),
          )
        : null,
    ]);

    return { entry: s, clusters, routes, labels, communities, loadEmbedding };
  })().catch((e) => {
    cache.delete(dom); // 失败不缓存，允许重试
    throw e;
  });
  cache.set(dom, p);
  return p;
}
