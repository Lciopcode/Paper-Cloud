#!/usr/bin/env python3
"""
论文云 · 语义层第 1 步：文本嵌入
================================================================================
把每篇论文的 (标题 + 摘要) 编成 256 维向量，int8 量化后落盘。

## 两个关键取舍（都直接决定后面能不能用）

1. **Matryoshka 256 维**：bge-m3 原生 1024 维。305 万篇 × 1024 × 4 字节 = 12.5 GB，
   浏览器不可能加载。截到 256 维后 int8 量化 => 约 0.8 GB，可整份进浏览器。
   Matryoshka 训练过的模型**前 256 维本身就是可用的低维表示**，
   不是"砍掉后面的" —— 这一点必须用 Matryoshka 模型（普通模型截断会显著掉点）。

2. **分片可续跑**：4090 上跑 3–6 小时，中途断掉（断电 / OOM / 手滑）是常态。
   每 `--shard` 篇落一次盘，重跑同一条命令自动跳过已完成的分片。
   分片文件带 xxhash 校验，避免"写了一半的文件被当成完整的"。

## 输出分片格式（中间产物，merge 后才是最终 emb.bin）

每个分片 `semantic/<domain>/emb-<start>.i8`：
    magic "LUNYEMBS"(8) | start(u32) | count(u32) | dim(u32) | count × dim × int8

同名 `.ok` 文件是**产出指纹**（JSON：模型 / 维度 / 序列长度 / 分片大小 + 数据的 xxh64）。
**只有指纹一致才复用** —— 换过 `--model`（或维度、序列长度、分片大小）时，
旧分片会被判定为 stale 并**重算**，而不是被静默跳过。
（旧版 `.ok` 只存一行 xxhash，无法证明是谁产出的，一律按 stale 处理。）

最终 `public/data/semantic/<domain>.emb.bin` 由 `export.py` 合并写出。

用法：
    python embed.py --domain cs
    python embed.py --domain cs --shard 200000 --batch 64
    python embed.py --all
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
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
TEXT_DIR = ROOT / "text"
SEM_DIR = ROOT / "semantic"
PUB = ROOT / "public" / "data"
DIM = 256
MAGIC_SHARD = b"LUNYEMBS"


def log(msg: str) -> None:
    print(msg, flush=True)


def total_from_rank(domain: str) -> int | None:
    """从 `rank.bin` 头部读该学科的篇数（只读 16 字节）。

    为什么需要它：原来是用 `sum(1 for _ in iter_papers(domain))` **把整个 679 MB 的
    gz 解压一遍只为数行数** —— 而 rank.bin 的头部第 8 字节就是 count，
    与 docId 空间由同一个构建脚本写出，是权威值。读它既快又不会与正文不一致。
    """
    p = PUB / domain / "rank.bin"
    if not p.exists():
        return None
    with open(p, "rb") as f:
        head = f.read(16)
    if len(head) < 16 or head[:8] != b"LUNYRANK":
        return None
    return struct.unpack_from("<I", head, 8)[0]


def shard_paths(domain: str, start: int) -> tuple[Path, Path]:
    d = SEM_DIR / domain
    d.mkdir(parents=True, exist_ok=True)
    base = d / f"emb-{start:09d}.i8"
    return base, base.with_suffix(".ok")


def shard_fingerprint(model: str, dim: int, max_seq_len: int, shard: int) -> dict:
    """这一片"是用什么产出的" —— 决定它能不能被复用。

    ⚠️ **`.ok` 里必须记住模型，否则续跑会静默复用错的向量。**
    原来的 `.ok` 只存了数据本身的 xxhash，于是"换个 --model 重跑"时
    所有分片都被判定为"已完成"而**跳过** —— 得到的是两个模型的向量混在一起，
    而且**完全不报错**（校验通过、长度自洽、验收也会过，
    因为验收查的是结构与范围，不是"这些向量是不是同一个模型算的"）。

    实测踩到：先用 all-MiniLM-L6-v2 跑了一遍 math 的小模型占位产物，
    之后用 bge-m3 重跑时那 3 个分片本该被重算，却因为 `.ok` 存在而被跳过。

    所以指纹不同 = 这一片作废，必须重算。宁可多花一次 GPU 时间，
    也不要产出一份"看起来正常、其实是两个模型拼起来"的数据。
    """
    return {"model": model, "dim": dim, "maxSeqLen": max_seq_len, "shard": shard}


def shard_status(ok_path: Path, want: dict) -> str:
    """`'ok'` 可复用 · `'stale'` 指纹不符或格式无法识别（要重算） · `'missing'` 没跑过。

    旧版 `.ok` 里只有一行 hex hash（不是 JSON）—— 那种**无法证明**它是不是当前模型产出的，
    一律当 `'stale'` 重算。这是刻意的：宁可重跑，也不要赌。
    """
    if not ok_path.exists() or ok_path.stat().st_size == 0:
        return "missing"
    try:
        got = json.loads(ok_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "stale"          # 旧格式：无法证明，重算
    if not isinstance(got, dict):
        return "stale"
    for k, v in want.items():
        if got.get(k) != v:
            return "stale"
    return "ok"


def iter_papers(domain: str):
    """按行读 text/<domain>.jsonl.gz。行序就是 docId 序 —— 这一点必须成立，
    否则"第 i 行 = docId i"的假设会崩，嵌入就会挂到别的论文上。"""
    path = TEXT_DIR / f"{domain}.jsonl.gz"
    if not path.exists():
        raise SystemExit(f"找不到 {path}。若未随仓库搬运，先在本机跑 node pipeline/export-text.mjs")
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                rec = {}
            yield i, rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default=None)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--shard", type=int, default=200_000, help="每个分片多少篇")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--dim", type=int, default=DIM)
    ap.add_argument("--model", default="BAAI/bge-m3")
    # ⚠️ 设计文档写的是"标题+摘要，**256 token 截断**"，但代码原来**没有强制它** ——
    #    bge-m3 自己的 max_seq_length 是 **8192**，于是实际按 8192 编码。
    #    后果有两层：
    #      · 与文档不符（别人按文档复现会对不上）；
    #      · 注意力是 O(n²)，长摘要会明显拖慢，而这个环节要跑 305 万篇。
    #    这里显式设成 256 并对齐文档；要改就显式传 --max-seq-len。
    ap.add_argument("--max-seq-len", type=int, default=256,
                    help="标题+摘要截断到多少 token（默认 256，与设计文档一致）")
    args = ap.parse_args()

    domains = (
        ["physics", "math", "cs", "bio", "eess", "stat", "econ", "qfin"] if args.all else [args.domain]
    )
    if not domains or domains == [None]:
        raise SystemExit("必须给 --domain <id> 或 --all")

    import torch
    from sentence_transformers import SentenceTransformer

    if not torch.cuda.is_available():
        raise SystemExit(
            "CUDA 不可用。本脚本不提供 CPU 回退 —— 305 万篇在 CPU 上要跑几十小时，"
            "而且会给人「已经跑完」的错觉。请先按 setup-4090.md 修好 torch 的 CUDA。"
        )
    log(f"设备：{torch.cuda.get_device_name(0)}")

    # truncate_dim 是 sentence-transformers 3.x 的 Matryoshka 支持
    model = SentenceTransformer(args.model, truncate_dim=args.dim, device="cuda")
    # 显式设序列长度上限（见上面 --max-seq-len 的说明：模型默认 8192，与文档的 256 不符）
    model.max_seq_length = args.max_seq_len
    log(f"模型：{args.model}（截到 {args.dim} 维，Matryoshka；序列上限 {model.max_seq_length} token）")

    for domain in domains:
        log(f"\n=== {domain} ===")
        total = total_from_rank(domain)
        if total is None:
            # rank.bin 不在时退回"数一遍行数"（慢，但至少能跑）
            total = sum(1 for _ in iter_papers(domain))
            log(f"（rank.bin 不在，篇数是数出来的：{total:,}）")
        log(f"篇数 {total:,} · 分片 {args.shard:,} => 约 {-(-total // args.shard)} 片")

        # 本次运行的指纹：模型/维度/序列长度/分片大小 任一不同，已落盘的分片就作废。
        FINGERPRINT = shard_fingerprint(args.model, args.dim, args.max_seq_len, args.shard)

        def flush(start: int, texts: list[str], idxs: list[int]) -> bool:
            """把一个分片编码并落盘。返回是否真的写了（跳过的返回 False）。"""
            base, ok = shard_paths(domain, start)
            state = shard_status(ok, FINGERPRINT)
            if state == "ok":
                log(f"  跳过 {base.name}（已完成，指纹一致）")
                return False
            if state == "stale":
                log(f"  {base.name} 的校验与当前参数不符（换过模型/维度/序列长度/分片大小，"
                    f"或是旧格式的 .ok）→ **重算**，不复用")
            # 分片内部必须连续且从 start 开始 —— 这是"第 i 行 = docId i"的落地检查。
            # 一旦不成立，嵌入就会挂到别的论文上，而**不会报错**。
            if idxs and (idxs[0] != start or idxs[-1] != start + len(idxs) - 1):
                raise SystemExit(
                    f"{domain} 的第 {start} 号分片行号不连续（{idxs[0]}..{idxs[-1]}，共 {len(idxs)}）—— "
                    "语料行序与 docId 序不一致，必须先查 pipeline/export-text.mjs"
                )
            vecs = model.encode(
                texts,
                batch_size=args.batch,
                normalize_embeddings=True,   # 归一化后内积 = 余弦相似度，直接用 faiss 的 IP 索引
                show_progress_bar=True,
                convert_to_numpy=True,
            ).astype(np.float32)
            # int8 量化：归一化向量的分量在 [-1,1]，乘 127 后取整，误差 < 1/127
            q = np.clip(np.rint(vecs * 127.0), -127, 127).astype(np.int8)
            with open(base, "wb") as f:
                f.write(MAGIC_SHARD)
                f.write(struct.pack("<III", start, len(texts), args.dim))
                f.write(q.tobytes())
            import xxhash
            h = xxhash.xxh64(base.read_bytes()).hexdigest()
            # `.ok` 里同时写**数据指纹**（xxh64）与**产出指纹**（模型/维度/序列长度/分片大小）。
            # 前者证明"文件没坏"，后者证明"这一片是当前参数产出的、可以复用"。
            ok.write_text(
                json.dumps({**FINGERPRINT, "xxh64": h}, ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
            log(f"  写入 {base.name}（{len(texts):,} 篇，{base.stat().st_size / 1e6:.1f} MB）")
            del vecs, q
            torch.cuda.empty_cache()
            return True

        # ---- 单遍流式：整个文件**只解压一次** ----
        #
        # ⚠️ 原来是"每个分片都从头 `_slice` 一遍"，于是总解压量 ≈ (片数+1) × 全量：
        #    物理团 679 MB gz / 8 片 = 白解压约 9 遍（几十 GB 的无谓 IO）。
        #    改成边读边按分片边界 flush，读一遍就够；
        #    已完成的分片仍然会"读过去但不编码"（gzip 不能 seek，这是省不掉的）。
        buf_text: list[str] = []
        buf_idx: list[int] = []
        start = 0
        for i, rec in iter_papers(domain):
            title = (rec.get("title") or "").strip()
            abstract = (rec.get("abstract") or "").strip()
            # 标题在前、摘要在后：Matryoshka 低维主要保留靠前的语义
            buf_text.append(f"{title}. {abstract}".strip() or "(untitled)")
            buf_idx.append(i)
            if len(buf_text) >= args.shard:
                flush(start, buf_text, buf_idx)
                start += args.shard
                buf_text, buf_idx = [], []
        if buf_text:
            flush(start, buf_text, buf_idx)

    log("\n嵌入完成。下一步：python cluster.py --domain <id>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
