/**
 * 论文云 · 编号脊柱的单元测试
 * ============================================================================
 * 这些测试守的是**不变量**，不是"当前实现的行为"：
 * 一旦有人改坏了双射性，这里必须红。所以每个测试都写成"对全空间抽样验证"。
 */
import { describe, expect, it } from "vitest";
import {
  bitLength,
  catalogDigits,
  catalogSize,
  feistelPermute,
  idsForTitle,
  idsToTitle,
  indexForTitle,
  nextPow2,
  prefixIndex,
  prefixSpan,
  rankSpine,
  scatter,
  splitmix64,
  titleOfIndex,
  unrankSpine,
  unscatter,
  vocabSize,
  type Catalog,
} from "./spine";

/** 造一个小目录用于穷举验证（V=7, S=5 ⇒ |C| = 16807，可以**逐个**验证双射）。 */
function tinyCatalog(V = 7, slots = 5): Catalog {
  const vocab: string[] = [];
  for (let i = 0; i < V; i++) vocab.push(`w${i}`);
  return { id: "tiny", vocab, slots };
}

/** 确定性伪随机（同一台机器同一序列，测试可复现）。 */
function rnd(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 与管线共用的一种简单分词：小写、按非字母数字切分。 */
export function tokenizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

describe("目录容量与位数", () => {
  it("|C| = V^S，位数与十进制长度一致", () => {
    const c = tinyCatalog(7, 5);
    expect(vocabSize(c)).toBe(7n);
    expect(catalogSize(c)).toBe(16807n); // 7^5
    expect(catalogDigits(c)).toBe(5);
    // 真实规模：V=4000, S=20 ⇒ 73 位十进制（本项目实际使用的配置）
    const big: Catalog = { id: "x", vocab: new Array(4000).fill("w"), slots: 20 };
    expect(catalogDigits(big)).toBe(73);
    // 回归保护：曾经在自检脚本里写成 `V ** S`（number 幂），
    // 4000^20 溢出成 "1.2089258196146292e+72"，位数被算成 22。
    // 这里把两种算法的差异钉死，防止有人"优化"回 number 幂。
    const badNumberPow = String(4000 ** 20);
    expect(badNumberPow).toContain("e+"); // number 幂确实会溢出成科学计数法
    expect(badNumberPow.length).not.toBe(73);
    expect(catalogDigits(big)).toBe(catalogSize(big).toString().length); // 与 BigInt 真值一致
  });
});

describe("rank / unrank 是互逆的双射（穷举验证）", () => {
  it("对小目录逐一遍历：unrank(rank(x)) === x 且编号互不相同", () => {
    const c = tinyCatalog(7, 5);
    const total = Number(catalogSize(c));
    const seen = new Set<string>();
    for (let i = 0; i < total; i++) {
      const ids = unrankSpine(c, BigInt(i));
      expect(ids.length).toBe(c.slots);
      const back = rankSpine(c, ids);
      expect(back).toBe(BigInt(i));
      seen.add(ids.join(","));
    }
    // 双射的"满射"一侧：所有 i 产生的词序列两两不同，且数量正好等于 |C|
    expect(seen.size).toBe(total);
  });

  it("首位是最高位：前缀相同的编号落在连续区间（半编号的根基）", () => {
    const c = tinyCatalog(7, 5);
    const prefix = [3, 1];
    const lo = prefixIndex(c, prefix);
    const span = prefixSpan(c, prefix.length);
    // 该前缀锁定的区间内，每一号的词序列都以 prefix 开头
    for (let d = 0n; d < span; d++) {
      const ids = unrankSpine(c, lo + d);
      expect(ids.slice(0, 2)).toEqual(prefix);
    }
    // 区间外（前一号）就不该以它开头了
    if (lo > 0n) expect(unrankSpine(c, lo - 1n).slice(0, 2)).not.toEqual(prefix);
  });

  it("越界输入要报错，不能静默返回垃圾", () => {
    const c = tinyCatalog(7, 5);
    expect(() => unrankSpine(c, -1n)).toThrow();
    expect(() => unrankSpine(c, catalogSize(c))).toThrow();
    expect(() => rankSpine(c, [7])).toThrow(); // 词 id 越界
    expect(() => rankSpine(c, new Array(6).fill(0))).toThrow(); // 词数超过词槽
  });
});

describe("标题 ⇄ 编号", () => {
  it("能编码的标题必须能解回原词序列", () => {
    const c = tinyCatalog(7, 5);
    const title = "w3 w1 w6 w0 w2";
    const idx = indexForTitle(c, title, tokenizeTitle);
    expect(idx).not.toBeNull();
    expect(titleOfIndex(c, idx!)).toBe(title);
  });

  it("定长编码会**低位补 0**：解回来多出的 0 是词表第 0 个词 —— 展示时必须按真实词数截断", () => {
    const c = tinyCatalog(7, 5);
    const ids = [3, 1]; // 只用了 2 个词槽
    const idx = rankSpine(c, ids);
    const back = unrankSpine(c, idx);
    expect(back).toHaveLength(5); // 定长：永远是 S 位
    expect(back.slice(0, 2)).toEqual(ids);
    expect(back.slice(2)).toEqual([0, 0, 0]); // 补的是 0
    // 0 就是词表第 0 个词，所以不截断就会多出 w0 —— 这就是"model model model"的来源
    expect(idsToTitle(c, back)).toBe("w3 w1 w0 w0 w0");
    expect(idsToTitle(c, back.slice(0, ids.length))).toBe("w3 w1");
  });

  it("词表外的词被丢弃；全丢光返回 null（而不是 0 —— 0 是一个合法编号）", () => {
    const c = tinyCatalog(7, 5);
    expect(indexForTitle(c, "w1 zzz w2", tokenizeTitle)).toBe(
      rankSpine(c, [1, 2]),
    );
    expect(indexForTitle(c, "zzz yyy", tokenizeTitle)).toBeNull();
  });

  it("超长标题按词槽数截断（前 S 个词决定编号）", () => {
    const c = tinyCatalog(7, 5);
    const long = "w1 w2 w3 w4 w5 w6 w0";
    const short = "w1 w2 w3 w4 w5";
    expect(indexForTitle(c, long, tokenizeTitle)).toBe(indexForTitle(c, short, tokenizeTitle));
    expect(idsForTitle(c, long, tokenizeTitle)!.length).toBe(5); // 只留前 5 个
  });
});

describe("位运算工具", () => {
  it("bitLength / nextPow2 边界正确", () => {
    expect(bitLength(0n)).toBe(0);
    expect(bitLength(1n)).toBe(1);
    expect(bitLength(255n)).toBe(8);
    expect(bitLength(256n)).toBe(9);
    expect(nextPow2(2n)).toBe(2n);
    expect(nextPow2(3n)).toBe(4n);
    expect(nextPow2(9n)).toBe(16n);
    expect(nextPow2(1n)).toBe(2n); // 最小宽度 2（Feistel 需要正偶数宽度）
  });

  it("splitmix64 是确定性的，且确实在搅动（雪崩）", () => {
    expect(splitmix64(1n)).toBe(splitmix64(1n));
    expect(splitmix64(1n)).not.toBe(splitmix64(2n));
    // 相邻输入的输出应差异很大（汉明距离大致在 32 位上下）
    const a = splitmix64(1000n);
    const b = splitmix64(1001n);
    let diff = a ^ b;
    let bits = 0;
    while (diff > 0n) {
      bits += Number(diff & 1n);
      diff >>= 1n;
    }
    expect(bits).toBeGreaterThan(16);
  });
});

describe("Feistel 置换与散射的双射性（这是最容易悄悄坏掉的地方）", () => {
  it("Feistel 在整块上可逆：permute(invert(permute(x))) === x", () => {
    const width = 16;
    const key = 0x1234567890abcdefn;
    const r = rnd(42);
    for (let i = 0; i < 500; i++) {
      const x = BigInt(Math.floor(r() * 65536));
      const y = feistelPermute(x, width, key, false);
      expect(y).toBeLessThan(65536n);
      expect(feistelPermute(y, width, key, true)).toBe(x);
    }
  });

  it("Feistel 是置换（不只是单射）：小宽度上穷举所有输入，输出两两不同", () => {
    const width = 12;
    const key = 0xdeadbeefn;
    const n = 1 << width;
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) seen.add(feistelPermute(BigInt(i), width, key, false).toString());
    expect(seen.size).toBe(n);
  });

  it("scatter 是双射：|C| 内每个编号都被恰好命中一次（穷举）", () => {
    const R = 16807n; // 7^5，非 2 的幂 —— 正是会踩坑的情形
    const key = 0n;
    const hit = new Uint8Array(Number(R));
    for (let x = 0n; x < R; x++) {
      const y = scatter(R, key, x);
      expect(y).toBeGreaterThanOrEqual(0n);
      expect(y).toBeLessThan(R);
      expect(hit[Number(y)]).toBe(0); // 重复即表示不是双射
      hit[Number(y)] = 1;
    }
    expect(hit.every((v) => v === 1)).toBe(true);
  });

  it("unscatter 是 scatter 的逆（穷举）", () => {
    const R = 16807n;
    for (let x = 0n; x < R; x++) {
      expect(unscatter(R, 0n, scatter(R, 0n, x))).toBe(x);
    }
  });

  it("散射后的相邻编号不再相邻（这是'宇宙感'而非'整齐螺旋'的来源）", () => {
    const R = 1000003n; // 大素数，最坏情形之一
    let near = 0;
    const N = 5000;
    for (let x = 0n; x < BigInt(N); x++) {
      const y0 = scatter(R, 0n, x);
      const y1 = scatter(R, 0n, x + 1n);
      const d = y0 > y1 ? y0 - y1 : y1 - y0;
      if (d < 10n) near++; // 相邻输入产生"相距不到 10"的输出
    }
    // 若没有散射，near 会是 N-1；散射后应极少
    expect(near).toBeLessThan(N * 0.01);
  });

  it("散射对超界输入报错（不静默）", () => {
    expect(() => scatter(100n, 0n, 100n)).toThrow();
    expect(() => unscatter(100n, 0n, 100n)).toThrow();
    expect(() => scatter(100n, 0n, -1n)).toThrow();
  });

  it("真实规模的目录也能散射（47 位十进制，验证不溢出、不超时）", () => {
    const R = 4002n ** 13n; // ≈ 2.6e47
    const key = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 200; i++) {
      const x = (R / 200n) * BigInt(i) + BigInt(i); // 均匀铺开取样
      const y = scatter(R, key, x);
      expect(y).toBeGreaterThanOrEqual(0n);
      expect(y).toBeLessThan(R);
      expect(unscatter(R, key, y)).toBe(x);
    }
  });
});

describe("词表查找缓存", () => {
  it("同一 Catalog 多次调用返回同一张表（缓存命中不影响结果）", () => {
    const c = tinyCatalog(7, 5);
    const a = indexForTitle(c, "w2 w4", tokenizeTitle);
    const b = indexForTitle(c, "w2 w4", tokenizeTitle);
    expect(a).toBe(b);
    expect(idsToTitle(c, [2, 4])).toBe("w2 w4");
  });
});
