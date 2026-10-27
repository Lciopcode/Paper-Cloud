/**
 * 选中一颗星 → 让 **FlyCamera 自己飞过去**（复用它的 `focusTarget` 通道）。
 *
 * 为什么不再像上一版那样自己改相机：那会和 FlyCamera 每帧的 lookAt/位置插值抢控制权，
 * 表现是"镜头没飞"甚至抖动。`focusTarget` 是它本来就支持的入口（图例双击就走这条），
 * 由它负责"飞到哪、看着哪"。
 */
import { useEffect } from "react";

import { resolveAnchor, emptyAnchorHit } from "./anchor.ts";
import { useCloud } from "../state/cloud.ts";

export function FocusOnSelect() {
  const selection = useCloud((s) => s.selection);
  const visible = useCloud((s) => s.visibleDomains);

  useEffect(() => {
    if (!selection || selection.kind !== "paper") return;
    if (!visible.includes(selection.domain)) return;

    const { domain, docId } = selection;
    const hit = emptyAnchorHit();
    let tries = 0;
    let raf = 0;

    /**
     * 锚点解析器由 `StarLayer` 注册，点星的那一刻可能还没就绪（首屏加载 / 点太快）。
     * 这里最多重试 40 帧（约 0.7 秒），拿到世界坐标就交给 FlyCamera。
     */
    const tick = () => {
      tries++;
      if (resolveAnchor(domain, docId, hit)) {
        useCloud.setState({ focusTarget: { pos: [hit.world[0], hit.world[1], hit.world[2]], at: Date.now() } });
        return;
      }
      if (tries < 40) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selection, visible]);

  return null;
}
