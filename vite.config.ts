import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 论文云 —— 纯静态 SPA：全部索引运算与渲染都在浏览器里完成，不依赖任何后端。
export default defineConfig({
  plugins: [react()],
  base: "./",
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist", "**/.claude/**"],
    environment: "node",
  },
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    /**
     * ⚠️ **不要**把 `public/` 复制进 `dist/`。
     *
     * Vite 默认会复制（`copyPublicDir: true`），于是每次构建都产生一份
     * **4.3 GB 的 `dist/data` 副本** —— 而 `deploy/serve.mjs` **根本不从那里取数据**：
     * 它把 `/data/...` 直接映射到 `public/data/`（见 serve.mjs 的 `DATA` 常量）。
     *
     * 也就是说那 4.3 GB 是**纯浪费**：磁盘占用翻倍，构建时间也多花在复制上。
     * 实测 `dist/data` = 4,369 MB，而 `dist/assets` 只有 1 MB。
     *
     * 关掉之后 `dist/` 只装真正的构建产物，数据仍然由 `public/data` 提供。
     */
    copyPublicDir: false,
  },
});
