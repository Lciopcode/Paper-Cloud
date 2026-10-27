/**
 * 论文云 · **引用扇形**的纯计算
 * ============================================================================
 * 作者的要求：「点某星星时，这颗星星为中心显示，发散连接线为关联到**引用论文**」。
 *
 * 这一步和 `filamentGraph.ts` 的关系要说清楚，免得以后有人以为有两个公式：
 *
 *   · `buildFan`（filamentGraph.ts）= **语义近邻**扇形。它是降级方案，
 *     数据来自标题+摘要的嵌入（`semantic/<d>.route.bin`），**不是引用**。
 *   · `buildCiteFan`（本文件）   = **真实引用**扇形，数据来自
 *     `public/data/citations/<d>.bin`（Semantic Scholar 的 references）。
 *
 * 两者**输出同一个 `Fan` 类型**，所以画线段那部分代码（`Filaments.tsx` 的
 * 贝塞尔铺点、赤道环、生长/淡出）一个字都不用改 —— 换的只是"关系从哪来"。
 * 这条接口对齐是刻意的：渲染与数据源解耦，将来换第三个数据源也只动这里。
 *
 * ## 只有"两端都在当前点集里"的引用才画得出线
 *
 * 被引论文若不在当前渲染的点集里（抽样抽掉了、或它属于别的团），
 * 就没有坐标。这时**不画线**，但**面板里照样要列出来** —— 列表用的是引用表，
 * 与点集无关。这一条是刻意的：用户要信息，不是要一堆假线。
 */
import type { Fan, FanSegment, FanPoints } from "./filamentGraph.ts";
import { docIndex } from "./points.ts";

/** 单篇最多画多少条（与语义扇形同一个上限，见 Filaments.MAX_LINES） */
export const MAX_CITE_LINES = 600;

/**
 * 由"引用 docId 列表"造扇形。
 *
 * @param refs   本作引用的论文 docId（`CitationTable.refsOf` 的结果，已按升序）
 * @param points 当前点集（决定被引论文的坐标）
 * @param docId  本作 docId
 * @returns 找不到本作时返回 `null`；引用一篇都不在场时返回 `segments` 为空的 Fan
 *          （**空 Fan 不等于 null**：界面要能区分"没有引用数据"与"有引用但都不在画面里"）
 */
export function buildCiteFan(
  refs: ArrayLike<number>,
  points: FanPoints | undefined,
  docId: number,
  maxLines = MAX_CITE_LINES,
): Fan | null {
  if (!points || docId < 0) return null;
  const srcIdx = docIndex(points.docIds, docId);
  if (srcIdx < 0) return null;
  const sx = points.positions[srcIdx * 3];
  const sy = points.positions[srcIdx * 3 + 1];
  const sz = points.positions[srcIdx * 3 + 2];

  const segments: FanSegment[] = [];
  const ids = new Set<number>([docId]);
  let ringR = 0;
  let visible = 0;
  for (let i = 0; i < refs.length && segments.length < maxLines; i++) {
    const dst = refs[i];
    /**
     * 自环要跳过：一篇论文不可能引用自己。
     * 数据里出现这种边只可能是映射错位（arXiv 号撞号、版本归一没做干净），
     * 而它画出来是一条**零长度的线** —— 看不见，却占掉一条线位、还让"引用 40 篇"
     * 的数字对不上列表。宁可丢，也不要让一个明显的错数据在画面里静默存在。
     */
    if (dst === docId) continue;
    const di = docIndex(points.docIds, dst);
    // 被引论文不在当前点集里 ⇒ 没有坐标，不画线（列表里仍会列出来）
    if (di < 0) continue;
    visible++;
    ids.add(dst);
    const bx = points.positions[di * 3];
    const by = points.positions[di * 3 + 1];
    const bz = points.positions[di * 3 + 2];
    segments.push({
      ax: sx,
      ay: sy,
      az: sz,
      bx,
      by,
      bz,
      /**
       * 权重：引用边没有"强度"这个量（要么引了要么没引），
       * 但着色公式要一个 0.65~1 的值来决定"偏白还是偏本团色"。
       * 取 0.9 让引用线接近白色 —— 这是**有意的**：引用与语义近邻在画面上要能一眼分开，
       * 白线读作"文献关系"，带颜色的线读作"语义相似"。
       */
      w: 0.9,
      k: 1,
      phase: (i % 16) / 16,
    });
    ringR = Math.max(ringR, Math.hypot(bx - sx, bz - sz));
  }
  // `visible` 只用于诊断，挂在 Fan 之外会破坏类型对齐，所以不返回
  void visible;
  return { segments, ids, ringR };
}
