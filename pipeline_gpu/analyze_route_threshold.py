#!/usr/bin/env python3
"""
论文云 · 同路线阈值的诊断工具
================================================================================
回答一个问题：**`community.py` 的 `--sim-threshold` 取多少才合理**？
它读 `knn-k*.bin`（精确的近邻与余弦值），对一串候选阈值报告：

    · 保留多少条边、涉及多少节点
    · 连通分量个数、最大分量占比、孤立小分量的比例
    · 用 igraph 跑一次 Leiden 得到的社区数与**规模分布**（最大/单例）
    · 单例社区（只有 1–2 篇）的比例 —— 这类"路线"没有意义，比例越低越好

## 判据：别看模块度

最早这里写的是"模块度接近 1 就是图碎了"，还配了 econ/bio 在 **0.80** 下的实测
（最大社区 8 篇、模块度 0.9912）。那个**现象**是真的，但把它当成**规律**是错的 ——
数学团（575,978 篇）在 0.65 下模块度 **0.927**，比 econ 的 0.713 高得多，
可它最大社区有 **56,560 篇**，图根本没碎。模块度接近 1 有两种**相反**的成因
（图碎成很多小块 / 真有强社区结构），单看它分不开。

**所以判据是「最大社区够不够大 + 单例社区够不够少」。**

    math 0.65：最大社区 56,560 · 单例 2,627 · 分量 3,399 · 模块度 0.927   ← 好
    math 0.80：最大社区    969 · 单例 27,300 · 分量 37,832 · 模块度 0.995  ← 碎

> ⚠️ **这些数字必须与本工具的 `weights` 设置一致。** 本工具曾经漏传权重
> （跑无权重 Leiden），给出的 0.65 行是"3,452 社区 / 最大 56,725"，
> 而产物是"3,475 / 56,560"。修好后**判据就是"能不能复现产物"**：
>
>     analyze_route_threshold.py --domain math --thresholds 0.65
>       vs  semantic/math/communities.json 里 membership 现算 → 逐项相同 ✅

本工具**不改任何数据**，只打印这张表。

用法：
    python pipeline_gpu/analyze_route_threshold.py --domain econ
    python pipeline_gpu/analyze_route_threshold.py --all
    python pipeline_gpu/analyze_route_threshold.py --domain physics --thresholds 0.60,0.65,0.70,0.80
        # 大团上全扫 9 档要很久（每档都要跑一次 Leiden），用这个只扫关键几档
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEM = ROOT / "semantic"

CANDIDATES = [0.50, 0.55, 0.60, 0.62, 0.65, 0.68, 0.70, 0.75, 0.80]


def load_knn(domain: str, k: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    p = SEM / domain / f"knn-k{k}.bin"
    if not p.exists():
        raise SystemExit(f"找不到 {p}（先跑 knn.py --domain {domain}）")
    raw = p.read_bytes()
    if raw[:8] != b"LUNYKNN1":
        raise SystemExit(f"{p} 魔法数不对")
    n, kk, dim = struct.unpack_from("<III", raw, 8)
    body = raw[20:]
    cnt = len(body) // 12
    arr = np.frombuffer(body, dtype=np.dtype([("a", "<u4"), ("b", "<u4"), ("w", "<f4")]), count=cnt)
    return arr["a"].copy(), arr["b"].copy(), arr["w"].copy(), n


def components(lo: np.ndarray, hi: np.ndarray, size: int) -> tuple[int, int, int]:
    """连通分量：返回 (分量数, 最大分量节点数, 只有 1–2 个节点的分量数)。

    ⚠️ `lo`/`hi` 里是 **docId 原值**（0 .. 篇数-1），不是紧凑的节点下标 ——
    所以并查集必须按**篇数**开，而不是按"出现过的节点数"开。
    （第一版就是按后者开的，于是 docId >= 出现节点数时 IndexError。）
    用并查集手写，避免为这一步引入 scipy 依赖。

    ⚠️ **这是没有 igraph 时的兜底路径，慢得多**：它逐条边做 Python 级 find，
    物理团量级（2,930 万条边）要跑几十秒到几分钟。
    有 igraph 时**不走这里** —— 图已经建好了，直接问 `g.connected_components()`
    （C 实现）。两条路径在 econ 上实测给出**完全相同**的数字（见提交信息）。
    """
    parent = np.arange(size, dtype=np.int64)

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in zip(lo.tolist(), hi.tolist()):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    # 只统计真正出现过的节点
    present = np.unique(np.concatenate([lo, hi]))
    roots = np.array([find(int(i)) for i in present.tolist()], dtype=np.int64)
    uniq, counts = np.unique(roots, return_counts=True)
    return len(uniq), int(counts.max()), int((counts <= 2).sum())


def analyze(domain: str, k: int = 20, candidates: list[float] | None = None) -> None:
    a, b, w, n = load_knn(domain, k)
    print(f"\n=== {domain}（{n:,} 篇 · {len(a):,} 条近邻边）===")
    print(f"  余弦分布：min {w.min():.3f} · 中位 {np.median(w):.3f} · "
          f"p90 {np.percentile(w, 90):.3f} · max {w.max():.3f}")

    try:
        import igraph as ig
        import leidenalg
    except ImportError:
        ig = None

    print(f"\n  {'阈值':>6} {'边数':>10} {'节点':>9} {'分量':>7} {'最大占比':>8} "
          f"{'≤2篇分量':>9} {'社区数':>7} {'最大社区':>8} {'单例社区':>8} {'模块度':>7}")
    for th in (candidates or CANDIDATES):
        keep = w >= th
        if not keep.any():
            print(f"  {th:>6.2f} {0:>10} {'—':>9}")
            continue
        lo = np.minimum(a[keep], b[keep]).astype(np.uint64)
        hi = np.maximum(a[keep], b[keep]).astype(np.uint64)
        key = lo * np.uint64(1 << 32) + hi
        uniq_key, idx = np.unique(key, return_index=True)
        lo, hi = lo[idx], hi[idx]

        nodes = np.unique(np.concatenate([lo, hi]))

        nc = maxc = singles = 0
        mod = 0.0
        if ig is not None:
            # ⚠️ 这里原来写成 `{int(v): i for i, v in enumerate(nodes)}` 再做
            #    `[(node_index[int(x)], node_index[int(y)]) for x, y in zip(lo, hi)]` ——
            #    在物理团量级是 2,930 万次 dict 查找 + 一个 2,930 万元素的元组列表
            #    （约 2 GB）。`nodes` 本来就是有序的（来自 np.unique），
            #    所以"值 → 下标"就是一次二分查找：用 searchsorted 全向量化。
            idx_lo = np.searchsorted(nodes, lo)
            idx_hi = np.searchsorted(nodes, hi)
            g = ig.Graph(n=len(nodes), edges=np.column_stack([idx_lo, idx_hi]).tolist(),
                         directed=False)
            # 边权 = 余弦值。**这一行原来也是漏的** —— 没有它，下面 `weights="weight"`
            # 会找不到属性；而在此之前是压根没传 weights（见下）。
            g.es["weight"] = w[keep][idx].tolist()
            # 图已经建好，分量直接问 igraph —— 比上面的 Python 并查集快一个量级。
            # 等价性：图的顶点集就是"出现在边里的节点"，没有孤立点，
            # 所以 igraph 的分量划分与并查集的结果是同一个划分。
            cc = g.connected_components()
            cc_sizes = np.array(cc.sizes(), dtype=np.int64)
            ncomp = len(cc_sizes)
            biggest = int(cc_sizes.max()) if ncomp else 0
            tiny = int((cc_sizes <= 2).sum())

            # ⚠️ **必须传 weights，否则这个工具算的不是 `community.py` 会算的东西。**
            #    这里原来漏了 `weights="weight"` —— 于是它跑的是**无权重** Leiden，
            #    而生产跑的是**有权重**（边权 = 余弦值）Leiden。两者目标函数不同，
            #    数字对不上（math @ 0.65：无权重 3,452 社区 / 最大 56,725；
            #    有权重 3,475 社区 / 最大 56,560）。方向性结论恰好一致，
            #    但**判据工具给出的具体数字不能代表产物** —— 那正是它存在的意义。
            part = leidenalg.find_partition(
                g, leidenalg.RBConfigurationVertexPartition,
                weights="weight",
                resolution_parameter=1.0, seed=20260101,
            )
            sizes = np.array([len(c) for c in part], dtype=np.int64)
            nc = len(sizes)
            maxc = int(sizes.max()) if nc else 0
            singles = int((sizes <= 2).sum())
            mod = float(part.modularity)
        else:
            ncomp, biggest, tiny = components(lo, hi, n)

        print(f"  {th:>6.2f} {len(lo):>10,} {len(nodes):>9,} {ncomp:>7,} "
              f"{biggest / max(1, len(nodes)):>7.1%} {tiny:>9,} "
              f"{nc:>7,} {maxc:>8,} {singles:>8,} {mod:>7.3f}")

    print("\n  读法：**别只看模块度** —— 它接近 1 有两种相反成因"
          "（图碎成很多小块 / 真有强社区结构），单看分不开。")
    print("        判据是「最大社区够不够大」+「单例社区（≤2 篇）够不够少」——")
    print("        8 篇论文组成的『技术路线』没有意义。")


def parse_thresholds(s: str) -> list[float]:
    """把 `--thresholds 0.60,0.65,0.70` 解析成列表（也接受空格分隔）。"""
    parts = [p for p in s.replace(",", " ").split() if p]
    if not parts:
        raise argparse.ArgumentTypeError("--thresholds 不能为空")
    try:
        vals = sorted({float(p) for p in parts})
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"--thresholds 里有不是数字的项：{e}") from e
    for v in vals:
        if not 0.0 <= v <= 1.0:
            raise argparse.ArgumentTypeError(f"阈值应在 0..1 之间，收到 {v}")
    return vals


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument(
        "--thresholds", type=parse_thresholds, default=None,
        help=f"只扫这几档（逗号分隔），默认全扫 {CANDIDATES}。"
             f"大团上全扫很慢（每档一次 Leiden），例如 --thresholds 0.60,0.65,0.70,0.80",
    )
    args = ap.parse_args()

    if args.all:
        doms = sorted(d.name for d in SEM.iterdir() if (d / f"knn-k{args.k}.bin").exists())
    elif args.domain:
        doms = [args.domain]
    else:
        raise SystemExit("必须给 --domain <id> 或 --all")

    for d in doms:
        analyze(d, args.k, args.thresholds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
