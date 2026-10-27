/**
 * 论文云 · 「数据源」面板（用户自带 API key / BYOK）
 * ============================================================================
 * ## 这个面板回答哪两个问题
 *
 *   ① **我有哪些数据源可用？** —— 调 `GET /api/sources`，列出
 *      arXiv 本地语料 / Semantic Scholar / OpenAlex，并如实标出
 *      「这台机器的内置 key 配没配」与「你的 key 填没填」。
 *   ② **我刚粘贴的 key 到底能不能用？** —— 每行「测试连接」调
 *      `GET /api/key-check?provider=`，让服务端用**这次请求头里的用户 key**
 *      发一次最小查询，回一句话结论 + HTTP 状态 + 耗时 + 一条真实样例。
 *
 * ## 安全边界（写在这里，也显示给用户）
 *
 *   · key 只存在**这台浏览器**的 localStorage（`src/state/apiKeys.ts` 负责）；
 *   · 只发给同源的 `/api/*`（本机 `127.0.0.1` 的 deploy/serve.mjs），不直连外部；
 *   · 默认 `type=password`；本组件**不把 key 写进任何状态行/DOM 文本**，
 *     测试请求的返回值里也没有 key（服务端只回凭据档位）。
 *
 * ## 为什么要单独开一个面板，而不是塞进 HUD 正文
 *
 * HUD 是"看星图时一直在的常驻面板"，而配 key 是一次性动作、还带输入框。
 * 常驻会让 HUD 变长；做成浮层则和 `BurstPanel`/`HierarchyPanel` 同一套交互：
 * 从 `.row-actions` 打开、右上角关掉。
 */
import { useEffect, useState } from "react";
import { apiKeyHeaders, useApiKeys } from "../state/apiKeys.ts";

/* ============================================================================
 * 服务端接口的形状（`deploy/api-refs.mjs` 的 handleSources / handleKeyCheck）
 * ========================================================================== */

/** `/api/sources` 里的一个数据源 */
interface SourceProvider {
  id: string;
  label: string;
  /** `local` = 本地语料；`http` = 需要联网的数据库 */
  kind?: string;
  /** **这台机器的 .env.local 里有没有内置 key**（不是 key 本身） */
  builtin?: boolean;
  /** 不填 key 也能用（只是额度/速度更差） */
  freeWithoutKey?: boolean;
  /** 用户 key 走哪个请求头（S2 用头） */
  keyHeader?: string;
  /** 用户 key 走哪个查询参数（OpenAlex 用参数） */
  keyParam?: string;
  docsUrl?: string;
  note?: string;
  rateNote?: string;
}

interface SourcesResponse {
  at?: number;
  providers?: SourceProvider[];
  /** 这次请求头里确实带了哪些用户 key（只有布尔，没有值） */
  userKeysConfigured?: { s2?: boolean; openalex?: boolean; mailto?: boolean };
  auth?: Record<string, string>;
  notes?: string[];
}

/** `/api/key-check` 的返回 */
interface KeyCheckResult {
  provider?: string;
  /** 这次请求是否真的用了用户 key */
  usingUserKey?: boolean;
  /** `user` | `builtin` | `anonymous`（服务端给的实际档位） */
  using?: string;
  status?: string;
  httpStatus?: number;
  ms?: number;
  note?: string;
  sample?: { title?: string; year?: number; citedBy?: number };
  error?: string;
}

/** 三个固定通道的展示顺序（服务端按这个顺序返回，这里也兜底） */
const PROVIDER_ORDER = ["corpus", "s2", "openalex"] as const;

/**
 * 服务端清单取不到时的兜底：面板不能因为一个 fetch 失败就变成空白 ——
 * 用户这时**最需要**的恰恰是输入框和「测试连接」。
 * 内置 key 配没配就不知道了（`builtin: undefined`），文案会显示"未知"。
 */
const FALLBACK_PROVIDERS: SourceProvider[] = [
  {
    id: "corpus",
    label: "arXiv 本地语料",
    kind: "local",
    freeWithoutKey: true,
    note: "3,052,327 篇：坐标、标题、摘要都在本地，不需要 key（星图不靠外部数据库扩充）。",
    docsUrl: "https://arxiv.org",
  },
  {
    id: "s2",
    label: "Semantic Scholar",
    kind: "http",
    freeWithoutKey: true,
    note: "点星取「引用/被引」关系；匿名池常 429，自带 key 的配额与稳定性都更好。",
    docsUrl: "https://www.semanticscholar.org/product/api",
  },
  {
    id: "openalex",
    label: "OpenAlex",
    kind: "http",
    freeWithoutKey: true,
    note: "两个方向都支持，老式 arXiv 号也能查；匿名额度低，免费 key 预算更高。",
    docsUrl: "https://help.openalex.org/api/authentication/",
  },
];

const STATUS_ZH: Record<string, string> = {
  ok: "可用",
  rate_limited: "被限流",
  error: "失败",
};

/** 状态 → `.src-status` 的配色档（ok 绿 / 限流金 / 失败红，与全站既有色一致） */
const STATUS_CLASS: Record<string, string> = {
  ok: "ok",
  rate_limited: "warn",
  error: "err",
};

const AUTH_ZH: Record<string, string> = {
  user: "你的 key",
  builtin: "内置 key",
  anonymous: "匿名",
};

/** 把异常/未知错误收成一句人话（绝不拼接 key，异常里也不会有） */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e ?? "");
}

type ProviderId = "s2" | "openalex";

interface TestState {
  busy: boolean;
  result?: KeyCheckResult;
}

export function SourcePanel({ onClose }: { onClose: () => void }) {
  /* ---- 受控输入：值直接来自 store（store 负责写 localStorage） ---- */
  const s2Key = useApiKeys((s) => s.s2Key);
  const openAlexKey = useApiKeys((s) => s.openAlexKey);
  const openAlexMailto = useApiKeys((s) => s.openAlexMailto);
  const allowLiveRefs = useApiKeys((s) => s.allowLiveRefs);
  const setS2Key = useApiKeys((s) => s.setS2Key);
  const setOpenAlexKey = useApiKeys((s) => s.setOpenAlexKey);
  const setOpenAlexMailto = useApiKeys((s) => s.setOpenAlexMailto);
  const setAllowLiveRefs = useApiKeys((s) => s.setAllowLiveRefs);
  const clearAll = useApiKeys((s) => s.clearAll);

  /** 明/暗文切换只用本地状态：不持久化、关掉面板就回到 password */
  const [showS2, setShowS2] = useState(false);
  const [showOpenAlex, setShowOpenAlex] = useState(false);

  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  /** 两条通道各自的测试状态（互不影响） */
  const [tests, setTests] = useState<Partial<Record<ProviderId, TestState>>>({});
  /** 「清除所有密钥」后的即时反馈（不是必须，但让用户知道真的清了） */
  const [cleared, setCleared] = useState(false);

  /** 打开面板时取一次清单（关闭时组件卸载，下次打开重新取） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/sources", { headers: apiKeyHeaders(), cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as SourcesResponse;
        if (alive) setSources(j);
      } catch (e) {
        if (alive) setSourcesError(errText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 测一次连接。
   *
   * 头用 `apiKeyHeaders()` 现取 —— 用户刚在输入框里敲的 key 会被 store 立即收下，
   * 所以「粘贴 → 测试」中间不需要任何"保存"动作。
   */
  async function runCheck(provider: ProviderId): Promise<void> {
    setTests((t) => ({ ...t, [provider]: { busy: true } }));
    try {
      const res = await fetch(`/api/key-check?provider=${provider}`, {
        headers: apiKeyHeaders(),
        cache: "no-store",
      });
      const j = (await res.json()) as KeyCheckResult;
      setTests((t) => ({ ...t, [provider]: { busy: false, result: j } }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [provider]: {
          busy: false,
          result: { status: "error", httpStatus: 0, note: `本机服务没响应：${errText(e)}` },
        },
      }));
    }
  }

  /** 改了 key 就把这条通道的旧结论作废 —— 否则界面会拿旧测试结果骗人 */
  function editS2(v: string): void {
    setS2Key(v);
    setTests((t) => ({ ...t, s2: undefined }));
  }
  function editOpenAlex(v: string): void {
    setOpenAlexKey(v);
    setTests((t) => ({ ...t, openalex: undefined }));
  }
  function editMailto(v: string): void {
    setOpenAlexMailto(v);
    setTests((t) => ({ ...t, openalex: undefined }));
  }

  function doClear(): void {
    clearAll();
    setShowS2(false);
    setShowOpenAlex(false);
    setTests({});
    setCleared(true);
  }

  /* 服务端清单 + 兜底合并成固定三行（这样即使接口失败也能填 key/测试） */
  const byId = new Map<string, SourceProvider>(FALLBACK_PROVIDERS.map((p) => [p.id, p]));
  for (const p of sources?.providers ?? []) byId.set(p.id, p);
  const providers = PROVIDER_ORDER.map((id) => byId.get(id)).filter(Boolean) as SourceProvider[];
  // 清单接口里出现了未知 id（以后可能加数据源）：也渲染出来，别悄悄吞掉
  for (const p of sources?.providers ?? []) {
    if (!PROVIDER_ORDER.includes(p.id as (typeof PROVIDER_ORDER)[number])) providers.push(p);
  }

  return (
    <div className="pp-panel src-panel" data-testid="source-panel" role="dialog" aria-label="数据源">
      <div className="pp-head">
        <span className="badge dim">数据源</span>
        <span className="muted small">你自己的 key 只在这台浏览器里</span>
        <button
          className="panel-close"
          data-testid="close-source-panel"
          onClick={onClose}
          aria-label="关闭数据源面板"
          title="关闭"
        >
          ×
        </button>
      </div>

      {/* ---- ① 隐私 / 边界说明 ---- */}
      <div className="src-boundary">
        <b>key 只保存在本机浏览器（localStorage）</b>，只发给你自己电脑上{" "}
        <code>127.0.0.1</code> 的本地服务；不上传、不入库，服务端日志与错误信息里也不含 key。
        <br />
        <b>数据源 ≠ 扩充星图语料</b>：星图仍然是本地 arXiv 的{" "}
        <b>3,052,327 篇</b>，外部数据库只在点星时补「这篇引用了谁 / 谁引用了它」。
      </div>

      {sourcesError && (
        <div className="src-status err">
          取不到数据源清单（本地服务可能没启动，或这还是旧版服务）：{sourcesError}
          <br />
          下面仍可填 key 并「测试连接」。
        </div>
      )}

      {/* ---- ② 数据源清单 ---- */}
      <div className="src-list">
        {providers.map((p) => {
          const isCorpus = p.id === "corpus";
          const pid: ProviderId | null = p.id === "s2" || p.id === "openalex" ? p.id : null;
          const userKeyFilled = pid === "s2" ? !!s2Key : pid === "openalex" ? !!openAlexKey : false;
          const test = pid ? tests[pid] : undefined;
          return (
            <div className="src-row" key={p.id}>
              <div className="src-row-head">
                <span className="src-row-name">{p.label}</span>
                {p.kind === "local" && <span className="src-kind">本地</span>}
                {p.docsUrl && (
                  <a className="src-doc" href={p.docsUrl} target="_blank" rel="noreferrer">
                    {isCorpus ? "arXiv" : "申请 / 文档"}
                  </a>
                )}
              </div>
              {p.note && <div className="src-row-note">{p.note}</div>}
              <div className="src-tags">
                {isCorpus ? (
                  <span className="src-tag on">无需 key</span>
                ) : (
                  <>
                    <span className={`src-tag ${p.builtin ? "on" : ""}`}>
                      {p.builtin === undefined ? "内置 key：未知" : p.builtin ? "内置 key 已配置" : "内置 key 未配置"}
                    </span>
                    <span className={`src-tag ${userKeyFilled ? "on" : ""}`}>
                      {userKeyFilled ? "你的 key 已填" : "你的 key 未填"}
                    </span>
                    {p.freeWithoutKey && <span className="src-tag">无 key 可走匿名（额度低）</span>}
                  </>
                )}
              </div>
              {pid && (
                <div className="src-row-actions">
                  <button
                    className="btn tiny"
                    data-testid={`test-${pid}`}
                    disabled={test?.busy}
                    onClick={() => void runCheck(pid)}
                    title="让本地服务用你填的 key（没填就用内置/匿名）发一次最小查询，只回答现在能不能用"
                  >
                    {test?.busy ? "测试中…" : "测试连接"}
                  </button>
                  {test?.busy && <span className="muted small">最多等 12 秒</span>}
                </div>
              )}
              {pid && (
                <div
                  className={`src-status ${STATUS_CLASS[test?.result?.status ?? ""] ?? ""}`}
                  data-testid={`key-status-${pid}`}
                  data-status={test?.result?.status ?? ""}
                >
                  <SourceStatusLine result={test?.result} filledKey={userKeyFilled} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- ③ 输入区 ---- */}
      <div className="src-label">你的 key</div>
      <label className="src-field">
        <span className="src-field-label">Semantic Scholar</span>
        <span className="src-input-row">
          <input
            className="src-input"
            data-testid="s2-key-input"
            type={showS2 ? "text" : "password"}
            value={s2Key}
            onChange={(e) => editS2(e.target.value)}
            placeholder="粘贴 S2 API key（留空 = 用内置 / 匿名）"
            autoComplete="off"
            spellCheck={false}
            aria-label="Semantic Scholar API key"
          />
          <button
            className="btn tiny src-eye"
            type="button"
            onClick={() => setShowS2((v) => !v)}
            title={showS2 ? "隐藏 key（默认就不显示明文）" : "临时显示，方便检查粘贴是否正确"}
          >
            {showS2 ? "隐藏" : "显示"}
          </button>
        </span>
        <span className="src-field-hint">
          只存在本机浏览器。测试连接会用它发一次请求；服务端不回显、不记录这个值。
        </span>
      </label>

      <label className="src-field">
        <span className="src-field-label">OpenAlex key</span>
        <span className="src-input-row">
          <input
            className="src-input"
            data-testid="openalex-key-input"
            type={showOpenAlex ? "text" : "password"}
            value={openAlexKey}
            onChange={(e) => editOpenAlex(e.target.value)}
            placeholder="粘贴 OpenAlex API key（留空 = 匿名，约 $0.10/天）"
            autoComplete="off"
            spellCheck={false}
            aria-label="OpenAlex API key"
          />
          <button
            className="btn tiny src-eye"
            type="button"
            onClick={() => setShowOpenAlex((v) => !v)}
            title={showOpenAlex ? "隐藏 key（默认就不显示明文）" : "临时显示，方便检查粘贴是否正确"}
          >
            {showOpenAlex ? "隐藏" : "显示"}
          </button>
        </span>
      </label>

      <label className="src-field">
        <span className="src-field-label">OpenAlex mailto（可选）</span>
        <span className="src-input-row">
          <input
            className="src-input"
            data-testid="openalex-mailto-input"
            type="text"
            inputMode="email"
            value={openAlexMailto}
            onChange={(e) => editMailto(e.target.value)}
            placeholder="你的邮箱，进「礼貌池」用（不会公开）"
            autoComplete="email"
            spellCheck={false}
            aria-label="OpenAlex 联系的邮箱（可选）"
          />
        </span>
        <span className="src-field-hint">OpenAlex 建议带邮箱；留空就用内置默认值。</span>
      </label>

      {/* ---- ④ 实时引用开关 ---- */}
      <div className="src-switch">
        <input
          id="allow-live-refs"
          data-testid="allow-live-refs"
          type="checkbox"
          checked={allowLiveRefs}
          onChange={(e) => setAllowLiveRefs(e.target.checked)}
        />
        <label htmlFor="allow-live-refs">
          <b>实时引用</b>
          <span className="src-field-hint" style={{ display: "block" }}>
            没有本地引用表的学科，点星时也向数据库实时取。首次取某学科要先建该学科的编号索引，
            大约 <b>10–30 秒</b>（期间界面会显示"正在取引用列表"）。默认关：不主动开就不会卡。
          </span>
        </label>
      </div>

      {/* ---- ⑤ 清除 ---- */}
      <div className="src-danger">
        <button className="btn tiny" data-testid="clear-keys" onClick={doClear} disabled={!s2Key && !openAlexKey && !openAlexMailto}>
          清除所有密钥
        </button>
        {cleared && <span className="src-clear-feedback">已清除：本机浏览器里不再保存任何 key。</span>}
      </div>

      {sources?.notes?.map((n, i) => (
        <div className="src-field-hint" key={i}>
          {n}
        </div>
      ))}
    </div>
  );
}

/**
 * 一条测试结论。
 *
 * 三种状态在界面上都用"一句话"说清楚，而不是只点一个红绿灯：
 * 用户真正要知道的是"**这次请求用的是谁的 key、被谁按住了**"。
 */
function SourceStatusLine({ result, filledKey }: { result?: KeyCheckResult; filledKey: boolean }) {
  if (!result) {
    return (
      <span className="muted">
        {filledKey ? "未测试。填了 key 后点「测试连接」确认它真的能用。" : "未测试。不填 key 时走内置 / 匿名配额。"}
      </span>
    );
  }
  const status = result.status ?? "error";
  const auth = AUTH_ZH[result.using ?? ""] ?? (result.usingUserKey ? "你的 key" : "内置 / 匿名");
  const ms = typeof result.ms === "number" ? `${result.ms} ms` : "—";
  return (
    <>
      <span className="src-status-line">
        {STATUS_ZH[status] ?? status} · 用{auth} · HTTP {result.httpStatus ?? "—"} · {ms}
      </span>
      {result.note && <span className="src-status-note">{result.note}</span>}
      {result.sample && (result.sample.title || result.sample.year || result.sample.citedBy !== undefined) && (
        <span className="src-status-note">
          样例：
          {result.sample.title ? `《${result.sample.title}》` : "（无标题）"}
          {result.sample.year ? ` · ${result.sample.year}` : ""}
          {result.sample.citedBy !== undefined ? ` · 被引 ${result.sample.citedBy}` : ""}
        </span>
      )}
    </>
  );
}
