#!/usr/bin/env python3
"""
论文云 · 语义层导出
================================================================================
把中间产物合并成**前端能直接读的最终文件**，并做一次"能不能被读出来"的自检。

## 为什么要有单独一步

`embed.py` / `cluster.py` 的分片格式是为了**续跑**（写一半能接着来），
而前端要的是**单一文件 + 可 O(1) 随机访问**。两者的布局要求不同，
所以在最后一步做一次转换，而不是让前端去理解分片。

这一步**不需要 GPU**，可以在任何机器上跑 —— 也就意味着在这里跑一遍，
就能提前发现格式问题，不用等到搬回本机。

用法：
    python export.py --domain cs
    python export.py --all
"""
from __future__ import annotations

import argparse
import gzip
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
SEM_IN = ROOT / "semantic"
SEM_OUT = PUB / "semantic"

DIM_DEFAULT = 256


def log(m: str) -> None:
    print(m, flush=True)


def export_embedding(domain: str) -> dict | None:
    """把 emb-*.i8 分片合并成 <domain>.emb.bin（含头部，按 docId 顺序）。"""
    d = SEM_IN / domain
    shards = sorted(d.glob("emb-*.i8"))
    if not shards:
        log(f"  {domain}: 没有嵌入分片，跳过")
        return None

    parts = []
    dim = DIM_DEFAULT
    total = 0
    for s in shards:
        if not s.with_suffix(".ok").exists():
            raise SystemExit(f"{s.name} 缺 .ok 校验 —— 可能写了一半，删掉重跑 embed.py")
        raw = s.read_bytes()
        if raw[:8] != b"LUNYEMBS":
            raise SystemExit(f"{s.name} 魔法数不对")
        start, count, dim = struct.unpack_from("<III", raw, 8)
        if start != total:
            raise SystemExit(f"{s.name} 起点 {start} != 已累计 {total}")
        parts.append(np.frombuffer(raw, dtype=np.int8, offset=20).reshape(count, dim))
        total += count

    # ⚠️ **必须校验分片是否覆盖整个学科。**
    #    上面只检查了"每片有 .ok"和"起点连续"，**没有**检查"加起来够不够全学科篇数"。
    #    于是只要 embed.py 还没跑完（比如 8 片只落了 5 片），这里就会合并出一个
    #    **头对、长度自洽、却截断了**的 emb.bin —— 正是本项目反复强调的那类
    #    "看着对、其实错"的产物：magic 对、24+count×dim 对得上、分片起点连续，
    #    只有拿 manifest 的篇数一比才知道少了 46 万篇。
    #    实测风险是真实的：`export.py --all` 会在 cs 跑完时被执行，而那时 physics
    #    可能还在嵌入（本次全量跑就是这个时间线）。
    #    处理方式是**不写文件**（而不是写一个错的）：这样 register 也不会把一个
    #    假嵌入登记进 manifest，且不会中断其余学科的导出。
    expected = domain_paper_count(domain)
    if expected is None:
        log(f"  {domain}: [!] manifest 里查不到篇数，**无法确认**嵌入是否完整"
            f"（{total:,} 篇）—— 仍然写出，但请自行核对")
    elif total != expected:
        missing = expected - total
        log(f"  {domain}: [!] 嵌入分片只覆盖 {total:,} / {expected:,} 篇"
            f"（少 {missing:,}）—— **不写出** {domain}.emb.bin。"
            f"embed.py 还没跑完，跑完后重跑本命令即可")
        return None

    q = np.vstack(parts)
    SEM_OUT.mkdir(parents=True, exist_ok=True)
    out = SEM_OUT / f"{domain}.emb.bin"
    with open(out, "wb") as f:
        f.write(b"LUNYEMB1")
        f.write(struct.pack("<III", total, dim, 1))   # count, dim, quant=1(int8)
        f.write(struct.pack("<f", 1.0 / 127.0))       # scale：反量化用
        f.write(q.tobytes())
    log(f"  {domain}: 嵌入 {total:,} 篇 × {dim} 维 → {out.name}（{out.stat().st_size / 1e6:.1f} MB）")
    return {"file": f"semantic/{domain}.emb.bin", "count": total, "dim": dim, "quant": "int8"}


def export_clusters(domain: str) -> dict | None:
    src = SEM_IN / domain / "clu.bin"
    if not src.exists():
        log(f"  {domain}: 没有聚类文件，跳过")
        return None
    raw = src.read_bytes()
    if raw[:8] != b"LUNYCLU1":
        raise SystemExit(f"{src} 魔法数不对")
    count, k, rec = struct.unpack_from("<III", raw, 8)
    SEM_OUT.mkdir(parents=True, exist_ok=True)
    out = SEM_OUT / f"{domain}.clu.bin"
    out.write_bytes(raw)   # 布局已经是前端要的（定长 + 按 docId），直接搬
    log(f"  {domain}: 聚类 {count:,} 篇 · k={k} → {out.name}（{out.stat().st_size / 1e6:.1f} MB）")
    return {"file": f"semantic/{domain}.clu.bin", "count": count, "k": k}


def export_routes(domain: str) -> dict | None:
    src = SEM_IN / domain / "route.bin"
    if not src.exists():
        log(f"  {domain}: 没有同路线边，跳过")
        return None
    raw = src.read_bytes()
    if raw[:8] != b"LUNYROU1":
        raise SystemExit(f"{src} 魔法数不对")
    (count,) = struct.unpack_from("<I", raw, 8)
    SEM_OUT.mkdir(parents=True, exist_ok=True)
    out = SEM_OUT / f"{domain}.route.bin"
    out.write_bytes(raw)
    log(f"  {domain}: 同路线边 {count:,} 条 → {out.name}（{out.stat().st_size / 1e6:.1f} MB）")
    return {"file": f"semantic/{domain}.route.bin", "count": count}


def export_labels(domain: str) -> dict | None:
    src = SEM_IN / domain / "labels.json"
    if not src.exists():
        log(f"  {domain}: 没有层标签，跳过")
        return None
    SEM_OUT.mkdir(parents=True, exist_ok=True)
    out = SEM_OUT / f"{domain}.labels.json"
    text = src.read_text(encoding="utf-8")
    out.write_text(text, encoding="utf-8")
    # ⚠️ 计数要按 label.py **实际写出的结构**来：它写的是
    #    `{ domain, method, globalK, strata: { "<层号>": [ {id,papers,zh,top} ] } }`。
    #    这里原来读的是 `.get("clusters", [])` —— 那个键**根本不存在**，
    #    于是无论起了多少名字都打印"层标签 0 条"，看起来像标注全失败了。
    #    （register.py 用的是 strata，所以它报的 135 才是对的 —— 两个脚本对不上就是线索。）
    data = json.loads(text)
    strata = data.get("strata", {}) or {}
    n = sum(len(v) for v in strata.values())
    log(f"  {domain}: 层标签 {n} 条（{len(strata)} 个层）→ {out.name}")
    return {"file": f"semantic/{domain}.labels.json", "clusters": n, "strata": len(strata)}


def export_communities(domain: str) -> dict | None:
    """导出**第 6 层「技术路线」**：Leiden 社区划分。

    产出两个文件，职责分开：

      `<domain>.cmu.bin`          按 docId 索引的**定宽二进制**社区归属表
                                  magic "LUNYCMU1"(8) | count(u32) | k(u32) | recBytes(u32=4)
                                  记录：u32 社区号；`0xFFFFFFFF` = 该篇没有社区（没有边）
      `<domain>.communities.json` **只放元信息**（k/nodes/edges/模块度/是否降级…），
                                  不含 membership

    ## 为什么 membership 不留在 JSON 里

    `communities.json` 里的 `membership` 是一个 `{docId: 社区号}` 的对象。
    econ 只有 672 条，但**物理团量级会有上百万条** —— JSON 既慢又占内存，
    而前端要的是"点开一篇就知道它属于哪条路线"，也就是**按 docId O(1) 随机访问**。
    这正是 `contract.ts` 里写死的原则 2：**定宽二进制而非 JSON**。
    所以表走二进制，元信息留在 JSON（它是人读的，也对得上原文件名，便于溯源）。
    """
    src = SEM_IN / domain / "communities.json"
    if not src.exists():
        log(f"  {domain}: 没有社区划分（community.py 还没跑），跳过")
        return None
    data = json.loads(src.read_text(encoding="utf-8"))
    membership = data.get("membership") or {}
    k = int(data.get("k") or 0)

    # 表的长度取**该学科篇数**（来自 manifest，权威值），而不是 max(docId)+1 ——
    # 这样读取端可以明确区分"越界"（数据不对）与"没有社区"（正常，0xFFFFFFFF）。
    count = domain_paper_count(domain)
    if count is None:
        count = (max(int(d) for d in membership) + 1) if membership else 0
        log(f"  {domain}: manifest 里没有篇数，退化为 max(docId)+1 = {count:,}")

    NONE = 0xFFFFFFFF
    table = np.full(count, NONE, dtype=np.uint32)
    oob = 0
    for doc_id_s, cid in membership.items():
        doc_id = int(doc_id_s)
        if doc_id >= count:
            oob += 1
            continue
        table[doc_id] = np.uint32(cid)
    if oob:
        log(f"  {domain}: [!] membership 里有 {oob} 条 docId 超出该学科篇数（{count:,}），已忽略")

    SEM_OUT.mkdir(parents=True, exist_ok=True)
    out_bin = SEM_OUT / f"{domain}.cmu.bin"
    out_bin.write_bytes(
        b"LUNYCMU1" + struct.pack("<III", count, k, 4) + table.tobytes()
    )
    # 元信息：**去掉 membership** 再写（它已经进二进制表了）
    meta = {kk: vv for kk, vv in data.items() if kk != "membership"}
    meta["membershipCount"] = len(membership)
    out_json = SEM_OUT / f"{domain}.communities.json"
    out_json.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    log(f"  {domain}: 技术路线 {k} 条（{len(membership):,} 篇有归属 / 共 {count:,} 篇）"
        f" → {out_bin.name}（{out_bin.stat().st_size / 1e6:.2f} MB）+ {out_json.name}")
    return {
        "meta": f"semantic/{domain}.communities.json",
        "table": f"semantic/{domain}.cmu.bin",
        "count": count,
        "k": k,
        "recordBytes": 4,
        "membershipCount": len(membership),
    }


def domain_paper_count(domain: str) -> int | None:
    """从 manifest.json 读该学科的篇数（表的长度要用它，不该靠猜）。"""
    m_path = PUB / "manifest.json"
    if not m_path.exists():
        return None
    try:
        m = json.loads(m_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    for d in m.get("domains", []):
        if d.get("id") == domain:
            try:
                return int(d.get("papers"))
            except (TypeError, ValueError):
                return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--register", action="store_true", help="顺便登记进 manifest.json")
    args = ap.parse_args()

    if args.all:
        domains = [d.name for d in SEM_IN.iterdir() if d.is_dir()]
    elif args.domain:
        domains = [args.domain]
    else:
        raise SystemExit("必须给 --domain <id> 或 --all")

    result = {}
    for domain in sorted(domains):
        log(f"\n[{domain}]")
        result[domain] = {
            "embedding": export_embedding(domain),
            "clusters": export_clusters(domain),
            "routes": export_routes(domain),
            "labels": export_labels(domain),
            "communities": export_communities(domain),
        }

    if args.register:
        register(result)

    log("\n导出完成。下一步：python verify_semantic.py --all")
    return 0


def register(result: dict) -> None:
    """把语义层登记进 manifest.json —— 前端据此自动发现，**不需要改前端代码**。"""
    m_path = PUB / "manifest.json"
    m = json.loads(m_path.read_text(encoding="utf-8"))
    for d in m["domains"]:
        r = result.get(d["id"])
        if not r:
            continue
        sem = {k: v for k, v in r.items() if v}
        if sem:
            d["semantic"] = sem
    m["semanticBuiltAt"] = __import__("datetime").datetime.now().isoformat()
    m_path.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    # 同步更新 brotli 版本（服务器优先发 .br）
    try:
        import brotli
        (PUB / "manifest.json.br").write_bytes(
            brotli.compress(m_path.read_bytes(), quality=9)
        )
    except ImportError:
        log("（没装 brotli 模块，manifest.json.br 未更新 —— 请在本机跑 node pipeline/build-spine.mjs 重建，或 pip install brotli）")
    log("\nmanifest.json 已登记 semantic")


if __name__ == "__main__":
    sys.exit(main())
