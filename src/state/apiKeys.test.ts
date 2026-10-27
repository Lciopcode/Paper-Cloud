/**
 * `apiKeys.ts`（用户自带 key，BYOK）单测。
 *
 * 这里只测**纯逻辑**：清洗、请求头拼装、空值语义。
 * 浏览器才有的 localStorage 在 Node 测试环境里不存在 —— 我们的读写函数已经
 * try/catch 兜住（隐私模式/被禁也不崩），所以这些用例在 Node 下也能跑。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { API_KEY_STORAGE, apiKeyHeaders, cleanKey, hasUserKey, useApiKeys } from "./apiKeys.ts";

/** 每个用例前把 store 复位（避免用例之间互相污染） */
beforeEach(() => {
  useApiKeys.setState({ s2Key: "", openAlexKey: "", openAlexMailto: "", allowLiveRefs: false });
});

describe("cleanKey：粘贴污染清洗", () => {
  it("去首尾空白与换行（最常见的粘贴事故）", () => {
    expect(cleanKey("  abc123\n")).toBe("abc123");
    expect(cleanKey("\tabc123\r\n")).toBe("abc123");
  });

  it("去掉控制字符但不改可见内容", () => {
    expect(cleanKey("ab\u0000c\u001f")).toBe("abc");
    // 连字符、下划线都可能是合法 key 的一部分，不能动
    expect(cleanKey("sk-abc_DEF-123")).toBe("sk-abc_DEF-123");
  });

  it("截断超长输入（防止一个巨大的粘贴把请求头撑爆）", () => {
    expect(cleanKey("x".repeat(999), 400)).toHaveLength(400);
  });

  it("空值 / 非字符串都归成空串", () => {
    expect(cleanKey("   ")).toBe("");
    expect(cleanKey(undefined)).toBe("");
    expect(cleanKey(null)).toBe("");
  });
});

describe("apiKeyHeaders：只带非空 key，键名与后端约定一致", () => {
  it("没填任何 key 时是空对象（不发空头，否则服务端会当成'用户提供了空 key'）", () => {
    expect(apiKeyHeaders()).toEqual({});
  });

  it("S2 / OpenAlex / mailto 分别映射到三个头", () => {
    useApiKeys.setState({
      s2Key: "s2-key-123",
      openAlexKey: "oa-key-456",
      openAlexMailto: "me@example.com",
    });
    expect(apiKeyHeaders()).toEqual({
      "x-user-s2-key": "s2-key-123",
      "x-user-openalex-key": "oa-key-456",
      "x-user-openalex-mailto": "me@example.com",
    });
  });

  it("只填一个就只带一个", () => {
    useApiKeys.setState({ openAlexKey: "oa-key-456" });
    expect(apiKeyHeaders()).toEqual({ "x-user-openalex-key": "oa-key-456" });
  });
});

describe("setter：写入前清洗，空串表示'没有 key'", () => {
  it("setS2Key 会去换行并落进 store", () => {
    useApiKeys.getState().setS2Key("  k\n");
    expect(useApiKeys.getState().s2Key).toBe("k");
  });

  it("clearAll 清掉三个值（但不动'实时引用'开关）", () => {
    useApiKeys.setState({ s2Key: "a", openAlexKey: "b", openAlexMailto: "c", allowLiveRefs: true });
    useApiKeys.getState().clearAll();
    const s = useApiKeys.getState();
    expect([s.s2Key, s.openAlexKey, s.openAlexMailto]).toEqual(["", "", ""]);
    expect(s.allowLiveRefs).toBe(true);
  });
});

describe("hasUserKey：有任意一个用户 key 即为 true", () => {
  it("默认 false", () => {
    expect(hasUserKey()).toBe(false);
  });

  it("只填 S2 或只填 OpenAlex 都算 true", () => {
    useApiKeys.setState({ s2Key: "x" });
    expect(hasUserKey()).toBe(true);
    useApiKeys.setState({ s2Key: "", openAlexKey: "y" });
    expect(hasUserKey()).toBe(true);
  });
});

describe("localStorage 键名是公开契约（探针/文档会引用）", () => {
  it("前缀统一 lunyun.，且一次请求里的四个键都在", () => {
    expect(API_KEY_STORAGE).toEqual({
      s2: "lunyun.s2Key",
      openalex: "lunyun.openAlexKey",
      mailto: "lunyun.openAlexMailto",
      allowLiveRefs: "lunyun.allowLiveRefs",
    });
  });
});
