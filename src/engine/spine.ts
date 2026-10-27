/**
 * 论文云 · 编号脊柱（title spine）
 * ============================================================================
 * 这是整个作品的"灵魂机制"：**目录不被存储，被计算**。
 *
 *   词表 V 个词  ×  词槽 S 位  ⇒  目录容量 catalogSize = V^S（几十位十进制）
 *   每篇论文标题 → 唯一编号 index ∈ [0, catalogSize)
 *   每个编号     → 唯一标题（含"从未存在过的论文"）
 *
 * 设计边界（**刻意如此**，不要在这里加东西）：
 *   · 本模块只做**纯整数运算**：不读文件、不碰 DOM、不认识"论文"这个概念。
 *   · 输入输出全是 bigint / string[]，因此可以在 Node 管线与浏览器里跑出完全一致的结果。
 *   · 论文的**元数据**（作者、摘要、引用数）不在这里 —— 那些是可变的、有来源的；
 *     编号只依赖标题，因此是**稳定且可离线重算**的。
 *
 * 与诗云（Cohenjikan/shiyun）的关系：本项目**借鉴其"无存储穷举映射"的设计思想**，
 * 但双射散射的构造是**独立实现且不同**的（见 `scatter` 的注释：我们用 width-2h 的
 * Feistel + 单侧 cycle-walk，而不是它的半宽 cycle-walk —— 后者在 M 不是置换并集时不是双射）。
 */

// ---------------------------------------------------------------- 目录定义
/** 一个学科的目录定义：词表 + 词槽数。 */
export interface Catalog {
  /** 学科 id，如 "physics" */
  readonly id: string;
  /** 该学科的标题词表（已按词频降序；下标 = 词 id = 基数位） */
  readonly vocab: readonly string[];
  /** 词槽数 S（定长编码的位数） */
  readonly slots: number;
}

/** 词表大小 V。 */
export function vocabSize(c: Catalog): bigint {
  return BigInt(c.vocab.length);
}

/** 目录容量 |C| = V^S。 */
export function catalogSize(c: Catalog): bigint {
  return vocabSize(c) ** BigInt(c.slots);
}

/**
 * 目录容量的十进制位数（UI 显示"这本目录有 73 位"）。
 *
 * 为什么不用 `catalogSize(c).toString().length`：
 *   BigInt 的 `toString()` 本身没问题（会给出完整的 73 位数字），
 *   但**调用方很容易写成 `V ** S`** —— 那是 number 幂，会溢出成
 *   "1.2089258196146292e+72"，长度只有 22。这个错误在自检里真实发生过。
 *   本函数只接收 Catalog，内部用对数，**从类型上就不给"误用 number 幂"的机会**。
 */
export function catalogDigits(c: Catalog): number {
  const S = c.slots;
  const V = c.vocab.length;
  if (S <= 0 || V <= 1) return 1; // 1 或 1^S 都只占 1 位
  return Math.floor(S * Math.log10(V)) + 1;
}

// ---------------------------------------------------------------- 互逆运算
/**
 * 编号 → 词 id 序列。**首位是最高位**（大端）。
 *
 * 为什么必须是大端：这样"标题开头相同"的编号会落在**连续区间**里，
 * 于是"输入标题前半段 → 看它锁定哪一段目录"（半编号）才有意义。
 * 若改成小端，前缀相同的编号会散布在整个目录里，这个功能就不存在了。
 */
export function unrankSpine(c: Catalog, index: bigint): number[] {
  const V = vocabSize(c);
  const S = c.slots;
  const total = catalogSize(c);
  if (index < 0n || index >= total) throw new RangeError(`编号 ${index} 超出目录范围 [0, ${total})`);
  const out = new Array<number>(S);
  let k = index;
  for (let i = S - 1; i >= 0; i--) {
    out[i] = Number(k % V);
    k /= V;
  }
  return out;
}

/** 词 id 序列 → 编号（unrankSpine 的逆）。不足 S 位则**低位补 0**（相当于标题被截断）。 */
export function rankSpine(c: Catalog, ids: readonly number[]): bigint {
  const V = vocabSize(c);
  if (ids.length > c.slots) throw new RangeError(`词数 ${ids.length} 超过词槽数 ${c.slots}`);
  let k = 0n;
  for (let i = 0; i < c.slots; i++) {
    const d = i < ids.length ? ids[i] : 0;
    if (d < 0 || d >= c.vocab.length) throw new RangeError(`词 id ${d} 超出词表范围`);
    k = k * V + BigInt(d);
  }
  return k;
}

/** 词 id 序列 → 可读标题（用词表拼回来）。 */
export function idsToTitle(c: Catalog, ids: readonly number[]): string {
  return ids.map((i) => c.vocab[i] ?? "?").join(" ");
}

/** 编号 → 标题。 */
export function titleOfIndex(c: Catalog, index: bigint): string {
  return idsToTitle(c, unrankSpine(c, index));
}

// ---------------------------------------------------------------- 半编号（前缀锁定区间）
/** 前缀 → 该前缀锁定的**最小**编号（低位补 0）。 */
export function prefixIndex(c: Catalog, prefixIds: readonly number[]): bigint {
  return rankSpine(c, prefixIds);
}

/**
 * 前缀锁定多少个编号 —— 也就是"这个开头有多少种可能的论文标题"。
 * 锁定 m 位 ⇒ 剩余 S-m 位自由 ⇒ V^(S-m)。
 */
export function prefixSpan(c: Catalog, locked: number): bigint {
  const free = Math.max(0, c.slots - Math.min(locked, c.slots));
  return vocabSize(c) ** BigInt(free);
}

// ---------------------------------------------------------------- 双射散射
/**
 * splitmix64：把一个 BigInt 搅成另一个（确定性、雪崩性好、无外部依赖）。
 * 它**不是**双射（不保证单射），所以只能用在 Feistel 的**轮函数**里 ——
 * Feistel 结构保证"轮函数任意，整体仍是置换"。
 */
export function splitmix64(x: bigint): bigint {
  const M = (1n << 64n) - 1n;
  let z = (x + 0x9e3779b97f4a7c15n) & M;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
  return (z ^ (z >> 31n)) & M;
}

const ZERO = 0n;
const ONE = 1n;

/** 位长（bitlen(0) = 0）。 */
export function bitLength(x: bigint): number {
  if (x <= ZERO) return 0;
  let bits = 0;
  let n = x;
  while (n > ZERO) {
    bits++;
    n >>= ONE;
  }
  return bits;
}

/** 大于等于 x 的最小 2 的幂（宽度用）。 */
export function nextPow2(x: bigint): bigint {
  const b = bitLength(x - ONE);
  return ONE << BigInt(Math.max(1, b));
}

/**
 * 在 `width` 位（2 的幂大小）上做 Feistel 置换 —— **平衡 Feistel**，两半都是 h = width/2 位。
 *
 * **为什么宽 2h 而不是诗云那种"半宽"**：
 * 诗云用 `halfBits(M) = ceil(bitlen(M)/2)` 把 M 本身折半，再对 M 做 cycle-walk。
 * 但 M 一般**不是** 2 的幂，置换的循环不封闭在 [0, M) 内 ——
 * 于是那种 cycle-walk 得到的映射**不是双射**（我们实测复现过：会产生重复值）。
 * 正确做法：把定义域扩到 **2 的幂**（width = 2h 位），在整块上置换，
 * 再用 cycle-walk 把落在填充区 [R, 2^width) 的值走回 [0, R)。
 *
 * 两半等宽让"交换"这一步不需要任何位宽修补，实现上不容易出错 ——
 * 这类代码一旦有一位错位，双射性就悄悄破了，所以宁可简单。
 */
export function feistelPermute(x: bigint, width: number, key: bigint, invert: boolean): bigint {
  if (width <= 0 || width % 2 !== 0) throw new RangeError(`Feistel 宽度必须是正偶数，收到 ${width}`);
  const h = width >> 1;
  const half = ONE << BigInt(h);
  const mask = half - ONE;
  const ROUNDS = 8;

  let left = x >> BigInt(h);
  let right = x & mask;

  const round = (roundIndex: number): void => {
    const f = splitmix64(left ^ BigInt(roundIndex) ^ key) & mask;
    const next = right ^ f;
    right = left;
    left = next;
  };
  // 逆轮：与正向严格对称 —— 正向 "t=L^F(R); L=R; R=t"
  //       逆轮 "L=R; R=t" 之后再 "t = L^F(R)"
  const roundInv = (roundIndex: number): void => {
    const f = splitmix64(right ^ BigInt(roundIndex) ^ key) & mask;
    const prev = left ^ f;
    left = right;
    right = prev;
  };

  if (!invert) {
    for (let i = 0; i < ROUNDS; i++) round(i);
  } else {
    for (let i = ROUNDS - 1; i >= 0; i--) roundInv(i);
  }
  return ((left & mask) << BigInt(h)) | (right & mask);
}

/**
 * 散射：把编号在目录里"打散"，使**相邻编号在空间上不相邻**。
 *
 * 这是"宇宙感"的来源之一：如果按编号顺序排列，会看到一条整齐的螺旋线；
 * 散射之后才是星海。
 *
 * 构造：定义域扩到 M = 2^width（width = 2·ceil(bitlen(R)/2)，即 M ≥ R），
 * 在整块上做 Feistel 置换，再用 cycle-walk 把落在 [R, M) 的填充值走回 [0, R)。
 * 因为 M/2 < R ≤ M，平均只需 ~1.4 次尝试，且**严格保持双射**。
 */
export function scatter(R: bigint, key: bigint, x: bigint): bigint {
  if (R <= ONE) return ZERO;
  if (x < ZERO || x >= R) throw new RangeError(`散射输入 ${x} 超出 [0, ${R})`);
  // ⚠️ 宽度必须在**进入 loop 之前**定死一次。
  // 若在循环里重新计算（按当前值的位长），走一步后位长会变、宽度跟着变，
  // 于是逆变换再也回不去 —— 这是一个非常隐蔽的双射破坏点。
  const width = 2 * Math.ceil(bitLength(R) / 2);
  let y = feistelPermute(x, width, key, false);
  // 期望迭代次数 = M/R ≤ 2；加一个硬上限防病态输入死循环
  for (let guard = 0; y >= R; guard++) {
    if (guard > 4096) throw new Error("scatter: cycle-walk 未收敛（输入异常）");
    y = feistelPermute(y, width, key, false);
  }
  return y;
}

/** 散射的逆（unscatter(scatter(x)) === x 对目录内所有 x 成立）。 */
export function unscatter(R: bigint, key: bigint, y: bigint): bigint {
  if (R <= ONE) return ZERO;
  if (y < ZERO || y >= R) throw new RangeError(`逆散射输入 ${y} 超出 [0, ${R})`);
  const width = 2 * Math.ceil(bitLength(R) / 2);
  let x = feistelPermute(y, width, key, true);
  for (let guard = 0; x >= R; guard++) {
    if (guard > 4096) throw new Error("unscatter: cycle-walk 未收敛（输入异常）");
    x = feistelPermute(x, width, key, true);
  }
  return x;
}

// ---------------------------------------------------------------- 标题 ⇄ 编号（对外接口）
/**
 * 标题 → 编号。
 *
 * 分词规则由宿主提供（`tokenize`），本模块不关心语言 —— 这样它就能同时服务
 * 浏览器（用户输入）与离线管线（305 万篇标题），且两者结果必然一致。
 */
export function indexForTitle(c: Catalog, title: string, tokenize: (t: string) => string[]): bigint | null {
  const ids = idsForTitle(c, title, tokenize);
  return ids ? rankSpine(c, ids) : null;
}

/** 标题 → 词 id 序列（词表外的词直接丢弃；全丢光则返回 null）。 */
export function idsForTitle(
  c: Catalog,
  title: string,
  tokenize: (t: string) => string[],
): number[] | null {
  const pos = wordIndex(c);
  const ids: number[] = [];
  for (const token of tokenize(title)) {
    const id = pos.get(token);
    if (id === undefined) continue;
    ids.push(id);
    if (ids.length >= c.slots) break;
  }
  return ids.length ? ids : null;
}

const _wordIndexCache = new WeakMap<Catalog, Map<string, number>>();
/** 词 → id 的查找表（缓存；词表是只读的，所以缓存安全）。 */
export function wordIndex(c: Catalog): Map<string, number> {
  let m = _wordIndexCache.get(c);
  if (m) return m;
  m = new Map();
  for (let i = 0; i < c.vocab.length; i++) m.set(c.vocab[i], i);
  _wordIndexCache.set(c, m);
  return m;
}

// ---------------------------------------------------------------- 星团布局
/** 一个学科星团在宇宙里的位置、尺度与朝向。 */
export interface ClusterLayout {
  /** 宇宙坐标（八层里的"星系"这一层） */
  readonly center: readonly [number, number, number];
  /** 星团半径（世界单位） */
  readonly radius: number;
  /** 倾斜（欧拉角），让每个星团朝向不同，读起来才像"各自独立的天体" */
  readonly tilt: readonly [number, number, number];
}
