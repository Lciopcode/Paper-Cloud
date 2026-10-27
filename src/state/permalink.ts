/**
 * 论文云 · 永久链接
 * ============================================================================
 * 把"用户在哪儿"编码进 URL 的 hash。三条要求：
 *
 *   1. **可分享**：复制地址栏给别人，打开就是同一颗星（或同一个检索）；
 *   2. **可复现**：同一串 hash 永远还原出同一个状态 —— 这是本作品
 *      "位置由编号唯一决定"这条不变量的直接兑现；
 *   3. **不打扰**：用 `replaceState` 而不是 `pushState`，
 *      否则每点一颗星就往浏览器历史里塞一条，返回键会变得没法用。
 *
 * ## 格式（全部放在 hash 里，服务端不参与）
 *
 *   `#p=<学科>.<docId>`   选中一篇**真实论文**
 *   `#c=<学科>`           聚焦某个星团
 *   `#m=time`             切到时间排列模式
 *   `#q=<关键词>`         执行一次检索
 *
 * 多个可以叠加：`#p=physics.731800&m=time&q=quantum`。
 */

export interface PermalinkState {
  /** 选中的真实论文 */
  paper?: { domain: string; docId: number };
  /** 聚焦的星团 */
  focus?: string;
  /** 排列模式 */
  mode?: "domain" | "time" | "impact";
  /** 检索词 */
  query?: string;
}

/** 把状态编码成 hash 字符串（不含开头的 `#`）。 */
export function encodePermalink(s: PermalinkState): string {
  const parts: string[] = [];
  if (s.paper) parts.push(`p=${encodeURIComponent(s.paper.domain)}.${s.paper.docId}`);
  if (s.focus) parts.push(`c=${encodeURIComponent(s.focus)}`);
  if (s.mode && s.mode !== "domain") parts.push(`m=${s.mode}`);
  if (s.query) parts.push(`q=${encodeURIComponent(s.query)}`);
  return parts.join("&");
}

/** 解析 hash（接受带或不带开头 `#`）。无法识别的部分**忽略而不是报错** —— 链接不该因为多一个参数就整个失效。 */
export function decodePermalink(hash: string): PermalinkState {
  const out: PermalinkState = {};
  const h = hash.replace(/^#/, "");
  if (!h) return out;

  for (const part of h.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const val = decodeURIComponent(part.slice(eq + 1));
    if (key === "p") {
      // ⚠️ 按**第一个**点切，且要求 docId 是纯数字。
      //    曾经按**最后一个**点切，于是 `p=cs.1.5` 被解析成 domain="cs.1"（一个不存在的学科），
      //    docId=5 —— 坏链接不报错、静默指向别处，比直接失败更难查。
      const dot = val.indexOf(".");
      if (dot > 0) {
        const rest = val.slice(dot + 1);
        const docId = Number(rest);
        // docId 是 u32，用 Number 是安全的；但必须是**纯十进制整数**且在范围内
        if (/^\d+$/.test(rest) && Number.isInteger(docId) && docId <= 0xffffffff) {
          out.paper = { domain: val.slice(0, dot), docId };
        }
      }
    } else if (key === "c") {
      if (val) out.focus = val;
    } else if (key === "m") {
      if (val === "time" || val === "impact" || val === "domain") out.mode = val;
    } else if (key === "q") {
      if (val) out.query = val;
    }
  }
  return out;
}

/**
 * 把当前状态写进地址栏。
 *
 * 用 `replaceState`：点星是很频繁的操作，若用 `pushState`，
 * 用户按一次返回键只会退到"上一颗星"，永远退不出这个站点。
 */
export function syncPermalink(s: PermalinkState): void {
  if (typeof window === "undefined") return;
  const hash = encodePermalink(s);
  const url = hash ? `#${hash}` : `${window.location.pathname}${window.location.search}`;
  // 只有真的变了才写，避免无意义的 replaceState 调用
  if (window.location.hash.replace(/^#/, "") === hash) return;
  window.history.replaceState(null, "", url);
}
