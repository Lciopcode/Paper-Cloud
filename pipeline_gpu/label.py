#!/usr/bin/env python3
"""
论文云 · 语义层第 5 步：层标签（第 5/6 层的中文名）
================================================================================
给每个聚类起一个**可读的名字**，否则界面上只能显示"簇 #17"。

## 方法：c-TF-IDF 关键词（不需要 GPU，也不需要联网）

把每个簇里的所有标题拼成一份"文档"，用 class-based TF-IDF 找出**这个簇特别常用、
而其他簇不常用**的词 —— 这正是"研究点的特征词"。
比"取簇内最高频词"好得多：后者会把每个簇都标成 "model / learning / method"
（全领域通用词）。

## 可选：LLM 润色

`--llm` 时会把关键词交给一个**本地**模型起名（不允许联网推理：
参赛要求可复现，且联网会让结果无法验证）。
LLM 只做"起名"这一件事，**不影响任何数据结构** ——
所以即使不起名，功能也是完整的，只是名字从"detection transformer object"
变成"目标检测"。

用法：
    python label.py --domain cs --topk 12
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import re
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
from collections import Counter
from pathlib import Path

# ⚠️ numpy 必须在**模块级**导入。
#    原来只在 `load_clusters()` 里 `import numpy as np`（局部导入），
#    而 `load_strata()` 也用了 `np` —— 于是这个脚本**必定崩**：
#        NameError: name 'np' is not defined
#    换句话说 label.py 从来没有成功跑过一次（这也印证了 HANDOFF 里
#    "五个算法脚本没有真正跑过"的说明）。
#    教训：局部 import 会让"这个模块到底依赖什么"变得不可见。
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
TEXT = ROOT / "text"
PUB = ROOT / "public" / "data"
SEM = ROOT / "semantic"

VALUE_BYTES = 32
RANK_BASE = 16 + VALUE_BYTES * 2
RANK_REC = 40

# 停用词：这些词在任何簇里都高频，留着只会污染标签
STOP = set(
    """a an the of for and to in on with by from using via based new novel
    study analysis approach method methods model models results result
    paper we our this that these those its their can may show shows
    proposed present presents investigate investigated towards toward
    high low large small two three one first second""".split()
)
WORD_RE = re.compile(r"[a-z][a-z0-9\-]{1,}")


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


def load_clusters(domain: str) -> tuple[int, "object"]:
    p = SEM / domain / "clu.bin"
    if not p.exists():
        raise SystemExit(f"找不到 {p}（先跑 cluster.py）")
    raw = p.read_bytes()
    if raw[:8] != b"LUNYCLU1":
        raise SystemExit(f"{p} 魔法数不对")
    count, k, rec = struct.unpack_from("<III", raw, 8)
    if rec != 4:
        raise SystemExit(f"{p} 记录长度声明为 {rec}，应为 4（u16 簇号 + u16 保留）")
    if len(raw) != 20 + count * rec:
        raise SystemExit(f"{p} 长度 {len(raw)} 与声明不符（应为 {20 + count * rec}）—— 可能是写了一半")
    # 每 4 字节一条：只管第 0 个 u16（簇号），保留位丢掉。    # ⚠️ 不能按一维 uint16 读 —— 那会把保留位也当成簇号，于是
    #    "每个簇"都被劈成两半（簇号 + 一个恒为 0 的假簇），标签会串。
    cl = np.frombuffer(raw, dtype=np.uint16, offset=20).reshape(count, 2)[:, 0].copy()
    return k, cl


def load_titles(domain: str, n: int) -> list[str]:
    path = TEXT / f"{domain}.jsonl.gz"
    if not path.exists():
        raise SystemExit(f"找不到 {path}（标签需要标题；先跑 node pipeline/export-text.mjs）")
    titles: list[str] = []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            if len(titles) >= n:
                break
            try:
                titles.append((json.loads(line).get("title") or "").lower())
            except json.JSONDecodeError:
                titles.append("")
    while len(titles) < n:
        titles.append("")
    return titles


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--topk", type=int, default=12)
    ap.add_argument("--llm", action="store_true", help="用本地 LLM 把关键词润成中文短语（可选）")
    ap.add_argument("--llm-model", default="Qwen/Qwen2.5-7B-Instruct")
    ap.add_argument("--min-papers", type=int, default=30, help="小于这个规模的点不起名")
    args = ap.parse_args()

    domain = args.domain
    k, clusters = load_clusters(domain)
    strata_of = load_strata(domain)
    n = len(clusters)
    titles = load_titles(domain, n)
    log(f"{domain}：{n:,} 篇 · {k} 个簇（全局）")

    # ---- 统计每个（层, 簇）的词频 ----
    cluster_words: dict[tuple[int, int], Counter] = {}
    cluster_papers: Counter = Counter()
    df: Counter = Counter()   # 有多少个簇出现过这个词（用于 IDF）
    for doc_id in range(n):
        s = int(strata_of[doc_id]) if doc_id < len(strata_of) else 0xFFFF
        c = int(clusters[doc_id])
        key = (s, c)
        cluster_papers[key] += 1
        words = {w for w in WORD_RE.findall(titles[doc_id]) if w not in STOP and len(w) > 2}
        if not words:
            continue
        cnt = cluster_words.setdefault(key, Counter())
        for w in words:
            cnt[w] += 1
        for w in words:
            df[w] += 1

    total_clusters = max(1, len(cluster_words))
    log(f"参与起名的（层, 簇）组合：{total_clusters:,}")

    def top_words(key: tuple[int, int], topk: int) -> list[str]:
        cnt = cluster_words.get(key)
        if not cnt:
            return []
        size = max(1, cluster_papers[key])
        scored = []
        for w, tf in cnt.items():
            # c-TF-IDF：簇内频率 × 稀有度（出现在越少的簇里越有区分度）
            idf = math.log(1 + total_clusters / (1 + df[w]))
            scored.append((tf / size * idf, w))
        scored.sort(reverse=True)
        return [w for _, w in scored[:topk]]

    # ---- 可选：LLM 起名 ----
    namer = None
    if args.llm:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        if not torch.cuda.is_available():
            log("[!] --llm 需要 CUDA；本次跳过润色，仍然输出 c-TF-IDF 关键词。")
        else:
            tok = AutoTokenizer.from_pretrained(args.llm_model)
            mdl = AutoModelForCausalLM.from_pretrained(args.llm_model, torch_dtype="auto", device_map="cuda")
            namer = (tok, mdl)
            log(f"LLM 起名：{args.llm_model}")

    def name_of(key: tuple[int, int], words: list[str]) -> str:
        if not words:
            return "（无关键词）"
        if namer is None:
            return " ".join(words[:4])
        tok, mdl = namer
        prompt = (
            "下面是一组论文标题里最有区分度的英文关键词。"
            "请用**一个中文短语**（不超过 8 个字）概括它们对应的研究主题，只输出这个短语。\n"
            f"关键词：{', '.join(words)}\n主题："
        )
        ids = tok(prompt, return_tensors="pt").to("cuda")
        out = mdl.generate(**ids, max_new_tokens=24, do_sample=False)
        text = tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
        return text.strip().splitlines()[0][:24] or " ".join(words[:4])

    # ---- 输出 ----
    per_stratum: dict[int, list[dict]] = {}
    for (s, c), _cnt in cluster_papers.most_common():
        if cluster_papers[(s, c)] < args.min_papers:
            continue
        words = top_words((s, c), args.topk)
        per_stratum.setdefault(s, []).append(
            {
                "id": c,
                "papers": int(cluster_papers[(s, c)]),
                "zh": name_of((s, c), words),
                "top": words,
            }
        )

    out = SEM / domain / "labels.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "domain": domain,
                "method": "c-TF-IDF" + (" + LLM 起名" if namer else ""),
                "globalK": int(k),
                "strata": {str(s): lst for s, lst in sorted(per_stratum.items())},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    total_named = sum(len(v) for v in per_stratum.values())
    log(f"写入 {out}（{len(per_stratum)} 个层 · {total_named:,} 个研究点已起名）")
    log("下一步：python export.py --all --register")
    return 0


if __name__ == "__main__":
    sys.exit(main())
