#!/usr/bin/env python3
"""
论文云 · 语义层第 2 步：层内聚类（产出八层结构里的第 5 层「具体研究点」）
================================================================================
## 为什么必须**在层内**聚类

一个学科包含几十个 L3 研究方向（物理团 71 个）。如果对整团做一次聚类，
算法会把"量子场论"和"星系形成"强行并成若干个大簇 —— 那不是研究点，那是把学科重切一遍，
层级就白做了。

正确做法：**在每个 L3 层内**各自聚类，于是 L5 是"某研究方向内部的具体研究点"，
层级链条完整：学科 → 一级学科 → 研究方向 → 具体研究点。

## 簇数怎么定

不固定。层内论文数差异极大（hepph 133,725 篇 vs qfin 某个 200 篇的小层），
固定 k 会让大层欠分割、小层过分割。这里按 `ceil(sqrt(n/2))` 给一个自适应值，
再夹到 [2, 64] —— 小层至少 2 个簇（否则"聚类"没意义），大层不超过 64 个（再多无法命名）。

## 输入
- `semantic/<domain>/emb-*.i8`（embed.py 的分片）
- `public/data/<domain>/rank.bin`（拿层号）

## 输出
- `semantic/<domain>/clu.bin`：u16 簇号，**按 docId 索引**（与邻接表同一套约定）
"""
from __future__ import annotations

import argparse
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
SEM_DIR = ROOT / "semantic"

VALUE_BYTES = 32
RANK_BASE = 16 + VALUE_BYTES * 2
RANK_REC = 40


def log(m: str) -> None:
    print(m, flush=True)


#: clu.bin 的头部长度与记录长度（**契约的一部分**，读取端与自检都依赖它）
CLU_HEAD_BYTES = 20
CLU_REC_BYTES = 4


def write_clu(path: Path, clusters: np.ndarray, global_k: int) -> None:
    """写出 `clu.bin`：`magic(8) | count(u32) | k(u32) | recBytes(u32=4)` + count×4 字节。

    记录 = **u16 簇号 + u16 保留(0)**，按 docId 索引。

    ⚠️ 抽成独立函数是为了**能被自检直接调用**。这里曾经只写 2 字节
    （`clusters` 是 uint16，`.tobytes()` 就是 2n 字节），而头部声明的是 4 ——
    自己声明一套、自己又写另一套，长度对不上会让下一步读错位，
    而这个错**不会崩**。现在由 `selftest_clu.py` 守住这条契约，
    并且那个自检会**故意写一份错的文件来确认自己真的会报错**。
    """
    n = len(clusters)
    rec = np.zeros((n, 2), dtype=np.uint16)   # 行主序：每行 = [簇号, 保留=0] = 4 字节
    rec[:, 0] = clusters
    path.write_bytes(
        b"LUNYCLU1" + struct.pack("<III", n, int(global_k), CLU_REC_BYTES) + rec.tobytes()
    )


def load_strata(domain: str) -> np.ndarray:
    """从 rank.bin 读出「docId → 层号」。"""
    p = PUB / domain / "rank.bin"
    if not p.exists():
        raise SystemExit(f"找不到 {p}（先在本机跑 node pipeline/build-spine.mjs）")
    buf = p.read_bytes()
    if buf[:8] != b"LUNYRANK":
        raise SystemExit(f"{p} 魔法数不对 —— 编号表格式变了？")
    count, rec_bytes = struct.unpack_from("<II", buf, 8)
    if rec_bytes != RANK_REC:
        raise SystemExit(f"编号表记录长度应为 {RANK_REC}，实际 {rec_bytes}")
    doc_ids = np.empty(count, dtype=np.uint32)
    strata = np.empty(count, dtype=np.uint16)
    for i in range(count):
        o = RANK_BASE + i * rec_bytes
        doc_ids[i] = struct.unpack_from("<I", buf, o)[0]
        strata[i] = struct.unpack_from("<H", buf, o + 4 + VALUE_BYTES + 2)[0]
    # docId 可能有空洞（实测八团都是 0 空洞，但不要假设）
    max_id = int(doc_ids.max())
    table = np.full(max_id + 1, 0xFFFF, dtype=np.uint16)
    table[doc_ids] = strata
    return table


def load_embeddings(domain: str, dim_expected: int | None = None) -> tuple[np.ndarray, int]:
    """把所有分片拼成一个 (n, dim) 的 int8 数组。"""
    d = SEM_DIR / domain
    shards = sorted(d.glob("emb-*.i8"))
    if not shards:
        raise SystemExit(f"{d} 里没有嵌入分片（先跑 embed.py --domain {domain}）")
    parts = []
    dim = dim_expected or 0
    total = 0
    for s in shards:
        ok = s.with_suffix(".ok")
        if not ok.exists():
            raise SystemExit(f"{s.name} 没有 .ok 校验文件 —— 可能是写了一半，删掉重跑 embed.py")
        raw = s.read_bytes()
        if raw[:8] != b"LUNYEMBS":
            raise SystemExit(f"{s.name} 魔法数不对")
        start, count, dim = struct.unpack_from("<III", raw, 8)
        if start != total:
            raise SystemExit(f"{s.name} 起点是 {start}，但已累计 {total} —— 分片缺失或乱序")
        arr = np.frombuffer(raw, dtype=np.int8, offset=20).reshape(count, dim)
        parts.append(arr)
        total += count
    log(f"嵌入：{total:,} 篇 × {dim} 维（{len(shards)} 个分片）")
    return np.vstack(parts), dim


def main() -> int:
    # [!] 先把参数解析完再加载数据。
    #    曾经把 load_embeddings() 放在 parse_args() 之前，于是 `--help` 也会去读几个 GB
    #    的数据然后崩掉 —— 谁都没法确认脚本能跑（实测踩过）。
    #    规则：**任何会碰磁盘或需要 GPU 的动作都必须在 parse_args() 之后**。
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--max-k", type=int, default=64, help="单层最多几个簇")
    ap.add_argument("--min-k", type=int, default=2, help="单层最少几个簇")
    ap.add_argument("--seed", type=int, default=20260101, help="固定随机种子，结果可复现")
    args = ap.parse_args()

    from sklearn.cluster import MiniBatchKMeans

    domain = args.domain
    emb, dim = load_embeddings(domain)
    strata_of_doc = load_strata(domain)
    n = len(emb)

    if len(strata_of_doc) < n:
        raise SystemExit(
            f"编号表只覆盖 {len(strata_of_doc):,} 个 docId，但嵌入有 {n:,} 篇 —— "
            "两者顺序/长度不一致，说明嵌入与编号表不是同一份语料。"
        )

    # 按层分桶
    buckets: dict[int, list[int]] = {}
    for doc_id in range(n):
        s = int(strata_of_doc[doc_id])
        if s == 0xFFFF:
            continue
        buckets.setdefault(s, []).append(doc_id)
    log(f"层数 {len(buckets)}")

    clusters = np.zeros(n, dtype=np.uint16)
    per_stratum_k: dict[int, int] = {}
    for s, members in sorted(buckets.items()):
        m = len(members)
        if m < 4:
            continue  # 太小的层不聚类：簇号全 0 就是"该层只有一个研究点"，这是诚实的结果
        k = int(np.clip(round((m / 2) ** 0.5), args.min_k, args.max_k))
        per_stratum_k[s] = k
        X = emb[members].astype(np.float32)
        km = MiniBatchKMeans(
            n_clusters=k,
            random_state=args.seed,
            batch_size=min(4096, m),
            n_init=3,
            max_iter=100,
        )
        labels = km.fit_predict(X)
        clusters[members] = labels.astype(np.uint16)
        log(f"  层 {s:>4}：{m:>7,} 篇 → {k:>3} 簇")

    out = SEM_DIR / domain / "clu.bin"
    write_clu(out, clusters, max(per_stratum_k.values(), default=0))
    log(f"\n写入 {out}（{out.stat().st_size / 1e6:.1f} MB）")
    log("下一步：python knn.py --domain " + domain)
    return 0


if __name__ == "__main__":
    sys.exit(main())
