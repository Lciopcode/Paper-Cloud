/**
 * 论文云 · **GPU 颜色 ID 拾取**
 * ============================================================================
 * ## 这一版解决什么
 *
 * 上一版 `StarPicker` 在每次点击/悬停时，把所有星点的 `position` 乘世界矩阵、
 * 再 `Vector3.project(camera)` 投影一遍 —— **CPU 上 O(点数)**。
 * 默认视图 30.5 万点（"载入全部"是 305 万）时，一次拾取要几十到几百毫秒，
 * 所以悬停节流被迫压到 250ms（还是卡）。作者的原话是「连星星都点不了」。
 *
 * ## 现在怎么做（与参考实现 `v2/shiyun/src/three/gpuPick.ts` 同一思路）
 *
 *   ① 每个星点顶点带一个 `aId`（`index + 1`，0 留给黑色背景 = 没点到）；
 *   ② 一个只输出颜色 id 的 `PickMaterial`：**可见性门控和 STAR_VERT 一致**
 *      （`uTopOnly` + `aTier` + `aSize`），于是"看得见的星才点得到"；
 *      点尺寸固定 1 像素 = "只画星点中心"，读回像素即"投影中心"
 *      （为什么不画成和星一样大的盘，见 PICK_VERT 注释里的实测）；
 *   ③ 拾取时只把**光标附近 n×n 像素窗口**渲染到一张小 RenderTarget
 *      （`camera.setViewOffset` 把该窗口铺满 RT），`readRenderTargetPixels` 读回
 *      这 n² 个像素，取**离光标最近的非 0 像素**解码出 `(domain, docId)`。
 *
 * 代价 = 顶点着色器仍然跑一遍全部顶点（GPU 上 300 万点 < 2ms），
 * 片元只处理 n² 个像素（29×29 时 841 个）—— **与点数近乎无关**。
 * CPU 侧只剩一次 n² 循环（典型 841 次），比原来的 305 万次投影少四个数量级。
 *
 * ## 为什么共享可见几何体、而不是新建一套
 *
 * 拾取用的 `THREE.Points` **直接用 `StarLayer` 的 geometry**（同一个对象）：
 *   · 位置/`aTier`/`aCites` 都是就地改写数组（时间模式、LOD、引用点亮），共享即自动同步；
 *   · 不复制 305 万点的 position（省 36MB 起）。
 * 唯一新增的是 `aId`（4 字节/点，305 万点 = 12MB）—— 没有它就无法从像素反查顶点下标。
 *
 * ## 世界矩阵为什么必须逐次同步
 *
 * 星点挂在「团位移/倾角」的 `<group>` 里，再挂在**自转**的 `SpinGroup` 里。
 * 拾取场景是另一棵树，所以每次拾取把 `layer.matrixWorld` 原样抄给拾取对象
 * （`matrixAutoUpdate = false`）。抄错一帧的表现是"点到的星是旁边那颗"。
 */

import * as THREE from "three";

/** 光标到这个像素半径内就算命中（与旧 CPU 版一致的容差） */
const PICK_RADIUS_PX = 14;
/** 拾取窗口边长上限（防止外部传一个巨大的半径把读回撑爆） */
const MAX_RADIUS_PX = 48;

export interface PickHit {
  domain: string;
  docId: number;
}

export interface PickStats {
  /** 最近一次 pick 的耗时（ms，含读回） */
  lastMs: number;
  /** 最近一次 pick 命中的 (domain, docId)；null = 点空 */
  lastHit: PickHit | null;
  /** 累计拾取次数 / 命中次数（诊断用） */
  picks: number;
  hits: number;
}

export interface GpuPicker {
  /** `clientX/clientY` 是浏览器视口坐标（和 PointerEvent 一致，内部减 canvas 的 rect） */
  pickClient(clientX: number, clientY: number, radiusCss?: number): PickHit | null;
  /** 诊断：读最近一次拾取窗口里的原始 id 网格（0 = 黑） */
  debugWindow(
    clientX: number,
    clientY: number,
    radiusCss?: number,
  ): {
    n: number;
    px: number;
    py: number;
    radius: number;
    scale: number;
    ids: number[];
    layers: { domain: string; base: number; count: number }[];
    marks: { domain: string; docId: number; dx: number; dy: number }[];
  } | null;
  /** 诊断：读最近一次拾取窗口里的原始 id 与像素（不改变任何状态） */
  stats(): PickStats;
  dispose(): void;
}

/* ------------------------------------------------------------------ 着色器 */

/**
 * 拾取顶点着色器。
 *
 * ## 门控必须与 `STAR_VERT` 一致
 *
 * 否则会出现"看得见却点不到 / 看不见却点到了"（旧 CPU 版就点得到被 LOD 藏起来的星）。
 * 这里只保留**可见性门控**（`uTopOnly` + `aTier` + `aSize`）——
 *
 * ## 为什么点尺寸固定 1 像素、而不是照抄画出来的星盘大小
 *
 * 一开始照参考实现把拾取盘做成"和画出来的星一样大"（`aSize * aCites * …`）。
 * 实测（`deploy/probe-pick.mjs`）暴露了问题：**本片星海比参考实现密得多**
 * （30.5 万点铺在 157 万像素上，"载入全部"时 305 万），一颗星的盘里常常叠着
 * 好几颗邻星的盘；深度测试只保留**每像素最近的那颗**，于是"点 A 的中心
 * 却选中了恰好压在它上面的 B"——同一个像素连点两次都可能给出不同 docId。
 *
 * 改成"每颗星只画中心 1 个像素"后，读回的每个像素就代表**一个星点的投影中心**，
 * 窗口扫描取"离光标最近的中心"—— 与旧 CPU 版（最近投影中心 + 深度兜底）
 * **语义完全一致**，而且是确定性的：实测 71/71 一致、固定点 100% 稳定。
 * 14px 的容差仍由窗口半径提供（点偏一点也能选中最近的星），手感与旧版相同。
 *
 * 输出：`vPick = encode(uIdBase + aId)`，分三个字节。
 */
const PICK_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aTier;
  attribute float aId;
  uniform float uTopOnly;
  uniform float uIdBase;
  varying vec3 vPick;

  void main() {
    // LOD 门控（与 STAR_VERT 完全相同）：默认模式只画 aTier >= 0.5 的星
    if (uTopOnly > 0.5 && aTier < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    // aSize = 0 = 被硬筛掉（见 STAR_VERT）→ 不可见也不可拾取
    if (aSize < 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = 1.0;

    float id = uIdBase + aId;
    vPick = vec3(
      mod(id, 256.0),
      mod(floor(id / 256.0), 256.0),
      mod(floor(id / 65536.0), 256.0)
    ) / 255.0;
  }
`;

/**
 * 片元着色器：写 id 颜色。**不做任何混色/色调映射**（`NoBlending` + 8 位 RT，
 * 颜色值就是 id 的三个字节；three 不会给自定义 ShaderMaterial 注入 sRGB 转换）。
 *
 * 圆盘裁剪：与画出来的星点形状一致，方片四角不算命中。
 */
const PICK_FRAG = /* glsl */ `
  varying vec3 vPick;
  void main() {
    if (length(gl_PointCoord - 0.5) > 0.5) discard;
    gl_FragColor = vec4(vPick, 1.0);
  }
`;

/* ---------------------------------------------------------------- 实现 */

/** 当前页面上活跃的拾取器（给调试桥 `__three.pickAt` 用；同一时刻只有一个场景） */
let activePicker: GpuPicker | null = null;

/** 调试桥：按浏览器视口坐标拾取（`window.__three.pickAt` 走这里） */
export function pickAtScreen(
  clientX: number,
  clientY: number,
  radiusCss?: number,
): PickHit | null {
  return activePicker?.pickClient(clientX, clientY, radiusCss) ?? null;
}

/** 调试桥：最近一次拾取耗时与结果 */
export function pickAtScreenStats(): PickStats | null {
  return activePicker?.stats() ?? null;
}

/** 调试桥：拾取窗口的原始 id 网格（排查"这个像素为什么不是那颗星"） */
export function pickWindowAtScreen(clientX: number, clientY: number, radiusCss?: number) {
  return activePicker?.debugWindow(clientX, clientY, radiusCss) ?? null;
}

interface LayerEntry {
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  points: THREE.Points;
}

/** 一次拾取里发现的星点层（按 `scene.traverse` 顺序，base 逐层累加） */
interface FoundLayer {
  obj: THREE.Points;
  domain: string;
  docIds: Uint32Array;
  count: number;
  source: THREE.ShaderMaterial;
  base: number;
}

/** 祖先链上任何一层 `visible === false` 都算不可见（three 的渲染规则） */
function visibleInScene(o: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

export function createGpuPicker(
  gl: THREE.WebGLRenderer,
  camera: THREE.Camera,
  scene: THREE.Scene,
): GpuPicker {
  const pickScene = new THREE.Scene();
  /** 几何体 → 拾取材质/对象（几何体一换就重建；见 `pruneCache`） */
  const cache = new Map<THREE.BufferGeometry, LayerEntry>();

  /** 拾取窗口（n×n，Nearest 采样；深度缓冲用于"前面的星优先"） */
  const rt = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  let buf = new Uint8Array(4);

  const dbSize = new THREE.Vector2();
  const clearColor = new THREE.Color();
  const stats: PickStats = { lastMs: 0, lastHit: null, picks: 0, hits: 0 };

  /** 遍历场景收集星点层，并按顺序分配全局 id 的起始偏移 */
  function collectLayers(): FoundLayer[] {
    const found: FoundLayer[] = [];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (o.userData?.layer !== "stars") return;
      const obj = o as THREE.Points;
      if (!(obj as THREE.Points).isPoints) return;
      if (!visibleInScene(obj)) return;
      const docIds = o.userData.docIds as Uint32Array | undefined;
      const domain = o.userData.domain as string | undefined;
      const geo = obj.geometry;
      const pos = geo?.getAttribute("position");
      const idAttr = geo?.getAttribute("aId");
      const src = (Array.isArray(obj.material) ? obj.material[0] : obj.material) as
        | THREE.ShaderMaterial
        | undefined;
      if (!docIds || !domain || !pos || !idAttr || !src?.uniforms?.uSize) return;
      found.push({
        obj,
        domain,
        docIds,
        count: Math.min(pos.count, docIds.length),
        source: src,
        base: 0,
      });
    });
    let base = 0;
    for (const f of found) {
      f.base = base;
      base += f.count;
    }
    return found;
  }

  /** 丢掉已经不在场景里的几何体缓存（"载入全部/切回精选"会换几何体，不清理会攒 12MB×N） */
  function pruneCache(layers: FoundLayer[]) {
    const alive = new Set(layers.map((l) => l.obj.geometry));
    for (const [geo, entry] of cache) {
      if (alive.has(geo)) continue;
      pickScene.remove(entry.points);
      entry.material.dispose();
      cache.delete(geo);
    }
  }

  function materialFor(layer: FoundLayer): LayerEntry {
    const geo = layer.obj.geometry;
    const hit = cache.get(geo);
    if (hit) return hit;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTopOnly: { value: layer.source.uniforms.uTopOnly?.value ?? 0 },
        uIdBase: { value: 0 },
      },
      vertexShader: PICK_VERT,
      fragmentShader: PICK_FRAG,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      blending: THREE.NoBlending,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    /** 世界矩阵由 `layer.obj.matrixWorld` 逐次抄过来（见文件头） */
    points.matrixAutoUpdate = false;
    points.userData.layer = "pick";
    pickScene.add(points);
    const entry = { geometry: geo, material, points };
    cache.set(geo, entry);
    return entry;
  }

  /** 渲染光标附近的拾取窗口并读回像素（`pickClient` 与调试口共用） */
  function capture(clientX: number, clientY: number, radiusCss: number) {
    const el = gl.domElement;
    const rect = el.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    if (cssX < 0 || cssY < 0 || cssX > rect.width || cssY > rect.height) return null;

    const t0 = performance.now();
    pickScene.updateMatrixWorld(true);
    const layers = collectLayers();
    pruneCache(layers);
    if (!layers.length) {
      stats.lastMs = performance.now() - t0;
      stats.lastHit = null;
      return null;
    }

    gl.getDrawingBufferSize(dbSize);
    if (dbSize.x < 1 || dbSize.y < 1) return null;
    /** 视口 CSS 像素 → 绘制缓冲像素（devicePixelRatio / 浏览器缩放都吃在这里） */
    const scale = dbSize.x / Math.max(1, rect.width);
    const px = Math.floor(cssX * scale);
    const py = Math.floor(cssY * scale);
    const radius = Math.max(2, Math.min(MAX_RADIUS_PX, Math.round(radiusCss * scale)));
    const n = radius * 2 + 1;
    if (rt.width !== n || rt.height !== n) {
      rt.setSize(n, n);
      buf = new Uint8Array(n * n * 4);
    }

    /** 把 n×n 窗口映射到整张 RT：相机偏移 → 只渲染这一小块（与参考实现同法） */
    const cam = camera as THREE.Camera & {
      setViewOffset?: (fw: number, fh: number, x: number, y: number, w: number, h: number) => void;
      clearViewOffset?: () => void;
    };
    if (!cam.setViewOffset || !cam.clearViewOffset) return null;
    cam.setViewOffset(dbSize.x, dbSize.y, px - radius, py - radius, n, n);

    /** 同步每一层的世界矩阵与门控开关 */
    for (const layer of layers) {
      const entry = materialFor(layer);
      entry.points.matrix.copy(layer.obj.matrixWorld);
      entry.material.uniforms.uTopOnly.value = layer.source.uniforms.uTopOnly?.value ?? 0;
      entry.material.uniforms.uIdBase.value = layer.base;
      entry.points.visible = true;
    }
    // 场景树里只有本次收集到的层；其余（上次有、这次没有的）已在 pruneCache 里移除
    pickScene.updateMatrixWorld(true);

    const prevRT = gl.getRenderTarget();
    const prevAutoClear = gl.autoClear;
    const prevAlpha = gl.getClearAlpha();
    gl.getClearColor(clearColor);
    gl.setRenderTarget(rt);
    // 黑色 = id 0 = 没点到。autoClear 关掉，因为下面只清一次、各层共用深度缓冲。
    gl.setClearColor(0x000000, 0);
    gl.autoClear = false;
    gl.clear(true, true, true);
    try {
      gl.render(pickScene, camera);
    } finally {
      /** ⚠️ 一定要还原：渲染器/camera 被留在拾取状态会毁掉下一帧主画面 */
      gl.autoClear = prevAutoClear;
      gl.setRenderTarget(prevRT);
      gl.setClearColor(clearColor, prevAlpha);
      cam.clearViewOffset();
    }

    gl.readRenderTargetPixels(rt, 0, 0, n, n, buf);
    return { layers, n, px, py, radius, scale, t0, buf };
  }

  /** 解码窗口里离中心最近的非 0 像素 → (domain, docId) */
  function decode(
    layers: FoundLayer[],
    n: number,
    bufNow: Uint8Array,
  ): PickHit | null {
    const cx = n >> 1;
    const cy = n >> 1;
    let bestId = 0;
    let bestD = Infinity;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const o = (y * n + x) * 4;
        const id = bufNow[o] | (bufNow[o + 1] << 8) | (bufNow[o + 2] << 16);
        if (id === 0) continue;
        const dx = x - cx;
        const dy = y - cy;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          bestId = id;
        }
      }
    }
    if (bestId <= 0) return null;
    for (const layer of layers) {
      if (bestId <= layer.base || bestId > layer.base + layer.count) continue;
      const local = bestId - layer.base - 1;
      if (local >= 0 && local < layer.count) return { domain: layer.domain, docId: layer.docIds[local] };
      break;
    }
    return null;
  }

  function pickClient(clientX: number, clientY: number, radiusCss = PICK_RADIUS_PX): PickHit | null {
    const cap = capture(clientX, clientY, radiusCss);
    if (!cap) return null;
    // 注意：buf 是复用的；decode 里用的就是本次读回的内容
    const hit = decode(cap.layers, cap.n, buf);
    stats.lastMs = +(performance.now() - cap.t0).toFixed(2);
    stats.lastHit = hit;
    stats.picks++;
    if (hit) stats.hits++;
    return hit;
  }

  /**
   * 诊断口：返回窗口里的原始 **id 网格**（每像素一个全局 id，0 = 黑）。
   * 只在排查"为什么这个像素不是那颗星"时用 —— 正常路径不调用。
   */
  function debugWindow(clientX: number, clientY: number, radiusCss = PICK_RADIUS_PX) {
    const cap = capture(clientX, clientY, radiusCss);
    if (!cap) return null;
    const { layers, n, px, py, radius, scale } = cap;
    const ids: number[] = [];
    /** 每个不同 id 的代表像素（相对窗口中心） + 解码结果 —— 排查"候选星在不在窗口里" */
    const seen = new Map<number, { dx: number; dy: number }>();
    const cx = n >> 1;
    const cy = n >> 1;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const o = (y * n + x) * 4;
        const id = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        if (id === 0) continue;
        if (!seen.has(id)) seen.set(id, { dx: x - cx, dy: cy - y });
      }
    }
    for (let i = 0; i < n * n; i++) {
      const o = i * 4;
      ids.push(buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16));
    }
    const marks: { domain: string; docId: number; dx: number; dy: number }[] = [];
    for (const [id, pos] of seen) {
      for (const layer of layers) {
        if (id <= layer.base || id > layer.base + layer.count) continue;
        const local = id - layer.base - 1;
        if (local >= 0 && local < layer.count) {
          marks.push({ domain: layer.domain, docId: layer.docIds[local], dx: pos.dx, dy: pos.dy });
        }
        break;
      }
    }
    return {
      n,
      px,
      py,
      radius,
      scale,
      ids,
      layers: layers.map((l) => ({ domain: l.domain, base: l.base, count: l.count })),
      marks,
    };
  }

  const picker: GpuPicker = {
    pickClient,
    debugWindow,
    stats: () => ({ ...stats }),
    dispose() {
      for (const [, entry] of cache) {
        pickScene.remove(entry.points);
        entry.material.dispose();
      }
      cache.clear();
      rt.dispose();
      if (activePicker === picker) activePicker = null;
    },
  };
  activePicker = picker;
  return picker;
}
