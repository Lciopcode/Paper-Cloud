/**
 * 论文云 · 选中星的爆发与标记
 * ============================================================================
 * 点一颗星之后，**画面里必须立刻有东西动起来** —— 否则"点了没反应"和"程序卡住了"
 * 在用户眼里是同一件事。参考实现（诗云）的做法量下来是一组"五连"，
 * 0.4 秒内全部发生；这里落地其中三件（另外两件是星点放大与镜头滑入，
 * 分别在 `shaders.ts` 的 `uSelOn` 与 `FlyCamera.tsx` 的锁定轨道里）：
 *
 *   ① **冲击波** —— 三圈错开的环从选中星向外扩，越扩越粗越淡；
 *   ② **核心闪光** —— 出生那一下最亮，0.55 秒收敛；
 *   ③ **常驻标记** —— 一个带呼吸的细环 + 一圈极淡光晕，**整个选中期间都在**。
 *      闪一下只说明"点到了"，常驻才说明"现在是它"。
 *
 * ## 为什么全部是"面向相机的方片"
 *
 * 环和光晕如果用真实几何（TorusGeometry / RingGeometry）做，一旦视角转到侧面就会变成
 * 一条线甚至消失。而它们的语义是**界面标记**，不是天体，本来就不该有"侧面"。
 * 所以用方片 + 每帧把朝向抄成相机的朝向（billboard），`shaders.ts` 的 PULSE_FRAG
 * 在方片内按到中心的距离画环和光晕。
 *
 * ## 为什么标记环用屏幕尺寸、冲击波用世界尺寸
 *
 *   · **标记环**是"指给你看这是哪颗"，必须**始终一样大**：相机拉远拉近它都不该变，
 *     否则拉近时它糊满半个屏幕、拉远时小得看不见。所以它的尺寸按
 *     `距离 × tan(fov/2)`（该距离上视口的高度）来定。
 *   · **冲击波**是"刚刚发生了一件事"，它是一次**空间**上的爆炸，按世界单位扩散才对。
 *     只给它一个下限，免得相机拉远之后爆炸小得看不见。
 *
 * ## 坐标从哪来
 *
 * 全部来自 `anchor.ts` 的解析器 —— 也就是 `StarLayer` 自己算出来的那份坐标。
 * 这里**不重算**位置（重算就是第二份公式，排列模式一改就会静静地挂错地方）。
 * 见 `anchor.ts` 顶部关于这件事的说明。
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { DOMAINS } from "../data/domains.ts";
import { useCloud } from "../state/cloud.ts";
import { PULSE_FRAG, PULSE_VERT } from "./shaders.ts";
import { emptyAnchorHit, resolveAnchor } from "./anchor.ts";

/** 冲击波圈数 */
const WAVES = 3;
/** 每圈的起始延迟（秒）与最大半径（世界单位）—— 错开才有"一波推一波"的感觉 */
const WAVE_DELAY = [0, 0.14, 0.28];
const WAVE_RADIUS = [2.0, 3.0, 4.0];
/** 单圈冲击波的生命期（秒）。参考实现的丝线生长是 1.2 秒，取同一个量级。 */
const WAVE_LIFE = 1.25;
/** 核心闪光的生命期（秒）—— 比冲击波短得多，它负责"炸"的那一下 */
const FLASH_LIFE = 0.55;
/** 标记环占视口高度的比例（0.13 ⇒ 环直径约屏幕高度的 10%） */
const MARKER_UNIT = 0.13;
/** 光晕方片占视口高度的比例 */
const HALO_UNIT = 0.62;

/** 材质下标：0..WAVES-1 = 冲击波，WAVES = 核心闪光，WAVES+1 = 标记环，WAVES+2 = 光晕。 */
const IDX_FLASH = WAVES;
const IDX_MARKER = WAVES + 1;
const IDX_HALO = WAVES + 2;

/** 复用的临时向量：每帧都要算一次距离，不能每帧 new 一个 Vector3。 */
const _v = new THREE.Vector3();

function makeMaterial(kind: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: PULSE_VERT,
    fragmentShader: PULSE_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uProgress: { value: 0 },
      uOpacity: { value: 0 },
      uTime: { value: 0 },
      uKind: { value: kind },
    },
    transparent: true,
    // 标记是"界面"，不该被星系里的点挡住 —— 挡住了就找不到自己选的是哪颗
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function SelectionPulse() {
  const selection = useCloud((s) => s.selection);
  const visible = useCloud((s) => s.visibleDomains);
  const { camera, size } = useThree();

  /**
   * 一个方片几何体给所有层共用。
   * 尺寸靠 `mesh.scale` 给，所以几何体只用单位平面 —— 6 个 mesh 共用 1 个几何体、1 次上传。
   */
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const materials = useMemo(
    () => Array.from({ length: WAVES + 3 }, (_, i) => makeMaterial(i < WAVES ? 0 : i === IDX_FLASH ? 1 : 2)),
    [],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      materials.forEach((m) => m.dispose());
    },
    [geometry, materials],
  );

  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  /** 复用的解析结果容器：每帧解析一次，不能每帧给 GC 交垃圾 */
  const hit = useRef(emptyAnchorHit());
  /** 当前爆发的身份与起始时刻（**身份变了才重新爆炸**，同一颗星不会因为重渲染又炸一次） */
  const burst = useRef({ key: "", t0: 0 });
  /** 领域色的提亮版（叠加混合下纯学科色太暗，提亮后才像"发光"） */
  const tint = useMemo(() => new THREE.Color(1, 1, 1), []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const ms = meshes.current;

    // ---- 先判断"现在该不该有标记"
    const domain = selection?.kind === "paper" ? selection.domain : null;
    const docId = selection?.kind === "paper" ? selection.docId : null;
    const key =
      domain !== null && docId !== null && visible.includes(domain) ? `${domain}:${docId}` : "";
    const found = key !== "" && resolveAnchor(domain as string, docId as number, hit.current);

    if (!found) {
      for (const m of ms) if (m) m.visible = false;
      burst.current.key = "";
      return;
    }

    const [wx, wy, wz] = hit.current.world;
    const dom = DOMAINS.find((d) => d.id === domain);
    // 提亮：叠加混合下学科色偏深，往白里推一点才读得出"在发光"（与 Bridges 同一个理由）。
    // 再乘 1.6 让它越过 bloom 的亮度阈值（0.55）—— 标记如果吃不到 bloom，就只是一张贴纸。
    tint.setStyle(dom?.color ?? "#ffffff").lerp(new THREE.Color(1, 1, 1), 0.45).multiplyScalar(1.6);

    // ---- 爆发计时：身份变了才重新开始
    if (burst.current.key !== key) {
      burst.current.key = key;
      burst.current.t0 = t;
    }
    const age = t - burst.current.t0;

    // ---- 尺寸基准：该距离上视口的高度。屏幕尺寸的层用它，世界尺寸的层不用。
    const dist = camera.position.distanceTo(_v.set(wx, wy, wz));
    const fov = "fov" in camera ? ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180 : 0.9;
    const viewH = 2 * Math.max(0.5, dist) * Math.tan(fov / 2);
    // 世界尺寸的层给一个"随距离放大"的下限，免得拉远之后爆炸小得看不见
    const worldK = Math.min(3, Math.max(0.5, dist / 32));

    // ---- 逐层更新
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m) continue;
      const mat = materials[i];
      m.visible = true;
      m.position.set(wx, wy, wz);
      // billboard：把方片的朝向抄成相机的朝向，于是它永远正对镜头
      m.quaternion.copy(camera.quaternion);
      mat.uniforms.uColor.value.copy(tint);
      mat.uniforms.uTime.value = t;

      if (i < WAVES) {
        const local = (age - WAVE_DELAY[i]) / WAVE_LIFE;
        if (local < 0 || local > 1) {
          m.visible = false;
          continue;
        }
        mat.uniforms.uProgress.value = local;
        mat.uniforms.uOpacity.value = 1;
        m.scale.setScalar(2 * WAVE_RADIUS[i] * worldK * (0.12 + 0.88 * local));
      } else if (i === IDX_FLASH) {
        const local = age / FLASH_LIFE;
        if (local > 1) {
          m.visible = false;
          continue;
        }
        // 出场即最大最亮，然后迅速收敛 —— 这才叫"闪"
        mat.uniforms.uProgress.value = Math.pow(1 - local, 2.2);
        mat.uniforms.uOpacity.value = 1 - local;
        m.scale.setScalar(viewH * 0.34 * (0.55 + 0.45 * local));
      } else if (i === IDX_MARKER) {
        mat.uniforms.uOpacity.value = 1;
        m.scale.setScalar(viewH * MARKER_UNIT);
      } else if (i === IDX_HALO) {
        mat.uniforms.uOpacity.value = 0.5;
        m.scale.setScalar(viewH * HALO_UNIT);
      } else {
        // 材质个数与上面三个分支对不上（新增层时忘了写分支）—— 藏起来而不是画错的环
        m.visible = false;
      }
    }
  });

  // 尺寸变化（窗口缩放）不影响任何 uniform —— 屏幕尺寸的层每帧都重算，所以这里不需要依赖它。
  // 留着 `size` 只是为了让 useFrame 的闭包在 resize 后拿到新的视口比例（未来若要用屏幕宽高比时不会踩坑）。
  void size;

  return (
    <group>
      {materials.map((m, i) => (
        <mesh
          key={i}
          ref={(el) => {
            meshes.current[i] = el;
          }}
          geometry={geometry}
          material={m}
          visible={false}
          frustumCulled={false}
          /**
           * 图层名：`__three.setLayer("pulse", false)` 能把它整层关掉。
           *
           * 为什么需要：它对**任何帧间比较**都是噪声源 —— 冲击波与呼吸环一直在动，
           * 于是"两帧差了多少像素"这个量被它主导（实测：减少动态效果下两帧仍差 11.6 万像素，
           * 而那本该是"画面静止"的状态）。要量丝线的沿线脉冲，必须先把它关掉。
           */
          userData={{ layer: "pulse" }}
          // renderOrder 是**逐对象**的，不随 group 继承 —— 写在 group 上不起作用。
          // 标记要压在所有星点之上（有 depthTest:false 还不够：不透明的绘制顺序仍会抢先）。
          renderOrder={999}
        />
      ))}
    </group>
  );
}
