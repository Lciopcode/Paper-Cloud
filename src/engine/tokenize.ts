/**
 * 论文云 · 标题分词器
 * ============================================================================
 * **为什么分词要放在引擎层**：编号的唯一性完全依赖分词的一致性。
 * 如果离线管线用一个分词器、浏览器用另一个，同一篇论文在两边的编号就会不同 ——
 * 这种 bug 表现为"点开论文编号对不上"，极难定位。
 * 因此分词器与 `spine.ts` 同层、同源、被双方 import。
 *
 * 设计取向：**保守**。宁可把两个相近的词当成不同的词（编号略有冗余），
 * 也不要把不同的词合并（那会造成编号冲突，破坏双射语义上的"可解释性"）。
 */

/** 规范化：NFKC + 小写。让 "Deep-Learning"、"deep learning"、"DEEP LEARNING" 同形。 */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * 单字符白名单：这些单字符本身就是有意义的学术词。
 * 不用白名单的话，"c"、"r"、"x" 这类单字符会污染词表；
 * 但一刀切去掉又会丢掉 "R"（语言）、"C"（语言）这类真实词。
 */
const SINGLE_OK = new Set(["r", "c", "x", "y", "z", "n", "k", "p", "q"]);

/**
 * 无信息量的词（对区分论文没有帮助，却会占满高频位）。
 *
 * 收录标准：**去掉它不会损失任何区分度**。
 * 因此刻意**不**收录这些看着像虚词、其实有语义的词：
 *   new（"new" 常是真正的方法标签）、case（case study / case report）、
 *   model / method / result / data / system / learning / network ……
 * 把这类词丢掉会让不同论文的编号撞在一起，得不偿失。
 */
const STOP = new Set([
  // 冠词、介词、连词
  "a", "an", "the", "of", "for", "and", "or", "nor", "but", "if", "so", "as", "to",
  "in", "on", "at", "by", "with", "from", "into", "onto", "upon", "over", "under",
  "above", "below", "between", "within", "without", "during", "after", "before",
  "than", "then", "via", "per", "out", "off", "up", "about", "toward", "towards",
  // be / have / do 及其变形
  "is", "are", "was", "were", "be", "been", "being", "am", "has", "have", "had", "do", "does", "did",
  // 代词与指示词
  "it", "its", "this", "that", "these", "those", "there", "here",
  "we", "our", "ours", "us", "you", "your", "yours", "they", "them", "their", "theirs",
  "he", "him", "his", "she", "her", "hers", "me", "my", "mine",
  "who", "whom", "whose", "which", "what", "when", "where", "why", "how",
  // 程度、范围、情态
  "not", "no", "all", "any", "both", "each", "some", "most", "more", "less", "least",
  "very", "much", "many", "only", "just", "even", "still", "yet", "also",
  "can", "may", "might", "must", "shall", "should", "would", "could", "will",
  "same", "different", "other", "others", "another", "such",
  // 学术写作套话（不区分论文主题）
  "using", "used", "use", "uses", "based", "study", "studies", "analysis",
  "approach", "approaches", "method", "methods", "result", "results",
  "novel", "review", "survey", "introduction", "overview", "toward",
]);

/** 结尾可安全去掉的复数形式（**保守**：只处理最无歧义的一批）。 */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y"; // theories → theory
  if (token.length > 4 && token.endsWith("ses")) return token.slice(0, -2); // classes → class
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * 标题 → 词序列。
 *
 * 规则：
 *   1. NFKC 规范化 + 转小写
 *   2. 非字母数字（含连字符、下划线、标点）一律视为分隔符
 *   3. 丢掉停用词、单字符（除白名单）
 *   4. 去掉最无歧义的复数结尾
 *   5. 稳定去重：同一个词在标题里出现两次只算一次（标题里的重复词不携带额外信息，
 *      却会白白吃掉一个词槽）
 *
 * 输出顺序 = 标题中的出现顺序，**这一点很重要**：
 * 编号的首位是最重要的词（通常是主题词），所以顺序必须保留。
 */
export function tokenizeTitle(title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of normalize(title).split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (raw.length === 1 && !SINGLE_OK.has(raw)) continue;
    if (raw.length === 1 && /[0-9]/.test(raw)) continue; // 单个数字（如 "3"）也丢
    if (STOP.has(raw)) continue;
    const t = stem(raw);
    if (!t || STOP.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 标题 → 用于检索的规范化串（保留原词序与空格，便于子串匹配）。 */
export function searchableTitle(title: string): string {
  return normalize(title)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
