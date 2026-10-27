/**
 * 论文云 · 关系数据结构的单元测试
 * ============================================================================
 * 这里守的是**打包/解包与 uid 的边界**。
 * 这类代码一旦有一位错位，"关系"就会指到别的论文上 —— 而且不会报错，
 * 只会安静地给出错误的邻居（比崩溃难查得多）。
 */
import { describe, expect, it } from "vitest";
import {
  DOCID_MASK,
  EDGE_KIND,
  EDGE_ZH,
  makeUid,
  packNeighbor,
  splitUid,
  unpackNeighbor,
} from "./relations";

describe("全局 uid：打包与拆分必须互逆", () => {
  it("往返一致（边界值也要覆盖）", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [0, DOCID_MASK],
      [1, 1],
      [7, 1_463_588],
      [127, 806_174],
      [127, DOCID_MASK],
    ];
    for (const [di, docId] of cases) {
      const uid = makeUid(di, docId);
      expect(splitUid(uid)).toEqual({ domainIndex: di, docId });
    }
  });

  it("不同 (学科, docId) 不会撞成同一个 uid", () => {
    const seen = new Set<number>();
    for (let di = 0; di < 8; di++) {
      for (const docId of [0, 1, 999, DOCID_MASK]) {
        const uid = makeUid(di, docId);
        expect(seen.has(uid)).toBe(false);
        seen.add(uid);
      }
    }
  });

  it("越界要立刻抛错（不静默截断）", () => {
    expect(() => makeUid(-1, 0)).toThrow();
    expect(() => makeUid(128, 0)).toThrow();
    expect(() => makeUid(0, -1)).toThrow();
    expect(() => makeUid(0, DOCID_MASK + 1)).toThrow();
  });
});

describe("邻居记录：类型与 uid 打包进一个 u32", () => {
  it("打包/解包互逆，三种类型都要覆盖", () => {
    const uids = [0, 1, 12_345, (1 << 30) - 1];
    for (const kind of [EDGE_KIND.cites, EDGE_KIND.sameField, EDGE_KIND.sameRoute]) {
      for (const uid of uids) {
        const packed = packNeighbor(kind, uid);
        expect(packed).toBeLessThanOrEqual(0xffffffff);
        expect(unpackNeighbor(packed)).toEqual({ kind, uid });
      }
    }
  });

  it("uid 超出 30 位要抛错（否则会污染类型位）", () => {
    expect(() => packNeighbor(EDGE_KIND.cites, 1 << 30)).toThrow();
    expect(() => packNeighbor(EDGE_KIND.cites, (1 << 30) + 5)).toThrow();
  });

  it("打包值是无符号的（存进 u32 不能变成负数）", () => {
    const packed = packNeighbor(EDGE_KIND.sameRoute, (1 << 30) - 1);
    expect(packed).toBeGreaterThan(0);
    expect(packed >>> 0).toBe(packed);
  });

  it("低 2 位是类型、高位是 uid（位序不能反）", () => {
    const packed = packNeighbor(EDGE_KIND.sameRoute, 0b1011);
    expect(packed & 0b11).toBe(EDGE_KIND.sameRoute);
    expect(packed >>> 2).toBe(0b1011);
  });
});

describe("边类型的中文名：每个类型都要有", () => {
  it("三种边都有中文名（界面不会显示 undefined）", () => {
    for (const k of [EDGE_KIND.cites, EDGE_KIND.sameField, EDGE_KIND.sameRoute]) {
      expect(EDGE_ZH[k]).toBeTruthy();
    }
    expect(EDGE_ZH[EDGE_KIND.cites]).toBe("引用");
    expect(EDGE_ZH[EDGE_KIND.sameField]).toBe("同领域");
    expect(EDGE_ZH[EDGE_KIND.sameRoute]).toBe("同路线");
  });
});
