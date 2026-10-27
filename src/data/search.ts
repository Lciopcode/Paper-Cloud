/**
 * 论文云 · 浏览器内关键词检索（BM25）
 * ============================================================================
 * 为什么检索能放在浏览器里（而不是请求服务器）：
 *   先量了真实分布再决定（`pipeline/_measure-words.mjs`）：标题平均只有 **6.3 个不同词**，
 *   于是收录 df ≥ 5 的词之后，八团倒排索引合计只有 **126 MB**（1980 万条倒排）。
 *   数据本来就在本地，做成浏览器内索引就能做到"边打字边变暗" ——
 *   若走服务器查询，用户每敲一个字母都要一次往返，手感完全不同。
 *
 * ## 索引布局（与 `pipeline/build-search.mjs` 严格对应）
 *
 *   magic "LUNYIDX1"(8) | wordCount(u32) | postingCount(u32) | domainIndex(u32) | 保留(u32)
 *   词表：wordCount × 40 字节（UTF-8 补 0）
 *   词头：wordCount × 12 字节 = firstPosting(u32) | postingCount(u32) | df(u32)
 *   倒排：postingCount × 6 字节 = docId(u32) | tf(u16)   （按 docId 升序）
 *   docLen：count × 2 字节（每篇论文的词数，BM25 要用）
 *
 * ## 一个刻意的取舍：**不做前缀匹配**
 *
 * 词表是精确词。用户输入 "learn" 不会匹配到 "learning"。
 * 理由：加前缀匹配就要支持"一个查询命中多个词"，而每个词都可能对应十万条倒排，
 * 合并与打分的成本会成倍上升，而收益（省几个字母）远小于代价。
 * 界面上的做法是**给出候选词**让用户点，而不是猜。
 */

const IDX_MAGIC = "LUNYIDX1";
const WORD_BYTES = 40;
const HEAD_BYTES = 24;
const POSTING_BYTES = 6;
const WORD_HEAD_BYTES = 12;

/** 跨学科统一的 IDF 依据：全局总篇数 + 各词的全局文档频率。 */
export interface GlobalIdf {
  /** 参与检索的全部学科总篇数 */
  readonly totalDocs: number;
  /** 词 → 全局文档频率 */
  readonly df: ReadonlyMap<string, number>;
}

/** 一条检索命中的论文。 */
export interface SearchHit {
  readonly domain: string;
  readonly docId: number;
  /** BM25 分数（越大越相关） */
  readonly score: number;
}

/** 一次检索的结果。 */
export interface SearchResult {
  /** 查询词（已归一化） */
  readonly query: string;
  /** 命中的词（去掉停用词与未收录词之后的） */
  readonly terms: readonly string[];
  /** 未收录进索引的词（用于提示"这个词搜不到"） */
  readonly unknown: readonly string[];
  /** 总命中数（不只是返回的那些） */
  readonly total: number;
  /** 命中的论文集合：`"domain\u0000docId"` —— 渲染层用它决定哪颗星保持明亮 */
  readonly keys: ReadonlySet<string>;
  /** 最相关的若干篇（供"跳过去"用） */
  readonly top: readonly SearchHit[];
}

/** 命中集合的键（渲染层每帧要查很多次，用字符串键比对象键快且好调试）。 */
export function hitKey(domain: string, docId: number): string {
  return `${domain}\u0000${docId}`;
}

/** 停用词：与构建端保持一致，否则用户输入 "the" 会得到"未收录"的误导提示。 */
const STOP = new Set(
  `a an the of for and to in on with by from using via based new novel study analysis approach method
   methods model models results result paper we our this that these those its their can may show shows
   proposed present presents investigate investigated towards toward high low large small two three one
   first second also such are was were is be been has have had not but more most other others than then
   when where which who whom under over between during within without across about into through after
   before while same different used use uses case cases general specific number total due set sets
   its it its upon toward per via non yet thus hence therefore however moreover furthermore additionally
   respectively ie eg etc et al`.split(/\s+/).filter(Boolean),
);

/**
 * 把一个学科的检索索引读进内存。
 *
 * 注意：这里**不复制**倒排数据，而是直接在 `ArrayBuffer` 上按偏移读 ——
 * 126 MB 的索引若再复制一份会给浏览器造成不必要的内存压力。
 */
export class SearchIndex {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  readonly domain: string;
  readonly wordCount: number;
  readonly postingCount: number;
  readonly docCount: number;
  /** 平均文档长度（BM25 的 avgdl） */
  private readonly avgDocLen: number;
  /** docLen 区起始偏移 */
  private readonly docLenOff: number;
  /**
   * 倒排区起始偏移。
   *
   * ⚠️ **读倒排时必须加上这个基址**。踩过的坑：写成 `p = (h.first + k) * POSTING_BYTES`，
   * 少了基址，于是把**文件开头的词表区**当成 docId 读 ——
   * docId 变成乱码大数，再去读 docLen 就越界。
   * 而且它**不一定立刻崩**（物理团就侥幸没崩，只是分数全是垃圾），
   * 所以这类错误会伪装成"能搜但结果不准"。
   */
  private readonly postingOff: number;

  constructor(buf: ArrayBuffer, domain: string) {
    this.view = new DataView(buf);
    this.bytes = new Uint8Array(buf);
    this.domain = domain;
    const magic = String.fromCharCode(...this.bytes.subarray(0, 8));
    if (magic !== IDX_MAGIC) {
      throw new Error(`检索索引魔法数不对：期望 ${IDX_MAGIC}，实际 ${magic}`);
    }
    this.wordCount = this.view.getUint32(8, true);
    this.postingCount = this.view.getUint32(12, true);
    const wordOff = HEAD_BYTES;
    const wordHeadOff = wordOff + this.wordCount * WORD_BYTES;
    const postingOff = wordHeadOff + this.wordCount * WORD_HEAD_BYTES;
    this.postingOff = postingOff;
    this.docLenOff = postingOff + this.postingCount * POSTING_BYTES;
    // docLen 区长度 = 该学科论文数 × 2。用文件长度反推，避免再多传一个字段。
    const remaining = buf.byteLength - this.docLenOff;
    this.docCount = Math.max(0, Math.floor(remaining / 2));

    // avgdl：BM25 要用。抽样 2000 篇算平均，不必遍历全部（图快）
    let sum = 0;
    const step = Math.max(1, Math.floor(this.docCount / 2000));
    let n = 0;
    for (let i = 0; i < this.docCount; i += step) {
      sum += this.view.getUint16(this.docLenOff + i * 2, true);
      n++;
    }
    this.avgDocLen = n > 0 ? Math.max(1, sum / n) : 1;
  }

  /** 二分查找词 → 词号（找不到返回 -1）。词表按字典序排列。 */
  private wordIdOf(word: string): number {
    let lo = 0;
    let hi = this.wordCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w = this.wordAt(mid);
      if (w === word) return mid;
      if (w < word) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private wordAt(i: number): string {
    const off = HEAD_BYTES + i * WORD_BYTES;
    let end = off;
    const limit = off + WORD_BYTES;
    while (end < limit && this.bytes[end] !== 0) end++;
    return new TextDecoder("utf-8").decode(this.bytes.subarray(off, end));
  }

  private wordHead(i: number): { first: number; count: number; df: number } {
    const off = HEAD_BYTES + this.wordCount * WORD_BYTES + i * WORD_HEAD_BYTES;
    return {
      first: this.view.getUint32(off, true),
      count: this.view.getUint32(off + 4, true),
      df: this.view.getUint32(off + 8, true),
    };
  }

  /** 取所有以 `prefix` 开头的候选词（供界面提示用；最多 `limit` 个）。 */
  suggest(prefix: string, limit = 8): string[] {
    if (!prefix) return [];
    // 二分找到第一个 ≥ prefix 的词，然后顺序扫
    let lo = 0;
    let hi = this.wordCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.wordAt(mid) < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < this.wordCount && out.length < limit; i++) {
      const w = this.wordAt(i);
      if (!w.startsWith(prefix)) break;
      out.push(w);
    }
    return out;
  }

  /**
   * 取某个词的**文档频率**（df）与索引篇数，供跨学科统一 IDF 使用。
   *
   * ⚠️ 为什么必须统一：`idf = log(1 + (N - df + 0.5)/(df + 0.5))` 里的 N 是**该索引的篇数**。
   * 若各学科各算各的，同一个词在**小团**里会因为"占比更高"而拿到更大的 idf ——
   * 实测踩过：搜 "quantum" 时排在最前的是 stat / eess 的论文，
   * 而 physics（"quantum" 在那出现 21,759 次）反而排在后面。那是**度量不一致**，
   * 不是真实相关性，而且从小团里挑出的"最相关"看起来会莫名其妙。
   * 修法：所有学科都用**全局** (N, df) 算 idf，只有 tf 与文档长度用本学科的。
   */
  termStats(word: string): { df: number } | null {
    const id = this.wordIdOf(word);
    if (id < 0) return null;
    return { df: this.wordHead(id).df };
  }

  /** 本索引的篇数（供全局 idf 汇总）。 */
  get totalDocs(): number {
    return this.docCount;
  }

  /**
   * BM25 检索。
   *
   * 参数 `k1=1.2`、`b=0.75` 是 BM25 的常用默认值（文献里对短文本也稳定）。
   * 因为标题很短，`b`（长度归一化强度）取 0.75 不会像长文档那样产生奇怪的结果。
   *
   * `topLimit` 控制返回的**排序结果条数**（`top`）。
   * ⚠️ 注意 `keys`（用于"哪些星保持明亮"）始终是**全量命中集**，不受它限制 ——
   * 用户要的是"输入关键词后，其他星系星球剔除，只有相关的原样亮着"，
   * 那就必须知道全部命中，只返回前 N 条会让画面少亮一片。
   * 代价是常见词（如 "quantum" 命中 13 万篇）会构建一个十几万元的 Set，这是可接受的。
   *
   * `globalIdf` 传了就按**全局** (N, df) 算 idf（跨学科检索必须传，见上面的说明）。
   */
  search(query: string, topLimit = 200, globalIdf?: GlobalIdf): SearchResult {
    try {
      return this.searchInner(query, topLimit, globalIdf);
    } catch (e) {
      // 把上下文带上再抛。
      // ⚠️ 不加这层包装时，调用方只能看到 "Offset is outside the bounds of the DataView"，
      //    无法判断是**哪个学科**的索引出的问题（八团各自一个文件），排查会很盲目。
      throw new Error(
        `检索索引读取越界（学科 ${this.domain} · 词 ${this.wordCount} · 倒排 ${this.postingCount} · ` +
          `文档 ${this.docCount} · docLenOff ${this.docLenOff}）：${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private searchInner(query: string, topLimit: number, globalIdf?: GlobalIdf): SearchResult {
    const raw = query.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? [];
    const terms: string[] = [];
    const unknown: string[] = [];
    for (const t of raw) {
      if (t.length < 3 || STOP.has(t)) continue;
      if (terms.includes(t)) continue;
      if (this.wordIdOf(t) < 0) unknown.push(t);
      else terms.push(t);
    }
    if (terms.length === 0) {
      return { query, terms: [], unknown, total: 0, keys: new Set(), top: [] };
    }

    // idf 的 (N, df)：**优先用全局**（跨学科检索必须如此，见 termStats 的说明）
    const N = Math.max(1, globalIdf ? globalIdf.totalDocs : this.docCount);
    const k1 = 1.2;
    const b = 0.75;
    /** 取某词的 idf —— 全局有记录就用全局 df，否则退回本索引的 df */
    const idfOf = (word: string, localDf: number): number => {
      const df = globalIdf?.df.get(word) ?? localDf;
      return Math.log(1 + (N - df + 0.5) / (df + 0.5));
    };

    // 单查询词的常见情形：不必建 Map，直接算出分数即可（省一次百万级的哈希插入）
    if (terms.length === 1) {
      const id = this.wordIdOf(terms[0]);
      const h = this.wordHead(id);
      const idf = idfOf(terms[0], h.df);
      const scores: SearchHit[] = [];
      for (let k = 0; k < h.count; k++) {
        const p = this.postingOff + (h.first + k) * POSTING_BYTES;
        const docId = this.view.getUint32(p, true);
        const tf = this.view.getUint16(p + 4, true);
        const dl = this.view.getUint16(this.docLenOff + docId * 2, true);
        const denom = tf + k1 * (1 - b + (b * dl) / this.avgDocLen);
        scores.push({ domain: this.domain, docId, score: idf * ((tf * (k1 + 1)) / (denom || 1)) });
      }
      scores.sort((a, c) => c.score - a.score);
      return {
        query,
        terms,
        unknown,
        total: scores.length,
        keys: new Set(scores.map((s) => hitKey(s.domain, s.docId))),
        top: scores.slice(0, topLimit),
      };
    }

    // 多查询词：累加分数（OR 语义）
    const acc = new Map<number, number>();
    for (const t of terms) {
      const id = this.wordIdOf(t);
      const h = this.wordHead(id);
      const idf = idfOf(t, h.df);
      for (let k = 0; k < h.count; k++) {
        const p = this.postingOff + (h.first + k) * POSTING_BYTES;
        const docId = this.view.getUint32(p, true);
        const tf = this.view.getUint16(p + 4, true);
        const dl = this.view.getUint16(this.docLenOff + docId * 2, true);
        const denom = tf + k1 * (1 - b + (b * dl) / this.avgDocLen);
        acc.set(docId, (acc.get(docId) ?? 0) + idf * ((tf * (k1 + 1)) / (denom || 1)));
      }
    }
    const scores: SearchHit[] = [];
    for (const [docId, score] of acc) scores.push({ domain: this.domain, docId, score });
    scores.sort((a, c) => c.score - a.score);
    return {
      query,
      terms,
      unknown,
      total: scores.length,
      keys: new Set(scores.map((s) => hitKey(s.domain, s.docId))),
      top: scores.slice(0, topLimit),
    };
  }
}

/** 索引缓存：一个学科只读一次。 */
const cache = new Map<string, Promise<SearchIndex>>();

/**
 * 加载某学科的检索索引。
 *
 * 单团最大 62 MB（物理），**只有用户真的用搜索时才加载** —— 首屏绝不带它。
 */
export function loadSearchIndex(domain: string, url: string): Promise<SearchIndex> {
  const hit = cache.get(domain);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`加载检索索引失败：HTTP ${res.status} ${url}`);
    return new SearchIndex(await res.arrayBuffer(), domain);
  })().catch((e) => {
    cache.delete(domain);
    throw e;
  });
  cache.set(domain, p);
  return p;
}
