#!/usr/bin/env python3
"""
论文云 · 语义层第 3 步：层内近邻（k-NN）
================================================================================
产出每个 L3 层内部的 k 近邻，供 `community.py` 跑社区发现。

## 为什么坚持"层内"

跨层近邻会把"量子场论"和"星系形成"连起来（它们都大量使用"场""观测"这类词），
于是社区发现会把整个学科揉成一个大团，第 6 层就失去意义。
**层内做近邻**保证第 6 层是"某研究方向内部的技术路线"。

## GPU 用法

用 `faiss.IndexFlatIP` + `StandardGpuResources`：
  · 嵌入已归一化 => 内积就是余弦相似度，不需要额外归一化；
  · 按层建临时索引，用完即弃 —— **绝不**把整个学科塞进一个索引
    （物理团 146 万篇 × 256 维，索引本身就要 1.5 GB 显存，加上中间量容易 OOM）。

用法：
    python knn.py --domain cs --k 20
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
SEM = ROOT / "semantic"

VALUE_BYTES = 32
RANK_BASE = 16 + VALUE_BYTES * 2
RANK_REC = 40


def log(m: str) -> None:
    print(m, flush=True)


def load_strata(domain: str) -> np.ndarray:
    buf = (PUB / domain / "rank.bin").read_bytes()
    count, rec_bytes = struct.unpack_from("<II", buf, 8)
    doc_ids = np.empty(count, dtype=np.uint32)
    strata = np.empty(count, dtype=np.uint16)
    for i in range(count):
        o = RANK_BASE + i * rec_bytes
        doc_ids[i] = struct.unpack_from("<I", buf, o)[0]
        strata[i] = struct.unpack_from("<H", buf, o + 4 + VALUE_BYTES + 2)[0]
    table = np.full(int(doc_ids.max()) + 1, 0xFFFF, dtype=np.uint16)
    table[doc_ids] = strata
    return table


def load_embeddings(domain: str) -> tuple[np.ndarray, int]:
    d = SEM / domain
    shards = sorted(d.glob("emb-*.i8"))
    if not shards:
        raise SystemExit(f"{d} 里没有嵌入分片（先跑 embed.py）")
    parts, total, dim = [], 0, 0
    for s in shards:
        if not s.with_suffix(".ok").exists():
            raise SystemExit(f"{s.name} 缺 .ok 校验 —— 删掉重跑 embed.py")
        raw = s.read_bytes()
        start, count, dim = struct.unpack_from("<III", raw, 8)
        if start != total:
            raise SystemExit(f"{s.name} 起点 {start} != 已累计 {total}")
        parts.append(np.frombuffer(raw, dtype=np.int8, offset=20).reshape(count, dim))
        total += count
    return np.vstack(parts), dim


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--k", type=int, default=20)
    # 注：这里曾经有一个 `--max-stratum`（"超过这个规模的层分块处理"），
    # 但它**从未被任何代码读取** —— 声明了却没实现的功能比没有更糟：
    # 看 help 的人会以为大层会被分块，于是不再担心显存/内存。
    # 按本项目"死代码是坏味道"的一贯做法删掉，而不是硬接上去。
    args = ap.parse_args()

    import faiss

    # ---- GPU 还是 CPU：这两件事要分开判断 ----
    #
    # faiss 能不能用 GPU 是**编译期**决定的（faiss-gpu / faiss-cpu 是两个不同的包），
    # 与 torch 能不能用 CUDA **完全无关**。
    # 实测（本机）：PyPI 上**没有** GPU 版 faiss 轮子
    # （`faiss-gpu` 与 `faiss-gpu-cu12` 都报 "No matching distribution found"），
    # 而官方文档给的 `conda install -c conda-forge faiss-gpu` 在本机没有 conda。
    # 所以这里显式支持 CPU 路径 —— 原来只在 CUDA 不可用时抛一句
    # "CPU 也能跑但慢一个数量级"，却**没有实现** CPU 分支，
    # 于是真到没有 faiss-gpu 的机器上会抛 `AttributeError: StandardGpuResources`，
    # 报错完全看不出跟"装的是 CPU 版"有关。
    has_gpu_api = hasattr(faiss, "StandardGpuResources")
    n_gpu = faiss.get_num_gpus() if hasattr(faiss, "get_num_gpus") else 0
    use_gpu = bool(has_gpu_api and n_gpu > 0)

    if use_gpu:
        log(f"kNN 后端：GPU（{n_gpu} 张卡）")
    else:
        why = (
            "装的是 faiss-cpu —— PyPI 上没有 GPU 版轮子（faiss-gpu 需要 conda-forge）"
            if not has_gpu_api
            else "faiss 报告 0 张可用 GPU"
        )
        log(f"[!] kNN 后端：**CPU**（{why}）")
        log("    IndexFlatIP 是精确检索，CPU 与 GPU 的**结果完全一致**，只是慢。")
        log("    想要 GPU 加速见 setup-4090.md（需要 conda 装 faiss-gpu）。")

    domain = args.domain
    emb_q, dim = load_embeddings(domain)
    strata_of = load_strata(domain)
    n = len(emb_q)
    log(f"{domain}：{n:,} 篇 × {dim} 维")

    # 反量化到 float32（faiss 不支持 int8 的 IP 索引）
    emb = emb_q.astype(np.float32) / 127.0
    # 重新归一化：int8 量化会让模长略微偏离 1
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    emb /= norms

    buckets: dict[int, list[int]] = {}
    for doc_id in range(n):
        s = int(strata_of[doc_id]) if doc_id < len(strata_of) else 0xFFFF
        if s == 0xFFFF:
            continue
        buckets.setdefault(s, []).append(doc_id)

    res = faiss.StandardGpuResources() if use_gpu else None
    out_dir = SEM / domain
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"knn-k{args.k}.bin"

    total_edges = 0
    with open(out, "wb") as f:
        f.write(b"LUNYKNN1" + struct.pack("<III", n, args.k, dim))
        for s, members in sorted(buckets.items()):
            m = len(members)
            if m < 2:
                continue
            X = np.ascontiguousarray(emb[members])
            index = faiss.IndexFlatIP(dim)
            if use_gpu:
                index = faiss.index_cpu_to_gpu(res, 0, index)
            index.add(X)
            # 多取一个：最近的那个是自己
            kk = min(args.k + 1, m)
            D, I = index.search(X, kk)
            log(f"  层 {s:>4}：{m:>7,} 篇 → 每篇 {min(args.k, m - 1)} 个邻居")

            # ---- 向量化地写出 (docId, neighborDocId, similarity) 三元组 ----
            #
            # ⚠️ 原来是逐行逐列 `struct.pack` + `f.write`：
            #    305 万篇 × 20 邻居 = **6000 万次** Python 级调用与 6000 万次小写入，
            #    这一段的耗时会远远超过 kNN 本身（CPU 路径下尤其明显）。
            #    改成整体拼一个结构化数组一次性写。
            member_arr = np.asarray(members, dtype=np.uint32)
            nb_ids = member_arr[I]                                   # (m, kk) 邻居的 docId
            me_ids = np.repeat(member_arr, kk).reshape(I.shape)      # (m, kk) 自己的 docId
            # 最近邻里必然包含"自己"，去掉它；其余保持相似度降序，每行只留前 k 个。
            keep = nb_ids != me_ids
            keep &= np.cumsum(keep, axis=1) <= args.k
            a, b, w = me_ids[keep], nb_ids[keep], D[keep].astype(np.float32)
            order = np.argsort(a, kind="stable")                     # 按 a 升序，便于下一步归并
            body = np.empty(len(a), dtype=np.dtype([("a", "<u4"), ("b", "<u4"), ("w", "<f4")]))
            body["a"], body["b"], body["w"] = a[order], b[order], w[order]
            f.write(body.tobytes())
            total_edges += len(a)

            del X, index, D, I, nb_ids, me_ids, keep, a, b, w, body
            if use_gpu:
                import torch
                torch.cuda.empty_cache()

    log(f"\n写入 {out}（{total_edges:,} 条近邻边，{out.stat().st_size / 1e6:.1f} MB）")
    log("下一步：python community.py --domain " + domain)
    return 0


if __name__ == "__main__":
    sys.exit(main())
