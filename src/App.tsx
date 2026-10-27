/**
 * 论文云 · 应用外壳
 * ============================================================================
 * 只做三件事：启动加载、按状态显示"载入 / 错误 / 场景 + HUD"、以及**永久链接的同步**。
 * 渲染细节在 `src/three/`，业务状态在 `src/state/`，本文件不碰它们内部。
 */
import { useCallback, useEffect, useRef } from "react";
import { useCloud } from "./state/cloud.ts";
import { decodePermalink, encodePermalink } from "./state/permalink.ts";
import { Galaxy } from "./three/Galaxy.tsx";
import { Hud } from "./ui/Hud.tsx";
import "./styles.css";

export default function App() {
  const booted = useCloud((s) => s.booted);
  const bootError = useCloud((s) => s.bootError);
  const boot = useCloud((s) => s.boot);
  const selection = useCloud((s) => s.selection);
  const layoutMode = useCloud((s) => s.layoutMode);
  const searchQuery = useCloud((s) => s.searchQuery);
  const focusTarget = useCloud((s) => s.focusTarget);
  const selectPaper = useCloud((s) => s.selectPaper);
  const setLayoutMode = useCloud((s) => s.setLayoutMode);
  const search = useCloud((s) => s.search);

  /** 已经应用过初始 hash 了（首次加载只应用一次） */
  const restored = useRef(false);
  /**
   * 我们自己最后一次写进地址栏的 hash。
   *
   * 用来区分"是我们写的"和"是用户粘贴 / 前进后退来的" —— 否则我们每写一次 hash
   * 就会立刻触发一次 `hashchange`，把状态又还原一遍（白做一次工作，
   * 更糟的是可能和用户刚做的操作打架）。
   */
  const written = useRef("");

  useEffect(() => {
    void boot();
  }, [boot]);

  /**
   * 把链接里的状态应用到应用上。
   *
   * 抽成函数是因为它有**两个**触发点：首次加载，以及**地址栏 hash 变化**
   * （用户粘贴了一个分享链接，或在同一标签页里点了别人的链接）。
   *
   * ⚠️ 只监听首次加载是不够的 —— 实测踩过：在同一标签页里把 hash 换成另一个
   * `#v=<编号>`，页面**不会重新加载**，只发一个 `hashchange`，
   * 于是"粘贴分享链接什么都没发生"。而粘贴恰恰是分享链接最常见的用法之一。
   */
  const applyHash = useCallback(() => {
    const s = decodePermalink(window.location.hash);
    if (s.mode) void setLayoutMode(s.mode);
    if (s.query) void search(s.query);
    if (s.paper) selectPaper(s.paper.domain, s.paper.docId);
  }, [setLayoutMode, search, selectPaper]);

  // 首次加载完成后还原一次
  useEffect(() => {
    if (!booted || restored.current) return;
    restored.current = true;
    applyHash();
  }, [booted, applyHash]);

  // 地址栏 hash 变化（粘贴链接 / 前进后退）也还原；跳过我们自己写的那一次
  useEffect(() => {
    if (!booted) return;
    const onHash = () => {
      if (window.location.hash.replace(/^#/, "") === written.current) return;
      applyHash();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [booted, applyHash]);

  /**
   * 全局快捷键 `B`：显示/隐藏背景层。
   *
   * ## 为什么放在这里，而不是 `FlyCamera` 里
   *
   * `FlyCamera` 已经装了一个全局 keydown，把 `B` 塞过去最省事 —— 但那是**相机**的文件，
   * 让它去开关背景层，等于把"视图可见性"这件事撕成两处。
   * 这里的定位是"应用外壳"，全局快捷键本来就属于外壳。
   *
   * ## 为什么必须挡输入框
   *
   * 检索框里打一个 "b" 就会把背景关掉 —— 这类 bug 看起来像"打字打着打着画面闪了一下"，
   * 极难联想到快捷键。所以凡是落在可编辑元素上的按键一律不管。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyB" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      useCloud.getState().toggleBackground();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- 状态变化 → **写回** hash（可分享、可刷新）----
  useEffect(() => {
    if (!booted) return;
    const paper = selection?.kind === "paper" ? { domain: selection.domain, docId: selection.docId } : undefined;
    const hash = encodePermalink({
      paper,
      mode: layoutMode,
      query: searchQuery || undefined,
    });
    // 先记下"这是我们写的"，再写 —— 否则 hashchange 监听会把这次当外部变化
    written.current = hash;
    if (window.location.hash.replace(/^#/, "") === hash) return;
    // replaceState 而不是 pushState：点星很频繁，用 pushState 会让返回键退不出去
    window.history.replaceState(null, "", hash ? `#${hash}` : window.location.pathname);
  }, [booted, selection, layoutMode, searchQuery, focusTarget]);

  if (bootError) {
    return (
      <div className="app">
        <div className="boot error">
          <div>加载失败：{bootError}</div>
          <div className="small">
            静态资产由 `pipeline/` 生成到 `public/data/`。
            <br />
            若尚未生成，请先运行 <code>pnpm export:text</code> 与 <code>pnpm build:spine</code>，
            再用 <code>pnpm serve</code> 启动（不要用 vite dev 直接读，资产要带 brotli 头）。
          </div>
        </div>
      </div>
    );
  }

  if (!booted) {
    return (
      <div className="app">
        <div className="boot">正在展开宇宙…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <Galaxy />
      <Hud />
    </div>
  );
}

