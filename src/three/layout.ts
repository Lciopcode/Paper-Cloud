/**
 * 论文云 · 排列模式（三种）
 * ============================================================================
 * 用户的要求：「这东西不是中心轴不变的」—— 三种模式各自是**一套完整坐标**，
 * 切换时整片宇宙重新排列，而不是只挪动某一层。
 *
 * ## 一条不能破的不变量
 *
 * **位置由编号（更准确地说：由地址）唯一决定。**
 * 所以模式切换**不重新算编号**，只是把同一批点按另一套规则摆一遍：
 *   · 每个点都带着自己的 `addrLow`（地址的低 64 位）与 `docId`；
 *   · 模式函数是**纯函数**：同一个 (addrLow, docId, year) 永远得到同一个坐标。
 * 于是永久链接、按编号反查、层级归属全都不受影响 —— 变的只是"摆法"。
 *
 * ## 三种模式
 *
 * | 模式 | 摆法 | 依据 | 现状 |
 * |---|---|---|---|
 * | **领域**（默认） | 8 座独立旋涡星系 | 地址散射 | ✅ 已有 |
 * | **时间** | 一片盘状星系，一条对数旋臂从中心（最老）绕到边缘（最新） | 发表年份 | ✅ 本次 |
 * | **影响** | 半径 ∝ 影响力（引用→亮度、评级→大小之外的第三种通道） | 引用次数 | ⏳ 缺数据 |
 *
 * **影响模式为什么没做**：语料里 `cites` 字段**全库为 0，从未填充过**
 * （实测物理/CS/数学各抽 6 万篇，非零比例 0%）。没有数据就没有意义 ——
 * 用"发表去处等级"冒充影响力会给出一个看起来合理、实际错误的图景，
 * 所以这里**明确留空**，并把原因显示在界面上。
 */

/** 排列模式。 */
export type LayoutMode = "domain" | "time" | "impact";

export const LAYOUT_ZH: Readonly<Record<LayoutMode, string>> = {
  domain: "领域",
  time: "时间",
  impact: "影响",
};

/** 影响模式是否可用（引用数据到位后改成 true，并在这里实现半径映射）。 */
export const IMPACT_AVAILABLE = true;

/** 时间模式的年份范围（实测语料：1986–2026）。 */
export const YEAR_MIN = 1986;
export const YEAR_MAX = 2026;

/** 时间模式的盘半径范围（世界单位）。中心 = 最老，边缘 = 最新。 */
export const TIME_R0 = 1.6;
export const TIME_R1 = 6.4;
/** 旋臂缠绕圈数 */
const TIME_TURNS = 2.6;
/**
 * 每个学科的扇区宽度（弧度）。
 *
 * ⚠️ 取 **2π/8 = 0.785398**（正好把整圆分完）。
 * 曾经取 0.7 想留出"间隙便于区分学科"，结果画面上出现八道空白扇区，
 * 看起来像"盘被切成了八块"而不是一片星系 —— 实测就是这个观感。
 * 学科之间的界线靠**颜色本身**区分就够了，不需要留空。
 */
const SECTOR = (Math.PI * 2) / 8;
/**
 * 同一个分位内的角度抖动幅度（占扇区宽度的比例）。
 *
 * 取 0.95 让相邻学科在边界处**轻微交叠**：既保留"这是哪个领域"的可读性，
 * 又不会出现硬边（硬边看起来像拼贴，不像星系）。
 */
const JITTER_FRAC = 0.95;

/**
 * 论文量分位 → 年份的对照表。
 *
 * ## 为什么不能按"年份等宽"排（这是实测出来的）
 *
 * arXiv 的论文量随时间是**指数增长**的。实测物理团：
 *     1986 年 1 篇 · 1996 年 12,166 篇 · 2016 年 58,241 篇 · 2026 年 84,751 篇
 *     累计到 2016 年才过 50%
 * 若按年份等宽摆，全部论文会挤在外圈，中间是一大片空白 ——
 * 第一次实现就是这个结果，画出来是个"甜甜圈"，数据没错但读不出任何东西。
 *
 * ## 改成按论文量等分
 *
 * 排序后**每一篇占同样的半径增量**，于是盘面密度均匀、可读。
 * 而刻度环仍标真实年份 —— 环的**疏密本身就画出增长率**：
 * 1990 年代的环几乎贴在一起（那时论文少），2020 年代的环拉得很开。
 * 这比"等宽年份 + 空白中心"信息量大得多，也比只画一个均匀盘更有意义。
 *
 * 输入是 `manifest.domains[*].meta.yearCounts`（每一年一篇的直方图）。
 */
export interface YearScale {
  /** 年份 → 分位（0..1），即"早于这一年的论文占多少" */
  readonly percentileOfYear: number[];
  readonly yearMin: number;
  readonly total: number;
}

/** 由年份直方图建出"年份 → 分位"的对照表。 */
export function buildYearScale(yearMin: number, yearCounts: readonly number[]): YearScale {
  const total = yearCounts.reduce((a, b) => a + b, 0) || 1;
  const percentileOfYear: number[] = [];
  let cum = 0;
  for (const c of yearCounts) {
    // 用区间的**中点**作为该年的分位：整年的论文大致均匀落在这一年对应的区间里，
    // 用起点会让每年都偏早半格（在刻度环上看得出来）。
    percentileOfYear.push((cum + c / 2) / total);
    cum += c;
  }
  return { percentileOfYear, yearMin, total };
}

/** 取某年的分位（缺数据时退化到线性年份，保证不会崩）。 */
function percentileOf(scale: YearScale | null, year: number): number {
  if (!scale) {
    // 没有直方图（例如年份表还没到位）：退回线性年份，至少方向是对的
    return year >= YEAR_MIN ? Math.min(1, (year - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) : 0;
  }
  const i = year - scale.yearMin;
  if (i < 0) return 0;
  if (i >= scale.percentileOfYear.length) return 1;
  return scale.percentileOfYear[i];
}

/**
 * 时间模式：算一篇论文的坐标。
 *
 * 形态选择说明：**对数螺旋**（而不是"半径只跟分位成正比"）。
 * 因为纯径向的话同一分位的论文会挤在同一个圆周上，看起来像一圈薄环，
 * 既不好看也读不出"那一段有多少篇"。带缠绕之后：
 *   · 分位差在**半径**上连续变化（内老外新，一眼可读）；
 *   · 同一分位的论文沿螺旋散开（于是产出量表现为那一段弧的**密度**）；
 *   · 螺旋本身是星系最典型的形态，与整体视觉语言一致。
 *
 * @param addrLow 地址低 64 位（用于在同年内散布角度 —— 必须由地址决定，不能随机）
 * @param year    发表年份
 * @param sectorIdx 学科在扇区里的序号（0..7）
 * @param scale   年份分位对照表（null = 退化成线性年份）
 */
export function timePosition(
  addrLow: bigint,
  year: number,
  sectorIdx: number,
  scale: YearScale | null = null,
): [number, number, number] {
  // 分位归一化到 [0,1]。缺失年份（0）放在**最内圈**（当作"未知/最早"），
  // 不要丢到随机位置 —— 那样会让人以为那些点有确定年份。
  const t = year >= YEAR_MIN ? Math.min(1, percentileOf(scale, year)) : 0;
  const r = TIME_R0 + (TIME_R1 - TIME_R0) * t;

  // 同一分位内的散布：用地址低 64 位的低位做一个小抖动（∈ [0,1)）
  const jitter = Number(addrLow & 0xffffn) / 65536;
  // 角度 = 整体螺旋 + 学科扇区 + 扇区内抖动
  //
  // ⚠️ 螺旋项必须与扇区无关（写成 `t * TURNS * 2π + sector * SECTOR + …`），
  //    不能写成 `(t * TURNS + sector) * …` —— 后者会让每个学科各自绕自己的轴转，
  //    八个扇区在边界处错开，画面变成八条独立的螺旋带而不是一片盘。
  const theta = t * TIME_TURNS * Math.PI * 2 + sectorIdx * SECTOR + jitter * JITTER_FRAC * SECTOR;

  const x = Math.cos(theta) * r;
  const z = Math.sin(theta) * r;
  // 盘要薄但有厚度：厚度随半径略微增长（外圈更松散），并带一点上下起伏
  const h = ((Number((addrLow >> 16n) & 0xffn) / 256) * 2 - 1) * (0.06 + 0.16 * t) * r;
  return [x, h, z];
}

/** 年代刻度环：给定年份，返回它的半径（与 `timePosition` 用同一套映射）。 */
export function ringRadiusOf(year: number, scale: YearScale | null): number {
  const t = Math.min(1, percentileOf(scale, year));
  return TIME_R0 + (TIME_R1 - TIME_R0) * t;
}

/** 影响模式的半径范围。中心 = 最高被引，外缘 = 低被引。 */
export const IMPACT_R0 = 1.2;
export const IMPACT_R1 = 6.0;
/**
 * 「没有引用记录」的那批单独放**更外面的一圈薄带**。
 *
 * ⚠️ 这是诚实性设计，不是排版偏好。
 *    「数据没抓到」与「确实 0 引用」是两件完全不同的事。若把两者放在外缘同一条带上，
 *    用户会读成"这些论文都没人引用"—— 那是把**数据缺失伪装成结论**。
 *    单独一条带子 + 界面说明，才能让人看出「这一圈是未知，不是不重要」。
 */
const IMPACT_UNKNOWN_BAND = 0.9;

/**
 * 影响模式：按**被引次数**排布。
 *
 * 形态与时间模式刻意不同：时间是一片螺旋（时间是单向的），
 * 影响是一个**引力井** —— 越靠近中心被引越多。这是"影响力"最直观的空间隐喻。
 *
 * 半径映射用**对数**（通过 `bright` 间接实现）：引用次数是极重尾分布
 * （实测最高 19.6 万而中位数是 0），线性映射会让除极少数几篇之外全部挤在外缘 ——
 * 等于没有编码。`CiteTable.brightOf()` 已经做过 log1p 归一化，这里直接用它的结果。
 *
 * @param bright `CiteTable.brightOf()` 的结果（0.75 = 无记录，1.0 = 0 引用，2.6 = 高被引）
 * @param sectorIdx 学科扇区序号
 */
export function impactPosition(
  addrLow: bigint,
  bright: number,
  sectorIdx: number,
): [number, number, number] {
  const jitter = Number(addrLow & 0xffffn) / 65536;
  const angle = sectorIdx * SECTOR + jitter * JITTER_FRAC * SECTOR;

  let r: number;
  if (bright <= 0.751) {
    // 无记录：外面那一圈薄带。带内按地址散开，避免挤成一条线
    r = IMPACT_R1 + IMPACT_UNKNOWN_BAND * (0.35 + 0.65 * (Number((addrLow >> 20n) & 0xffn) / 256));
  } else {
    // 有记录：亮度越高越靠中心。bright ∈ [1.0, 2.6] → t ∈ [0, 1]
    const t = Math.min(1, Math.max(0, (bright - 1.0) / 1.6));
    r = IMPACT_R1 - (IMPACT_R1 - IMPACT_R0) * t;
    // 同一档内再加径向抖动，否则同档论文会挤在一个正圆上（看起来像一圈薄环）
    r += (jitter - 0.5) * 0.35;
  }

  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  const h = ((Number((addrLow >> 16n) & 0xffn) / 256) * 2 - 1) * (0.05 + 0.12 * r);
  return [x, h, z];
}
