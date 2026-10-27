/**
 * 论文云 · **用户自带 API key（BYOK）**
 * ============================================================================
 * ## 这个文件为什么存在
 *
 * 作品里能"按需取引用"的外部数据源只有两条：Semantic Scholar（S2）与 OpenAlex。
 * 它们都按 key / 配额限流：我们内置的 S2 key 用久了会 429，OpenAlex 匿名额度
 * 只有 $0.10/天。用户若**自带自己的 key**，就应该能用自己那份配额 —— 而不是被
 * 我们的额度卡住。这就是"用户自带密钥"（bring your own key）的由来。
 *
 * ## 三条硬规则（安全）
 *
 *   1. **只存在这台浏览器**：`localStorage`（`lunyun.*` 四个键），不写服务器、不进仓库；
 *   2. **只发给 `127.0.0.1` 的本机服务**：前端调 `/api/*`（同源），由 `deploy/api-refs.mjs`
 *      把 key 放进上游请求头/参数；**不直连** S2/OpenAlex（浏览器也直连不了，CORS）；
 *   3. **不回显、不日志**：界面上默认 `type=password`；服务端任何日志/错误信息都不含 key。
 *
 * ## 为什么用 zustand + 手写 localStorage，而不是 persist 中间件
 *
 * 四个字段、几条 setter，价值不在"通用持久化"，而在**语义清楚**：
 * 空串表示"没有这个 key"（而不是"空 key"），并且 `apiKeyHeaders()` 是唯一出口 ——
 * 所有请求都从这里拿头，不会出现"某处忘了带 key"。
 */
import { create } from "zustand";

/** localStorage 键名（统一 `lunyun.` 前缀，避免和别的东西撞） */
export const API_KEY_STORAGE = {
  s2: "lunyun.s2Key",
  openalex: "lunyun.openAlexKey",
  mailto: "lunyun.openAlexMailto",
  /** "1" = 允许无静态引用表的学科也实时取（默认关） */
  allowLiveRefs: "lunyun.allowLiveRefs",
} as const;

/** localStorage 可能被隐私模式/嵌入页禁掉 —— 读写都不能让应用崩 */
function readString(key: string): string {
  try {
    return typeof window === "undefined" ? "" : (window.localStorage.getItem(key) ?? "");
  } catch {
    return "";
  }
}

function writeString(key: string, value: string): void {
  try {
    if (typeof window === "undefined") return;
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* 存不进去（隐私模式/配额满）不影响本次会话使用 */
  }
}

/**
 * key 清洗：去首尾空白、**去掉换行/控制字符**（粘贴时最常见的污染），限制长度。
 * 不校验格式 —— 各家的 key 长得不一样，让"测试连接"去回答"这个 key 到底能不能用"。
 */
export function cleanKey(raw: unknown, maxLen = 400): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLen);
}

export interface ApiKeyState {
  /** 用户自带的 Semantic Scholar key（空串 = 不用） */
  s2Key: string;
  /** 用户自带的 OpenAlex key（空串 = 不用） */
  openAlexKey: string;
  /** 用户自带的 OpenAlex mailto（礼貌池，可选；空串 = 用内置默认值） */
  openAlexMailto: string;
  /**
   * 允许"没有静态引用表"的学科在点星时也向数据库实时取引用。
   * **默认关**：首次取某学科要先建该学科的编号索引（10–30 秒），不主动开不会卡。
   */
  allowLiveRefs: boolean;
  setS2Key: (v: string) => void;
  setOpenAlexKey: (v: string) => void;
  setOpenAlexMailto: (v: string) => void;
  setAllowLiveRefs: (v: boolean) => void;
  /** 清掉全部 key / mailto（实时引用开关另有 setter，不在这里清） */
  clearAll: () => void;
}

export const useApiKeys = create<ApiKeyState>((set) => ({
  s2Key: readString(API_KEY_STORAGE.s2),
  openAlexKey: readString(API_KEY_STORAGE.openalex),
  openAlexMailto: readString(API_KEY_STORAGE.mailto),
  allowLiveRefs: readString(API_KEY_STORAGE.allowLiveRefs) === "1",

  setS2Key: (v) => {
    const val = cleanKey(v);
    writeString(API_KEY_STORAGE.s2, val);
    set({ s2Key: val });
  },
  setOpenAlexKey: (v) => {
    const val = cleanKey(v);
    writeString(API_KEY_STORAGE.openalex, val);
    set({ openAlexKey: val });
  },
  setOpenAlexMailto: (v) => {
    const val = cleanKey(v, 200);
    writeString(API_KEY_STORAGE.mailto, val);
    set({ openAlexMailto: val });
  },
  setAllowLiveRefs: (v) => {
    writeString(API_KEY_STORAGE.allowLiveRefs, v ? "1" : "");
    set({ allowLiveRefs: !!v });
  },
  clearAll: () => {
    writeString(API_KEY_STORAGE.s2, "");
    writeString(API_KEY_STORAGE.openalex, "");
    writeString(API_KEY_STORAGE.mailto, "");
    set({ s2Key: "", openAlexKey: "", openAlexMailto: "" });
  },
}));

/**
 * 所有请求带用户 key 的**唯一出口**。
 *
 * 返回只含**非空**字段：没填的 key 不发空头（空头会让服务端误以为"用户提供了一个空 key"）。
 */
export function apiKeyHeaders(): Record<string, string> {
  const s = useApiKeys.getState();
  const h: Record<string, string> = {};
  if (s.s2Key) h["x-user-s2-key"] = s.s2Key;
  if (s.openAlexKey) h["x-user-openalex-key"] = s.openAlexKey;
  if (s.openAlexMailto) h["x-user-openalex-mailto"] = s.openAlexMailto;
  return h;
}

/** 有没有任何一个用户 key（UI 用来显示"已配置"角标） */
export function hasUserKey(): boolean {
  const s = useApiKeys.getState();
  return !!(s.s2Key || s.openAlexKey);
}
