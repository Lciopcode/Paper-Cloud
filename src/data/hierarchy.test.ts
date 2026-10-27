/**
 * 论文云 · 层级模块的单元测试
 * ============================================================================
 * 这里守的是"**每个分类都有归宿、且归宿稳定**"。
 * 层级 id 会写进编号，一旦漂移，所有永久链接与坐标都会错位 —— 所以必须锁死。
 */
import { describe, expect, it } from "vitest";
import {
  archiveOf,
  archiveZh,
  catZh,
  crossTagOf,
  stratumPath,
  subcatOf,
} from "./hierarchy";

describe("archiveOf：尊重 arXiv 本来的顶层结构", () => {
  it("普通二级分类取前缀", () => {
    expect(archiveOf("cs.LG")).toBe("cs");
    expect(archiveOf("math.AP")).toBe("math");
    expect(archiveOf("eess.IV")).toBe("eess");
    expect(archiveOf("q-bio.NC")).toBe("q-bio");
    expect(archiveOf("q-fin.ST")).toBe("q-fin");
  });

  it("hep-* 与 nucl-* 本身就是顶层 archive（不能当成 physics 的子类）", () => {
    expect(archiveOf("hep-th")).toBe("hep-th");
    expect(archiveOf("hep-ph")).toBe("hep-ph");
    expect(archiveOf("hep-ex")).toBe("hep-ex");
    expect(archiveOf("hep-lat")).toBe("hep-lat");
    expect(archiveOf("nucl-th")).toBe("nucl-th");
    expect(archiveOf("nucl-ex")).toBe("nucl-ex");
    // 即使有二级写法（hep-ph.xxx）也仍归到顶层 archive
    expect(archiveOf("hep-ph.xyz")).toBe("hep-ph");
  });

  it("math-ph 归数学物理，不被 math 吞掉", () => {
    expect(archiveOf("math-ph")).toBe("math-ph");
  });

  it("cond-mat / astro-ph 是独立顶层 archive", () => {
    expect(archiveOf("cond-mat.mtrl-sci")).toBe("cond-mat");
    expect(archiveOf("astro-ph.GA")).toBe("astro-ph");
  });

  it("大小写与空白容错；空值有明确归宿", () => {
    expect(archiveOf("CS.LG")).toBe("cs");
    expect(archiveOf("  math.AP  ")).toBe("math");
    expect(archiveOf("")).toBe("(none)");
  });
});

describe("subcatOf：没有二级分类时退化成 archive 本身", () => {
  it("有二级就取二级", () => {
    expect(subcatOf("cs.LG")).toBe("lg");
    expect(subcatOf("cond-mat.str-el")).toBe("str-el");
  });
  it("没有二级就取自己", () => {
    expect(subcatOf("hep-th")).toBe("hep-th");
    expect(subcatOf("math-ph")).toBe("math-ph");
  });
});

describe("stratumPath：层路径必须稳定且可读", () => {
  it("L2 是 学科/archive，L3 再挂二级", () => {
    expect(stratumPath("cs", "cs.LG")).toEqual({ l2: "cs/cs", l3: "cs/cs/lg" });
    expect(stratumPath("physics", "hep-th")).toEqual({ l2: "physics/hep-th", l3: "physics/hep-th/hep-th" });
  });

  it("同一分类永远得到同一路径（写进编号的前提）", () => {
    const a = stratumPath("math", "math.AP");
    const b = stratumPath("math", "math.AP");
    expect(a).toEqual(b);
  });

  it("不同分类得到不同路径（否则层会混在一起）", () => {
    const s = new Set([
      JSON.stringify(stratumPath("cs", "cs.LG")),
      JSON.stringify(stratumPath("cs", "cs.CV")),
      JSON.stringify(stratumPath("cs", "cs.CL")),
    ]);
    expect(s.size).toBe(3);
  });
});

describe("crossTagOf：交叉列表是真实的跨学科信号", () => {
  it("多分类 = 交叉；单分类 = 不交叉", () => {
    expect(crossTagOf(["cs.LG", "stat.ML"])).toBe(true);
    expect(crossTagOf(["cs.LG"])).toBe(false);
    expect(crossTagOf([])).toBe(false);
  });
});

describe("中文名：未收录时原样返回，绝不丢数据", () => {
  it("收录的给中文", () => {
    expect(archiveZh("cs")).toBe("计算机科学");
    expect(catZh("cs.CV")).toBe("计算机视觉");
    expect(catZh("math.AP")).toBe("偏微分方程");
  });
  it("未收录的原样返回（而不是变成空串或 undefined）", () => {
    expect(archiveZh("some-new-archive")).toBe("some-new-archive");
    expect(catZh("cs.ZZZ")).toBe("cs.ZZZ");
  });
});
