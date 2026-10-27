/**
 * `citationFan.ts` 的单测。
 *
 * 这一层最容易犯的错是"**静默画错**"：线段接到错误的星、或者把不在场的
 * 被引论文当成在场（画出一根指向原点的线）。两种都不会抛异常，
 * 只会让画面"看起来有点怪"，所以必须由单测钉住。
 */
import { describe, expect, it } from "vitest";
import { docIndex } from "./points.ts";
import { buildCiteFan } from "./citationFan.ts";

/** 造一个小点集：5 颗星，docId 故意不连续（真实点集是抽样出来的） */
function points() {
  const docIds = new Uint32Array([10, 40, 90, 120, 200]);
  const positions = new Float32Array(5 * 3);
  for (let i = 0; i < 5; i++) {
    positions[i * 3] = i * 10;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = 0;
  }
  return { docIds, positions, count: 5 };
}

describe("引用扇形", () => {
  it("每条被引论文在场就画一条线，起点是本文、终点是被引星", () => {
    const p = points();
    const fan = buildCiteFan([40, 200], p, 10);
    expect(fan).not.toBeNull();
    expect(fan!.segments).toHaveLength(2);
    expect(fan!.segments[0]).toMatchObject({ ax: 0, bx: 10 });
    expect(fan!.segments[1]).toMatchObject({ ax: 0, bx: 40 });
  });

  it("不在当前点集里的被引论文**不画线**（没有坐标可画）", () => {
    const p = points();
    // 777 不在点集里
    const fan = buildCiteFan([40, 777], p, 10);
    expect(fan!.segments).toHaveLength(1);
    // 关系集里也不该出现它 —— 否则星点层会以为"有一颗该亮的星"
    expect(fan!.ids.has(777)).toBe(false);
  });

  it("引用一篇都不在场时返回**空扇**而不是 null", () => {
    // 这个区分很重要：null = 点不到本文（数据坏了）；空扇 = 有引用但都不在画面里。
    const p = points();
    const fan = buildCiteFan([777, 888], p, 10);
    expect(fan).not.toBeNull();
    expect(fan!.segments).toHaveLength(0);
    expect(fan!.ringR).toBe(0);
  });

  it("本文不在点集里时返回 null", () => {
    expect(buildCiteFan([40], points(), 999)).toBeNull();
  });

  it("自环不会画出一条零长度的线", () => {
    const p = points();
    const fan = buildCiteFan([10, 40], p, 10);
    // 10 是自己：在场，但一条从自己射向自己的线没有意义
    expect(fan!.segments).toHaveLength(1);
    expect(fan!.segments[0].bx).toBe(10);
  });

  it("条数上限生效（综述型论文可能引几百篇）", () => {
    const p = points();
    const fan = buildCiteFan([40, 90, 120, 200], p, 10, 2);
    expect(fan!.segments).toHaveLength(2);
  });

  it("赤道环半径 = 最远那条被引论文的水平距离", () => {
    const p = points();
    const fan = buildCiteFan([40, 200], p, 10);
    // 200 那颗在 x=40，本文在 x=0 ⇒ 半径 40
    expect(fan!.ringR).toBeCloseTo(40, 5);
  });

  it("docIndex 对不连续 docId 也给出正确下标（线不能接错星）", () => {
    const p = points();
    expect(docIndex(p.docIds, 120)).toBe(3);
    expect(docIndex(p.docIds, 121)).toBe(-1);
  });
});
