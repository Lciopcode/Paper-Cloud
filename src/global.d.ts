/**
 * 全局类型补充：自检脚本要读的 window 桥。
 *
 * **刻意从 store 反推类型，而不是手写一份视图接口**：
 * 手写会导致"改了字段名但视图没改"，而自检脚本读不存在的字段时只会静默拿到 undefined，
 * 于是自检"通过"但实际没检查到东西 —— 那比没有自检更糟。
 * 让类型从唯一真相来源（store）反推，字段一改这里立刻报错。
 */
import type { useCloud } from "./state/cloud.ts";

type LunyunStore = typeof useCloud;

declare global {
  interface Window {
    /** zustand store（`src/main.tsx` 里挂上）。自检脚本用 `getState()` 读。 */
    __lunyun?: LunyunStore;
    /** 三维场景诊断桥（`src/three/Galaxy.tsx` 的 installDebugBridge 挂上） */
    __three?: {
      probeGL: () => {
        w: number;
        h: number;
        nonBgPct: number;
        blownPct: number;
        coloredPct: number;
        hueBins: number[];
      } | null;
      snapshot: (scale?: number) => string | null;
      cameraPos: () => number[] | null;
      /** 共享自转角（弧度）—— 自检用它断言"星系确实在转" */
      spinAngle: () => number;
      /**
       * 按图层名开关可见性（`stars` / `nebula` / `halo` / `dome`），返回改动的对象数。
       * 用于"某个效果看不见 / 太亮"的分层归因 —— 逐层关掉再量像素统计。
       */
      setLayer: (name: string, visible: boolean) => number;
      sceneInfo: () => { points: number; groups: number; lines: number; linesVisible: number; lineVerts: number } | null;
    };
  }
}

export {};
