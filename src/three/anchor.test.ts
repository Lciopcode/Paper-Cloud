/**
 * 选中星锚点注册表的用例。
 *
 * 这一层的 bug 特别难在画面上认出来 —— 表现是"标记环时有时无""环挂歪了一点"，
 * 都不像是"注册表出了问题"。所以这里把几条容易被忽略的约定钉住：
 *   · 找不到是**正常返回 false**，不是抛异常（抽样过的点集里有些 docId 就是不在）；
 *   · 注销**必须比对函数本身**再删（React 严格模式会"挂载-卸载-再挂载"）；
 *   · 八个团同时在场，各注册各的，互不覆盖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyAnchorHit,
  registerAnchorResolver,
  resetAnchorResolvers,
  resolveAnchor,
  type AnchorHit,
} from "./anchor.ts";

/** 造一个"永远答同一个坐标"的解析器。 */
function fixed(p: [number, number, number]) {
  return (docId: number, out: AnchorHit) => {
    out.local[0] = docId;
    out.local[1] = 0;
    out.local[2] = 0;
    out.world[0] = p[0];
    out.world[1] = p[1];
    out.world[2] = p[2];
    return true;
  };
}

afterEach(() => {
  resetAnchorResolvers();
});

describe("resolveAnchor", () => {
  it("没有注册过的学科 → false，且不写入 out", () => {
    const out = emptyAnchorHit();
    out.world[1] = 7; // 放一个哨兵：解析失败时输出必须原样不动
    expect(resolveAnchor("physics", 1, out)).toBe(false);
    expect(out.world[1]).toBe(7);
  });

  it("注册后能拿到坐标；docId 原样传给解析器", () => {
    registerAnchorResolver("physics", fixed([1, 2, 3]));
    const out = emptyAnchorHit();
    expect(resolveAnchor("physics", 42, out)).toBe(true);
    expect(out.world).toEqual([1, 2, 3]);
    expect(out.local[0]).toBe(42);
  });

  it("解析器说找不到 → false（抽样过的点集里这是正常情况，不是错误）", () => {
    registerAnchorResolver("physics", () => false);
    expect(resolveAnchor("physics", 1, emptyAnchorHit())).toBe(false);
  });

  it("八个团各注册各的，互不覆盖", () => {
    registerAnchorResolver("physics", fixed([1, 0, 0]));
    registerAnchorResolver("math", fixed([2, 0, 0]));
    const out = emptyAnchorHit();
    expect(resolveAnchor("math", 1, out)).toBe(true);
    expect(out.world[0]).toBe(2);
    expect(resolveAnchor("physics", 1, out)).toBe(true);
    expect(out.world[0]).toBe(1);
  });

  it("注销之后不再解析", () => {
    const off = registerAnchorResolver("physics", fixed([1, 0, 0]));
    off();
    expect(resolveAnchor("physics", 1, emptyAnchorHit())).toBe(false);
  });

  it("旧的注销函数不能删掉新注册的解析器（严格模式会挂载-卸载-再挂载）", () => {
    const offOld = registerAnchorResolver("physics", fixed([1, 0, 0]));
    // 模拟严格模式：新的先注册进来，旧的清理函数才跑
    registerAnchorResolver("physics", fixed([9, 0, 0]));
    offOld();
    const out = emptyAnchorHit();
    expect(resolveAnchor("physics", 1, out)).toBe(true);
    expect(out.world[0]).toBe(9);
  });

  it("被调用的是当前那个函数（重注册即生效）", () => {
    const first = vi.fn(fixed([1, 0, 0]));
    const second = vi.fn(fixed([2, 0, 0]));
    registerAnchorResolver("physics", first);
    registerAnchorResolver("physics", second);
    resolveAnchor("physics", 1, emptyAnchorHit());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("八个团全部注销后整张表是空的", () => {
    const offs = ["physics", "math", "cs", "bio", "eess", "stat", "econ", "qfin"].map((d) =>
      registerAnchorResolver(d, fixed([0, 0, 0])),
    );
    offs.forEach((off) => off());
    for (const d of ["physics", "math", "cs", "bio", "eess", "stat", "econ", "qfin"]) {
      expect(resolveAnchor(d, 1, emptyAnchorHit())).toBe(false);
    }
  });
});
