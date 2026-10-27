#!/usr/bin/env python3
"""
论文云 · 语义层第 4 步：社区发现 + 同路线边（八层结构第 6 层 / 第三类关系）
================================================================================
用户对第三类关系的原话是「**同一路线**」。这个说法比"相似"严格，所以这里
**不把"向量相似"直接当路线**，而是要求两条独立证据都成立：

  路线 = 语义近邻 ∩ 共被引

  证据 1（语义）：k-NN 图上的边（`knn.py` 产出，余弦 ≥ 阈值）
  证据 2（引用）：两篇论文被同一批论文引用（共被引），或直接互相引用

只有语义相似、没有任何学术关联的论文，不画路线 —— 那只是"用词像"。
反过来只有引用、语义不沾的（比如综述引用了完全不相关的领域），也不画。

> ⚠️ **本次交付里证据 2 是缺席的，所以每个学科都会降级。** 这不是没接线，
> 是**数据里就没有"谁引用了谁"**（依据见 `load_cocitation()` 的注释）：
>   · `data/cites/<学科>.bin` —— **一篇一条的引用计数表**：
>     `u32 cites | u16 year | u8 venueTier | u8 flags`，按 docId 索引。
>     物理团 11,708,704 ÷ 8 = **1,463,588 条**，正好等于物理团论文数，
>     所以是"每篇一个数"，**不含引用对**；
>   · `public/data/cites/<学科>.bin` —— `LUNYCITE` **亮度表**，
>     每篇 8 字节（引用数 | 期刊档 | 引用档 | 保留），也**不含引用对**。
> 要真正启用这一路，需要一份"引用者 → 被引者"的有向边表；本仓库任何文件
> 都不是这个格式。注意**继续跑现有的抓取器也补不上** ——
> `pipeline/harvest-cites.mjs` 抓的是引用**次数**（给"亮度"编码用），
> 它本身不产出边。要拿到边得走 S2 的 `/references` 那条路，
> 当前被配额卡住（两条路各自的障碍见 `docs/HANDOFF-当前状态与后续.md` §3.3）。

因此脚本**总是**降级为"仅语义近邻 + 更高的相似度阈值"，并把这一事实写进
输出的 meta 里 —— 不允许静默地把"相似"当"同路线"。

## 相似度阈值取多少：0.65（这是量出来的，不是拍的）

原来的默认值是 **0.80**，而实测它把图**切得太碎**，第 6 层因此没有意义。
用 `analyze_route_threshold.py` 在三个已跑完的团上量（bge-m3 / 256 token / k=20）：

| 阈值 | econ 最大社区 | qfin 最大社区 | bio 最大社区 | 模块度 |
|---:|---:|---:|---:|---|
| 0.60 | 2,907 | 2,356 | 7,637 | 0.69–0.87 |
| **0.65** | **1,775** | **1,646** | **4,344** | **0.71–0.86** |
| 0.70 | 362 | 578 | 2,293 | 0.84–0.90 |
| 0.80 | **8** | **21** | **47** | **0.99+** |

> ⚠️ **这张表的 0.65 行必须与产物一致。** 它们现在是**有权重** Leiden 的结果
> （就是这个脚本跑的那个），所以 econ/qfin/bio 三列分别是 **1,775 / 1,646 / 4,344**，
> 与 `semantic/<d>/communities.json` 里 `membership` 现算出来的**完全相同**。
> 早先这张表填的是 **1,612 / 1,858 / 4,723** —— 那是
> `analyze_route_threshold.py` **漏传 `weights`** 时算的（无权重 Leiden），
> 数字对不上产物。已修工具并重新量（见那个脚本里的注释）。

三团的余弦分布也很一致（中位 0.633 / 0.645 / 0.646，p90 ≈ 0.70）——
**0.80 落在 p99.5 之外**，于是 95% 以上的论文根本没有同路线邻居：
econ 只剩 672/12,486 篇有归属、最大"技术路线"只有 **8 篇**、299 个社区里 249 个 ≤2 篇。

> ⚠️ **别把模块度当判据。** 它接近 1 有两种完全相反的成因：
>   ① 图**断成很多小块**（碎片化，坏）；② 真有**强社区结构**（好）。
> 光看模块度分不开这两者，必须一起看**最大社区**和**单例社区**。
>
> 数学团就是反例（`--domain math`，575,978 篇）：
>
> | 阈值 | 最大社区 | 单例社区 | 连通分量 | 模块度 |
> |---:|---:|---:|---:|---:|
> | 0.60 | 58,683 | 195 | 272 | 0.939 |
> | **0.65** | **56,560** | 2,627 | 3,399 | **0.927** |
> | 0.70 | 22,287 | 14,905 | 22,025 | 0.929 |
> | 0.80 | **969** | 27,300 | 37,832 | 0.995 |
>
> 0.65 的模块度 0.927 **比 econ 的 0.713 高得多，但它显然不是碎片** ——
> 最大社区有 **56,560 篇**。真碎的是 0.80：最大社区只剩 969 篇、单例 27,300、
> 连通分量 37,832。所以"0.65 ⇒ 模块度落在 0.71–0.86"这个说法是
> **按五个小团归纳出来的、已被数学团证伪**，不要再当规律用；
> **判据是"最大社区够不够大 + 单例占比够不够低"**。

所以默认值改成 **0.65**：最大社区上千篇（econ 1,775 / qfin 1,646 / bio 4,344 /
math 56,560），模块度 0.71–0.93，社区数随学科规模增长（econ 222 / qfin 156 / bio 580）。
有引用证据时再放松 0.10（两路证据交叉，单看语义那一路可以弱一些）。

要按学科微调就跑 `analyze_route_threshold.py` 看那张表，再传 `--sim-threshold`。

## 输出
- `semantic/<domain>/route.bin`：u32 a + u32 b + f32 weight（a < b，按 a 升序）
- `semantic/<domain>/communities.json`：社区划分 + 降级状态（供 export.py 转成第 6 层）

用法：
    python community.py --domain cs
    python community.py --domain cs --sim-threshold 0.62
"""
from __future__ import annotations

import argparse
import json
import struct
import sys


# ---- 输出加固（Windows 上必做）----
# Windows 控制台默认是 GBK，打印 'OK'/'FAIL'/'=>' 这类字符会抛 UnicodeEncodeError
# 而**直接崩掉**，且崩在 log 里，看起来像程序逻辑有错（实测踩过：cluster.py --help
# 就因为 help 里的 '=>' 而崩）。这里统一把 stdout/stderr 改成 UTF-8 并容错。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public" / "data"
SEM = ROOT / "semantic"
# ⚠️ 抓取产物在 `data/cites/`，不是 `data/citations/`（后者是 v1 时代的旧目录，本仓库里不存在）。
#    路径写错时 `load_cocitation()` 只会安静地返回 None —— 看起来像"还没抓引用"，
#    而不像"路径写错了"，于是共被引证据无声地永远缺席。
CIT = ROOT / "data" / "cites"

#: route.bin 的 magic，**必须是 8 字节**。
#:
#: 原来这里写的是 `b"LUNYRT1"` —— 那是 **7** 个字符，而头部布局
#: （以及 export.py / register.py / verify_semantic.py 的读取）全都按
#: "8 字节 magic + offset 8 取 count" 设计。后果是**整条 route 链路从来没通过过**：
#:   · 写出的是 7+4+n×12 字节；
#:   · 读取端 `raw[:8] == b"LUNYRT1"`（8 字节 vs 7 字节）**恒为假**；
#:   · offset 8 取到的 count 整体错位，长度判据必然失败；
#:   · `register.py` 因此**永远发现不了** routes。
#: 同目录其余 12 个 magic（LUNYEMBS/LUNYEMB1/LUNYCLU1/LUNYKNN1/LUNYRANK/
#: LUNYSPN1/LUNYSPD1/LUNYNBR1/LUNYCITE/LUNYIDX1/LUNYMETA）都是 8 字节，只有它漏了一个字符。
#: 所以下面那句 assert 是有意留着的：**别再让它变成 7 字节**。
MAGIC_ROUTE = b"LUNYROU1"
assert len(MAGIC_ROUTE) == 8, "route 的 magic 必须是 8 字节（头部偏移全依赖这一点）"


def log(m: str) -> None:
    print(m, flush=True)


def load_knn(domain: str, k: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    p = SEM / domain / f"knn-k{k}.bin"
    if not p.exists():
        raise SystemExit(f"找不到 {p}（先跑 knn.py --domain {domain} --k {k}）")
    raw = p.read_bytes()
    if raw[:8] != b"LUNYKNN1":
        raise SystemExit(f"{p} 魔法数不对")
    n, kk, dim = struct.unpack_from("<III", raw, 8)
    body = raw[20:]
    if len(body) % 12:
        raise SystemExit(f"{p} 长度不是 12 的整数倍 —— 写了一半？")
    cnt = len(body) // 12
    arr = np.frombuffer(body, dtype=np.dtype([("a", "<u4"), ("b", "<u4"), ("w", "<f4")]), count=cnt)
    log(f"近邻：{cnt:,} 条边（{n:,} 篇 × k={kk}）")
    return arr["a"].copy(), arr["b"].copy(), arr["w"].copy()


def load_cocitation(domain: str) -> dict[tuple[int, int], float] | None:
    """
    探测本机的引用数据**是否足以算共被引**，够就返回"共被引对 → 权重"，不够返回 None。

    这个函数以前是个会误导人的桩：docstring 写着"算共被引对"，
    函数体却只读了一个 magic 就**无条件 `return None`**，还留着"见 TODO"。
    下面把"为什么不够"查清楚了，写死在这里 —— 免得下一个人以为只是没接完线。

    ## 本交付里为什么恒为 None

    唯一一份**能**算共被引的输入，是"谁引用了谁"的有向边表。本仓库没有这个文件：

    | 文件 | 真实内容 | 能不能算共被引 |
    |---|---|---|
    | `data/cites/<学科>.bin` | **一篇一条的引用计数表**（`harvest-cites.mjs` 产出）：`u32 cites \| u16 year \| u8 venueTier \| u8 flags`，**按 docId 索引**（第 i 条 = docId i） | ❌ 只有计数，无引用对 |
    | `public/data/cites/<学科>.bin` | `LUNYCITE` 亮度表（由上面那份经 `build-cites.mjs` 生成）：每篇 8 字节（引用数/期刊档/引用档/保留） | ❌ 只有计数，无引用对 |

    实测依据（`physics`）：11,708,704 字节 ÷ 8 = **1,463,588 条**，
    正好等于物理团的论文数 ⇒ **一篇一条**。头 8 字节 `19 00 00 00 c2 07 00 00`
    是 **docId 0 的那条记录本身**（cites=25、year=1986、venueTier=0、flags=0）——
    这个文件**没有文件头，是纯记录数组**，所以下面那句 magic 检查必然不通过，
    这不是"抓坏了"，而是格式本来如此。

    > ⚠️ 我最初把这条记录读成了 `(docId=25, 年份=1986)` —— **读错了**。
    > `u32` 那个字段是**引用数**不是 docId（物理团该字段最大 20,140、只有 1,665 个
    > 不同值，显然不是一个 id 序列）。真正的依据在产出方的注释里
    > （`pipeline/harvest-cites.mjs` 顶部写了布局），**不该靠猜字节**。

    结论不变：**即使把 magic 校验去掉也没用**，因为文件里没有"谁引用了谁"。
    但要说准"缺的是什么、怎么补"：
      · 跑现有的 `harvest-cites.mjs` **补不上** —— 它抓的是引用**次数**（亮度用），
        不是边；
      · 要边得走 S2 的 `/references`（不能批量，一篇一次请求）或 OpenAlex 的
        `referenced_works`（要先建一张 ID 映射表，约 30 天配额）——
        两条路的障碍都在 `docs/HANDOFF-当前状态与后续.md` §3.3，
        拿到 API key 之后是可做的，**不是永远做不了**。

    调用方只需知道"None ⇒ 降级"，不要把它当成"引用还没抓"。
    """
    p = CIT / f"{domain}.bin"
    if not p.exists():
        return None
    raw = p.read_bytes()
    if raw[:8] != b"LUNYCITE":
        # 走到这里说明读到的是 harvest-cites 的产出：**没有文件头的纯记录数组**，
        # 每条 8 字节 = 一篇论文的引用数/年份/期刊档/flags。
        # 如实说清缺的是什么 —— 只说"跳过引用证据"听起来像"配好了但没数据"。
        log(f"  （{p} 无 LUNYCITE magic —— 它是一篇一条的引用计数表"
            f"（u32 cites|u16 year|u8 venueTier|u8 flags，按 docId 索引），"
            f"不含引用对，共被引这一路缺席）")
        return None
    # 有 magic 也仍然不算：本仓库里带 LUNYCITE 的是**亮度表**（一篇一条的计数），
    # 不是边表。别在这里凭空解析出"对"来 —— 那才是真正的谎报。
    log(f"  （{p} 是 LUNYCITE 亮度表：一篇一条的引用计数，不含引用对，"
        f"共被引这一路缺席）")
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument(
        "--sim-threshold", type=float, default=0.65,
        help="余弦相似度阈值（仅语义证据时的门槛；有引用证据时会再放宽 0.10）",
    )
    # 这里原来有个 `--with-citations <路径>`，但它**从头到尾没被读过** ——
    # 传了也照样降级，属于"看着能开、其实无效"的开关。删掉，
    # 免得有人以为加个参数就能启用共被引（真因是数据里没有引用对，见 load_cocitation）。
    ap.add_argument("--resolution", type=float, default=1.0, help="Leiden 分辨率：越大社区越多越小")
    args = ap.parse_args()

    import igraph as ig
    import leidenalg

    domain = args.domain
    a, b, w = load_knn(domain, args.k)
    cocite = load_cocitation(domain)

    have_citations = cocite is not None and len(cocite) > 0
    # 有第二路证据（共被引）时可以接受更弱的语义相似度 ——
    # 两路都指向才算"同路线"，所以单看语义这一路可以放松一点。
    threshold = args.sim_threshold if not have_citations else max(0.0, args.sim_threshold - 0.10)
    if not have_citations:
        log("[!] 引用数据不可用 => 降级为**仅语义近邻**，阈值取 "
            f"{threshold}。这一事实会写进输出 meta，不会被静默掩盖。")
        log("    原因不是'没接线'，而是本交付的数据里没有'谁引用了谁' —— "
            "详见 load_cocitation() 的注释。")

    # 过滤：只留够相似的边
    keep = w >= threshold
    a, b, w = a[keep], b[keep], w[keep]
    log(f"阈值 {threshold} 之后保留 {len(a):,} 条边")

    if len(a) == 0:
        log("没有边可聚类 —— 说明嵌入质量或阈值有问题，请先看 verify_semantic 的语义一致性检查")
        return 1

    # 去重 + 规范化为 a < b
    lo = np.minimum(a, b).astype(np.uint64)
    hi = np.maximum(a, b).astype(np.uint64)
    key = lo * np.uint64(1 << 32) + hi
    uniq, idx = np.unique(key, return_index=True)
    lo, hi, w = lo[idx], hi[idx], w[idx]
    log(f"去重后 {len(lo):,} 条边")

    # ---- Leiden 社区发现 ----
    #
    # ⚠️ 这里三处原来都是 Python 级循环，在**物理团量级**上会吃掉好几 GB 内存：
    #      · `{int(v): i for i, v in enumerate(nodes)}` —— 上百万个键的 dict；
    #      · `[(node_index[int(x)], node_index[int(y)]) for x, y in zip(lo, hi)]` ——
    #        每条边两次 int() + 哈希查找，900 万条边就是 1800 万次，且要建一个
    #        900 万元素的元组列表（每个元组 ~70 字节 ⇒ 1 GB+，纯浪费）；
    #      · `membership[[node_index[int(x)] for x in lo]]` —— 同样的查找再来一遍。
    #    改成 `np.searchsorted` 全向量化：`nodes` 本来就是**有序**的
    #    （来自 np.unique），所以"值 → 下标"就是一次二分查找，
    #    这正是 searchsorted 做的事，而且作用在整个数组上。
    nodes = np.unique(np.concatenate([lo, hi]))
    idx_lo = np.searchsorted(nodes, lo)
    idx_hi = np.searchsorted(nodes, hi)
    # igraph 需要 Python 的边列表；用 tolist() 一次转换，比逐条 dict 查快一个量级。
    edge_list = np.column_stack([idx_lo, idx_hi]).tolist()
    g = ig.Graph(n=len(nodes), edges=edge_list, directed=False)
    # 权重同理：原来是 `[float(v) for v in w]`，逐元素 Python 转换；tolist() 更快且等价。
    g.es["weight"] = w.tolist()

    part = leidenalg.find_partition(
        g,
        leidenalg.RBConfigurationVertexPartition,
        weights="weight",
        resolution_parameter=args.resolution,
        seed=20260101,      # 固定种子 => 可复现
    )
    membership = np.array(part.membership, dtype=np.uint32)
    k = int(membership.max()) + 1
    log(f"社区发现：{len(nodes):,} 个节点 → {k} 个社区（模块度 {part.modularity:.4f}）")

    # ---- 输出同路线边（只留**跨社区不算**的：同一社区的边才是"同一条路线"）----
    same = membership[idx_lo] == membership[idx_hi]
    lo2, hi2, w2 = lo[same], hi[same], w[same]
    order = np.argsort(lo2, kind="stable")
    lo2, hi2, w2 = lo2[order], hi2[order], w2[order]

    out_dir = SEM / domain
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "route.bin"
    # 边表也一次性拼成结构化数组写出 —— 原来逐条 struct.pack：
    # 物理团上千万条边就是上千万次 Python 调用与小写入（同 knn.py 修过的那个问题）。
    body = np.empty(len(lo2), dtype=np.dtype([("a", "<u4"), ("b", "<u4"), ("w", "<f4")]))
    body["a"], body["b"], body["w"] = lo2.astype(np.uint32), hi2.astype(np.uint32), w2.astype(np.float32)
    with open(out, "wb") as f:
        f.write(MAGIC_ROUTE + struct.pack("<I", len(lo2)))
        f.write(body.tobytes())
    log(f"写入 {out}（{len(lo2):,} 条同路线边，{out.stat().st_size / 1e6:.1f} MB）")

    # ---- 社区归属 + meta（把"降级"这件事记录下来，不掩盖）----
    doc_to_community = {int(n): int(m) for n, m in zip(nodes.tolist(), membership.tolist())}
    (out_dir / "communities.json").write_text(
        json.dumps(
            {
                "domain": domain,
                "k": k,
                "nodes": int(len(nodes)),
                "edges": int(len(lo2)),
                "modularity": float(part.modularity),
                "resolution": args.resolution,
                "threshold": threshold,
                "evidence": ["semantic"] + (["cocitation"] if have_citations else []),
                "degraded": not have_citations,
                "degradedReason": None if have_citations
                else (f"引用数据不可用：仅用语义近邻（阈值 {threshold}）判定，"
                      "没有第二路证据交叉。这不等同于「同一路线」，已在文档中声明。"),
                "membership": doc_to_community,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    log("下一步：python label.py --domain " + domain)
    return 0


if __name__ == "__main__":
    sys.exit(main())
