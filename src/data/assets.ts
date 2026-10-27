/**
 * 论文云 · 资产加载层
 * ============================================================================
 * 唯一允许"碰文件"的地方（浏览器里就是 HTTP）。上层（渲染/状态/界面）**不许**自己 fetch。
 *
 * 加载策略（关系到 305 万篇能不能在浏览器里跑起来）：
 *   · manifest  —— 首屏立即加载（几 KB）
 *   · vocab     —— 进入某个星团时加载（几十 KB）
 *   · spine     —— 进入某个星团时加载（全量约 220 MB，brotli 后约 60 MB；**按学科**加载，
 *                  最大的物理团约 105 MB / brotli 约 28 MB）
 *   全部**只加载一次并缓存**（Promise 缓存，避免并发重复请求，也避免失败被永久缓存）。
 *
 * `.br` 的处理：静态服务器带 `Content-Encoding: br` 提供预压缩文件，
 * 浏览器**透明解压**。因此这里不需要（也不能）自己解 brotli ——
 * 浏览器不支持 `DecompressionStream('brotli')`，这一点是实测确认过的。
 */
import type { Manifest, SpineRecord, VocabAsset } from "./contract";
import {
  DOCID_BITS,
  DOCID_MASK,
  NBR_HEAD_BYTES,
  NBR_MAGIC,
  NBR_REC_BYTES,
  unpackNeighbor,
} from "./relations";

const BASE = "/data";

/** spine.bin 的布局常量（必须与 `pipeline/build-spine.mjs` 严格一致）。 */
const SPINE_MAGIC = "LUNYSPN1";
const SPINE_DEMO_MAGIC = "LUNYSPD1";
const VALUE_BYTES = 32;
/**
 * 头部长度**按类型区分**（这一点极易错，错一个字节整份数据就全错位）：
 *   · 完整脊柱 `LUNYSPN1`：magic(8) + count(4) + slots(4) + recBytes(4) = **20 字节**
 *   · 演示脊柱 `LUNYSPD1`：在完整头之后多一个 stride(4) + 保留(4) = **32 字节**
 *
 * ⚠️ 踩过的坑：客户端曾对两种脊柱都用 20 字节头部，
 * 于是读演示脊柱时整体**错位 12 字节** —— 读到的 rank 是 77 位（实际 70–72 位），
 * 于是报"编号超出目录范围"。而把演示文件与完整文件逐条比对是**零差异**，
 * 长时间误判成"浏览器缓存了旧文件"。教训：**逐字节偏移必须由头部自身声明**，
 * 不要让调用方假设；下面 `this.headBytes` 就是按实际读到的 magic 定的。
 */
const SPINE_FULL_HEAD = 20;
const SPINE_DEMO_HEAD = 32;

/**
 * 资产版本：**从 manifest 的 generatedAt 自动推导**，不是手写常量。
 *
 * 为什么必须自动：本地服务器对 `/data/` 发 `cache-control: no-cache`（允许复用 + 需校验），
 * 而资产文件名是固定的（`spine.bin`、`vocab.json`…）。
 * **数据重建后若版本号没跟着变，浏览器就会继续用旧副本** —— 这是最难查的一类 bug：
 * 磁盘上的文件是对的，但页面里用的是旧字节。
 * （实测踩过：演示脊柱格式修正后页面仍读旧记录，报"编号超出目录范围"，
 *   而把文件逐条比对是**零差异** —— 排查了很久才发现是缓存。）
 *
 * 推导规则：`generatedAt`（ISO 时间戳）→ 只留数字 → 取前 14 位。
 * 每次 build-spine 重跑都会写新的 generatedAt，所以版本必然更新。
 */
let dataVersion = "0";

/** 已加载的 manifest（供延迟构造元数据读取器用）。 */
let manifestCache: Manifest | null = null;

/** manifest 自身**不带版本**（它是版本的来源），因此单独用一个固定的缓存键。 */
const MANIFEST_URL = `${BASE}/manifest.json`;

/** 供其他模块拼资产 URL（带数据版本号，见文件头关于缓存的说明）。 */
export function assetUrlFor(path: string): string {
  return assetUrl(path);
}

function assetUrl(path: string): string {
  return `${BASE}/${path}${path.includes("?") ? "&" : "?"}v=${dataVersion}`;
}

/** 读定宽 32 字节大端无符号整数（与构建端 writeValue 严格对应）。 */
function readBig(bytes: Uint8Array, offset: number): bigint {
  let x = 0n;
  for (let i = 0; i < VALUE_BYTES; i++) x = (x << 8n) | BigInt(bytes[offset + i]);
  return x;
}

// ---------------------------------------------------------------- 论文元数据

/** 索引记录里 flags 字段的位约定（与 `pipeline/build-meta.mjs` 对应）。 */
export const FLAG_CROSS_LISTED = 1;
export const FLAG_HAS_VENUE = 2;

/** 元数据索引记录里内联的信息（**零额外请求**就能拿到）。 */
export interface MetaHead {
  readonly docId: number;
  readonly titleHead: string;
  readonly venueHead: string;
  readonly year: number;
  readonly cites: number;
  readonly venueTier: number;
  readonly authorCount: number;
  /** 是否值得去取摘要（false = 这篇没有摘要） */
  readonly hasAbstract: boolean;
  /**
   * 是否**交叉列表**（挂了多个 arXiv 分类）—— 即"跨学科论文"。
   *
   * 这是"星尘流"的依据：星桥（星系之间的弧）显示的是**强度**，
   * 而真正构成桥的是这些论文。把它们高亮出来，才能从"两个领域有联系"
   * 走到"联系是由这些具体工作建立的"。
   */
  readonly crossListed: boolean;
  /** 是否识别出正式发表去处 */
  readonly hasVenue: boolean;
}

/** 完整元数据（标题与作者已从文本池取出）。 */
export interface MetaFull extends MetaHead {
  readonly title: string;
  readonly authors: string;
  readonly venue: string;
}

/**
 * 元数据读取器：**按 docId O(1) 随机访问**，用 HTTP `Range` 只取需要的字节。
 *
 * ## 为什么这样设计（这是整个元数据层的关键取舍）
 *
 * 标题 188 MB + 摘要 2.1 GB + 作者 ≈ 2.5 GB，整份下载不可能。
 * 但"点开一篇论文看它的标题/作者"只需要几百字节。
 * 所以：
 *   · 索引是**定长**的 ⇒ 给定 docId 直接算出字节偏移，不需要查找；
 *   · 文本池**不压缩** ⇒ 服务器能按 Range 返回精确区间（压缩后必须先解压前面全部内容）；
 *   · 记录里还内联了标题前 17 字节与去处名 ⇒ **点开就立刻有字**，完整标题随后补齐。
 *
 * ## 一个刻意的行为：批量取数会合并请求
 *
 * "相关论文"面板一次要显示 4 篇的标题。若逐篇请求就是 4 次往返。
 * `getMany` 于是把请求按**邻近程度**合并成少数几个 Range 请求
 * （标题在池里基本是按 docId 顺序排列的，所以相邻 docId 的标题往往挨在一起）。
 */
export class MetaReader {
  readonly count: number;
  private readonly rec: number;
  private readonly headBytes: number;
  private readonly view: DataView;

  constructor(indexBuf: ArrayBuffer, meta: NonNullable<Manifest["domains"][number]["meta"]>) {
    this.view = new DataView(indexBuf);
    const bytes = new Uint8Array(indexBuf);
    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    if (magic !== META_MAGIC) {
      throw new Error(`元数据索引魔法数不对：期望 ${META_MAGIC}，实际 ${magic}`);
    }
    const count = this.view.getUint32(8, true);
    this.rec = this.view.getUint32(12, true);
    this.headBytes = this.view.getUint32(24, true);
    if (this.rec !== meta.recordBytes) {
      throw new Error(
        `元数据记录长度不一致：文件是 ${this.rec}，manifest 声明 ${meta.recordBytes}（重新构建即可）`,
      );
    }
    if (isFinite(meta.count) && meta.count > 0 && count !== meta.count) {
      throw new Error(`元数据篇数与 manifest 不一致：文件 ${count}，manifest ${meta.count}`);
    }
    this.count = count;
    const need = META_HEAD_BYTES + count * this.rec;
    if (indexBuf.byteLength < need) {
      throw new Error(`元数据索引长度不足：需要 ${need}，实际 ${indexBuf.byteLength}`);
    }
  }

  private offsetOf(docId: number): number {
    return META_HEAD_BYTES + docId * this.rec;
  }

  /** 取记录里内联的部分（不发任何网络请求）。 */
  head(docId: number): MetaHead | null {
    if (docId < 0 || docId >= this.count) return null;
    const o = this.offsetOf(docId);
    const absLen = this.view.getUint32(o + 14, true);
    const venueLen = this.view.getUint8(o + 27);
    return {
      docId,
      // 按**实际长度**读：记录里的 titleHead/venueHead 是定长补零的，
      // 读满长度会把填充的 0 也读进来（见 readUtf8 的说明）。
      titleHead: readUtf8(this.view, o + 32, Math.min(this.headBytes, 17)),
      venueHead: venueLen > 0 ? readUtf8(this.view, o + 53, Math.min(venueLen, 11)) : "",
      year: this.view.getUint16(o + 18, true),
      cites: this.view.getUint32(o + 20, true),
      venueTier: this.view.getUint8(o + 24),
      authorCount: this.view.getUint8(o + 25),
      hasAbstract: absLen > 0,
      crossListed: (this.view.getUint8(o + 26) & FLAG_CROSS_LISTED) !== 0,
      hasVenue: (this.view.getUint8(o + 26) & FLAG_HAS_VENUE) !== 0,
    };
  }

  /**
   * 抽出**全部论文的交叉列表标记**（每位 1 字节，0/1）。
   *
   * 供"星尘流"用：需要筛出所有跨学科论文，而逐篇 `head()` 会有上百万次
   * 字符串解码（titleHead / venueHead），很浪费。这里是纯整数读取。
   */
  crossTable(): Uint8Array {
    const out = new Uint8Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = (this.view.getUint8(this.offsetOf(i) + 26) & FLAG_CROSS_LISTED) !== 0 ? 1 : 0;
    }
    return out;
  }

  /** 该篇论文在文本池里的字节区间。 */
  textRange(docId: number): { off: number; len: number } {
    const o = this.offsetOf(docId);
    return { off: this.view.getUint32(o + 4, true), len: this.view.getUint16(o + 8, true) };
  }

  /** 该篇论文的去处名字节区间。 */
  venueRange(docId: number): { off: number; len: number } {
    const o = this.offsetOf(docId);
    return { off: this.view.getUint32(o + 28, true), len: this.view.getUint8(o + 27) };
  }

  /** 该篇论文的摘要字节区间（len = 0 表示没有摘要）。 */
  abstractRange(docId: number): { off: number; len: number } {
    if (docId < 0 || docId >= this.count) return { off: 0, len: 0 };
    const o = this.offsetOf(docId);
    return { off: this.view.getUint32(o + 10, true), len: this.view.getUint32(o + 14, true) };
  }

  /**
   * 抽出**全部论文的年份**（每篇 2 字节）。
   *
   * 供"时间排列模式"用：它需要每一篇的年份，而逐篇 `head()` 会有 146 万次函数调用
   * （每次都做字符串解码，很浪费）。这里是纯整数搬运，快得多。
   */
  yearTable(): Uint16Array {
    const out = new Uint16Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.view.getUint16(this.offsetOf(i) + 18, true);
    }
    return out;
  }
}

/**
 * 读一段字节并按 UTF-8 解出字符串。
 *
 * ⚠️ **遇到 NUL（0x00）就停**，这是必须的：记录里的内联字段（标题前缀 / 去处名）
 * 是**定长**的、不足处补 0。若把这些 0 也解进字符串，会得到一个由 `\u0000` 组成的串 ——
 * 而 `\u0000` **不是空白字符**，`String.trim()` 清不掉它，
 * 于是在界面上表现为"有一个'发表'标签、后面却是一块空白框"
 * （实测踩过：`venueLen=0` 的论文却显示了一个空的发表徽标）。
 * 这与编号定长补零被当成"词表第 0 个词"是同一类错误：**定长填充必须显式还原**。
 */
function readUtf8(view: DataView, offset: number, len: number): string {
  if (len <= 0) return "";
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, len);
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  if (end === 0) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, end));
}

/**
 * 某学科**全部论文的层号表**（按 docId 索引，每篇 2 字节）。
 *
 * 供"超新星遗迹"用：点一个爆发点后要精确定位"那个方向、那一年的论文"，
 * 需要层号与年份两张表（年份表见 `loadYearTable`）。
 * 物理团这张表 1.4 MB（146 万篇 × 2 字节），比 89 MB 的元数据索引便宜得多，
 * 而且只需建一次。
 */
const stratumTableCache = new Map<string, Promise<Uint16Array>>();

export function loadStratumTable(domain: string): Promise<Uint16Array> {
  const hit = stratumTableCache.get(domain);
  if (hit) return hit;
  const p = (async () => {
    const r = await loadRankTable(domain);
    return r.stratumTable();
  })().catch((e) => {
    stratumTableCache.delete(domain);
    throw e;
  });
  stratumTableCache.set(domain, p);
  return p;
}

/**
 * 某学科**全部论文的年份表**（按 docId 索引），供"时间排列模式"用。
 *
 * 为什么单独做一张表：年份住在元数据索引的每条记录里（偏移 +18 的 u16），
 * 而元数据索引是按需加载的（单团最大 93 MB）。时间模式需要**每一篇**的年份，
 * 所以这里一次性抽成一张紧凑的表（每篇 2 字节，物理团 2.9 MB），
 * 之后反复用都不必再碰那个 93 MB 的索引。
 */
const yearTableCache = new Map<string, Promise<Uint16Array>>();

export function loadYearTable(domain: string): Promise<Uint16Array> {
  const hit = yearTableCache.get(domain);
  if (hit) return hit;
  const p = (async () => {
    const store = metaStoreOf(domain);
    if (!store) throw new Error(`manifest 里没有 ${domain} 的元数据登记`);
    const r = await store.ensure();
    return r.yearTable();
  })().catch((e) => {
    yearTableCache.delete(domain);
    throw e;
  });
  yearTableCache.set(domain, p);
  return p;
}

/**
 * 某学科**全部论文的交叉列表标记**（按 docId 索引，每位 1 字节）。
 *
 * 供"星尘流"用：要筛出所有跨学科论文。与年份表同理 ——
 * 一次性抽成紧凑数组（物理团 1.4 MB），之后反复用都不必再碰 89 MB 的索引。
 */
const crossTableCache = new Map<string, Promise<Uint8Array>>();

export function loadCrossTable(domain: string): Promise<Uint8Array> {
  const hit = crossTableCache.get(domain);
  if (hit) return hit;
  const p = (async () => {
    const store = metaStoreOf(domain);
    if (!store) throw new Error(`manifest 里没有 ${domain} 的元数据登记`);
    const r = await store.ensure();
    return r.crossTable();
  })().catch((e) => {
    crossTableCache.delete(domain);
    throw e;
  });
  crossTableCache.set(domain, p);
  return p;
}

/** 元数据索引的头部长度（magic 8 + count 4 + recBytes 4 + txtLen 4 + absLen 4 + headBytes 4 + venLen 4）。 */
const META_HEAD_BYTES = 32;
const META_MAGIC = "LUNYMETA";

/**
 * 带 `Range` 的字节取数。
 *
 * 这是"点开一篇论文只下几百字节"能成立的唯一机制。
 * ⚠️ 必须检查 206 状态码：服务器若不支持 Range 会返回 200 + 整个文件，
 * 那样单次点开会静默下载上百 MB —— 看起来只是"有点慢"，极难发现。
 * 所以这里显式要求 206，否则抛错。
 */
async function getRange(relPath: string, off: number, len: number): Promise<string> {
  if (len <= 0) return "";
  const res = await fetch(assetUrl(relPath), {
    headers: { Range: `bytes=${off}-${off + len - 1}` },
  });
  if (res.status !== 206) {
    throw new Error(
      `服务器未按 Range 返回（状态 ${res.status}，期望 206）：${relPath}。` +
        `本地服务器需支持 Range，且该文件不能是 .br 压缩版。`,
    );
  }
  return await res.text();
}

/**
 * 某个学科的元数据读取器（懒加载）。
 *
 * 为什么要包一层：索引本身有 116 MB（八团合计），不能进首屏。
 * 只有真正要看元数据时才 `ensure()` 一次，之后全在内存里。
 */
export class MetaStore {
  private impl: Promise<MetaReader> | null = null;
  private reader: MetaReader | null = null;

  /** 学科 id（仅用于错误信息与调试，不参与取数） */
  readonly domain: string;

  constructor(domain: string, private readonly meta: NonNullable<Manifest["domains"][number]["meta"]>) {
    this.domain = domain;
  }

  get loaded(): boolean {
    return this.reader !== null;
  }

  async ensure(): Promise<MetaReader> {
    if (this.reader) return this.reader;
    if (!this.impl) {
      this.impl = (async () => {
        const buf = await getBuffer(this.meta.index);
        const r = new MetaReader(buf, this.meta);
        this.reader = r;
        return r;
      })().catch((e) => {
        this.impl = null; // 失败不缓存，允许重试
        throw e;
      });
    }
    return this.impl;
  }

  /** 取完整元数据（标题 + 作者 + 去处名）。会发 1–2 次 Range 请求。 */
  async full(docId: number): Promise<MetaFull | null> {
    const r = await this.ensure();
    const h = r.head(docId);
    if (!h) return null;
    const tr = r.textRange(docId);
    const vr = r["venueRange"](docId);
    // 标题与作者在同一段文本里（"标题\n作者\n"），一次取回
    const textRaw = await getRange(this.meta.text, tr.off, tr.len + titleAuthorTail(tr.len));
    void vr;
    const nl = textRaw.indexOf("\n");
    const title = nl >= 0 ? textRaw.slice(0, nl) : textRaw;
    const authors = nl >= 0 ? textRaw.slice(nl + 1).trim() : "";
    // 去处名多数已内联在记录里；只有超长的才需要去池里取
    let venue = h.venueHead;
    if (!venue && this.meta.venue) {
      const vrr = r.venueRange(docId);
      if (vrr.len > 0) venue = await getRange(this.meta.venue, vrr.off, vrr.len);
    }
    return { ...h, title: title || h.titleHead, authors, venue };
  }

  /** 取摘要（**只有用户明确展开时才调用** —— 摘要池是 GB 量级）。 */
  async abstract(docId: number): Promise<string> {
    const r = await this.ensure();
    const { off, len } = r.abstractRange(docId);
    if (len <= 0) return "";
    return (await getRange(this.meta.abstract, off, len)).trim();
  }

  /** 批量取标题（供"相关论文"列表用）。并发上限 4，避免打爆连接数。 */
  async titlesOf(docIds: readonly number[]): Promise<Map<number, string>> {
    const r = await this.ensure();
    const out = new Map<number, string>();
    const queue = [...docIds];
    const worker = async () => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) return;
        const h = r.head(id);
        if (!h) continue;
        try {
          const f = await this.full(id);
          out.set(id, f?.title || h.titleHead);
        } catch {
          out.set(id, h.titleHead); // 取失败就退回内联前缀，不整块失败
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }
}

/**
 * 标题之后还要多取几个字节才能拿到作者。
 *
 * 记录里的 `titleLen` 只标了标题长度，而作者紧跟其后（`标题\n作者\n`）。
 * 这里多取 256 字节覆盖绝大多数作者列表；超长作者列表会被截断
 * （作者名字段的展示不要求完整，截断比再发一次请求划算）。
 */
function titleAuthorTail(_titleLen: number): number {
  return 256;
}

/** 元数据缓存的键（按学科）。 */
const metaStores = new Map<string, MetaStore>();

/**
 * 后台预取某个学科的元数据索引，并在**同步可用之后**回调。
 *
 * 为什么需要这个"预取 + 回调"的形态：点的**大小**要在构建点集时同步决定
 * （`buildPoints` 是个纯同步函数，12 万个点一次算完）。
 * 而元数据索引是异步取来的（单团最大 93 MB）。所以流程是：
 *   ① 先用默认大小画出星系（首屏立刻可见，不等网络）；
 *   ② 索引到了之后**重建一次点集**，把"发表去处 → 星球大小"真正体现出来。
 * 这样首屏不会被 93 MB 拖住，而效果最终是对的。
 */
export async function preloadMetaIndex(domain: string): Promise<MetaReader | null> {
  const store = metaStoreOf(domain);
  if (!store) return null;
  try {
    return await store.ensure();
  } catch {
    return null; // 预取失败不影响主流程：点集就保持默认大小
  }
}

/** 取某学科的元数据读取器（懒加载；未在 manifest 登记则返回 null）。 */
export function metaStoreOf(domain: string): MetaStore | null {
  const hit = metaStores.get(domain);
  if (hit) return hit;
  // 延迟到有 manifest 时才建 —— manifest 未加载时返回 null，调用方据此显示"暂不可用"
  const m = manifestCache;
  const entry = m?.domains.find((d) => d.id === domain);
  if (!entry?.meta) return null;
  const store = new MetaStore(domain, entry.meta);
  metaStores.set(domain, store);
  return store;
}

// ---------------------------------------------------------------- 关系（邻接表）
/** 一位邻居（已知它属于哪个学科之后）。 */
export interface Neighbor {
  readonly kind: number;
  /** 邻居所属学科在 `manifest.domains` 里的下标 */
  readonly domainIndex: number;
  readonly docId: number;
}

/**
 * 邻接表：每篇论文的 K 个同领域邻居，**按 docId O(1) 随机访问**。
 *
 * 为什么用定长记录：交互要求"点开一篇论文就立刻看到邻居"，必须是常数时间。
 * 变长边表省空间，但每次查询都要先定位偏移，交互会卡。
 *
 * ⚠️ 邻接表**不能像脊柱那样抽样**：它按 docId 直接索引，
 * 抽样会让 docId 与记录位置错位（实测踩过：自检条 13,543 条错 13,542 条）。
 * 所以这里**只有完整表**，按需加载。
 */
export class NeighborTable {
  private readonly view: DataView;
  readonly domainIndex: number;
  readonly k: number;
  readonly count: number;

  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    if (magic !== NBR_MAGIC) {
      throw new Error(`邻接表魔法数不对：期望 ${NBR_MAGIC}，实际 ${magic}`);
    }
    this.count = this.view.getUint32(8, true);
    this.k = this.view.getUint32(12, true);
    const recBytes = this.view.getUint32(16, true);
    this.domainIndex = this.view.getUint32(20, true);
    if (recBytes !== NBR_REC_BYTES) {
      throw new Error(`邻接表记录长度应为 ${NBR_REC_BYTES}，实际 ${recBytes}`);
    }
    const need = NBR_HEAD_BYTES + this.count * (this.k + 1) * recBytes;
    if (buf.byteLength < need) {
      throw new Error(`邻接表长度不足：需要 ${need}，实际 ${buf.byteLength}`);
    }
  }

  /** 取一篇论文的邻居。空槽（打包值 0）会被跳过。 */
  neighborsOf(docId: number): Neighbor[] {
    if (docId < 0 || docId >= this.count) return [];
    const o = NBR_HEAD_BYTES + docId * (this.k + 1) * NBR_REC_BYTES;
    const out: Neighbor[] = [];
    for (let j = 1; j <= this.k; j++) {
      const packed = this.view.getUint32(o + j * NBR_REC_BYTES, true);
      if (packed === 0) continue;
      const { kind, uid } = unpackNeighbor(packed);
      out.push({ kind, domainIndex: uid >>> DOCID_BITS, docId: uid & DOCID_MASK });
    }
    return out;
  }
}

/**
 * 加载邻接表（按需；最大物理团 19 MB brotli）。
 * 只在用户要看"相关论文"时才调用 —— 首屏绝不带它。
 */
export function loadNeighbors(dom: string): Promise<NeighborTable> {
  return once(`nbr:${dom}`, async () => new NeighborTable(await getBuffer(`relations/${dom}.nbr.bin`)));
}

// ---------------------------------------------------------------- 关系丝线边
/**
 * 丝线边文件的布局（`edges/<domain>.bin`，由 `pipeline/build-edges.mjs` 写出）。
 *
 *   头部：magic "LUNYEDG2"(8) | count u32 | srcCount u32 | recBytes u32 | idxBytes u32 = 24
 *   索引：srcCount × (u32 起点 docId | u32 起始下标)     ← 按 docId 升序，可二分
 *   边：  count × (u32 终点 docId | f32 权重 | f32 bx,by,bz)  = 20 字节
 *
 * ## 为什么是"按起点配额"而不是"全局均匀抽样"
 *
 * 第一版是把全量候选边均匀抽样到每团 2 万条，用来铺一张**默认就显示**的网。
 * 那样画面上确实有网，但每篇论文平均只留下 0.7 条自己的边 ——
 * **点开一颗星，属于它的线几乎一条都没有**。
 * 作者把默认网去掉了（"点击某个论文再显示出纤细清晰的关系线"），
 * 于是这一版反过来：每一篇都留、只留它最强的若干条（实测每篇均 5~7 条，
 * 96% 的演示论文都有边）。索引就是为"按起点查"服务的。
 *
 * ## 为什么不存起点坐标
 *
 * 起点一定是场上真实画出来的那颗星（构建时就按这个筛的），
 * 浏览器用 `docIndex` 从点集里就能读到它的坐标 —— 存一份是白占 12 字节/条。
 *
 * ⚠️ 终点那颗星**当前可能没有被画出来**（它不在演示点集里），
 *    所以这些线是"从在场的星出发、连到它的同路线论文"，
 *    线的另一端不一定有一颗可见的星。界面上不能把它说成"两颗可见星之间的关系"。
 */
export const EDGE_MAGIC = "LUNYEDG2";
export const EDGE_HEAD_BYTES = 24;
export const EDGE_IDX_BYTES = 8;
export const EDGE_REC_BYTES = 20;

export interface FilamentEdges {
  readonly domain: string;
  readonly count: number;
  /** 起点 docId（升序） */
  readonly srcDocId: Uint32Array;
  /** 该起点的边在下面的数组里的起始下标；区间终点是**下一个**起点的偏移（最后一个用 count） */
  readonly srcOffset: Uint32Array;
  readonly dst: Uint32Array;
  readonly weight: Float32Array;
  /** 终点的局部坐标（3/条）—— 与星点同一坐标系，可直接画 */
  readonly b: Float32Array;
}

/**
 * 查某篇论文自己的边在数组里的区间 `[start, end)`；没有则返回 `null`。
 *
 * 二分查找：索引按起点 docId 升序（构建时排过），所以 O(log n)。
 * 不用 `Map` 是为了省内存 —— 物理团有 2.8 万个起点、20 万条边，
 * 建 Map 的开销比一次二分大得多，而这里每次点击只查一次。
 */
export function edgesOfSource(
  e: FilamentEdges,
  docId: number,
): { start: number; end: number } | null {
  let lo = 0;
  let hi = e.srcDocId.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = e.srcDocId[mid];
    if (v === docId) {
      const start = e.srcOffset[mid];
      const end = mid + 1 < e.srcDocId.length ? e.srcOffset[mid + 1] : e.count;
      return { start, end };
    }
    if (v < docId) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/**
 * 加载某学科的关系丝线边。
 *
 * 与其它二进制资产一样**不在这里做「加载失败就当没有」**：格式不对必须报错。
 * 静默降级会让"丝线没画出来"看起来像"这个学科本来就没有边"，那是两个完全不同的结论。
 */
export function loadFilamentEdges(domain: string): Promise<FilamentEdges> {
  return once(`edges:${domain}`, async () => {
    const buf = await getBuffer(`edges/${domain}.bin`);
    if (buf.byteLength < EDGE_HEAD_BYTES) throw new Error(`丝线边文件太短：${buf.byteLength} 字节`);
    const view = new DataView(buf);
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 8));
    if (magic !== EDGE_MAGIC) {
      throw new Error(`丝线边 magic 不对：期望 ${EDGE_MAGIC}，实际 ${JSON.stringify(magic)}`);
    }
    const count = view.getUint32(8, true);
    const srcCount = view.getUint32(12, true);
    const recBytes = view.getUint32(16, true);
    const idxBytes = view.getUint32(20, true);
    if (recBytes !== EDGE_REC_BYTES || idxBytes !== EDGE_IDX_BYTES) {
      throw new Error(
        `丝线边记录长度不一致：文件 ${recBytes}/${idxBytes}，前端按 ${EDGE_REC_BYTES}/${EDGE_IDX_BYTES} 读（重新构建即可）`,
      );
    }
    const need = EDGE_HEAD_BYTES + srcCount * idxBytes + count * recBytes;
    if (buf.byteLength < need) {
      throw new Error(`丝线边长度不足：需要 ${need}，实际 ${buf.byteLength}`);
    }
    const srcDocId = new Uint32Array(srcCount);
    const srcOffset = new Uint32Array(srcCount);
    for (let i = 0; i < srcCount; i++) {
      const o = EDGE_HEAD_BYTES + i * idxBytes;
      srcDocId[i] = view.getUint32(o, true);
      srcOffset[i] = view.getUint32(o + 4, true);
    }
    const dst = new Uint32Array(count);
    const weight = new Float32Array(count);
    const b = new Float32Array(count * 3);
    const base = EDGE_HEAD_BYTES + srcCount * idxBytes;
    for (let i = 0; i < count; i++) {
      const o = base + i * recBytes;
      dst[i] = view.getUint32(o, true);
      weight[i] = view.getFloat32(o + 4, true);
      b[i * 3] = view.getFloat32(o + 8, true);
      b[i * 3 + 1] = view.getFloat32(o + 12, true);
      b[i * 3 + 2] = view.getFloat32(o + 16, true);
    }
    return { domain, count, srcDocId, srcOffset, dst, weight, b };
  });
}

/** 内存缓存：同一路径只请求一次。 */
const cache = new Map<string, Promise<unknown>>();

function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = load().catch((e) => {
    cache.delete(key); // 失败不缓存，允许重试
    throw e;
  });
  cache.set(key, p);
  return p;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(assetUrl(path), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`加载 ${path} 失败：HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function getBuffer(path: string): Promise<ArrayBuffer> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`加载 ${path} 失败：HTTP ${res.status}`);
  return await res.arrayBuffer();
}

// ---------------------------------------------------------------- manifest / vocab
/**
 * 加载总清单。**它是资产版本的来源**，因此自己不带版本参数，
 * 且必须用 `cache: "no-store"` 强取 —— 否则拿到旧 manifest 就等于版本号没变，
 * 后面所有资产又都走了旧副本。
 */
export function loadManifest(): Promise<Manifest> {
  return once("manifest", async () => {
    const res = await fetch(MANIFEST_URL, { cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`加载 manifest 失败：HTTP ${res.status}`);
    const m = (await res.json()) as Manifest;
    manifestCache = m;
    // generatedAt → 版本号（只留数字，取前 14 位）
    dataVersion = String(m.generatedAt ?? "").replace(/\D/g, "").slice(0, 14) || "0";
    return m;
  });
}

export function loadVocab(dom: string): Promise<VocabAsset> {
  return once(`vocab:${dom}`, () => getJson<VocabAsset>(`${dom}/vocab.json`));
}

// ---------------------------------------------------------------- spine
/**
 * 编号脊柱：定长记录，支持 O(1) 随机访问。
 *
 * 读大整数用**逐字节累加**而不是 `DataView.getBigUint64`：
 * 地址有 73 位十进制（≈243 位），64 位 API 装不下，会静默截断。
 */
export class Spine {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;

  /** **真实论文数**（不是本文件的记录数 —— 演示脊柱只含抽样） */
  readonly count: number;
  /** 是否为**演示脊柱**（count 是上界而非真实篇数 —— 见构造函数里的说明） */
  readonly isDemo: boolean;
  readonly slots: number;
  readonly recordBytes: number;
  /**
   * 抽样步长。1 = 完整脊柱（每条记录按 docId 直接索引）；
   * N>1 = 演示脊柱（第 k 条记录对应 docId = k·N）。
   */
  readonly stride: number;
  /** 本文件的头部长度（**由 magic 决定**，不假设） */
  private readonly headBytes: number;

  constructor(buf: ArrayBuffer) {
    this.bytes = new Uint8Array(buf);
    this.view = new DataView(buf);
    const magic = String.fromCharCode(...this.bytes.subarray(0, 8));
    const isDemo = magic === SPINE_DEMO_MAGIC;
    if (magic !== SPINE_MAGIC && !isDemo) {
      throw new Error(`spine 魔法数不对：期望 ${SPINE_MAGIC} 或 ${SPINE_DEMO_MAGIC}，实际 ${magic}`);
    }
    this.headBytes = isDemo ? SPINE_DEMO_HEAD : SPINE_FULL_HEAD;
    /** 本文件实际含多少条记录 */
    const records = this.view.getUint32(8, true);
    /**
     * 这是不是**演示脊柱**（每 stride 篇取一篇）。
     *
     * 暴露出来是因为它直接影响 `count` 的语义：
     * 演示脊柱的 `count` 是 `records × stride`，即**上界**而不是真实篇数。
     * 自检脚本要据此判断该用哪个基准比对，否则会拿上界去比真实篇数，
     * 得到"差 12 篇"的假失败（实测踩过：29,272 × 50 = 1,463,600 vs 真实 1,463,588）。
     */
    this.isDemo = isDemo;
    this.slots = this.view.getUint32(12, true);
    this.recordBytes = this.view.getUint32(16, true);
    this.stride = isDemo ? this.view.getUint32(20, true) : 1;
    // 演示脊柱的"真实篇数"由调用方从 manifest 取；这里用 records×stride 作为上界，
    // 保证 `get(docId)` 的边界检查不会放过越界访问。
    this.count = isDemo ? records * this.stride : records;
    if (this.recordBytes !== 72) {
      throw new Error(`spine 记录长度应为 72，实际 ${this.recordBytes}（布局变更后需同步前端）`);
    }
    if (this.stride < 1) throw new Error(`spine 抽样步长非法：${this.stride}`);
    const need = this.headBytes + records * this.recordBytes;
    if (buf.byteLength < need) {
      throw new Error(
        `spine 长度不足：头部 ${this.headBytes} + ${records}×${this.recordBytes} = ${need} 字节，实际 ${buf.byteLength}`,
      );
    }
  }

  /** 读定宽 32 字节大端无符号整数（与构建端 writeValue 严格对应）。 */
  private readValue(offset: number): bigint {
    let x = 0n;
    for (let i = 0; i < VALUE_BYTES; i++) x = (x << 8n) | BigInt(this.bytes[offset + i]);
    return x;
  }

  /**
   * 取一篇论文的编号记录。
   *
   * 演示脊柱（stride > 1）只能回答"步长整数倍"的 docId —— 其余返回 null。
   * 这**不是缺陷而是有意的**：首屏只需要画点，完整数据在需要时按需加载（见 loadFullSpine）。
   */
  get(docId: number): SpineRecord | null {
    if (docId < 0 || docId >= this.count) return null;
    if (docId % this.stride !== 0) return null;
    const rec = docId / this.stride;
    const off = this.headBytes + rec * this.recordBytes;
    return {
      docId,
      addr: this.readValue(off),
      rank: this.readValue(off + VALUE_BYTES),
      tokens: this.bytes[off + VALUE_BYTES * 2 + 4],
      truncated: this.bytes[off + VALUE_BYTES * 2 + 5] !== 0,
    };
  }

  /** 本文件含多少条记录（演示脊柱的抽样点数）。 */
  recordCount(): number {
    return Math.ceil(this.count / this.stride);
  }

  /**
   * 本文件**能否**解析这篇论文。
   *
   * 演示脊柱只含每 stride 篇中的一篇，因此大部分 docId 是"解析不到"的。
   * 调用方必须先问这一句 —— 否则 `get()` 返回 null 会让上层静默失败
   * （实测踩过：按编号反查命中一个演示版里不存在的 docId，
   *   面板于是**继续显示上一篇论文**，看起来像"标题算错了"，实际是根本没切换）。
   */
  canResolve(docId: number): boolean {
    return docId >= 0 && docId < this.count && docId % this.stride === 0;
  }

  /**
   * 找**本文件里最接近 `docId` 的那条记录**（按 docId 距离）。
   *
   * 为什么需要：演示脊柱只有每 N 篇中的一篇（如每 50 篇），而"相关论文"给出的是
   * **任意 docId**。直接 `get()` 会返回 null，界面上就是"点了没反应"。
   * 而"跳到最接近的那一篇"是**诚实且有用**的：它就在原目标附近，
   * 且返回里带 `distance`，界面可以如实说明"最近的可查看论文在 N 篇之外"。
   *
   * 用整数运算而不是建一张 docId 表：演示脊柱的 docId 是 `k·stride` 的等差数列，
   * 所以最接近的就是 `round(docId/stride)·stride`（夹到合法范围）。
   */
  nearestRecord(docId: number): { docId: number; distance: number } | null {
    if (this.count <= 0) return null;
    if (this.stride === 1) {
      if (docId < 0) return { docId: 0, distance: -docId };
      if (docId >= this.count) return { docId: this.count - 1, distance: docId - (this.count - 1) };
      return { docId, distance: 0 };
    }
    const lastIdx = this.recordCount() - 1;
    let k = Math.round(docId / this.stride);
    if (k < 0) k = 0;
    if (k > lastIdx) k = lastIdx;
    const snapped = k * this.stride;
    return { docId: snapped, distance: Math.abs(docId - snapped) };
  }
}

/**
 * 加载**演示脊柱**（每 N 篇取 1，八团合计约 4 MB）。
 * 首屏只用它 —— 完整脊柱八团合计 121 MB brotli，全下会把浏览器拖死
 * （实测：8 个学科全部卡在"载入中"，首屏空白）。
 */
export function loadSpine(dom: string): Promise<Spine> {
  return once(`spine:${dom}`, async () => new Spine(await getBuffer(`${dom}/spine.demo.bin`)));
}

/**
 * 加载**完整脊柱**（按需，用户明确要某个星团的全部点时）。
 * 与演示脊柱共享同一套布局与 docId，所以切换过去不需要重算任何编号。
 */
export function loadFullSpine(dom: string): Promise<Spine> {
  return once(`spineFull:${dom}`, async () => new Spine(await getBuffer(`${dom}/spine.bin`)));
}

// ---------------------------------------------------------------- 编号表（虚空占用判定）
/** 编号表的一条记录。 */
export interface RankHit {
  /** 命中的 docId */
  readonly docId: number;
  /** 该条目的编号 */
  readonly rank: bigint;
  /**
   * 该论文**词表内的真实词数**。
   * 展示标题时必须按它截断 —— 编码是定长的，尾部补齐的 0 解出来是"词表第 0 个词"，
   * 不截断就会看到 "quantum quantum quantum …"（补了十几个最高频词）。
   */
  readonly tokens: number;
  /** 该论文所属的**层号**（下标进 manifest.strata） */
  readonly stratum: number;
}

/**
 * 编号表：按**编号升序**排列的 `(rank, docId)` 表。
 *
 * 用途：回答"这个编号上真的有一篇论文吗"（界面上的**编号反查标题**、永久链接的落地校验）——
 * 采样编号 → 二分查找 → 命中则那篇论文真实存在，未命中则它是一个
 * **从未有人写过的标题**（但编号本身完全合法）。
 *
 * 布局（与 `pipeline/build-spine.mjs` 严格对应）：
 *   magic "LUNYRANK"(8) | count(u32) | recBytes(u32) | minRank(32B 大端) | maxRank(32B 大端) | count×recBytes
 *   recBytes = 40：docId(u32) + rank(32B 大端) + 保留(u32)
 */
export class RankTable {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  readonly count: number;
  readonly recBytes: number;
  /** 该学科全部论文编号的最小值/最大值 —— 虚空采样的范围应当落在这之间 */
  readonly minRank: bigint;
  readonly maxRank: bigint;

  constructor(buf: ArrayBuffer) {
    this.bytes = new Uint8Array(buf);
    this.view = new DataView(buf);
    const magic = String.fromCharCode(...this.bytes.subarray(0, 8));
    if (magic !== "LUNYRANK") throw new Error(`编号表魔法数不对：${magic}`);
    this.count = this.view.getUint32(8, true);
    this.recBytes = this.view.getUint32(12, true);
    this.minRank = readBig(this.bytes, 16);
    this.maxRank = readBig(this.bytes, 16 + VALUE_BYTES);
    const need = this.rankBase + this.count * this.recBytes;
    if (buf.byteLength < need) {
      throw new Error(`编号表长度不足：需要 ${need}，实际 ${buf.byteLength}`);
    }
  }

  private rankAt(i: number): bigint {
    return readBig(this.bytes, this.rankBase + i * this.recBytes + 4);
  }
  private docIdAt(i: number): number {
    return this.view.getUint32(this.rankBase + i * this.recBytes, true);
  }
  /** 该条目的词数（记录布局：docId(u32) + rank(32B) + tokens(u8) + flags(u8) + 层号(u16)） */
  private tokensAt(i: number): number {
    return this.bytes[this.rankBase + i * this.recBytes + 4 + VALUE_BYTES];
  }
  /** 该条目的层号（层级归属；下标进 manifest.strata） */
  private stratumAt(i: number): number {
    return this.view.getUint16(this.rankBase + i * this.recBytes + 4 + VALUE_BYTES + 2, true);
  }
  /** 记录区起点（头部：magic 8 + count 4 + recBytes 4 + minRank 32 + maxRank 32 = 80） */
  private get rankBase(): number {
    return 16 + VALUE_BYTES * 2;
  }

  /** 二分查找某个编号。命中返回 `{docId, rank}`，未命中返回 null。 */
  find(rank: bigint): RankHit | null {
    if (rank < this.minRank || rank > this.maxRank) return null;
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.rankAt(mid);
      if (v === rank) {
        return { docId: this.docIdAt(mid), rank, tokens: this.tokensAt(mid), stratum: this.stratumAt(mid) };
      }
      if (v < rank) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** 第 i 条（供"随机跳到某篇真实论文"使用）。 */
  at(i: number): RankHit | null {
    if (i < 0 || i >= this.count) return null;
    return { docId: this.docIdAt(i), rank: this.rankAt(i), tokens: this.tokensAt(i), stratum: this.stratumAt(i) };
  }

  /**
   * 抽出**全部论文的层号**（按 docId 索引，每篇 2 字节）。
   *
   * 供"超新星遗迹"用：要回答"某个研究方向在某一年爆发时**具体是哪些论文**"，
   * 就需要每一篇的层号。
   *
   * ⚠️ 必须**按 docId 反填**，不能直接用下标 ——
   * 编号表是按 **rank** 排序的，而层号表要按 **docId** 索引，两者顺序不同。
   * 直接用下标会拿到"另一篇论文的层号"，而且是**静默错误**
   * （图能画出来、数字看着也合理，只是全错了）。同一个坑在
   * `pipeline/build-relations.mjs` 里已经踩过一次（自检条 13,543 条错 13,542 条）。
   */
  stratumTable(): Uint16Array {
    const out = new Uint16Array(this.count);
    for (let i = 0; i < this.count; i++) out[this.docIdAt(i)] = this.stratumAt(i);
    return out;
  }

  /**
   * 找**离给定编号最近的真实论文**（按编号距离）。
   *
   * 为什么需要它（这是"按编号反查"能真正可用的关键）：
   *   真实论文的编号在 73 位目录里极其稀疏 —— 物理团实测相邻两篇的间距约 10^56。
   *   如果只回答"这个编号上恰好有论文吗"，命中率约 10^-10，功能等于没用。
   *   而回答"离它最近的真实论文是哪一篇、有多远"，则**永远有答案**，
   *   并且把"虚空"的含义讲清楚了：它是一片真实的、有度量意义的空间。
   *
   * 返回 `{hit, distance}`；distance = |rank − hit.rank|。空表返回 null。
   */
  nearest(rank: bigint): { hit: RankHit; distance: bigint } | null {
    if (this.count === 0) return null;
    // 在有序数组中定位插入点（第一个 ≥ rank 的位置）
    let lo = 0;
    let hi = this.count; // 注意是 count，不是 count-1（插入点可能落在末尾之后）
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rankAt(mid) < rank) lo = mid + 1;
      else hi = mid;
    }
    // 候选：lo（第一个 ≥ rank）与 lo-1（最后一个 < rank）
    const cands: number[] = [];
    if (lo < this.count) cands.push(lo);
    if (lo > 0) cands.push(lo - 1);
    let best = -1;
    let bestD = -1n;
    for (const i of cands) {
      const r = this.rankAt(i);
      const d = r > rank ? r - rank : rank - r;
      if (best < 0 || d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best < 0) return null;
    return {
      hit: { docId: this.docIdAt(best), rank: this.rankAt(best), tokens: this.tokensAt(best), stratum: this.stratumAt(best) },
      distance: bestD,
    };
  }
}

export function loadRankTable(dom: string): Promise<RankTable> {
  return once(`rank:${dom}`, async () => new RankTable(await getBuffer(`${dom}/rank.bin`)));
}

/** 清空缓存（调试用：改完数据不想重启页面时）。 */
export function clearAssetCache(): void {
  cache.clear();
}
