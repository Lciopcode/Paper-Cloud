/**
 * 论文云 · 资产契约
 * ============================================================================
 * **契约先行**：这里是管线（生产者）与前端（消费者）之间唯一的边界。
 * 改任何数据结构，先改本文件与 `docs/03-架构设计.md`，再改实现。
 *
 * 三个原则：
 *   1. **首屏 ≤ 2 MB**：manifest 必须小到可以立刻加载完；其余全部按需流式。
 *   2. **定宽二进制而非 JSON**：305 万篇用 JSON 会是 GB 级，浏览器扛不住。
 *   3. **每个字段都要说清"谁在用"**：没人用的字段不许进契约（省体积也省歧义）。
 */

/** 学科在宇宙里的布局（由 `src/data/domains.ts` 的策展值填充）。 */
export interface DomainLayout {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly tilt: readonly [number, number, number];
}

/**
 * 语义层产物（GPU 管线产出，格式见 `pipeline_gpu/README.md`）。
 *
 * ⚠️ **这一节是后补的，而它的缺失曾经是一个真实的缺口。**
 *
 * GPU 管线那一侧早就把四个文件的格式定死了，交接文档也因此反复承诺
 * "跑完 GPU、把文件搬回来跑一次 register.py，**前端一行代码都不用改**"。
 * 但实际上：`DomainEntry` 里没有 `semantic` 字段、`assets.ts` 里没有任何 loader ——
 * 于是 `register.py` 登记得再成功，界面也不会有任何变化，
 * **"格式先定死"只定死了生产者，消费者那一端从来没写**。
 *
 * 现在补上契约。四个文件都**按 docId 索引**（与 `rank.bin`、邻接表同一套约定），
 * 所以"点开一篇论文取它的簇号 / 向量"是 O(1) 的，不需要任何查找表。
 */
export interface SemanticAssets {
  /** 256 维 int8 嵌入（`LUNYEMB1`）。供"语义近邻"与第 6 层用。 */
  readonly embedding?: {
    readonly file: string;
    readonly count: number;
    readonly dim: number;
    /** `"int8"`。其它值表示格式未知 —— 前端应拒绝加载，而不是猜着读 */
    readonly quant: string;
    readonly bytes?: number;
  };
  /** 第 5 层「具体研究点」：**层内**聚类的簇归属（`LUNYCLU1`）。 */
  readonly clusters?: {
    readonly file: string;
    readonly count: number;
    /**
     * **全局最大**层内簇数（所有层里最大的那个）。
     * ⚠️ 不是"每层都用这么大" —— 每层是自适应的 `clip(round(sqrt(m/2)), 2, 64)`，
     * 且不足 4 篇的层跳过聚类（簇号恒为 0）。别拿它去推某篇的具体簇数。
     */
    readonly k: number;
    /** 记录的字节数，应为 4（u16 簇号 + u16 保留）。读取端据此校验错位 */
    readonly recordBytes: number;
    readonly bytes?: number;
  };
  /** 第三类关系「同路线」边（`LUNYROU1`）。无向，a < b，按 a 升序。 */
  readonly routes?: {
    readonly file: string;
    readonly count: number;
    readonly bytes?: number;
  };
  /** 第 5/6 层的中文名（c-TF-IDF 关键词；可选 LLM 润色）。 */
  readonly labels?: {
    readonly file: string;
    readonly method: string;
    /** 有多少个层有标签 */
    readonly strata: number;
    /** 一共给多少个研究点起了名 */
    readonly named: number;
  };
  /**
   * 第 6 层「技术路线」：Leiden 社区划分。
   *
   * 与其它资产一样是**两个文件分工**：
   *   · `meta`  —— 人读的元信息（k / 节点数 / 模块度 / **是否降级**…）
   *   · `table` —— 按 docId 索引的**定宽二进制**归属表（每篇 4 字节 u32，`0xFFFFFFFF` = 无归属）
   *
   * 为什么归属表不用 JSON：`membership` 是个 `{docId: 社区号}` 对象，
   * econ 只有 672 条、但**物理团量级会有上百万条**，JSON 既慢又占内存，
   * 而前端要的是"点开一篇就知道它属于哪条路线"（O(1)）。
   * 这正是本文件开头写的原则 2：定宽二进制而非 JSON。
   */
  readonly communities?: {
    readonly meta: string;
    readonly table: string;
    /** 表的长度（= 该学科篇数），用于区分"越界"与"没有社区" */
    readonly count: number;
    /** 社区（技术路线）条数 */
    readonly k: number;
    readonly recordBytes: number;
    /** 实际有归属的论文数（≤ count —— 没有同路线边的论文不属于任何路线） */
    readonly membershipCount: number;
    readonly modularity: number;
    /** 是否降级（当前**总是 true**：共被引证据缺席，只用语义近邻）。界面应如实显示 */
    readonly degraded: boolean;
  };
}

/** 一个学科在 manifest 里的条目。**这是首屏唯一需要加载的东西。** */
export interface DomainEntry {
  readonly id: string;
  readonly zh: string;
  readonly en: string;
  /** 星团主色（宝石色系） */
  readonly color: string;
  /** 光谱副色（色温梯度的外臂） */
  readonly color2: string;
  /** 一句话说明（面板显示） */
  readonly blurb: string;
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly tilt: readonly [number, number, number];

  /** 论文篇数 */
  readonly papers: number;
  /** 词表大小 V */
  readonly vocabSize: number;
  /** 词槽数 S */
  readonly slots: number;
  /** 目录容量 |C| = V^S 的十进制位数（UI 显示"这本目录有 73 位"） */
  readonly cardinalityDigits: number;
  /** 词表覆盖了多少比例的词次（%） */
  readonly vocabCoverage: number;
  /** 能算出编号的论文比例（%） */
  readonly encodablePct: number;
  /** 词表内的词超过词槽数（被截断）的比例（%） */
  readonly truncatedPct: number;
  /** 含词表外词的论文比例（%）—— 覆盖问题，与截断是两回事 */
  readonly oovPct: number;

  /** 编号脊柱文件 */
  readonly spine: { readonly file: string; readonly recordBytes: number };
  /** 编号表（按编号升序；按编号反查标题、永久链接落地校验的依据） */
  readonly rank?: { readonly file: string; readonly recordBytes: number; readonly count: number };
  /**
   * 层级：**层号 → 层**（数组下标就是层号）。
   *
   * 层号已经写进编号表的记录里（保留的 u16 字段），所以：
   *   · 由编号可以**立刻**知道一篇论文属于哪一层；
   *   · 反过来，一层包含哪些论文 = 编号表里 layer 字段命中的那些记录。
   * 这就是"位置由编号决定"在八层结构上的落地方式。
   */
  readonly strata?: readonly StrataEntry[];
  /** 交叉列表（挂了多个 arXiv 分类）的论文比例 */
  readonly crossPct?: number;
  /**
   * 跨学科桥：**其他学科 id → 本团有多少篇论文挂了对方学科的 arXiv 分类**。
   *
   * 这是真实统计，不是装饰性的连线。实测出的图景本身就说明问题：
   *   eess → cs 80,572 · cs → math 79,529 · math → cs 76,313
   *   physics → math 105,316（物理是最大的枢纽）
   *   econ → qfin 6,291，但 qfin → econ 只有 565（**单向**）
   * 所以桥有**方向** —— 它读的是"谁在借谁的分类"，不是一条对称的连线。
   */
  readonly bridges?: Readonly<Record<string, number>>;
  /**
   * 关系数据（邻接表）。**按需加载**，首屏不带。
   * `kinds` 声明这个文件里实际包含哪几类边 —— 界面据此决定显示哪些筛选，
   * 不允许出现"界面上有'引用'筛选、但数据里根本没有引用边"这种谎报。
   */
  readonly relations?: {
    readonly file: string;
    readonly k: number;
    readonly count: number;
    readonly kinds: readonly ("cites" | "sameField" | "sameRoute")[];
  };
  /**
   * 演示脊柱：每 `stride` 篇取 1 篇，**保留原始 docId**。
   * 首屏用它（几十 KB 而不是上百 MB），点开论文与编号反查与完整版完全一致。
   */
  readonly spineDemo?: {
    readonly file: string;
    readonly stride: number;
    readonly count: number;
    readonly recordBytes: number;
  };
  /** 词表文件 */
  readonly vocab: { readonly file: string };
  /**
   * 关键词检索索引（倒排表）。
   *
   * **不压缩**、且做成**浏览器内索引**（见 `src/data/search.ts` 的说明）：
   * 标题很短（平均 6.3 个不同词），八团合计只有 126 MB，
   * 于是"边打字边变暗"不需要任何网络往返。
   */
  readonly search?: {
    readonly file: string;
    readonly count: number;
    readonly words: number;
    readonly postings: number;
  };
  /**
   * 论文元数据（标题 / 作者 / 年份 / 摘要 / 发表去处）。
   *
   * **三个文件都不压缩**，因为浏览器用 HTTP `Range` 按需取字节：
   *   · `index`    定长记录，给定 docId 直接算出偏移 —— O(1)，不需要任何查找
   *   · `text`     标题 + 作者（点开一篇只取几百字节）
   *   · `abstract` 摘要（2 GB 量级，**只有用户展开摘要时才取那一段**）
   *   · `venue`    发表去处名（很短，多为 "PRL" "NeurIPS"）
   */
  readonly meta?: {
    readonly index: string;
    readonly text: string;
    readonly abstract: string;
    readonly venue?: string;
    /** 定长记录字节数（改布局时必须同步前端） */
    readonly recordBytes: number;
    /** 记录里内联的标题前缀字节数 */
    readonly headBytes: number;
    readonly count: number;
    /** 有摘要的比例（用来在界面上决定要不要显示"展开摘要"） */
    readonly withAbstractPct: number;
    /** 被识别出发表去处的比例 */
    readonly withVenuePct: number;
    /** 引用次数非零的比例（语料里这个字段**从未填充过**，所以是 0 —— 见 README 的诚实说明） */
    readonly citeNonZeroPct: number;
    /**
     * 年份直方图的起始年份（= 布局模块的 YEAR_MIN）。
     * `yearCounts[i]` 对应 `yearMin + i` 那一年的论文数。
     */
    readonly yearMin?: number;
    /**
     * 年份直方图（每一年一篇）。
     *
     * 时间排列模式需要它才能**按论文量等分**排布 ——
     * arXiv 的论文量随时间指数增长（物理团实测：1986 年 1 篇、2016 年 58,241 篇、
     * 2026 年 84,751 篇，累计到 2016 才过 50%）。若按年份等宽摆，
     * 论文会全挤在外圈、中间一片空白（第一次实现画出来就是个"甜甜圈"）。
     */
    readonly yearCounts?: readonly number[];
    /**
     * 产出爆发点（"超新星遗迹"的依据）。
     *
     * 判据：某年该 L3 方向的产出 ≥ 前三年均值的 2.2 倍，且当年 ≥ 40 篇、
     * 前三年均值 ≥ 8 篇。**前三年均值那一条是实测踩出来的** ——
     * 没有它会得到"前三年均值 0.33、1485 倍"这种毫无意义的数字。
     */
    readonly bursts?: readonly {
      /** L3 层 id（与 `strata[].id` 对应） */
      readonly stratum: string;
      readonly year: number;
      readonly papers: number;
      readonly prevAvg: number;
      readonly ratio: number;
      /**
       * 是否可能只是"arXiv 分库刚建立"造成的（该年 ≈ 分库建立年前后一年）。
       * 实测 eess 2017、econ 2018 —— 论文从别的分类迁过来，不是研究爆发。
       */
      readonly archiveArtifact?: boolean;
    }[];
  };

  /**
   * 引用数据（引用次数 → 星球亮度）。**这是 `DomainEntry` 的字段，不在 `meta` 里面。**
   *
   * ⚠️ `coveragePct` 必须显示给用户：抓取是分批跑的，目前只有一部分论文有数据。
   *    不显示的话，用户会把「没有记录」读成「引用很少」——
   *    那是把数据缺失伪装成结论，比功能缺失更糟。
   *
   * ⚠️ 位置踩过一次坑：我按 `bursts` 当锚点插入，而 `bursts` 是在 `meta` 里的，
   *    于是 `cites` 被加进了 `meta`，报 `Property 'cites' does not exist on type 'DomainEntry'`。
   *    **插入字段时要看锚点在哪个层级，不能只看字段名。**
   */
  readonly cites?: {
    readonly file: string;
    readonly count: number;
    readonly coveragePct: number;
    readonly citeNonZeroPct: number;
    readonly maxCites: number;
    /** 亮度归一化基准（第 99 百分位，不是最大值 —— 否则离群点会压平其余全部） */
    readonly scaleCites: number;
  };

  /**
   * 语义层（GPU 管线产出）。**可选**：没跑过 GPU 的学科没有这个字段，
   * 界面据此决定要不要显示第 5/6 层与"同路线"筛选，而不是显示一个点了没反应的按钮。
   */
  readonly semantic?: SemanticAssets;
}

/** 一个层级节点（八层里的第 3 层：研究方向）。 */
export interface StrataEntry {
  /** 层号（= 在 manifest.strata 数组里的下标，也是编号表里记录的值） */
  readonly index: number;
  /** 稳定 id（写进编号，发布后不可改） */
  readonly id: string;
  /** 父层 id（第 2 层：一级学科） */
  readonly l2: string;
  /** 中文名（用于界面） */
  readonly zh: string;
  /** 原始名（arXiv 分类码） */
  readonly en: string;
  /** 所属 arXiv 顶层 archive */
  readonly arch: string;
  /** 该层论文数 */
  readonly papers: number;
}

/** 总清单。首屏只加载它（约几 KB）。 */
export interface Manifest {
  readonly version: number;
  readonly generatedAt: string;
  /** 散射密钥（十六进制）。**必须随 manifest 下发**，否则前端算不出地址 */
  readonly scatterKey: string;
  readonly vocabSize: number;
  readonly slots: number;
  readonly domains: readonly DomainEntry[];
  readonly totalPapers: number;
  /** 各构建阶段的完成时间戳（用于判断"数据到哪一步了"）。 */
  readonly relationsBuiltAt?: string;
  readonly metaBuiltAt?: string;
  readonly searchBuiltAt?: string;
  readonly citesBuiltAt?: string;
  /** 语义层登记时间。**没有它说明 GPU 语义层还没跑过**（不是"跑了但为空"）。 */
  readonly semanticBuiltAt?: string;
}

/** 词表资产。 */
export interface VocabAsset {
  readonly id: string;
  readonly slots: number;
  /** 按词频降序；下标 = 词 id = 基数位 */
  readonly words: readonly string[];
}

/** 一篇论文的编号记录（从 spine.bin 里按 docId 随机取出，72 字节）。 */
export interface SpineRecord {
  readonly docId: number;
  /**
   * 原始编号（rank）。**这是"编号反查"与永久链接显示用的值**。
   * 类型是 bigint —— 它有 73 位十进制，number 装不下。
   */
  readonly rank: bigint;
  /**
   * 散射后的地址（scatter(rank)）。**这是空间位置与"虚空占用判定"用的值**。
   * 地址与编号是双射关系，两者都要存：地址用于几何，编号用于人读。
   */
  readonly addr: bigint;
  /** 词表内的实际词数 */
  readonly tokens: number;
  /** 词表内的词超过词槽数而被截断 */
  readonly truncated: boolean;
}

/** 内存中展开的一篇论文（供渲染与面板使用）。 */
export interface PaperPoints {
  /**
   * 构建时是否因为点数上限而**抽样截断**了。
   *
   * 界面必须据此如实显示"当前 N 点 / 共 M 篇" ——
   * 否则用户会把抽样结果当成全部（实测踩过：146 万篇只画了 11.2 万点，
   * 而按钮写着"载入全部"）。
   */
  readonly truncated: boolean;
  readonly domain: string;
  /** 用于渲染的点数（可能是全量的下采样） */
  readonly count: number;
  /** 该学科总篇数（count 可能小于它） */
  readonly total: number;
  /** 局部坐标（星团坐标系），长度 count*3 */
  readonly positions: Float32Array;
  /** 每点的基础尺寸（受 venue 等级影响） */
  readonly sizes: Float32Array;
  /** 每点颜色（受引用等级影响亮度） */
  readonly colors: Float32Array;
  /** 每点用于闪烁与散列的随机种子 [0,1) */
  readonly seeds: Float32Array;
  /** 点 → docId（点开论文时用它去 spine 取完整记录） */
  readonly docIds: Uint32Array;
  /**
   * 点 → 地址的**低 64 位**（仅用于位置散列与调试显示）。
   *
   * ⚠️ 这里刻意**不存完整地址**：地址有 73 位十进制（≈243 位），
   * `BigUint64Array` 装不下，硬塞就是又一次静默截断（我们在 spine 那边踩过）。
   * 需要完整地址时按 docId 读 spine 记录即可 —— 那是 O(1) 的。
   */
  readonly addrLow: BigUint64Array;
  /**
   * 逐顶点的**学科染色目标**（`count × 3`），与 `colors` 一一对应。
   *
   * 为什么要单独一份而不是从 `colors` 反推：`colors` 是"色温梯度 × 亮度 × 学科色"
   * 混过之后的**结果**，色相已经被底色（中段那一站是纯白）冲淡到几乎中性；
   * 反推不出"这一团该是什么颜色"。见 `geometry.ts` 的 `domainTint` 与
   * `STAR_VERT` 里 `uTint` 那段实测。
   */
  readonly tints: Float32Array;
}
