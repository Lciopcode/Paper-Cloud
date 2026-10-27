/**
 * 论文云 · 选中星锚点
 * ============================================================================
 * 回答一个问题：**"当前选中的那篇论文，此刻画在世界的哪个位置？"**
 *
 * ## 为什么需要单独一层
 *
 * 选中一颗星之后要做三件事：镜头飞过去看它、在它身上炸一圈冲击波、给它常驻一个标记环；
 * 另外星点自己也要"选中那颗变大变亮"。这四件事都需要**坐标**，
 * 而坐标依赖当前的排列模式：
 *
 *   · `domain` 模式：`sampleAddress(addr)` 再乘所属 `<group>` 的位移与倾角；
 *   · `time`   模式：八个团都归到原点、不倾斜，改由 `timePosition(addrLow, year, …)` 决定；
 *   · `impact` 模式：同理，由 `impactPosition(addrLow, bright, …)` 决定。
 *
 * 三套公式分散在 `layout.ts` 与 `Galaxy.tsx` 里。如果"选中"这条链路自己再算一遍，
 * 就成了**第二份公式** —— 任何一处改了、别处忘了跟，标记环就会**静静地挂在错误的位置上**。
 * 那种错误在画面上看起来只是"环画歪了一点"，很难联想到是代码不同步。
 *
 * 所以坐标由**唯一知道答案的那个人**给出：`StarLayer`。它手里的点集就是屏幕上真正画出来的
 * 那一批点，它的 `matrixWorld` 就是那一批点真正的变换，它的 `position` 属性里就是当前模式下的真实坐标。
 * 各域把自己的解析器注册进来，需要坐标的组件按 `(domain, docId)` 问它 —— 不存在第二份公式。
 *
 * ## 为什么是"解析器"而不是"发布一个坐标值"
 *
 * 一开始想的是"选中变化时算好坐标发布出来"。但那样有两个时机问题：
 *   ① 切换排列模式时，坐标重写发生在 effect 里，而世界矩阵要到**下一次渲染**才更新 ——
 *      在 effect 里发布，发布出去的是**上一帧的位置**（标记环滞后一拍）；
 *   ② 从 store 发布要触发 React 重渲染，而这只影响下一帧的画面，属于"为了画面去改状态"。
 * 改成"渲染时按需解析"之后，读取发生在 `useFrame` 里 ——
 * 那一刻世界矩阵**保证是最新的**，而且一次分配都不用（调用方提供输出对象）。
 */

/**
 * 解析结果。
 *
 * 两个坐标都要，因为用途不同：
 *   · `local` —— 点集**顶点属性空间**的坐标。给星点着色器用：拿它和每个顶点的
 *     `position` 比距离，就能让"选中那一颗"变大变亮，不必再传一个顶点下标
 *     （`gl_VertexID` 在 GLSL ES 1.00 里没有，传下标属性又要多一份 4 字节/点的开销）。
 *   · `world` —— 世界坐标。给标记环、冲击波、镜头用：它们是点集的**兄弟节点**，
 *     不在那个 `<group>` 里面，拿局部坐标会画到错误的位置。
 */
export interface AnchorHit {
  local: [number, number, number];
  world: [number, number, number];
}

/**
 * 按 `docId` 解析出坐标。**找到返回 true 并填好 `out`，找不到返回 false。**
 *
 * 找不到是**正常情况**，不是错误：点集在超上限时会被抽样（见 `points.ts` 的 `MAX_POINTS`），
 * 抽样后某些 docId 确实不在屏幕上 —— 这时"没有标记"才是诚实的（那颗星没画出来）。
 *
 * 刻意用"填 out"而不是"返回一个新对象"：这个函数每帧都会被调用，
 * 返回新对象等于每帧给 GC 交一笔垃圾。
 */
export type AnchorResolver = (docId: number, out: AnchorHit) => boolean;

/** 每个学科一个解析器（同时可能有八个团在场，不能只留一个）。 */
const resolvers = new Map<string, AnchorResolver>();

/**
 * 注册某学科的解析器，返回注销函数。
 *
 * 注销时**必须比对函数本身**再删：React 严格模式下 effect 会"挂载-卸载-再挂载"，
 * 若无条件 `delete`，后注册的那个会被先注册那个的清理函数删掉 ——
 * 表现为"标记环时有时无"，而且只在开发模式下复现。
 */
export function registerAnchorResolver(domain: string, fn: AnchorResolver): () => void {
  resolvers.set(domain, fn);
  return () => {
    if (resolvers.get(domain) === fn) resolvers.delete(domain);
  };
}

/** 问某学科要一篇论文的坐标。没有该学科的解析器、或该篇不在点集里 → false。 */
export function resolveAnchor(domain: string, docId: number, out: AnchorHit): boolean {
  const fn = resolvers.get(domain);
  if (!fn) return false;
  return fn(docId, out);
}

/** 造一个空的输出对象（调用方复用一个即可）。 */
export function emptyAnchorHit(): AnchorHit {
  return { local: [0, 0, 0], world: [0, 0, 0] };
}

/** 仅测试用：清空所有解析器，避免用例之间互相污染。 */
export function resetAnchorResolvers(): void {
  resolvers.clear();
}
