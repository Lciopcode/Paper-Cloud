#!/usr/bin/env python3
"""
论文云 · 语义层验收
================================================================================
**在 4090 上跑完必须过这一关，才能拿回本仓库用。**

这个脚本只做一件事：把"文件确实是我以为的那个东西"证明出来。
语义层的每一步都可能**静默产出坏数据**（分片写一半、层号对错位、簇号越界），
而坏数据一旦进了前端，表现只是"看起来有点怪"，极难回溯 —— 所以必须在这里挡住。

判据分四组：
  A 结构：文件头、长度、记录数 —— 与 manifest / rank.bin **交叉核对**，不只是自洽
  B 语义：嵌入的方向是否合理（同层相似度 > 跨层相似度）
  C 范围：簇号 < k、层内至少 2 个簇、同路线边 a<b 且不越界、权重 ∈ [0,1]
  D 格式契约：声明多少字节/条，文件里就真的多少字节/条（保留位恒 0 即为此设的哨兵）

> ⚠️ 写判据时记住这一轮踩到的两个"**看起来在验、其实没验**"：
>   · `cl` 按一维 uint16 读 → 保留位被当成簇号混进统计（数字看着还挺正常）；
>   · `np.diff(a) >= 0` 而 `a` 是 **uint32** → 下溢回绕，**恒为真**，
>     "按 a 升序"从来没有生效过。**比较大小前先看 dtype 有没有符号。**
> 所以下面凡是有"顺序/范围"性质的判据，都显式转成有符号再比。

用法：
    python verify_semantic.py --domain cs
    python verify_semantic.py --all
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
SEM = PUB / "semantic"

VALUE_BYTES = 32
RANK_BASE = 16 + VALUE_BYTES * 2
RANK_REC = 40

fails: list[str] = []
notes: list[str] = []


def check(ok: bool, msg: str) -> None:
    print(f"  {'OK' if ok else 'FAIL'} {msg}")
    if not ok:
        fails.append(msg)


def note(msg: str) -> None:
    print(f"    {msg}")
    notes.append(msg)


def load_strata(domain: str) -> tuple[np.ndarray, np.ndarray]:
    """返回 (docIds, strata)，来自编号表。"""
    buf = (PUB / domain / "rank.bin").read_bytes()
    count, rec_bytes = struct.unpack_from("<II", buf, 8)
    doc_ids = np.empty(count, dtype=np.uint32)
    strata = np.empty(count, dtype=np.uint16)
    for i in range(count):
        o = RANK_BASE + i * rec_bytes
        doc_ids[i] = struct.unpack_from("<I", buf, o)[0]
        strata[i] = struct.unpack_from("<H", buf, o + 4 + VALUE_BYTES + 2)[0]
    return doc_ids, strata


def check_embedding(domain: str, expected_n: int) -> np.ndarray | None:
    p = SEM / f"{domain}.emb.bin"
    if not p.exists():
        check(False, f"缺少 {p.name}（先跑 export.py）")
        return None
    raw = p.read_bytes()
    check(raw[:8] == b"LUNYEMB1", "嵌入文件头是 LUNYEMB1")
    count, dim, quant = struct.unpack_from("<III", raw, 8)
    (scale,) = struct.unpack_from("<f", raw, 20)
    need = 24 + count * dim
    check(len(raw) == need, f"嵌入长度自洽（{len(raw)} == 24 + {count}×{dim}）")
    check(count == expected_n, f"嵌入篇数与编号表一致（{count:,} == {expected_n:,}）")
    check(dim == 256, f"维度是 256（Matryoshka 截断；实际 {dim}）")
    check(quant == 1, f"量化方式是 int8（实际 {quant}）")

    q = np.frombuffer(raw, dtype=np.int8, offset=24).reshape(count, dim).astype(np.float32)
    v = q * (scale if scale else (1.0 / 127.0))
    # 归一化嵌入的模长应当接近 1
    norms = np.linalg.norm(v[: min(20000, count)], axis=1)
    note(f"前 2 万条向量模长 中位 {np.median(norms):.4f} · 最小 {norms.min():.4f} · 最大 {norms.max():.4f}")
    check(0.5 < float(np.median(norms)) < 1.5, "向量模长在合理区间（未归一化或量化崩坏会偏离很远）")
    # 零向量是明确的坏信号（编码失败/空文本）
    zeros = int(np.sum(np.all(q[: min(200000, count)] == 0, axis=1)))
    check(zeros == 0, f"没有全零向量（0 表示编码失败；实测 {zeros} 条）")
    return v


def check_semantics(domain: str, v: np.ndarray, doc_ids: np.ndarray, strata: np.ndarray) -> None:
    """同层相似度应当明显高于跨层 —— 这是"嵌入真的抓住了层"的直接证据。"""
    rng = np.random.default_rng(20260101)
    n = len(v)
    if n < 1000:
        note("样本太少，跳过语义一致性检查")
        return
    # 随机取若干篇，各找同层与跨层的另一篇，比较余弦相似度
    same, cross = [], []
    strata_of_doc = np.full(int(doc_ids.max()) + 1, 0xFFFF, dtype=np.uint16)
    strata_of_doc[doc_ids] = strata
    # 每层的成员表
    buckets: dict[int, list[int]] = {}
    for d in doc_ids[:n]:
        buckets.setdefault(int(strata_of_doc[d]), []).append(int(d))
    buckets = {k: m for k, m in buckets.items() if len(m) >= 50}
    if len(buckets) < 2:
        note("可用层不足，跳过语义一致性检查")
        return
    keys = list(buckets.keys())
    for _ in range(2000):
        s = keys[rng.integers(len(keys))]
        m = buckets[s]
        i, j = rng.choice(len(m), size=2, replace=False)
        a, b = m[i], m[j]
        same.append(float(np.dot(v[a], v[b])))
        s2 = keys[rng.integers(len(keys))]
        if s2 == s:
            continue
        c = buckets[s2][rng.integers(len(buckets[s2]))]
        cross.append(float(np.dot(v[a], v[c])))
    ms, mc = float(np.mean(same)), float(np.mean(cross))
    note(f"同层余弦均值 {ms:.4f} · 跨层余弦均值 {mc:.4f} · 差 {ms - mc:+.4f}")
    check(ms > mc, "同层相似度高于跨层（嵌入确实抓住了研究方向）")


def check_clusters(domain: str, expected_n: int, doc_ids: np.ndarray, strata: np.ndarray) -> None:
    p = SEM / f"{domain}.clu.bin"
    if not p.exists():
        check(False, f"缺少 {p.name}（先跑 cluster.py + export.py）")
        return
    raw = p.read_bytes()
    check(raw[:8] == b"LUNYCLU1", "聚类文件头是 LUNYCLU1")
    count, k, rec = struct.unpack_from("<III", raw, 8)
    check(rec == 4, f"记录的字节数与声明一致（应为 4 = u16 簇号 + u16 保留；实际 {rec}）")
    check(len(raw) == 20 + count * rec, f"聚类长度自洽（{len(raw)} == 20 + {count}×{rec}）")
    check(count == expected_n, f"聚类篇数与编号表一致（{count:,} == {expected_n:,}）")
    if rec != 4 or len(raw) != 20 + count * rec:
        # 口径或长度不对时，再按步长去读只会得到"看起来合理"的垃圾 —— 直接停在这里。
        return

    # 每 4 字节一条记录：u16 簇号 + u16 保留。
    # ⚠️ 不能用 `np.frombuffer(raw, dtype=np.uint16, offset=20)` 一维读 ——
    #    那样会把保留位也当成簇号，混进 min/max/unique 的统计里
    #    （症状是"不同簇号"数目虚高、且最小簇号恒为 0，看起来还挺正常）。
    recs = np.frombuffer(raw, dtype=np.uint16, offset=20).reshape(count, 2)
    cl = recs[:, 0]
    # 保留位恒为 0。这条判据的价值在于：**写出端若按 2 字节错位，这里立刻炸**，
    # 而不是等到前端画出乱七八糟的簇才被发现。
    check(int(recs[:, 1].max()) == 0, "保留位全为 0（非 0 说明写出时按 2 字节错位了）")
    note(f"簇号范围 {int(cl.min())}–{int(cl.max())}（声明 k={k}）")
    check(int(cl.max()) < max(k, 1), f"所有簇号 < 声明的 k（最大 {int(cl.max())} < {max(k, 1)}）")
    note(f"不同簇号 {len(np.unique(cl)):,} 个")

    # 每层至少 2 个簇 —— 只对**参与聚类的层**要求。
    # cluster.py 明确跳过 <4 篇的小层（那些层簇号恒为 0，是"该层只有一个研究点"的诚实结果），
    # 所以对它们提这个要求是错的；README 原来那句"每层至少 2 个簇"没有这个限定，已同步改掉。
    strata_of_doc = np.full(int(doc_ids.max()) + 1, 0xFFFF, dtype=np.uint16)
    strata_of_doc[doc_ids] = strata
    layer_sizes: dict[int, int] = {}
    layer_clusters: dict[int, set[int]] = {}
    for doc_id in range(count):
        s = int(strata_of_doc[doc_id])
        if s == 0xFFFF:
            continue
        layer_sizes[s] = layer_sizes.get(s, 0) + 1
        layer_clusters.setdefault(s, set()).add(int(cl[doc_id]))
    checked = 0
    bad: list[str] = []
    for s, cs in sorted(layer_clusters.items()):
        m = layer_sizes[s]
        if m < 4:
            continue          # 与 cluster.py 的跳过规则一致
        checked += 1
        if len(cs) < 2:
            bad.append(f"层{s}({m}篇)只有{len(cs)}个簇")
    check(len(bad) == 0, f"参与聚类的层都至少 2 个簇（受检 {checked} 个层；异常：{'、'.join(bad) if bad else '无'}）")


def check_routes(domain: str, expected_n: int) -> None:
    p = SEM / f"{domain}.route.bin"
    if not p.exists():
        note("（没有同路线边文件 —— 若 community.py 还没跑，这是正常的）")
        return
    raw = p.read_bytes()
    check(raw[:8] == b"LUNYROU1", "同路线文件头是 LUNYROU1（8 字节 magic）")
    (count,) = struct.unpack_from("<I", raw, 8)
    need = 12 + count * 12
    check(len(raw) == need, f"同路线长度自洽（{len(raw)} == 12 + {count}×12）")
    if len(raw) != need:
        return                       # 长度都不对，下面的解析没有意义
    if count == 0:
        note("（同路线边为 0 条 —— 阈值可能过高，见 community.py 的输出）")
        return

    # 用结构化 dtype **一次读完全部边**。
    #
    # ⚠️ 这里原来有两个真问题，都属于"判据看起来在验、其实没验"：
    #
    #  1. 用 Python 循环只填了前 2,000,000 条（`range(min(count, 2_000_000))`），
    #     而断言却作用在整个数组上 —— 未填充的尾部全是 0。
    #     边数超过 200 万时会拿一堆 0 去做判据，得到"a < b 失败"这种**假失败**。
    #     （顺带：逐条 struct.unpack 对千万级边也太慢。）
    #
    #  2. **`np.diff` 作用在 uint32 上会下溢回绕**：a[i+1] < a[i] 时相减得到
    #     接近 2^32 的大正数，于是 `np.diff(a) >= 0` **恒为真** ——
    #     "按 a 升序"这条判据从来没有真正生效过。必须转成有符号再比较。
    dt = np.dtype([("a", "<u4"), ("b", "<u4"), ("w", "<f4")])
    e = np.frombuffer(raw, dtype=dt, offset=12)
    a, b, w = e["a"], e["b"], e["w"]

    check(bool(np.all(a < b)), "每条边 a < b（无自环、无重复方向）")
    check(
        bool(np.all(np.diff(a.astype(np.int64)) >= 0)),
        "按 a 升序（便于前端归并）",
    )
    check(
        bool(np.all(a < expected_n) and np.all(b < expected_n)),
        f"边两端的 docId 都落在该学科篇数内（< {expected_n:,}）",
    )
    # 权重的容差 —— 这条判据第一版写成严格的 `w <= 1.0`，结果**假失败**了。
    #
    # 实测（math，173,079 条边）：最大权重 1.0000011921，即超出 1.0 **1.192e-06**
    # （= 10 倍 float32 的 eps；只有 78 条越界）。
    # 那是 int8 量化 → 反量化 → 重新归一化 → 256 维点积 的**浮点累积误差** ——
    # 余弦相似度在数学上不可能超过 1，超过一点点只能是舍入。
    #
    # 所以给容差的同时**把超出量算出来并打印**：
    # 真损坏（例如把相邻字段读成权重）会超出好几个数量级，
    # 而 eps 级别的超出只可能是舍入 —— 两者必须一眼分得开。
    EPS = 1e-5
    over = w > (1.0 + EPS)
    if bool(over.any()):
        worst = float((w[over] - 1.0).max())
        check(False, f"权重都在 [0,1]（{int(over.sum()):,} 条越界，最多超 {worst:.3e} —— 远超浮点舍入，需要查）")
    else:
        excess = float(max(0.0, float(w.max()) - 1.0))
        check(True, f"权重都在 [0,1]（含 {EPS:g} 容差；实测最大超出 {excess:.3e}，属浮点舍入）")
    note(f"权重范围 {float(w.min()):.6f}–{float(w.max()):.6f}")
    note(f"涉及节点 {len(np.unique(np.concatenate([a, b]))):,} 个")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    manifest = json.loads((PUB / "manifest.json").read_text(encoding="utf-8"))
    if args.all:
        domains = [d["id"] for d in manifest["domains"]]
    elif args.domain:
        domains = [args.domain]
    else:
        raise SystemExit("必须给 --domain <id> 或 --all")

    for domain in domains:
        entry = next((d for d in manifest["domains"] if d["id"] == domain), None)
        if entry is None:
            check(False, f"manifest 里没有 {domain}")
            continue
        expected_n = int(entry["papers"])
        print(f"\n=== {domain}（manifest 声明 {expected_n:,} 篇）===")
        doc_ids, strata = load_strata(domain)
        check(len(doc_ids) == expected_n, f"编号表篇数与 manifest 一致（{len(doc_ids):,}）")
        v = check_embedding(domain, expected_n)
        if v is not None:
            check_semantics(domain, v, doc_ids, strata)
        check_clusters(domain, expected_n, doc_ids, strata)
        check_routes(domain, expected_n)

    print("\n" + "=" * 60)
    if fails:
        print(f"结论：FAIL {len(fails)} 项未通过")
        for f in fails:
            print(f"  · {f}")
        return 1
    print("结论：OK 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
