import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { useCloud } from "./state/cloud.ts";

/**
 * 把 store 挂到 window 供自检脚本使用（`deploy/verify.mjs`）。
 *
 * 为什么不"仅开发模式暴露"：出题与答辩演示时也需要能在控制台里直接验证，
 * 而且它**只读**（除了几个显式动作），不构成安全面 —— 这是一份纯静态作品，没有后端。
 */
window.__lunyun = useCloud;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
