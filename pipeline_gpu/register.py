#!/usr/bin/env python3
"""
论文云 · 语义层登记
================================================================================
把 `public/data/semantic/` 里已导出的文件登记进 `manifest.json`，
前端据此**自动发现**第 5/6 层与同路线边 —— 不需要改任何前端代码。

这是"格式先定死"的好处：GPU 机器上跑完、把文件搬回来、跑一次本脚本，
界面就多出内容。

用法：
    python register.py                 # 扫描 semantic/ 目录，登记全部
    python register.py --domain cs
"""
from __future__ import annotations

import argparse
import datetime
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

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public" / "data"
SEM = PUB / "semantic"


def log(m: str) -> None:
    print(m, flush=True)


def probe(domain: str) -> dict:
    """只读文件头就够 —— 不把几百 MB 读进内存。"""
    out: dict = {}

    p = SEM / f"{domain}.emb.bin"
    if p.exists():
        with open(p, "rb") as f:
            head = f.read(24)
        if head[:8] == b"LUNYEMB1":
            count, dim, quant = struct.unpack_from("<III", head, 8)
            out["embedding"] = {
                "file": f"semantic/{domain}.emb.bin",
                "count": count,
                "dim": dim,
                "quant": "int8" if quant == 1 else f"unknown({quant})",
                "bytes": p.stat().st_size,
            }

    p = SEM / f"{domain}.clu.bin"
    if p.exists():
        with open(p, "rb") as f:
            head = f.read(20)
        if head[:8] == b"LUNYCLU1":
            count, k, rec = struct.unpack_from("<III", head, 8)
            out["clusters"] = {
                "file": f"semantic/{domain}.clu.bin",
                "count": count,
                "k": k,
                "recordBytes": rec,
                "bytes": p.stat().st_size,
            }

    p = SEM / f"{domain}.route.bin"
    if p.exists():
        with open(p, "rb") as f:
            head = f.read(12)
        if head[:8] == b"LUNYROU1":
            (count,) = struct.unpack_from("<I", head, 8)
            out["routes"] = {
                "file": f"semantic/{domain}.route.bin",
                "count": count,
                "bytes": p.stat().st_size,
            }

    p = SEM / f"{domain}.labels.json"
    if p.exists():
        data = json.loads(p.read_text(encoding="utf-8"))
        named = sum(len(v) for v in data.get("strata", {}).values())
        out["labels"] = {
            "file": f"semantic/{domain}.labels.json",
            "method": data.get("method", "unknown"),
            "strata": len(data.get("strata", {})),
            "named": named,
        }

    # 第 6 层「技术路线」：元信息在 JSON，归属表在定宽二进制（按 docId O(1)）。
    # 两个文件都在才算登记成功 —— 只登记一半会让前端拿到表却读不到"是否降级"这类说明。
    meta_p = SEM / f"{domain}.communities.json"
    table_p = SEM / f"{domain}.cmu.bin"
    if meta_p.exists() and table_p.exists():
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        with open(table_p, "rb") as f:
            head = f.read(20)
        if head[:8] == b"LUNYCMU1":
            count, k, rec = struct.unpack_from("<III", head, 8)
            out["communities"] = {
                "meta": f"semantic/{domain}.communities.json",
                "table": f"semantic/{domain}.cmu.bin",
                "count": count,
                "k": k,
                "recordBytes": rec,
                "membershipCount": meta.get("membershipCount", 0),
                "modularity": meta.get("modularity", 0.0),
                "degraded": bool(meta.get("degraded", False)),
            }
    elif meta_p.exists() or table_p.exists():
        # 只有一半 —— 明确报出来，不要静默登记一个读不了的东西
        log(f"  [!] {domain}: 社区文件只存在一半（meta={meta_p.exists()} table={table_p.exists()}），"
            "不登记第 6 层；重跑 export.py 即可")

    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default=None)
    args = ap.parse_args()

    m_path = PUB / "manifest.json"
    if not m_path.exists():
        raise SystemExit(f"找不到 {m_path}")
    manifest = json.loads(m_path.read_text(encoding="utf-8"))

    domain_ids = [d["id"] for d in manifest["domains"]]
    targets = [args.domain] if args.domain else domain_ids

    touched = 0
    for d in manifest["domains"]:
        if d["id"] not in targets:
            continue
        sem = probe(d["id"])
        if not sem:
            log(f"  {d['id']}: semantic/ 里没有这个学科的文件，跳过")
            continue
        d["semantic"] = sem
        # ⚠️ 这里**故意不**把 "sameRoute" 写进 `d["relations"]["kinds"]`。
        #
        # `relations.kinds` 声明的是 **`relations/<d>.nbr.bin` 这个文件里实际有哪些边**，
        # 而前端读的就只有那一个文件（`build-relations.mjs` 产出，实测 kinds = ["sameField"]）。
        # 同路线边在**另一个文件** `semantic/<d>.route.bin` 里，前端目前**没有读它的路径**
        # （`contract.ts` 的 DomainEntry 没有 semantic 字段、assets.ts 没有 loader）。
        #
        # 原来的写法只要发现 routes 就 add("sameRoute")，于是界面会多出一个
        # **一条边都筛不出来**的"同路线"筛选 —— 正是 contract.ts 注释里明确禁止的：
        #   "不允许出现'界面上有引用筛选、但数据里根本没有引用边'这种谎报。"
        #
        # 正确做法：routes 只登记在 `semantic` 下（客观描述"文件存在、多少条边"），
        # 等前端真的接上 route.bin 之后，再由那时决定往 kinds 里加。
        # 顺带一提：以前因为 magic 是 7 字节（见 community.py），
        # 这个分支其实**从来没进去过** —— 修好 magic 之后它才会生效，
        # 所以这个坑是"修一个 bug 会暴露另一个 bug"的典型，必须一起处理。
        touched += 1
        log(f"  {d['id']}: " + " · ".join(f"{k}({v.get('count', v.get('named', '?'))})" for k, v in sem.items()))

    if touched == 0:
        log("没有可登记的内容。")
        return 1

    manifest["semanticBuiltAt"] = datetime.datetime.now().isoformat()
    m_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # 服务器优先发 .br，所以必须同步更新，否则前端拿到的是旧 manifest
    try:
        import brotli
        (PUB / "manifest.json.br").write_bytes(brotli.compress(m_path.read_bytes(), quality=9))
        log("manifest.json 与 manifest.json.br 都已更新")
    except ImportError:
        log("[!] 没装 brotli 模块 => manifest.json.br **没有**更新。"
            "前端会优先拿到旧的 .br，看不到语义层。请 pip install brotli 后重跑本脚本。")
        return 1

    log(f"\n登记完成（{touched} 个学科）。回到前端验收：node deploy/verify.mjs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
