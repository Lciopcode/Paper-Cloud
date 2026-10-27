#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
论文云 · 标题中文翻译（NLLB-200，双卡）
============================================================================
产出 `public/data/title-zh/<domain>.bin`：

    magic "LUNYTIT1"(8) | u32 count | u32 blobBytes
    | u32 offsets[count+1] | utf8 blob（每篇一段，无译文则为 0 长）

## 为什么是"离线批量"而不是运行时调 API

运行时调翻译 API 意味着：要 key、要网络、要按字计费、还会把用户的点击行为
发给第三方。这个作品的定位是"离线静态资产 + 本地服务器"，所以翻译也必须是
**构建期产物**（和 `cites.bin`、`spine` 一样）。

## 为什么只翻"被引论文"而不是全量 305 万篇

界面用到译名的位置只有一处：**面板里被引论文的标题**（作者原话：
"展示信息时除了本作信息后边附上引用论文标题及**标题翻译**"）。
引用表当前覆盖几千篇，被引方去重后是几百个标题 —— 双卡十几秒就翻完。
`--all` 可以翻全量（3,052,327 条，双卡实测约 40–70 分钟），但**没必要先翻**：
翻译表的格式与条数无关，将来引用数据铺开了再重跑一次即可。

## 用什么模型、为什么

`facebook/nllb-200-distilled-600M`：600M 参数，单卡 1–2k 条/秒（标题很短），
中英方向质量够用，**完全离线**跑，权重 2.5 GB。比它大的 1.3B/3.3B 在标题这种
短句上收益很小，反而把一张 4090 占满。

用法：
    python pipeline/translate-titles.py --domain physics        # 只翻引用表里出现的标题
    python pipeline/translate-titles.py --domain physics --all  # 翻全量
"""
import argparse
import json
import os
import struct
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "title-zh"
MODEL = "facebook/nllb-200-distilled-600M"
MAGIC = b"LUNYTIT1"
# NLLB 的语种代码：英语 → 简体中文
SRC, TGT = "eng_Latn", "zho_Hans"


def corpus_titles(domain: str):
    """按 docId 顺序产出标题（`text/<d>.jsonl.gz` 的行序就是 docId）。"""
    import gzip

    f = ROOT / "text" / f"{domain}.jsonl.gz"
    with gzip.open(f, "rt", encoding="utf-8") as fh:
        for line in fh:
            if not line:
                yield ""
                continue
            try:
                yield json.loads(line).get("title", "") or ""
            except Exception:
                yield ""


def cited_doc_ids(domain: str):
    """从已经建好的 CSR 里取出**被引方**的 docId 集合（只翻这些）。"""
    f = ROOT / "public" / "data" / "citations" / f"{domain}.bin"
    if not f.exists():
        return set()
    buf = f.read_bytes()
    count, edges = struct.unpack_from("<II", buf, 8)
    off = struct.unpack_from(f"<{count + 1}I", buf, 28)
    dst = struct.unpack_from(f"<{edges}I", buf, 28 + (count + 1) * 4)
    ids = set(dst)
    # 引用方自己的标题也要翻（面板顶部显示本作标题）
    for d in range(count):
        if off[d + 1] > off[d]:
            ids.add(d)
    return ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--all", action="store_true", help="翻全量（305 万条）")
    ap.add_argument("--batch", type=int, default=96)
    args = ap.parse_args()

    want = None if args.all else cited_doc_ids(args.domain)
    if want is not None and not want:
        print(f"{args.domain}: 引用表里没有被引方，先跑 harvest + build-citations")
        return 1
    print(f"{args.domain}: 目标 {len(want) if want is not None else '全量'} 条")

    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    n_gpu = torch.cuda.device_count()
    print(f"GPU {n_gpu} 张：{[torch.cuda.get_device_name(i) for i in range(n_gpu)]}")
    tok = AutoTokenizer.from_pretrained(MODEL, src_lang=SRC)
    tgt_id = tok.convert_tokens_to_ids(TGT)

    # 双卡：每张卡一份模型副本（600M 在 24GB 上各占约 1.5GB，完全放得下）
    models = []
    for i in range(max(1, n_gpu)):
        m = AutoModelForSeq2SeqLM.from_pretrained(MODEL, torch_dtype=torch.float16)
        m = m.to(f"cuda:{i}" if n_gpu else "cpu").eval()
        models.append(m)

    OUT.mkdir(parents=True, exist_ok=True)
    titles = []
    for doc_id, t in enumerate(corpus_titles(args.domain)):
        titles.append(t)
    total = len(titles)
    zh = [""] * total

    todo = [i for i in range(total) if (want is None or i in want) and titles[i].strip()]
    print(f"语料 {total} 篇，待翻 {len(todo)} 篇")

    # 轮转分片到各卡；一批内只做一次 encode/decode
    for k in range(0, len(todo), args.batch * max(1, len(models))):
        chunk = todo[k : k + args.batch * max(1, len(models))]
        parts = [chunk[i :: len(models)] for i in range(len(models))]
        outs = [None] * len(models)

        def run(gi, ids):
            if not ids:
                return []
            enc = tok([titles[i] for i in ids], return_tensors="pt", padding=True, truncation=True, max_length=128)
            enc = {kk: vv.to(f"cuda:{gi}" if n_gpu else "cpu") for kk, vv in enc.items()}
            with torch.no_grad():
                gen = models[gi].generate(**enc, forced_bos_token_id=tgt_id, max_new_tokens=160, num_beams=1)
            return tok.batch_decode(gen, skip_special_tokens=True)

        for gi in range(len(models)):
            outs[gi] = run(gi, parts[gi])
        for gi in range(len(models)):
            for i, s in zip(parts[gi], outs[gi]):
                zh[i] = (s or "").strip()
        done = min(k + args.batch * len(models), len(todo))
        if (k // (args.batch * len(models))) % 5 == 0:
            print(f"  {done}/{len(todo)}", flush=True)

    blob = b""
    offs = [0] * (total + 1)
    for i in range(total):
        offs[i] = len(blob)
        if zh[i]:
            blob += zh[i].encode("utf-8")
    offs[total] = len(blob)

    buf = bytearray()
    buf += MAGIC
    buf += struct.pack("<II", total, len(blob))
    buf += struct.pack(f"<{total + 1}I", *offs)
    buf += blob
    f = OUT / f"{args.domain}.bin"
    f.write_bytes(bytes(buf))
    have = sum(1 for x in zh if x)
    print(f"→ {f}  {len(buf) / 1048576:.2f} MB  有译文 {have}/{total}")
    print("样例：")
    for i in todo[:3]:
        print(f"  {titles[i][:70]}\n   → {zh[i][:60]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
