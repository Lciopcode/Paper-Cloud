/**
 * 论文云 · 永久链接的单元测试
 * ============================================================================
 * 这里守一件事：**往返一致** —— 编码再解码必须还原
 * （否则分享出去的链接打开是别的地方）。
 *
 * ⚠️ 2026-10：`#v=<学科>.<编号>`（虚空编号）那一套随「虚空拉取」一起删掉了。
 *    当时它守的是"73 位编号必须逐字保留、不能被 Number() 丢精度"——
 *    那条约束现在已经没有 URL 载体了，所以这里不再有用例。
 */
import { describe, expect, it } from "vitest";
import { decodePermalink, encodePermalink } from "./permalink";

describe("往返一致", () => {
  it("论文链接", () => {
    const s = { paper: { domain: "physics", docId: 731800 } };
    expect(decodePermalink(encodePermalink(s))).toEqual(s);
  });

  it("聚焦 / 模式 / 检索", () => {
    const s = { focus: "cs", mode: "time" as const, query: "quantum entanglement" };
    expect(decodePermalink(encodePermalink(s))).toEqual(s);
  });

  it("多个参数叠加", () => {
    const s = {
      paper: { domain: "cs", docId: 42 },
      mode: "time" as const,
      query: "galaxy",
    };
    expect(decodePermalink(encodePermalink(s))).toEqual(s);
  });

  it("带 # 前缀也能解析（浏览器 location.hash 是带 # 的）", () => {
    expect(decodePermalink("#p=math.7")).toEqual({ paper: { domain: "math", docId: 7 } });
    expect(decodePermalink("p=math.7")).toEqual({ paper: { domain: "math", docId: 7 } });
  });
});

describe("容错：坏链接不该让整个应用失效", () => {
  it("空 hash", () => {
    expect(decodePermalink("")).toEqual({});
    expect(decodePermalink("#")).toEqual({});
  });

  it("无法识别的参数被忽略，其余照常解析", () => {
    expect(decodePermalink("p=cs.1&zzz=3&m=time")).toEqual({
      paper: { domain: "cs", docId: 1 },
      mode: "time",
    });
  });

  it("非法 docId（负数 / 非整数 / 超范围）被拒", () => {
    expect(decodePermalink("p=cs.-1").paper).toBeUndefined();
    expect(decodePermalink("p=cs.1.5").paper).toBeUndefined();
    expect(decodePermalink("p=cs.99999999999").paper).toBeUndefined();
  });

  it("已经删掉的 v= 参数被当成无法识别的参数忽略（老链接不会让应用失效）", () => {
    // 这条是**兼容性**用例：`#v=` 曾经是合法格式，老链接可能还在别人手里。
    // 要求不是"还能用"，而是"不会崩、其余部分照常解析"。
    expect(decodePermalink("v=cs.123").paper).toBeUndefined();
    expect(decodePermalink("v=cs.123&p=math.9")).toEqual({ paper: { domain: "math", docId: 9 } });
  });

  it("非法模式被拒（不认识的模式名不该被当成合法值）", () => {
    expect(decodePermalink("m=banana").mode).toBeUndefined();
    expect(decodePermalink("m=time").mode).toBe("time");
  });

  it("没有点的 p= 被忽略（不会切成半个学科名）", () => {
    expect(decodePermalink("p=physics").paper).toBeUndefined();
  });
});

describe("编码：默认值不写进 URL", () => {
  it("领域模式（默认）不产生 m= 参数", () => {
    expect(encodePermalink({ mode: "domain" })).toBe("");
    expect(encodePermalink({ mode: "time" })).toBe("m=time");
  });

  it("空状态产生空 hash（地址栏保持干净）", () => {
    expect(encodePermalink({})).toBe("");
  });

  it("中文检索词被正确转义并能还原", () => {
    const s = { query: "量子纠缠" };
    const enc = encodePermalink(s);
    expect(enc).toContain("%");
    expect(decodePermalink(enc)).toEqual(s);
  });
});
