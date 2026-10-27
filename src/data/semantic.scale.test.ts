/**
 * 规模预演：物理团量级的路线表，前端解析要多久？
 * ============================================================================
 * 这是**可选的重型测试**，默认跳过（`describe.skipIf`）。要跑：
 *
 *     $env:HEAVY=1; node node_modules/vitest/vitest.mjs run src/data/semantic.scale.test.ts
 *     # bash: HEAVY=1 node node_modules/vitest/vitest.mjs run src/data/semantic.scale.test.ts
 *
 * ## 为什么值得单独留一个
 *
 * 第 6 层的阈值从 0.80 降到 0.65 之后，同路线边暴涨。按五个已完成团的实测外推
 * （加权 9.0 边/篇），物理团（146 万篇）会有约 **13.2M 条边**，
 * `route.bin` 约 **158 MB**。前端的 `SemanticRoutes` 会为它建一个 CSR 索引
 * （`neighbors` + `weights` 各 2×边数）。这些都是**算术推测** ——
 * 没有真跑过就不知道点一下「加载语义层」会不会卡住好几秒。
 *
 * 所以这里造一份**同规模**的合成路线表，实测建索引的耗时。
 * 它不校验正确性（那是小用例的事），只回答"要多久、要多少内存"。
 */
import { describe, expect, it } from "vitest";
import { SemanticRoutes } from "./semantic";

const HEAVY = process.env.HEAVY === "1";

/** 物理团的量级（146 万篇 / 约 13.2M 条边）。 */
const N_PAPERS = 1_463_588;
const N_EDGES = 13_200_000;
const HEAD = 12;
const REC = 12;

function synthRouteFile(nPapers: number, nEdges: number): ArrayBuffer {
  const buf = new ArrayBuffer(HEAD + nEdges * REC);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode("LUNYROU1"), 0);
  const view = new DataView(buf);
  view.setUint32(8, nEdges, true);
  // 每篇平均 nEdges*2/nPapers 条无向边；造的时候让 a 大致均匀铺开、b = a + 一个小偏移，
  // 保证 a < b 且不重复（与真实产物的约束一致）。
  const perPaper = Math.max(1, Math.floor((nEdges * 2) / nPapers));
  let e = 0;
  for (let a = 0; a < nPapers && e < nEdges; a++) {
    for (let d = 1; d <= perPaper && e < nEdges; d++) {
      const o = HEAD + e * REC;
      view.setUint32(o, a, true);
      view.setUint32(o + 4, Math.min(a + d, nPapers - 1), true);
      view.setFloat32(o + 8, 0.7, true);
      e++;
    }
  }
  return buf;
}

describe("规模预演（默认跳过，HEAVY=1 才跑）", () => {
  it.skipIf(!HEAVY)(
    `${N_EDGES.toLocaleString()} 条边（物理团量级）建 CSR 索引的耗时`,
    () => {
      const t0 = Date.now();
      const buf = synthRouteFile(N_PAPERS, N_EDGES);
      const tGen = Date.now() - t0;

      const t1 = Date.now();
      const r = new SemanticRoutes(buf);
      const tParse = Date.now() - t1;

      const mb = (n: number) => (n / 1e6).toFixed(1);
      console.log(
        `\n  合成文件 ${mb(buf.byteLength)} MB（造它花了 ${tGen} ms）\n` +
          `  建索引 ${tParse} ms · 边数 ${r.edgeCount.toLocaleString()} · ` +
          `节点 ${r.nodesWithRoutes.toLocaleString()}\n` +
          `  CSR 占用约 ${mb((r.edgeCount * 2 * 4 * 2))} MB（neighbors + weights 各 2×边数）`,
      );

      // 判据：不该慢到把界面卡住（主线程上 >2 秒用户就会觉得"卡了"）
      expect(r.edgeCount).toBe(N_EDGES);
      expect(tParse).toBeLessThan(2000);

      // 取一个真有边的节点，确认查询是常数级
      const t2 = Date.now();
      for (let i = 0; i < 1000; i++) r.routesOf(i, 12);
      const tQuery = Date.now() - t2;
      console.log(`  1000 次 routesOf(限 12) 共 ${tQuery} ms（每次 ${(tQuery / 1000).toFixed(3)} ms）`);
      expect(tQuery).toBeLessThan(2000);
    },
    // 造 156 MB 的缓冲 + 建索引，给足时间
    120_000,
  );

  it.skipIf(HEAVY)("（规模预演默认跳过 —— 设 HEAVY=1 才跑）", () => {
    expect(true).toBe(true);
  });
});
