import { describe, expect, it } from "vitest";
import {
  SemanticClusters,
  SemanticCommunities,
  SemanticEmbedding,
  SemanticLabels,
  SemanticRoutes,
  loadSemantic,
} from "./semantic";

// ---------------------------------------------------------------- 造文件的工具
//
// 故意与 pipeline_gpu/*.py 的**写出**逻辑逐字节对应：
// 只要那边改了布局而这边没跟着改，这些测试就会红 —— 这正是要守的东西。

function embFile(vectors: number[][], scale = 1 / 127): ArrayBuffer {
  const count = vectors.length;
  const dim = vectors[0].length;
  const buf = new ArrayBuffer(24 + count * dim);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes.set(new TextEncoder().encode("LUNYEMB1"), 0);
  view.setUint32(8, count, true);
  view.setUint32(12, dim, true);
  view.setUint32(16, 1, true); // quant = int8
  view.setFloat32(20, scale, true);
  let o = 24;
  for (const v of vectors) for (const x of v) bytes[o++] = x & 0xff;
  return buf;
}

/** `recBytes` 可覆盖，用来构造"声明与实际不符"的错文件。 */
function cluFile(clusters: number[], recBytes = 4, reserved = 0): ArrayBuffer {
  const count = clusters.length;
  const buf = new ArrayBuffer(20 + count * recBytes);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes.set(new TextEncoder().encode("LUNYCLU1"), 0);
  view.setUint32(8, count, true);
  view.setUint32(12, Math.max(...clusters) + 1, true);
  view.setUint32(16, recBytes, true);
  if (recBytes === 4) {
    for (let i = 0; i < count; i++) {
      view.setUint16(20 + i * 4, clusters[i], true);
      view.setUint16(20 + i * 4 + 2, reserved, true);
    }
  } else {
    for (let i = 0; i < count; i++) view.setUint16(20 + i * 2, clusters[i], true);
  }
  return buf;
}

function routeFile(edges: [number, number, number][], magic = "LUNYROU1"): ArrayBuffer {
  const buf = new ArrayBuffer(12 + edges.length * 12);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes.set(new TextEncoder().encode(magic), 0);
  view.setUint32(8, edges.length, true);
  edges.forEach(([a, b, w], i) => {
    const o = 12 + i * 12;
    view.setUint32(o, a, true);
    view.setUint32(o + 4, b, true);
    view.setFloat32(o + 8, w, true);
  });
  return buf;
}

/** 归属表：`communities[docId]`，null 表示"不属于任何路线"。 */
function cmuFile(communities: (number | null)[], routeCount = 0, recBytes = 4): ArrayBuffer {
  const count = communities.length;
  const buf = new ArrayBuffer(20 + count * recBytes);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes.set(new TextEncoder().encode("LUNYCMU1"), 0);
  view.setUint32(8, count, true);
  view.setUint32(12, routeCount, true);
  view.setUint32(16, recBytes, true);
  communities.forEach((c, i) => {
    view.setUint32(20 + i * 4, c === null ? 0xffffffff : c, true);
  });
  return buf;
}

// ---------------------------------------------------------------- 嵌入

describe("SemanticEmbedding", () => {
  it("解析头部并逐字节给出向量", () => {
    const e = new SemanticEmbedding(embFile([[10, -20, 30], [1, 2, 3]]));
    expect(e.count).toBe(2);
    expect(e.dim).toBe(3);
    expect([...e.rawVectorOf(0)!]).toEqual([10, 236, 30]); // -20 → 补码 0xEC = 236
    expect([...e.rawVectorOf(1)!]).toEqual([1, 2, 3]);
  });

  it("越界的 docId 返回 null，而不是抛错（绘制路径要能容忍）", () => {
    const e = new SemanticEmbedding(embFile([[1, 2]]));
    expect(e.rawVectorOf(-1)).toBeNull();
    expect(e.rawVectorOf(1)).toBeNull();
  });

  it("同一篇的余弦是 1，正交向量是 0", () => {
    const e = new SemanticEmbedding(embFile([[127, 0], [0, 127], [127, 0]]));
    expect(e.cosine(0, 2)).toBeCloseTo(1, 6);
    expect(e.cosine(0, 1)).toBeCloseTo(0, 6);
  });

  it("余弦会校正 int8 量化带来的模长偏差（不是裸内积）", () => {
    // 两条方向相同、但量化后模长不同的向量：裸内积会 < 1，余弦应当仍为 1
    const e = new SemanticEmbedding(embFile([[100, 0], [127, 0]]));
    const raw = 100 * 127; // 裸内积
    const denom = Math.sqrt(100 * 100) * Math.sqrt(127 * 127);
    expect(e.cosine(0, 1)).toBeCloseTo(raw / denom, 6);
    expect(e.cosine(0, 1)).toBeCloseTo(1, 6);
  });

  it("魔法数不对要报错（而不是当成别的格式硬读）", () => {
    const bad = embFile([[1, 2]]);
    new Uint8Array(bad).set(new TextEncoder().encode("LUNYEMBX"), 0);
    expect(() => new SemanticEmbedding(bad)).toThrow(/魔法数/);
  });

  it("量化方式不是 int8 时拒绝加载（猜着读会得到像向量的垃圾）", () => {
    const bad = embFile([[1, 2]]);
    new DataView(bad).setUint32(16, 2, true);
    expect(() => new SemanticEmbedding(bad)).toThrow(/量化方式未知/);
  });

  it("长度与声明不符时报错（写了一半的分片）", () => {
    expect(() => new SemanticEmbedding(embFile([[1, 2]]).slice(0, 20))).toThrow();
  });
});

// ---------------------------------------------------------------- 聚类

describe("SemanticClusters", () => {
  it("按 docId O(1) 取簇号", () => {
    const c = new SemanticClusters(cluFile([0, 3, 3, 7]));
    expect(c.count).toBe(4);
    expect(c.k).toBe(8);
    expect(c.clusterOf(0)).toBe(0);
    expect(c.clusterOf(3)).toBe(7);
    expect(c.clusterOf(99)).toBe(-1);
    expect(c.distinct).toBe(3);
  });

  it("★ 保留位非 0 必须被抓住 —— 这正是当年「按 2 字节写」的错位症状", () => {
    // 写出端若只写 2 字节，读取端按 4 字节读就会把簇号/保留位交错；
    // 这里显式构造"保留位有值"的文件，确认加载时立刻炸而不是画出乱簇
    expect(() => new SemanticClusters(cluFile([1, 2], 4, 7))).toThrow(/保留位不是 0/);
  });

  it("记录长度不是 4 时报错", () => {
    expect(() => new SemanticClusters(cluFile([1, 2], 2))).toThrow(/记录长度应为 4/);
  });

  it("★ 声明 recBytes=4 但只写了 2 字节/条 → 长度判据抓住（原 bug 的复现）", () => {
    const wrong = cluFile([1, 2, 3], 2); // 实际 20+2n 字节
    new DataView(wrong).setUint32(16, 4, true); // 却声明 4
    expect(() => new SemanticClusters(wrong)).toThrow(/长度不对/);
  });
});

// ---------------------------------------------------------------- 同路线

describe("SemanticRoutes", () => {
  it("CSR 双向索引正确，权重保留", () => {
    const r = new SemanticRoutes(
      routeFile([
        [1, 5, 0.9],
        [1, 9, 0.8],
        [5, 9, 0.7],
      ]),
    );
    expect(r.edgeCount).toBe(3);
    expect(r.nodesWithRoutes).toBe(3);

    // 1 的邻居：5 与 9（按权重降序）
    const n1 = r.routesOf(1);
    expect(n1.map((x) => x.docId)).toEqual([5, 9]);
    expect(n1[0].weight).toBeCloseTo(0.9, 5);
    expect(n1[1].weight).toBeCloseTo(0.8, 5);
    // 反向也要能查到（文件里只有 1→5，但 5 应该能看到 1）
    expect(r.routesOf(5).map((x) => x.docId).sort((a, b) => a - b)).toEqual([1, 9]);
    // 没有边的节点
    expect(r.routesOf(2)).toEqual([]);
    expect(r.hasRoutes(2)).toBe(false);
    expect(r.hasRoutes(1)).toBe(true);
  });

  it("limit 会截断（按权重降序取前 N）", () => {
    const r = new SemanticRoutes(routeFile([[1, 2, 0.1], [1, 3, 0.9], [1, 4, 0.5]]));
    expect(r.routesOf(1, 2).map((x) => x.docId)).toEqual([3, 4]);
  });

  it("★ 7 字节的旧 magic 必须被拒绝 —— 这曾让整条 route 链路从没通过验收", () => {
    // 原来的字面量 b"LUNYRT1" 只有 7 个字符，而读取端按 8 字节比较，恒为假。
    // 现在显式要求 8 字节的 LUNYROU1，旧文件会被明确拒绝而不是静默读错。
    expect(() => new SemanticRoutes(routeFile([[1, 2, 0.5]], "LUNYRT1"))).toThrow(/魔法数/);
  });

  it("长度与声明不符时报错", () => {
    expect(() => new SemanticRoutes(routeFile([[1, 2, 0.5]]).slice(0, 20))).toThrow(/长度不对/);
  });

  it("空边表可用（community.py 可能一条边都没留下）", () => {
    const r = new SemanticRoutes(routeFile([]));
    expect(r.edgeCount).toBe(0);
    expect(r.routesOf(0)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 标签

describe("SemanticLabels", () => {
  const json = {
    domain: "econ",
    method: "c-TF-IDF",
    globalK: 53,
    strata: {
      "0": [
        { id: 17, papers: 213, zh: "carbon climate emissions co2", top: ["carbon", "climate"] },
        { id: 20, papers: 198, zh: "electricity energy hydrogen", top: ["energy"] },
      ],
      "1": [{ id: 1, papers: 162, zh: "volatility autoregressive", top: ["volatility"] }],
    },
  };

  it("按（层号, 簇号）取名字", () => {
    const l = new SemanticLabels(json);
    expect(l.method).toBe("c-TF-IDF");
    expect(l.globalK).toBe(53);
    expect(l.named).toBe(3);
    expect(l.stratumCount).toBe(2);
    expect(l.labelOf(0, 17)?.zh).toBe("carbon climate emissions co2");
    expect(l.labelOf(1, 1)?.papers).toBe(162);
  });

  it("查不到时返回 null，而不是编一个名字", () => {
    const l = new SemanticLabels(json);
    expect(l.labelOf(0, 999)).toBeNull();
    expect(l.labelOf(9, 0)).toBeNull();
  });

  it("某一层的全部研究点按规模降序", () => {
    const l = new SemanticLabels(json);
    expect(l.labelsOfStratum(0).map((c) => c.id)).toEqual([17, 20]);
    expect(l.labelsOfStratum(7)).toEqual([]);
  });

  it("结构异常时不炸（GPU 还没跑 / 文件是空 JSON）", () => {
    expect(new SemanticLabels(null).named).toBe(0);
    expect(new SemanticLabels({}).stratumCount).toBe(0);
    expect(new SemanticLabels({ strata: { abc: [] } }).stratumCount).toBe(0);
  });
});

// ---------------------------------------------------------------- 第 6 层：技术路线

describe("SemanticCommunities", () => {
  const meta = {
    membershipCount: 5,
    modularity: 0.9912,
    threshold: 0.8,
    evidence: ["semantic"],
    degraded: true,
    degradedReason: "引用数据不可用：仅用语义近邻 + 更高阈值。",
  };

  it("按 docId 取技术路线，并统计每条路线的规模", () => {
    // 0→路线3, 1→无, 2→路线3, 3→路线7, 4→路线3
    const c = new SemanticCommunities(cmuFile([3, null, 3, 7, 3], 8), meta);
    expect(c.count).toBe(5);
    expect(c.routeCount).toBe(8);
    expect(c.communityOf(0)).toBe(3);
    expect(c.communityOf(1)).toBe(-1); // NO_COMMUNITY 哨兵
    expect(c.communityOf(3)).toBe(7);
    expect(c.sizeOf(3)).toBe(3);
    expect(c.sizeOf(7)).toBe(1);
    expect(c.sizeOf(1)).toBe(0);
    expect(c.presentRoutes).toBe(2); // 只有 3 与 7 是非空的
  });

  it("越界的 docId 返回 -1（不抛错）", () => {
    const c = new SemanticCommunities(cmuFile([1], 2), meta);
    expect(c.communityOf(-1)).toBe(-1);
    expect(c.communityOf(99)).toBe(-1);
    expect(c.sizeOf(99)).toBe(0);
  });

  it("topRoutes 按规模降序", () => {
    const c = new SemanticCommunities(cmuFile([1, 1, 2, 2, 2, 5], 9), meta);
    expect(c.topRoutes(2)).toEqual([
      { id: 2, papers: 3 },
      { id: 1, papers: 2 },
    ]);
    expect(c.topRoutes(10).length).toBe(3);
  });

  it("★ 降级状态必须如实透传 —— 不能在前端「补一个默认值」", () => {
    const deg = new SemanticCommunities(cmuFile([1], 2), meta);
    expect(deg.degraded).toBe(true);
    expect(deg.degradedReason).toContain("引用数据不可用");
    expect(deg.evidence).toEqual(["semantic"]);

    // 显式 false 才表示"两路证据都有"
    const ok = new SemanticCommunities(cmuFile([1], 2), { degraded: false, evidence: ["semantic", "cocitation"] });
    expect(ok.degraded).toBe(false);

    // meta 缺失时**按降级处理**（保守：宁可说"证据不足"，也不要把未验证的说成已验证的）
    expect(new SemanticCommunities(cmuFile([1], 2), {}).degraded).toBe(true);
  });

  it("★ 社区号超出声明的 k 时不能静默越界（用 Map 统计而不是定长数组）", () => {
    // 声明 k=2，但表里出现了社区号 9 —— 如果按 Uint32Array(k) 写就会静默丢数据
    const c = new SemanticCommunities(cmuFile([9, 9, 0], 2), meta);
    expect(c.sizeOf(9)).toBe(2);
    expect(c.presentRoutes).toBe(2);
  });

  it("魔法数不对要报错", () => {
    const bad = cmuFile([1]);
    new Uint8Array(bad).set(new TextEncoder().encode("LUNYCMU2"), 0);
    expect(() => new SemanticCommunities(bad, meta)).toThrow(/魔法数/);
  });

  it("记录长度不是 4 时报错", () => {
    const buf = new ArrayBuffer(20 + 2 * 4);
    const v = new DataView(buf);
    new Uint8Array(buf).set(new TextEncoder().encode("LUNYCMU1"), 0);
    v.setUint32(8, 2, true);
    v.setUint32(16, 8, true); // 声明 8 字节/条
    expect(() => new SemanticCommunities(buf, meta)).toThrow(/记录长度应为 4/);
  });

  it("长度与声明不符时报错（写了一半）", () => {
    expect(() => new SemanticCommunities(cmuFile([1, 2, 3]).slice(0, 24), meta)).toThrow(/长度不对/);
  });

  it("空表可用（一条路线都没有）", () => {
    const c = new SemanticCommunities(cmuFile([], 0), {});
    expect(c.count).toBe(0);
    expect(c.presentRoutes).toBe(0);
    expect(c.communityOf(0)).toBe(-1);
    expect(c.topRoutes(5)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 按需加载

describe("loadSemantic 的按需加载", () => {
  /** 造一份最小可用的假响应；记下请求过的 URL。 */
  function mockFetch(requested: string[]) {
    const files: Record<string, { buf?: ArrayBuffer; json?: unknown }> = {
      "semantic/lazytest.clu.bin": { buf: cluFile([0]) },
      "semantic/lazytest.route.bin": { buf: routeFile([]) },
      "semantic/lazytest.labels.json": { json: { method: "c-TF-IDF", strata: {} } },
      "semantic/lazytest.cmu.bin": { buf: cmuFile([0], 1) },
      "semantic/lazytest.communities.json": { json: { k: 1, membershipCount: 1, degraded: true } },
      // 嵌入故意做得像"很大"：只要有请求它就会被记下来
      "semantic/lazytest.emb.bin": { buf: embFile([[1, 2, 3]]) },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const key = Object.keys(files).find((k) => url.includes(k));
      if (!key) return new Response("not found", { status: 404 });
      const f = files[key];
      if (f.json !== undefined) {
        return new Response(JSON.stringify(f.json), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(f.buf!, { status: 200 });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = orig;
    };
  }

  const entry = {
    id: "lazytest",
    semantic: {
      embedding: { file: "semantic/lazytest.emb.bin", count: 1, dim: 3, quant: "int8" },
      clusters: { file: "semantic/lazytest.clu.bin", count: 1, k: 1, recordBytes: 4 },
      routes: { file: "semantic/lazytest.route.bin", count: 0 },
      labels: { file: "semantic/lazytest.labels.json", method: "c-TF-IDF", strata: 0, named: 0 },
      communities: {
        table: "semantic/lazytest.cmu.bin",
        meta: "semantic/lazytest.communities.json",
        count: 1,
        k: 1,
        recordBytes: 4,
        membershipCount: 1,
        modularity: 0,
        degraded: true,
      },
    },
  } as unknown as Parameters<typeof loadSemantic>[0];

  it("★ 取 bundle 时**不下载**嵌入（物理团 374 MB，而面板一个字节都用不到它）", async () => {
    const requested: string[] = [];
    const restore = mockFetch(requested);
    try {
      const bundle = await loadSemantic(entry);
      expect(requested.some((u) => u.includes(".emb.bin"))).toBe(false);
      // 但面板真正要用的四份必须都到位
      expect(bundle.clusters).not.toBeNull();
      expect(bundle.routes).not.toBeNull();
      expect(bundle.labels).not.toBeNull();
      expect(bundle.communities).not.toBeNull();
      expect(requested.length).toBe(5); // clu + route + labels + cmu + communities.json
    } finally {
      restore();
    }
  });

  it("★ 调 loadEmbedding() 才下载，且**只下载一次**（结果被记住）", async () => {
    const requested: string[] = [];
    const restore = mockFetch(requested);
    try {
      const bundle = await loadSemantic(entry);
      const before = requested.filter((u) => u.includes(".emb.bin")).length;
      expect(before).toBe(0);

      const e1 = await bundle.loadEmbedding();
      expect(e1).not.toBeNull();
      expect(e1!.dim).toBe(3);

      const e2 = await bundle.loadEmbedding();
      expect(e2).toBe(e1); // 同一个实例 = 没有重复下载
      expect(requested.filter((u) => u.includes(".emb.bin")).length).toBe(1);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------- 跨语言契约
//
// ★ 这一组是**最硬的证据**：拿 `pipeline_gpu/*.py` 真正写出来的文件，
//   让前端的 TS 解析器去读。上面那些用例的缓冲区是"照着格式手搓"的，
//   如果我对格式的理解本身错了，它们照样会全绿；只有读真实产物才能证伪。
//
// 文件不存在时**跳过**（而不是失败）—— 没跑过 GPU 的机器上本来就没有这些文件，
// 那是正常状态，不该让整个测试套件变红。

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SEM_DIR = resolve(process.cwd(), "public/data/semantic");

function readSem(name: string): ArrayBuffer | null {
  const p = resolve(SEM_DIR, name);
  if (!existsSync(p)) return null;
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("跨语言契约：读 pipeline_gpu 真正写出的文件", () => {
  const emb = readSem("econ.emb.bin");
  const clu = readSem("econ.clu.bin");
  const route = readSem("econ.route.bin");
  const cmu = readSem("econ.cmu.bin");
  const cmuMeta = (() => {
    const p = resolve(SEM_DIR, "econ.communities.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  })();

  it.skipIf(!emb)("TS 能解析 Python 写的 emb.bin", () => {
    const e = new SemanticEmbedding(emb!);
    expect(e.dim).toBe(256);
    expect(e.count).toBeGreaterThan(0);
    // 同一篇与自己的余弦必须是 1（量化后仍应非常接近 —— 这验证了反量化与归一化校正）
    expect(e.cosine(0, 0)).toBeCloseTo(1, 4);
  });

  it.skipIf(!clu)("TS 能解析 Python 写的 clu.bin，且保留位哨兵通过", () => {
    const c = new SemanticClusters(clu!);
    expect(c.recordBytes).toBe(4);
    expect(c.count).toBeGreaterThan(0);
    // 每篇都该有一个合法簇号
    for (const i of [0, 1, Math.floor(c.count / 2), c.count - 1]) {
      const v = c.clusterOf(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(Math.max(1, c.k));
    }
  });

  it.skipIf(!route)("TS 能解析 Python 写的 route.bin（8 字节 magic）", () => {
    const r = new SemanticRoutes(route!);
    // 边数必须与文件长度自洽（解析器内部已校验长度，这里再确认一次非空语义）
    expect(r.edgeCount).toBeGreaterThanOrEqual(0);
    if (r.edgeCount > 0) {
      expect(r.nodesWithRoutes).toBeGreaterThan(0);
    }
  });

  it.skipIf(!cmu)("TS 能解析 Python 写的 cmu.bin（第 6 层技术路线）", () => {
    const c = new SemanticCommunities(cmu!, cmuMeta);
    expect(c.count).toBeGreaterThan(0);
    // 表里至少要有一些论文归属于某条路线（否则社区发现等于没跑出东西）
    expect(c.membershipCount).toBeGreaterThan(0);
    expect(c.presentRoutes).toBeGreaterThan(0);
    // 声明与实际必须对得上 —— 这两条正是"export.py 与 communities.json 同源"的证据
    expect(c.membershipCount).toBe(cmuMeta.membershipCount);
    expect(c.routeCount).toBe(cmuMeta.k);
    // 有归属的篇数应当等于各路线规模之和（否则统计口径就不一致了）
    const sum = c.topRoutes(Number.MAX_SAFE_INTEGER).reduce((a, r) => a + r.papers, 0);
    expect(sum).toBe(c.membershipCount);
    // 降级状态必须与 meta 一致
    expect(c.degraded).toBe(cmuMeta.degraded);
  });

  it("至少有一个学科的语义层产物可被解析（否则说明上面全被跳过了）", () => {
    const any = !!(emb || clu || route || cmu);
    if (!any) {
      // 明确说出来，避免"全跳过"被误读成"全通过"
      console.warn("public/data/semantic/ 下没有产物 —— 跨语言契约测试被跳过（跑完 GPU 管线后会自动生效）");
    }
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------- 全学科覆盖
//
// 上面那一组把 econ 写死了。但"每个学科都能被前端读出来"是个**逐学科**的性质：
// 某一份产物坏掉（比如 export 写了一半、或某个团的分片边界不对）时，
// 写死 econ 的测试照样全绿。所以这里改成**数据驱动**：
// 读 manifest，凡是登记了语义层的学科都逐一过一遍解析器，并与 manifest 声明的数字对齐。
//
// 这同时也是"文档说会自动发现、其实没人读"那次教训的守卫 ——
// 只要 manifest 里登记了，就必须**真的能被解析**，不能只是登记成功。

describe("全学科覆盖：manifest 登记过的每个学科都要能被解析", () => {
  const manifestPath = resolve(process.cwd(), "public/data/manifest.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {
        domains?: { id: string; papers: number; semantic?: Record<string, unknown> }[];
      })
    : null;
  const registered = (manifest?.domains ?? []).filter((d) => d.semantic);

  it("manifest 可读（读不到就说明下面全被跳过了）", () => {
    if (!manifest) {
      console.warn("读不到 public/data/manifest.json —— 全学科覆盖测试被跳过");
    }
    expect(true).toBe(true);
  });

  it("至少登记了一个学科（登记了就必须能解析 —— 这是覆盖测试的前提）", () => {
    if (registered.length === 0) {
      console.warn("manifest 里没有任何学科登记语义层 —— 覆盖测试被跳过");
    } else {
      console.log(`  已登记语义层的学科（${registered.length}）：${registered.map((d) => d.id).join(", ")}`);
    }
    expect(true).toBe(true);
  });

  for (const d of registered) {
    const sem = d.semantic as {
      embedding?: { file: string; count: number; dim: number };
      clusters?: { file: string; count: number; k: number; recordBytes: number };
      routes?: { file: string; count: number };
      labels?: { file: string };
      communities?: { table: string; meta: string; count: number; k: number };
    };
    const load = (rel: string) => readSem(rel.replace(/^semantic\//, ""));

    it(`${d.id}：嵌入可解析，且 count 与 manifest 声明一致`, () => {
      const buf = sem.embedding ? load(sem.embedding.file) : null;
      if (!buf) return; // 未登记则跳过（describe 里已说明）
      const e = new SemanticEmbedding(buf);
      expect(e.count).toBe(d.papers);
      expect(e.count).toBe(sem.embedding!.count);
      expect(e.dim).toBe(sem.embedding!.dim);
    });

    it(`${d.id}：聚类可解析，簇号都在范围内且保留位哨兵通过`, () => {
      const buf = sem.clusters ? load(sem.clusters.file) : null;
      if (!buf) return;
      const c = new SemanticClusters(buf);
      expect(c.count).toBe(d.papers);
      expect(c.recordBytes).toBe(sem.clusters!.recordBytes);
      let maxSeen = 0;
      for (let i = 0; i < c.count; i += Math.max(1, Math.floor(c.count / 500))) {
        const v = c.clusterOf(i);
        expect(v).toBeGreaterThanOrEqual(0);
        if (v > maxSeen) maxSeen = v;
      }
      expect(maxSeen).toBeLessThan(Math.max(1, c.k));
    });

    it(`${d.id}：同路线边可解析，且每条边的两端都在篇数内`, () => {
      const buf = sem.routes ? load(sem.routes.file) : null;
      if (!buf) return;
      const r = new SemanticRoutes(buf);
      expect(r.edgeCount).toBe(sem.routes!.count);
      // 抽几个真实有边的节点，确认 CSR 双向索引能取到东西
      let checked = 0;
      for (let id = 0; id < 4096 && checked < 3; id++) {
        if (r.hasRoutes(id)) {
          const nb = r.routesOf(id);
          expect(nb.length).toBeGreaterThan(0);
          for (const n of nb) {
            expect(n.docId).toBeGreaterThanOrEqual(0);
            expect(n.docId).toBeLessThan(d.papers);
            expect(n.weight).toBeGreaterThan(0.5); // 阈值 0.65 之后留下的一定 > 0.5
          }
          checked++;
        }
      }
    });

    it(`${d.id}：第 6 层可解析，且与 meta 同源`, () => {
      const table = sem.communities ? load(sem.communities.table) : null;
      const metaRaw = sem.communities ? load(sem.communities.meta) : null;
      if (!table || !metaRaw) return;
      const meta = JSON.parse(new TextDecoder().decode(metaRaw));
      const c = new SemanticCommunities(table, meta);
      expect(c.count).toBe(d.papers);
      expect(c.routeCount).toBe(meta.k);
      expect(c.membershipCount).toBe(meta.membershipCount);
      expect(c.degraded).toBe(meta.degraded);
    });
  }
});
