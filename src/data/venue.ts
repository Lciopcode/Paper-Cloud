/**
 * 论文云 · 发表去处评级
 * ============================================================================
 * 用途：给"星球大小"提供一个**可审计**的依据（用户要求"发表评级对应星球大小"）。
 *
 * ## 为什么是"可审计的启发式"而不是权威排名
 *
 * 语料里只有 arXiv 的 `journal_ref`（物理团 44% 有）与 `comments`（92% 有），
 * **没有任何官方评级字段**。所以这里的等级只是**从文本里识别出的去处类型**，
 * 不是对期刊质量的权威判断。把"我们认出了这是 PRL"说成"这篇论文很优秀"是两回事。
 *
 * 设计原则：
 *   1. **规则全部写在这一个文件里**，任何人都能读、能改、能反驳；
 *   2. 认不出来就老实返回 T0，不猜中间值；
 *   3. 界面上标注"按发表去处粗略分级"，不假装是引用影响力。
 *
 * 真正的引用影响力要等引用数据 —— 语料里 `cites` 字段**全库为 0，从未填充过**
 * （实测确认：物理/CS/数学各抽 6 万篇，非零比例 0%）。
 *
 * ## ⚠️ 踩过的坑：必须**先去点号再匹配**
 *
 * arXiv 的 `journal_ref` 用的是**压缩缩写**，实测物理团最常见的写法是：
 *     phys.rev.d（4497 次）· phys.lett.b（2037）· phys.rev.b（1919）
 *     phys.rev.lett.（1474）· astrophys.j.（1465）· mon.not.roy.astron.soc.（948）
 * 如果我按 "Phys. Rev. Lett." 去匹配，**一条都认不出来** —— 早期版本就踩了这个坑，
 * 结果 PRL 全被降到 T0/T1。
 *
 * 修法：把文本与模式**都去掉所有点号与空格**再比：
 *     "Phys. Rev. Lett." → "physrevlett"
 *     "phys.rev.lett."   → "physrevlett"   ← 现在能对上了
 * 这样一份模式能同时覆盖压缩缩写、带空格写法、无点号写法。
 *
 * ## 等级定义
 *
 *   T3  综合顶刊（Nature / Science / Cell / PNAS 系列）
 *   T2  学科顶刊与顶会（PRL / ApJ / JACS / CVPR / NeurIPS / STOC …）
 *   T1  有明确期刊或会议的正式发表（其余被识别出的）
 *   T0  未识别（预印本、只有 arXiv 编号、或**只是投稿未接收**）
 *
 * 注意 T0 的第三类：`submitted to Appl. Phys. Lett.` 虽然提到了期刊，
 * 但那是**投稿**、未必被接收，所以不算已发表。这个区分靠"投稿语境"检测实现。
 */

/** 等级常量（与索引记录里的 u8 字段对应）。 */
export const VENUE_TIER = {
  /** 未识别：预印本、识别不出、或只是投稿未接收 */
  none: 0,
  /** 有正式发表（被识别出的期刊/会议） */
  published: 1,
  /** 学科顶刊 / 顶会 */
  top: 2,
  /** 综合顶刊 */
  flagship: 3,
} as const;

/**
 * 归一化：去掉点号、逗号、连字符与全部空白，并小写化。
 * 这是"压缩缩写能匹配标准写法"的关键（见文件头注释）。
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[.,\-_:;()"']/g, "").replace(/\s+/g, "");
}

interface VenueRule {
  /** 归一化后要匹配的子串（**不是正则** —— 归一化后正则的边界锚点已无意义） */
  readonly needle: string;
  readonly tier: number;
  readonly zh: string;
  /**
   * 是否要求"附近有卷号或年份"。
   *
   * ⚠️ 为什么需要它：子串匹配对**短词**会撞车 ——
   * 实测踩过：`nature` 命中了 `digital signature scheme`（signature 里含 nature），
   * 于是把一篇密码学预印本判成了 Nature 论文。
   * 常见期刊名（`physrevlett`、`mnras`、`neurips`…）足够独特，不需要额外条件；
   * 而 `nature` / `science` / `cell` 这类**普通英文单词**必须配一个
   * 卷号或年份才算真的在指期刊（"Nature 435, 123 (2005)"）。
   */
  readonly needsVolume?: boolean;
}

/**
 * 规则表（归一化子串）。**按 needle 长度降序检查**，避免短模式抢先命中：
 * 例如 `physrevd` 必须比 `physrev` 先判，否则会落到较低的等级。
 */
const RULES: readonly VenueRule[] = [
  // ---------------- T3 综合顶刊 ----------------
  { needle: "naturereviewsmaterials", tier: 3, zh: "Nature Reviews Materials" },
  { needle: "naturecommunications", tier: 3, zh: "Nature Communications" },
  { needle: "naturephysics", tier: 3, zh: "Nature Physics" },
  { needle: "naturechemistry", tier: 3, zh: "Nature Chemistry" },
  { needle: "naturematerials", tier: 3, zh: "Nature Materials" },
  { needle: "naturemethods", tier: 3, zh: "Nature Methods" },
  { needle: "naturebiotechnology", tier: 3, zh: "Nature Biotechnology" },
  { needle: "natureastronomy", tier: 3, zh: "Nature Astronomy" },
  { needle: "natureenergy", tier: 3, zh: "Nature Energy" },
  { needle: "nature", tier: 3, zh: "Nature", needsVolume: true },
  { needle: "scienceadvances", tier: 3, zh: "Science Advances" },
  { needle: "sciencerobotics", tier: 3, zh: "Science Robotics" },
  { needle: "science", tier: 3, zh: "Science", needsVolume: true },
  { needle: "cell", tier: 3, zh: "Cell", needsVolume: true },
  { needle: "pnas", tier: 3, zh: "PNAS" },
  { needle: "proceedingsofthenationalacademy", tier: 3, zh: "PNAS" },

  // ---------------- T2 学科顶刊（用实测到的压缩缩写） ----------------
  { needle: "physrevlett", tier: 2, zh: "PRL" },
  { needle: "physicalreviewletters", tier: 2, zh: "PRL" },
  // ⚠️ 语料里同时存在 "PRL 95, 010401" 这种纯缩写写法，必须单独列。
  //    实测：漏了它会让 PRL 缩写写法掉到 T0。
  { needle: "prl", tier: 2, zh: "PRL" },
  { needle: "physicalreviewx", tier: 2, zh: "Physical Review X" },
  { needle: "physrevx", tier: 2, zh: "Physical Review X" },
  { needle: "journalofhighenergyphysics", tier: 2, zh: "JHEP" },
  { needle: "jhep", tier: 2, zh: "JHEP" },
  { needle: "astrophysicaljournal", tier: 2, zh: "ApJ" },
  { needle: "astrophysj", tier: 2, zh: "ApJ" },
  { needle: "astronomicaljournal", tier: 2, zh: "AJ" },
  { needle: "astronj", tier: 2, zh: "AJ" },
  // ⚠️ MNRAS 在语料里有**两种**归一化形态（实测）：
  //    "Mon. Not. Roy. Astron. Soc." → monnotroyastronsoc
  //    "Mon. Not. R. Astron. Soc."   → monnotrastronsoc（少一个字母）
  //    只写一种会漏掉一半。
  { needle: "monnotroyastronsoc", tier: 2, zh: "MNRAS" },
  { needle: "monnotrastronsoc", tier: 2, zh: "MNRAS" },
  { needle: "monthlynotices", tier: 2, zh: "MNRAS" },
  { needle: "mnras", tier: 2, zh: "MNRAS" },
  { needle: "astronastrophys", tier: 2, zh: "A&A" },
  { needle: "astronomyandastrophysics", tier: 2, zh: "A&A" },
  { needle: "journaloftheamericanchemicalsociety", tier: 2, zh: "JACS" },
  { needle: "jacs", tier: 2, zh: "JACS" },
  { needle: "angewandtechemie", tier: 2, zh: "Angew. Chem." },
  { needle: "advancedmaterials", tier: 2, zh: "Advanced Materials" },
  { needle: "advmater", tier: 2, zh: "Advanced Materials" },
  { needle: "nanoletters", tier: 2, zh: "Nano Letters" },
  { needle: "acsnanoletters", tier: 2, zh: "Nano Letters" },
  { needle: "journalofmachinelearningresearch", tier: 2, zh: "JMLR" },
  { needle: "jmlr", tier: 2, zh: "JMLR" },
  { needle: "ieeetranspatternanal", tier: 2, zh: "IEEE TPAMI" },
  { needle: "annalsofmathematics", tier: 2, zh: "Annals of Mathematics" },
  { needle: "annalsofstatistics", tier: 2, zh: "Annals of Statistics" },
  { needle: "annalsofprobability", tier: 2, zh: "Annals of Probability" },
  { needle: "actamathematica", tier: 2, zh: "Acta Mathematica" },
  { needle: "inventionesmathematicae", tier: 2, zh: "Inventiones" },
  { needle: "journaloffinance", tier: 2, zh: "Journal of Finance" },
  { needle: "reviewoffinancialstudies", tier: 2, zh: "RFS" },
  { needle: "journaloffinancialeconomics", tier: 2, zh: "JFE" },
  { needle: "americaneconomicreview", tier: 2, zh: "AER" },
  { needle: "econometrica", tier: 2, zh: "Econometrica" },
  { needle: "lancet", tier: 2, zh: "Lancet" },
  { needle: "newenglandjournalofmedicine", tier: 2, zh: "NEJM" },
  // 凝聚态/材料领域常用的高影响期刊
  { needle: "naturereviewsmaterials", tier: 3, zh: "Nature Reviews Materials" },
  { needle: "reports onprogressinphysics", tier: 2, zh: "Rep. Prog. Phys." },
  { needle: "repprogphys", tier: 2, zh: "Rep. Prog. Phys." },
  { needle: "revmodphys", tier: 2, zh: "Rev. Mod. Phys." },
  { needle: "reviewsofmodernphysics", tier: 2, zh: "Rev. Mod. Phys." },

  // ---------------- T2 顶会 ----------------
  { needle: "neurips", tier: 2, zh: "NeurIPS" },
  { needle: "nips", tier: 2, zh: "NeurIPS" },
  { needle: "neuralinformationprocessingsystems", tier: 2, zh: "NeurIPS" },
  { needle: "icml", tier: 2, zh: "ICML" },
  { needle: "internationalconferenceonmachinelearning", tier: 2, zh: "ICML" },
  { needle: "iclr", tier: 2, zh: "ICLR" },
  { needle: "internationalconferenceonlearningrepresentations", tier: 2, zh: "ICLR" },
  { needle: "cvpr", tier: 2, zh: "CVPR" },
  { needle: "computervisionandpatternrecognition", tier: 2, zh: "CVPR" },
  { needle: "iccv", tier: 2, zh: "ICCV" },
  { needle: "eccv", tier: 2, zh: "ECCV" },
  { needle: "europeanconferenceoncomputervision", tier: 2, zh: "ECCV" },
  { needle: "emnlp", tier: 2, zh: "EMNLP" },
  { needle: "naacl", tier: 2, zh: "NAACL" },
  // ⚠️ 会议**缩写**必须单独列：语料里几乎只写缩写（"ACL 2023"），
  //    只写全称会全部漏判（实测踩过：加了全称却漏了 acl/eacl/coling）。
  { needle: "acl", tier: 2, zh: "ACL" },
  { needle: "eacl", tier: 2, zh: "EACL" },
  { needle: "coling", tier: 2, zh: "COLING" },
  { needle: "conll", tier: 2, zh: "CoNLL" },
  { needle: "annualmeetingoftheassociationforcomputationallinguistics", tier: 2, zh: "ACL" },
  { needle: "aaai", tier: 2, zh: "AAAI" },
  { needle: "ijcai", tier: 2, zh: "IJCAI" },
  { needle: "siggraph", tier: 2, zh: "SIGGRAPH" },
  { needle: "acmtransactionongraphics", tier: 2, zh: "SIGGRAPH" },
  { needle: "acmtog", tier: 2, zh: "SIGGRAPH" },
  { needle: "symposiumontheoryofcomputing", tier: 2, zh: "STOC" },
  { needle: "stoc", tier: 2, zh: "STOC" },
  { needle: "focs", tier: 2, zh: "FOCS" },
  { needle: "sigcomm", tier: 2, zh: "SIGCOMM" },
  { needle: "sosp", tier: 2, zh: "SOSP" },
  { needle: "usenix", tier: 2, zh: "USENIX" },
  { needle: "internationalconferenceonroboticsandautomation", tier: 2, zh: "ICRA" },
  { needle: "icra", tier: 2, zh: "ICRA" },
  { needle: "iros", tier: 2, zh: "IROS" },
  { needle: "icassp", tier: 2, zh: "ICASSP" },
  { needle: "knowledge discoveryanddatamining", tier: 2, zh: "KDD" },
  { needle: "kdd", tier: 2, zh: "KDD" },
  { needle: "thew ebconference", tier: 2, zh: "WWW" },
  { needle: "worldwidewebconference", tier: 2, zh: "WWW" },
  { needle: "sigir", tier: 2, zh: "SIGIR" },
  { needle: "humanfactorsincomputingsystems", tier: 2, zh: "CHI" },

  // ---------------- T1 物理/数学/工程常见期刊（归一化后） ----------------
  // 这些是实测中出现频率最高的去处，全部归 T1（正式发表但不是顶刊）。
  { needle: "physrevd", tier: 1, zh: "Phys. Rev. D" },
  { needle: "physrevc", tier: 1, zh: "Phys. Rev. C" },
  { needle: "physrevb", tier: 1, zh: "Phys. Rev. B" },
  { needle: "physreva", tier: 1, zh: "Phys. Rev. A" },
  { needle: "physreve", tier: 1, zh: "Phys. Rev. E" },
  { needle: "physicalreview", tier: 1, zh: "Physical Review" },
  { needle: "physlettb", tier: 1, zh: "Phys. Lett. B" },
  { needle: "physicsletters", tier: 1, zh: "Physics Letters" },
  { needle: "nuclphysb", tier: 1, zh: "Nucl. Phys. B" },
  { needle: "nuclphysa", tier: 1, zh: "Nucl. Phys. A" },
  { needle: "nuclphys", tier: 1, zh: "Nucl. Phys." },
  { needle: "nuclinstrummeth", tier: 1, zh: "NIM" },
  { needle: "jphysa", tier: 1, zh: "J. Phys. A" },
  { needle: "jphysg", tier: 1, zh: "J. Phys. G" },
  { needle: "jphys", tier: 1, zh: "J. Phys." },
  { needle: "jmathphys", tier: 1, zh: "J. Math. Phys." },
  { needle: "jchemphys", tier: 1, zh: "J. Chem. Phys." },
  { needle: "classquantgrav", tier: 1, zh: "Class. Quantum Grav." },
  { needle: "eurphysjc", tier: 1, zh: "Eur. Phys. J. C" },
  { needle: "eurphysja", tier: 1, zh: "Eur. Phys. J. A" },
  { needle: "eurphysj", tier: 1, zh: "Eur. Phys. J." },
  { needle: "modphysletta", tier: 1, zh: "Mod. Phys. Lett. A" },
  { needle: "modphyslett", tier: 1, zh: "Mod. Phys. Lett." },
  { needle: "intjmodphysa", tier: 1, zh: "Int. J. Mod. Phys. A" },
  { needle: "intjmodphysd", tier: 1, zh: "Int. J. Mod. Phys. D" },
  { needle: "intjmodphys", tier: 1, zh: "Int. J. Mod. Phys." },
  { needle: "applphyslett", tier: 1, zh: "Appl. Phys. Lett." },
  { needle: "appliedphysicsletters", tier: 1, zh: "Appl. Phys. Lett." },
  { needle: "genrelgrav", tier: 1, zh: "Gen. Rel. Grav." },
  { needle: "europhyslett", tier: 1, zh: "Europhys. Lett." },
  { needle: "aipconfproc", tier: 1, zh: "AIP Conf. Proc." },
  { needle: "progtheorphys", tier: 1, zh: "Prog. Theor. Phys." },
  { needle: "astrophysspacesci", tier: 1, zh: "Astrophys. Space Sci." },
  { needle: "jcap", tier: 1, zh: "JCAP" },
  { needle: "newastron", tier: 1, zh: "New Astronomy" },
  { needle: "physica", tier: 1, zh: "Physica" },
  { needle: "solidstatecommun", tier: 1, zh: "Solid State Commun." },
  { needle: "japplphys", tier: 1, zh: "J. Appl. Phys." },
  { needle: "journalofappliedphysics", tier: 1, zh: "J. Appl. Phys." },
  { needle: "ieeetrans", tier: 1, zh: "IEEE Trans." },
  { needle: "ieeejournal", tier: 1, zh: "IEEE Journal" },
  { needle: "lecturenotes", tier: 1, zh: "Lecture Notes" },
  { needle: "springer", tier: 1, zh: "Springer" },
  { needle: "elsevier", tier: 1, zh: "Elsevier" },
  { needle: "worldscientific", tier: 1, zh: "World Scientific" },
  { needle: "iopscience", tier: 1, zh: "IOP" },
  { needle: "proceedingsof", tier: 1, zh: "会议论文集" },
  { needle: "journalof", tier: 1, zh: "期刊" },
  { needle: "journal", tier: 1, zh: "期刊" },
  { needle: "letters", tier: 1, zh: "Letters" },
  { needle: "review", tier: 1, zh: "Review" },
  { needle: "annals", tier: 1, zh: "Annals" },
  { needle: "bulletin", tier: 1, zh: "Bulletin" },
  { needle: "advancesin", tier: 1, zh: "Advances" },
  { needle: "conferenceon", tier: 1, zh: "会议" },
  { needle: "workshopon", tier: 1, zh: "研讨会" },
  { needle: "symposiumon", tier: 1, zh: "专题讨论会" },
  { needle: "proceedingsofthe", tier: 1, zh: "会议论文集" },
].sort((a, b) => b.needle.length - a.needle.length);

/**
 * "只是投稿"的语境。命中了就把等级压到 T0。
 *
 * 为什么需要：实测 `comments` 里大量出现
 *     "3 pages, 3 figures, submitted to Appl. Phys. Lett"
 *     "17 pages, 9 figures, submitted to Phys Rev E"
 * 这些**提到了期刊但还没被接收**，算作"已发表"是错的。
 *
 * ⚠️ 必须匹配**原始文本**，不能匹配归一化文本 ——
 * 归一化会把 `submitted to Appl. Phys. Lett` 压成 `submittedtoapplphyslett`，
 * 于是 `\bsubmitted\b` 的边界断言失效、整条规则永不命中（实测踩过）。
 */
const SUBMITTED_ONLY =
  /\b(submitted|under review|under consideration|preprint|in preparation|to be submitted)\b/i;

/** "已被接收/已发表"的语境 —— 命中则即使有 submitted 字样也按已发表算。 */
const ACCEPTED = /\b(accepted|to appear|to be published|published in|in press|appeared in)\b/i;

/**
 * 卷号 / 年份的信号 —— `needsVolume` 的规则必须配它才生效。
 *
 * ⚠️ 为什么放得这么宽：arXiv 的 journal_ref 里**连分隔符都可能没有**。
 * 实测真实数据：`phys.rev.lett. 96, 066804 (2006)` 会被写成
 *     `physrevlett960668042006`   ← 卷96 页066804 年2006，全黏在一起
 * 所以不能用"必须有逗号/括号"这种精确格式去卡，那样会大面积漏判。
 * 这里只要求**出现一个像年份的四位数**（1990–2035）或 `vol` 字样即可。
 *
 * 这个宽条件配 `needsVolume` 是够用的：它的唯一目的是挡住
 * `digital signature scheme` 这类**完全没有任何数字**的误命中。
 */
const VOLUME_SIGNAL = /(\b(19[89]\d|20[0-3]\d)\b)|(\bvol\b)|(\bvolume\b)/i;

/** 从文本推断发表去处等级。`text` 通常传 `journal_ref + " " + comments`。 */
export function venueTier(text: string): number {
  return venueInfo(text).tier;
}

/**
 * 同时返回**等级**与**识别到的去处名**。
 *
 * 为什么要返回名字：界面显示"PRL（学科顶刊）"比只显示"学科顶刊"有用得多 ——
 * 用户能一眼看出依据是什么，也就能反驳我们的判断（这是"可审计"的落地方式）。
 *
 * 导出语料时用它把原文压成 `{ tier: 0-3, zh: "PRL" }` 两个短字段，
 * 而不是把整段 `journal_ref + comments` 都搬进 JSONL（那会多出约 400 MB）。
 */
export function venueInfo(text: string): { tier: number; zh: string } {
  if (!text || !text.trim()) return { tier: VENUE_TIER.none, zh: "" };
  const n = normalize(text);
  const hasVolume = VOLUME_SIGNAL.test(text);

  // 显式标成 number：VENUE_TIER 是 `as const`，若让 TS 推断，
  // 初值 0 会把 best 窄化成字面量类型 0，后面赋 3 就报错。
  let best: number = VENUE_TIER.none;
  let bestZh = "";
  for (const rule of RULES) {
    if (rule.tier <= best) continue;
    if (!n.includes(rule.needle)) continue;
    // 普通英文单词（nature / science / cell）必须邻近卷号或年份才算指期刊
    if (rule.needsVolume && !hasVolume) continue;
    best = rule.tier;
    bestZh = rule.zh;
    if (best === VENUE_TIER.flagship) break; // 已最高，不必再扫
  }
  if (best === VENUE_TIER.none) return { tier: VENUE_TIER.none, zh: "" };

  // 语境修正：只说"投稿"且没有"已接收/已发表"字样 ⇒ 还没发表。
  if (SUBMITTED_ONLY.test(text) && !ACCEPTED.test(text)) {
    return { tier: VENUE_TIER.none, zh: "" };
  }
  return { tier: best, zh: bestZh };
}

/** 等级的中文名（界面显示）。 */
export function venueTierZh(tier: number): string {
  switch (tier) {
    case VENUE_TIER.flagship:
      return "综合顶刊";
    case VENUE_TIER.top:
      return "学科顶刊/顶会";
    case VENUE_TIER.published:
      return "正式发表";
    default:
      return "预印本";
  }
}

/** 等级对应的**星球大小倍率**（视觉编码用；未识别 = 1.0，不惩罚预印本）。 */
export function venueSizeBoost(tier: number): number {
  switch (tier) {
    case VENUE_TIER.flagship:
      return 2.2;
    case VENUE_TIER.top:
      return 1.75;
    case VENUE_TIER.published:
      return 1.3;
    default:
      return 1.0;
  }
}
