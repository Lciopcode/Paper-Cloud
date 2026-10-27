/**
 * 论文云 · 双指手势的**纯数学**
 * ============================================================================
 * 照搬诗云 `src/three/touchGesture.ts` 的做法：把双指手势里**能算的部分**全部抽成纯函数，
 * 一个 three / DOM 都不 import。理由在它的注释里写得很清楚，而且我们这边同样成立：
 *
 *   **无头浏览器合成不出多点触控** —— 软件渲染 + CDP 发不出真正的双指事件。
 *   所以"双指缩放到底对不对"这件事**没有端到端可测的面**，
 *   唯一能被单测钉住的就是这些纯函数（见 `touchGesture.test.ts`）。
 *   把数学留在组件里，等于把这个功能变成"只能靠手在手机上试"——
 *   而那种功能一旦坏了，通常是很久以后才被发现。
 *
 * ## 两个模式两套语义（与相机模型一致，见 `FlyCamera.tsx`）
 *
 *   · **自由飞行**：双指**张开/捏合** = 改**速度倍率**（与滚轮同一个旋钮）；
 *     双指**整体平移** = 模拟推进（摇杆式：按住不放就一直飞）。
 *   · **锁定一颗星**：双指张开/捏合 = 改**轨道距离**（与滚轮同一个旋钮）。
 *
 * ⚠️ 两种语义**必须互斥**，否则"一只手捏合"时掌心的漂移会被当成推进 ——
 *    那正是诗云用 `classifyGesture` 解决的问题：手势移动超过阈值之后**锁定成一种**。
 */

export interface Pt {
  x: number;
  y: number;
}

export function centroid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function pinchDistance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 从"重心相对手势起点的位移"算模拟推进量，返回 `{ forward, right }`（0..1）。
 *
 * 为什么用"重心位移"而不是"某根手指的位移"：两指同时上推时重心才代表意图；
 * 用单指会在捏合时被误读成推进。
 *
 * 死区 10px 吃掉抖动；120px 位移映射到满推力。
 */
export function thrustFromDrag(
  origin: Pt,
  cur: Pt,
  deadzone = 10,
  span = 120,
): { forward: number; right: number } {
  const axis = (d: number) => {
    const past = Math.abs(d) - deadzone;
    if (past <= 0) return 0;
    return Math.max(-1, Math.min(1, (Math.sign(d) * past) / span));
  };
  /**
   * 手指往上 = 前进（屏幕 y 向下为正，所以取负）。
   *
   * ⚠️ `f === 0 ? 0 : f` 不是多余：`-0` 与 `0` 在算术上等价，但 `Object.is(-0, 0)` 是 false ——
   *    它会让"推进量是否为零"这类比较在某些写法下失效（单测里当场就撞上了）。
   *    归一化成正零，成本是一次比较。
   */
  const f = -axis(cur.y - origin.y);
  return { forward: f === 0 ? 0 : f, right: axis(cur.x - origin.x) };
}

/**
 * 捏合 → 速度倍率（自由飞行）。
 *
 * 张开（`curDist > prevDist`）变快，与滚轮的"往上滚 = 加速"同向。
 * 上下限的默认值与 `FlyCamera` 的 `SPEED_MIN/SPEED_MAX` **必须一致**
 * （`touchGesture.test.ts` 里有一条断言把两个模块钉在一起，就是防这个漂移）。
 *
 * `!(x > 0)` 的写法是**故意**的：它同时挡住 0、负数与 NaN（退化重心），
 * 而 `x <= 0` 挡不住 NaN —— NaN 一旦写进倍率就再也回不来了（后续全是 NaN）。
 *
 * ⚠️ 上下限**必须给默认值**：第一版把 `min/max` 写成必填，而调用方少传两个参数时
 *    `Math.max(undefined, ...)` 会返回 **NaN** —— 上面那段"绝不让 NaN 污染倍率"的话
 *    就成了空话（自己的函数先把 NaN 放进去了）。单测当场抓到。
 */
export const PINCH_SPEED_MIN = 0.1;
export const PINCH_SPEED_MAX = 80;

export function pinchSpeed(
  speedMul: number,
  prevDist: number,
  curDist: number,
  min = PINCH_SPEED_MIN,
  max = PINCH_SPEED_MAX,
): number {
  if (!(prevDist > 0) || !(curDist > 0)) return speedMul;
  return Math.max(min, Math.min(max, speedMul * (curDist / prevDist)));
}

/**
 * 把双指手势**锁成一种**：重心位移与指距变化谁大听谁的。
 *
 * 阈值之内返回 `null`（"还看不出来要干什么"），于是一个静置的双指触摸什么也不做 ——
 * 这比"猜一个"好：猜错的表现是"我只是按住，镜头自己飞走了"。
 */
export function classifyGesture(
  origin: Pt,
  cur: Pt,
  startDist: number,
  curDist: number,
  threshold = 16,
): "pan" | "pinch" | null {
  const panDisp = Math.hypot(cur.x - origin.x, cur.y - origin.y);
  const pinchDisp = Math.abs(curDist - startDist);
  if (panDisp < threshold && pinchDisp < threshold) return null;
  return panDisp >= pinchDisp ? "pan" : "pinch";
}

/**
 * 捏合 → 轨道距离（锁定一颗星）。
 *
 * ⚠️ 方向与速度那支**相反**：张开手指是**拉近**（`dist * prevDist / curDist` 变小）。
 *    这不是笔误 —— 锁定时"张开"读作"把它拉到我面前"，与滚轮往上滚 = 拉近一致。
 */
export function orbitZoom(
  dist: number,
  prevDist: number,
  curDist: number,
  min: number,
  max: number,
): number {
  if (!(prevDist > 0) || !(curDist > 0)) return dist;
  return Math.max(min, Math.min(max, dist * (prevDist / curDist)));
}
