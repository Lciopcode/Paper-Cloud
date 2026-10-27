/**
 * 论文云 · 点集构建
 * ============================================================================
 * 从编号脊柱（spine）构建可渲染的点集。
 *
 * 分层加载策略（关系到 305 万篇能不能在浏览器里跑）：
 *   · 首屏用 `spine.demo.bin`（每 N 篇取 1）→ 秒开、能看出是一座星系
 *   · 完整 `spine.bin` 在后台加载 → 加载完替换点集，密度提升
 *   两者**保留相同 docId**，所以"点开论文""编号反查"在两种状态下完全一致。
 *
 * 为什么位置从地址算而不是 docId：见 `geometry.ts` 顶部注释。
 */
import {
  domainTint,
  GALAXY_SHAPE,
  hexRgb,
  pointColor,
  sampleAddress,
  vnoise,
  type ClusterLayout,
} from "./geometry";
import type { PaperPoints } from "../data/contract";
import type { Spine } from "../data/assets";

/**
 * 单次构建的点数**默认**上限。
 *
 * ⚠️ 这个上限必须对用户**可见**，否则会造成"按钮名在说谎"：
 *    第一版"载入全部"按钮调 `loadFull()`，而 `loadFull` 用默认上限构建 ——
 *    物理团 146 万篇只画了 **112,584 点**，按钮却写着"载入全部"。
 *    实测发现的方式是性能自检里打印 `points.count`（112,584 ≠ 1,463,588）。
 *
 * 现在的约定：
 *   · 演示路径（每 50 篇取 1 篇）远低于上限，不受影响；
 *   · 完整路径由调用方**显式**指定上限（见 `loadFull` 传 `Infinity`）；
 *   · `PaperPoints.truncated` 记录是否被截断，界面据此如实显示
 *     "当前 N 点 / 共 M 篇"，而不是让人以为画的就是全部。
 *
 * 为什么可以放到很大：全部论文是**一个 `THREE.Points` 对象、一次 draw call**，
 * 点精灵在顶点着色器里算尺寸 —— 这正是用 Points 而不是 N 个 Mesh 的意义。
 * 146 万个顶点的属性缓冲约 (3+1+3+1+1+1)×4×146万 ≈ 58 MB，完全在正常范围。
 */
export const MAX_POINTS = 420_000;

/** 从 64 位散列取 [0,1)。 */
function unit(h: bigint): number {
  return Number(h & ((1n << 53n) - 1n)) / Number(1n << 53n);
}

/** 由地址的低位推出一个稳定的散列（用于尺寸抖动与 HII 判定）。 */
function hashLow(addr: bigint): bigint {
  const M = (1n << 64n) - 1n;
  let x = (addr & M) ^ ((addr >> 64n) & M) ^ ((addr >> 128n) & M) ^ ((addr >> 192n) & M);
  x = (x + 0x9e3779b97f4a7c15n) & M;
  let z = x;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
  return (z ^ (z >> 31n)) & M;
}

export interface BuildOptions {
  /** 学科 id（仅用于标记点集来源） */
  domain: string;
  domainColor: string;
  color2: string;
  layout: ClusterLayout;
  /**
   * 影响力字节：venue 等级(高 4 位) + 引用等级(低 4 位)。
   * 未接引用数据时传 undefined ⇒ 全部按 0 级处理（只是偏暗偏小，不影响可见与可点）。
   */
  impactOf?: (docId: number) => number;
}

/**
 * 构建点集。
 *
 * @param spine 编号脊柱（含地址与编号）
 * @param opts  学科颜色与布局
 * @param step  抽样步长（1 = 全部；>1 用于在点数超上限时降密度）
 */
export function buildPoints(
  spine: Spine,
  opts: BuildOptions,
  step = 1,
  /**
   * 点数上限。默认用 `MAX_POINTS`；**完整加载路径应当显式传更大的值**
   * （见 points.ts 顶部关于"按钮名在说谎"的说明）。
   */
  maxPoints = MAX_POINTS,
): PaperPoints {
  // ⚠️ 必须用 `recordCount()`（**本文件实际含多少条记录**），不能用 `count`（真实论文总数）。
  //    演示脊柱每 50 篇只有 1 条记录；若拿 count 当循环上界，
  //    第一次迭代后 `spine.get(50)` 就越界返回 null，
  //    于是**每个星团只画出 1 个点**（实测就是这个现象：8 团各 1 点，画面几乎全黑）。
  const records = spine.recordCount();
  // 记录层面的步长：按上限压缩时取 stride 的整数倍，保证落到的都是真实存在的记录
  const recStep = Math.max(1, Math.ceil(records / Math.max(1, maxPoints) / step) * step);
  const count = Math.ceil(records / recStep);

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const docIds = new Uint32Array(count);
  const addrLow = new BigUint64Array(count);
  /** 学科染色目标（逐顶点）—— 供着色器的 uTint 决定"染多浓"，见 geometry.ts 的 domainTint */
  const tints = new Float32Array(count * 3);

  const dom = hexRgb(opts.domainColor);
  const dom2 = hexRgb(opts.color2);
  const layout = opts.layout;

  let n = 0;
  // 遍历**记录下标**，再换算回 docId（演示脊柱里 docId = rec · stride）
  for (let rec = 0; rec < records && n < count; rec += recStep) {
    const docId = rec * spine.stride;
    const record = spine.get(docId);
    if (!record) continue;
    const s = sampleAddress(record.addr, layout);
    positions[n * 3] = s.pos[0];
    positions[n * 3 + 1] = s.pos[1];
    positions[n * 3 + 2] = s.pos[2];

    // 影响力：引用 → 亮度，venue → 大小
    const imp = opts.impactOf ? opts.impactOf(docId) : 0;
    const citeTier = imp & 0xf;
    const venueTier = (imp >> 4) & 0xf;

    const h = hashLow(record.addr);
    /** 个体差异（0~1）：诗云用 rnd()，我们用地址散列 —— 同一颗星每次都一样 */
    const jitter01 = unit(h);

    /**
     * 亮度（**配方照搬诗云**，见它的 `Galaxy.tsx` 里 `bright` 的算法）。
     *
     * 诗云盘粒子：
     *   `bright = (armBoost + cb·0.4) · (0.45 + cb·0.25 + nz·0.8) · (0.8 + rnd·0.4)`
     * 其中 `nz` 是值噪声（成团）、`cb` 是核心混合。三个因子的作用各不相同：
     *   · `armBoost` —— 贴臂的更亮（臂是年轻恒星聚集的地方）；
     *   · `nz·0.8`   —— **密度不均匀**：同样在臂上，团块处亮、空隙处暗。
     *                   没有这一项，画出来是"干净的数学螺旋"，一眼假；
     *   · `cb·0.4`   —— 核心整体抬亮，保证中心是亮核而不是一个黑洞。
     *
     * 我们额外乘上引用/venue 的等级 —— 那是这个作品的语义（论文级别 → 亮度/尺寸），
     * 参考实现没有这一层，但它加在同一个乘积里，不改变形态。
     */
    const cb = s.coreBlend;
    const armBoost = 0.34 + s.armProx * 0.75;
    const noise = 0.45 + cb * 0.25 + s.clump * 0.8;
    const sizeJitter = 0.8 + jitter01 * 0.4;
    const coreBoost = 1 + 1.6 * Math.pow(Math.max(0, 1 - s.t / 0.45), 1.6);
    const citeBoost = 1 + citeTier * 0.2;
    const bright = 0.4 * (armBoost + cb * 0.4) * noise * sizeJitter * coreBoost * citeBoost;

    const c = pointColor(s.t, s.armProx, dom, dom2, s.hii);
    colors[n * 3] = Math.min(1.4, c.r * bright);
    colors[n * 3 + 1] = Math.min(1.4, c.g * bright);
    colors[n * 3 + 2] = Math.min(1.4, c.b * bright);
    const tn = domainTint(dom, dom2);
    tints[n * 3] = tn.r;
    tints[n * 3 + 1] = tn.g;
    tints[n * 3 + 2] = tn.b;

    /**
     * 尺寸（**配方照搬诗云**的"论文星点"那一档）。
     *
     * 诗云盘上的星：`(0.7 + armProx·0.8 + hii·0.8) · (0.7 + rnd·0.6)`
     * —— 贴臂更大、HII 结更大、每颗再乘 0.7~1.3 的个体差异。
     * 我们再把 venue 等级乘进去（顶刊顶会读起来是"大星"）。
     *
     * ⚠️ 下限由着色器的 `clamp(..., 0.6, uMaxSize)` 保证：
     *    **再小也不会小到看不见**（作者原话："再小也不能压根不显示，得有亮度吧？"）。
     */
    const venueBoost = 1 + venueTier * 0.22;
    const base = 0.7 + s.armProx * 0.8 + (s.hii ? 0.8 : 0);
    sizes[n] = base * (0.7 + jitter01 * 0.6) * venueBoost;
    seeds[n] = unit(hashLow(record.addr ^ 0x5bf03635n));
    docIds[n] = docId;
    addrLow[n] = BigInt.asUintN(64, record.addr);
    n++;
  }

  return {
    // 是否因为这轮的点数上限而抽样了。界面据此如实显示「当前 N 点 / 共 M 篇」。
    truncated: count < records / step,
    domain: opts.domain,
    count: n,
    /** 该学科**真实论文总数**（count 只是本次抽样的点数） */
    total: spine.count,
    positions: positions.subarray(0, n * 3),
    sizes: sizes.subarray(0, n),
    colors: colors.subarray(0, n * 3),
    seeds: seeds.subarray(0, n),
    docIds: docIds.subarray(0, n),
    addrLow: addrLow.subarray(0, n),
    tints: tints.subarray(0, n * 3),
  };
}

/**
 * 星云层。**拆成两个独立的群落**，因为诗云就是这么做的（它的 DUST 与 BULGE）。
 *
 * ## ⚠️ 为什么必须拆开，不能"按 t 二选一"
 *
 * 第一版把两种处理写成"t < CORE_CAP 走核球、否则走尘埃"，结果画面上
 * **核心外面出现了一圈明显的暗环**：那是一道**分区** ——
 * 半径 0.42R 两侧的亮度公式不同，密度连续、亮度却有台阶。
 *
 * 诗云是**两个群落各自独立采样、直接叠加**：
 *   · DUST 铺满整个盘（包括中心）—— 中心也有尘埃；
 *   · BULGE 只落在核心（expR(R*0.10, R*0.42)），**额外叠在尘埃之上**。
 * 于是中心 = 尘埃 + 核球（最亮），往外 = 只剩尘埃（平滑过渡），**没有台阶**。
 */
export interface NebulaLayer {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly sizes: Float32Array;
  /** 逐顶点的学科染色目标（`count × 3`）—— 与 `PaperPoints.tints` 同一套，见那里的说明 */
  readonly tints: Float32Array;
  readonly count: number;
}

/** 内部：按地址序列取一批雾粒子，kind 决定用哪一套亮度/尺寸配方。 */
function nebulaPass(
  seedBase: bigint,
  count: number,
  layout: ClusterLayout,
  domainColor: string,
  kind: "dust" | "bulge",
): NebulaLayer {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  /** 学科染色目标（逐顶点），与 buildPoints 同一套 —— 见 geometry.ts 的 domainTint */
  const tints = new Float32Array(count * 3);
  const dom = hexRgb(domainColor);
  const M = (1n << 64n) - 1n;
  const R = layout.radius;
  const NF = 4.2 / R;
  let n = 0;
  const isBulge = kind === "bulge";
  for (let i = 0; i < count; i++) {
    const h = hashLow((seedBase + BigInt(i) * 0x9e3779b97f4a7c15n) & M);
    // 核球层直接按核心半径分布采样（coreOnly），不再"从整盘里筛" —— 省 4 倍取样
    const s = sampleAddress(h, layout, isBulge);

    positions[n * 3] = s.pos[0] * NEB_EXTENT;
    // 雾比星点厚一点，才有"体积"
    positions[n * 3 + 1] = s.pos[1] * 1.6 * NEB_EXTENT;
    positions[n * 3 + 2] = s.pos[2] * NEB_EXTENT;
    const c = pointColor(s.t, s.armProx, dom, dom, false);
    // 值噪声：核球那边频率更高（诗云 nz 用 x·NF·1.6 采样）
    const nz = vnoise(s.pos[0] * NF * (kind === "bulge" ? 1.6 : 1), s.pos[2] * NF * (kind === "bulge" ? 1.6 : 1));

    let bright: number;
    let size: number;
    if (kind === "bulge") {
      // 诗云核球：亮 = (0.80 - t·0.75)·(0.55+rnd·0.5)·(0.7+nz·0.75)
      const t = s.t;
      bright = (0.8 - t * 0.75) * (0.55 + s.clump * 0.5) * (0.7 + nz * 0.75);
      // 尺寸 = (1.5 + (0.3-t)·2.6)·(0.7+rnd·0.7) —— 更大更软，糊成连续核球
      size = (1.5 + (0.3 - t) * 2.6) * (0.7 + s.clump * 0.7);
    } else {
      // 诗云尘埃：亮 = (0.34 + armProx·0.75 + cb·0.4)·(0.45 + cb·0.25 + nz·0.8)·(0.8+rnd·0.4)
      const cb = s.coreBlend;
      bright = (0.34 + s.armProx * 0.75 + cb * 0.4) * (0.45 + cb * 0.25 + nz * 0.8) * (0.8 + s.clump * 0.4);
      /**
       * **盘的面亮度补偿**（我们自己的修正，诗云没有这一步）。
       *
       * ## 为什么必须有
       *
       * 粒子半径走指数分布（`expR`，中位半径约 0.52R）⇒ **单位面积的粒子数随半径掉得很快**，
       * 而单颗亮度不含半径因子，于是画面上的**面亮度**跟着一起塌。
       * 单团特写实测（`imgstat --arms` 的径向剖面）：r=8 → 204、r=44 → 78、r=98 → **45**，
       * 90 像素内掉到 1/4.5 —— 读起来是"一个亮核 + 一圈很快变暗的雾"，不是一个盘。
       * 真实星系的面亮度确实随半径下降，但远没有这么陡。
       *
       * ## ⚠️ 必须按**最终半径**算，不能按 `t` 算
       *
       * 位置在下面乘过 `NEB_EXTENT`，所以 `t` 与"它离团心几个 R"**不是一回事**：
       *   最终半径 = `t × NEB_EXTENT`（以 R 为单位）。
       * 第一版按 `t` 补偿，而 `NEB_EXTENT = 2.05` ⇒ 被抬亮的是 t≈0.5 那一圈，也就是 **1.0R 处** ——
       * 恰好是盘的**外面**。实测症状很典型：r=44..134（盘的可见部分）几乎没变，
       * 而 r=152..260（团与团之间的雾）整段抬高了 —— **改错了地方**。
       *
       * 现在按最终半径分段：盘内（<1R）线性抬到 2.0×，盘缘外缓降，
       * 保证"抬起来的是盘、不是团之间的雾"。
       */
      const tr = s.t * NEB_EXTENT;
      bright *= tr < 1 ? 0.55 + 1.15 * tr : Math.max(0.7, 1.7 - (tr - 1) * 1.2);
      // 尺寸 = (0.5 + (1-t)·0.8)·(0.7+rnd·0.5) —— 内圈稍大，把中心填满
      size = (0.5 + (1 - s.t) * 0.8) * (0.7 + s.clump * 0.5);
    }

    const dim = bright * DUST_BRIGHT;
    /**
     * 雾的颜色：**保留色相**，只做一点偏冷处理。
     *
     * ⚠️ 旧版把 RGB 三个通道都写成蓝色通道（`c.b, (c.g+c.b)/2, c.b*1.08`）——
     * 那等于**把雾强制去色**，实测 coloredPct 掉到 0.9（整幅几乎只剩白灰）。
     * 诗云的雾是带颜色的（暖核 → 蓝白臂），所以这里按原色相输出，
     * 蓝通道只抬 6% 作"星际尘埃偏冷"的暗示。
     */
    colors[n * 3] = c.r * dim;
    colors[n * 3 + 1] = c.g * dim;
    colors[n * 3 + 2] = c.b * 1.06 * dim;
    const tn = domainTint(dom, dom);
    tints[n * 3] = tn.r;
    tints[n * 3 + 1] = tn.g;
    tints[n * 3 + 2] = tn.b;
    sizes[n] = size;
    n++;
  }
  return {
    positions: positions.subarray(0, n * 3),
    colors: colors.subarray(0, n * 3),
    sizes: sizes.subarray(0, n),
    tints: tints.subarray(0, n * 3),
    count: n,
  };
}

/** 盘上的暗雾（诗云 DUST）：铺满整个盘，包括中心。 */
export function buildDust(seedBase: bigint, count: number, layout: ClusterLayout, domainColor: string): NebulaLayer {
  return nebulaPass(seedBase, count, layout, domainColor, "dust");
}

/** 核心密云（诗云 BULGE）：只落在核心，**叠在尘埃之上**，更大更软，糊成连续核球。 */
export function buildBulge(seedBase: bigint, count: number, layout: ClusterLayout, domainColor: string): NebulaLayer {
  return nebulaPass(seedBase, count, layout, domainColor, "bulge");
}

/** 把两层拼成一层（位置/颜色/尺寸各自首尾相接）。 */
export function mergeNebula(a: NebulaLayer, b: NebulaLayer): NebulaLayer {
  const cat = (x: Float32Array, y: Float32Array) => {
    const out = new Float32Array(x.length + y.length);
    out.set(x, 0);
    out.set(y, x.length);
    return out;
  };
  return {
    positions: cat(a.positions, b.positions),
    colors: cat(a.colors, b.colors),
    sizes: cat(a.sizes, b.sizes),
    tints: cat(a.tints, b.tints),
    count: a.count + b.count,
  };
}

/**
 * 雾的总体亮度倍率。
 *
 * 诗云的尘埃与核球用的是**同一套公式**但粒子数极多（12 万 + 6.4 万），
 * 所以单颗可以很暗。我们按比例给了粒子数之后也用同一个量级 ——
 * 这个数改大一点整片发白、改小一点看不见雾，量的时候看 `probeGL` 的 `nonBgPct`。
 */
const DUST_BRIGHT = 0.26;

/**
 * 星云雾的**外扩系数**（在 `sampleAddress` 给出的盘坐标之上再乘）。
 *
 * ## 为什么是"把每团的雾摊大"，而不是"加一层均匀的虚空雾"
 *
 * 作者要的是「像诗云那样充满整个屏幕」。第一版的做法是往八团之间**均匀**撒一层尘埃，
 * 结果是**一屏灰金色噪点板**（截图上八团与虚空之间没有明暗差，远看像电视雪花）。
 * 原因是几何的：均匀体积填充必然在屏幕上均匀成一张平底，**结构被抹掉**。
 *
 * 而诗云那屏之所以"满"又不糊，是因为它是**细亮线**（几千条赠诗弧，见 Galaxy.tsx 里的归因记录）——
 * **高空间频率、暗底**。线我们不能抄（作者要求默认不显示关系线），
 * 但"高空间频率 + 暗底"这条可以：把每团的雾**摊大**（半径 ×NEB_EXTENT），
 * 于是八团的雾彼此重叠、连成一片有明暗起伏的暖色场，而**虚空里仍然是暗的**。
 *
 * ⚠️ 只乘雾，**不乘星点** —— 星点的位置是"由编号算出"的那套坐标，
 *    动了它就要重跑 `pipeline/build-edges.mjs`（丝线端点跟着走）。
 *    雾是纯装饰层，摊大它不影响任何契约。
 */
const NEB_EXTENT = 1.3;

/**
 * 在点集的 `docIds` 里二分查找一个 docId，返回顶点下标（找不到返回 -1）。
 *
 * ## 为什么可以二分
 *
 * `buildPoints` 是按**记录下标递增**遍历的（`for (rec += recStep)`），
 * 而 `docId = rec * spine.stride`，所以 `docIds` 天然**严格递增**。
 * 这一点必须守住：哪一天构建循环改成乱序（比如为了"打散绘制顺序"），
 * 这个函数就会静默地给出错误答案 —— 所以它有一条专门测"乱序输入必须答错/不崩"的用例，
 * 而不是只测"能查到"。
 *
 * ## 为什么需要它
 *
 * 拾取是反过来的：鼠标点中一个顶点，`three` 给出 `index`，我们查 `docIds[index]` 得到论文。
 * 而"选中了一篇论文 → 它在屏幕上的哪个点"是**正着查**，原来只能 `indexOf` 线性扫 ——
 * 146 万点的点集每次都扫一遍是 6 ms 量级，而这件事在选中的瞬间就要用。
 */
export function docIndex(docIds: Uint32Array, docId: number): number {
  let lo = 0;
  let hi = docIds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = docIds[mid];
    if (v === docId) return mid;
    if (v < docId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** 星团半径的参考值（供 UI 提示尺寸）。 */
export const SHAPE = GALAXY_SHAPE;
