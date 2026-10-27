/**
 * 论文云 · 标题中文译名（HTTP Range 随机访问）
 * ============================================================================
 * 读 `public/data/title-zh/<domain>.bin`（`pipeline/translate-titles.py` 产出）：
 *
 *     magic "LUNYTIT1"(8) | u32 count | u32 blobBytes | u32 offsets[count+1] | utf8 blob
 *
 * 与引用表同一套做法：**不整份下载**。取一篇译名 = 读 8 字节偏移 + 读那段 utf8，
 * 两次 Range 请求（通常几十字节）。
 *
 * ## 为什么译名可能为空，而且这是正常状态
 *
 * 翻译只覆盖**引用表涉及的那些论文**（见翻译脚本的文件头）。所以绝大多数论文
 * 打开时 `zhOf` 返回 `null` —— 界面必须能显示"暂无译名"，而不是显示空白行或
 * 让标题错位。返回 `null` 与返回 `""` 在界面上是一回事，但在这里分得清：
 * `null` = 没翻，`""` = 翻了但模型吐了空串（数据问题）。
 */

const HEADER = 16;
const MAGIC = "LUNYTIT1";

async function rangeBytes(url: string, off: number, len: number): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` }, cache: "force-cache" });
  if (res.status !== 206) throw new Error(`译名表未按 Range 返回（状态 ${res.status}）：${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

const UTF8 = new TextDecoder();

export class TitleZhTable {
  readonly count: number;
  private readonly url: string;
  private readonly cache = new Map<number, string | null>();

  private constructor(url: string, count: number) {
    this.url = url;
    this.count = count;
  }

  static async open(domain: string, base = "/data"): Promise<TitleZhTable | null> {
    const url = `${base}/title-zh/${domain}.bin`;
    try {
      const h = await rangeBytes(url, 0, HEADER);
      let magic = "";
      for (let i = 0; i < 8; i++) magic += String.fromCharCode(h[i]);
      if (magic !== MAGIC) return null;
      const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      return new TitleZhTable(url, dv.getUint32(8, true));
    } catch {
      return null;
    }
  }

  /** 一篇的中文译名；没有译文返回 `null` */
  async zhOf(docId: number): Promise<string | null> {
    if (docId < 0 || docId >= this.count) return null;
    const hit = this.cache.get(docId);
    if (hit !== undefined) return hit;
    try {
      const ob = await rangeBytes(this.url, HEADER + docId * 4, 8);
      const odv = new DataView(ob.buffer, ob.byteOffset, ob.byteLength);
      const b0 = odv.getUint32(0, true);
      const b1 = odv.getUint32(4, true);
      if (b1 <= b0) {
        this.cache.set(docId, null);
        return null;
      }
      const offsetsBytes = (this.count + 1) * 4;
      const s = UTF8.decode(await rangeBytes(this.url, HEADER + offsetsBytes + b0, b1 - b0)).trim();
      const out = s || "";
      this.cache.set(docId, out);
      return out;
    } catch {
      this.cache.set(docId, null);
      return null;
    }
  }

  /**
   * 批量取（并发受限）。
   *
   * ⚠️ 为什么是"逐条两次 Range"而不是一次拿一大段：offsets 数组本身有 5.6 MB，
   *    为了取 40 个译名去下载整张偏移表是本末倒置。40 条 × 2 次小请求在本地
   *    服务器上是毫秒级的事；将来若真成瓶颈，再按 `docId` 分块（页）缓存。
   */
  async zhOfMany(docIds: readonly number[], concurrency = 8): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (let i = 0; i < docIds.length; i += concurrency) {
      const slice = docIds.slice(i, i + concurrency);
      const vals = await Promise.all(slice.map((d) => this.zhOf(d)));
      for (let k = 0; k < slice.length; k++) {
        const v = vals[k];
        if (v) out.set(slice[k], v);
      }
    }
    return out;
  }
}

const cache = new Map<string, Promise<TitleZhTable | null>>();
export function loadTitleZh(domain: string, base = "/data"): Promise<TitleZhTable | null> {
  const hit = cache.get(domain);
  if (hit) return hit;
  const p = TitleZhTable.open(domain, base).catch(() => null);
  cache.set(domain, p);
  return p;
}
