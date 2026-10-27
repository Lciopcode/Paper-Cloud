/**
 * 论文云 · 关系丝线（**只在选中之后出现**）
 * ============================================================================
 * 作者的两条要求决定了这一版的样子：
 *
 *   ① 「把各论文之间的线取消了，点击某个论文再显示出纤细清晰的关系线（参考诗云）」
 *      —— 所以**默认一根线都没有**。原来那张铺满星系的网被去掉了：
 *         它看起来"像蜘蛛网"，而且 11 万条线互相叠加会把颜色洗掉。
 *   ② 「纤细清晰」—— 只有几十条线，于是单条可以画得**明确**。
 *
 * ## 生命周期：照搬诗云的三段（生长 → 保持 → 淡出）
 *
 * 诗云 `PoemGuides.tsx`：`GROW = 1.2s`（线从中心向外生长）→ 保持 → `FADE = 1.2s`（淡出）。
 * 我们原来只有生长，取消选中时线**瞬间消失** —— 那读起来像"程序出错了"，
 * 而不是"这个关系被收起来了"。
 *
 * ## 为什么这一版改成**命令式**
 *
 * 上一版用 `useMemo` 建几何体、React 卸载即消失。要支持"淡出期间还得继续画"，
 * 就得让几何体在选中项已清空之后**仍然存在一段时间** —— 用 React 生命周期表达会很别扭
 * （要额外记一份"上一个几何体"、还要手动管它的 dispose）。
 * 所以改成诗云那样的做法：**几何体常驻、原地填属性、用 `uEnv` 控制显隐**，
 * 容量按 `MAX_LINES` 预分配、用 `setDrawRange` 决定这次画多少。
 *
 * ## 画什么
 *
 *   · **1 跳**：从选中星射向它自己的同路线论文（每篇最多 K 条，权重最高的那些）——
 *     这一层是"放射"，是诗云那种从中心射出去的感觉；
 *   · **2 跳**：邻居的邻居之间连起来，铺一层更淡的网，让画面读起来是"一个网络"；
 *   · **赤道环**：绕选中星一圈的细环（诗云的 `buildEquatorRing`，96 段），
 *     半径取邻居的水平最大距离 —— 它把"这颗星的关系范围"框了出来。
 *
 * ## 为什么线的数量天然比参考实现少一个量级（这一点必须如实说）
 *
 * 参考实现的一个诗人有**几千首**诗，所以能射出几千条线；而我们一篇论文在
 * 「同技术路线」图里的度只有约 **11**。这是**数据的形状**，不是渲染省了。
 * 所以这里用两跳把可视的关系扩到上百条，但不会假装一篇论文有几千个同路线伙伴。
 *
 * ## 诚实的边界
 *
 * 线另一端的那颗星**当前可能没有被画出来**（它不在演示点集里）。所以这些线是
 * "从这颗在场的星出发、连到它的同路线论文"，不是"两颗可见星之间的关系"。
 * 另外这是**语义近邻，不是引用**（引用边需要外部 API，见 `docs/04-引用数据获取.md`）。
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { DOMAINS } from "../data/domains.ts";
import { docIndex } from "./points.ts";
import { hexRgb } from "./geometry.ts";
import { buildCiteFan } from "./citationFan.ts";
import { FILAMENT_FRAG, FILAMENT_VERT } from "./shaders.ts";
import { useCloud, type DomainRuntime } from "../state/cloud.ts";
import { selectionEnv } from "./selectionEnv.ts";

/** 生长时间（秒）—— 照搬诗云的 `GROW` */
const GROW = 1.2;
/** 淡出时间（秒）—— 照搬诗云的 `FADE` */
const FADE = 1.2;
/**
 * 单条线的基准不透明度（实际约 0.48：`vHot` 会把选中项那批再乘 4）。
 *
 * 对比 v1（默认铺满星系的那张网）：那时 11 万条线、单条压到 **0.035** 才不至于糊成一片白。
 * 同一个旋钮，两种数量级 —— **这个数不能跨版本照抄**。
 * 参考实现的平面样式用 alpha 0.28，我们量级相当。
 */
/**
 * 单条线的不透明度。
 *
 * ⚠️ 0.12 → **0.42**：作者反馈「点击星星看不到连接线」。线一直在画
 * （`verify-filaments` 全绿、截图里也能找到），问题是**对比度**：
 * "每篇论文一个点"之后背景是 300 万颗亮星，0.12 的淡线被完全淹没。
 * 线是信息，必须在亮的背景上也读得出来 —— 这与"默认不要线"是两件事。
 */
const ALPHA = 0.42;
/**
 * 两跳合计最多画多少条。
 *
 * ⚠️ 2 跳的亮度系数（`HOP2_DIM`）与去重的 `pairKey` 都已经搬到
 * `filamentGraph.ts` —— 星点层要用同一份关系集，两处各留一份就是第二份公式。
 */
const MAX_LINES = 600;
/** 赤道环的段数 —— 照搬诗云的 `buildEquatorRing(ringR, 96)` */
const RING_SEGMENTS = 96;
/**
 * 连线的弯曲度（横向偏移 = 弦长 × 这个系数）。
 *
 * 诗云用"控制点朝星系中心收束 0.3"来成束；我们的线是**一颗星射向各处的扇形**，
 * 没有共同的收束点，所以改用"垂直于弦的偏移"：线弯成风车状，与星系的旋向同感。
 * 0.12 是**实测选的**：0.06 时肉眼仍像直线（白改），0.2 时短线的弯折过强、像钩子。
 */
const BEND = 0.12;

/** 生命周期阶段 */
type Phase = "idle" | "in" | "hold" | "out";

export function Filaments({ rt }: { rt: DomainRuntime }) {
  const edges = rt.filamentEdges;
  const loadFilaments = useCloud((s) => s.loadFilaments);
  const selection = useCloud((s) => s.selection);
  /** "减少动态效果"下停住沿线脉冲（那条偏好的语义是"别动"，见下面 useFrame 的说明） */
  const reduced = useCloud((s) => s.reducedMotion);
  const mat = useRef<THREE.ShaderMaterial>(null);
  const ringMat = useRef<THREE.LineBasicMaterial>(null);
  const lines = useRef<THREE.LineSegments>(null);
  const ring = useRef<THREE.LineLoop>(null);

  const sel = selection?.kind === "paper" && selection.domain === rt.id ? selection : null;
  const selDocId = sel?.docId ?? -1;

  /**
   * ⚠️ **数据到了必须强制重建一次**。
   *
   * 扇形内容是在 `useFrame` 里、且**只在选中项变化时**才 `build()` 的。
   * 于是第一次点星时 `edges`/`citeRefs` 往往还没到（都是按需拉的），
   * `buildFan` 拿到 undefined 直接返回 null ⇒ **一根线都不画**；
   * 之后帧里选中项没变，永远不会重建 —— 表现就是"点了星，线没了"。
   *
   * 把 `st.current.doc` 置 -1，下一帧就会走"选中项变了"的分支重建。
   */
  useEffect(() => {
    st.current.doc = -1;
  }, [edges, rt.citeRefs, rt.citeRefsDoc]);
  /** 只在第一次选中本团的论文时才去取边文件（默认不画线，就不该在首屏抢带宽） */
  useEffect(() => {
    if (selDocId >= 0 && !edges) void loadFilaments(rt.id);
  }, [selDocId, edges, loadFilaments, rt.id]);

  /**
   * 取**真实引用**列表（作者要求：发散的线连的是"这篇引用到的论文"）。
   *
   * 与上面那条"取语义边"并存：语义边是**降级方案**，引用表没有时才用它
   * （见 `citationFan.ts` 顶部那两行对照）。两条数据源都在选中之后才拉，
   * 首屏不抢带宽。
   */
  const loadCiteRefs = useCloud((s) => s.loadCiteRefs);
  useEffect(() => {
    if (selDocId >= 0) {
      void loadCiteRefs(rt.id, selDocId);
      /**
       * **选中论文时补齐该团的全量点**。
       *
       * 演示点集是"每 50 篇取 1"，被引论文的 docId 大概率不在其中 ⇒ 线找不到终点、扇形为空。
       * 只在有选中项时触发（用户已经在等这篇的引用，多等一会儿是合理的）。
       */
      const stt = useCloud.getState();
      if (stt.runtime[rt.id]?.phase === "demo") void stt.loadFull(rt.id);
    }
  }, [selDocId, loadCiteRefs, rt.id]);

  /**
   * 常驻几何体：容量按 `MAX_LINES` 预分配一次，之后只改属性内容 + `setDrawRange`。
   * 这样"淡出期间保持不动"不需要任何 React 生命周期技巧。
   */
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const cap = MAX_LINES * 6;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute("aCenter", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute("aPhase", new THREE.BufferAttribute(new Float32Array(cap), 1));
    g.setAttribute("aSrc", new THREE.BufferAttribute(new Float32Array(cap), 1));
    /**
     * 关系强度：**选中态的扇形一律画满**，所以这里恒填 1，
     * 并让 `uMinWeight` 保持 0（阈值那一套只服务于常驻关系线场 —— 用户点开一篇论文，
     * 要看的就是它**全部**的关系，不该被阈值筛掉）。
     */
    g.setAttribute("aWeight", new THREE.BufferAttribute(new Float32Array(cap).fill(1), 1));
    /**
     * 线参数 aT：**每条线 3 段、6 个顶点**，t 依次是 0,⅓ ⅓,⅔ ⅔,1。
     * 端点淡出与沿线脉冲都靠它（见 FILAMENT_VERT 的说明）。
     */
    const tArr = new Float32Array(cap);
    for (let i = 0; i < MAX_LINES; i++) {
      const T = [0, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1];
      for (let k = 0; k < 6; k++) tArr[i * 6 + k] = T[k];
    }
    g.setAttribute("aT", new THREE.BufferAttribute(tArr, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }, []);
  const ringGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RING_SEGMENTS * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }, []);
  useEffect(
    () => () => {
      geo.dispose();
      ringGeo.dispose();
    },
    [geo, ringGeo],
  );

  const uniforms = useMemo(
    () => ({
      uGrow: { value: 0 },
      uAlpha: { value: ALPHA },
      uRest: { value: 1 },
      uSelDoc: { value: -1 },
      uSelOn: { value: 0 },
      uEnv: { value: 0 },
      /** 沿线脉冲的时钟（秒）—— 每帧推进，见下面 useFrame */
      uTime: { value: 0 },
      /** 选中态的扇形**不做强度筛选**（恒 0 ⇒ 全部通过），理由见上面 aWeight 的说明 */
      uMinWeight: { value: 0 },
    }),
    [],
  );

  /** 生命周期状态机（用 ref，避免每帧触发 React 重渲染） */
  const st = useRef({ doc: -1, phase: "idle" as Phase, t0: 0, refsFor: -1 });

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const s = st.current;

    // ---- 选中变化 → 重建内容并进入"生长"
    if (selDocId >= 0 && selDocId !== s.doc) {
      s.doc = selDocId;
      build(selDocId);
      s.phase = "in";
      s.t0 = t;
      s.refsFor = -1;
    } else if (selDocId < 0 && s.phase !== "idle" && s.phase !== "out") {
      // 取消选中 → 进入"淡出"（**不立刻清空**，否则线会瞬间消失）
      s.phase = "out";
      s.t0 = t;
    }

    /**
     * **引用数据晚到 → 重建内容**（不重播生长动画）。
     *
     * 点星时 /api/refs 还在路上，扇形先用空 refs 构建了一次；
     * 若不在数据到达后重建，屏幕上就永远没有线（作者："引用线怎么没了"）。
     */
    if (s.doc >= 0 && s.refsFor !== s.doc && rt.citeRefsDoc === s.doc) {
      s.refsFor = s.doc;
      build(s.doc);
    }

    // ---- 包络：生长 → 保持 → 淡出（照搬诗云的三段）
    let env = 0;
    let grow = 0;
    if (s.phase === "in") {
      grow = Math.min(1, (t - s.t0) / GROW);
      env = grow;
      if (grow >= 1) s.phase = "hold";
    } else if (s.phase === "hold") {
      grow = 1;
      env = 1;
    } else if (s.phase === "out") {
      grow = 1;
      env = Math.max(0, 1 - (t - s.t0) / FADE);
      if (env <= 0) s.phase = "idle";
    }

    const u = mat.current?.uniforms;
    if (u) {
      u.uEnv.value = env;
      u.uGrow.value = grow;
      // 这一层里的线**全都属于选中项**，所以整体是"热"的
      u.uSelOn.value = s.doc >= 0 ? 1 : 0;
      u.uSelDoc.value = s.doc;
      u.uRest.value = 1;
      /**
       * 沿线脉冲的时钟。
       *
       * ⚠️ 用**自己的累加器**（`t` 是 `clock.elapsedTime`，够用）—— 但注意"减少动态效果"
       * 这条偏好：作者明确要求过那条偏好的语义是"别动"（闪烁、UI 过渡都归零了）。
       * 脉冲是一条**方向提示**，不是装饰闪烁；仍然在"减少动态效果"下停住，
       * 因为那正是"我要静止画面"的字面意思（见 `verify-a11y.mjs`）。
       */
      u.uTime.value = reduced ? 0 : t;
    }
    if (ringMat.current) ringMat.current.opacity = env * 0.5;
    // 环随生长一起出现（诗云：环在平面段生长时淡入）
    if (ring.current) {
      ring.current.visible = env > 0.01 && grow > 0.2;
      ring.current.scale.setScalar(0.6 + 0.4 * grow);
    }
    const vis = env > 0.005;
    if (lines.current) lines.current.visible = vis;
    if (ring.current) ring.current.visible = ring.current.visible && vis;

    /**
     * 把包络发布出去（**本组件是唯一推进者**，见 selectionEnv.ts 的说明）。
     * 星云与核心柔光读它、按包络压暗 —— 否则核心的强光会把关系线吞掉。
     *
     * ⚠️ **只有"拥有选中项"的那个实例才能写 `domain`。**
     *    这个组件每个学科各挂一个（八个实例），而每个实例每帧都会走到这里 ——
     *    第一版就是无条件写 `selectionEnv.domain = rt.id`，于是**最后一个赢**：
     *    八个团轮流覆盖，物理团那边读到的永远不是 "physics"，压暗从来没生效过。
     *    实测表现是"改了压暗系数、画面完全没变"，而所有接线看起来都是对的。
     *
     *    现在的规则：`selDocId >= 0` 的实例写 value + domain（它就是拥有者）；
     *    淡出期间（`s.doc >= 0`）只更新 value、**不动 domain**，让拥有者继续生效；
     *    其余的实例一概不碰。
     */
    if (selDocId >= 0) {
      selectionEnv.value = env;
      selectionEnv.domain = rt.id;
    } else if (s.doc >= 0) {
      selectionEnv.value = env;
    }
  });

  /**
   * 填几何体内容（原地写属性数组，然后 setDrawRange）。
   *
   * 邻域本身由 `buildFan`（filamentGraph.ts）算 —— **星点层也用同一个函数**
   * 来决定"哪些星要保持亮着"。两处各算一遍就是第二份公式，改了线忘了星，
   * 画面上会变成"线和亮着的星对不上"。
   */
  function build(doc: number) {
    const points = rt.points ?? rt.demoPoints;
    /**
     * **优先用真实引用**造扇形；没有引用表（或这一篇还没取到）时退回语义近邻。
     *
     * 两者输出同一个 `Fan` 结构，所以下面画线的一大段代码完全不用改 ——
     * 换的只是"关系从哪来"，见 `citationFan.ts` 顶部对这条接口对齐的说明。
     */
    const citeRefs = rt.citeRefsDoc === doc ? rt.citeRefs : undefined;
    const fan =
      citeRefs && citeRefs.length
        ? buildCiteFan(citeRefs, points, doc)
        : null; // 只画真实引用：没有 citeRefs 就不画，不退回语义邻域
    if (!fan || !points) return;

    const dom = DOMAINS.find((d) => d.id === rt.id);
    const tint = hexRgb(dom?.color ?? "#ffffff");
    const W0 = 0.65;
    const W1 = 0.99;
    const colorOf = (w: number, k: number) => {
      const tt = Math.min(1, Math.max(0, (w - W0) / (W1 - W0)));
      const gain = (2.0 + tt * 0.8) * k;
      return [
        (tint.r + (1 - tint.r) * (0.2 + tt * 0.8)) * gain,
        (tint.g + (1 - tint.g) * (0.2 + tt * 0.8)) * gain,
        (tint.b + (1 - tint.b) * (0.2 + tt * 0.8)) * gain,
      ] as const;
    };

    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const cen = geo.getAttribute("aCenter") as THREE.BufferAttribute;
    const col = geo.getAttribute("aColor") as THREE.BufferAttribute;
    const pha = geo.getAttribute("aPhase") as THREE.BufferAttribute;
    const srcA = geo.getAttribute("aSrc") as THREE.BufferAttribute;
    const P = pos.array as Float32Array;
    const C = cen.array as Float32Array;
    const K = col.array as Float32Array;
    const H = pha.array as Float32Array;
    const S = srcA.array as Float32Array;

    const n = Math.min(fan.segments.length, MAX_LINES);
    for (let i = 0; i < n; i++) {
      const seg = fan.segments[i];
      const c = colorOf(seg.w, seg.k);
      /**
       * 把直线改成**弯的**：二次贝塞尔，控制点取弦中点、沿垂直于弦的方向推开 `BEND·弦长`。
       *
       * ## 为什么必须弯（照诗云的"平面样式"）
       *
       * 诗云的连线是三次贝塞尔、控制点朝星系中心收束（它的 `BUNDLE = 0.3`），
       * 于是几千条线**拧成一股股流动的束**；而我们原来是一条条**直线**，
       * 1 跳的邻居常常在别的团里 ⇒ 画出来是几根**横贯全屏的辐条**，
       * 像尺子画的，和"星系"这个意象完全打架。
       *
       * 垂线方向取 `弦 × 世界上方向`：**它随线的方向一起转**，
       * 于是一个星射出的整束线会弯成**风车状**（与星系的旋向同感），
       * 而不是各自朝随机方向扭。
       *
       * ⚠️ 每段要铺 **3 个子段 / 6 个顶点**（`LineSegments` 只认顶点对），
       *    几何体容量也跟着从 `MAX_LINES × 2` 改成 `× 6`。
       */
      const dx = seg.bx - seg.ax;
      const dy = seg.by - seg.ay;
      const dz = seg.bz - seg.az;
      const len = Math.hypot(dx, dy, dz) || 1;
      // 弦 × 世界上方向；退化时（弦几乎竖直）改用 X 轴叉乘
      let px = dy * 0 - dz * 1;
      let py = dz * 0 - dx * 0;
      let pz = dx * 1 - dy * 0;
      let pl = Math.hypot(px, py, pz);
      if (pl < 1e-4) {
        px = dy * 0 - dz * 0;
        py = dz * 1 - dx * 0;
        pz = dx * 0 - dy * 1;
        pl = Math.hypot(px, py, pz) || 1;
      }
      px /= pl;
      py /= pl;
      pz /= pl;
      const bend = len * BEND;
      const mx = (seg.ax + seg.bx) / 2 + px * bend;
      const my = (seg.ay + seg.by) / 2 + py * bend;
      const mz = (seg.az + seg.bz) / 2 + pz * bend;
      // 二次贝塞尔：B(t) = (1-t)²A + 2(1-t)t·M + t²B，取 t = 0, 1/3, 2/3, 1
      const T = [0, 1 / 3, 2 / 3, 1];
      const bx: number[] = [];
      const by: number[] = [];
      const bz: number[] = [];
      for (const t of T) {
        const u = 1 - t;
        bx.push(u * u * seg.ax + 2 * u * t * mx + t * t * seg.bx);
        by.push(u * u * seg.ay + 2 * u * t * my + t * t * seg.by);
        bz.push(u * u * seg.az + 2 * u * t * mz + t * t * seg.bz);
      }
      // 3 个子段 → 6 个顶点，顺序是 (p0,p1)(p1,p2)(p2,p3)
      const ORDER = [0, 1, 1, 2, 2, 3];
      for (let k = 0; k < 6; k++) {
        const o = i * 6 + k;
        const q = ORDER[k];
        P[o * 3] = bx[q];
        P[o * 3 + 1] = by[q];
        P[o * 3 + 2] = bz[q];
        // 两个顶点的 aCenter 都是起点 —— mix(aCenter, position, g) 于是让线从起点射出去
        C[o * 3] = seg.ax;
        C[o * 3 + 1] = seg.ay;
        C[o * 3 + 2] = seg.az;
        K[o * 3] = c[0];
        K[o * 3 + 1] = c[1];
        K[o * 3 + 2] = c[2];
        H[o] = seg.phase;
        S[o] = doc;
      }
    }
    pos.needsUpdate = true;
    cen.needsUpdate = true;
    col.needsUpdate = true;
    pha.needsUpdate = true;
    srcA.needsUpdate = true;
    geo.setDrawRange(0, n * 6);

    // ---- 赤道环：绕选中星、落在团的赤道面上。半径取邻居的水平最大距离
    if (fan.ringR > 0.01) {
      const srcIdx = docIndex(points.docIds, doc);
      const sx = points.positions[srcIdx * 3];
      const sy = points.positions[srcIdx * 3 + 1];
      const sz = points.positions[srcIdx * 3 + 2];
      const arr = (ringGeo.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * Math.PI * 2;
        arr[i * 3] = sx + Math.cos(a) * fan.ringR;
        arr[i * 3 + 1] = sy;
        arr[i * 3 + 2] = sz + Math.sin(a) * fan.ringR;
      }
      (ringGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      if (ringMat.current) ringMat.current.color.setRGB(tint.r * 1.4, tint.g * 1.4, tint.b * 1.4);
    }
  }

  return (
    <>
      <lineSegments ref={lines} geometry={geo} frustumCulled={false} visible={false} userData={{ layer: "filaments" }}>
        <shaderMaterial
          ref={mat}
          uniforms={uniforms}
          vertexShader={FILAMENT_VERT}
          fragmentShader={FILAMENT_FRAG}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
      {/*
        赤道环（照搬诗云的 buildEquatorRing）：96 段的 LineLoop，极淡（不透明度峰值 0.5 × uEnv）。
        它的作用是**把"这颗星的关系范围"框出来** —— 只有射出去的线、没有边界时，
        人会把最近的那条线误当成范围的边界。
      */}
      <lineLoop ref={ring} geometry={ringGeo} frustumCulled={false} visible={false} userData={{ layer: "equator" }}>
        <lineBasicMaterial
          ref={ringMat}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineLoop>
    </>
  );
}
