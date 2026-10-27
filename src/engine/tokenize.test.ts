/**
 * 论文云 · 分词器的单元测试
 * ============================================================================
 * 分词是所有编号的根基，所以这里测的是"**可解释性**"而不是"跑得通"：
 * 同一个概念的不同写法必须归一，不同的概念必须保持区分。
 */
import { describe, expect, it } from "vitest";
import { normalize, searchableTitle, tokenizeTitle } from "./tokenize";

describe("规范化", () => {
  it("NFKC + 小写：全角、大小写、连字符写法归一", () => {
    expect(normalize("ＤＥＥＰ Learning")).toBe("deep learning");
    expect(normalize("Deep-Learning")).toBe("deep-learning");
  });
});

describe("分词：同一概念的不同写法必须归一", () => {
  it("大小写不敏感", () => {
    expect(tokenizeTitle("Deep Learning")).toEqual(tokenizeTitle("deep learning"));
    expect(tokenizeTitle("DEEP LEARNING")).toEqual(tokenizeTitle("Deep Learning"));
  });

  it("连字符 / 下划线 / 空格一律等同（都当分隔符）", () => {
    const a = tokenizeTitle("deep-learning models");
    const b = tokenizeTitle("deep_learning models");
    const c = tokenizeTitle("deep learning models");
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("复数归一（保守规则）", () => {
    expect(tokenizeTitle("neural networks")).toEqual(tokenizeTitle("neural network"));
    expect(tokenizeTitle("theories")).toEqual(tokenizeTitle("theory"));
    expect(tokenizeTitle("classes")).toEqual(tokenizeTitle("class"));
  });

  it("但 -ss / -us 结尾不动（否则会误伤 class/pressure 这类词）", () => {
    // "class" 结尾是 ss，不该被当成复数去掉尾巴
    expect(tokenizeTitle("class")).toEqual(["class"]);
    // "glasses" 走 ses 规则 → glass（这是**有意**的归一：玻璃/眼镜在论文里同指一类材料或度量）
    expect(tokenizeTitle("glasses")).toEqual(["glass"]);
  });
});

describe("分词：无信息量的词要丢掉", () => {
  it("停用词被丢弃", () => {
    expect(tokenizeTitle("A Novel Approach to the Study of Networks")).toEqual(["network"]);
  });

  it("单字符除白名单外都丢弃（避免 r/c/x 之外的噪声）", () => {
    expect(tokenizeTitle("a b c d e")).toEqual(["c"]);
    expect(tokenizeTitle("R package for X")).toEqual(["r", "package", "x"]);
  });

  it("单个数字丢弃，且相邻的单字符也按规则处理", () => {
    // "3" 是单个数字 → 丢；"D" 不在单字符白名单（r,c,x,y,z,n,k,p,q）→ 丢
    expect(tokenizeTitle("3 D modeling")).toEqual(["modeling"]);
    // 但白名单里的单字符会保留
    expect(tokenizeTitle("3 X modeling")).toEqual(["x", "modeling"]);
  });

  it("有语义的短词**不能**被误当停用词丢掉", () => {
    // 这几个是真实的区分性标签，丢了会让不同论文撞号
    expect(tokenizeTitle("A New Model for Case Study")).toEqual(["new", "model", "case"]);
    expect(tokenizeTitle("Data Systems Learning Networks")).toEqual([
      "data", "system", "learning", "network",
    ]);
  });
});

describe("分词：顺序与去重（影响编号的语义）", () => {
  it("保持出现顺序 —— 首位是主题词，会成为编号最高位", () => {
    expect(tokenizeTitle("quantum gravity waves")).toEqual(["quantum", "gravity", "wave"]);
    expect(tokenizeTitle("gravity quantum waves")).toEqual(["gravity", "quantum", "wave"]);
    // 顺序不同 ⇒ 词序列不同 ⇒ 编号不同（这是正确的：标题不同）
    expect(tokenizeTitle("quantum gravity")).not.toEqual(tokenizeTitle("gravity quantum"));
  });

  it("同词重复只算一次（重复词不携带额外信息，不该白占词槽）", () => {
    expect(tokenizeTitle("networks and networks")).toEqual(["network"]);
    expect(tokenizeTitle("deep deep learning")).toEqual(["deep", "learning"]);
  });

  it("空标题 / 纯符号 / 纯停用词 → 空数组（调用方据此判定'无法编号'）", () => {
    expect(tokenizeTitle("")).toEqual([]);
    expect(tokenizeTitle("   ")).toEqual([]);
    expect(tokenizeTitle("--- /// ...")).toEqual([]);
    expect(tokenizeTitle("the a of and")).toEqual([]);
  });
});

describe("真实标题抽样（回归保护）", () => {
  it("几个真实 arXiv 标题的分词结果符合预期", () => {
    // "Is / All / You" 都是无区分度的虚词，被丢弃后只剩主题词 —— 这正是我们要的
    expect(tokenizeTitle("Attention Is All You Need")).toEqual(["attention", "need"]);
    expect(tokenizeTitle("BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding")).toEqual([
      "bert", "pre", "training", "deep", "bidirectional", "transformer", "language", "understanding",
    ]);
    expect(tokenizeTitle("Deep Residual Learning for Image Recognition")).toEqual([
      "deep", "residual", "learning", "image", "recognition",
    ]);
  });
});

describe("检索用规范化串", () => {
  it("保留词序、压成单空格（供子串匹配）", () => {
    expect(searchableTitle("Attention Is All You Need")).toBe("attention is all you need");
    expect(searchableTitle("  Deep-Learning:  A  Survey ")).toBe("deep learning a survey");
  });
});
