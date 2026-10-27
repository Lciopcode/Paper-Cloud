/**
 * 论文云 · 论文外链（**纯函数，没有网络**）
 * ============================================================================
 * 界面上每个标题都要能点出去。这件事看着简单，但"往哪儿跳"分好几种情况，
 * 而**写错一种就等于告诉用户一个不存在的地址**：
 *
 *   · 本库的论文 —— 一定有 arXiv 号，跳 `arxiv.org/abs/<号>`（这是最权威的免费全文）；
 *   · 库外的被引论文 —— 只有标题，可能还有 DOI：
 *       - 有 DOI → `doi.org/<DOI>`（出版商的正式页）；
 *       - 没有 DOI → 只能**检索**，跳谷歌学术 / 知网的关键词搜索。
 *
 * ## 为什么不把"跳哪儿"分散到各个组件里
 *
 * 同一个规则要在三个地方用（本作信息、被引列表、库外简介页），
 * 各写一遍就是第二份规则：哪天发现知网的检索地址变了，只改一处才对。
 *
 * ## 知网那条为什么总是跟着给
 *
 * 用户明确要求"遇到没有开源的论文，只显示某个单独星星简介页附带知网或者谷歌学术链接"。
 * 知网的检索 URL 是公开的（`kns.cnki.net/kns8s/defaultresult/index?kw=<词>`），
 * 但**只有检索入口是公开的，正文要订阅** —— 所以这里给的是"去知网搜一下"，
 * 不是"知网能看全文"，措辞上不能混淆（见下面 `note` 字段）。
 */

/** 一条外链 */
export interface PaperLink {
  readonly label: string;
  readonly url: string;
  /** 给用户看的一句话说明（"直接看全文" / "去检索"），避免把"检索"说成"有全文" */
  readonly note: string;
  readonly kind: "arxiv" | "doi" | "scholar" | "cnki";
}

/**
 * arXiv 号 → 摘要页 URL。
 *
 * ⚠️ 老号形态（`hep-th/9901001`）里带斜杠，**不能**再编码成 `%2F` 之外的任何东西；
 *    新版号（`1706.03762`）直接拼。两种都原样放进去就是对的 —— 别"顺手"做 URL 编码，
 *    那会把 `hep-th/9901001` 变成 `hep-th%2F9901001`，arXiv 认不出来。
 */
export function arxivAbsUrl(arxivId: string): string {
  return `https://arxiv.org/abs/${arxivId.trim()}`;
}

/** doi.org 解析地址（DOI 前缀 `https://doi.org/` 要去掉，否则会拼成两遍） */
export function doiUrl(doi: string): string {
  const d = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return `https://doi.org/${d}`;
}

/** 谷歌学术关键词检索（标题太长时只取前半段，太长的查询反而搜不到） */
export function scholarSearchUrl(title: string): string {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(shortQuery(title))}`;
}

/** 知网检索 */
export function cnkiSearchUrl(title: string): string {
  return `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(shortQuery(title))}`;
}

/**
 * 检索词收敛。
 *
 * 学术标题常常带副标题（冒号之后那段）与各种括号补充，整条丢进检索引擎会
 * 因为太多词而命中过窄。取主标题（第一个冒号之前）、截到 90 字符。
 */
function shortQuery(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  const main = t.split(/[:：]/)[0].trim() || t;
  return (main.length > 90 ? main.slice(0, 90) : main).trim();
}

/**
 * 给一篇论文算出所有可用外链，**第一个是主链接**。
 *
 * 入参刻意用最小集合（arXiv 号 / DOI / 标题），这样本库论文与库外论文
 * 走同一个函数 —— 两者只是"有哪些字段"不同。
 */
export function linksFor(p: { arxivId?: string | null; doi?: string | null; title?: string | null }): PaperLink[] {
  const out: PaperLink[] = [];
  if (p.arxivId) {
    out.push({ label: "arXiv 全文", url: arxivAbsUrl(p.arxivId), note: "免费全文，直接看", kind: "arxiv" });
  }
  if (p.doi) {
    out.push({ label: "出版商页面（DOI）", url: doiUrl(p.doi), note: "正式发表版，可能需订阅", kind: "doi" });
  }
  if (p.title) {
    out.push({ label: "谷歌学术", url: scholarSearchUrl(p.title), note: "按标题检索（不是全文直链）", kind: "scholar" });
    out.push({ label: "知网", url: cnkiSearchUrl(p.title), note: "按标题检索（中文库，需订阅才看正文）", kind: "cnki" });
  }
  return out;
}

/** 主链接（没有就返回 null —— 界面据此显示"无外链"，不要编一个假地址） */
export function primaryLink(p: { arxivId?: string | null; doi?: string | null; title?: string | null }): PaperLink | null {
  return linksFor(p)[0] ?? null;
}
