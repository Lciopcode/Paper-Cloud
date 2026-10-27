/**
 * 论文云 · **选中星的浮动标签**（照诗云的做法）
 * ============================================================================
 * 诗云选中一个诗人时，开发者工具里是这样的：
 *
 *     <div style="position:absolute; top:0; left:0; transform: translate3d(485px,434px,0)">
 *       <div style="position:absolute; transform:translate(-50%,-50%); pointer-events:none">
 *         <div class="poet-label focus" style="color: rgb(110,231,168)">苏轼</div>
 *
 * 也就是：**名字不是三维物体，而是一个 HTML 层**，每帧用投影出来的屏幕坐标定位。
 * 文字永远正对相机、不受透视缩放影响，也不占 GPU 排版开销
 * （在 305 万点的场景里，任何三维文字都是奢侈）。
 *
 * ## 为什么拆成两半（重要）
 *
 * R3F 的 `<Canvas>` 里面**只能放 three 的对象**。第一版我直接在 Canvas 里
 * `return <div>`，页面立刻抛 `Uncaught`（`div is not part of the THREE namespace`）。
 * 所以拆成：
 *
 *   · `<LabelTracker />`  —— 在 Canvas 里，每帧把选中星投影成屏幕坐标写进 `labelPos`；
 *   · `<StarLabel />`     —— 在 Canvas **外面**（Hud 里），用 rAF 读 `labelPos` 改样式。
 *
 * 这与 `selectionEnv.ts` 是同一个套路：跨渲染树的每帧数据走一个模块级的小对象，
 * 不引入新的状态管理。
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useCloud } from "../state/cloud.ts";
import { resolveAnchor, type AnchorHit } from "./anchor.ts";

/** 每帧由 `<LabelTracker>` 写入、由 `<StarLabel>` 读取 */
export const labelPos = { x: 0, y: 0, visible: false };

/** 标题太长会把标签拉成一整行，截断到这么多字（与面板的小字提示一致） */
const MAX_CHARS = 30;

/** Canvas 内部：只算坐标，不产出任何 three 对象 */
export function LabelTracker() {
  const selection = useCloud((s) => s.selection);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const v = useMemo(() => new THREE.Vector3(), []);
  const hit = useRef<AnchorHit>({ local: [0, 0, 0], world: [0, 0, 0] });

  useFrame(() => {
    if (selection?.kind !== "paper") {
      labelPos.visible = false;
      return;
    }
    // `resolveAnchor` 是"填 out"式的（每帧调用，返回新对象等于每帧给 GC 交垃圾），
    // 且它已经把团的位移/倾角与自转角都算进去了
    if (!resolveAnchor(selection.domain, selection.docId, hit.current)) {
      labelPos.visible = false;
      return;
    }
    v.set(hit.current.world[0], hit.current.world[1], hit.current.world[2]).project(camera);
    // 投影到相机后面就藏起来，否则"背后的星的名字"会飘在屏幕上
    if (v.z > 1) {
      labelPos.visible = false;
      return;
    }
    labelPos.x = (v.x * 0.5 + 0.5) * size.width;
    labelPos.y = (-v.y * 0.5 + 0.5) * size.height;
    labelPos.visible = true;
  });

  return null;
}

/** Canvas 外部：DOM 标签，用 rAF 跟着 `labelPos` 走 */
export function StarLabel() {
  const selection = useCloud((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);

  const text = useMemo(() => {
    if (selection?.kind !== "paper") return "";
    const t = (selection.meta?.title || selection.title || "").trim();
    if (!t) return `docId ${selection.docId}`;
    return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + "…" : t;
  }, [selection]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        if (labelPos.visible) {
          el.style.transform = `translate3d(${labelPos.x.toFixed(1)}px, ${labelPos.y.toFixed(1)}px, 0)`;
          el.style.opacity = "1";
        } else {
          el.style.opacity = "0";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!text) return null;
  return (
    <div
      ref={ref}
      className="star-label"
      style={{ position: "fixed", top: 0, left: 0, opacity: 0, pointerEvents: "none" }}
    >
      <span className="star-label-inner">{text}</span>
    </div>
  );
}
