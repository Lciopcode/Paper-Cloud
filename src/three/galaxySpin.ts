/**
 * 论文云 · 共享自转时钟
 * ============================================================================
 * 照搬诗云的 `src/three/galaxyParams.ts`。它的做法值得抄的地方在于**只有一个推进者**：
 *
 *   · `advanceSpin(dt)` 每帧被调用**一次**（由挂载最早的那个图层负责），
 *     其余图层只**读** `galaxySpin.angle`；
 *   · 于是诗人星、赠诗弧、标记、GPU 拾取器全都转在**同一个角度**上 ——
 *     否则拾取会与画面错开（点到的星不是看到的那颗），而那种错非常难查。
 *
 * ## 两个角：一个给"论文"，一个给"背景"，故意不同速
 *
 * 诗云的原话是"a gentle differential so the galaxy never looks like a rigid pinwheel"：
 * 背景（星云尘埃）转得比可点的星稍快一点，于是整片星海不会像一个刚体风车那样
 * 死板地整体旋转 —— 弥散的雾会**缓缓流过**定住的星。
 *
 * ⚠️ 我们的对应关系：
 *   · `angle` —— **论文星点 + 关系丝线 + 选中标记**（都在同一个组里，必须同角）；
 *   · `decorAngle` —— **星云尘埃**（单独一层，可以与论文不同速）。
 * 二者分开之后，星云会相对论文缓慢流动，正合它的意图。
 *
 * ⚠️ 速率照抄：`SPIN_RATE = 0.012 rad/s`（一整圈约 8.7 分钟）、
 *    `DECOR_RATE = 0.019`（约 1.6 倍）。**别调大** —— 转快了会晕，也会让拾取
 *    在高帧率下产生可见的滞后感。
 */
export const galaxySpin = { angle: 0, decorAngle: 0 };

/** 论文层的角速度（rad/s）—— 诗云 `SPIN_RATE` */
export const SPIN_RATE = 0.012;
/** 星云背景层的角速度（rad/s）—— 诗云 `DECOR_RATE`，约 1.6 倍 */
export const DECOR_RATE = 0.019;

/**
 * 推进共享角度（**每帧只调用一次**）。
 *
 * 为什么对 2π 取模：长时间运行后 `angle` 会累积到很大，而 `Math.cos/sin` 在大参数下
 * 精度会下降（浮点有效位被整数部分吃掉），表现为"转着转着开始抖"。
 * 取模是**无缝**的（2π ≡ 0），所以可以在任意时刻安全地做。
 */
export function advanceSpin(dt: number): void {
  galaxySpin.angle = (galaxySpin.angle + dt * SPIN_RATE) % (Math.PI * 2);
  galaxySpin.decorAngle = (galaxySpin.decorAngle + dt * DECOR_RATE) % (Math.PI * 2);
}

/** 测试用：把角度复位（用例之间不能互相污染） */
export function resetSpin(): void {
  galaxySpin.angle = 0;
  galaxySpin.decorAngle = 0;
}
