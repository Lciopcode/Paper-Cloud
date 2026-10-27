/** 悬停浮现的论文名标签（画布外渲染，避免每帧同步 DOM 到 3D）。 */
import { useCloud } from "../state/cloud.ts";

export function HoverTip() {
  const hover = useCloud((s) => s.hover);
  const titleOf = useCloud((s) => s.titleOf);
  if (!hover) return null;
  const text = titleOf(hover.domain, hover.docId) || `#${hover.docId}`;
  return (
    <div
      className="hover-tip"
      style={{
        position: "fixed",
        left: hover.x + 16,
        top: hover.y + 14,
        pointerEvents: "none",
        zIndex: 30,
      }}
    >
      {text}
    </div>
  );
}
