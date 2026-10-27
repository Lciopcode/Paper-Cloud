/**
 * 论文云 · 发表去处评级的单元测试
 * ============================================================================
 * 这里守的是两件事：
 *   1. **该认出来的认出来** —— 顶刊顶会的常见写法都要命中（包括 arXiv 里
 *      五花八门的写法："Phys. Rev. Lett."、"PRL 92"、"accepted at NeurIPS"）。
 *   2. **不该认出来的别瞎认** —— 宁可返回"未识别"，也不要因为子串撞车
 *      把一篇预印本标成顶刊（这会让"星球大小"变成误导）。
 */
import { describe, expect, it } from "vitest";
import { VENUE_TIER, venueSizeBoost, venueTier, venueTierZh } from "./venue";

describe("T3 综合顶刊", () => {
  it("常见写法", () => {
    expect(venueTier("Nature 435, 123 (2005)")).toBe(VENUE_TIER.flagship);
    expect(venueTier("Science 310, 456 (2005)")).toBe(VENUE_TIER.flagship);
    expect(venueTier("Phys. Rev. Lett.")).not.toBe(VENUE_TIER.flagship);
    expect(venueTier("PNAS 102, 1234")).toBe(VENUE_TIER.flagship);
    expect(venueTier("Cell 120, 1 (2005)")).toBe(VENUE_TIER.flagship);
  });

  it("子刊也算 T3，但纯 arXiv 提到 nature 的普通句不算", () => {
    expect(venueTier("Nature Communications 5, 1234")).toBe(VENUE_TIER.flagship);
    expect(venueTier("Nature Physics 3, 1")).toBe(VENUE_TIER.flagship);
  });
});

describe("T2 学科顶刊", () => {
  it("物理：PRL 的各种写法", () => {
    expect(venueTier("Phys. Rev. Lett. 92, 123456")).toBe(VENUE_TIER.top);
    expect(venueTier("Physical Review Letters 88, 010101")).toBe(VENUE_TIER.top);
    expect(venueTier("PRL 95, 010401 (2005)")).toBe(VENUE_TIER.top);
  });

  it("天体：ApJ / MNRAS / A&A", () => {
    expect(venueTier("Astrophys. J. 600, L1")).toBe(VENUE_TIER.top);
    expect(venueTier("Mon. Not. R. Astron. Soc. 360, 1")).toBe(VENUE_TIER.top);
    expect(venueTier("Astronomy and Astrophysics 440, 1")).toBe(VENUE_TIER.top);
  });

  it("数学：Annals / Acta / Inventiones", () => {
    expect(venueTier("Annals of Mathematics 162, 1")).toBe(VENUE_TIER.top);
    expect(venueTier("Acta Mathematica 195, 1")).toBe(VENUE_TIER.top);
  });

  it("经济金融顶刊", () => {
    expect(venueTier("American Economic Review 95, 1")).toBe(VENUE_TIER.top);
    expect(venueTier("Econometrica 73, 1")).toBe(VENUE_TIER.top);
    expect(venueTier("Journal of Finance 60, 1")).toBe(VENUE_TIER.top);
  });
});

describe("T2 顶会：arXiv 的 comments 写法", () => {
  it("机器学习顶会", () => {
    expect(venueTier("Accepted at NeurIPS 2024")).toBe(VENUE_TIER.top);
    expect(venueTier("to appear in ICML 2023")).toBe(VENUE_TIER.top);
    expect(venueTier("Published at ICLR 2024")).toBe(VENUE_TIER.top);
    expect(venueTier("NIPS 2017")).toBe(VENUE_TIER.top);
  });

  it("视觉 / 自然语言 / 图形顶会", () => {
    expect(venueTier("CVPR 2022")).toBe(VENUE_TIER.top);
    expect(venueTier("ICCV 2021")).toBe(VENUE_TIER.top);
    expect(venueTier("ACL 2023")).toBe(VENUE_TIER.top);
    expect(venueTier("SIGGRAPH 2020")).toBe(VENUE_TIER.top);
  });
});

describe("T1 正式发表：宽泛识别", () => {
  it("任何像样的期刊名都至少 T1", () => {
    expect(venueTier("J. Phys. A 38, 1234")).toBeGreaterThanOrEqual(VENUE_TIER.published);
    expect(venueTier("Applied Physics Letters 88, 082107")).toBeGreaterThanOrEqual(VENUE_TIER.published);
    expect(venueTier("IEEE Transactions on Applied Superconductivity 16, 1")).toBeGreaterThanOrEqual(VENUE_TIER.published);
    expect(venueTier("Proceedings of the Royal Society A 461, 1")).toBeGreaterThanOrEqual(VENUE_TIER.published);
  });

  it("『accepted at』这类表述本身就算已发表", () => {
    expect(venueTier("accepted to Physical Review D")).toBeGreaterThanOrEqual(VENUE_TIER.published);
    expect(venueTier("to appear in Journal of Fluid Mechanics")).toBeGreaterThanOrEqual(VENUE_TIER.published);
  });

  it("含年份的期刊格式兜底判 T1", () => {
    expect(venueTier("Some Journal 12(2005)345")).toBe(VENUE_TIER.published);
    expect(venueTier("Acta Physica Polonica B 36 (2005) 123")).toBeGreaterThanOrEqual(VENUE_TIER.published);
  });
});

describe("T0 未识别：不能把预印本误判成顶刊", () => {
  it("空文本", () => {
    expect(venueTier("")).toBe(VENUE_TIER.none);
    expect(venueTier("   ")).toBe(VENUE_TIER.none);
  });

  it("单纯的 arXiv 说明（字数少、无期刊名）", () => {
    expect(venueTier("22 pages, 3 figures")).toBe(VENUE_TIER.none);
    expect(venueTier("4 pages")).toBe(VENUE_TIER.none);
    expect(venueTier("submitted")).toBe(VENUE_TIER.none);
  });

  it("子串撞车不能误判：cell / science / nature 出现在别的词里", () => {
    // "excellent" 里含 "cell" —— 必须靠词边界挡住
    expect(venueTier("excellent results")).toBe(VENUE_TIER.none);
    // "neuroscience" 里含 "science"
    expect(venueTier("computational neuroscience")).toBe(VENUE_TIER.none);
    // "signature" 里含 "nature"
    expect(venueTier("digital signature scheme")).toBe(VENUE_TIER.none);
  });
});

describe("视觉编码：等级 → 大小倍率", () => {
  it("等级越高越大，未识别不惩罚（=1.0）", () => {
    expect(venueSizeBoost(VENUE_TIER.none)).toBe(1.0);
    expect(venueSizeBoost(VENUE_TIER.published)).toBeGreaterThan(1.0);
    expect(venueSizeBoost(VENUE_TIER.top)).toBeGreaterThan(venueSizeBoost(VENUE_TIER.published));
    expect(venueSizeBoost(VENUE_TIER.flagship)).toBeGreaterThan(venueSizeBoost(VENUE_TIER.top));
  });

  it("倍率不能太夸张（否则几个顶刊会把星系撑坏）", () => {
    for (const t of [0, 1, 2, 3]) {
      const b = venueSizeBoost(t);
      expect(b).toBeGreaterThanOrEqual(1.0);
      expect(b).toBeLessThanOrEqual(2.5);
    }
  });

  it("每一级都有中文名（界面不会显示 undefined）", () => {
    for (const t of [0, 1, 2, 3, 99]) {
      expect(venueTierZh(t)).toBeTruthy();
    }
  });
});
