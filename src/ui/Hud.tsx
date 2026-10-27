/**
 * 群星 · 上帝视角 HUD（左侧总览面板）
 * ============================================================================
 * 排版基调与作品一致：**楷体衬线 + 鎏金渐变字**（金色渐变用 background-clip: text
 * 灌进字里 —— 这才是"鎏金"；给字加黄色 + 发光只会显得廉价）。
 */
import { useEffect, useRef, useState } from "react";
import { useCloud, useStats } from "../state/cloud.ts";
import type { CiteSource } from "../state/cloud.ts";
import { useApiKeys } from "../state/apiKeys.ts";
import { SourcePanel } from "./SourcePanel.tsx";
import { DOMAINS } from "../data/domains.ts";
import { venueTierZh } from "../data/venue.ts";
import { scholarSearchUrl, linksFor } from "../data/links.ts";
import { loadTitleZh } from "../data/titleZh.ts";
import { StarLabel } from "../three/StarLabel.tsx";
import { metaStoreOf, loadStratumTable } from "../data/assets.ts";
import { hasSemantic, loadSemantic } from "../data/semantic.ts";
import type { SemanticBundle } from "../data/semantic.ts";
import { IMPACT_AVAILABLE, LAYOUT_ZH } from "../three/layout.ts";
import { FLY_BASE_SPEED } from "../three/FlyCamera.tsx";

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * 边类型的中文名。
 *
 * ⚠️ 从 `EDGE_KIND` 的**值**映射，而不是自己另写一套字符串 ——
 *    两处各写一遍就一定会漂移（这个坑在本项目里已经踩过两次：
 *    层 id 的格式、以及检索键的转义）。
 */
const EDGE_KIND_ZH: Readonly<Record<string, string>> = {
  sameField: "同领域",
  cites: "引用",
  sameRoute: "同路线",
};

/**
 * 拼"学科 + docId"的查询键。
 *
 * ⚠️ 不要在各处直接写 `` `${domain}\u0000${docId}` ``：同一个转义在不同编辑途径
 * （编辑器、脚本替换、模板字符串）里很容易变成一个**字面的反斜杠加 u0000**，
 * 于是两处的键长得像但永远对不上 —— 表现为"取数成功但界面空白"，
 * 而且极难看出原因（实测踩过一次）。
 * 收成一个函数，顺便让 NUL 分隔符的意图（避免 id 拼接歧义）有一个说明的地方。
 */
function docKey(domain: string, docId: number): string {
  return `${domain}\u0000${docId}`;
}

export function Hud() {
  const stats = useStats();
  const runtime = useCloud((s) => s.runtime);
  const visible = useCloud((s) => s.visibleDomains);
  const quality = useCloud((s) => s.quality);
  const toggleDomain = useCloud((s) => s.toggleDomain);
  const loadFull = useCloud((s) => s.loadFull);
  const showAll = useCloud((s) => s.showAllDomains);
  const focusDomain = useCloud((s) => s.focusDomain);
  // 只用 setQualityManual（不用 setQuality）：手动改画质要记下"用户表过态了"，
  // 此后不再自动降级 —— 否则用户切回高画质、两秒后又会被自动降回（实测踩过）。
  const perfAutoDegraded = useCloud((s) => s.perfAutoDegraded);
  const setQualityManual = useCloud((s) => s.setQualityManual);
  const showCrossOnly = useCloud((s) => s.showCrossOnly);
  const showCites = useCloud((s) => s.showCites);
  const starMode = useCloud((s) => s.starMode);
  const toggleStarMode = useCloud((s) => s.toggleStarMode);
  const refMode = useCloud((s) => s.refMode);
  const setRefMode = useCloud((s) => s.setRefMode);
  /** 关系方向：引用 / 被引用 / 全部（后端 mode 参数） */
  const onRefMode = () => setRefMode(refMode === "refs" ? "cites" : refMode === "cites" ? "all" : "refs");
  const toggleCites = useCloud((s) => s.toggleCites);
  const citeTables = useCloud((s) => s.citeTables);
  const toggleCrossOnly = useCloud((s) => s.toggleCrossOnly);
  const layoutMode = useCloud((s) => s.layoutMode);
  const setLayoutMode = useCloud((s) => s.setLayoutMode);
  const layoutError = useCloud((s) => s.layoutError);
  const selection = useCloud((s) => s.selection);
  const clearSelection = useCloud((s) => s.clearSelection);
  /** 自由飞行的速度倍率（滚轮改它）—— 提示行要显示，让"滚轮到底改了啥"看得见 */
  const flySpeed = useCloud((s) => s.flySpeed);
  /** 锁定一颗星之后操作模型整个变了（拖拽环绕 / 滚轮调距离），提示行也必须跟着变 */
  const locked = selection?.kind === "paper";
  /** 展开"学术层级"面板的学科（null = 不展开） */
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  /** 是否展开"超新星遗迹"面板 */
  const [openBursts, setOpenBursts] = useState(false);
  /**
   * 是否展开「数据源」面板（用户自带 S2 / OpenAlex key）。
   * 同理独立于 `openBursts`：两个都是浮层，可以各自开关。
   */
  const [openSources, setOpenSources] = useState(false);
  /**
   * 有没有任何一个用户 key —— 只影响按钮文案（「数据源 · 已配置」），
   * 用 store 订阅而不是调 `hasUserKey()`：后者不订阅，填完 key 按钮不会更新。
   */
  const userKeyConfigured = useApiKeys((s) => !!(s.s2Key || s.openAlexKey));
  /**
   * 窄屏下抽屉是否收起。
   *
   * 初值直接取"窄屏 ⇒ 收起"，而不是 useEffect 里再改 ——
   * 否则手机上会先渲染出展开的抽屉、再跳成收起的，有一次很明显的闪动。
   * 用 900px 与 styles.css 的媒体查询**同一个断点**（两处不一致会出现
   * "CSS 认为是窄屏、JS 认为不是"的错位）。
   */
  const [drawerCollapsed, setDrawerCollapsed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches,
  );

  return (
    /* ⚠️ 用 Fragment 返回**两个同级兄弟**，而不是把面板塞进 `.hud` 里面。
       `.hud` 是一个 340px 宽的绝对定位 flex 容器 ——
       一旦面板成为它的子元素，`right: 18px` 就是相对 **.hud** 而不是视口，
       面板会被关在 340px 的盒子里（实测：视口无论多宽，面板右边界恒为 340、
       左边界恒为 −60 ⇒ 标题左侧被裁掉，而 body 是 overflow-x:hidden，连滚动条都没有）。
       这是"绝对定位要看定位祖先"的经典坑，写在这里以免以后又踩。 */
    <>
      {/* 选中星的浮动标签（照诗云的 .poet-label：绝对定位、pointer-events:none） */}
      <StarLabel />
      <div className={`hud${drawerCollapsed ? " collapsed" : ""}`}>
        {/*
          抽屉把手（只在窄屏显示，见 styles.css 的响应式段）。
          窄屏默认**收起**：这个作品的核心价值是那片星空，
          一进来就被面板盖掉六成屏幕是本末倒置。
        */}
        <div
          className="hud-handle"
          onClick={() => setDrawerCollapsed((v) => !v)}
          role="button"
          tabIndex={0}
          aria-expanded={!drawerCollapsed}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setDrawerCollapsed((v) => !v);
          }}
        >
          {drawerCollapsed ? "展开面板" : "收起面板"}
          <span className="hint">{fmt(stats.totalPapers)} 篇</span>
        </div>
        <header className="hud-top hud-brand">
        {/* 观测台徽标：四星连成的 asterism + 轨道环（纯内联 SVG，无外部资源） */}
        <div className="brand-row">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 48 32" role="presentation" focusable="false">
              <ellipse cx="24" cy="16" rx="21" ry="7.5" fill="none" stroke="currentColor" strokeOpacity=".28" strokeWidth="1" transform="rotate(-16 24 16)" />
              <path d="M9 12 22 21 37 9 30 26" fill="none" stroke="currentColor" strokeOpacity=".52" strokeWidth="1" />
              <circle cx="9" cy="12" r="2" fill="#f0b35a" />
              <circle cx="22" cy="21" r="1.4" fill="#5fd4d0" />
              <circle cx="37" cy="9" r="1.2" fill="#dbe4ee" />
              <circle cx="30" cy="26" r="1.6" fill="#7bd88f" />
            </svg>
          </span>
          <div className="brand-text">
            <h1 className="brand-title">
              群星<span className="brand-en">GOD VIEW</span>
            </h1>
            <div className="brand-sub mono">
              ALL-SKY OBSERVATORY<span className="brand-slash">/</span>上帝视角
            </div>
          </div>
        </div>
        <p className="tagline">arXiv 全量元数据 · 按学科排成星图 · 点星读论文与关系</p>
        <div className="stat-grid" role="group" aria-label="总量遥测">
          <div className="stat-cell">
            <span className="stat-k mono">PAPERS</span>
            <span className="stat-v mono">{fmt(stats.totalPapers)}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-k mono">FIELDS</span>
            <span className="stat-v mono">{stats.domainCount}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-k mono">READY</span>
            <span className="stat-v mono">{stats.ready}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-k mono">POINTS</span>
            <span className="stat-v mono">{fmt(stats.points)}</span>
          </div>
        </div>
        {/*
          ⚠️ 被点数上限截断时**必须说**。
          第一版「载入全部」只画了 11.2 万点却写着"全部"（见 points.ts 的说明）——
          把抽样结果当成全部，比功能缺失更糟：用户会据此刻断"这个学科就这么大"。
        */}
        {stats.truncated > 0 && (
          <div className="stat-note mono" title="受单次渲染点数上限限制，正在按步长抽样">
            已抽样 · 实际共 {fmt(stats.visiblePapers)} 篇
          </div>
        )}
      </header>

      <div className="sec-head">
        <span className="sec-no mono">01</span>
        <span className="sec-name mono">CATALOGUE</span>
        <span className="sec-cn">星团目录</span>
        <button className="link sec-action" onClick={showAll}>
          全部显示
        </button>
      </div>
      <div className="legend">
        {DOMAINS.map((d) => {
          const rt = runtime[d.id];
          const on = visible.includes(d.id);
          const phase = rt?.phase ?? "idle";
          return (
            <button
              key={d.id}
              className={`legend-row${on ? " on" : ""}${phase === "ready" ? " full" : ""}`}
              onClick={() => toggleDomain(d.id)}
              onDoubleClick={() => focusDomain(d.id)}
              title={`${d.blurb}\n（单击显示/隐藏，双击聚焦）`}
            >
              <span className="dot" style={{ background: d.color }} />
              <span className="lg-zh">{d.zh}</span>
              <span className="lg-num">{fmt(rt?.total ?? 0)}</span>
              {/* 层级入口：点开看这一团的学术层级（L1/L2/L3） */}
              <span className={`lg-phase ${phase}`} onClick={(e) => { e.stopPropagation(); setOpenDomain(d.id); }} title="查看这一团的学术层级">
                {phase === "ready" ? "完整" : phase === "demo" ? "演示" : phase === "loading" ? "载入" : phase === "error" ? "失败" : "待载"}
              </span>
              {/*
                完整点集入口。
                首屏只画"每 50 篇取一篇"的演示点集（物理团 2.9 万点），
                完整点集是 146 万点、脊柱 60 MB brotli —— 所以必须由用户明确要求才加载。
                ⚠️ 加载中要显示"载入中"并禁用：几秒到十几秒没有反馈，用户会以为卡死并重复点击。
              */}
              {phase === "demo" && !rt?.fullLoading && (
                <span
                  className="lg-load"
                  onClick={(e) => {
                    e.stopPropagation();
                    void loadFull(d.id);
                  }}
                  title={`载入「${d.zh}」的全部 ${fmt(rt?.total ?? 0)} 篇（离线数据，约需几秒）`}
                >
                  载入全部
                </span>
              )}
              {(rt?.fullLoading || phase === "loading") && <span className="lg-load busy">载入中…</span>}
            </button>
          );
        })}
        <div className="legend-foot mono" aria-hidden="true">
          <span>{DOMAINS.length} CLUSTERS · {visible.length} ON</span>
          <span>VISIBLE {fmt(stats.points)}</span>
        </div>
      </div>

      <div className="sec-head">
        <span className="sec-no mono">02</span>
        <span className="sec-name mono">CONTROLS</span>
        <span className="sec-cn">观测控制</span>
        <span className="sec-meta mono">{visible.length}/{DOMAINS.length} ON</span>
      </div>
      <div className="hud-top hud-controls">
        <div className="row-actions">
          <button className="btn tiny" onClick={() => setOpenBursts((v) => !v)} title="各研究方向的产出爆发点（超新星遗迹）">
            遗迹
          </button>
          <button
            className="btn tiny"
            onClick={onRefMode}
            title="关系方向：引用（它引用了谁）/ 被引用（谁引用了它）/ 全部"
          >
            {refMode === "refs" ? "关系：引用" : refMode === "cites" ? "关系：被引用" : "关系：全部"}
          </button>
            <button
            className="btn tiny"
            onClick={toggleStarMode}
            title="精选：每团只画高被引的星（默认）；全部：把已加载的点都画出来"
          >
            {starMode === "top" ? "星：精选" : "星：全部"}
          </button>
          <button
            className="btn tiny"
            onClick={toggleCites}
            title="把被引次数编进星球亮度（对数刻度）。数据是分批抓的，界面会如实显示覆盖率。"
          >
            {showCites ? "引用亮度：开" : "引用亮度：关"}
          </button>
          <button
            className="btn tiny"
            onClick={() => void toggleCrossOnly()}
            title="星尘流：只留跨学科论文（挂了多个 arXiv 分类）亮着 —— 它们才是构成星桥的那些工作"
          >
            {showCrossOnly ? "星尘流：开" : "星尘流：关"}
          </button>

          <button
            className="btn tiny"
            onClick={() => setQualityManual(quality === "high" ? "low" : "high")}
            title="低画质档压低点精灵的尺寸上限（实测瓶颈是填充率，不是顶点数）"
          >
            画质：{quality === "high" ? "高" : "低"}
            {perfAutoDegraded && <span className="muted">（自动）</span>}
          </button>
          {/* 用户自带 key：入口放在「画质」之后，与其它一次性/设置类动作排在一起 */}
          <button
            className="btn tiny"
            data-testid="open-source-panel"
            onClick={() => setOpenSources((v) => !v)}
            title="配置你自己的 Semantic Scholar / OpenAlex key，并查看各数据源是否可用（key 只存在这台浏览器）"
          >
            数据源{userKeyConfigured ? " · 已配置" : ""}
          </button>
          {selection && (
            <button className="btn tiny" onClick={clearSelection}>
              取消选择
            </button>
          )}
        </div>
        {/* 飞行/操作提示已移到页面底部固定遥测条（.hud-telemetry）；卡片里只留需要处理的状态 */}
        {perfAutoDegraded && (
          <div className="lb-note warn" style={{ marginTop: 8 }}>
            实测帧率偏低，已自动降到低画质（点更小更省填充率）。
            <button className="link" onClick={() => setQualityManual("high")}>
              仍然用高画质
            </button>
          </div>
        )}
        {/* 操作提示保留在左侧栏内（不另加底部浮条） */}
        <div className="hud-hint">
          {locked ? (
            <>已锁定选中论文 · 拖拽环绕 · 滚轮调距离 · 点空白或按移动键解锁 · F 全屏</>
          ) : (
            <>
              WASD 飞行 · 拖拽转向 · Q/E 滚转 · 滚轮调速 · F 全屏
              <br />
              速度 ×{flySpeed.toFixed(2)} · {(flySpeed * FLY_BASE_SPEED).toFixed(0)} 单位/秒
              <span className="muted"> · 点星查看论文 · 双击图例聚焦星团 · Esc 取消选中</span>
            </>
          )}
        </div>
      </div>

      {/* ---- 排列模式：三种模式各自是一套完整坐标（用户明确要求"中心轴不是不变的"）---- */}
      <div className="sec-head">
        <span className="sec-no mono">03</span>
        <span className="sec-name mono">OPTICS</span>
        <span className="sec-cn">排列与检索</span>
      </div>
      <div className="layout-bar">
        <span className="lb-label mono">ARRANGE</span>
        {(["domain", "time", "impact"] as const).map((m) => (
          <button
            key={m}
            className={`lb-btn ${layoutMode === m ? "on" : ""} ${m === "impact" && !IMPACT_AVAILABLE ? "dim" : ""}`}
            onClick={() => void setLayoutMode(m)}
            title={
              m === "domain"
                ? "8 座独立旋涡星系，按学科分列"
                : m === "time"
                  ? "一片盘状星系：对数螺旋，内圈最老、外缘最新（1986–2026）"
                  : "引力井：越靠近中心被引越多。「没有引用记录」的论文单独落在最外一环（未知 ≠ 不重要）"
            }
          >
            {LAYOUT_ZH[m]}
          </button>
        ))}
      </div>
      {layoutError && <div className="lb-err">{layoutError}</div>}
      {layoutMode === "impact" && (
        <div className="lb-note">
          引力井：<b>越靠近中心被引越多</b>（对数刻度）。最外一环是
          <b>「还没有引用记录」</b>的论文 —— 那是「未知」，不是「不重要」，所以单独分开放。
        </div>
      )}
      {layoutMode === "time" && (
        <div className="lb-note">
          内圈 1986 → 外缘 2026，每 10 年一圈刻度。颜色仍表学科（每个学科一个扇区），
          于是"哪个领域在哪个年代产出多少"可以直接读出来。
        </div>
      )}

      {/*
        引用数据的**覆盖率如实显示**。

        ⚠️ 这一段是诚实性要求，不是装饰：抓取是分批跑的，目前只有一部分论文有数据。
           不写清楚的话，用户会把「没有记录」读成「引用很少」——
           那是把**数据缺失伪装成结论**，比功能缺失更糟。
      */}
      {showCites &&
        (() => {
          const vis = visible.map((id) => citeTables[id]).filter(Boolean) as Array<{
            count: number;
            coveragePct: number;
          }>;
          if (vis.length === 0) {
            return (
              <div className="lb-note">
                引用数据还没覆盖当前可见的学科（抓取进行中）。已抓到的部分会按对数刻度编进亮度。
              </div>
            );
          }
          const total = vis.reduce((a, c) => a + c.count, 0);
          const cov = vis.reduce((a, c) => a + (c.coveragePct / 100) * c.count, 0);
          const pct = (100 * cov) / Math.max(1, total);
          return (
            <div className="lb-note">
              引用亮度已开：<b>{pct.toFixed(1)}%</b> 的可见论文有引用记录
              {pct < 99 && (
                <>
                  {" "}
                  · 其余 <b>{(100 - pct).toFixed(1)}%</b> 是「数据还没抓到」，<b>不是</b>
                  「引用很少」—— 它们保持中性亮度，不会被错误地画暗。
                </>
              )}
            </div>
          );
        })()}

      <SearchBox />
      </div>

      {selection?.kind === "paper" && <PaperPanel />}
      {openDomain && <HierarchyPanel domainId={openDomain} onClose={() => setOpenDomain(null)} />}
      {openBursts && <BurstPanel onClose={() => setOpenBursts(false)} />}
      {openSources && <SourcePanel onClose={() => setOpenSources(false)} />}
    </>
  );
}

/**
 * 关键词检索框。
 *
 * 检索在**浏览器里**跑（索引 126 MB，八团合计），所以能边打字边变暗 ——
 * 未命中的星压暗到 7%，命中的原样亮着（见 `src/three/shaders.ts` 的 aDim）。
 *
 * 输入防抖 260 ms：不加防抖的话，每次按键都会对百万级倒排做一次全量打分，
 * 手感会明显发涩。
 */
function SearchBox() {
  const searchQuery = useCloud((s) => s.searchQuery);
  const searchHits = useCloud((s) => s.searchHits);
  const searchBusy = useCloud((s) => s.searchBusy);
  const searchError = useCloud((s) => s.searchError);
  const search = useCloud((s) => s.search);
  const clearSearch = useCloud((s) => s.clearSearch);
  const selectPaper = useCloud((s) => s.selectPaper);
  const manifest = useCloud((s) => s.manifest);
  const [text, setText] = useState(searchQuery);
  const timer = useRef<number | null>(null);
  /** 检索结果的前若干条标题/年份/去处（Range 取回，几十条各几百字节） */
  const [hitInfo, setHitInfo] = useState<
    Map<string, { title: string; year: number; venue: string }>
  >(new Map());

  // 检索结果变化 → 取前若干条的元数据（只为**展示的那几条**取，不是全部命中）
  useEffect(() => {
    if (!searchHits || searchHits.top.length === 0) {
      setHitInfo(new Map());
      return;
    }
    let alive = true;
    void (async () => {
      const head = searchHits.top.slice(0, 10);
      const byDomain = new Map<string, number[]>();
      for (const h of head) {
        const arr = byDomain.get(h.domain) ?? [];
        arr.push(h.docId);
        byDomain.set(h.domain, arr);
      }
      const out = new Map<string, { title: string; year: number; venue: string }>();
      await Promise.all(
        [...byDomain.entries()].map(async ([dom, ids]) => {
          const store = metaStoreOf(dom);
          if (!store) return;
          const titles = await store.titlesOf(ids).catch(() => new Map<number, string>());
          const reader = await store.ensure().catch(() => null);
          for (const id of ids) {
            const h = reader?.head(id) ?? null;
            out.set(docKey(dom, id), {
              title: titles.get(id) ?? "",
              year: h?.year ?? 0,
              venue: h?.venueHead || "",
            });
          }
        }),
      );
      if (alive) setHitInfo(out);
    })();
    return () => {
      alive = false;
    };
  }, [searchHits]);

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (text !== searchQuery) void search(text);
    }, 260);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const hasIndex = (manifest?.domains ?? []).some((d) => d.search);

  return (
    <div className="search-box">
      <div className="sb-row">
        <input
          className="sb-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={hasIndex ? "搜索标题关键词…" : "检索索引未构建"}
          spellCheck={false}
          disabled={!hasIndex}
        />
        {text && (
          <button
            className="sb-clear"
            onClick={() => {
              setText("");
              clearSearch();
            }}
            title="清除"
          >
            ×
          </button>
        )}
      </div>

      {searchError && <div className="sb-err">{searchError}</div>}
      {searchBusy && <div className="muted small">检索中…</div>}

      {searchHits && !searchBusy && (
        <>
          <div className="sb-stat">
            命中 <b>{fmt(searchHits.total)}</b> 篇 · 词 {searchHits.terms.join(" ")}
            {searchHits.unknown.length > 0 && (
              <span className="muted"> · 未收录：{searchHits.unknown.join(" ")}</span>
            )}
          </div>
          {searchHits.top.length > 0 && (
            <div className="sb-list">
              {searchHits.top.slice(0, 10).map((h, i) => {
                const info = hitInfo.get(docKey(h.domain, h.docId));
                return (
                  <button
                    className="sb-item"
                    key={`${h.domain}:${h.docId}:${i}`}
                    onClick={() => selectPaper(h.domain, h.docId)}
                    title="选中这篇论文"
                  >
                    <span className="sb-dom">{DOMAINS.find((d) => d.id === h.domain)?.zh ?? h.domain}</span>
                    <span className="sb-main">
                      {/* 标题来自元数据（Range 取回）。取不到就退回 docId ——
                          宁可显示编号，也不要因为一次请求失败就整块空白。 */}
                      <span className="sb-title">{info?.title || `docId ${h.docId}`}</span>
                      <span className="sb-sub">
                        {info?.year ? `${info.year} · ` : ""}
                        {info?.venue ? `${info.venue} · ` : ""}
                        {h.score.toFixed(1)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="muted small" style={{ marginTop: 4 }}>
            未命中的星已压暗到 7%（保留星系轮廓作为空间参照）。
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 层级面板：把**八层里的第 2～3 层**画出来。
 *
 * 这两层来自真实数据（arXiv 的顶层 archive 与二级分类），不是人工臆造：
 *   L2 一级学科 ← cs / math / cond-mat / astro-ph / hep-th …
 *   L3 研究方向 ← cs.CV / cond-mat.mtrl-sci / math.AP …
 * 每篇论文的层号**已经写进它的编号**，所以点任意一层都能立刻知道自己站在哪。
 */
function HierarchyPanel({ domainId, onClose }: { domainId: string; onClose: () => void }) {
  const manifest = useCloud((s) => s.manifest);
  const runtime = useCloud((s) => s.runtime);
  const dom = DOMAINS.find((d) => d.id === domainId);
  const entry = manifest?.domains.find((d) => d.id === domainId);
  const rt = runtime[domainId];
  const drill = useCloud((s) => s.highlightStratum);
  const drillStratum = useCloud((s) => s.drillStratum);
  const strata = entry?.strata ?? [];
  const total = entry?.papers ?? 0;

  // 按 L2（一级学科）归并 L3（研究方向）
  const groups = new Map<string, typeof strata>();
  for (const s of strata) {
    const arr = groups.get(s.arch) ?? [];
    (arr as typeof strata as unknown as typeof strata[number][]).push(s);
    groups.set(s.arch, arr as typeof strata);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) => b[1].reduce((x, s) => x + s.papers, 0) - a[1].reduce((x, s) => x + s.papers, 0),
  );

  return (
    <div className="pp-panel hier-panel">
      <div className="pp-head">
        <span className="badge" style={{ color: dom?.color, borderColor: dom?.color }}>
          {dom?.zh}
        </span>
        <span className="badge dim">学术层级</span>
        <button className="panel-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="muted small">
        共 <b>{strata.length}</b> 个研究方向（L3），分属 <b>{sorted.length}</b> 个一级学科（L2）。
        每篇论文的层号**已经写进它的编号**——所以编号一解出来，就知道它在宇宙的哪一层。
        {entry?.crossPct !== undefined && (
          <>
            <br />
            交叉列表论文占 {entry.crossPct}%（arXiv 里挂了多个分类）—— 这是真实的跨学科信号。
          </>
        )}
      </div>

      {/*
        下潜状态提示 + 取消。
        ⚠️ 没有这个提示的话，用户点了之后画面变暗会以为"数据丢了"——
        必须明确告诉他"这是你筛出来的，点这里可以取消"。
      */}
      {drill?.domain === domainId && (
        <div className="hier-drill-bar">
          <span>
            正在下潜：<b>{strata.find((s) => s.id === drill.stratumId)?.zh ?? drill.stratumId}</b>
            　其余论文已压暗
          </span>
          <button className="btn tiny" onClick={() => void drillStratum(domainId, null)}>
            取消下潜
          </button>
        </div>
      )}

      <div className="hier-tree">
        {sorted.map(([arch, list]) => {
          const sum = list.reduce((a, s) => a + s.papers, 0);
          const sortedList = [...list].sort((a, b) => b.papers - a.papers);
          return (
            <div className="hier-l2" key={arch}>
              <div className="hier-l2-head">
                <span className="hier-arch">{arch}</span>
                <span className="hier-count">{fmt(sum)}</span>
                <span className="hier-pct">{((100 * sum) / Math.max(1, total)).toFixed(0)}%</span>
              </div>
              <div className="hier-l3-list">
                {sortedList.slice(0, 12).map((s) => {
                  const on = drill?.domain === domainId && drill?.stratumId === s.id;
                  return (
                  <button
                    className={`hier-l3${on ? " on" : ""}`}
                    key={s.id}
                    onClick={() => void drillStratum(domainId, on ? null : s.id)}
                    title={`${s.zh}（${s.en}）· ${fmt(s.papers)} 篇 · 点一下只留这个方向的论文亮着`}
                  >
                    <span className="hier-l3-zh">{s.zh}</span>
                    <span className="hier-bar">
                      <i style={{ width: `${Math.max(2, (100 * s.papers) / Math.max(1, sortedList[0].papers))}%` }} />
                    </span>
                    <span className="hier-count">{fmt(s.papers)}</span>
                  </button>
                  );
                })}
                {sortedList.length > 12 && (
                  <div className="muted small" style={{ paddingLeft: 2 }}>
                    还有 {sortedList.length - 12} 个研究方向…
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {rt && (
        <div className="muted small" style={{ marginTop: 10, borderTop: "1px solid rgba(255,210,122,0.12)", paddingTop: 10 }}>
          目录：{rt.catalog ? `${rt.catalog.vocab.length} 词 × ${rt.catalog.slots} 槽` : "未加载"} ·{" "}
          当前点集 {fmt(rt.points?.count ?? rt.demoPoints?.count ?? 0)} 点
          {!rt.full && "（抽样视图）"}
        </div>
      )}
    </div>
  );
}

function LocalGraph({
  domain,
  nbrs,
}: {
  domain: string;
  nbrs: readonly { docId: number }[];
}) {
  const selectPaper = useCloud((s) => s.selectPaper);
  const size = 170;
  const c = size / 2;
  const ring = size * 0.34;
  const points = nbrs.map((n, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, nbrs.length)) * Math.PI * 2;
    return { docId: n.docId, x: c + Math.cos(a) * ring, y: c + Math.sin(a) * ring };
  });

  return (
    <div className="lg-wrap">
      <svg width={size} height={size} className="lg-svg">
        {points.map((p) => (
          <line key={`l${p.docId}`} x1={c} y1={c} x2={p.x} y2={p.y} className="lg-edge" />
        ))}
        <circle cx={c} cy={c} r={6} className="lg-self" />
        {points.map((p) => (
          <g key={p.docId} onClick={() => selectPaper(domain, p.docId)} className="lg-node">
            <circle cx={p.x} cy={p.y} r={4.5} />
            {/* 透明的大圆只为放大点击区域 —— 4.5px 的圆太难点中 */}
            <circle cx={p.x} cy={p.y} r={12} className="lg-hit" />
          </g>
        ))}
      </svg>
      <div className="muted small lg-hint">
        中心＝本篇 · 周围＝{nbrs.length} 篇同领域 · 点击可跳转
      </div>
    </div>
  );
}

/**
 * 超新星遗迹面板：列出各研究方向的"产出爆发点"。
 *
 * 判据来自 `manifest.domains[*].meta.bursts`（构建期按 L3 层逐年统计后检测）：
 * 某年产出 ≥ 前三年均值的 2.2 倍，且当年 ≥ 40 篇、前三年均值 ≥ 8 篇。
 *
 * **为什么要前三年均值 ≥ 8**（这是实测踩出来的）：第一版只要求"前三年均值 > 0"，
 * 于是最强的"爆发"是 `cond-mat/other 2004 年 495 篇（前三年均值 0.33，1485×）`——
 * 1485 倍毫无意义，它是"一个几乎不存在的分类突然有了 495 篇"。
 *
 * **为什么有些条目带"疑分库迁移"**：arXiv 的 eess 分库 2017 年才建立、
 * econ 2018 年，那些年份的"爆发"是论文从别的分类迁过来，不是研究爆发。
 * 这类点单独标注，不与真爆发混在一起。
 *
 * 点任意一条 → 只留"那个方向 + 那一年"的论文亮着，
 * 于是清单上的数字变成可以逐个点开看的论文集合。
 */
function BurstPanel({ onClose }: { onClose: () => void }) {
  const manifest = useCloud((s) => s.manifest);
  const visible = useCloud((s) => s.visibleDomains);
  const selectedBurst = useCloud((s) => s.selectedBurst);
  const selectBurst = useCloud((s) => s.selectBurst);

  // 汇总可见学科的爆发点，按倍率排序
  const rows: Array<{
    domain: string;
    domainZh: string;
    stratumId: string;
    stratumZh: string;
    year: number;
    papers: number;
    prevAvg: number;
    ratio: number;
    artifact: boolean;
  }> = [];
  for (const d of manifest?.domains ?? []) {
    if (!visible.includes(d.id)) continue;
    const strataZh = new Map((d.strata ?? []).map((s) => [s.id, s.zh]));
    for (const b of d.meta?.bursts ?? []) {
      rows.push({
        domain: d.id,
        domainZh: d.zh,
        stratumId: b.stratum,
        // 层中文名从 manifest.strata 里查（bursts 里只存了 id）
        stratumZh: strataZh.get(b.stratum) ?? b.stratum,
        year: b.year,
        papers: b.papers,
        prevAvg: b.prevAvg,
        ratio: b.ratio,
        artifact: !!b.archiveArtifact,
      });
    }
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  const realCount = rows.filter((r) => !r.artifact).length;

  return (
    <div className="pp-panel burst-panel">
      <div className="pp-head">
        <span className="badge dim">超新星遗迹</span>
        <span className="muted small">{rows.length} 处爆发（真起爆 {realCount}）</span>
        <button className="panel-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="muted small" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        某研究方向某年产出 ≥ 前三年均值的 2.2 倍（且当年 ≥ 40 篇）即记为一次<b>爆发</b>。
        <br />
        点任意一条 → <b>只留构成那次爆发的论文亮着</b>。
      </div>

      <div className="burst-list">
        {rows.map((r, i) => {
          const on =
            selectedBurst?.domain === r.domain &&
            selectedBurst?.stratumId === r.stratumId &&
            selectedBurst?.year === r.year;
          return (
            <button
              className={`burst-row ${on ? "on" : ""} ${r.artifact ? "artifact" : ""}`}
              key={`${r.domain}:${r.stratumId}:${r.year}:${i}`}
              onClick={() =>
                void selectBurst(on ? null : { domain: r.domain, stratumId: r.stratumId, year: r.year })
              }
              title={r.artifact ? "该年 ≈ arXiv 分库建立年，多半是论文从别的分类迁过来，不是研究爆发" : "点开只留这批论文"}
            >
              <span className="br-year">{r.year}</span>
              <span className="br-main">
                <span className="br-name">
                  {r.stratumZh}
                  {r.artifact && <span className="br-flag">疑分库迁移</span>}
                </span>
                <span className="br-sub">
                  {r.domainZh} · {r.papers} 篇（前三年均值 {r.prevAvg}）
                </span>
              </span>
              <span className="br-ratio">{r.ratio}×</span>
            </button>
          );
        })}
        {rows.length === 0 && <div className="muted small">可见学科里没有达到阈值的爆发点。</div>}
      </div>

      {selectedBurst && (
        <div className="muted small" style={{ marginTop: 8 }}>
          正在高亮：
          {rows.find((r) => r.domain === selectedBurst.domain && r.year === selectedBurst.year)?.stratumZh ??
            selectedBurst.stratumId}{" "}
          {selectedBurst.year} 年 · 再点一次取消
        </div>
      )}
    </div>
  );
}

/** 论文详情（选中一颗星时显示）。 */
function PaperPanel() {
  /** 引用表（用于在详情里显示被引次数；未加载时不显示这一栏，而不是显示 0） */
  const citeTables = useCloud((s) => s.citeTables);
  const selection = useCloud((s) => s.selection);
  const runtime = useCloud((s) => s.runtime);
  const clearSelection = useCloud((s) => s.clearSelection);
  if (selection?.kind !== "paper") return null;
  const rt = runtime[selection.domain];
  const dom = DOMAINS.find((d) => d.id === selection.domain);
  if (!rt?.catalog) return null;

  // 编号是有几十位的大整数，展示时按 4 位分组，便于人读
  const rankStr = selection.record.rank.toString();
  const grouped = rankStr.replace(/\B(?=(\d{4})+(?!\d))/g, " ");
  const meta = selection.meta;

  return (
    <div className="paper-panel">
      <div className="pp-kicker">
        <span className="mono">OBSERVATION LOG</span>
        <span className="pp-kicker-cn">观测记录</span>
      </div>
      <div className="pp-head">
        <span className="badge" style={{ color: dom?.color, borderColor: dom?.color }}>
          {dom?.zh}
        </span>
        <span className="badge dim">docId {selection.docId}</span>
        <button className="panel-close" onClick={clearSelection}>
          ×
        </button>
      </div>

      <div className="pp-label">标题（由编号反查得到）</div>
      {/* 标题优先用元数据里的原文（更完整、大小写正确）；元数据没到时用编号反查的结果。
          两者**必然一致**（这是本作品的不变量），所以不会出现"标题跳变"的观感问题。 */}
      <div className="pp-title">{meta?.title || selection.title}</div>

      {/* ---- 语料元数据（异步补齐；缺失时明确说明而不是空着）---- */}
      {selection.metaLoading && !meta && <div className="muted small">正在取作者与摘要…</div>}
      {meta && (
        <>
          <div className="pp-meta">
            {/*
              被引次数。
              ⚠️ 三种情况必须**分别显示**，不能都写成「引用 0」：
                · 有记录、有引用 → 显示数字；
                · 有记录、0 引用 → 显示「0（尚未被引用）」；
                · **没有记录**   → 显示「暂无数据」，并说明是数据源未收录，
                  而不是"没人引用"。这一条是诚实性要求（见 cites.ts 的说明）。
            */}
            {(() => {
              const ct = citeTables[selection.domain];
              if (!ct) return null;
              const info = ct.info(selection.docId);
              if (!info) return null;
              if (!info.hasRecord) {
                return (
                  <span>
                    <span className="k">被引</span>
                    <span className="v muted" title="数据源未收录这篇，我们不知道它被引用了多少次 —— 这不等于 0 引用">
                      暂无数据
                    </span>
                  </span>
                );
              }
              return (
                <span>
                  <span className="k">被引</span>
                  <span className="v" title={`引用次数（数据源：OpenAlex / Semantic Scholar）`}>
                    {fmt(info.cites)}
                    {info.cites === 0 && <span className="muted"> · 尚未被引用</span>}
                  </span>
                </span>
              );
            })()}
            {meta.year > 0 && (
              <span>
                <span className="k">年份</span>
                <span className="v">{meta.year}</span>
              </span>
            )}
            {meta.authorCount > 0 && (
              <span>
                <span className="k">作者</span>
                <span className="v">{meta.authorCount} 位</span>
              </span>
            )}
            {meta.venue.trim() && (
              <span>
                <span className="k">发表</span>
                <span className={`pp-venue t${meta.venueTier}`} title={venueTierZh(meta.venueTier)}>
                  {meta.venue}
                </span>
              </span>
            )}
            {!meta.venue.trim() && <span className="k">未识别发表去处（预印本）</span>}
          </div>
          {meta.authors && <div className="pp-authors">{meta.authors}</div>}
          {meta.hasAbstract && <AbstractBlock domain={selection.domain} docId={selection.docId} />}
        </>
      )}

      <div className="pp-label">
        目录编号（共 {selection.indexDigits} 位）
        {selection.record.truncated && <span className="warn"> · 词表内的词超过词槽，已截断</span>}
      </div>
      <div className="pp-index">{grouped}</div>

      <div className="pp-grid">
        <div>
          <span className="muted small">词表内词数</span>
          <b>{selection.record.tokens}</b>
        </div>
        <div>
          <span className="muted small">词槽数 S</span>
          <b>{rt.catalog.slots}</b>
        </div>
        <div>
          <span className="muted small">词表 V</span>
          <b>{fmt(rt.catalog.vocab.length)}</b>
        </div>
      </div>

      <CitedPapers domain={selection.domain} docId={selection.docId} />

      <RelatedPapers domain={selection.domain} docId={selection.docId} />

      <SemanticLayer domain={selection.domain} docId={selection.docId} />

      <div className="muted small" style={{ marginTop: 8 }}>
        这篇论文的标题就是它编号的十进制展开 —— 反过来，任何一个编号也能算出一个标题，
        包括从未有人写过的那些。地址（散射后）决定它在星团里的位置。
      </div>
    </div>
  );
}

/**
 * 摘要（**点击才取**）。
 *
 * 摘要池有 2.9 GB，整份不可能加载。这里用 HTTP Range 只取这一篇的那一段
 * （通常 1–2 KB），所以"展开摘要"是瞬时且零负担的。
 */
function AbstractBlock({ domain, docId }: { domain: string; docId: number }) {
  const loadAbstract = useCloud((s) => s.loadAbstract);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 换论文时清空，避免显示上一片的摘要
  useEffect(() => {
    setText(null);
    setBusy(false);
  }, [domain, docId]);

  if (text !== null) {
    return (
      <>
        <div className="pp-label">摘要</div>
        <div className="pp-abstract">{text}</div>
      </>
    );
  }
  return (
    <button
      className="btn tiny ghost"
      style={{ marginTop: 8 }}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void loadAbstract(domain, docId).then((t) => {
          setText(t || "（这一篇没有摘要）");
          setBusy(false);
        });
      }}
    >
      {busy ? "正在取摘要…" : "展开摘要"}
    </button>
  );
}

/**
 * 语义层：第 5 层「研究点」+ 第三类关系「同路线」。
 *
 * ⚠️ **这一块是补上来的，而它的缺失曾经是一个真实的缺口。**
 * GPU 管线那边早就把 `emb/clu/route/labels` 四个文件的格式定死了，
 * 交接文档也因此承诺"跑完 GPU、登记进 manifest，前端一行代码都不用改"。
 * 但 `contract.ts` 里根本没有 `semantic` 字段、`assets.ts` 里也没有任何 loader ——
 * 于是 `register.py` 登记得再成功，界面也不会有任何变化。
 * 现在补齐契约（`src/data/semantic.ts`）并在面板里显示出来。
 *
 * 与「相关论文」一样，刻意区分三种"没有"：
 *   · manifest 没登记       → 说明这个学科还没跑 GPU（不是功能坏了）
 *   · 登记了但还没加载      → 给一个"加载"按钮
 *   · 加载了但没有同路线边  → 说明原因（阈值 / 引用证据缺失），而不是显示一片空白
 */
function SemanticLayer({ domain, docId }: { domain: string; docId: number }) {
  const manifest = useCloud((s) => s.manifest);
  const selectPaper = useCloud((s) => s.selectPaper);
  const entry = manifest?.domains.find((d) => d.id === domain);

  const [bundle, setBundle] = useState<SemanticBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nbrTitles, setNbrTitles] = useState<Map<number, string>>(new Map());
  /** docId → 层号（第 5 层的标签要按 (层号, 簇号) 查，所以要这张表） */
  const [strata, setStrata] = useState<Uint16Array | null>(null);

  // ⚠️ 只在**换学科**时清空，换论文时**保留**已加载的 bundle。
  //    第一版写的是 `[domain, docId]`，于是每点开一篇不同的论文都要重新点一次
  //    "加载语义层" —— 但 bundle 是**按学科**的（嵌入/聚类/标签都是整团的），
  //    与具体是哪一篇无关。保留它，换论文就能立刻看到新的研究点。
  useEffect(() => {
    setBundle(null);
    setErr(null);
    setStrata(null);
  }, [domain]);

  // 邻居标题是**按论文**的，换论文必须重取
  useEffect(() => {
    setNbrTitles(new Map());
  }, [domain, docId]);

  const routes = bundle?.routes ?? null;
  const cluster = bundle?.clusters?.clusterOf(docId) ?? -1;
  // 0xFFFF 是"没有层归属"的哨兵（见 loadStratumTable / rank.bin 的约定）
  const rawStratum = strata ? strata[docId] : 0xffff;
  const stratum = rawStratum === undefined || rawStratum === 0xffff ? -1 : rawStratum;

  const routeNbrs = routes ? routes.routesOf(docId).map((r) => r.docId) : [];
  /** 第 6 层：这一篇属于哪条技术路线（-1 = 不属于任何路线） */
  const myRoute = bundle?.communities?.communityOf(docId) ?? -1;

  // 同路线邻居的标题（走元数据 Range，只取几百字节）
  useEffect(() => {
    if (!routes || routeNbrs.length === 0) return;
    let alive = true;
    void (async () => {
      const store = metaStoreOf(domain);
      if (!store) return;
      const titles = await store.titlesOf(routeNbrs);
      if (alive) setNbrTitles(titles);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, docId, domain]);

  const load = async () => {
    if (!entry) return;
    setLoading(true);
    setErr(null);
    try {
      // 层号表与语义层一起取：标签是按 (层号, 簇号) 查的，缺一张就显示不出名字。
      // 层号表本身有缓存（loadStratumTable），重复调用不会重复下载。
      const [b, st] = await Promise.all([loadSemantic(entry), loadStratumTable(domain)]);
      setBundle(b);
      setStrata(st);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const label = bundle?.labels && stratum >= 0 && cluster >= 0 ? bundle.labels.labelOf(stratum, cluster) : null;

  const head = (
    <div className="pp-label" style={{ marginTop: 10 }}>
      语义层
      {bundle?.labels?.method ? `（${bundle.labels.method}）` : ""}
    </div>
  );

  if (!entry || !hasSemantic(entry)) {
    return (
      <div className="related">
        {head}
        <div className="muted small">
          这个学科还没有语义层（第 5/6 层需要显卡跑 <code>pipeline_gpu/</code> 那套脚本）。
          <br />
          这不是功能坏了 —— 跑完 GPU 管线后把 <code>public/data/semantic/</code> 与 manifest 拿回来即可。
        </div>
      </div>
    );
  }

  return (
    <div className="related">
      {head}

      {!bundle && !loading && (
        <>
          <div className="muted small">
            {/* 用 filter+join 而不是给每项加 " · " 前缀：后者在**第一项缺失**时
                会以分隔符开头（"已登记： · 同路线"）。 */}
            已登记：
            {[
              entry.semantic?.embedding ? "嵌入" : "",
              entry.semantic?.clusters ? "聚类" : "",
              entry.semantic?.routes ? "同路线" : "",
              entry.semantic?.labels ? "标签" : "",
              entry.semantic?.communities ? "技术路线社区" : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <button className="btn tiny" onClick={() => void load()}>
            加载语义层
          </button>
        </>
      )}

      {loading && <div className="muted small">正在加载语义数据…</div>}
      {err && <div className="muted small">加载失败：{err}</div>}

      {bundle && (
        <>
          <div className="nbr-row" style={{ marginTop: 6 }}>
            <span className="nbr-kind">研究点</span>
            <span className="nbr-main">
              <span className="nbr-title">
                {label?.zh || (cluster >= 0 ? `簇 #${cluster}` : "（未参与聚类）")}
              </span>
              <span className="nbr-meta">
                {stratum >= 0 ? `第 ${stratum} 层 · ` : ""}
                {cluster >= 0 ? `簇 ${cluster}` : "该层论文太少，未聚类"}
                {label ? ` · ${label.papers} 篇同研究点` : ""}
                {bundle.clusters ? ` · 全学科分出 ${bundle.clusters.distinct} 个研究点` : ""}
              </span>
            </span>
          </div>

          {label && label.top.length > 0 && (
            <div className="muted small" style={{ marginTop: 4 }}>
              特征词：{label.top.slice(0, 8).join(" · ")}
            </div>
          )}

          {/*
            第 6 层「技术路线」。
            与第 5 层的区别在界面上也要说清：第 5 层是**层内**聚类（某个研究方向内部的研究点），
            第 6 层是**跨研究方向**的社区 —— 一个社区会横跨 cv/lg/ml 几个方向，
            那才是"技术路线"的语义。所以这里标"跨研究方向"。
          */}
          {bundle.communities ? (
            <>
              <div className="nbr-row" style={{ marginTop: 8 }}>
                <span className="nbr-kind">技术路线</span>
                <span className="nbr-main">
                  <span className="nbr-title">
                    {myRoute >= 0 ? `路线 #${myRoute}` : "（不属于任何路线）"}
                  </span>
                  <span className="nbr-meta">
                    {myRoute >= 0
                      ? `${fmt(bundle.communities.sizeOf(myRoute))} 篇同路线 · `
                      : "这篇没有达到阈值的同路线邻居 · "}
                    全学科 {fmt(bundle.communities.presentRoutes)} 条路线 ·{" "}
                    {fmt(bundle.communities.membershipCount)} 篇有归属 / 共 {fmt(bundle.communities.count)} 篇
                    {bundle.communities.modularity
                      ? ` · 模块度 ${bundle.communities.modularity.toFixed(3)}`
                      : ""}
                  </span>
                </span>
              </div>

              {/* 让"第 6 层"以层级的形式露出来，而不是只有一句编号 */}
              {bundle.communities.presentRoutes > 1 && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  规模最大的几条（跨研究方向）：
                  {bundle.communities
                    .topRoutes(5)
                    .map((r) => ` #${r.id}(${fmt(r.papers)} 篇)`)
                    .join(" ·")}
                </div>
              )}

              {bundle.communities.degraded && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  ⚠️ 第 6 层是<b>降级结果</b>：{bundle.communities.degradedReason ?? "引用证据不可用"}
                </div>
              )}
            </>
          ) : (
            <div className="muted small" style={{ marginTop: 8 }}>
              第 6 层「技术路线」还没有数据（<code>community.py</code> 或 <code>export.py</code> 还没跑）。
            </div>
          )}

          <div className="pp-label" style={{ marginTop: 8 }}>
            同路线（同一条「技术路线」内、语义近邻的论文）
          </div>
          {routeNbrs.length === 0 ? (
            <div className="muted small">
              {routes
                ? `这篇没有达到阈值的同路线邻居（整个学科共 ${fmt(routes.edgeCount)} 条同路线边、涉及 ${fmt(routes.nodesWithRoutes)} 篇论文）。`
                : "这个学科没有同路线边数据。"}
            </div>
          ) : (
            <div className="nbr-list">
              {routeNbrs.slice(0, 12).map((id, i) => (
                <div className="nbr-row" key={`route:${id}:${i}`}>
                  <span className="nbr-kind">同路线</span>
                  <span className="nbr-main">
                    <span className="nbr-title">{nbrTitles.get(id) || `docId ${id}`}</span>
                    <span className="nbr-meta">docId {id}</span>
                  </span>
                  <button className="btn tiny ghost" onClick={() => selectPaper(domain, id)}>
                    查看
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="muted small" style={{ marginTop: 6 }}>
            ⚠️ 同路线目前是<b>仅语义证据</b>（共被引那一路因引用边未抓到而缺席），
            脚本已把这件事记进 <code>communities.json</code> 的 <code>degraded</code> 字段。
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 相关论文（关系数据结构的第一类：**同领域边**）。
 *
 * 数据来自本地构建的邻接表（`pipeline/build-relations.mjs`），**不需要任何 API** ——
 * 因为层号早就写进了编号表，同领域关系是"顺带算出来"的。
 *
 * 界面上刻意区分两种"没有"：
 *   · 还没加载      → 显示按钮（"加载相关论文"）
 *   · 加载了但为空  → 显示"这一层只有它自己"
 * 混成一句"没有相关论文"会让用户以为功能坏了。
 */

/**
 * 引用来源的中文名。
 *
 * `static` 不是数据库名，而是**我们自己的本地预抓表** —— 这一档也要显示，
 * 否则用户会以为"没写来源"= 数据来路不明。
 */
const CITE_SOURCE_ZH: Readonly<Record<string, string>> = {
  static: "本地引用表",
  s2: "Semantic Scholar",
  openalex: "OpenAlex",
};

/** 那次请求实际用的凭据档位（用户自带 / 内置 / 匿名） */
const CITE_AUTH_ZH: Readonly<Record<string, string>> = {
  user: "你的 key",
  builtin: "内置 key",
  anonymous: "匿名",
};

/**
 * 拼「数据源：Semantic Scholar · 你的 key」这一行。
 *
 * 为什么要显示：用户自带 key 之后，必须能看见**自己的 key 有没有真的生效**，
 * 否则"我填了 key"只能靠猜 —— 而这恰好是这一轮功能存在的理由。
 * 未知来源 / 凭据原样显示，不硬编一个"未知"把信息吞掉。
 */
function citeSourceText(cs: CiteSource): string {
  const src = CITE_SOURCE_ZH[cs.source ?? ""] ?? cs.source ?? "外部数据库";
  const auth = cs.auth ? (CITE_AUTH_ZH[cs.auth] ?? cs.auth) : "";
  return auth ? `${src} · ${auth}` : src;
}

/**
 * **这篇引用的论文**（真实引用，作者要求的那一项）。
 *
 * ## 与下面「相关论文」的区别，界面上必须说清楚
 *
 * 两者都是"关系"，但来源完全不同：
 *   · 本块 = **引用**（Semantic Scholar 的 references，`citations/<d>.bin`）；
 *   · 下面那块 = **语义近邻**（标题+摘要嵌入算的，不是引用）。
 *
 * 把两者混成一个列表是最省事的做法，也是最坏的做法 ——
 * 这个作品的核心卖点就是"关系由数据算出、不编造"，把"相似"标成"引用"就是编造。
 *
 * ## 三种状态必须分开显示
 *
 *   1. 这个学科**没有引用表** → "本库尚未抓到引用数据"，并给出补数据的命令；
 *   2. 有引用表、这一篇**查到了 0 条** → "数据源里这一篇没有参考文献记录"
 *      （arXiv 早期论文确实常见，不能写成"它没引用任何论文"）；
 *   3. 有引用 → 列出标题 + 中文译名 + 外链，**外加**库外的那些（只有标题）。
 *
 * 三种状态在画面上都很像（都是一段灰字），但对用户的意义完全不同 ——
 * 这正是 `cites.ts` 顶部那条"查到 0 引用 ≠ 没有记录"的同一个道理。
 */
function CitedPapers({ domain, docId }: { domain: string; docId: number }) {
  const rt = useCloud((s) => s.runtime[domain]);
  const selectPaper = useCloud((s) => s.selectPaper);
  const [titles, setTitles] = useState<Map<number, string>>(new Map());
  /**
   * 中文译名（`title-zh/<d>.bin`，离线 NLLB 翻的，标注"机器翻译"）。
   * 只覆盖引用表涉及的论文，所以查不到是常态 —— 查不到就不显示那一行。
   */
  const [zh, setZh] = useState<Map<number, string>>(new Map());

  const refs = rt?.citeRefsDoc === docId ? rt?.citeRefs : undefined;
  const ext = rt?.citeRefsDoc === docId ? rt?.citeExt : undefined;
  const loading = rt?.citeRefsLoading && rt?.citeRefsDoc === docId;
  const table = rt?.citations;
  /**
   * 这批引用是**从哪来的**（本地预抓表 / S2 / OpenAlex，以及那次请求实际用的凭据）。
   *
   * 与 refs/ext 一样按 `citeRefsDoc` 判有效：换选中论文后旧来源必须立刻失效，
   * 否则界面会把上一篇的来源贴到这一篇头上。
   */
  const citeSource = rt?.citeRefsDoc === docId ? rt?.citeSource : undefined;
  /** 用户有没有在「数据源」面板里打开"实时引用"（决定下面要不要提示这个入口） */
  const allowLive = useApiKeys((s) => s.allowLiveRefs);

  // 引用列表确定之后，批量取这一批的标题（`MetaReader.titlesOf` 会把邻近的
  // Range 请求合并，几十个标题也只要 1–3 次请求）
  useEffect(() => {
    if (!refs || !refs.length) return;
    let alive = true;
    const store = metaStoreOf(domain);
    if (!store) return;
    void store
      .titlesOf(refs)
      .then((m) => {
        if (alive) setTitles(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [domain, refs]);

  useEffect(() => {
    if (!refs || !refs.length) return;
    let alive = true;
    void loadTitleZh(domain)
      .then((tb) => (tb ? tb.zhOfMany(refs.slice(0, 40)) : null))
      .then((m) => {
        if (alive && m) setZh(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [domain, refs]);

  return (
    <div className="pp-section">
      <div className="pp-label">
        引用的论文
        {refs && refs.length > 0 && <span className="muted"> · {refs.length} 篇在本库</span>}
        {ext && ext.length > 0 && <span className="muted"> · {ext.length} 篇在库外</span>}
      </div>
      {/*
        来源如实标出：本地预抓表 / S2 / OpenAlex，以及那次请求实际用的凭据。
        这一行是"我填的 key 到底生效了没"的唯一可见证据。
      */}
      {citeSource && (
        <div className="muted small" data-testid="cite-source">
          数据源：{citeSourceText(citeSource)}
        </div>
      )}
      {/*
        没问到 ≠ 没有引用：外部数据库限流/断网时沿用同一套诚实措辞
        （与上方"查到 0 条"的状态区分开，但都不说成"这一篇没引用"）。
      */}
      {citeSource?.error && (
        <div className="muted small">
          这次没问到数据源：{citeSource.error}（「取不到」不等于「没有引用」。）
        </div>
      )}
      {loading && <div className="muted small">正在取引用列表…</div>}
      {!loading && table === null && (
        <div className="muted small">
          本库尚未抓到「{rt?.zh ?? domain}」的引用数据（不是这一篇没有引用）。
          <br />
          补数据：<code>node pipeline/harvest-refs.mjs --domain {domain}</code>
          {" "}然后{" "}
          <code>node pipeline/build-citations.mjs --domain {domain}</code>
          {!allowLive && (
            <>
              <br />
              也可以打开「数据源」面板里的<b>实时引用</b>，用你自己的 key 从 Semantic Scholar /
              OpenAlex 实时取（首次取某学科要先建索引，约 10–30 秒）。
            </>
          )}
        </div>
      )}
      {!loading && table && refs && refs.length === 0 && (
        <div className="muted small">数据源里这一篇没有参考文献记录（不等于它没引用任何论文）。</div>
      )}
      {!loading && refs && refs.length > 0 && (
        <div className="pp-cites">
          {refs.slice(0, 40).map((id) => {
            const title = titles.get(id) ?? `docId ${id}`;
            /**
             * **库内**的被引论文：点标题 = 在应用里跳过去（选中它、镜头滑过去、展开它自己的信息）。
             *
             * 为什么不是外链：它就在我们库里，跳出去再让用户自己回来是最差的一种交互。
             * 而"跳转"的另一半（看它引用了谁）也只有在应用里才做得到 —— 引用表是按 docId 索引的。
             */
            return (
              <div key={id} className="pp-cite-row">
                <span className="pp-cite-title">
                  <button className="linklike" onClick={() => selectPaper(domain, id)} title="跳到这篇（并展开它引用了谁）">
                    {title}
                  </button>
                  {zh.get(id) && (
                    <span className="pp-zh" title="机器翻译（NLLB-200，离线生成）">
                      {zh.get(id)}
                    </span>
                  )}
                </span>
                <a className="muted small" href={scholarSearchUrl(title)} target="_blank" rel="noreferrer">
                  学术
                </a>
              </div>
            );
          })}
          {refs.length > 40 && <div className="muted small">…另有 {refs.length - 40} 篇</div>}
        </div>
      )}
      {!loading && ext && ext.length > 0 && (
        <div className="pp-ext">
          <div className="muted small">库外 {ext.length} 篇（本库没有全文，给检索入口）</div>
          {ext.slice(0, 20).map((e, i) => (
            <div key={i} className="pp-cite-row">
              <span className="nbr-title">
                {e.year > 0 ? `${e.year} · ` : ""}
                {e.title}
              </span>
              <span className="pp-links">
                {linksFor({ title: e.title, doi: e.doi }).map((l) => (
                  <a key={l.kind} href={l.url} target="_blank" rel="noreferrer" title={l.note}>
                    {l.label}
                  </a>
                ))}
              </span>
            </div>
          ))}
          {ext.length > 20 && <div className="muted small">…另有 {ext.length - 20} 篇</div>}
        </div>
      )}
    </div>
  );
}
function RelatedPapers({ domain, docId }: { domain: string; docId: number }) {
  const rt = useCloud((s) => s.runtime[domain]);
  const loadRelations = useCloud((s) => s.loadRelations);
  const selectPaper = useCloud((s) => s.selectPaper);
  const manifest = useCloud((s) => s.manifest);
  /** 邻居的标题/年份/去处（按邻居 docId 取，用 Range 只下几百字节） */
  const [info, setInfo] = useState<
    Map<number, { title: string; year: number; venue: string }>
  >(new Map());

  const entry = manifest?.domains.find((d) => d.id === domain);
  // 收窄成局部常量：TS 在 map 回调里不会保留 entry.relations 的非空收窄
  const rel = entry?.relations;
  // manifest 没登记关系数据 ⇒ 这个学科还没建，明确说明而不是让按钮点了没反应
  if (!rel) {
    return (
      <div className="muted small" style={{ marginTop: 10, borderTop: "1px solid rgba(255,210,122,0.12)", paddingTop: 10 }}>
        这个学科还没有构建关系数据（运行 <code>pipeline/build-relations.mjs</code>）。
      </div>
    );
  }

  const loading = rt?.relationsLoading;
  const table = rt?.neighbors;
  const nbrs = table ? table.neighborsOf(docId) : [];

  // 邻接表到位后取邻居的元数据（只在同团邻居上做，跨团的暂不取，避免无谓请求）
  useEffect(() => {
    if (!table || nbrs.length === 0) return;
    let alive = true;
    void (async () => {
      const store = metaStoreOf(domain);
      if (!store) return;
      const ids = nbrs.map((n) => n.docId);
      const titles = await store.titlesOf(ids);
      if (!alive) return;
      const m = new Map<number, { title: string; year: number; venue: string }>();
      const reader = await store.ensure().catch(() => null);
      for (const id of ids) {
        const h = reader?.head(id) ?? null;
        m.set(id, {
          title: titles.get(id) ?? "",
          year: h?.year ?? 0,
          venue: h?.venueHead || "",
        });
      }
      if (alive) setInfo(m);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, docId, domain]);

  return (
    <div className="related">
      <div className="pp-label" style={{ marginTop: 10 }}>
        相关论文{entry.relations.kinds.includes("sameField") && "（同领域）"}
      </div>

      {/* 局部图与文字列表并排：图形看结构，列表读内容 */}
      {table && nbrs.length > 0 && <LocalGraph domain={domain} nbrs={nbrs} />}

      {/*
        边过滤器（Obsidian 式浏览五项里的最后一项）。

        ⚠️ 只列**实际存在**的边类型，并说明没做的那两类**为什么没做**。
           规划里共三类边：
             · 同领域 —— ✅ 有（层号写进编号，顺带算出来，1220 万条）
             · 引用   —— ⏳ 抓取被 API 配额卡住（S2 /references 不能批量；
                        OpenAlex 需要先建 ID 映射表，要 30 天）
             · 同路线 —— ⏳ 需要语义层（聚类 → 路线），那是显卡的活
           列一个点不动的筛选项比不列更糟：用户会以为是功能坏了。
      */}
      {rel && (
        <div className="edge-filter">
          <div className="ef-head">边类型（只列实际存在的）</div>
          {rel.kinds.map((k) => (
            <label className="ef-row on" key={k}>
              <input type="checkbox" checked readOnly />
              <span className="ef-name">{EDGE_KIND_ZH[k] ?? k}</span>
              <span className="ef-count">{fmt(rel.count)} 组 · 每组 {rel.k} 条</span>
            </label>
          ))}
          <div className="ef-missing">
            未列出的边<b>不是遗漏，是数据还没到</b>：
            <br />
            · <b>引用</b>（应用 / 被应用）—— API 配额限制，一篇一次请求；
            <br />
            {entry.semantic?.routes ? (
              <>
                · <b>同路线</b>（同一研究路线）—— ✅ 数据已就位，
                <b>在下面的「语义层 → 同路线」里单列</b>。
                它住在 <code>semantic/&lt;学科&gt;.route.bin</code> 里，
                与这张同领域邻接表<b>不是同一个文件</b>，所以不混进上面的类型列表
                （混进来会变成一个"一条边都筛不出来"的筛选项）。
              </>
            ) : (
              <>· <b>同路线</b>（同一研究路线）—— 需要显卡跑语义聚类（见 pipeline_gpu/）。</>
            )}
          </div>
        </div>
      )}

      {!table && !loading && (
        <>
          <div className="muted small">
            同领域关系直接从本地层级算出（层号已写进编号），不需要联网。
            {entry.relations.count > 100000 && " 这个学科的关系表较大，首次加载需要一点时间。"}
          </div>
          <button className="btn tiny" onClick={() => void loadRelations(domain)}>
            加载相关论文
          </button>
        </>
      )}

      {loading && <div className="muted small">正在加载关系数据…</div>}

      {table && nbrs.length === 0 && (
        <div className="muted small">这一层只有它自己（论文数太少，没有可列的邻居）。</div>
      )}

      {table && nbrs.length > 0 && (
        <div className="nbr-list">
          {nbrs.map((n, i) => (
            <div className="nbr-row" key={`${n.domainIndex}:${n.docId}:${i}`}>
              <span className="nbr-kind">同领域</span>
              <span className="nbr-main">
                {/* 标题来自元数据（Range 取回，几百字节）。取不到就退回 docId ——
                    宁可显示编号，也不要因为一次请求失败就整块空白。 */}
                <span className="nbr-title">{info.get(n.docId)?.title || `docId ${n.docId}`}</span>
                <span className="nbr-meta">
                  docId {n.docId}
                  {info.get(n.docId)?.year ? ` · ${info.get(n.docId)!.year}` : ""}
                  {info.get(n.docId)?.venue ? ` · ${info.get(n.docId)!.venue}` : ""}
                </span>
              </span>
              {n.domainIndex === (manifest?.domains.findIndex((d) => d.id === domain) ?? -1) ? (
                <button className="btn tiny ghost" onClick={() => selectPaper(domain, n.docId)}>
                  查看
                </button>
              ) : (
                <span className="muted small">
                  {manifest?.domains[n.domainIndex]?.zh ?? n.domainIndex}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
