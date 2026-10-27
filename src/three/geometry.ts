/**
 * 论文云 · 几何层
 * ============================================================================
 * 把"编号地址"变成"星团里的一点"，并算出它的颜色与尺寸。
 *
 * 职责边界（**这里不做别的事**）：
 *   · 本模块是**纯函数 + 纯数学**：不读文件、不碰 three（只借它的类型），不认状态。
 *   · 输入：地址（bigint）+ 星团布局；输出：局部坐标、颜色、尺寸依据。
 *   · 因此它可以被单元测试穷举验证（"盘是扁的""分布是幂律""确定性"）。
 *
 * ## ⚠️ 2026-10 大改：形态配方**照搬诗云**（`src/three/Galaxy.tsx` @771591f）
 *
 * 作者的原话：「让你扩大体积，是把整个星团体积变大，一进来还是怎么小，
 * 谁家宇宙星团是标准的圆圆外一点东西没有，圆内星星超密集分布？」
 *
 * 旧版的问题是**有界**：`DISK_EDGE = 1.05` 意味着最远的点就在 1.05R，
 * 外面**一点东西都没有** —— 画出来就是一个硬边圆饼，圆内密、圆外空。
 *
 * 诗云的解法是**指数半径**（`expR(h, cap) = min(cap, -h·ln(1-u))`）：
 *   · 核球：`h = R×0.10`、`cap = R×0.42` —— 陡，密核；
 *   · 盘：  `h = R×0.27`、`cap = R`     —— 缓，向外指数稀疏。
 * 于是**密度从中心向外指数衰减**，边缘自然淡出、没有硬边，
 * 而且"圆外还有东西"（稀疏的晕）—— 这才是星团的样子。
 *
 * 另外三处也是照搬的，它们共同解决"中心是个亮十字 / 四臂之间有黑楔子"：
 *   · **核心角度完全打散**（`cb`）：`t < 0.45` 处角度随机化，核心填成一个圆盘；
 *   · **面内核心填充**：核心附近额外铺开 ±`0.07R`，不让四臂在中心交汇成十字；
 *   · **臂内散布**（`scatter = pow(rnd, 2.6)·±1·0.16·r`）：臂有厚度与颗粒感。
 *
 * 还有**值噪声成团**（`vnoise`）：让密度不均匀，读起来是"真实的星云"而不是
 * "干净的数学螺旋"。它与 `points.ts` 的亮度一起用（见那边的说明）。
 *
 * ## 关于"确定性"这条不变量（**没有破**）
 *
 * 诗云用 `mulberry32` 伪随机数发生器；我们**不能**用 PRNG ——
 * "位置由编号算出、不存储"是这个作品的根，刷新一次星就不能动。
 * 所以每一处 `rnd()` 都换成**从地址的不同盐取出的均匀数**（`unitFromAddress`），
 * 语义完全对应：诗云的 `rnd()` 调用顺序 = 我们的盐序号。
 * 位置仍然是地址的纯函数。
 */

/** 星团布局（与 `src/data/domains.ts` 的策展值对应）。 */
export interface ClusterLayout {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly tilt: readonly [number, number, number];
}

/**
 * 星系形态参数。
 *
 * ⚠️ 这组数**照搬诗云的 `galaxyParams.ts` + `Galaxy.tsx`**，只把它的世界单位
 * （`RADIUS = 3600`）换成我们的**相对比例**（半径 = 1）。改任何一个之前先看
 * 上面那段"为什么改"，它们是配平过的。
 */
export const GALAXY_SHAPE = {
  /** 旋臂数（诗云 `BRANCHES`） */
  BRANCHES: 4,
  /** 从中心到边缘缠绕的弧度（诗云 `TWIST = 5.2`） */
  TWIST: 5.2,
  /** 臂的高斯角宽（诗云 `ARM_SPREAD = 0.42`） */
  ARM_SPREAD: 0.42,
  /** 盘厚：|y| / r（诗云 `THICKNESS = 0.11`） */
  THICKNESS: 0.11,

  /** 核球成分占的分位比例（诗云核球粒子占 34%，我们按"论文"取 25% 让盘更铺得开） */
  BULGE_FRAC: 0.25,
  /**
   * 核球半径上限（× R）。诗云：`expR(R*0.10, R*0.42)`。
   *
   * 盘**从核球的上限接续**（不是从 0 重新开始）：否则半径函数在交界处不单调，
   * "从半径反推分位"不再是双射 —— 旧版为此专门写过一段说明，那个约束仍然有效。
   */
  CORE_CAP: 0.42,
  /** 核球的指数陡度 = cap/h = 0.42/0.10（诗云） */
  CORE_K: 4.2,
  /** 盘的指数陡度 = cap/h = 1.00/0.27（诗云） */
  DISK_K: 3.7,
  /** 盘的外缘（× R）。诗云的 cap 就是 R —— 密度指数衰减，边缘自然淡出，没有硬边 */
  DISK_EDGE: 1.0,

  /** 核心混合的截止高度：t 超过它之后"核心处理"完全消失（诗云 0.45） */
  CORE_FILL: 0.45,
  /** 面内核心填充幅度（× R，诗云 `coreFill = cb²·R·0.07`） */
  CORE_FILL_R: 0.07,
  /** 核心抖动幅度（× R，诗云核球 `R*0.05` 面内 + `R*0.03` 竖向） */
  CORE_JITTER: 0.05,
  CORE_JITTER_Y: 0.03,
  /** 臂内散布幅度（诗云 `scatter(0.16)`） */
  ARM_SCATTER: 0.16,
  /** 盘的竖向缩放（诗云盘粒子 `THICKNESS × 1.1`；论文星点用 0.8，见 STAR_Y_SCALE） */
  DISK_Y_SCALE: 0.8,
} as const;


// ---------------------------------------------------------------- 从地址取均匀随机数
const MASK64 = (1n << 64n) - 1n;

/** splitmix64：把 64 位搅成 64 位。确定性、雪崩好、零依赖。 */
function mix64(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/**
 * 从地址 + 盐取一个 [0,1) 的均匀随机数。
 *
 * 为什么不用 `Number(addr & mask) / 2^53`：地址是 243 位，
 * 只取低 64 位再取低 53 位**会丢掉高位信息**，导致地址相近的论文位置也相近
 * （而地址相近恰恰是"标题相近"的情形，于是词义相近的论文会挤在一起 —— 反而不像星海）。
 * 这里先把高位折进低位再搅，让 243 位都参与。
 */
function unitFromAddress(addr: bigint, salt: bigint): number {
  const folded = (addr & MASK64) ^ ((addr >> 64n) & MASK64) ^ ((addr >> 128n) & MASK64) ^ ((addr >> 192n) & MASK64);
  const h = mix64(folded ^ (salt * 0x100000001b3n));
  return Number(h & ((1n << 53n) - 1n)) / Number(1n << 53n);
}

// ---------------------------------------------------------------- 半径分布
/**
 * 截断指数分布的**分位函数**：`q(0)=0`、`q(1)=1`、严格单调。
 *
 * 诗云的做法是"取一个指数分布随机数再钳到 cap"：
 * `min(cap, -h·ln(1-u))`。直接照搬到**分位**上会出问题：
 * 钳位会把所有超过 cap 的样本**堆在 cap 上**，形成一个密度奇点（画出来是一圈亮环），
 * 而且半径函数在尾部变成常函数 —— 破坏"半径 ⇄ 分位"的双射。
 *
 * 这里改成**截断指数分布的分位函数**，形式等价、但没有堆叠：
 *   `q(v) = -ln(1 - v·(1-e^-k)) / k`，其中 `k = cap/h`。
 * 代入 v=1 得 `q=1`（正好落在 cap 上，不越界也不堆叠）。
 *
 * k 的取值就是诗云的 `cap/h`：核球 `0.42/0.10 = 4.2`，盘 `1.00/0.27 ≈ 3.7`。
 */
export function expQuantile(v: number, k: number): number {
  const tail = 1 - Math.exp(-k);
  const x = Math.min(0.999999, Math.max(0, v));
  return -Math.log(1 - x * tail) / k;
}

/**
 * 双成分**指数**半径分布（核球 + 盘），照搬诗云的 `expR`。
 *
 * 两段在 `u = BULGE_FRAC` 处**严格接续**（核球的上限 = 盘的起点），
 * 所以半径函数在整个 [0,1] 上单调、连续、无跳变 ——
 * "从半径反推分位"仍然是双射（这是旧版花过力气守住的性质，不能丢）。
 */
export function radiusFor(u: number, R: number): number {
  const S = GALAXY_SHAPE;
  if (u < S.BULGE_FRAC) {
    const v = Math.min(1, Math.max(0, u / S.BULGE_FRAC));
    return R * S.CORE_CAP * expQuantile(v, S.CORE_K);
  }
  const v = Math.min(1, Math.max(0, (u - S.BULGE_FRAC) / (1 - S.BULGE_FRAC)));
  return R * (S.CORE_CAP + (S.DISK_EDGE - S.CORE_CAP) * expQuantile(v, S.DISK_K));
}

// ---------------------------------------------------------------- 值噪声
/**
 * 二维格点上的廉价平滑值噪声（照搬诗云的 `vnoise`）。
 *
 * 用途：给密度加**不均匀**。没有它，指数半径 + 对数螺旋画出来是"干净的数学螺旋"，
 * 一眼就是程序生成的；有了它，臂上会有团块与空隙，读起来才像真实星云。
 *
 * 它是**纯函数**（只依赖坐标），所以不破坏确定性。
 */
export function vnoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const h = (a: number, b: number) => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const n00 = h(xi, zi);
  const n10 = h(xi + 1, zi);
  const n01 = h(xi, zi + 1);
  const n11 = h(xi + 1, zi + 1);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

// ---------------------------------------------------------------- 主函数
/** 一点在星团**局部坐标系**里的位置、颜色与尺寸依据。 */
export interface PointSample {
  /** 局部坐标 */
  readonly pos: [number, number, number];
  /** 到中心的半径（世界单位） */
  readonly r: number;
  /** 归一化半径 [0,1] */
  readonly t: number;
  /** 贴臂程度 [0,1]：1 = 正在旋臂中心线上 */
  readonly armProx: number;
  /** 该点是否是 HII 结（亮粉色年轻星团） */
  readonly hii: boolean;
  /**
   * 值噪声给出的局部密度（0~1）。诗云用它调制亮度：
   * 密度高的地方更亮 —— 于是"成团"这件事在**亮度**上也读得出来，不只是位置。
   */
  readonly clump: number;
  /** 核心混合：1 = 完全在核心处理区，0 = 完全在盘上（诗云的 `cb`） */
  readonly coreBlend: number;
}

/**
 * 地址 → 星团局部坐标。
 *
 * 骨架照搬诗云的 Galaxy Generator：指数半径 + 对数缠绕旋臂 + 高斯臂宽 +
 * 核心角度打散 + 面内核心填充 + 臂内散布。位置来源不同（它用 PRNG，我们用地址），
 * 但**每个自由度的语义一一对应**：`rnd()` 的调用顺序 = 盐的序号。
 */
export function sampleAddress(addr: bigint, layout: ClusterLayout, coreOnly = false): PointSample {
  const R = layout.radius;
  const S = GALAXY_SHAPE;

  // 与诗云 rnd() 调用顺序对应的自由度
  /**
   * 半径分位。
   *
   * `coreOnly` 把分位压进核心区（`u < BULGE_FRAC`）—— 核球那一层用得上。
   * 为什么需要它：核球层若"从整盘里筛出核心的那 25%"，取样次数要翻 4 倍，
   * 而每次取样要算 13 次 BigInt 散列 —— 八个团加起来是几百万次，直接拖慢首屏。
   * 它只是把同一个分位重新映射，**分布形状不变、确定性不变**。
   */
  const uRaw = unitFromAddress(addr, 0x01n);
  const u = coreOnly ? uRaw * GALAXY_SHAPE.BULGE_FRAC : uRaw;
  const brU = unitFromAddress(addr, 0x02n); // 臂号
  const zq = unitFromAddress(addr, 0x03n); // 臂偏移（两次构成近似高斯）
  const zq2 = unitFromAddress(addr, 0x04n);
  const hU = unitFromAddress(addr, 0x05n); // 竖向
  const jU = unitFromAddress(addr, 0x06n); // 核心抖动
  const hiiU = unitFromAddress(addr, 0x07n); // HII 判定
  const fU = unitFromAddress(addr, 0x08n); // 核心角度打散
  const fU2 = unitFromAddress(addr, 0x09n); // 面内核心填充（x）
  const fU3 = unitFromAddress(addr, 0x0an); // 面内核心填充（z）
  const sU = unitFromAddress(addr, 0x0bn); // 臂内散布幅度
  const sSign = unitFromAddress(addr, 0x0cn); // 臂内散布方向

  const r = radiusFor(u, R);
  const t = r / R;

  // 近似高斯：两个均匀分布之和（Irwin–Hall n=2），再中心化到 [-1,1]
  const g = (zq + zq2 - 1) * 1.5;

  /**
   * 核心混合（诗云的 `cb`）：`t ≥ CORE_FILL` 之后为 0。
   *
   * 它同时控制三件事，缺一不可：
   *   ① 角度完全打散 —— 否则四臂在中心交汇成一个亮十字，臂间还有暗楔子；
   *   ② 面内额外铺开 —— 把中心填成一个圆盘而不是一个点；
   *   ③ 竖向抖动 —— 核心有厚度，不是一张纸。
   */
  const coreBlend = Math.max(0, S.CORE_FILL - t) / S.CORE_FILL;
  const cb2 = coreBlend * coreBlend;

  // 臂号：**必须由"最终角度"四舍五入决定**，正演与反解才严格对称
  const step = (Math.PI * 2) / S.BRANCHES;
  const base = brU * Math.PI * 2 + t * S.TWIST;
  const arm = Math.round(base / step) * step;
  const spread = S.ARM_SPREAD * (1 + t * 0.9);
  let ang = arm + g * spread;
  // ① 核心角度完全打散
  ang += (fU - 0.5) * Math.PI * 2 * cb2;

  // 臂内散布：`pow(rnd, 2.6)` 让大多数点**贴着臂**，少数甩出去（诗云原式）
  const scatter = Math.pow(sU, 2.6) * (sSign < 0.5 ? -1 : 1) * S.ARM_SCATTER * r;
  // ② 面内核心填充
  const coreFill = cb2 * R * S.CORE_FILL_R;

  const x = Math.cos(ang) * r + scatter + (fU2 - 0.5) * 2 * coreFill;
  const z = Math.sin(ang) * r + scatter + (fU3 - 0.5) * 2 * coreFill;
  // ③ 竖向：盘很薄（THICKNESS×DISK_Y_SCALE），核心额外加一点抖动让它有厚度
  const y =
    (hU * 2 - 1) * r * S.THICKNESS * S.DISK_Y_SCALE +
    (jU - 0.5) * R * S.CORE_JITTER_Y * coreBlend;

  // 贴臂程度：诗云用 exp(-((dev/σ)²)·2.2)
  const armProx = Math.exp(-Math.pow(g / S.ARM_SPREAD, 2) * 2.2);
  // HII 结：贴臂 + 少量散列命中（诗云 0.04）
  const hii = armProx > 0.55 && hiiU < 0.04;
  // 值噪声成团：频率与诗云一致（4.2 / R）
  const clump = vnoise(x * (4.2 / R), z * (4.2 / R));

  return { pos: [x, y, z], r, t, armProx, hii, clump, coreBlend };
}

// ---------------------------------------------------------------- 颜色
/** 简单十六进制 → RGB（0..1）。 */
export function hexRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}
function mixRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, k: number) {
  return { r: lerp(a.r, b.r, k), g: lerp(a.g, b.g, k), b: lerp(a.b, b.b, k) };
}

/**
 * 色温梯度（**色值与分段阈值照搬诗云**）：
 *   `#fff1d6`（暖核 ~4500K）→ `#fff7ec` → `#ffffff` → `#cfe0ff`（蓝白年轻臂星 ~9000K）
 * 分段：`t < 0.12` 核→内，`t < 0.4` 内→中，其余 中→臂。
 */
const C_CORE = hexRgb("#fff1d6");
const C_INNER = hexRgb("#fff7ec");
const C_MID = hexRgb("#ffffff");
const C_ARM = hexRgb("#cfe0ff");
const C_HII = hexRgb("#ff6d92");

/**
 * 学科色的**染色目标**：把主色与副色按 0.35 调一调，得到"这一团该有的那口颜色"。
 *
 * 单独抽出来是为了让 `pointColor` 与"染色浓度"那条通路用**同一个**色值 ——
 * 两处各算一遍的话，调 `uTint` 时会染到另一个颜色上去（那种错看起来只是"颜色有点怪"，
 * 很难归因）。见 `STAR_VERT` 里 `uTint` 的说明。
 */
export function domainTint(
  domain: { r: number; g: number; b: number },
  color2: { r: number; g: number; b: number },
): { r: number; g: number; b: number } {
  return mixRgb(domain, color2, 0.35);
}

/**
 * 点的颜色。
 * @param t 归一化半径
 * @param armProx 贴臂程度
 * @param domain 学科主色（染进一部分，保证"像宇宙"的同时仍能分辨是哪一团）
 * @param color2 学科副色
 * @param hii 是否 HII 结
 */
export function pointColor(
  t: number,
  armProx: number,
  domain: { r: number; g: number; b: number },
  color2: { r: number; g: number; b: number },
  hii: boolean,
): { r: number; g: number; b: number } {
  let c: { r: number; g: number; b: number };
  if (t < 0.12) c = mixRgb(C_CORE, C_INNER, t / 0.12);
  else if (t < 0.4) c = mixRgb(C_INNER, C_MID, (t - 0.12) / 0.28);
  else c = mixRgb(C_MID, C_ARM, Math.min(1, (t - 0.4) / 0.5));
  // 贴臂的点更偏蓝白（诗云：c.lerp(cArm, armProx*0.45)）
  c = mixRgb(c, C_ARM, armProx * 0.45);
  if (hii) return mixRgb(c, C_HII, 0.85);
  /**
   * 学科色比例。
   *
   * ⚠️ 2026-10 从 0.22 提到 0.55：旧值下 probeGL 的 coloredPct 只有 1.92%
   * （整幅画面不到 2% 的像素带颜色），而参考实现的画面里颜色本身就是信息。
   * 上限刻意不取 1.0：全染会变成"霓虹花"，丢掉色温梯度。
   *
   * ⚠️ **但 0.55 仍然不够 —— 而且原因不在这个系数上**（2026-10 实测）：
   *    色温梯度中段那一站是**纯白** `#ffffff`（照诗云抄的，`C_MID`），
   *    而指数半径下**中位半径落在 t≈0.52**，也就是绝大多数粒子拿到的底色是
   *    `mix(#ffffff, #cfe0ff, 0.24)` ≈ `(243,248,255)` —— **离中性只有 12 的色差**。
   *    把这种颜色往学科色混 0.3~0.55，得到的色差仍然只有 12→38，
   *    而画面上一颗粒子渲染出来的 `max` 通道只有几十 ⇒ 实际色差被同比例缩到 **不到 18**，
   *    于是**整片底光算作"中性灰"**（`metric.mjs --hist`：亮起来的像素里只有 3.5% 有色差，
   *    而诗云是 32%）。
   *
   *    结论：**"混多少"这个旋钮已经拧到头了，缺的是色相本身。**
   *    所以另开一条通路：把学科色作为**独立属性**传下去，由着色器的 `uTint` 决定浓度
   *    （见 `STAR_VERT` 里那段 —— 这样也能在同一个页面里扫，不必每换一个值重跑构建）。
   *
   * ## ⚠️ 还有一层残余，是**设计本身**带来的，不是这个函数能修的
   *
   * 提彩度 + 上色之后，与取景无关的那项指标从「色差>18 占 16.4%」补到 **21.4%**
   * （诗云 32.0%）。剩下的这部分追到了机制上：
   *
   *   逐层单独出图（`_scratch/probe-layer-solo.mjs`）里，**`stars` 这一层单独看仍然是灰的**
   *   —— 占画面 39.6% 的亮像素里只有 5.4% 有色差，九点取样是 `(16,16,19)`、`(34,35,35)`、
   *   `(47,53,48)` 这种。而它明明已经按 `uTint = 0.8` 染过学科色了。
   *
   *   原因是**加法混合**：八团各自的色相不同，它们在**互相重叠的区域**里加起来
   *   ⇒ 不同色相相加趋于中性。空间上也对得上 —— 饱和度图（`metric.mjs --satmap`）里
   *   高的只出现在**各团自己的团块**上（`#`），而它们之间的**大片底光是 `.`（<10%）**。
   *
   *   **诗云没有这个问题，因为它只有一个星系。** 它的画面上不会出现"八种色相相加"。
   *   所以这一层残余是"**八团平权、互相重叠、靠颜色区分**"这个设计选择的代价 ——
   *   想再往上补，要么减少重叠（改构图，与作者的明确要求冲突），
   *   要么把颜色继续推到霓虹。两者都不是"对齐参考实现"该做的事。
   *
   *   记在这里，是因为下一个看到"饱和度还差 1.5 倍"的人，第一反应会是来改这个函数 ——
   *   **改了没用**，缺的已经不是单个粒子的颜色浓度了。
   */
  const tint = domainTint(domain, color2);
  return mixRgb(c, tint, 0.55 * (0.5 + armProx * 0.5));
}
