/**
 * 论文云 · 引用次数表
 * ============================================================================
 * 读取 `public/data/cites/<domain>.bin`：每篇论文 **8 字节**，按 docId 索引。
 *
 *     u32 cites | u16 year | u8 venueTier | u8 flags
 *
 *     flags bit0 = 在数据源里**查到了记录**（0 = 对端没收录这篇）
 *
 * ## 为什么必须区分"查到 0 引用"与"没有记录"
 *
 * 这两件事在数值上都是 0，但意义完全不同：
 *   · 查到 0 引用 —— 这篇确实还没被引用过，应该画得很暗；
 *   · 没有记录   —— 我们**不知道**它被引用了多少次，不该假装它很暗。
 *
 * 混在一起会让"不够知名的论文"和"数据缺失的论文"看起来一样，
 * 而这恰恰是做「引用 → 亮度」最容易误导人的地方。
 * 所以本模块把两者分开暴露（`hasRecord`），界面据此区别对待并如实报告覆盖率。
 *
 * ## 亮度用对数刻度（这是必须的，不是审美选择）
 *
 * 引用次数的分布是极重尾的：实测最高 196,853 而中位数是 0。
 * 线性映射会让除了极少数几篇之外**全部论文都是同一个亮度** ——
 * 等于没有编码。用 `log(1+cites)` 之后动态范围才落到可用的区间里。
 */

/** 记录里 flags 字节的位约定（与 `pipeline/harvest-*.mjs` 对应）。 */
export const CITE_FLAG_HAS_RECORD = 1;

const REC_BYTES = 8;
const MAGIC = "LUNYCITE";

export interface CiteInfo {
  readonly cites: number;
  readonly year: number;
  readonly venueTier: number;
  /** 数据源里查到了这篇（false = 数据缺失，不是"0 引用"） */
  readonly hasRecord: boolean;
}

/**
 * 一份引用表。
 *
 * 定长记录 + 直接下标寻址，所以 `get(docId)` 是 O(1) —— 绘制时要为每颗星取一次，
 * 上百万次调用不能有任何分配（`CiteInfo` 只在显式调用 `get` 时构造，
 * 绘制路径用下面那几个**不分配**的原始读取方法）。
 */
export class CiteTable {
  private readonly view: DataView;
  readonly count: number;
  /** 有记录的比例（0..100），界面用它如实报告覆盖率 */
  readonly coveragePct: number;
  /** 引用次数的最大值 —— 亮度归一化用 */
  readonly maxCites: number;
  /**
   * 亮度的**归一化基准**（第 99 百分位附近，不是最大值）。
   *
   * 为什么不用最大值：一个 20 万次引用的离群点会把其余全部压到接近 0。
   * 用高分位之后绝大多数论文落在可分辨的区间里，而极少数超高分只是"亮到顶"——
   * 那正是我们想要的观感（它们本来就该最亮）。
   */
  readonly scaleCites: number;

  constructor(buf: ArrayBuffer) {
    const bytes = new Uint8Array(buf);
    const header = String.fromCharCode(...bytes.subarray(0, 8));
    if (header !== MAGIC) {
      throw new Error(`引用表魔法数不对：期望 ${MAGIC}，实际 ${header}`);
    }
    this.view = new DataView(buf);
    this.count = this.view.getUint32(8, true);
    const maxCites = this.view.getUint32(12, true);
    this.maxCites = maxCites;
    this.coveragePct = this.view.getUint32(16, true) / 100;
    this.scaleCites = Math.max(1, this.view.getUint32(20, true));
  }

  private offsetOf(docId: number): number {
    // 头部：magic 8 + count 4 + maxCites 4 + coveragePct 4 + scaleCites 4 = 24
    return 24 + docId * REC_BYTES;
  }

  /** 引用次数（越界或缺失一律返回 0；**不做边界抛错** —— 绘制路径要能容忍缺数据）。 */
  citesOf(docId: number): number {
    if (docId < 0 || docId >= this.count) return 0;
    return this.view.getUint32(this.offsetOf(docId), true);
  }

  /** 是否有记录（区分"0 引用"与"数据缺失"）。 */
  hasRecordOf(docId: number): boolean {
    if (docId < 0 || docId >= this.count) return false;
    return (this.view.getUint8(this.offsetOf(docId) + 7) & CITE_FLAG_HAS_RECORD) !== 0;
  }

  yearOf(docId: number): number {
    if (docId < 0 || docId >= this.count) return 0;
    return this.view.getUint16(this.offsetOf(docId) + 4, true);
  }

  /**
   * 亮度系数（绘制路径用，**不分配对象**）。
   *
   * 返回 0.75 ~ 2.6 之间：
   *   · 0.75 —— 没有记录。**比"确认 0 引用"更亮**，因为"不知道"不该被画成"很暗"；
   *   · 1.00 —— 查到记录但 0 引用（最暗的一档，但仍是可见的星）；
   *   · 2.60 —— 高被引（截顶，避免离群点独占动态范围）。
   */
  brightOf(docId: number): number {
    if (docId < 0 || docId >= this.count) return 0.75;
    const o = this.offsetOf(docId);
    if ((this.view.getUint8(o + 7) & CITE_FLAG_HAS_RECORD) === 0) return 0.75;
    const c = this.view.getUint32(o, true);
    if (c === 0) return 1.0;
    // log1p 归一化到 [0,1]，再映射到 [1.0, 2.6]
    const t = Math.min(1, Math.log1p(c) / Math.log1p(this.scaleCites));
    return 1.0 + 1.6 * t;
  }

  info(docId: number): CiteInfo | null {
    if (docId < 0 || docId >= this.count) return null;
    const o = this.offsetOf(docId);
    return {
      cites: this.view.getUint32(o, true),
      year: this.view.getUint16(o + 4, true),
      venueTier: this.view.getUint8(o + 6),
      hasRecord: (this.view.getUint8(o + 7) & CITE_FLAG_HAS_RECORD) !== 0,
    };
  }
}

/** 取某个学科的引用表（带缓存；同一学科只下载/解析一次）。 */
const cache = new Map<string, Promise<CiteTable>>();

export function loadCites(domain: string, base = "/data"): Promise<CiteTable> {
  const hit = cache.get(domain);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`${base}/cites/${domain}.bin`, { cache: "force-cache" });
    if (!res.ok) throw new Error(`引用表下载失败（HTTP ${res.status}）`);
    return new CiteTable(await res.arrayBuffer());
  })().catch((e) => {
    cache.delete(domain); // 失败不缓存，允许重试
    throw e;
  });
  cache.set(domain, p);
  return p;
}
