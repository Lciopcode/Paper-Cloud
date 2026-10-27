/**
 * 论文云 · **引用表**读取（HTTP Range 随机访问）
 * ============================================================================
 * 读 `public/data/citations/<domain>.bin`（由 `pipeline/build-citations.mjs` 写出）：
 *
 *     magic "LUNYREF1"(8) | u32 count | u32 edgeCount | u32 coveragePct | u32 maxRefs
 *     | u32 reserved | u32 offsets[count+1] | u32 dst[edgeCount]
 *
 * ## 为什么是 CSR + Range，而不是"整份下载"
 *
 * 物理团一家就有两千万条边（80 MB 级）。但界面一次只点**一颗星**，
 * 要的只是它那几十条边。CSR 布局下这件事是 O(1) 的：
 *
 *     读 offsets[docId] 与 offsets[docId+1]（8 字节）
 *     读 dst[o0..o1)（N×4 字节）
 *
 * 两次 Range 请求、不到 1 KB。和摘要池（2.9 GB 照样按需取）同一套办法。
 *
 * ## 一定要检查 206
 *
 * 服务器若不支持 Range 会返回 **200 + 整个文件**（80 MB）。那时把响应体当
 * "那 8 个字节"用，读到的会是文件开头 —— 于是所有论文的引用列表都变成
 * 同一篇的。这种错**不会抛异常**，只会让界面显示错内容，所以必须显式挡。
 * （`assets.ts` 的 `getRange` 里为同一个原因写过一次。）
 */

import { apiKeyHeaders, useApiKeys } from "../state/apiKeys.ts";

/** 头部字节数：magic 8 + 5 个 u32 */
const HEADER_BYTES = 28;
const MAGIC = "LUNYREF1";
const EXT_MAGIC = "LUNYEXT1";
const EXT_HEADER_BYTES = 16;

/** 一条库外引用（只有标题/年份/DOI —— 它不在我们库里，没有坐标可画） */
export interface ExtRef {
  readonly title: string;
  readonly year: number;
  readonly doi: string;
}

/**
 * 带 Range 的字节读取。
 *
 * @param expectLen 期望长度；服务器返回别的长度一律报错（不做"尽力而为"）
 */
async function rangeBytes(url: string, off: number, len: number): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` }, cache: "force-cache" });
  if (res.status !== 206) {
    throw new Error(
      `引用表未按 Range 返回（状态 ${res.status}，期望 206）：${url}。` +
        `本地服务器需支持 Range，且该文件不能是 .br 压缩版。`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** 解码一段 utf8（用浏览器自带的解码器，不自己写） */
const UTF8 = new TextDecoder();

export class CitationTable {
  /** 该学科论文总数（docId 上界） */
  readonly count: number;
  /** 全库边数 */
  readonly edgeCount: number;
  /** 有引用数据的论文占比（0..100）—— 界面要如实报，不许假装全覆盖 */
  readonly coveragePct: number;
  private readonly url: string;
  private readonly extUrl: string | null;
  /** 已取到的 dst 分块缓存（同一颗星反复点不该反复发请求） */
  private readonly dstCache = new Map<number, Uint32Array>();
  private readonly extCache = new Map<number, ExtRef[]>();

  private constructor(url: string, extUrl: string | null, head: DataView) {
    this.url = url;
    this.extUrl = extUrl;
    this.count = head.getUint32(8, true);
    this.edgeCount = head.getUint32(12, true);
    this.coveragePct = head.getUint32(16, true);
  }

  /** 打开一个学科的引用表；文件不存在时返回 `null`（**不是**抛错 —— 缺数据是正常状态） */
  static async open(domain: string, base = "/data"): Promise<CitationTable | null> {
    const url = `${base}/citations/${domain}.bin`;
    const head = await tryHead(url, HEADER_BYTES, MAGIC);
    if (!head) return null;
    const extUrl = `${base}/citations/${domain}.ext.bin`;
    const extHead = await tryHead(extUrl, EXT_HEADER_BYTES, EXT_MAGIC);
    return new CitationTable(url, extHead ? extUrl : null, head);
  }

  /** 某一篇引用了哪些**本库**论文（docId 数组，按 docId 升序） */
  async refsOf(docId: number): Promise<Uint32Array> {
    if (docId < 0 || docId >= this.count) return EMPTY;
    const hit = this.dstCache.get(docId);
    if (hit) return hit;
    // ① 两个 offset（8 字节）
    const offAt = HEADER_BYTES + docId * 4;
    const ob = await rangeBytes(this.url, offAt, 8);
    const o0 = new DataView(ob.buffer, ob.byteOffset, ob.byteLength).getUint32(0, true);
    const o1 = new DataView(ob.buffer, ob.byteOffset, ob.byteLength).getUint32(4, true);
    if (o1 <= o0) return EMPTY;
    // ② 目标 docId 列表
    const offsetsBytes = (this.count + 1) * 4;
    const db = await rangeBytes(this.url, HEADER_BYTES + offsetsBytes + o0 * 4, (o1 - o0) * 4);
    const dv = new DataView(db.buffer, db.byteOffset, db.byteLength);
    const out = new Uint32Array(o1 - o0);
    for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
    this.dstCache.set(docId, out);
    return out;
  }

  /** 某一篇的**库外**被引（标题/年份/DOI）；没有就是空数组 */
  async extOf(docId: number): Promise<readonly ExtRef[]> {
    if (!this.extUrl || docId < 0) return EMPTY_EXT;
    const hit = this.extCache.get(docId);
    if (hit) return hit;
    const count = (await headCount(this.extUrl)) ?? 0;
    if (docId >= count) return EMPTY_EXT;
    const ob = await rangeBytes(this.extUrl, EXT_HEADER_BYTES + docId * 4, 8);
    const odv = new DataView(ob.buffer, ob.byteOffset, ob.byteLength);
    const b0 = odv.getUint32(0, true);
    const b1 = odv.getUint32(4, true);
    if (b1 <= b0) return EMPTY_EXT;
    const offsetsBytes = (count + 1) * 4;
    const blob = await rangeBytes(this.extUrl, EXT_HEADER_BYTES + offsetsBytes + b0, b1 - b0);
    const text = UTF8.decode(blob);
    const out: ExtRef[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      const [y, title, doi] = line.split("\t");
      if (!title) continue;
      out.push({ year: Number(y) || 0, title, doi: doi ?? "" });
    }
    this.extCache.set(docId, out);
    return out;
  }
}

const EMPTY = new Uint32Array(0);
const EMPTY_EXT: readonly ExtRef[] = [];

/** 取头部；404 / 不是我们的 magic 都当作"没有这份数据" */
async function tryHead(url: string, len: number, magic: string): Promise<DataView | null> {
  try {
    const b = await rangeBytes(url, 0, len);
    let m = "";
    for (let i = 0; i < 8; i++) m += String.fromCharCode(b[i]);
    if (m !== magic) return null;
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  } catch {
    return null;
  }
}

const countCache = new Map<string, Promise<number | null>>();
function headCount(url: string): Promise<number | null> {
  const hit = countCache.get(url);
  if (hit) return hit;
  const p = tryHead(url, EXT_HEADER_BYTES, EXT_MAGIC).then((dv) => (dv ? dv.getUint32(8, true) : null));
  countCache.set(url, p);
  return p;
}

const cache = new Map<string, Promise<CitationTable | null>>();
export function loadCitations(domain: string, base = "/data"): Promise<CitationTable | null> {
  const hit = cache.get(domain);
  if (hit) return hit;
  const p = CitationTable.open(domain, base).catch(() => null);
  cache.set(domain, p);
  return p;
}

/** 测试用：清掉缓存（单测里换 mock 服务器时要它） */
export function clearCitationCache(): void {
  cache.clear();
  countCache.clear();
}

/**
 * **按需取引用**（作者：「不能点击一次拿一次吗？」）。
 *
 * 静态表（`citations/<d>.bin`）只有预抓过的那批论文；其余论文点开时走这里：
 * 本地服务器代问 Semantic Scholar / OpenAlex（浏览器直连没有 CORS），结果落盘缓存，
 * 同一篇再点就是读本地。
 *
 * ## 用户自带 key（BYOK）
 *
 * 请求会带上 `apiKeyHeaders()`（`src/state/apiKeys.ts`）里的自定义头，
 * 由本地服务优先使用**用户自己的** S2 / OpenAlex key —— 这样用户那份配额
 * （以及它对应的数据库权限）就直接作用于这里。key 只在浏览器 localStorage
 * 与本机 127.0.0.1 之间流动，不进页面 URL 之外的地方。
 *
 * key 一改就清掉本模块的 live 缓存：否则"换 key → 重试"会读到上一次（可能是
 * 429/匿名）的结果，看起来像"换了 key 没用"。服务端的落盘缓存仍按 doc 复用。
 *
 * 返回 `null` = 没问到（限流/断网）—— 界面据显示"暂时取不到"，而不是"没有引用"。
 */
export interface LiveRefs {
  readonly in: number[];
  readonly ext: ExtRef[];
  /** 外部接口的报错（有值说明"没问到"，不是"没有引用"） */
  readonly error?: string;
  /** 哪条通道给出的结果：`s2` / `openalex`（服务端判定） */
  readonly source?: string;
  /** 这条通道用的是谁的凭据：`user`（用户自带 key）/ `builtin`（内置 key）/ `anonymous` */
  readonly auth?: "user" | "builtin" | "anonymous" | string;
}

const liveCache = new Map<string, LiveRefs>();
/** 清掉浏览器侧的实时引用缓存（换 key / 换数据源开关时调用） */
export function clearLiveCache(): void {
  liveCache.clear();
}

/** key 变更 → 让此前的 live 结果失效（否则会误判"换了 key 没用"） */
useApiKeys.subscribe(() => clearLiveCache());

export async function fetchRefsLive(
  domain: string,
  docId: number,
  mode: "refs" | "cites" | "all" = "all",
): Promise<LiveRefs | null> {
  const key = `${domain}:${docId}`;
  const hit = liveCache.get(key);
  if (hit) return hit;
  try {
    const res = await fetch(`/api/refs?domain=${encodeURIComponent(domain)}&doc=${docId}&mode=${mode}`, {
      headers: apiKeyHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      in?: number[];
      ext?: [string, number, string][];
      error?: string;
      source?: string;
      auth?: { s2?: string; openalex?: string };
    };
    /**
     * `auth` 是服务端按"这次实际用了谁"回的（`user` / `builtin` / `anonymous`）。
     * 优先取与 `source` 对应的那一个；对不上（旧缓存）就不显示。
     */
    const authValue =
      typeof j.auth === "object" && j.auth
        ? j.source === "openalex"
          ? j.auth.openalex
          : j.source === "s2"
            ? j.auth.s2
            : undefined
        : undefined;
    const out: LiveRefs = {
      in: Array.isArray(j.in) ? j.in : [],
      ext: Array.isArray(j.ext) ? j.ext.map(([title, year, doi]) => ({ title, year, doi })) : [],
      error: j.error,
      source: j.source,
      auth: authValue,
    };
    liveCache.set(key, out);
    return out;
  } catch {
    return null;
  }
}