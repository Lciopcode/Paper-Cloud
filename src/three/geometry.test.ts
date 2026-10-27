/**
 * 论文云 · 几何层的单元测试
 * ============================================================================
 * 这些测试守的是**视觉正确性**，不是"当前实现的行为"：
 * "盘是扁的""点铺得开""有旋臂""同一地址永远同一坐标"——
 * 每一条坏掉都会让画面变成另一副样子（白斑 / 花朵 / 每次刷新都跳位置）。
 */
import { describe, expect, it } from "vitest";
import { GALAXY_SHAPE, hexRgb, pointColor, radiusFor, sampleAddress, type ClusterLayout } from "./geometry";

const LAYOUT: ClusterLayout = { center: [1, 2, 3], radius: 4.2, tilt: [0.3, -0.5, 0.2] };

/** 确定性伪随机地址（模拟 243 位量级：用多个 64 位字拼） */
function addr(i: number): bigint {
  let h = 0xcbf29ce484222325n;
  const M = (1n << 64n) - 1n;
  let x = BigInt(i);
  for (let k = 0; k < 4; k++) {
    x = (x + 0x9e3779b97f4a7c15n) & M;
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    h = (h ^ (z ^ (z >> 31n))) & M;
  }
  return h;
}

function sample(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(sampleAddress(addr(i), LAYOUT));
  return out;
}

describe("半径分布：核紧凑、盘铺开", () => {
  it("半径单调不减，且在 [0, 1.05R] 内", () => {
    let prev = -1;
    for (let u = 0; u <= 1; u += 0.01) {
      const r = radiusFor(u, 4.2);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(4.2 * 1.05 + 1e-9);
      prev = r;
    }
  });

  it("核成分占比正确：分位 < BULGE_FRAC 的点都落在 0.4R 内", () => {
    const R = 4.2;
    for (let u = 0; u < GALAXY_SHAPE.BULGE_FRAC; u += 0.01) {
      expect(radiusFor(u, R)).toBeLessThan(R * 0.4);
    }
  });

  it("盘成分真的铺开：大量点在 0.5R~R 之间（否则会挤成一根亮柱）", () => {
    const s = sample(20000);
    const outer = s.filter((p) => p.t > 0.5 && p.t < 1.02).length;
    // 若是指数盘，这个比例会低得多；幂律盘应有可观比例落在中外部
    expect(outer / s.length).toBeGreaterThan(0.2);
    // 同时中位半径不能太靠内
    const ts = s.map((p) => p.t).sort((a, b) => a - b);
    expect(ts[Math.floor(ts.length / 2)]).toBeGreaterThan(0.45);
  });
});

describe("盘是扁的（这是'星系'而不是'球状星团'的关键）", () => {
  it("|y| / r 的中位数很小", () => {
    const s = sample(20000);
    const ratios = s
      .filter((p) => p.r > 0.05)
      .map((p) => Math.abs(p.pos[1]) / p.r)
      .sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    expect(median).toBeLessThan(0.12); // 理论中位数 ≈ THICKNESS/2 = 0.055
  });
});

describe("有旋臂结构", () => {
  it("沿方位角看，贴臂程度呈周期性起伏（峰谷比足够大）", () => {
    const SECTORS = 72;
    const sum = new Array(SECTORS).fill(0);
    const cnt = new Array(SECTORS).fill(0);
    for (const p of sample(60000)) {
      if (p.t < 0.4) continue; // 只看盘（核区角度被打散）
      const theta = Math.atan2(p.pos[2], p.pos[0]);
      const k = Math.min(SECTORS - 1, Math.floor(((theta + Math.PI) / (Math.PI * 2)) * SECTORS));
      sum[k] += p.armProx;
      cnt[k]++;
    }
    const mean = sum.map((s, i) => (cnt[i] ? s / cnt[i] : NaN)).filter(Number.isFinite);
    expect(mean.length).toBeGreaterThan(40);
    const peak = Math.max(...mean);
    const valley = Math.min(...mean);
    expect(peak / Math.max(1e-6, valley)).toBeGreaterThan(1.3);
  });
});

/**
 * 核心角度打散（照诗云的 `cb²`）—— **这一条守的是"中心不能有四臂暗楔"**。
 *
 * 诗云在 `Galaxy.tsx` 里写得很清楚：
 *
 *   > Near the core the 4 arms converge into a bright X with dark wedges between.
 *   > Randomise the angle FULLY there (strong at the centre → gone by t≈0.45)
 *   > so the inner backdrop fills into a round disc — no inter-arm dark zones.
 *
 * 我们的对应实现是 `ang += (fU - 0.5) * 2π * cb²`（`sampleAddress` 里标着「① 核心角度完全打散」）。
 *
 * ## 怎么把它测成「看得见的性质」而不是「读了源码」
 *
 * 少了这一项，**越靠近中心，四臂越聚拢成一个亮十字、臂间是暗楔** ——
 * 也就是"按方位角切 72 个扇区数点"，中心那一带的**起伏会比外盘更大**。
 * 有了它，中心的方位起伏应该**明显小于**外盘。
 *
 * 所以这条判据是**方向性**的：`调制深度(内) < 调制深度(外)`。
 * 它不依赖任何绝对数值 —— 换个半径、换个团，关系都该成立；
 * 而一旦有人把 `cb²` 那一项删掉或调小，方向就会翻过来，判据立刻红。
 */
describe("核心角度打散：中心没有四臂暗楔", () => {
  /** 某一半径带里，「按方位角分扇区的点数」的调制深度 (max-min)/mean。越大 = 方位起伏越强 */
  function angularModulation(tMin: number, tMax: number): { mod: number; n: number } {
    const SECTORS = 72;
    const cnt = new Array(SECTORS).fill(0);
    let n = 0;
    for (const p of sample(120000)) {
      if (p.t < tMin || p.t >= tMax) continue;
      const theta = Math.atan2(p.pos[2], p.pos[0]);
      const k = Math.min(SECTORS - 1, Math.floor(((theta + Math.PI) / (Math.PI * 2)) * SECTORS));
      cnt[k]++;
      n++;
    }
    // 逐扇区计数不能有空格子（有空格子说明样本太少，调制深度会被 0 撑爆）
    const occupied = cnt.filter((c) => c > 0).length;
    expect(occupied).toBeGreaterThan(SECTORS * 0.9);
    const mean = cnt.reduce((a, b) => a + b, 0) / SECTORS;
    return { mod: (Math.max(...cnt) - Math.min(...cnt)) / mean, n };
  }

  it("**角度打散在起作用**：t∈[0.1,0.2) 的方位调制要够低（去掉打散会翻 3.4 倍）", () => {
    const a = angularModulation(0.1, 0.2);
    console.log(`  t∈[0.1,0.2) 方位调制 ${a.mod.toFixed(3)}（n=${a.n}）`);
    expect(a.n).toBeGreaterThan(500);
    expect(a.mod).toBeLessThan(1.0);
  });

  /**
   * ## ⚠️ 为什么判据打在 **t∈[0.1,0.2)**，而不是更靠中心的 [0.02,0.1)
   *
   * 第一版打的是最里面那一带，理由是"越靠中心、四臂越聚拢，暗楔越明显"。
   * **那个理由是错的**：核心里还有**面内铺开**（`coreFill = cb²·R·0.07`），
   * 在 t≈0.05 处它的位移幅度（≈0.06R）**比半径本身还大** ——
   * 点被它甩得到处都是，角度早就均匀了。
   * 所以把角度打散乘 0 之后，最内带的调制只从 0.316 涨到 0.438，**判据抓不到**（实测过）。
   *
   * 于是逐带量了一遍（打散开 / 打散关）：
   *
   *   t∈[0.02,0.1)  0.316 → 0.438   （面内铺开盖住了，不敏感）
   *   t∈[0.1 ,0.2)  0.517 → 1.771   ← **3.4 倍**，最敏感的一带
   *   t∈[0.2 ,0.3)  0.928 → 2.251   （2.4 倍，但样本少）
   *   t∈[0.3 ,0.4)  2.061 → 2.209   （这一带打散已经几乎为 0：cb²=(0.45-0.35)/0.45)²≈0.05）
   *
   * **判据要打在机制真正有作用的那一带** —— 打在"看起来最该有效"的地方，
   * 测到的可能全是另一个机制。这一条是量出来的，不是推出来的。
   */
  it("**角度打散是「逐带渐弱」的**：越往外调制越大（照诗云 cb² 的设计）", () => {
    const near = angularModulation(0.1, 0.2);
    const far = angularModulation(0.2, 0.3);
    console.log(`  t∈[0.1,0.2) ${near.mod.toFixed(3)} · t∈[0.2,0.3) ${far.mod.toFixed(3)}`);
    expect(far.mod).toBeGreaterThan(near.mod);
  });
  it("内区的方位分布接近均匀（起伏本身很小，不是「比外盘小但依然明显」）", () => {
    const inner = angularModulation(0.02, 0.1);
    console.log(`  内区方位调制的绝对值：${inner.mod.toFixed(3)}`);
    // 均匀分布的 72 个扇区里，1.2 万点的计数起伏约 √(n/72)/mean ≈ 0.1，
    // 所以 0.5 这个上限远在噪声之上 —— 它卡的是「肉眼能看出的暗楔」
    expect(inner.mod).toBeLessThan(0.5);
  });
});

describe("确定性：同一地址永远同一坐标（永久链接与'记住位置'的前提）", () => {
  it("重复采样完全一致", () => {
    const a = addr(12345);
    const p1 = sampleAddress(a, LAYOUT);
    const p2 = sampleAddress(a, LAYOUT);
    expect(p1.pos).toEqual(p2.pos);
    expect(p1.t).toBe(p2.t);
    expect(p1.armProx).toBe(p2.armProx);
  });

  it("不同地址几乎不会撞到同一点", () => {
    const seen = new Set<string>();
    const s = sample(5000);
    for (const p of s) seen.add(p.pos.map((v) => v.toFixed(6)).join(","));
    // 允许极少量巧合，但不应出现大量重复
    expect(seen.size).toBeGreaterThan(s.length * 0.99);
  });

  it("相邻编号的地址应当天各一方（否则星海会排成行）", () => {
    // 地址本身由 scatter 打散；这里验证"位置对地址的高位也敏感"
    const a = addr(7);
    const b = a ^ (1n << 200n); // 只翻转高位
    const p1 = sampleAddress(a, LAYOUT);
    const p2 = sampleAddress(b, LAYOUT);
    const d = Math.hypot(p1.pos[0] - p2.pos[0], p1.pos[1] - p2.pos[1], p1.pos[2] - p2.pos[2]);
    expect(d).toBeGreaterThan(0.01); // 高位必须参与，否则折进低位时会丢掉信息
  });
});

describe("颜色", () => {
  it("核更暖、臂更冷（色温梯度方向正确）", () => {
    const dom = hexRgb("#f0b775");
    const core = pointColor(0.02, 0.1, dom, dom, false);
    const arm = pointColor(0.95, 0.9, dom, dom, false);
    // 暖 = 红蓝差大；冷 = 红蓝差小
    expect(core.r - core.b).toBeGreaterThan(arm.r - arm.b);
  });

  it("所有通道都在 [0,1] 内（否则着色器会过曝）", () => {
    const dom = hexRgb("#6fc9bd");
    const dom2 = hexRgb("#d8fff6");
    for (let t = 0; t <= 1; t += 0.05) {
      for (const ap of [0, 0.5, 1]) {
        for (const hii of [false, true]) {
          const c = pointColor(t, ap, dom, dom2, hii);
          for (const v of [c.r, c.g, c.b]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("hexRgb 支持 3 位与 6 位写法", () => {
    expect(hexRgb("#fff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    const half = hexRgb("#808080");
    expect(half.r).toBeCloseTo(0.502, 2);
  });
});
