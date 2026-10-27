/**
 * 双指手势数学的单测。
 *
 * ⚠️ **这个文件就是"双指手势"这个功能的全部可测面。**
 *    无头浏览器合成不出多点触控（软件渲染 + CDP 都发不出真正的双指事件），
 *    所以端到端自检在这一块**测不了**——把这些数学抽成纯函数、在这里钉住，
 *    是唯一诚实的做法（诗云的注释里写的是同一件事）。
 *
 * 每个用例都对着"坏了会怎样"写：
 *   · 方向反了 ⇒ 张开手指变成减速（用户会以为卡了）；
 *   · 没挡 NaN ⇒ 倍率一旦变 NaN 就再也回不来；
 *   · 没挡 0/负距离 ⇒ 退化重心（两指重合）会把距离算成 0 或负；
 *   · 不分类手势 ⇒ 捏合时掌心的漂移被当成推进，镜头自己飞走。
 */
import { describe, expect, it } from "vitest";
import {
  PINCH_SPEED_MAX,
  PINCH_SPEED_MIN,
  centroid,
  classifyGesture,
  orbitZoom,
  pinchDistance,
  pinchSpeed,
  thrustFromDrag,
} from "./touchGesture.ts";
import { SPEED_MAX, SPEED_MIN } from "./FlyCamera.tsx";

/**
 * 防漂移：手势的上下限与滚轮的上下限**必须是同一组数**。
 * 两处各写一份字面量、哪天只改了滚轮那边，就会出现"捏合能到 80、滚轮只能到 24"
 * 这种谁也想不到的不一致 —— 而它是**不会报错**的。
 */
describe("touchGesture — 与相机模块的常量对齐", () => {
  it("捏合的速度区间 == 滚轮的速度区间", () => {
    expect(PINCH_SPEED_MIN).toBe(SPEED_MIN);
    expect(PINCH_SPEED_MAX).toBe(SPEED_MAX);
  });
});

describe("touchGesture — 基础量", () => {
  it("重心取中点", () => {
    expect(centroid({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
  it("指距是欧氏距离（两指重合时为 0）", () => {
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pinchDistance({ x: 7, y: 7 }, { x: 7, y: 7 })).toBe(0);
  });
});

describe("touchGesture — thrustFromDrag（自由飞行的模拟推进）", () => {
  const origin = { x: 100, y: 100 };
  it("死区之内不动（抖动不该让镜头飘）", () => {
    expect(thrustFromDrag(origin, { x: 105, y: 95 })).toEqual({ forward: 0, right: 0 });
  });
  it("往上推 = 前进（屏幕 y 向下为正，所以要取负）", () => {
    const t = thrustFromDrag(origin, { x: 100, y: 100 - 70 });
    expect(t.forward).toBeGreaterThan(0);
    expect(t.right).toBe(0);
  });
  it("往右推 = 右移", () => {
    const t = thrustFromDrag(origin, { x: 100 + 70, y: 100 });
    expect(t.right).toBeGreaterThan(0);
    expect(t.forward).toBe(0);
  });
  it("满推力封顶在 1（推多远都不会超过）", () => {
    expect(thrustFromDrag(origin, { x: 100 + 9999, y: 100 }).right).toBe(1);
    expect(thrustFromDrag(origin, { x: 100, y: 100 - 9999 }).forward).toBe(1);
  });
});

describe("touchGesture — pinchSpeed（自由飞行：捏合改速度）", () => {
  it("张开手指 = 变快", () => {
    expect(pinchSpeed(1, 100, 200)).toBe(2);
  });
  it("捏合手指 = 变慢", () => {
    expect(pinchSpeed(2, 200, 100)).toBe(1);
  });
  it("封顶 80 / 保底 0.1（与滚轮同一个区间）", () => {
    expect(pinchSpeed(50, 100, 1000, 0.1, 80)).toBe(80);
    expect(pinchSpeed(0.2, 1000, 100, 0.1, 80)).toBe(0.1);
  });
  it("退化重心（距离 0 / 负 / NaN）时倍率**原样返回**，不被污染成 NaN", () => {
    expect(pinchSpeed(3, 0, 100)).toBe(3);
    expect(pinchSpeed(3, 100, 0)).toBe(3);
    expect(pinchSpeed(3, Number.NaN, 100)).toBe(3);
    expect(pinchSpeed(3, 100, Number.NaN)).toBe(3);
  });
});

describe("touchGesture — orbitZoom（锁定：捏合改轨道距离）", () => {
  it("张开 = 拉近（与速度那支方向相反，见实现的说明）", () => {
    expect(orbitZoom(100, 100, 200, 1, 400)).toBe(50);
  });
  it("捏合 = 推远", () => {
    expect(orbitZoom(100, 200, 100, 1, 400)).toBe(200);
  });
  it("夹在 [min,max] 之间", () => {
    expect(orbitZoom(100, 100, 100000, 20, 400)).toBe(20);
    expect(orbitZoom(100, 100000, 100, 20, 400)).toBe(400);
  });
  it("退化重心时距离原样返回", () => {
    expect(orbitZoom(100, 0, 50, 1, 400)).toBe(100);
    expect(orbitZoom(100, 50, Number.NaN, 1, 400)).toBe(100);
  });
});

describe("touchGesture — classifyGesture（先分类，再动作）", () => {
  const origin = { x: 200, y: 200 };
  it("阈值之内不表态（静置的双指触摸什么也不该发生）", () => {
    expect(classifyGesture(origin, { x: 203, y: 202 }, 100, 104)).toBeNull();
  });
  it("重心走得比指距变化多 ⇒ pan", () => {
    expect(classifyGesture(origin, { x: 260, y: 200 }, 100, 104)).toBe("pan");
  });
  it("指距变化比重心位移大 ⇒ pinch", () => {
    expect(classifyGesture(origin, { x: 205, y: 202 }, 100, 220)).toBe("pinch");
  });
  it("两者都过阈值时，谁大听谁的（平局算 pan，避免抖动下反复横跳）", () => {
    expect(classifyGesture(origin, { x: 250, y: 200 }, 100, 150)).toBe("pan");
  });
});
