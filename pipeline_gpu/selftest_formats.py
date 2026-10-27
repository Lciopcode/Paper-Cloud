#!/usr/bin/env python3
"""
论文云 · 语义层二进制格式契约自检（clu.bin / route.bin）
================================================================================
守的是**头部声明与文件内容必须一致**这条契约，以及几条件序/范围判据。

## 为什么值得单独写一个自检

`cluster.py` 原来头部声明 `recBytes=4`（README 也写"u16 簇号 + u16 保留"），
实际却只写 2 字节/条 —— 文件长度 `20+2n`、声明 `20+4n`，**正好差一倍**。
这类错的危险之处是**它不崩**：下一步按 4 字节步长读，会读出"簇号/保留位"交错的数据，
看着还挺像回事（最小簇号恒 0、范围也对），直到前端画错才有人发现。

`verify_semantic.py` 里还修掉过一条**恒为真的空判据**：
`np.diff(a) >= 0` 而 `a` 是 **uint32** —— 递减时相减下溢回绕成大正数，
于是"按 a 升序"从来没生效过。本自检**专门构造一份乱序的 route.bin** 来确认它现在真的会报错。

## 判据原则（对齐项目已有的教训）

**只验证"正常情况通过"的自检等于没有自检。** 所以每个格式都配一份"故意写错"的用例，
并且断言"必须被抓住"。任何一条守卫失效，本脚本自己就会 exit 1。

用法：
    python pipeline_gpu/selftest_formats.py [--domain econ]
"""
from __future__ import annotations

import argparse
import shutil
import struct
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np

import cluster as clu_mod
import verify_semantic as vs

GOOD_K = 8
ROUTE_HEAD = 12
ROUTE_REC = 12
results: list[bool] = []


def report(ok: bool, msg: str) -> None:
    results.append(ok)
    print(f"  {'✓' if ok else '✗'} {msg}")


def expect_guard(label: str, runner, expect_fail: bool = True) -> None:
    """跑一条检查，断言"是否报错"符合预期。"""
    vs.fails.clear()
    runner()
    got = len(vs.fails) > 0
    ok = got == expect_fail
    report(ok, f"{label}：{'被抓住' if got else '未报错'}"
              f"（期望{'报错' if expect_fail else '通过'}）")
    for f in vs.fails:
        print(f"        判据 → {f}")
    if ok is False and expect_fail:
        print("        ⚠️ 守卫没生效 —— 这属于「永远通过的空判据」，比没有判据更糟")


# --------------------------------------------------------------------------- clu

def make_clusters(s_of_doc: np.ndarray) -> np.ndarray:
    """每层内轮转分配 0..k-1，保证 m>=4 的层至少有 2 个不同簇号。"""
    out = np.zeros(len(s_of_doc), dtype=np.uint16)
    layers: dict[int, list[int]] = {}
    for d in range(len(s_of_doc)):
        layers.setdefault(int(s_of_doc[d]), []).append(d)
    for members in layers.values():
        if len(members) < 4:
            continue
        for j, d in enumerate(members):
            out[d] = j % GOOD_K
    return out


def test_clu(target: Path, clusters: np.ndarray) -> None:
    print("\n[A] clu.bin 记录格式契约")

    clu_mod.write_clu(target, clusters, GOOD_K)
    size = target.stat().st_size
    want = clu_mod.CLU_HEAD_BYTES + len(clusters) * clu_mod.CLU_REC_BYTES
    report(size == want, f"写出长度 == 声明长度（{size} == {want}）")
    expect_guard("正常文件", lambda: vs.check_clusters(DOM, N_DOC, DOC_IDS, STRATA), expect_fail=False)

    # 复现原来那个 bug：声明 4、实际写 2
    target.write_bytes(
        b"LUNYCLU1" + struct.pack("<III", len(clusters), GOOD_K, 4) + clusters.tobytes()
    )
    expect_guard("2 字节/条的错文件（原来那个 bug）",
                 lambda: vs.check_clusters(DOM, N_DOC, DOC_IDS, STRATA))

    bad = np.zeros((len(clusters), 2), dtype=np.uint16)
    bad[:, 0] = clusters
    bad[:, 1] = 7
    target.write_bytes(
        b"LUNYCLU1" + struct.pack("<III", len(clusters), GOOD_K, 4) + bad.tobytes()
    )
    expect_guard("保留位非 0（内容错位）",
                 lambda: vs.check_clusters(DOM, N_DOC, DOC_IDS, STRATA))

    target.write_bytes(
        b"LUNYCLU1" + struct.pack("<III", len(clusters), GOOD_K, 2) + clusters.tobytes()
    )
    expect_guard("头部 recBytes 声明成 2",
                 lambda: vs.check_clusters(DOM, N_DOC, DOC_IDS, STRATA))

    clu_mod.write_clu(target, np.zeros(len(clusters), dtype=np.uint16), GOOD_K)
    expect_guard("所有簇号都是 0（层内没分出簇）",
                 lambda: vs.check_clusters(DOM, N_DOC, DOC_IDS, STRATA))


# ------------------------------------------------------------------------- route

def write_route(target: Path, a, b, w) -> None:
    assert len(a) == len(b) == len(w)
    body = np.empty(len(a), dtype=np.dtype([("a", "<u4"), ("b", "<u4"), ("w", "<f4")]))
    body["a"], body["b"], body["w"] = a, b, w
    target.write_bytes(b"LUNYROU1" + struct.pack("<I", len(a)) + body.tobytes())


def test_route(target: Path, expected_n: int) -> None:
    print("\n[B] route.bin 顺序/范围契约")

    n = 5000
    a = np.arange(n, dtype=np.uint32) * 2
    b = a + 1
    w = np.full(n, 0.9, dtype=np.float32)
    write_route(target, a, b, w)
    expect_guard("正常文件（升序、a<b、权重 0.9）",
                 lambda: vs.check_routes(DOM, expected_n), expect_fail=False)

    # ★ 这一条专门证明 `np.diff(uint32) >= 0` 那条恒真判据已经修好
    a_desc = a[::-1].copy()
    b_desc = b[::-1].copy()
    write_route(target, a_desc, b_desc, w)
    expect_guard("a 递减（乱序）—— 证明 uint32 下溢的恒真判据已修",
                 lambda: vs.check_routes(DOM, expected_n))

    write_route(target, a, a.copy(), w)          # a == b 自环
    expect_guard("存在自环 a == b", lambda: vs.check_routes(DOM, expected_n))

    a_oob = a.copy()
    a_oob[0] = np.uint32(expected_n + 10)        # 越界
    write_route(target, a_oob, b, w)
    expect_guard("docId 越界（>= 该学科篇数）", lambda: vs.check_routes(DOM, expected_n))

    # ★ 浮点舍入必须**通过**，真越界必须**失败** —— 这两者要能分开。
    #
    # 背景：这条判据第一版写成严格的 `w <= 1.0`，在 math（真实产物）上假失败了 ——
    # 实测最大 1.0000011921（超出 1.192e-06 = 10 倍 float32 eps，17 万条里 78 条），
    # 那是量化和点积的舍入误差，不是数据坏了。
    # 下面两个用例把"容差之内算过、之外算错"固定下来。
    w_eps = w.copy()
    w_eps[0] = np.nextafter(np.float32(1.0), np.float32(2.0))   # 1.0 之上最小的一步
    w_eps[1] = np.float32(1.0000011921)                          # 实测见到的那个真实值
    write_route(target, a, b, w_eps)
    expect_guard("权重 1.0+ε（浮点舍入，应通过）",
                 lambda: vs.check_routes(DOM, expected_n), expect_fail=False)

    w_bad = w.copy()
    w_bad[0] = np.float32(1.5)                   # 真越界
    write_route(target, a, b, w_bad)
    expect_guard("权重 1.5（真越界）", lambda: vs.check_routes(DOM, expected_n))

    # ★ 超过 200 万条：原来只填前 200 万、断言却作用于整个数组，会拿尾部 0 做判据而**假失败**
    big = 2_100_000
    ab = np.arange(big, dtype=np.uint32)
    write_route(target, ab, ab + np.uint32(1), np.full(big, 0.8, dtype=np.float32))
    expect_guard(f"{big:,} 条边（原来会因只填前 200 万而假失败）",
                 lambda: vs.check_routes(DOM, big + 10), expect_fail=False)


def main() -> int:
    sem = vs.SEM
    sem.mkdir(parents=True, exist_ok=True)
    clu_target = sem / f"{DOM}.clu.bin"
    route_target = sem / f"{DOM}.route.bin"
    saved = {}
    for t in (clu_target, route_target):
        if t.exists():
            bak = t.with_suffix(t.suffix + ".selfbak")
            shutil.copy2(t, bak)
            saved[t] = bak

    print(f"用 {DOM}（{N_DOC:,} 篇）的**真实层结构**测二进制格式契约")
    try:
        test_clu(clu_target, CLUSTERS)
        test_route(route_target, N_DOC)
    finally:
        for t, bak in saved.items():
            shutil.move(str(bak), str(t))
        for t in (clu_target, route_target):
            if t not in saved:
                t.unlink(missing_ok=True)

    passed = sum(1 for r in results if r)
    print(f"\n结论：{passed}/{len(results)} 通过"
          + ("" if passed == len(results) else " —— 有守卫失效，必须修"))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="econ", help="用哪个学科的 rank.bin 取真实层结构")
    ARGS = ap.parse_args()
    DOM = ARGS.domain

    manifest = vs.json.loads((vs.PUB / "manifest.json").read_text(encoding="utf-8"))
    N_DOC = int(next(d for d in manifest["domains"] if d["id"] == DOM)["papers"])
    DOC_IDS, STRATA = vs.load_strata(DOM)
    _s_of_doc = np.full(int(DOC_IDS.max()) + 1, 0xFFFF, dtype=np.uint16)
    _s_of_doc[DOC_IDS] = STRATA
    CLUSTERS = make_clusters(_s_of_doc)
    sys.exit(main())
