#!/usr/bin/env python3
"""
论文云 · 嵌入分片续跑逻辑自检
================================================================================
守的是一条**续跑契约**：`.ok` 说"这一片可以复用"，就必须真的是**当前参数**产出的。

## 为什么值得单独写一个自检

`embed.py` 的分片可续跑（跑 3–6 小时的任务不能白跑），判据是"同名 `.ok` 存在"。
但最初 `.ok` 里只存了**数据本身**的 xxhash —— 它只能证明"文件没写坏"，
**不能证明"这片是当前模型产出的"**。

后果是静默的：换了 `--model` 重跑时，所有分片都被判定为"已完成"而跳过，
于是得到一份**两个模型的向量混在一起**的数据 ——
而校验会过、长度自洽、`verify_semantic` 也会过（它查的是结构与范围，
不是"这些向量是不是同一个模型算的"）。

实测踩到过：先用 all-MiniLM-L6-v2 跑了 math 的占位产物，
之后用 bge-m3 重跑时那 3 个分片本该重算，却因为 `.ok` 存在而被跳过。

所以这里把判定规则固化成用例 —— 尤其是"**旧格式必须被判为 stale**"那条：
它是唯一能救回上面那种情况的东西。

用法：
    python pipeline_gpu/selftest_resume.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

sys.path.insert(0, str(Path(__file__).resolve().parent))

from embed import shard_fingerprint, shard_status  # noqa: E402

results: list[bool] = []


def check(ok: bool, msg: str) -> None:
    results.append(ok)
    print(f"  {'✓' if ok else '✗'} {msg}")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="lunyun-resume-"))
    want = shard_fingerprint("models/bge-m3", 256, 256, 200000)

    print("用临时目录测 .ok 的续跑判定：")

    # 1) 没有 .ok → missing（要跑）
    ok_path = tmp / "a.ok"
    check(shard_status(ok_path, want) == "missing", "没有 .ok → missing（要跑）")

    # 2) 空文件 → missing（写了一半）
    ok_path.write_text("", encoding="utf-8")
    check(shard_status(ok_path, want) == "missing", "空 .ok → missing")

    # 3) 指纹完全一致 → ok（可复用）
    ok_path.write_text(json.dumps({**want, "xxh64": "deadbeef"}), encoding="utf-8")
    check(shard_status(ok_path, want) == "ok", "指纹一致 → ok（复用，不重算）")

    # 4) ★ 旧格式（只有一行 hex hash）→ stale（必须重算）
    ok_path.write_text("0123456789abcdef", encoding="utf-8")
    check(shard_status(ok_path, want) == "stale",
          "★ 旧格式 .ok（只有 xxhash）→ stale（无法证明是谁产出的，重算）")

    # 5) ★ 换了模型 → stale
    ok_path.write_text(
        json.dumps({**shard_fingerprint("sentence-transformers/all-MiniLM-L6-v2", 256, 256, 200000),
                    "xxh64": "deadbeef"}),
        encoding="utf-8",
    )
    check(shard_status(ok_path, want) == "stale", "★ 换过 --model → stale（不静默复用）")

    # 6) 换了维度 / 序列长度 / 分片大小 → 都算 stale
    for field, value in (("dim", 512), ("maxSeqLen", 512), ("shard", 100000)):
        ok_path.write_text(json.dumps({**want, field: value, "xxh64": "x"}), encoding="utf-8")
        check(shard_status(ok_path, want) == "stale", f"换过 {field} → stale")

    # 7) 不是 JSON 对象（比如是个数组）→ stale
    ok_path.write_text("[1,2,3]", encoding="utf-8")
    check(shard_status(ok_path, want) == "stale", "内容是数组而非对象 → stale")

    # 8) 当前真实的 math 分片：如果还是小模型留下的旧 .ok，必须被判为 stale
    real = Path(__file__).resolve().parent.parent / "semantic" / "math"
    oks = sorted(real.glob("emb-*.ok")) if real.exists() else []
    if oks:
        states = [shard_status(o, want) for o in oks]
        print(f"\n  实测 semantic/math 的 {len(oks)} 个 .ok：{states}")
        print("    （当前参数 = bge-m3 / 256 维 / 256 token / 分片 200000）")

        # ⚠️ 这条判据**不能假设分片处于某个状态**。
        #
        # 第一版写的是"必须全是 stale"，因为当时 math 的分片确实都是小模型留下的。
        # 但等它们真的被重算成 bge-m3 之后，正确的判定就是 ok 了 ——
        # 于是这条判据开始**假失败**（实测 9/10）。
        # 这跟"永远通过的空判据"是同一类问题的反面：判据把**某一时刻的状态**
        # 当成了**规则**。规则应该是"判定与文件内容一致"：
        #   · 旧格式（一行 hex）→ 必须 stale（无法证明是谁产出的）
        #   · JSON 指纹与当前参数一致 → 必须 ok
        #   · JSON 指纹与当前参数不符 → 必须 stale
        mismatch: list[str] = []
        for o, st in zip(oks, states):
            raw = o.read_text(encoding="utf-8").strip()
            if raw.startswith("{"):
                try:
                    got = json.loads(raw)
                except json.JSONDecodeError:
                    mismatch.append(f"{o.name}: JSON 解析失败但被判 {st}")
                    continue
                expect = "ok" if all(got.get(k) == v for k, v in want.items()) else "stale"
            else:
                expect = "stale"          # 旧格式
            if st != expect:
                mismatch.append(f"{o.name}: 内容指向 {expect}，却判成 {st}")
        check(not mismatch,
              f"★ 真实分片的判定与文件内容一致（{len(oks)} 个；不一致：{'、'.join(mismatch) if mismatch else '无'}）")
        if states:
            n_ok = sum(1 for s in states if s == "ok")
            print(f"    其中 {n_ok} 个已是当前参数产出的（指纹一致 → 复用），"
                  f"{len(states) - n_ok} 个待重算")
    else:
        print("\n  （semantic/math 下没有分片，跳过真实数据检查）")

    passed = sum(1 for r in results if r)
    print(f"\n结论：{passed}/{len(results)} 通过")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
