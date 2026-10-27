/**
 * 论文云 · 排列模式的单元测试
 * ============================================================================
 * 这里守的是"**模式切换不能破坏坐标的确定性**"。
 *
 * 因为位置必须由地址唯一决定（这是本作品的核心不变量：永久链接、
 * 按编号反查、层级归属全都依赖它），所以模式函数必须是**纯函数**：
 * 同一个 (addrLow, year, sector) 输入永远得到同一个坐标，且不依赖任何全局状态。
 */
import { describe, expect, it } from "vitest";
import {
  IMPACT_AVAILABLE,
  LAYOUT_ZH,
  YEAR_MAX,
  YEAR_MIN,
  buildYearScale,
  impactPosition,
  ringRadiusOf,
  timePosition,
  type YearScale,
} from "./layout";

describe("时间模式：确定性", () => {
  it("同一输入永远得到同一坐标", () => {
    const a = timePosition(0x1234567890abcdefn, 2015, 3);
    const b = timePosition(0x1234567890abcdefn, 2015, 3);
    expect(a).toEqual(b);
  });

  it("不同地址在同一年内要散开（否则同年的论文会挤成一列）", () => {
    const xs = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = timePosition(BigInt(i) * 0x9e3779b97f4a7c15n, 2015, 0);
      xs.add(p[0].toFixed(4) + "," + p[2].toFixed(4));
    }
    // 200 个不同地址应当给出接近 200 个不同位置（允许极少碰撞）
    expect(xs.size).toBeGreaterThan(190);
  });
});

describe("时间模式：年份映射到半径（内老外新）", () => {
  it("越新的论文半径越大（单调）", () => {
    const addr = 12345n;
    let prevR = -1;
    for (let y = YEAR_MIN; y <= YEAR_MAX; y += 4) {
      const [x, , z] = timePosition(addr, y, 0);
      const r = Math.hypot(x, z);
      expect(r).toBeGreaterThan(prevR);
      prevR = r;
    }
  });

  it("最老与最新的半径差足够大（看得出层次）", () => {
    const [x0, , z0] = timePosition(1n, YEAR_MIN, 0);
    const [x1, , z1] = timePosition(1n, YEAR_MAX, 0);
    const r0 = Math.hypot(x0, z0);
    const r1 = Math.hypot(x1, z1);
    expect(r1 - r0).toBeGreaterThan(3);
  });

  it("缺年份（0）落到最内圈，而不是随机位置", () => {
    const [x, , z] = timePosition(999n, 0, 0);
    const r = Math.hypot(x, z);
    const [x0, , z0] = timePosition(999n, YEAR_MIN, 0);
    const rMin = Math.hypot(x0, z0);
    // 与"最早年份"同一个半径量级
    expect(r).toBeCloseTo(rMin, 1);
  });

  it("超出范围的年份被夹住（不会飞到盘外）", () => {
    const [xa, , za] = timePosition(1n, 1800, 0);
    const [xb, , zb] = timePosition(1n, 3000, 0);
    const [xMin, , zMin] = timePosition(1n, YEAR_MIN, 0);
    const [xMax, , zMax] = timePosition(1n, YEAR_MAX, 0);
    expect(Math.hypot(xa, za)).toBeCloseTo(Math.hypot(xMin, zMin), 1);
    expect(Math.hypot(xb, zb)).toBeCloseTo(Math.hypot(xMax, zMax), 1);
  });
});

describe("时间模式：学科分扇区", () => {
  it("不同学科占不同扇区（否则读不出'哪个领域'）", () => {
    const angles = new Set<number>();
    for (let s = 0; s < 8; s++) {
      const [x, , z] = timePosition(0n, YEAR_MIN, s);
      angles.add(Math.round((Math.atan2(z, x) * 180) / Math.PI));
    }
    expect(angles.size).toBe(8);
  });

  it("扇区序号越大角度越大（相邻学科在盘上相邻）", () => {
    const angleOf = (s: number) => {
      const [x, , z] = timePosition(0n, YEAR_MIN, s);
      return Math.atan2(z, x);
    };
    expect(angleOf(1)).toBeGreaterThan(angleOf(0));
    expect(angleOf(4)).toBeGreaterThan(angleOf(3));
  });
});

describe("影响模式：按被引次数摆成引力井", () => {
  it("IMPACT_AVAILABLE 为 true（引用数据已抓到，模式可用）", () => {
    expect(IMPACT_AVAILABLE).toBe(true);
  });

  it("被引越高越靠中心（这是这个模式唯一要表达的事）", () => {
    const rOf = (bright: number) => {
      const [x, , z] = impactPosition(7n, bright, 0);
      return Math.hypot(x, z);
    };
    const hot = rOf(2.6); // 高被引
    const warm = rOf(1.8);
    const cold = rOf(1.0); // 有记录但 0 引用
    expect(hot).toBeLessThan(warm);
    expect(warm).toBeLessThan(cold);
  });

  it("**没有记录**的落在更外面的单独一带（不能与「0 引用」混在一起）", () => {
    const unknown = (() => {
      const [x, , z] = impactPosition(7n, 0.75, 0);
      return Math.hypot(x, z);
    })();
    const zeroCited = (() => {
      const [x, , z] = impactPosition(7n, 1.0, 0);
      return Math.hypot(x, z);
    })();
    // 无记录的一律在"确实 0 引用"之外 —— 否则会把数据缺失读成"没人引用"
    expect(unknown).toBeGreaterThan(zeroCited);
  });

  it("确定性：同一编号 + 同一亮度 ⇒ 同一坐标", () => {
    const a = impactPosition(12345n, 1.9, 2);
    const b = impactPosition(12345n, 1.9, 2);
    expect(a).toEqual(b);
  });

  it("不同学科落在不同扇区（角度不同）", () => {
    const [x0, , z0] = impactPosition(7n, 1.5, 0);
    const [x1, , z1] = impactPosition(7n, 1.5, 1);
    expect(Math.abs(x0 - x1) + Math.abs(z0 - z1)).toBeGreaterThan(0.1);
  });
});

describe("年份分位：按论文量等分（这是修掉'甜甜圈'的关键）", () => {
  // 造一个**指数增长**的直方图 —— 正是 arXiv 的真实形态
  // （实测物理团：1986 年 1 篇、2016 年 58,241 篇、2026 年 84,751 篇，累计到 2016 才过 50%）
  const counts = Array.from({ length: 41 }, (_, i) => Math.round(10 ** (i / 8)));
  const scale = buildYearScale(1986, counts);

  it("分位单调不减（年份越新分位越大）", () => {
    for (let i = 1; i < scale.percentileOfYear.length; i++) {
      expect(scale.percentileOfYear[i]).toBeGreaterThanOrEqual(scale.percentileOfYear[i - 1]);
    }
  });

  it("首个分位接近 0、末个落在后段（覆盖整个区间）", () => {
    expect(scale.percentileOfYear[0]).toBeLessThan(0.05);
    // ⚠️ 末个分位是**最后一年区间的中点**，不是 1.0 ——
    // 最后一年本身横跨 [1 − c/total, 1]，取中点是刻意的
    // （用起点会让每年都偏早半格，在刻度环上看得出来）。
    // 所以这里只要求它落在后段，而不是贴着 1。
    const last = scale.percentileOfYear[scale.percentileOfYear.length - 1];
    expect(last).toBeGreaterThan(0.7);
    expect(last).toBeLessThan(1);
  });

  it("按论文量等分：**早期年份占据更多半径**（这正是要修的效果）", () => {
    // 线性年份映射下，1996（第 10 年 / 共 40 年）应当落在 25%；
    // 按论文量等分后，因为早期论文少，1996 的分位应当**远小于** 25%
    const p1996 = scale.percentileOfYear[1996 - 1986];
    expect(p1996).toBeLessThan(0.25);
  });

  it("同一批点的半径分布比线性映射更均匀（不再是甜甜圈）", () => {
    // 用真实年份分布取样，比较两种映射下的半径分布标准差
    const years: number[] = [];
    for (let i = 0; i < counts.length; i++) {
      for (let k = 0; k < Math.min(50, counts[i]); k++) years.push(1986 + i);
    }
    const radiiOf = (s: YearScale | null) =>
      years.map((y) => {
        const [x, , z] = timePosition(7n, y, 0, s);
        return Math.hypot(x, z);
      });
    const sd = (a: number[]) => {
      const m = a.reduce((p, c) => p + c, 0) / a.length;
      return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length);
    };
    const uniformBetter = sd(radiiOf(scale)) < sd(radiiOf(null));
    expect(uniformBetter).toBe(true);
  });
});

describe("刻度环半径：与点位用同一套映射", () => {
  it("环半径随年份单调增（否则刻度会错位）", () => {
    const counts = Array.from({ length: 41 }, (_, i) => Math.round(10 ** (i / 8)));
    const scale = buildYearScale(1986, counts);
    let prev = -1;
    for (let y = 1990; y <= 2026; y += 5) {
      const r = ringRadiusOf(y, scale);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it("同一年份的点与环落在同一半径（读得准）", () => {
    const counts = Array.from({ length: 41 }, (_, i) => Math.round(10 ** (i / 8)));
    const scale = buildYearScale(1986, counts);
    const [x, , z] = timePosition(0n, 2010, 0, scale);
    // 抖动只影响角度，不影响半径
    expect(Math.hypot(x, z)).toBeCloseTo(ringRadiusOf(2010, scale), 6);
  });
});

describe("模式中文名：每种都有", () => {
  it("三种模式都有中文名", () => {
    expect(LAYOUT_ZH.domain).toBe("领域");
    expect(LAYOUT_ZH.time).toBe("时间");
    expect(LAYOUT_ZH.impact).toBe("影响");
  });
});
