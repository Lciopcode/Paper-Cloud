/**
 * 论文云 · 编号 ⇄ 标题 双射（**用真实资产**验证）
 * ============================================================================
 * ## 这个文件是从哪来的
 *
 * 原来这件事是在**浏览器自检**里做的（`deploy/verify.mjs` 第 5 节），
 * 走的路径是「虚空拉取」：随机取一个编号 → 算标题 → 判定占用。
 * 2026-10 按作者决定把「虚空拉取」整个删掉了，那条自检路径也就没了 ——
 * 但**它守的那条不变量必须留下**：编号决定标题、标题决定编号，两者是双射。
 * 所以把它挪到这里，改成纯单测。
 *
 * ## 为什么单测还不够，非得再读一次真实资产
 *
 * `spine.test.ts` 已经穷举验证过 `rank`/`unrank` 互逆 —— 但那是**自己造的目录**
 * （`{ vocab: ["w0","w1",…], slots: 5 }`）。原来的浏览器自检多守一层：
 * **构建产物里的编号与目录是不是自洽的**。这一层用合成目录测不出来 ——
 * 目录换了、`spine.bin` 忘了重建，两个文件就各自都「合法」但互相对不上，
 * 表现是「标题读出来是乱词」，而代码没有任何一处会报错。
 *
 * 所以这里读**磁盘上真实的** `public/data/<domain>/spine.demo.bin` 与 `vocab.json`，
 * 用和前端完全相同的方式拼出 `Catalog`，再验证真实记录里的编号能原样往返。
 *
 * ⚠️ 只读演示脊柱（每团几 MB），不读完整脊柱 —— 单测不该拖几十秒。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogSize, idsToTitle, rankSpine, unrankSpine, type Catalog } from "./spine.ts";
import { Spine } from "../data/assets.ts";

const DATA = join(process.cwd(), "public", "data");
/** 取一个大的（cs）和一个小的（econ）：两边的构建路径都要过 */
const DOMAINS = ["cs", "econ"];

function loadCatalog(domain: string): Catalog | null {
  const p = join(DATA, domain, "vocab.json");
  if (!existsSync(p)) return null;
  const v = JSON.parse(readFileSync(p, "utf8")) as { words: string[]; slots: number };
  return { id: domain, vocab: v.words, slots: v.slots };
}

function loadDemoSpine(domain: string): Spine | null {
  const p = join(DATA, domain, "spine.demo.bin");
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  return new Spine(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

/** 编号 → 标题（与 `cloud.ts` 的 `selectPaper` 用同一套规则） */
function titleOf(catalog: Catalog, rank: bigint, tokens: number): string {
  return idsToTitle(catalog, unrankSpine(catalog, rank).slice(0, Math.max(1, tokens)));
}

for (const domain of DOMAINS) {
  describe(`${domain}：真实资产里的编号与标题互逆`, () => {
    const catalog = loadCatalog(domain);
    const spine = loadDemoSpine(domain);

    it("资产存在（缺了就说明没构建，而不是「这条不变量没问题」）", () => {
      expect(catalog, `public/data/${domain}/vocab.json`).toBeTruthy();
      expect(spine, `public/data/${domain}/spine.demo.bin`).toBeTruthy();
      expect(catalog!.slots).toBeGreaterThan(0);
      expect(catalog!.vocab.length).toBeGreaterThan(1000);
      expect(spine!.recordCount()).toBeGreaterThan(100);
    });

    it("抽样 200 条真实记录：标题可读、非空、不夹占位符", () => {
      // 均匀抽样而不是取前 200 条 —— 前 200 条都在最早那批论文里，
      // 覆盖不到编号空间的后段，而编号空间的问题往往只在后段才暴露。
      const records = spine!.recordCount();
      const step = Math.max(1, Math.floor(records / 200));
      let checked = 0;
      for (let rec = 0; rec < records; rec += step) {
        const record = spine!.get(rec * spine!.stride);
        if (!record) continue;
        const ids = unrankSpine(catalog!, record.rank).slice(0, Math.max(1, record.tokens));
        const title = idsToTitle(catalog!, ids);
        expect(title.length).toBeGreaterThan(0);
        expect(title).not.toContain("undefined");
        expect(title.startsWith(" ")).toBe(false);
        checked++;
      }
      expect(checked).toBeGreaterThan(50);
    });

    it("真实目录上的双射：编号 → 词 → 编号（含边界与随机）", () => {
      /**
       * ⚠️ 这里刻意**不**用"真实记录里词数占满词槽的那些"来验证逐位相等。
       *    第一版就是那么写的，结果断言 `full > 0` 直接失败 —— 20 个词槽要
       *    标题长到 20 个词，这种论文很少，200 条抽样里一条都没有。
       *    那样写等于把"双射成立"绑在"能不能碰巧抽到长标题"上，是不稳的用例。
       *
       * 正确做法：直接拿**真实目录**构造占满词槽的词序列。
       * 双射是 `titlesOfLength(slots) ⇄ 0..size-1` 之间的事，
       * 不需要经过"某篇真实论文恰好这么长"这一层。
       */
      const size = catalogSize(catalog!);
      const slots = catalog!.slots;
      const S = BigInt(slots);
      const V = BigInt(catalog!.vocab.length);
      const samples: bigint[] = [0n, 1n, size - 1n, size / 2n];
      for (let i = 0; i < 50; i++) {
        samples.push((BigInt(i + 1) * 7919n * size) / 400n % size);
      }
      for (const idx of samples) {
        const ids = unrankSpine(catalog!, idx);
        expect(ids.length).toBe(slots);
        expect(ids.every((x) => x >= 0 && x < catalog!.vocab.length)).toBe(true);
        // 正演必须原样回到同一个编号
        expect(rankSpine(catalog!, ids)).toBe(idx);
      }
      // 目录规模必须与 V^S 一致（位数对不上说明目录或词槽数被改坏了）
      expect(catalogSize(catalog!).toString()).toBe((V ** S).toString());
    });

    it("同一个编号必然算出同一个标题（确定性 —— 永久链接与「记住位置」的前提）", () => {
      const rec = Math.floor(spine!.recordCount() / 3) * spine!.stride;
      const r = spine!.get(rec);
      expect(r).toBeTruthy();
      const a = titleOf(catalog!, r!.rank, r!.tokens);
      const b = titleOf(catalog!, r!.rank, r!.tokens);
      expect(a).toBe(b);
      // 多截一个词，标题必须真的变短 —— 否则「按真实词数截断」这件事没有生效
      if (r!.tokens > 1) {
        expect(titleOf(catalog!, r!.rank, r!.tokens - 1).length).toBeLessThan(a.length);
      }
    });
  });
}
