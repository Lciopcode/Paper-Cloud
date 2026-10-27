/**
 * 论文云 · 学术层级（八层里的前几层）
 * ============================================================================
 * 这是**唯一的层级定义来源**：管线用它给论文分层，前端用它把层画成宇宙结构。
 * 两边必须用同一份，否则"编号算出来的层"与"画面画的层"会对不上。
 *
 * ## 为什么层级要写进编号（而不是只当标签）
 *
 * 本作品的核心不变量是：**位置由编号唯一决定**。
 *   编号 → 标题 → 坐标，这条链必须是函数，否则：
 *   · 按编号反查出来的坐标与真实论文的坐标不在同一套坐标系里；
 *   · 永久链接恢复不出同一颗星；
 *   · "半编号"（前缀锁定区间）失去意义。
 *
 * 所以层级**不能只挂在元数据上**，必须进编号。做法是把编号空间**按层切片**：
 *
 *   编号 = [ 层号 stratum ][ 层内编号 rankWithin ]
 *   层内编号 = 该层的词表（V 个词）在 S 个词槽上的定长编码
 *
 * 于是：
 *   · 给定编号，先解出层号 ⇒ 立即知道它在宇宙里的哪一层、哪个星团；
 *   · 同一层的论文编号落在**同一段连续区间**里 ⇒ 它们的坐标天然聚在一起；
 *   · 关键词累积（`keywords ∧ entry`）可以直接写成**层号 + 层内前缀**，
 *     这正是"半编号"在八层结构里的自然推广。
 *
 * ## 层级来源（**全部来自真实数据，不含人工臆造**）
 *
 *   L1 学科门类   ← 策展的 8 个学科（`src/data/domains.ts`）
 *   L2 一级学科   ← arXiv 顶层 archive（cs / math / cond-mat / astro-ph / hep-th …）
 *   L3 研究方向   ← arXiv 二级分类（cs.CV / cond-mat.mtrl-sci / math.AP …）
 *   L4 交叉标记   ← 是否被交叉列表（`cats.length > 1`）—— 这是"交叉论文"的真实信号
 *
 * 再往下的"具体研究点 / 技术路线"需要语义聚类或引用社区（P1/P2），
 * 那两层**不属于本文件**：它们由 GPU 管线产出，作为层内再细分使用。
 */

/** 一层在树里的节点。 */
export interface StratumNode {
  /** 稳定 id（写进编号，因此**一旦发布就不能改**） */
  readonly id: string;
  /** 中文名 */
  readonly zh: string;
  /** 英文/原始名（arXiv archive 或分类码） */
  readonly en: string;
  /** 父节点 id（根为 null） */
  readonly parent: string | null;
  /** 层级深度（1 = 学科门类） */
  readonly depth: number;
  /** 归属的学科 id（与 domains.ts 对应；根节点为 null） */
  readonly domain: string | null;
  /** 该层包含的论文数（由管线回填） */
  readonly papers: number;
}

/** 是否把跨列表的论文单独标一层。 */
export const CROSS_TAG = "x";

// ---------------------------------------------------------------- L2：arXiv archive → 中文名
/**
 * arXiv 顶层 archive 的中文名。
 *
 * 只覆盖语料里真实出现过的 archive（见 `pipeline/_measure-cats.mjs` 的实测分布）。
 * 未收录的会退化成"原始名 + 原样显示"，不会丢数据。
 */
const ARCHIVE_ZH: Readonly<Record<string, string>> = {
  cs: "计算机科学",
  math: "数学",
  "cond-mat": "凝聚态物理",
  "astro-ph": "天体物理",
  physics: "普通物理",
  "hep-ph": "粒子物理·现象学",
  "hep-th": "粒子物理·理论",
  "hep-ex": "粒子物理·实验",
  "hep-lat": "粒子物理·格点",
  "quant-ph": "量子物理",
  "gr-qc": "引力与量子宇宙学",
  "nucl-th": "核物理·理论",
  "nucl-ex": "核物理·实验",
  "math-ph": "数学物理",
  nlin: "非线性科学",
  eess: "电子工程",
  stat: "统计学",
  "q-bio": "定量生物学",
  econ: "经济学",
  "q-fin": "金融工程",
};

/** arXiv 二级分类的中文名（覆盖语料里的高频分类；未收录的原样显示）。 */
const SUBCAT_ZH: Readonly<Record<string, string>> = {
  // 计算机
  "cs.CV": "计算机视觉",
  "cs.LG": "机器学习",
  "cs.CL": "自然语言处理",
  "cs.AI": "人工智能",
  "cs.RO": "机器人学",
  "cs.IT": "信息论",
  "cs.NE": "神经网络与进化计算",
  "cs.DS": "数据结构与算法",
  "cs.CR": "密码学与安全",
  "cs.SE": "软件工程",
  "cs.DB": "数据库",
  "cs.DC": "分布式与并行计算",
  "cs.GR": "图形学",
  "cs.SD": "声音与语音处理",
  "cs.MM": "多媒体",
  "cs.HC": "人机交互",
  "cs.CY": "计算与社会",
  "cs.IR": "信息检索",
  "cs.MA": "多智能体系统",
  "cs.SY": "系统与控制",
  "cs.CE": "计算工程",
  "cs.CG": "计算几何",
  "cs.PL": "程序语言",
  "cs.LO": "逻辑与形式化方法",
  "cs.NI": "网络与互联网",
  "cs.OS": "操作系统",
  "cs.AR": "硬件架构",
  "cs.ET": "新兴技术",
  "cs.FL": "形式语言与自动机",
  "cs.GT": "博弈论与机制设计",
  "cs.MS": "数学软件",
  "cs.NA": "数值分析",
  "cs.SC": "符号计算",
  "cs.SI": "社会与信息网络",
  // 数学
  "math.AP": "偏微分方程",
  "math.CO": "组合数学",
  "math.PR": "概率论",
  "math.OC": "优化与控制",
  "math.AG": "代数几何",
  "math.NA": "数值分析",
  "math.NT": "数论",
  "math.DG": "微分几何",
  "math.FA": "泛函分析",
  "math.RT": "表示论",
  "math.ST": "统计理论",
  "math.LO": "数理逻辑",
  "math.GT": "几何拓扑",
  "math.IT": "信息论（数学）",
  "math.MP": "数学物理",
  "math.CA": "经典分析",
  "math.GR": "群论",
  "math.AT": "代数拓扑",
  "math.DS": "动力系统",
  "math.QA": "量子代数",
  "math.RA": "环与代数",
  "math.SP": "谱理论",
  "math.MG": "度量几何",
  "math.CV": "复分析",
  "math.AC": "交换代数",
  "math.KT": "K 理论与同调代数",
  "math.OA": "算子代数",
  "math.GN": "一般拓扑",
  "math.HO": "数学史与综述",
  "math-ph": "数学物理",
  // 凝聚态
  "cond-mat.mtrl-sci": "材料科学",
  "cond-mat.mes-hall": "介观与霍尔效应",
  "cond-mat.str-el": "强关联电子",
  "cond-mat.stat-mech": "统计力学",
  "cond-mat.supr-con": "超导",
  "cond-mat.soft": "软物质",
  "cond-mat.quant-gas": "量子气体",
  "cond-mat.dis-nn": "无序与神经网络",
  "cond-mat.other": "凝聚态·其他",
  // 天体物理
  "astro-ph.GA": "星系与银河系",
  "astro-ph.SR": "太阳与恒星",
  "astro-ph.HE": "高能天体物理",
  "astro-ph.CO": "宇宙学",
  "astro-ph.EP": "地球与行星",
  "astro-ph.IM": "天文仪器与方法",
  // 电子工程
  "eess.IV": "图像与视频处理",
  "eess.SP": "信号处理",
  "eess.AS": "音频与语音",
  "eess.SY": "系统与控制",
  "eess.EL": "电子器件",
  // 统计
  "stat.ML": "统计机器学习",
  "stat.ME": "统计方法论",
  "stat.AP": "应用统计",
  "stat.TH": "统计理论",
  "stat.CO": "计算统计",
  // 定量生物
  "q-bio.NC": "神经科学",
  "q-bio.PE": "种群与进化",
  "q-bio.QM": "定量方法",
  "q-bio.BM": "生物大分子",
  "q-bio.GN": "基因组学",
  "q-bio.MN": "分子网络",
  "q-bio.CB": "细胞行为",
  "q-bio.TO": "组织与器官",
  // 经济与金融
  "econ.EM": "计量经济学",
  "econ.TH": "经济理论",
  "econ.GN": "一般经济学",
  "q-fin.ST": "金融统计",
  "q-fin.MF": "数理金融",
  "q-fin.GN": "一般金融",
  "q-fin.RM": "风险管理",
  "q-fin.CP": "计算金融",
  "q-fin.PM": "资产组合管理",
  "q-fin.TR": "交易与市场微结构",
  "q-fin.PR": "资产定价",
};

/**
 * 分类码 → L2 archive 键（**这是层级切分的核心规则**）。
 *
 * ⚠️ 刻意保持"一字不改地按 arXiv 的既有结构"：
 * `cond-mat` / `astro-ph` / `hep-*` / `nucl-*` 在 arXiv 里是**独立的顶层 archive**
 * （不是 `physics.*` 的子分类），所以这里也把它们当顶层 ——
 * 尊重数据本来的结构，比我另发明一套归并更可靠、也更容易向别人解释。
 */
export function archiveOf(cat: string): string {
  const c = (cat ?? "").toLowerCase().trim();
  if (!c) return "(none)";
  // hep-ph / hep-th / hep-ex / hep-lat 本身就是顶层 archive
  if (c.startsWith("hep-")) return c.split(".")[0];
  if (c.startsWith("nucl-")) return c.split(".")[0];
  if (c === "math-ph" || c.startsWith("math-ph")) return "math-ph";
  const arch = c.split(".")[0];
  return arch || "(none)";
}

/** archive 的中文名（未收录时原样返回）。 */
export function archiveZh(arch: string): string {
  return ARCHIVE_ZH[arch] ?? arch;
}

/** 分类码的中文名（未收录时原样返回）。 */
export function catZh(cat: string): string {
  return SUBCAT_ZH[cat] ?? cat;
}

/**
 * 分类码 → L3 研究方向 id。
 * 没有二级分类的（如 `hep-th`）退化成 archive 本身，保证每个分类都有归宿。
 */
export function subcatOf(cat: string): string {
  const c = (cat ?? "").toLowerCase().trim();
  if (!c) return "(none)";
  const parts = c.split(".");
  return parts.length > 1 ? parts[1] : parts[0];
}

/**
 * 一个论文归属的**层路径**（从 L1 到 L3 的节点 id 列表）。
 *
 * L4（是否交叉列表）**不在这里**：它不是"分类归属"，而是一个布尔标记，
 * 由 `crossTagOf` 单独给出 —— 混进层路径会让每个分类都分裂成两半，
 * 把层级树撑成两倍宽却没有信息量。
 */
export function stratumPath(domain: string, primaryCat: string): { l2: string; l3: string } {
  const arch = archiveOf(primaryCat);
  const sub = subcatOf(primaryCat);
  return { l2: `${domain}/${arch}`, l3: `${domain}/${arch}/${sub}` };
}

/** 是否属于"交叉列表"（arXiv 里同时挂了多个分类）。 */
export function crossTagOf(cats: readonly string[]): boolean {
  return cats.length > 1;
}
