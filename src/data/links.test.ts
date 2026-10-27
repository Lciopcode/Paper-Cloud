/**
 * `links.ts` 的单测。
 *
 * 这几条判据都是"**别给用户一个假地址**"的具体形态 —— 每一条都对应一个
 * 真的会犯的错（斜杠被编码、DOI 前缀拼两遍、检索词里塞进整条副标题）。
 */
import { describe, expect, it } from "vitest";
import { arxivAbsUrl, cnkiSearchUrl, doiUrl, linksFor, primaryLink, scholarSearchUrl } from "./links.ts";

describe("外链构造", () => {
  it("老号形态的 arXiv 号里的斜杠不能被编码", () => {
    // 编码成 hep-th%2F9901001 之后 arXiv 认不出来（会 404，而不是跳转）
    expect(arxivAbsUrl("hep-th/9901001")).toBe("https://arxiv.org/abs/hep-th/9901001");
    expect(arxivAbsUrl(" 1706.03762 ")).toBe("https://arxiv.org/abs/1706.03762");
  });

  it("DOI 前缀不会拼两遍", () => {
    expect(doiUrl("https://doi.org/10.1103/PhysRevLett.116.061102")).toBe(
      "https://doi.org/10.1103/PhysRevLett.116.061102",
    );
    expect(doiUrl("10.1103/PhysRevLett.116.061102")).toBe("https://doi.org/10.1103/PhysRevLett.116.061102");
  });

  it("检索词只取主标题（副标题会让命中过窄）", () => {
    const u = scholarSearchUrl("Attention Is All You Need: A Study Of Something Long");
    expect(decodeURIComponent(u.split("q=")[1])).toBe("Attention Is All You Need");
  });

  it("知网检索走 kns8s 的公开入口", () => {
    expect(cnkiSearchUrl("量子测量")).toContain("kns.cnki.net");
    expect(decodeURIComponent(cnkiSearchUrl("量子测量").split("kw=")[1])).toBe("量子测量");
  });

  it("库内论文：arXiv 全文是主链接", () => {
    const links = linksFor({ arxivId: "1706.03762", title: "Attention Is All You Need" });
    expect(links[0]?.kind).toBe("arxiv");
    expect(primaryLink({ arxivId: "1706.03762" })?.url).toBe("https://arxiv.org/abs/1706.03762");
  });

  it("库外论文：只有标题时退到检索，且**明说这是检索**", () => {
    const links = linksFor({ title: "Some Paywalled Paper" });
    expect(links.map((l) => l.kind)).toEqual(["scholar", "cnki"]);
    // note 里必须是"检索"，不能让人以为点开就有全文
    for (const l of links) expect(l.note).toContain("检索");
  });

  it("什么都没有的时候不编地址", () => {
    expect(linksFor({})).toEqual([]);
    expect(primaryLink({})).toBeNull();
  });
});
