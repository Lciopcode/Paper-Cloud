/**
 * 论文云 · 关系扇形的**纯计算**
 * ============================================================================
 * "选中一篇论文，它和谁有关系"——这件事算一次，给两个地方用：
 *   · `Filaments` 用它画线；
 *   · `StarLayer` 用它决定**哪些星要保持亮着**（其余退到 22%，把焦点让出来）。
 *
 * ## 为什么必须抽成公共函数
 *
 * 两处各算一遍就是**第二份公式**：哪天"关系"的定义改了（比如从 1+2 跳改成同社区），
 * 改了线、忘了星，画面上会变成"线和亮着的星对不上"——而那种错看起来
 * 只是"有些星莫名其妙暗着"，很难联想到原因。`anchor.ts` 顶部对同一类问题有更长的说明。
 *
 * ## 算的是什么
 *
 *   · **1 跳**：从选中星射向它自己的同路线论文（每篇最多 K 条，权重最高的那些）；
 *   · **2 跳**：邻居的邻居（去重、去自环），铺一层更淡的网；
 *   · **关系集 `ids`**：只收**当前点集里在场**的 docId —— 不在场的星没得可亮，
 *     而把它们也算进来会让人以为"某颗星该亮却没亮"。
 *
 * 刻意**不做的事**：不生成 three 的对象、不碰 React、不读全局状态。
 * 输入输出都是普通数据，于是它可以被单元测试直接验证。
 */
import { edgesOfSource, type FilamentEdges } from "../data/assets.ts";
import { docIndex } from "./points.ts";

/** 一段线：起点在 `a`、终点在 `b`；`k` 是亮度系数（2 跳乘 0.42） */
export interface FanSegment {
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  /** 关系强度（0.65~1），用来决定颜色偏白还是偏本团色 */
  readonly w: number;
  /** 亮度系数：1 跳 = 1，2 跳 = HOP2_DIM */
  readonly k: number;
  /** 生长相位（错开一点，线才是"喷出去"而不是"推出去"） */
  readonly phase: number;
}

export interface Fan {
  readonly segments: readonly FanSegment[];
  /** 关系集：被选中那篇 + 1/2 跳里**在场**的那些 docId */
  readonly ids: ReadonlySet<number>;
  /** 赤道环半径：邻居的水平最大距离（0 = 没有邻居） */
  readonly ringR: number;
}

/** 2 跳的线亮度系数（与 `Filaments` 里的常量同源） */
export const HOP2_DIM = 0.42;
/** 默认最多画多少条 */
export const MAX_LINES = 600;

export interface FanPoints {
  readonly docIds: Uint32Array;
  readonly positions: Float32Array;
  readonly count: number;
}

/** 把一条无向边归一成可去重的 key（两个 docId 都 < 2^22，拼进一个数不会溢出 2^53） */
export function pairKey(a: number, b: number): number {
  return a < b ? a * 4194304 + b : b * 4194304 + a;
}

/**
 * 算出选中星的扇形邻域。找不到那颗星（不在当前点集里）时返回 `null`。
 */
export function buildFan(
  edges: FilamentEdges | undefined,
  points: FanPoints | undefined,
  docId: number,
  maxLines = MAX_LINES,
): Fan | null {
  if (!edges || !points || docId < 0) return null;
  const srcIdx = docIndex(points.docIds, docId);
  if (srcIdx < 0) return null;
  const sx = points.positions[srcIdx * 3];
  const sy = points.positions[srcIdx * 3 + 1];
  const sz = points.positions[srcIdx * 3 + 2];

  const segments: FanSegment[] = [];
  const ids = new Set<number>([docId]);
  const seen = new Set<number>();
  const neighbours: number[] = [];
  let ringR = 0;

  // ---- 1 跳
  const own = edgesOfSource(edges, docId);
  if (own) {
    for (let i = own.start; i < own.end && segments.length < maxLines; i++) {
      const dst = edges.dst[i];
      const bx = edges.b[i * 3];
      const by = edges.b[i * 3 + 1];
      const bz = edges.b[i * 3 + 2];
      segments.push({ ax: sx, ay: sy, az: sz, bx, by, bz, w: edges.weight[i], k: 1, phase: (i % 16) / 16 });
      seen.add(pairKey(docId, dst));
      neighbours.push(dst);
      ringR = Math.max(ringR, Math.hypot(bx - sx, bz - sz));
    }
  }

  // ---- 2 跳（按 docId 升序，画面稳定可复现）
  neighbours.sort((a, b) => a - b);
  for (const nb of neighbours) {
    if (segments.length >= maxLines) break;
    const nbIdx = docIndex(points.docIds, nb);
    if (nbIdx < 0) continue; // 邻居自己不在场，就没有可见的起点
    ids.add(nb);
    const bx0 = points.positions[nbIdx * 3];
    const by0 = points.positions[nbIdx * 3 + 1];
    const bz0 = points.positions[nbIdx * 3 + 2];
    const nbEdges = edgesOfSource(edges, nb);
    if (!nbEdges) continue;
    for (let i = nbEdges.start; i < nbEdges.end && segments.length < maxLines; i++) {
      const dst = edges.dst[i];
      if (dst === docId) continue;
      const key = pairKey(nb, dst);
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push({
        ax: bx0, ay: by0, az: bz0,
        bx: edges.b[i * 3], by: edges.b[i * 3 + 1], bz: edges.b[i * 3 + 2],
        w: edges.weight[i], k: HOP2_DIM, phase: (i % 16) / 16,
      });
      if (docIndex(points.docIds, dst) >= 0) ids.add(dst);
    }
  }

  return { segments, ids, ringR };
}
