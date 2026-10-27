/**
 * 让**选中的星恒定在屏幕中央**。
 *
 * 做法：每帧把相机朝向对准那颗星（只改旋转，不改位置——位置由 FlyCamera 负责"飞近"）。
 * 用 `useFrame(..., 1)` 的更高优先级，保证在 FlyCamera 的 lookAt 之后执行，否则会被它覆盖。
 */
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

import { resolveAnchor, emptyAnchorHit } from "./anchor.ts";
import { useCloud } from "../state/cloud.ts";

const FOCUS_DIST = 26;

export function FocusCenter() {
  const hit = useRef(emptyAnchorHit());
  const up = useRef(new THREE.Vector3(0, 1, 0));

  const target = useRef(new THREE.Vector3());
  const dir = useRef(new THREE.Vector3());

  useFrame(({ camera }) => {
    const st = useCloud.getState();
    const sel = st.selection;
    if (!sel || sel.kind !== "paper") return;
    if (!st.visibleDomains.includes(sel.domain)) return;
    if (!resolveAnchor(sel.domain, sel.docId, hit.current)) return;
    const [x, y, z] = hit.current.world;
    target.current.set(x, y, z);
    /**
     * **两步都要做**（作者："没有把画面移动使得点到画面中心"）：
     *   ① 把相机推到距星 FOCUS_DIST 处（飞近）；
     *   ② 再 lookAt 那颗星 ⇒ 它必然落在屏幕正中。
     * 只做 ② 时，星虽然在视线方向上，但相机可能离得太远、或者被团的朝向挡住，
     * 看起来"没居中"——所以位置与朝向一起管。
     */
    dir.current.copy(camera.position).sub(target.current);
    if (dir.current.lengthSq() < 1e-6) dir.current.set(0, 0.35, 1);
    dir.current.normalize();
    const want = target.current.clone().addScaledVector(dir.current, FOCUS_DIST);
    camera.position.lerp(want, 0.12);
    up.current.set(0, 1, 0);
    camera.lookAt(target.current);
    camera.updateMatrixWorld();
  }, 1);

  return null;
}
