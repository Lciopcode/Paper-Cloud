/**
 * 论文云 · 全局状态
 * ============================================================================
 * 单一 zustand store。**按域切片**（注释分节），不堆成一个巨型对象。
 *
 * 跨域重置纪律：换选中目标时必须清理派生状态，否则会串台
 * （例如从物理团切到数学团时，上一团的论文点集必须被丢弃）。
 */
import { create } from "zustand";
import { DOMAINS } from "../data/domains.ts";
import { fetchRefsLive, loadCitations, type CitationTable, type ExtRef } from "../data/citations.ts";
import { useApiKeys } from "./apiKeys.ts";
import { assetUrlFor } from "../data/assets.ts";
import { loadSearchIndex, type SearchHit, type SearchResult } from "../data/search.ts";
import { buildYearScale, type LayoutMode, type YearScale } from "../three/layout.ts";
import {
  loadFilamentEdges,
  loadFullSpine,
  loadManifest,
  loadNeighbors,
  loadCrossTable,
  loadStratumTable,
  loadYearTable,
  metaStoreOf,
  preloadMetaIndex,
  loadSpine,
  loadVocab,
  type FilamentEdges,
  type MetaFull,
  type NeighborTable,
  type RankTable,
  type Spine,
} from "../data/assets.ts";
import type { Manifest, PaperPoints, SpineRecord, VocabAsset } from "../data/contract.ts";
import { buildBulge, buildDust, buildPoints, mergeNebula, MAX_POINTS } from "../three/points.ts";
import { catalogDigits, idsToTitle, unrankSpine, type Catalog } from "../engine/spine.ts";
import { loadCites as loadCiteTable, type CiteTable } from "../data/cites.ts";

/** 引用数据来源（见 `DomainRuntime.citeSource` 的说明） */
export interface CiteSource {
  /** `static` = 本地预抓表；`s2` / `openalex` = 外部数据库 */
  source?: "static" | "s2" | "openalex" | string;
  /** 实际凭据：用户自带 key / 内置 key / 匿名 */
  auth?: "user" | "builtin" | "anonymous" | string;
  /** 非空 = 这次没问到（限流/断网），不是"这篇没有引用" */
  error?: string;
}

/** 单个学科的运行时状态。 */
export interface DomainRuntime {
  readonly id: string;
  readonly zh: string;
  /** 加载阶段：'idle' → 'demo'（演示点集可用）→ 'ready'（完整点集）→ 'error' */
  phase: "idle" | "loading" | "demo" | "ready" | "error";
  error?: string;
  /** 总篇数（来自 manifest，加载前就可知） */
  total: number;
  spine?: Spine;
  /** 编号表（层级归属：层号写在编号表里，见 assets.ts 的 RankTable） */
  rankTable?: RankTable;
  /**
   * 关系数据（邻接表）：同领域邻居。**按需加载**（最大物理团 19 MB brotli），首屏绝不带。
   * 未加载时是 undefined —— 界面据此显示"加载相关论文"按钮，而不是"没有相关论文"。
   * 这两者对用户完全不同：前者是"还没查"，后者是"查了确实没有"。
   */
  neighbors?: NeighborTable;
  /** 关系数据是否正在加载 */
  relationsLoading?: boolean;
  /**
   * 丝线边（同技术路线的关系线，见 `assets.ts` 的 `FilamentEdges`）。
   *
   * 与 `neighbors` 分开：邻接表是**每篇 4 条同领域邻居**（用来在面板里列"相关论文"），
   * 而丝线边是**画在场景里的关系线**（全量 11.4 万条、3.9 MB），两者用途与规模都不同。
   * 未加载时是 `undefined` —— 界面据此知道"丝线还没到"，而不是"这个学科没有丝线"。
   */
  filamentEdges?: FilamentEdges;
  /** 丝线边是否正在加载 */
  filamentsLoading?: boolean;
  vocab?: VocabAsset;
  /** 编号目录（引擎输入） */
  catalog?: Catalog;
  /** 演示点集（首屏用） */
  demoPoints?: PaperPoints;
  /** 完整点集 */
  points?: PaperPoints;
  /** 星云（尘埃雾）—— 与点集一同构建 */
  nebula?: { positions: Float32Array; colors: Float32Array; sizes: Float32Array; tints: Float32Array; count: number };
  /** 是否已经用完整点集替换了演示点集 */
  full: boolean;
  /**
   * **引用表**（`public/data/citations/<d>.bin`，HTTP Range 随机访问）。
   * `null` = 这个学科还没有引用数据（如实呈现，不假装有）。
   */
  citations?: CitationTable | null;
  /**
   * 当前选中论文**引用的论文 docId**（真实引用，不是语义近邻）。
   * `undefined` = 还没查；`null` = 查过了但这个学科没有引用表。
   */
  citeRefs?: number[] | null;
  /** `citeRefs` 属于哪一篇（换选中论文时用来判断缓存是否过期） */
  citeRefsDoc?: number;
  citeRefsLoading?: boolean;
  /** 库外被引（只有标题/年/DOI，没有坐标） */
  citeExt?: ExtRef[];
  /**
   * 这批引用**是从哪来的**（UI 如实显示，用户才知道自己带的 key 有没有生效）。
   *
   *   · `source = "static"`   —— 本地预抓的 `citations/<d>.bin`；
   *   · `source = "s2" | "openalex"` —— 本地服务代问外部数据库；
   *   · `auth = "user" | "builtin" | "anonymous"` —— 那次请求实际用的凭据。
   * `error` 有值表示"这次没问到"，与"这篇没有引用"是两件事（见 CitedPapers 的文案）。
   */
  citeSource?: CiteSource;
  /**
   * 正在加载完整点集。
   *
   * ⚠️ 不是可有可无的装饰：完整脊柱最大 60 MB brotli，解压 + 建 146 万个点的几何
   * 要几秒到十几秒。没有加载态，用户点完界面**看起来就是卡死了**，于是会重复点击。
   * 入口按钮在加载期间据此变成"载入中…"并禁用。
   */
  fullLoading?: boolean;
}

/** 选中的对象（论文 / 星团 / 空）。 */
export type Selection =
  | {
      kind: "paper";
      domain: string;
      docId: number;
      record: SpineRecord;
      /** 由编号反查得到的标题（**永远可用**，不依赖任何网络请求） */
      title: string;
      indexDigits: number;
      /**
       * 元数据（标题/作者/年份/摘要/发表去处）。**异步补齐**，可能为 null。
       *
       * 为什么和 `title` 分开：`title` 是从编号算出来的、**必然相同**的（这是本作品的不变量），
       * 而 `meta` 是从语料来的、可能缺失（没作者、没摘要、没期刊信息）。
       * 混成一个字段会让"标题为什么和刚才不一样"变成无法回答的问题。
       */
      meta: MetaFull | null;
      /** 元数据是否正在加载 */
      metaLoading: boolean;
      /**
       * 请求的 docId 与**实际显示的那篇**差多远（演示视图里每 N 篇才有一篇，所以常常非 0）。
       * 界面据此如实说明"最近的可查看论文在 N 篇之外"，而不是让人以为点错了。
       */
      snapDistance: number;
      /** 用户原本想点的那一篇 */
      requestedDocId: number;
    }
  | { kind: "domain"; domain: string }
  | null;

interface CloudState {
  // ---- 启动 ----
  booted: boolean;
  bootError: string | null;
  manifest: Manifest | null;
  runtime: Record<string, DomainRuntime>;

  // ---- 视图 ----
  visibleDomains: string[];
  quality: "high" | "low";
  showLabels: boolean;
  /**
   * **背景是否隐藏**（作者要求："你现在把背景隐藏掉，增加背景隐藏功能"）。
   *
   * ## "背景"指什么，边界画在哪
   *
   * 指**不属于任何学科星团**的那几层：远星穹 `StarDome`、虚空星野 `VoidStars`、
   * 虚空薄雾 `VoidDust`、白噪声洗 `VoidGlow`（最后一层不透明度恒 0，是死代码）。
   * 八团自己的星云/核心柔光/星点/关系线**不算背景**，它们关掉这个开关之后必须照常。
   *
   * ## 为什么默认是 `true`（默认隐藏）
   *
   * 作者的原话是"你现在把背景隐藏掉"—— 先按他的意思关掉，再由他点开关打开。
   * 那一层彩色小星是"八团各裹一层自己的星野"，在没有学科色语义的观感下
   * 读起来就是一粒粒彩色星球，与"黑底上的学术星系"打架。
   *
   * ⚠️ 默认值改了会影响**所有按整幅画面统计的像素判据**（mean / blown / colored）——
   *    所以 `deploy/verify-background.mjs` 必须在**两种状态**下各量一次，不许只量一种。
   */
  hideBackground: boolean;
  /**
   * 是否显示**装饰性光雾**（星云尘埃 + 核心柔光）。
   *
   * 作者要「每一个发光的点都是一篇论文」，但那两层的点是装饰、不是论文。
   * 直接删掉会让画面变空（作者同时要求「一打开充满屏幕」），所以做成开关：
   * 默认**开**（诗云那种星系体积感），关掉就只剩论文点（严格一一对应）。
   */
  showDecor: boolean;
  /** 相机聚焦目标（星团 id → 世界坐标） */
  focusTarget: { pos: [number, number, number]; at: number } | null;
  /**
   * 自由飞行的速度倍率（滚轮调）。
   *
   * 为什么放进 store：HUD 要把它**显示出来**（照搬诗云那行
   * "速度 ×1.00 · 140 单位/秒"）—— 用户得知道自己调到了多少，
   * 否则"按了 W 怎么飘这么快/这么慢"就成了无从判断的事。
   * 它只在滚轮时变化，不会造成每帧重渲染。
   */
  flySpeed: number;

  // ---- 选择 ----
  selection: Selection;

  // ---- 检索 ----
  /** 当前检索的词（空 = 未检索） */
  searchQuery: string;
  /** 检索命中（null = 未检索 ⇒ 所有星都亮） */
  searchHits: SearchResult | null;
  searchBusy: boolean;
  searchError?: string;
  /** 排列模式的错误（如影响模式缺数据） */
  layoutError?: string;

  // ---- 交叉可视化 ----
  /** 排列模式：领域（8 座独立星系）/ 时间（一片盘，内老外新）/ 影响（缺引用数据，未实现） */
  layoutMode: LayoutMode;
  /** 各学科的年份表（时间模式用；按学科懒加载） */
  yearTables: Record<string, Uint16Array | null>;
  /**
   * 各学科的**年份分位对照表**（由 manifest 里的年份直方图建出）。
   *
   * 为什么要有它：时间排列模式必须**按论文量等分**而不是按年份等宽，
   * 否则 arXiv 的指数增长会让所有论文挤在外圈，中间一片空白（实测就是这个结果）。
   * 见 `src/three/layout.ts` 里 buildYearScale 的说明。
   */
  yearScales: Record<string, YearScale | null>;
  /** 星尘流：只留跨学科论文亮着（与检索过滤共用 aDim 机制） */
  showCrossOnly: boolean;
  /**
   * 超新星遗迹：选中一个"爆发点"后，只留**构成那次爆发的论文**亮着。
   * null = 未选中。
   */
  selectedBurst: { domain: string; stratum: number; stratumId: string; year: number } | null;
  /** 各学科的层号表（按 docId；按需加载） */
  stratumTables: Record<string, Uint16Array | null>;
  /**
   * 下潜高亮：只留某个**研究方向（L3）**的论文亮着。
   * null = 没有下潜高亮。
   */
  highlightStratum: { domain: string; stratum: number; stratumId: string } | null;
  /** 各学科的交叉列表标记表（按 docId；按需加载） */
  crossTables: Record<string, Uint8Array | null>;
  /**
   * 引用表（引用次数 → 星球亮度）。
   *
   * ⚠️ 覆盖率**必须如实显示**：抓取是分批跑的，早期只有一部分论文有数据。
   *    把"没有记录"当成"0 引用"会把数据缺失伪装成结论 ——
   *    `CiteTable` 用 flags 区分了两者，界面据此报告覆盖率。
   */
  citeTables: Record<string, CiteTable | null>;
  /** 是否把引用次数编进亮度（关掉可看"没有影响力编码"的原始星系） */
  showCites: boolean;
  /** 鼠标悬停的星（null = 没悬停）；x/y 是屏幕坐标，供标签跟随 */
  hover: { domain: string; docId: number; x: number; y: number } | null;
  /**
   * 星点密度模式（需求①）。
   *   "top" —— 默认：每个学科只画高被引的那一批（其余星隐藏）；
   *   "all" —— 「载入全部」：把已加载的点全画出来。
   */
  starMode: "top" | "all";
  /** 关系方向：refs = 这篇引用了谁；cites = 谁引用了这篇；all = 两者（默认） */
  refMode: "refs" | "cites" | "all";
  /**
   * 是否因为**实测帧率偏低**而自动降到了低画质档。
   *
   * 为什么要如实告知：用户没动过画质开关，画面却变了（星点变小变暗），
   * 不说清楚会以为"显示坏了"。同时给出"仍然切成高画质"的出口 ——
   * 自动降级是**建议**而不是强制。
   */
  perfAutoDegraded: boolean;
  /**
   * 用户是否手动选过画质。选过之后**整个会话都不再自动降级** ——
   * 否则"用户切回高画质、两秒后又被自动降回"会让人觉得开关坏了。
   * 自动降级是建议，用户一旦表态就该让位。
   */
  qualityUserChosen: boolean;
  /**
   * 系统是否请求「减少动态效果」。
   *
   * ⚠️ 这条偏好必须**一路传到着色器**，只写 CSS 的 `@media` 是不够的 ——
   *    星点闪烁是在**顶点着色器**里做的（6 万个点各自呼吸），
   *    CSS 管不到它。明确要求减少动态效果的用户不该继续看到满屏闪烁。
   */
  reducedMotion: boolean;

  // ---- 动作 ----
  boot: () => Promise<void>;
  ensureDomain: (id: string) => Promise<void>;
  /** 按需升级到完整点集 */
  loadFull: (id: string) => Promise<void>;
  /** 按需加载关系数据（邻接表） */
  loadRelations: (id: string) => Promise<void>;
  /** 加载丝线边（同技术路线的关系线） */
  loadFilaments: (id: string) => Promise<void>;
  /** 按需补齐当前所选论文的元数据（作者/年份/摘要/发表去处） */
  loadMeta: (domain: string, docId: number) => Promise<void>;
  /** 展开摘要时才取（摘要池是 GB 量级） */
  loadAbstract: (domain: string, docId: number) => Promise<string | null>;
  /** 关键词检索（浏览器内 BM25；空查询 = 清除） */
  search: (query: string) => Promise<void>;
  /** 清除检索 */
  clearSearch: () => void;
  /** 切换排列模式。切到"时间"时会去拉各学科的年份表（按需）。 */
  setLayoutMode: (mode: LayoutMode) => Promise<void>;
  /** 开关星尘流（只留跨学科论文亮着）。开启时按需拉交叉列表标记表。 */
  toggleCrossOnly: () => Promise<void>;
  /** 按需加载某学科的引用表。 */
  loadCites: (domain: string) => Promise<void>;
  /**
   * 下潜到某个研究方向（L3）：只留它的论文亮着。传 null 取消。
   * 这是"八层视觉下潜"在现有架构下的落地形式 —— 层号早就写进了编号，
   * 所以"看某一层"只是按层号筛一下，不需要任何新数据。
   */
  drillStratum: (domain: string, stratumId: string | null) => Promise<void>;
  /** 开关「引用亮度」。 */
  toggleCites: () => void;
  /** 设置/清除悬停星（StarPicker 每 80ms 调一次，必须便宜） */
  setHover: (h: { domain: string; docId: number; x: number; y: number } | null) => void;
  /** 由 docId 反查标题（与选中面板同一套编号反查，不额外发请求） */
  titleOf: (domain: string, docId: number) => string;
  /** 切换「精选 / 全部」 */
  toggleStarMode: () => void;
  /** 切换关系方向（会重新拉一次引用） */
  setRefMode: (m: "refs" | "cites" | "all") => void;
  /**
   * 选中/取消一个"爆发点"（超新星遗迹）。
   * 选中后只留"那个研究方向 + 那一年"的论文亮着 —— 即构成那次爆发的具体工作。
   */
  selectBurst: (b: { domain: string; stratumId: string; year: number } | null) => Promise<void>;
  toggleDomain: (id: string) => void;
  showAllDomains: () => void;
  /** 显示/隐藏背景层（远星穹 + 虚空星野 + 薄雾），不影响八团 */
  toggleBackground: () => void;
  toggleDecor: () => void;
  setBackgroundHidden: (v: boolean) => void;
  selectPaper: (domain: string, docId: number) => void;
  /**
   * 取当前选中论文的**引用列表**（真实引用）。
   *
   * 为什么不放进 `selectPaper` 里一起做：引用表是按学科一份的
   * （`citations/<d>.bin`），第一次点开某团的论文才需要建连接；
   * 而 `selectPaper` 是同步的、每次点星都走。放进去会把同步路径变成异步，
   * 点星的响应会被网络拖住。
   */
  loadCiteRefs: (domain: string, docId: number) => Promise<void>;
  clearSelection: () => void;
  setQuality: (q: "high" | "low") => void;
  /** 实测帧率偏低时自动降级（见实现处的说明） */
  autoDegradeQuality: (fps: number) => void;
  /** 用户手动改画质 */
  setQualityManual: (q: "high" | "low") => void;
  focusDomain: (id: string) => void;
  /** 滚轮调速（自由飞行） */
  setFlySpeed: (v: number) => void;
  /** 测试用：暴露脊椎以做自检 */
  debugSpine: (domain: string) => Spine | undefined;
  /**
   * 层级计数自洽检查（规划文档 P0-5 的验收项）。
   *
   * 不变量：**子级之和 == 父级**，一环扣一环直到该学科总篇数：
   *   L1（学科）== Σ L2（一级学科）== Σ L3（研究方向）== manifest 声明的篇数
   *
   * 为什么运行时也要能查：层级计数一旦对不上，界面上的"占比"与
   * "半径 ∝ √count"就全是错的，而且错得隐蔽 —— 看起来只是"某个方向好像少了一点"。
   * 构建期已经挡了一道（build-spine.mjs），这里是第二道，且是端到端的那一道。
   */
  checkHierarchy: (domain: string) => HierarchyCheck;
}

/** 层级自洽检查的结果。 */
export interface HierarchyCheck {
  readonly domain: string;
  readonly ok: boolean;
  /** manifest 声明的该学科篇数（L1） */
  readonly l1: number;
  readonly l2Sum: number;
  readonly l3Sum: number;
  readonly l2Count: number;
  readonly l3Count: number;
  /** 具体哪里对不上（空数组 = 全部自洽） */
  readonly problems: readonly string[];
}

/**
 * 星云尘埃（装饰性雾）相对论文点数的比例与上限。
 *
 * ⚠️ 2026-10 试过把它从 0.35 提到 **2.5**，**失败了，已退回**。实测：
 *
 *     nonBgPct 5.5 → 6.1     雾点多了 7 倍，画面覆盖率只多了 0.6 个百分点
 *     blownPct 0.33 → 4.09   过曝涨了 12 倍（参赛材料的红线是 1.5%）
 *
 * 原因：雾点**集中在同样的位置上**（星团内部），加量只是把同一处堆到饱和，
 * 并不会把画面铺开。所以"画面 94.5% 是纯黑"的根因**不是点数，是构图** ——
 * 8 个星团在视口里只占一小块，摄像机离得太远。要解决得动视点/尺度，
 * 不是往同一个地方塞更多粒子。
 *
 * 真要加密度，必须**同时把每颗调暗**（参考实现的原话："dimmer per-particle so
 * additive overlap accumulates into SMOOTH haze, no grainy bright dots"）——
 * 叠加混合下点数与单颗亮度是乘积关系，只加一头必然烧白。
 *
 * ## ⚠️ 2026-10：密度**确实加上去了**，而且两头一起动
 *
 * 上面这段"别加密度"的结论建立在**旧的构图**上（八个团离得远、只占视口一小块）。
 * 现在布局放大过（`LAYOUT_SCALE` × `RADIUS_BOOST`）、机位也调过，
 * 而且作者明确要求"星团体积变大、圆外要有东西" —— 所以改成照搬诗云的粒子数比例：
 *
 *   ⚠️ **不能照抄它的绝对粒子数，要抄的是"屏幕密度"。** 第一版照抄了它的比例
 *   （5 倍 ≈ 14.6 万雾点），结果整片烧成实心白团（实测 blownPct 6.36）。算一下就明白：
 *     · 它的 12 万尘埃铺在**占满屏幕**的星系上（约 159 万像素），单像素约 1 层精灵；
 *     · 我们的星团在屏幕上只占约 38 万像素 —— 同样 14.6 万粒子，**单像素叠了约 10 层**。
 *   所以按屏幕面积折算：尘埃 ≈ 论文数的 **1 倍**（物理团约 2.9 万），这才等价。
 *   它的 DUST:BULGE = 12:6.4 这个**比例**照抄（见 BULGE_RATIO），绝对量按屏幕折算。
 *
 * 配套动作（缺一不可）：
 *   · 星云按诗云的两群落配方重写（DUST 铺满盘 + BULGE 叠在中心，核球那批更大更软）；
 *   · 单颗亮度乘 `DUST_BRIGHT = 0.34` 压下去 —— 这就是上面那句"两头一起动"。
 * 实测标准：`probeGL` 的 `nonBgPct` 上去、`blownPct` 不跟着上去。
 */
const NEBULA_RATIO = 0.06;
const NEBULA_CAP = 40_000;
/**
 * 核球层相对尘埃层的比例。诗云：BULGE 64,000 / DUST 120,000 ≈ **0.53**。
 *
 * 两个群落是**独立采样、直接叠加**的（不是二选一）—— 中心 = 尘埃 + 核球、
 * 往外只剩尘埃，这样才没有亮度台阶（一圈暗环）。见 points.ts 里 nebulaPass 的说明。
 */
const BULGE_RATIO = 0.53;

export const useCloud = create<CloudState>((set, get) => ({
  booted: false,
  bootError: null,
  manifest: null,
  runtime: {},
  visibleDomains: DOMAINS.map((d) => d.id),
  quality: "high",
  showLabels: true,
  hideBackground: true,
  showDecor: true,
  focusTarget: null,
  flySpeed: 1,
  selection: null,
  searchQuery: "",
  searchHits: null,
  searchBusy: false,
  layoutMode: "domain",
  yearTables: {},
  yearScales: {},
  showCrossOnly: false,
  selectedBurst: null,
  stratumTables: {},
  highlightStratum: null,
  crossTables: {},
  citeTables: {},
  showCites: true,
  starMode: "top",
  refMode: "all",
  hover: null,
  perfAutoDegraded: false,
  qualityUserChosen: false,
  reducedMotion: typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,

  // ------------------------------------------------------------ 启动
  async boot() {
    if (get().booted) return;
    try {
      const manifest = await loadManifest();
      const runtime: Record<string, DomainRuntime> = {};
      for (const d of manifest.domains) {
        runtime[d.id] = { id: d.id, zh: d.zh, phase: "idle", total: d.papers, full: false };
      }
      set({ manifest, runtime, booted: true, bootError: null });
      // 首屏只要演示点集：8 个团并行加载（每个几十 KB，很快）
      await Promise.all(manifest.domains.map((d) => get().ensureDomain(d.id)));
      /**
       * **八团全量常驻**（作者原话：「每篇论文一个点、八团全量常驻」）。
       *
       * 原来只有用户点「载入全量」才把某团换成完整点集，于是默认画面上
       * **每 4 篇物理论文才有 1 颗星**（`points.ts` 的 recStep 抽样）——
       * 而作者要的"每个光点对应一篇论文"只有全量才成立。
       *
       * 为什么**串行**：8 团全量点集合计约 470 MB（10 个 float/点），
       * 并行下载 + 同时建几何会在最坏时刻要两倍瞬时内存。串行慢一点但稳。
       * 为什么**不 await**：首屏已经被演示点集撑住了，全量在后面一团一团换上去。
       */
      void (async () => {
        /**
         * 先等 1.2 秒再动手：首屏的第一帧要留给人看。八团全量是"背景工程"，
         * 不该和"打开页面就有东西看"抢同一瞬间的带宽与主线程。
         */
        await new Promise((r) => setTimeout(r, 1200));
        for (const d of manifest.domains) {
          if (get().bootError) break;
          try {
            await get().loadFull(d.id);
          } catch {
            /* 单个团失败不该拖住其余团 */
          }
          /**
           * 团与团之间留 800ms。
           *
           * ⚠️ 不加间隔时，测出的现象是**自检大面积变红**：`verify-bloom` 与
           * `verify-background` 都报"画面 15 秒内没有稳定"，数值从 1.5 飙到 17。
           * 那不是产品坏了 —— 是自检在**加载风暴**里量画面：每个团的完整点集
           * （物理 146 万点）替换演示点集时整屏都要重建一次。
           * 留间隔既让页面在这几秒里可交互，也让"等稳定"这件事有机会成立。
           */
          await new Promise((r) => setTimeout(r, 800));
        }
      })();
      /*
       * 后台拉引用表（**不 await**，不阻塞首屏）。
       *
       * 为什么要自动拉而不是等用户点开关：引用亮度是默认开启的，
       * 若等用户去点，他会看到一片"没有影响力差异"的星系，
       * 而实际上数据是有的 —— 那会让人以为这个功能没做。
       *
       * 体积可接受：引用表每篇 8 字节，物理团 11 MB（对比元数据索引 89 MB）。
       * 而且只有 `manifest.cites` 登记过的学科才拉 —— 没抓到的学科不会被请求。
       */
      void (async () => {
        for (const d of manifest.domains) {
          if (!d.cites) continue;
          await get().loadCites(d.id);
        }
      })();
    } catch (e) {
      set({ bootError: e instanceof Error ? e.message : String(e), booted: false });
    }
  },

  // ------------------------------------------------------------ 按需加载
  async ensureDomain(id: string) {
    const st = get();
    const dom = st.manifest?.domains.find((d) => d.id === id);
    if (!dom) return;
    const rt = st.runtime[id];
    if (!rt) return;
    // 已经在加载或已经就绪就直接返回（幂等）
    if (rt.phase === "loading" || rt.phase === "ready" || rt.phase === "demo") return;

    const patch = (p: Partial<DomainRuntime>) =>
      set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], ...p } } }));

    patch({ phase: "loading" });
    try {
      // 首屏只加载**演示脊柱**（每 50 篇取 1，八团合计约 4 MB brotli）。
      //
      // ⚠️ 这里踩过一个让首屏直接空白的坑：
      //   ① 曾经在这里 `Promise.all` 等**完整脊柱**（八团合计 121 MB brotli），
      //      浏览器忙着解压与构点，8 个学科全部卡在"载入中"；
      //   ② 后来又把**编号表**（物理团 34 MB）塞进来，问题更重。
      //   现在：完整脊柱与编号表都改成**按需加载**（loadFullSpine / loadRankTable），
      //   首屏只做"能看见星系"这一件事。
      const [vocab, spine] = await Promise.all([loadVocab(id), loadSpine(id)]);
      const catalog: Catalog = { id, vocab: vocab.words, slots: vocab.slots };
      const layout = { center: dom.center, radius: dom.radius, tilt: dom.tilt };

      // 演示点集：直接就是全部抽样点（再抽一次会让星团太稀）
      const demoPoints = buildPoints(spine, {
        domain: id, domainColor: dom.color, color2: dom.color2, layout,
      }, 1);
      /**
       * 星云粒子数（照搬诗云的 DUST + BULGE 比例，见 `NEBULA_RATIO` 的说明）。
       *
       * 低画质档砍到一半：那一档的瓶颈是**填充率**，而雾的精灵又大又软，
       * 是像素着色器最贵的部分（与星点那边"低画质压尺寸上限"同一个道理）。
       */
      const nebulaRatio = get().quality === "high" ? NEBULA_RATIO : NEBULA_RATIO * 0.5;
      const dustCount = Math.min(NEBULA_CAP, Math.round(demoPoints.count * nebulaRatio));
      // 核球层按诗云的比例（BULGE 6.4 万 / DUST 12 万 ≈ 0.53）
      const bulgeCount = Math.round(dustCount * BULGE_RATIO);
      const seed = BigInt("0x" + (dom.id.length * 7919 + 104729).toString(16));
      const nebula = mergeNebula(
        buildDust(seed, dustCount, layout, dom.color),
        // 核球换一个种子：两层若用同一串地址，叠加处会出现整齐的"同心花纹"
        buildBulge(seed ^ 0x5bf03635n, bulgeCount, layout, dom.color),
      );

      patch({ phase: "demo", vocab, spine, catalog, demoPoints, nebula, full: false, error: undefined });

      // ---- 后台预取元数据索引，到了之后**重建一次点集** ----
      //
      // 为什么要重建：点的**大小**由"发表去处评级"决定（用户要求"评级→星球大小"），
      // 而 `buildPoints` 是纯同步函数、评级要读元数据索引（单团最大 93 MB）。
      // 所以先用默认大小把星系画出来（首屏不被网络拖住），索引到位后再重建一次。
      // 失败就算了（点集保持默认大小），不影响任何其他功能。
      void (async () => {
        const reader = await preloadMetaIndex(id);
        if (!reader) return;
        const rt2 = get().runtime[id];
        if (!rt2?.spine || rt2.phase === "error") return;
        const pts = buildPoints(
          rt2.spine,
          {
            domain: id,
            domainColor: dom.color,
            color2: dom.color2,
            layout,
            // 评级就在索引记录里，同步可读（不需要再发请求）
            impactOf: (docId) => reader.head(docId)?.venueTier ?? 0,
          },
          1,
        );
        set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], demoPoints: pts } } }));
      })();
    } catch (e) {
      patch({ phase: "error", error: e instanceof Error ? e.message : String(e) });
    }
  },

  /**
   * 按需升级到完整点集（用户明确要看这个星团的全部论文时）。
   *
   * 为什么必须按需：完整脊柱最大 60 MB brotli（物理团 146 万篇），
   * 首屏带它会让"展开宇宙"从 3 秒变成一分钟。默认只画每 50 篇取一篇的演示点集。
   *
   * ⚠️ `fullLoading` 不是可有可无的装饰：60 MB 解压 + 建 146 万个点的几何
   * 要几秒到十几秒。没有加载态，用户点了之后界面**看起来就是卡死了**，
   * 于是会重复点击。所以入口按钮在加载期间必须变成"载入中…"并禁用。
   */
  async loadFull(id) {
    const rt = get().runtime[id];
    if (!rt || rt.full || rt.fullLoading) return;
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], fullLoading: true } } }));
    try {
      const spine = await loadFullSpine(id);
      const dom = get().manifest?.domains.find((d) => d.id === id);
      if (!dom) return;
      const layout = { center: dom.center, radius: dom.radius, tilt: dom.tilt };
      /*
       * ⚠️ 上限传 `Infinity` —— 这是「载入全部」按钮，就必须真的画全部。
       *    第一版用了默认上限 12 万，于是物理团 146 万篇只画了 112,584 点，
       *    而按钮写着「载入全部」—— 按钮名在说谎。
       *    实测发现方式：性能自检里打印 points.count，112,584 ≠ 1,463,588。
       *
       *    为什么敢放到无限：全部论文是**一个 THREE.Points、一次 draw call**，
       *    点精灵在顶点着色器里算尺寸。146 万顶点的属性缓冲约 58 MB，正常范围。
       */
      const points = buildPoints(
        spine,
        { domain: id, domainColor: dom.color, color2: dom.color2, layout },
        1,
        Number.POSITIVE_INFINITY,
      );
      set((s) => ({
        runtime: {
          ...s.runtime,
          // ⚠️ 这里 `points` 换成完整点集后，`StarLayer` 里那几个依赖 `points` 的
          //    useEffect 会重跑（位置重写、压暗、几何重建），所以检索/星尘流/
          //    爆发点的高亮都会自动跟着更新 —— 不需要额外的同步逻辑。
          [id]: { ...s.runtime[id], spine, points, phase: "ready", full: true, fullLoading: false },
        },
      }));
    } catch (e) {
      set((s) => ({
        runtime: {
          ...s.runtime,
          [id]: {
            ...s.runtime[id],
            fullLoading: false,
            error: `完整点集加载失败：${e instanceof Error ? e.message : String(e)}`,
          },
        },
      }));
    }
  },

  /**
   * 按需加载**关系数据**（邻接表），并算出当前选中论文的相关论文。
   *
   * 为什么按需：完整邻接表最大 19 MB brotli（物理团），首屏绝不能带。
   * 用户点开"相关论文"时才加载。
   */
  async loadRelations(id) {
    const rt = get().runtime[id];
    if (!rt || rt.neighbors) return;
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], relationsLoading: true } } }));
    try {
      const neighbors = await loadNeighbors(id);
      set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], neighbors, relationsLoading: false } } }));
    } catch (e) {
      set((s) => ({
        runtime: {
          ...s.runtime,
          [id]: {
            ...s.runtime[id],
            relationsLoading: false,
            error: `关系数据加载失败：${e instanceof Error ? e.message : e}`,
          },
        },
      }));
    }
  },

  // ------------------------------------------------------------ 丝线
  /**
   * 按需加载**丝线边**（同技术路线的关系线）。
   *
   * 与 `loadRelations` 同一个模式，但代价小得多：每个学科一个文件，
   * 全量 11.4 万条边合计只有 **3.9 MB**（物理团 20,000 条 = 0.7 MB），
   * 所以这里**不设开关门槛** —— 场景挂载后就后台加载，用户不必先点一次。
   *
   * ⚠️ 但如果它和首屏的点集抢带宽，会拖慢"第一眼看到星系"。
   *    所以调用方（`Filaments` 组件）是**等场景就绪之后**才触发的，
   *    不是随首屏一起发出去。
   */
  async loadFilaments(id) {
    const rt = get().runtime[id];
    if (!rt || rt.filamentEdges || rt.filamentsLoading) return;
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], filamentsLoading: true } } }));
    try {
      const filamentEdges = await loadFilamentEdges(id);
      set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], filamentEdges, filamentsLoading: false } } }));
    } catch (e) {
      set((s) => ({
        runtime: {
          ...s.runtime,
          [id]: {
            ...s.runtime[id],
            filamentsLoading: false,
            error: `丝线数据加载失败：${e instanceof Error ? e.message : e}`,
          },
        },
      }));
    }
  },

  // ------------------------------------------------------------ 视图
  toggleDomain(id) {
    set((s) => ({
      visibleDomains: s.visibleDomains.includes(id)
        ? s.visibleDomains.filter((x) => x !== id)
        : [...s.visibleDomains, id],
    }));
  },
  showAllDomains() {
    set({ visibleDomains: DOMAINS.map((d) => d.id) });
  },
  /** 装饰光雾开关（星云尘埃 + 核心柔光）—— 关掉就只剩论文点 */
  toggleDecor() {
    set((s) => ({ showDecor: !s.showDecor }));
  },
  toggleBackground() {
    set((s) => ({ hideBackground: !s.hideBackground }));
  },
  setBackgroundHidden(v) {
    set({ hideBackground: v });
  },
  setQuality(quality) {
    set({ quality });
  },
  setFlySpeed(v) {
    set({ flySpeed: v });
  },

  focusDomain(id) {
    const dom = get().manifest?.domains.find((d) => d.id === id);
    if (!dom) return;
    set({ focusTarget: { pos: [dom.center[0], dom.center[1], dom.center[2]], at: Date.now() } });
  },

  // ------------------------------------------------------------ 选择
  selectPaper(domain, docId) {
    const rt = get().runtime[domain];
    if (!rt?.spine || !rt.catalog) return;
    // 演示脊柱只含每 N 篇中的一篇，所以目标 docId 常常不在其中。
    // 这时跳到**最接近的**那一条，并把距离如实告诉界面 ——
    // 比"点了没反应"诚实得多（见 Spine.nearestRecord 的说明）。
    const near = rt.spine.nearestRecord(docId);
    const useDocId = rt.spine.canResolve(docId) ? docId : near ? near.docId : docId;
    const record = rt.spine.get(useDocId);
    if (!record) return;
    // 编号 → 标题（"编号反查"）
    //
    // ⚠️ **必须按 `record.tokens` 截断**：编码是定长的，`rankSpine` 会把不足词槽的位置补 0，
    // 而这些 0 解回来就是"词表第 0 个词"。不截断的话，一个 11 词的标题会显示成
    // "... model model model model model model model model model"（补了 9 个最高频词）。
    // 定长编码本身是对的，但**展示时必须还原成真实词数**。
    const ids = unrankSpine(rt.catalog, record.rank).slice(0, record.tokens);
    const title = idsToTitle(rt.catalog, ids);
    set({
      selection: {
        kind: "paper",
        domain,
        docId: useDocId,
        record,
        title,
        indexDigits: catalogDigits(rt.catalog),
        meta: null,
        metaLoading: true,
        /** 目标 docId 与"实际显示的那篇"差多远（0 = 就是它） */
        snapDistance: near ? near.distance : 0,
        requestedDocId: docId,
      },
    });
    // 元数据（作者/年份/摘要/发表去处）异步补齐。**不阻塞选择** ——
    // 标题已经由编号算出来了，界面可以立刻显示；元数据到了再补上。
    void get().loadMeta(domain, useDocId);
  },

  /**
   * 取一篇论文的元数据并补进当前选择。
   *
   * 为什么要单独一个动作、而不是在 selectPaper 里 await：
   *   ① 标题是**算出来的**（编号反查），永远是即时的；
   *   ② 元数据要发 Range 请求，会有几十毫秒延迟，不该拖慢"点星即出字"。
   * 所以两者分开：先出能出的，再补不能立刻出的。
   */
  async loadMeta(domain, docId) {
    const store = metaStoreOf(domain);
    if (!store) {
      // manifest 里没登记元数据 ⇒ 明确指出"还没构建"，而不是让面板一直转圈
      set((s) =>
        s.selection?.kind === "paper" && s.selection.docId === docId
          ? { selection: { ...s.selection, meta: null, metaLoading: false } }
          : {},
      );
      return;
    }
    try {
      const meta = await store.full(docId);
      set((s) =>
        s.selection?.kind === "paper" && s.selection.domain === domain && s.selection.docId === docId
          ? { selection: { ...s.selection, meta, metaLoading: false } }
          : {},
      );
    } catch (e) {
      set((s) =>
        s.selection?.kind === "paper" && s.selection.docId === docId
          ? { selection: { ...s.selection, metaLoading: false } }
          : {},
      );
      // 记到 runtime 的 error 上，界面上能看到（而不是静默失败）
      set((s) => ({
        runtime: {
          ...s.runtime,
          [domain]: { ...s.runtime[domain], error: `元数据加载失败：${e instanceof Error ? e.message : e}` },
        },
      }));
    }
  },

  /** 取某篇论文的摘要（**只在用户展开摘要时调用** —— 摘要池是 GB 量级）。 */
  async loadAbstract(domain, docId) {
    const store = metaStoreOf(domain);
    if (!store) return null;
    return await store.abstract(docId);
  },

  /**
   * 关键词检索。
   *
   * 索引**按需加载**（单团最大 62 MB），加载后常驻内存；检索本身在浏览器里跑、
   * 不发网络请求 —— 所以能边打字边更新（见 `src/data/search.ts` 的说明）。
   *
   * 空查询 = 清除检索（所有星恢复明亮）。
   */
  async search(query) {
    const q = query.trim();
    if (!q) {
      set({ searchHits: null, searchQuery: "", searchBusy: false, searchError: undefined });
      return;
    }
    const manifest = get().manifest;
    if (!manifest) return;
    set({ searchQuery: q, searchBusy: true, searchError: undefined });

    const targets = manifest.domains.flatMap((d) => (d.search ? [{ id: d.id, file: d.search.file }] : []));
    if (targets.length === 0) {
      set({ searchBusy: false, searchError: "还没有构建检索索引（跑 pipeline/build-search.mjs）" });
      return;
    }

    try {
      const indices = (
        await Promise.all(targets.map((d) => loadSearchIndex(d.id, assetUrlFor(d.file)).catch(() => null)))
      ).filter((x) => x !== null);

      // ---- 跨学科统一 IDF ----
      // 不统一的话，同一个词在**小团**里会因为"占比更高"而拿到更大的 idf，
      // 于是搜 "quantum" 排在最前的是 stat / eess，而 physics 反而靠后 ——
      // 那是度量不一致，不是真实相关性（见 search.ts 里 termStats 的说明）。
      const q0 = q.toLowerCase();
      const rawTerms = (q0.match(/[a-z0-9][a-z0-9-]+/g) ?? []).filter((t) => t.length >= 3);
      let totalDocs = 0;
      const dfMap = new Map<string, number>();
      for (const idx of indices) {
        totalDocs += idx.totalDocs;
        for (const t of rawTerms) {
          const st = idx.termStats(t);
          if (st) dfMap.set(t, (dfMap.get(t) ?? 0) + st.df);
        }
      }
      const globalIdf = { totalDocs, df: dfMap };

      // 合并各学科结果：keys 取并集 —— 渲染层用它决定哪颗星保持明亮。
      // ⚠️ keys 必须是**全量命中**，不能只留前 N 条，否则画面上会少亮一片。
      const keys = new Set<string>();
      const top: SearchHit[] = [];
      let total = 0;
      const unknown = new Set<string>();
      const terms = new Set<string>();
      for (const idx of indices) {
        const r = idx.search(q, 200, globalIdf);
        total += r.total;
        for (const k of r.keys) keys.add(k);
        for (const t of r.terms) terms.add(t);
        for (const u of r.unknown) unknown.add(u);
        for (const h of r.top) top.push(h);
      }
      top.sort((a, b) => b.score - a.score);
      // "未收录"只保留**在所有学科里都没收录**的词。
      //
      // ⚠️ 不加这一步会自相矛盾：某个词在物理团里收录、在经济学团里没收录时，
      // 界面会同时显示"词 galaxy"和"未收录：galaxy"（实测踩过），
      // 看起来像 bug，其实是"各学科词表不同"被错误地汇总了。
      for (const t of terms) unknown.delete(t);
      // 竞态保护：期间用户又改了查询就丢弃这次结果（否则会闪回旧结果）
      if (get().searchQuery !== q) return;
      set({
        searchHits: { query: q, terms: [...terms], unknown: [...unknown], total, keys, top: top.slice(0, 60) },
        searchBusy: false,
      });
    } catch (e) {
      set({ searchBusy: false, searchError: `检索失败：${e instanceof Error ? e.message : e}` });
    }
  },

  /** 清除检索。 */
  clearSearch() {
    set({ searchHits: null, searchQuery: "", searchBusy: false, searchError: undefined });
  },

  /**
   * 开关星尘流：只留跨学科论文亮着。
   *
   * 为什么值得单独一个开关：一篇论文挂没挂**别的学科的分类**，是"它跨出去了"的直接证据；
   * 但整团亮着的时候看不出是哪一批工作跨出去的。打开星尘流就能看到那批论文本身。
   *
   * ⚠️ 它原来是为"星桥"服务的（星桥画的是每对学科的交叉篇数），
   *    星桥 2026-10 已被密集丝线取代、随后丝线也改成"点击才显示"，
   *    但这个筛子本身仍然有意义，所以保留。
   */
  async toggleCrossOnly() {
    const next = !get().showCrossOnly;
    set({ showCrossOnly: next });
    if (!next) return;
    const manifest = get().manifest;
    if (!manifest) return;
    const targets = manifest.domains.filter((d) => get().visibleDomains.includes(d.id));
    await Promise.all(
      targets.map(async (d) => {
        if (get().crossTables[d.id]) return;
        try {
          const t = await loadCrossTable(d.id);
          set((s) => ({ crossTables: { ...s.crossTables, [d.id]: t } }));
        } catch (e) {
          set({ layoutError: `跨学科标记表加载失败：${e instanceof Error ? e.message : e}` });
        }
      }),
    );
  },

  /**
   * 选中/取消一个爆发点。
   *
   * 为什么值得做成"能点进去看"：清单本身只是数字（"1997 年 491 篇，18×"），
   * 而用户真正想知道的是"那到底是些什么工作"。选中后只留那批论文亮着，
   * 于是"一次爆发"从统计量变成了可以逐个点开看的论文集合。
   */
  async selectBurst(b) {
    if (!b) {
      set({ selectedBurst: null });
      return;
    }
    const manifest = get().manifest;
    const entry = manifest?.domains.find((d) => d.id === b.domain);
    const idx = entry?.strata?.findIndex((s) => s.id === b.stratumId) ?? -1;
    if (idx < 0) {
      set({ layoutError: `找不到层 ${b.stratumId}` });
      return;
    }
    set({ selectedBurst: { domain: b.domain, stratum: idx, stratumId: b.stratumId, year: b.year } });
    // 层号表与年份表都按需加载（各 1–3 MB，比元数据索引便宜得多）
    try {
      if (!get().stratumTables[b.domain]) {
        const st = await loadStratumTable(b.domain);
        set((s) => ({ stratumTables: { ...s.stratumTables, [b.domain]: st } }));
      }
      if (!get().yearTables[b.domain]) {
        const yt = await loadYearTable(b.domain);
        set((s) => ({ yearTables: { ...s.yearTables, [b.domain]: yt } }));
      }
    } catch (e) {
      set({ layoutError: `爆发点数据加载失败：${e instanceof Error ? e.message : e}` });
    }
  },

  /**
   * 按需加载引用表。
   *
   * 引用表每篇 8 字节（物理团 11 MB），比元数据索引小得多，
   * 但首屏仍然不该带 —— 只有用户打开"引用亮度"或看论文详情时才需要。
   */
  async loadCites(domain) {
    if (get().citeTables[domain]) return;
    try {
      const ct = await loadCiteTable(domain);
      set((s) => ({ citeTables: { ...s.citeTables, [domain]: ct } }));
    } catch (e) {
      // 没有引用数据是**正常情况**（还没抓到那个学科），不当作错误报给用户，
      // 只在控制台留一条，界面显示"暂无引用数据"。
      console.info(`[论文云] ${domain} 暂无引用数据：${e instanceof Error ? e.message : e}`);
    }
  },

  /**
   * 下潜到某个研究方向。
   *
   * 为什么值得做：层级不是装饰 —— 层号**已经写进每一篇的编号**，
   * 所以"只看这个方向"是一次 O(1) 的判断，不需要任何新数据。
   * 这让"从星系 → 一级学科 → 研究方向"这条下潜路径真的能走通。
   */
  async drillStratum(domain, stratumId) {
    if (!stratumId) {
      set({ highlightStratum: null });
      return;
    }
    const entry = get().manifest?.domains.find((d) => d.id === domain);
    const idx = entry?.strata?.findIndex((s) => s.id === stratumId) ?? -1;
    if (idx < 0) {
      set({ layoutError: `找不到层 ${stratumId}` });
      return;
    }
    set({ highlightStratum: { domain, stratum: idx, stratumId } });
    if (!get().stratumTables[domain]) {
      try {
        const st = await loadStratumTable(domain);
        set((s) => ({ stratumTables: { ...s.stratumTables, [domain]: st } }));
      } catch (e) {
        set({ layoutError: `层号表加载失败：${e instanceof Error ? e.message : e}` });
      }
    }
  },

  /**
   * 实测帧率偏低时自动降级（只降一次，不反复横跳）。
   *
   * 阈值取 12 fps：低于这个值交互已经明显不跟手（旋转视角会拖影）。
   * 只在**高画质**时降 —— 已经是低画质就不再降，避免无意义的状态写入。
   */
  autoDegradeQuality(fps) {
    /*
     * ⚠️ 用户手动选过画质之后**整个会话都不再自动改**。
     *
     * 第一版只清了 perfAutoDegraded 标记，于是"用户切回高画质 → 2 秒后又被
     * 自动降回低画质"—— 用户会觉得开关是坏的。自动降级是**建议**，
     * 一旦用户表态就该让位（实测踩过）。
     */
    if (get().qualityUserChosen) return;
    if (get().quality === "low" || get().perfAutoDegraded) return;
    if (fps >= 12) return;
    set({ quality: "low", perfAutoDegraded: true });
  },

  /** 用户手动改画质：记下"用户表过态了"，此后不再自动降级 */
  setQualityManual(q) {
    set({ quality: q, perfAutoDegraded: false, qualityUserChosen: true });
  },

  /** 开关「引用亮度」。开启时顺手把可见学科的引用表拉下来。 */
  setHover(h) {
    set({ hover: h });
  },
  titleOf(domain, docId) {
    const rt = get().runtime[domain];
    if (!rt?.spine || !rt.catalog) return "";
    const record = rt.spine.get(docId);
    if (!record) return "";
    const ids = unrankSpine(rt.catalog, record.rank).slice(0, record.tokens);
    return idsToTitle(rt.catalog, ids);
  },
  setRefMode(m) {
    set({ refMode: m });
  },
  toggleStarMode() {
    set((s) => ({ starMode: s.starMode === "top" ? "all" : "top" }));
  },
  toggleCites() {
    const next = !get().showCites;
    set({ showCites: next });
    if (!next) return;
    for (const id of get().visibleDomains) void get().loadCites(id);
  },


  /**
   * 切换排列模式。
   *
   * 切到"时间"时要去拉各学科的年份表（每篇 2 字节；物理团 2.9 MB）——
   * 这一步**按需**做，领域模式（默认）不需要它，所以首屏不会带。
   * 年份表到位之前，时间模式会用 year=0 把论文放在最内圈，
   * 到位后立刻重排（不会出现"点了没反应"）。
   */
  async setLayoutMode(mode) {
    set({ layoutMode: mode, layoutError: undefined });

    /*
     * 影响模式需要引用表才摆得出来（半径由被引次数决定）。
     * 引用表是启动后**后台**拉的，正常已经就位；这里再确认一次，
     * 避免用户手快在它到位之前切过来 —— 那样会看到一整个"未知"外环，
     * 而实际上数据马上就有。
     */
    if (mode === "impact") {
      const manifest = get().manifest;
      if (!manifest) return;
      await Promise.all(
        manifest.domains
          .filter((d) => d.cites && get().visibleDomains.includes(d.id))
          .map((d) => get().loadCites(d.id)),
      );
      const missing = get().visibleDomains.filter((id) => !get().citeTables[id]);
      if (missing.length === get().visibleDomains.length) {
        set({
          layoutError:
            "还没有任何学科的引用数据 —— 影响模式会把全部论文都摆进「未知」那一环。" +
            "抓取正在进行（pipeline/harvest-cites.mjs），稍后再试。",
        });
      }
      return;
    }

    if (mode !== "time") return;

    const manifest = get().manifest;
    if (!manifest) return;
    // 年份分位表由 manifest 里的直方图**同步**建出（不需要额外请求）——
    // 有了它才能按论文量等分排布（见 layout.ts 的说明）。
    const scales: Record<string, YearScale | null> = { ...get().yearScales };
    for (const d of manifest.domains) {
      const yc = d.meta?.yearCounts;
      const y0 = d.meta?.yearMin;
      if (yc && typeof y0 === "number" && !scales[d.id]) scales[d.id] = buildYearScale(y0, yc);
    }
    set({ yearScales: scales });
    // 只为**当前可见**的学科拉年份表 —— 不可见的团不参与绘制
    const targets = manifest.domains.filter((d) => get().visibleDomains.includes(d.id));
    await Promise.all(
      targets.map(async (d) => {
        if (get().yearTables[d.id]) return;
        try {
          const t = await loadYearTable(d.id);
          set((s) => ({ yearTables: { ...s.yearTables, [d.id]: t } }));
        } catch (e) {
          set({ layoutError: `年份表加载失败：${e instanceof Error ? e.message : e}` });
        }
      }),
    );
  },

  async loadCiteRefs(domain, docId) {
    const rt = get().runtime[domain];
    if (!rt) return;
    // 已经取过这一篇就不再发请求（引用表是 Range 读、有缓存，但状态也要挡住重复触发）
    if (rt.citeRefsDoc === docId && rt.citeRefs !== undefined) return;
    set((s) => ({
      runtime: {
        ...s.runtime,
        [domain]: { ...rt, citeRefsDoc: docId, citeRefsLoading: true, citeSource: undefined },
      },
    }));
    let table = rt.citations;
    if (table === undefined) table = await loadCitations(domain);
    let refs: number[] | null = null;
    let ext: ExtRef[] = [];
    let citeSource: CiteSource | undefined;

    /**
     * **实时取引用**（本地服务代问 S2 / OpenAlex）。
     *
     * 两个触发条件：
     *   ① 有静态表、但这一篇在表里没有记录（原来的行为）；
     *   ② **没有静态表**的学科 —— 只有用户在「数据源」面板里打开"实时引用"才走。
     *      默认关：首次取某学科要先建该学科的 arXiv 编号索引（10–30 秒），
     *      不主动开就不该让点一颗星变成等待。
     */
    /**
     * 是否允许实时取引用。
     *
     * ⚠️ **没有静态引用表的学科自动允许**（除物理之外都是这种）：
     * 否则"实时引用"开关默认关闭时，点星永远拿不到 refs → 一根线都不画，
     * 而用户会以为"引用关系没了"（事实是根本没请求）。开关仍可用于**关闭**它。
     */
    const allowLive = useApiKeys.getState().allowLiveRefs || !table;
    const tryLive = async () => {
      const live = await fetchRefsLive(domain, docId, get().refMode);
      if (!live) return;
      citeSource = { source: live.source, auth: live.auth, error: live.error };
      if (!live.error) {
        refs = live.in;
        ext = live.ext;
      }
    };

    if (table) {
      try {
        refs = Array.from(await table.refsOf(docId));
        ext = [...(await table.extOf(docId))];
        if (refs.length || ext.length) {
          citeSource = { source: "static" };
        } else {
          await tryLive();
        }
      } catch (e) {
        // Range 读失败（服务器不支持 / 文件被换掉）不该让界面卡在"载入中"
        refs = null;
        ext = [];
        console.warn("引用表读取失败", e);
      }
    } else if (allowLive) {
      await tryLive();
    }
    const cur = get().runtime[domain];
    if (!cur) return;
    set((s) => ({
      runtime: {
        ...s.runtime,
        [domain]: {
          ...cur,
          citations: table,
          citeRefs: refs,
          citeExt: ext,
          citeSource,
          citeRefsLoading: false,
        },
      },
    }));
  },

  clearSelection() {
    set({ selection: null });
  },

  debugSpine(domain) {
    return get().runtime[domain]?.spine;
  },

  /**
   * 层级计数自洽检查：L1 == Σ L2 == Σ L3 == manifest 声明的篇数。
   *
   * 三级都要比，不能只比总数 —— 只比总数会漏掉"某一层重复计数、另一层少计"的情况
   * （两边抵消，总数看起来是对的）。所以这里同时比**每一级的和**与**节点个数**。
   */
  checkHierarchy(domain) {
    const entry = get().manifest?.domains.find((d) => d.id === domain);
    const strata = entry?.strata ?? [];
    const l1 = entry?.papers ?? 0;
    const byL2 = new Map();
    let l3Sum = 0;
    const problems: string[] = [];
    for (const s of strata) {
      if (!s.id || !s.l2) problems.push(`层 ${s.index} 缺 id 或 l2`);
      if (!Number.isFinite(s.papers) || s.papers < 0) problems.push(`层 ${s.id} 篇数非法：${s.papers}`);
      l3Sum += s.papers;
      byL2.set(s.l2, (byL2.get(s.l2) ?? 0) + s.papers);
    }
    const l2Sum = [...byL2.values()].reduce((a, b) => a + b, 0);
    if (strata.length === 0) problems.push("manifest 里没有 strata（层级未构建？）");
    if (l3Sum !== l1) problems.push(`Σ L3(${l3Sum}) != L1(${l1})`);
    if (l2Sum !== l3Sum) problems.push(`Σ L2(${l2Sum}) != Σ L3(${l3Sum})`);
    if (l2Sum !== l1) problems.push(`Σ L2(${l2Sum}) != L1(${l1})`);
    // 层号必须是 0..n-1 且不重复（层号写进了编号表，重复会让"编号 → 层"变成多值）
    const seen = new Set<number>();
    for (const s of strata) {
      if (seen.has(s.index)) problems.push(`层号重复：${s.index}`);
      seen.add(s.index);
    }
    return {
      domain,
      ok: problems.length === 0,
      l1,
      l2Sum,
      l3Sum,
      l2Count: byL2.size,
      l3Count: strata.length,
      problems,
    };
  },
}));

/** 首屏统计（HUD 用）。 */
export function useStats() {
  const manifest = useCloud((s) => s.manifest);
  const runtime = useCloud((s) => s.runtime);
  const ready = Object.values(runtime).filter((r) => r.phase === "ready" || r.phase === "demo").length;
  const points = Object.values(runtime).reduce(
    (a, r) => a + (r.points?.count ?? r.demoPoints?.count ?? 0),
    0,
  );
  /**
   * 有几个星团是**抽样显示**的（点数少于该学科的论文数）。
   *
   * 界面对此必须如实说明。`PaperPoints.truncated` 由构建期写入，
   * 而不是在这里比较 `count < total` —— 因为演示点集**本来就是抽样**，
   * 用数量比较会把"有意抽样的首屏"也算成截断，那是误报。
   */
  const truncated = Object.values(runtime).filter((r) => {
    const p = r.points ?? r.demoPoints;
    return p?.truncated === true;
  }).length;
  /** 当前画出来的这些点代表多少篇论文（抽样时说清"实际共多少"用） */
  const visiblePapers = Object.values(runtime).reduce((a, r) => {
    const p = r.points ?? r.demoPoints;
    return a + (p ? p.total : 0);
  }, 0);
  return {
    totalPapers: manifest?.totalPapers ?? 0,
    domainCount: manifest?.domains.length ?? 0,
    ready,
    points,
    truncated,
    visiblePapers,
    maxPoints: MAX_POINTS,
  };
}

/**
 * 「减少动态效果」偏好的**实时**监听。
 *
 * ## 为什么需要（原来只在 store 创建时读一次）
 *
 * 那项偏好的初值是在模块加载时读 matchMedia 的，之后再变就没人管了 ——
 * 用户在系统设置里打开「减少动态效果」，**已经开着的页面不会有任何变化**，得刷新才生效。
 * 而这条偏好是**无障碍**语义（前庭敏感的用户会因此不适），不是启动参数：
 * 它应该在改的那一刻就生效。
 *
 * 顺带解决一个可测性问题：没有它，「动画在减少动态效果下会停住吗」这个判据
 * 只能靠**重载页面**来测（`verify-a11y.mjs` 一直在这么做）；
 * 有了它，自检可以在同一个页面里来回切换、直接对比两个状态。
 */
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const sync = () => useCloud.setState({ reducedMotion: mq.matches });
  // Safari 14 之前只有 addListener；两种都挂上。重复触发无害（同值时不会引起重渲染）
  mq.addEventListener?.("change", sync);
  mq.addListener?.(sync);
}
