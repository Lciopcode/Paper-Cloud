/**
 * 论文云 · 学科领域定义（八层学术层级的**第一层：学科门类 / 宇宙网**）
 * ============================================================================
 * 这是**契约文件**：管线、引擎、界面都从这里取学科定义，不许各写一份。
 *
 * 层级说明（完整八层见 `docs/03-架构设计.md`）：
 *   ① 学科门类（宇宙网）        ← 本文件：8 个学科
 *   ② 一级学科（超星系团）      ← 领域层级抓取（OpenAlex field）
 *   ③ 大研究方向（星系群）      ← OpenAlex subfield
 *   ④ 子研究方向（星系）        ← OpenAlex primary_topic
 *   ⑤ 课题方向（星团）          ← OpenAlex topics / arXiv 分类
 *   ⑥ 具体研究点（星云）        ← GPU 语义聚类
 *   ⑦ 技术路线（恒星）          ← 引用社区发现 ∩ 语义近邻
 *   ⑧ 论文（行星/小行星）       ← 单篇论文
 *
 * 为什么学科划分要写死在这里：它是**策展结果**（人类决定的分类），不是统计结果。
 * arXiv 的 primary category 只是"投稿时选的分类"，会有大量跨领域与误选；
 * 把它归并成 8 个学科是本作品的设计决策，因此必须显式、可审计、可修改。
 */

/** 学科定义。 */
export interface DomainSpec {
  /** 短 id（用于文件名、URL、状态键） */
  readonly id: string;
  /** 中文名（界面主标签） */
  readonly zh: string;
  /** 英文名（副标签） */
  readonly en: string;
  /**
   * 归类到本学科的 arXiv 分类前缀（**按顺序**匹配，先命中者胜）。
   *
   * ⚠️ 注意语义：这是"主分类落在这里就算这个学科"。
   * 一篇论文可能同时有 `cs.LG` 与 `stat.ML`，我们按**主分类**（primary_cat）归团，
   * 避免同一篇论文出现在两个星系里（那会让"论文与论文的关系"变得含糊）。
   */
  readonly prefixes: readonly string[];
  /**
   * 学科主题色。
   *
   * ⚠️ **2026-10 整体提高了彩度**（每个定义后面留着旧值）。
   * 起因是把观感对齐到诗云时量到"单像素饱和度差 2~4 倍"：
   *
   * ┌─ 拉远到与诗云同一取景（`_scratch/probe-dolly.mjs`，距离 90，mean 35.6 vs 36.2）
   * │            亮起来   色差>18   色差>30   色差>50
   * │  诗云        23.9%     32.0%     11.6%      5.6%
   * │  我们        20.9%     16.4%      4.5%      1.3%
   * └─ 也就是**亮度分桶已经对上了，饱和度没对上**
   *
   * 逐层单独出图（`_scratch/probe-layer-solo.mjs`）定位到中性的是 halo / field / stars 三层，
   * 但它们的**色相是对的、彩度不够**：那些层的像素 max 多在 40~60，
   * 而判据要 `色差 > 18` ⇒ 需要彩度比 > 0.3~0.45。再往上追就追到色板本身：
   *
   *   诗云朝代色 彩度比 **0.40 ~ 0.78**（均值 ≈ 0.58，见它 `src/data/dynasties.ts`）
   *   我们学科色 彩度比 **0.24 ~ 0.51**（均值 ≈ 0.36）
   *
   * 我们那套是**柔和**的宝石色，诗云那套是**鲜艳**的 —— 差 1.6 倍。
   *
   * ## 怎么改的（关键，别用"统一饱和度"那套）
   *
   * `c' = Y + (c − Y) × 1.5`，`Y` 是亮度（0.2126 / 0.7152 / 0.0722 加权）。
   * 三通道同时减去同一个 `Y` 再加回去 ⇒ **luma 严格不变**
   * （`Σw·(c−Y)·K = K·(Σw·c − Y) = 0`），于是**色相、相对亮度、八团平权关系全部原样保留**，
   * 只有彩度变大（平均 0.360 → 0.495）。
   *
   * ⚠️ **试过"HSL 里把 S 统一提到 0.82、L 压到 0.6"，不行**：生成的是霓虹色，
   *    而且把八团的**相对亮度**毁了（luma 从 0.338 跨到 0.783，而作品明确要求"八团平权"），
   *    stat(262°) 与 qfin(249°) 两个紫还被推到一起。两种做法的对比见 `_scratch/regen-palette.mjs`。
   *
   * ⚠️ 只有两个色在放大后**触到通道上限**（physics 的红、math 的蓝），
   *    luma 各偏 1.2% / 0.3% —— 在"八团平权"的容差里。
   */
  readonly color: string;
  /** 光谱副色（色温梯度的外臂，让同团内部也有色彩层次）。**保持淡**，不参与上面那次提彩度。 */
  readonly color2: string;
  /** 星团在宇宙坐标里的位置 */
  readonly center: readonly [number, number, number];
  /** 星团半径（世界单位） */
  readonly radius: number;
  /** 星团朝向（欧拉角） */
  readonly tilt: readonly [number, number, number];
  /** 面向用户的一句话说明（面板里显示） */
  readonly blurb: string;
}

/**
 * 八个学科（**策展值**：下面是"一个星团该长什么样"的原始定义）。
 *
 * 归并原则：
 *   · 物理学：把 cond-mat / hep / gr-qc / nucl / quant-ph / astro-ph / nlin / math-ph 全部并入
 *     —— 它们在 arXiv 里本来就是"物理大类"的细分，用户不会认为"凝聚态"和"高能物理"是两个学科。
 *   · 数学与 math-ph 分家：math-ph 归物理（它的读者与物理学家重叠更多，这是策展判断）。
 *   · 计算机科学包含 cs.*；stat.ML 留在统计（它是方法论而非计算机系统）。
 *
 * ⚠️ 这里只写**相对关系**（谁在谁旁边、谁大谁小），**不写最终的世界坐标** ——
 *    整体的尺度由下面的 `LAYOUT_SCALE` 统一决定，见那段说明。
 */
const DOMAINS_CURATED: readonly DomainSpec[] = [
  {
    id: "physics",
    zh: "物理学",
    en: "Physics",
    prefixes: [
      "physics", "cond-mat", "hep-th", "hep-ph", "hep-ex", "hep-lat", "gr-qc",
      "nucl-th", "nucl-ex", "quant-ph", "astro-ph", "nlin", "math-ph",
    ],
    color: "#ffb350",
    color2: "#cfe0ff",
    center: [-11.5, 1.6, -2],
    radius: 4.6,
    tilt: [0.34, -0.5, 0.2],
    blurb: "从凝聚态到高能物理、从量子信息到天体物理 —— 论文量最大的一团。",
  },
  {
    id: "math",
    zh: "数学",
    en: "Mathematics",
    prefixes: ["math"],
    color: "#8cb9ff",
    color2: "#e6eeff",
    center: [7.2, -3.1, -4.8],
    radius: 3.5,
    tilt: [0.12, 0.75, -0.28],
    blurb: "纯数学与应用的全体：代数、几何、分析、概率、数值。",
  },
  {
    id: "cs",
    zh: "计算机科学",
    en: "Computer Science",
    prefixes: ["cs"],
    color: "#4cd3c1",
    color2: "#d8fff6",
    center: [1.8, 3.2, 9],
    radius: 4.2,
    tilt: [0.5, 0.22, 0.42],
    blurb: "机器学习、计算理论、系统与网络、图形学与视觉。",
  },
  {
    id: "bio",
    zh: "生物学与定量生物学",
    en: "Biology & Quantitative Biology",
    prefixes: ["q-bio"],
    color: "#71d274",
    color2: "#e2ffd8",
    center: [-6.4, -2.2, 5.6],
    radius: 3.0,
    tilt: [-0.28, -0.4, 0.18],
    blurb: "从分子到种群：定量生物学与计算生物学。",
  },
  {
    id: "eess",
    zh: "电子工程与系统科学",
    en: "Electrical Engineering & Systems Science",
    prefixes: ["eess"],
    color: "#e8b757",
    color2: "#fff0cc",
    center: [4.2, 4.6, -6.8],
    radius: 3.2,
    tilt: [0.62, -0.18, -0.36],
    blurb: "信号处理、图像与视频、系统与控制、音频与语音。",
  },
  {
    id: "stat",
    zh: "统计学",
    en: "Statistics",
    prefixes: ["stat"],
    color: "#bf9efa",
    color2: "#f0e6ff",
    center: [-3.2, -4.4, -7.4],
    radius: 2.6,
    tilt: [0.2, 0.5, 0.6],
    blurb: "统计方法论、机器学习理论、应用统计。",
  },
  {
    id: "econ",
    zh: "经济学",
    en: "Economics",
    prefixes: ["econ"],
    color: "#ee93ba",
    color2: "#ffe4ee",
    center: [8.6, 1.2, 3.4],
    radius: 2.4,
    tilt: [-0.44, 0.3, -0.2],
    blurb: "微观、宏观、计量与理论经济。",
  },
  {
    id: "qfin",
    zh: "金融工程",
    en: "Quantitative Finance",
    prefixes: ["q-fin"],
    color: "#a99df1",
    color2: "#e8e4ff",
    center: [-8.8, 3.4, 2.2],
    radius: 2.0,
    tilt: [0.36, -0.62, 0.5],
    blurb: "资产定价、风险管理、计算金融、交易与市场微结构。",
  },
] as const;

/**
 * 整体布局放大系数（中心距）；**星团半径另有 `RADIUS_BOOST`**。
 *
 * ## 关键的一条：等比放大会得到一模一样的画面
 *
 * 星团的**屏幕尺寸**正比于 `半径 / 中心距`。如果中心和半径乘同一个系数、
 * 同时把相机按同比例推远，投影出来的画面**完全相同**（相似变换）。
 * 所以"让画面更满"这件事**不可能靠等比放大解决** —— 我第一次就是把两者一起乘了 2.2，
 * 结果只是把镜头推进了星团内部：右上被一团占满、左上大片全黑。
 *
 * 真正决定"满不满"的是**半径相对中心距的比例**：比例越大，八团越大、彼此越靠、越重叠。
 * 所以这里拆成两个数：中心距乘 `LAYOUT_SCALE`，半径乘 `LAYOUT_SCALE × RADIUS_BOOST`。
 *
 * ## 作者的原话与取值
 *
 * 「一打开是八个亮光团，全然没有像宇宙的感觉，留白太多了；人家诗云一打开是充满整个屏幕的，
 *   这八个星团挨到了重合一点也没关系，有颜色区分」。
 *
 * 取 1.6 / 1.5 之后的账（世界单位）：
 *   · 八团中心分布在离原点约 18~21 的地方，整簇外接直径 ≈ 26×1.6 + 2×4.6×2.4 ≈ **64**；
 *   · 单个星团直径 ≈ 9.2×2.4 ≈ **22** —— 占整簇的三分之一，于是**八团明显互相重叠**；
 *   · 默认机位距离取 38.9（见 Galaxy.tsx 里 `<Canvas camera>` 的说明），
 *     视口横向覆盖 ≈ 1.687×38.9 ≈ **66** ⇒ 整簇刚好铺满并略微溢出。
 *
 * ## 连带影响（改这两个数之前先看这一条）
 *
 * `pipeline/build-edges.mjs` **import 本文件**来算丝线端点的坐标 ——
 * 改完**必须重跑它**，否则丝线会连到旧坐标上（看起来只是"线有点歪"，很难查）。
 */
const LAYOUT_SCALE = 1.6;

/**
 * 星团半径的额外放大（在 `LAYOUT_SCALE` 之上再乘）。
 *
 * **这才是"填满屏幕"的那一刀**（理由见上面那段）。
 *
 * ⚠️ 2026-10 从 1.5 提到 **2.3**：星团形态换成诗云的**指数半径**之后，
 * 点明显向中心收拢（新的中位半径约 0.52R，旧的有界幂律约 0.81R），
 * 于是画面上星团**反而变小了**（实测 nonBgPct 8.14 → 4.9）。
 * 2.3 是按中位半径补偿算出来的：0.81 / 0.52 ≈ 1.56，1.5 × 1.56 ≈ 2.3。
 * 指数分布天然"密核 + 长尾"，所以放大之后得到的是
 * **更大的体积 + 更亮的核 + 更长的星云尾巴**，而不是把原来那团等比放大。
 * 作者明确说过重叠没关系，靠颜色区分；而重叠带来的另一个好处是
 * 每团内部的星与星间距变大（点数不变、面积变大），**颗粒感也跟着变好**。
 */
const RADIUS_BOOST = 3.2;

/** 八个学科（已应用两个放大系数；界面与管线都用这一份）。 */
export const DOMAINS: readonly DomainSpec[] = DOMAINS_CURATED.map((d) => ({
  ...d,
  center: [d.center[0] * LAYOUT_SCALE, d.center[1] * LAYOUT_SCALE, d.center[2] * LAYOUT_SCALE] as const,
  radius: d.radius * LAYOUT_SCALE * RADIUS_BOOST,
}));

/** id → 定义（O(1) 查找，界面与管线共用）。 */
export const DOMAIN_BY_ID: ReadonlyMap<string, DomainSpec> = new Map(
  DOMAINS.map((d) => [d.id, d]),
);

/**
 * 按 arXiv 分类码判定学科。
 * 传入 primary category（如 "cs.LG"），返回学科 id；无法判定时返回 null。
 */
export function domainForCategory(cat: string): string | null {
  const c = (cat ?? "").toLowerCase();
  if (!c) return null;
  for (const d of DOMAINS) {
    for (const p of d.prefixes) {
      if (c === p || c.startsWith(p + ".") || c.startsWith(p + "-")) return d.id;
    }
  }
  return null;
}

/** 全部学科 id（顺序稳定，供状态与 UI 使用）。 */
export const DOMAIN_IDS: readonly string[] = DOMAINS.map((d) => d.id);
