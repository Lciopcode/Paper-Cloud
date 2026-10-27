/**
 * 论文云 · **点星拾取**（GPU 颜色 ID）
 * ============================================================================
 * ## 历史（为什么改过三次）
 *
 *  1. **raycast**：给星点对象挂 `onPointerDown`，让 three 的 `Raycaster` 算交点。
 *     `Points.raycast` 对**每个顶点**算一次"点到射线的距离"，而且 R3F 在
 *     **每次 pointermove** 都会做一次 enter/leave 检测 —— 305 万点时界面直接卡死
 *     （作者原话：「连星星都点不了」）。
 *
 *  2. **CPU 屏幕投影**（上一版）：只在点击/悬停时把所有 `position` 乘世界矩阵、
 *     再 `Vector3.project(camera)` 一遍，取光标半径内最近的一颗。
 *     305 万点下一次要几十~几百毫秒，悬停被迫压到 250ms 一次，**还是卡**；
 *     而且它只认"投影中心"，看不见的星（`aTier=0` 被 LOD 藏起来的）也能被点到。
 *
 *  3. **GPU 拾取（现在）**：照参考实现 `v2/shiyun` 的做法 —— 用只输出颜色 id 的
 *     `PickMaterial` 把**光标附近 n×n 像素窗口**渲染到小 RenderTarget，读回 n² 个像素，
 *     取离光标最近的非 0 像素解码 `(domain, docId)`。CPU 只扫 ~841 个像素，
 *     **与点数无关**；门控与点尺寸公式与 `STAR_VERT` 一致，所以"看得见的才点得到"。
 *     实现与原理见 `gpuPick.ts` 文件头。
 *
 * ## 交互语义（保持不变，是作者明确要求的）
 *
 *   · 拖拽转头不算点击（位移 > `DRAG_SLOP`）；
 *   · 慢速长按（> 900ms）不算点击；
 *   · **点虚空不做事** —— 只有点到星才改选中；取消选中走 Esc / 面板按钮；
 *   · 悬停浮现论文名（60ms 节流；GPU 拾取后不必再压到 250ms）。
 */
import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { useCloud } from "../state/cloud.ts";
import { createGpuPicker } from "./gpuPick.ts";

/** 位移超过这么多像素就算"拖拽转头"，不算点击（与 Galaxy 里的 DRAG_SLOP 同义） */
const DRAG_SLOP = 5;
/**
 * 悬停拾取的节流间隔（ms）。
 *
 * 上一版是 250ms —— 那不是"体验选择"，是 CPU 投影太慢的妥协。
 * GPU 拾取之后一次典型耗时在**亚毫秒~2ms**（见 `docs/` 与 `deploy/probe-pick.mjs` 的实测），
 * 所以回到 60ms：鼠标划过星海时标签跟得上手，又不会每帧都做一次离屏渲染。
 */
const HOVER_INTERVAL_MS = 60;

export function StarPicker() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const selectPaper = useCloud((s) => s.selectPaper);
  const setHover = useCloud((s) => s.setHover);

  const picker = useMemo(() => createGpuPicker(gl, camera, scene), [gl, camera, scene]);
  useEffect(() => () => picker.dispose(), [picker]);

  useEffect(() => {
    const el = gl.domElement;
    let downX = 0;
    let downY = 0;
    let downAt = 0;

    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      downAt = performance.now();
    };

    const onUp = (e: PointerEvent) => {
      // 拖拽转头不算点击；慢速长按也不算（避免和"按住拖动"混淆）
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP) return;
      if (performance.now() - downAt > 900) return;
      const picked = picker.pickClient(e.clientX, e.clientY);
      /**
       * **点空不做事**（作者："点击虚空不能有反应，只有点击到星辰才行"）。
       * 原来点空会 clearSelection()，于是偏移一点的点击会把刚选中的星清掉。
       */
      if (picked) selectPaper(picked.domain, picked.docId);
    };

    /**
     * 悬停（功能③）：**不点击**也要浮出论文名。
     *
     * GPU 拾取后这里不再有"要不要牺牲帧率"的取舍 —— 60ms 一次离屏 29×29 渲染，
     * 顶点着色器跑一遍全部顶点（GPU 上 300 万点 < 2ms）。
     */
    let last = 0;
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - last < HOVER_INTERVAL_MS) return;
      last = now;
      const hit = picker.pickClient(e.clientX, e.clientY);
      if (hit) setHover({ domain: hit.domain, docId: hit.docId, x: e.clientX, y: e.clientY });
      else setHover(null);
    };
    const onLeave = () => setHover(null);

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [gl, picker, selectPaper, setHover]);

  return null;
}
