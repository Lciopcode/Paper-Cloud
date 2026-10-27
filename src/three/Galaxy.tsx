/**
 * 论文云 · 三维宇宙
 * ============================================================================
 * 四层结构（**顺序有意义**：先铺雾，再点星，最后加装饰）：
 *   ① 星云尘埃   —— 叠加混合，单点极暗，靠"很多点各自很淡"堆出雾
 *   ② 论文星点   —— **叠加混合** + 高斯软裙 + 颜色预乘，可拾取（2026-10 改，原为正常混合）
 *   ③ 远星天穹   —— 9000 单位外的暗星壳，给画面尺度感
 *   ④ 核心柔光   —— 每团一颗极淡的大柔光贴图
 *
 * ⑤ **HDR 辉光后期（bloom）** —— 见 `<Canvas>` 里那段注释：2026-10 才接上，
 *    在此之前 ④ 的注释原文是"**模拟** bloom"，而真 bloom 的库装了却没用过。
 *    星点在正常混合下没有光晕（整片像沙粒），改成叠加 + 预乘后才有了累积辉光，
 *    再由 bloom 把亮点晕开 —— 这两件必须一起做，只做一件都不像。
 */
import { useEffect, useMemo, useRef } from "react";
import { hitKey } from "../data/search.ts";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { DOMAIN_IDS, DOMAINS } from "../data/domains.ts";
import type { DomainSpec } from "../data/domains.ts";
import { useCloud, type DomainRuntime } from "../state/cloud.ts";
import { NEBULA_FRAG, NEBULA_VERT, STAR_FRAG, STAR_VERT, VOID_FRAG, VOID_STARS_FRAG, VOID_STARS_VERT } from "./shaders.ts";
import { YEAR_MAX, TIME_R1, impactPosition, ringRadiusOf, timePosition } from "./layout.ts";
import { docIndex } from "./points.ts";
import { hexRgb } from "./geometry.ts";
import { buildFan } from "./filamentGraph.ts";
import { buildCiteFan } from "./citationFan.ts";
import { emptyAnchorHit, registerAnchorResolver, resolveAnchor } from "./anchor.ts";
import { Filaments } from "./Filaments.tsx";

import { advanceSpin, galaxySpin } from "./galaxySpin.ts";
import { selectionEnv } from "./selectionEnv.ts";
import { StarPicker } from "./StarPicker.tsx";
import { pickAtScreen, pickAtScreenStats, pickWindowAtScreen } from "./gpuPick.ts";
import { FocusOnSelect } from "./FocusOnSelect.tsx";
import { LabelTracker } from "./StarLabel.tsx";
import { HoverTip } from "./HoverTip.tsx";
import { FlyCamera, GRAVITY_K, flyDebug } from "./FlyCamera.tsx";
import type { SpinBody } from "./FlyCamera.tsx";

/** 解析选中星坐标时复用的临时对象（每帧都要问一次，不能每帧新建）。 */
const _anchorHit = emptyAnchorHit();
const _anchorV = new THREE.Vector3();
/** 调试桥算"相机到选中星的距离"用的命中对象（不复用拾取那个，免得两处互相踩） */
const _bridgeHit = emptyAnchorHit();

/**
 * 选中一颗星之后镜头停在离它多远的地方 —— 现在由 `FlyCamera` 的 `LOCK_DIST` 定义
 * （自由飞行相机接管了这件事，见 `FlyCamera.tsx` 顶部的对照说明）。
 *
 * ⚠️ 这个数改过三次，前两次都是**因为别的参数不对而误判了它**，记下来免得再绕：
 *
 *   **3.4（第一次）**：截图是"一团白云"，于是判定"太近"。**误判。**
 *     真正的原因是当时点精灵 `430/视距` 且钳在 64px，凑近后每颗星都顶到上限。
 *
 *   **10（第二次）**：改成 10，把整个星团框进画面。构图是对的，但**看得见的仍然是一团光**。
 *
 *   **4.5 → 10 → 12 → 18（跟着布局放大走）**：整个布局（中心距与星团半径）放大了 2.2 倍，
 *     所以"离选中星多远"这个数也必须同比放大，否则等于又贴回脸上。
 *     判据仍是**屏幕间距**（参考实现约 28 像素、颗颗分明）：视距 10 时物理团的屏幕面积
 *     是默认机位的约 12 倍，间距约 4.7 像素；凑近到 10 已经能看清一颗颗球，
 *     再近就该由用户自己滚轮决定了。
 *
 * 18 这个值原样搬进了 `FlyCamera.tsx` 的 `LOCK_DIST`（数字相同，含义相同）。
 */

// ---------------------------------------------------------------- 论文星点层

/**
 * 密度归一化的基准点数 = "八个学科的演示点集全展开"（各约 7,600 篇）。
 *
 * 取它做基准的理由：默认视图下 uDensity 恰好 = 1.0，也就是**不改变标定好的默认观感**；
 * 只有点了「载入全部」（点数 ×50）才会生效。
 *
 * ⚠️ 这个数是**量出来的**，不是拍的：实测演示点集 61,050 时
 * `probeGL()` 给 nonBgPct 11.07 / blownPct 1.25（在 1.5% 红线内）；
 * 而点满 3,052,327 时整片过曝成白团。基准就取前者。
 */
const DENSITY_REF_POINTS = 300_000;

function StarLayer({
  rt,
  quality,
  sectorIdx,
}: {
  rt: DomainRuntime;
  quality: "high" | "low";

  /** 该学科在"时间排列模式"里的扇区序号（0..7） */
  sectorIdx: number;
}) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const objRef = useRef<THREE.Points>(null);
  const points = rt.points ?? rt.demoPoints;
  /** 当前选中的对象（用来让"选中那一颗"变大变亮） */
  const selection = useCloud((s) => s.selection);
  /**
   * 全场点数（八个学科合计）—— 给 uDensity 用。
   *
   * 为什么需要它：叠加混合下画面总亮度 ≈ 点数 × 单颗亮度，而点数是**运行时**由
   * 界面的「载入全部」改的（6.1 万 → 305 万）。原来单颗亮度是写死的常数，
   * 于是"载入全部"直接把总亮度乘 50 倍 —— 实测整片烧成过曝白团。
   * 这里把总点数接进 uniform，让**亮度随点数反比收敛**。见 shaders.ts 的 uDensity。
   */
  const totalPoints = useCloud((s) =>
    Object.values(s.runtime).reduce(
      (a, r) => a + (r.points?.count ?? r.demoPoints?.count ?? 0),
      0,
    ),
  );
  /** 检索命中集合（null = 未检索 ⇒ 全部正常亮度） */
  const searchHits = useCloud((s) => s.searchHits);
  const layoutMode = useCloud((s) => s.layoutMode);
  /** 各学科的年份表（只有时间模式才需要；null = 还没加载好） */
  const years = useCloud((s) => s.yearTables[rt.id] ?? null);
  /** 年份分位对照表（由 manifest 里的年份直方图建出；见 layout.ts 的说明） */
  const yearScale = useCloud((s) => s.yearScales[rt.id] ?? null);
  /** 星尘流：只留跨学科论文亮着 */
  const showCrossOnly = useCloud((s) => s.showCrossOnly);
  const crossTable = useCloud((s) => s.crossTables[rt.id] ?? null);
  /** 超新星遗迹：选中的爆发点（只留那批论文亮着） */
  const burst = useCloud((s) => s.selectedBurst);
  const stratumTable = useCloud((s) => s.stratumTables[rt.id] ?? null);
  /** 下潜高亮（点某个 L3 研究方向后只留它亮着） */
  const drill = useCloud((s) => s.highlightStratum);
  /** 引用表（按需加载；未加载时为 null，aCites 全填中性 1.0） */
  const cites = useCloud((s) => s.citeTables[rt.id] ?? null);
  const showCites = useCloud((s) => s.showCites);
  const starMode = useCloud((s) => s.starMode);

  const geometry = useMemo(() => {
    if (!points) return null;
    const g = new THREE.BufferGeometry();
    // position 用**拷贝**：时间模式要就地改写坐标，而 `points.positions` 是规范坐标，
    // 必须保持原样 —— 否则切回领域模式就回不去了。
    g.setAttribute("position", new THREE.BufferAttribute(points.positions.slice(), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(points.sizes, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(points.colors, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(points.seeds, 1));
    /**
     * 学科染色目标（逐顶点）。与 `aColor` 平行的一份数据 —— 为什么不能从 `aColor`
     * 反推、以及它解决的是什么问题，见 `STAR_VERT` 里 `aTint` 那两段。
     */
    g.setAttribute("aTint", new THREE.BufferAttribute(points.tints, 3));
    // aDim 初值全 1（正常亮度）。检索时只在 CPU 侧改这个数组，
    // 不必重建几何体 —— 重建 12 万个点的 BufferGeometry 会造成明显卡顿。
    g.setAttribute("aDim", new THREE.BufferAttribute(new Float32Array(points.count).fill(1), 1));
    /*
     * aCites = 由引用次数决定的亮度（用户明确要求的一对映射）。
     *
     * ⚠️ 没有引用数据时**必须填 1.0（中性）而不是 0** ——
     *    填 0 会让整片星系在着色器里被乘成黑色，看起来像"渲染坏了"。
     *    有了数据之后由下面那个 effect 逐篇填。
     */
    /**
       * LOD 的可见层级。初值 1（全可见）：星表还没到位时先别把星藏起来，
       * 否则首屏会黑一下。星表到了之后由下面的 effect 重新填。
       */
      g.setAttribute(
        "aTier",
        new THREE.BufferAttribute(new Float32Array(points.count).fill(1), 1),
      );
      g.setAttribute("aCites", new THREE.BufferAttribute(new Float32Array(points.count).fill(1), 1));
    /**
     * 拾取用的逐顶点 id（`index + 1`；0 留给"没点到"的黑色背景）。
     *
     * 为什么必须有它：GPU 拾取只读回一个颜色，颜色要能反查到**哪一层、哪个顶点**
     * —— 没有顶点下标就只能把 305 万点再投影一遍，那正是要删掉的 CPU 路径。
     * 代价 4 字节/点（305 万点 = 12MB），换掉每次拾取几十万次投影，划算。
     * 使用方见 `gpuPick.ts`（着色器里 `id = uIdBase + aId`，uIdBase 按层累加）。
     */
    {
      const ids = new Float32Array(points.count);
      for (let i = 0; i < points.count; i++) ids[i] = i + 1;
      g.setAttribute("aId", new THREE.BufferAttribute(ids, 1));
    }
    g.computeBoundingSphere();
    return g;
  }, [points]);

  /**
   * 引用表到位（或用户开关"引用亮度"）→ 逐篇填 aCites。
   *
   * 用 `brightOf()` 而不是在着色器里现算：对数与分位归一化在 CPU 侧做一次，
   * 之后每帧只读一个浮点数。反过来的话每帧要为 146 万个点各算一次 log ——
   * GPU 上不是不能做，但没必要（这些值在整个会话里不变）。
   */
  useEffect(() => {
    if (!geometry || !points) return;
    const attr = geometry.getAttribute("aCites") as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    if (!cites || !showCites) {
      arr.fill(1); // 中性：不做引用编码时保持原始观感
    } else {
      for (let i = 0; i < points.count; i++) arr[i] = cites.brightOf(points.docIds[i]);
    }
    attr.needsUpdate = true;
  }, [geometry, points, cites, showCites]);

  /**
   * 需求①：**默认只显示高被引的星**。
   *
   * 每团取被引最高的 K_PER_DOMAIN 颗（其余 aTier=0 → 默认模式下不画）。
   * 若引用表还没加载 / 覆盖太少（大部分论文没被引记录），退化成本点集内的**均匀抽样** ——
   * 否则会出现"一颗星都没有"的黑屏。
   */
  /** 每颗星的"基础可见层级"（0/1）：点亮引用时用来还原，避免把 LOD 结果覆盖掉 */
  const baseTier = useRef<Float32Array | null>(null);
  /** docId → 顶点下标（只在 points 变化时重建） */
  const docIndexMap = useMemo(() => {
    const m = new Map<number, number>();
    if (points) for (let i = 0; i < points.count; i++) m.set(points.docIds[i], i);
    return m;
  }, [points]);
  /**
   * 每团默认显示多少颗（作者要"满，60 万"）。
   *
   * 取 3.75 万/团 ⇒ 八团合计约 **30 万颗**（作者要求"降低到三十万"）。
   * 想回到"只画高被引"就把它调小（1500 是曾经的精选档）。
   */
  const K_PER_DOMAIN = 37_500;
  useEffect(() => {
    if (!geometry || !points) return;
    const attr = geometry.getAttribute("aTier") as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const a = attr.array as Float32Array;
    const n = points.count;
    if (n === 0) { attr.needsUpdate = true; return; }

    // 有被引数据：按 cites 降序取前 K
    const buckets: { i: number; c: number }[] = [];
    if (cites) {
      for (let i = 0; i < n; i++) {
        const d = points.docIds[i];
        if (cites.hasRecordOf(d)) buckets.push({ i, c: cites.citesOf(d) });
      }
    }
    if (buckets.length >= Math.min(K_PER_DOMAIN, n) * 0.5) {
      buckets.sort((x, y) => y.c - x.c);
      const keep = new Set(buckets.slice(0, K_PER_DOMAIN).map((b) => b.i));
      for (let i = 0; i < n; i++) a[i] = keep.has(i) ? 1 : 0;
    } else {
      const step = Math.max(1, Math.floor(n / K_PER_DOMAIN));
      for (let i = 0; i < n; i++) a[i] = i % step === 0 ? 1 : 0;
    }
    attr.needsUpdate = true;
  }, [geometry, points, cites]);

  /**
   * 需求①的后半句：「或者有一篇文章引用它，再展示出来」。
   *
   * 选中某篇论文后，它引用的星即使不在高被引集合里，也必须出现（aTier = 2）——
   * 否则画面上只有线、没有终点。换选中或取消选中时，按 baseTier 还原，
   * 不破坏 LOD 结果。
   */
  useEffect(() => {
    const attr = geometry?.getAttribute("aTier") as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const a = attr.array as Float32Array;
    const base = baseTier.current;
    if (!base) return;
    a.set(base);
    /** 选中的那颗星自己也要点亮（否则看不出"我选的是哪个"） */
    const siSel = docIndexMap.get(rt.citeRefsDoc ?? -1);
    if (siSel !== undefined) a[siSel] = 2;
    const refs = rt.citeRefs ?? undefined;
    /** 选中的那颗星自己也要点亮（否则"我选的是哪个"看不出来） */
    if (refs) {
      for (const docId of refs) {
        const i = docIndexMap.get(docId);
        if (i !== undefined) a[i] = 2;
      }
    }
    attr.needsUpdate = true;
  }, [geometry, docIndexMap, rt, rt.citeRefs, rt.citeRefsDoc]);

  // 排列模式变化 → 改写 position
  //
  // 为什么在这里做而不是重建几何体：重建 12 万个点的 BufferGeometry 会明显卡顿，
  // 而"改写坐标"只是一次 Float32Array 写入（12 万 × 3 次乘法），几乎瞬时。
  useEffect(() => {
    if (!geometry) return;
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;

    if (layoutMode === "time" && years && points) {
      // 时间模式：整片宇宙重排成一片盘状星系（内老外新）。
      // 坐标**只由地址与年份决定**，与领域模式共用同一套"确定性"要求。
      for (let i = 0; i < points.count; i++) {
        const docId = points.docIds[i];
        const year = docId < years.length ? years[docId] : 0;
        const [x, y, z] = timePosition(points.addrLow[i], year, sectorIdx, yearScale);
        arr[i * 3] = x;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = z;
      }
    } else if (points) {
      // 领域模式（默认）：还原成规范坐标
      arr.set(points.positions);
    }
    attr.needsUpdate = true;
    geometry.computeBoundingSphere();
  }, [geometry, points, layoutMode, years, yearScale, sectorIdx]);

  /**
   * 影响模式：按被引次数摆成**引力井**（中心 = 最高被引）。
   *
   * 与时间模式共用同一套"重写 position"的做法，但半径来源不同：
   * 时间用年份分位，影响用 `CiteTable.brightOf()`（已做 log 归一化）。
   */
  useEffect(() => {
    if (!geometry || !points || layoutMode !== "impact") return;
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < points.count; i++) {
      const docId = points.docIds[i];
      // 没有引用表时一律按"无记录"处理 —— 那正是事实（我们确实不知道），
      // 而不是把所有人当成 0 引用塞进外缘。
      const bright = cites ? cites.brightOf(docId) : 0.75;
      const [x, y, z] = impactPosition(points.addrLow[i], bright, sectorIdx);
      arr[i * 3] = x;
      arr[i * 3 + 1] = y;
      arr[i * 3 + 2] = z;
    }
    pos.needsUpdate = true;
    geometry.computeBoundingSphere();
  }, [geometry, points, layoutMode, cites, sectorIdx]);

  // 压暗：未命中检索的星、非跨学科的星（星尘流）、不属于所选爆发点的星（超新星遗迹）
  //
  // 同一个 `aDim` 机制承担三件事，**不必改着色器**：
  //   · 检索过滤：只留命中关键词的论文亮着；
  //   · 星尘流：只留**跨学科论文**（挂了多个 arXiv 分类）亮着 ——
  //     星桥显示的是"两个领域有联系"这个**强度**，而真正构成桥的是这些论文；
  //   · 超新星遗迹：只留"某个研究方向在某一年爆发"时的那批论文亮着 ——
  //     清单上的数字（"1997 年 491 篇，18×"）于是变成了可以逐个点开看的论文集合。
  //
  // 三者同时开启时取**交集** —— 那正是用户叠加这些开关时想看的。
  useEffect(() => {
    if (!geometry || !points) return;
    const attr = geometry.getAttribute("aDim") as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    const useDrill = drill && drill.domain === rt.id ? drill : null;
    /**
     * 选中本团某篇论文 → **其余论文退到 22%**（"聚焦"）。
     *
     * 为什么非做不可：点开一颗星之后要能看清它的关系线，但星团中心本身就是一团强光
     * ——而**那团光的绝大部分来自论文星点自己**（不是星云、也不是核心柔光；
     * 我先试过压暗后两者，实测几乎没有变化）。几十条细线在那种亮度旁边等于不存在。
     *
     * 参考实现的同一招：选中诗人之后弧网切成 **ego-net**、其余退下去。
     * 我们这里更彻底一点（整团退），因为我们的论文散布在整个星系里、
     * 不像它的行星云只围绕被选中的那颗星。
     *
     * ## 取值是**量出来的**，不是拍的（三轮）
     *
     *   · 0.22：核心仍是**叠加饱和**的白团（把单颗压到 22% 只缩小了饱和面积、
     *     峰值不变），关系线在中心附近依然看不见；
     *   · 0.12：blownPct 只从 1.925 降到 1.914 —— 几乎没动；
     *   · **0.04（现在）**：核心退成暗背景，关系线才真正浮出来。
     *
     * 分层归因（`_scratch/probe-whodunit.mjs`，用"低画质 = 关掉 bloom"做单变量对照）：
     *   选中态 blownPct = 1.914，**关掉 bloom 后只降到 1.445** —— 那团白
     *   **不是 bloom 晕出来的，是核心几千颗星自己叠饱和的**。而选中后镜头推到 18，
     *   半径约 7 个单位的核心占满画面 ⇒ 只要它还在全亮，线就不可能看清。
     *
     * 所以这里取"几乎藏起来"的值。这不违背"保留星系形状作空间上下文"那条原则：
     * 那条针对的是**检索/下潜**（用户在看整片星海里的一个子集），
     * 而选中是"把镜头交给这一篇"——参考实现的选中态也是一片暗背景 + 中心的关系网。
     */
    const selected =
      selection?.kind === "paper" && selection.domain === rt.id ? selection.docId : -1;
    if (!searchHits && !showCrossOnly && !burst && !useDrill && selected < 0) {
      arr.fill(1);
      attr.needsUpdate = true;
      return;
    }
    const DIM = 0.07; // 隐约可见轮廓，保留星系形状作为空间上下文
    const FOCUS_DIM = 0.04; // 选中时的"退后"程度（为什么这么低：见上面那段实测）
    const cross = showCrossOnly ? crossTable : null;
    // 爆发点是按学科选的，所以只有那个学科才应用它 ——
    // 否则别的星团会被整团压暗，看起来像"它们出问题了"。
    const useBurst = burst && burst.domain === rt.id ? burst : null;
    /**
     * 关系集：被选中那篇 + 它 1/2 跳邻居里**在场**的那些。
     *
     * 与丝线层**共用 `buildFan`**（filamentGraph.ts）——
     * 两处各算一遍就是第二份公式，改了线忘了星，
     * 画面上会变成"线和亮着的星对不上"，而那种错看起来只是"有些星莫名暗着"。
     *
     * `filamentEdges` 还没到位时 `buildFan` 返回 null：那时只有选中那颗保持亮着、
     * 其余退后；边文件到了这个 effect 会重跑（依赖里有 `rt.filamentEdges`）。
     */
    /**
     * ⚠️ **引用优先**，与 `Filaments.tsx` 的取舍必须完全一致。
     *
     * 丝线层在"有引用数据"时画的是引用扇形（`buildCiteFan`）。这里若还按语义关系集
     * 决定"哪些星保持亮着"，画面上就会变成：**线射向一片暗星** ——
     * 用户看到的是"这些线到底连着谁？黑乎乎的"。
     *
     * 条件与丝线层逐字相同（`citeRefsDoc === selected && citeRefs.length`），
     * 不在两处各写一套判断 —— 那是第二份规则，也是 filamentGraph.ts 顶部警告的同一类错。
     */
    const citeRefs = rt.citeRefsDoc === selected ? rt.citeRefs : undefined;
    const fan =
      selected < 0
        ? null
        : citeRefs && citeRefs.length
          ? buildCiteFan(citeRefs, points, selected)
          : buildFan(rt.filamentEdges, points, selected);
    const myDocIds = fan ? fan.ids : new Set<number>();
    for (let i = 0; i < points.count; i++) {
      const docId = points.docIds[i];
      let keep = searchHits ? searchHits.keys.has(hitKey(rt.id, docId)) : true;
      if (keep && cross) keep = docId < cross.length && cross[docId] === 1;
      if (keep && useBurst) {
        const s = stratumTable && docId < stratumTable.length ? stratumTable[docId] : -1;
        const y = years && docId < years.length ? years[docId] : 0;
        keep = s === useBurst.stratum && y === useBurst.year;
      }
      // 下潜：只留这个研究方向（L3）的论文
      if (keep && useDrill) {
        const s = stratumTable && docId < stratumTable.length ? stratumTable[docId] : -1;
        keep = s === useDrill.stratum;
      }
      if (keep) {
        arr[i] = 1;
      } else if (selected >= 0) {
        // 有选中项时，"不相关"是相对**这颗星的关系集**说的：
        // 被选中那颗自己，以及它的关系线上那些在场论文，都保持亮着
        arr[i] = selected === docId || myDocIds.has(docId) ? 1 : FOCUS_DIM;
      } else {
        arr[i] = DIM;
      }
    }
    attr.needsUpdate = true;
  }, [geometry, points, searchHits, showCrossOnly, crossTable, burst, drill, stratumTable, years, rt.id, selection, rt.filamentEdges]);

  const reducedMotion = useCloud((s) => s.reducedMotion);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },      /*
     * 低画质档的本意是**真的降负载**，不是只换观感。
     * 实测（SwiftShader 软件渲染，146 万点）：原来的 1.0 → 0.8 让帧率变化
     * **1.00 倍** —— 等于没有降级，白挂了一个开关。
     *
     * 瓶颈是**填充率**：每个点精灵最大 30px，146 万个点铺在屏幕上时
     * 像素着色器成为瓶颈（顶点着色器里那点 sin 的开销可以忽略）。
     * 所以把点尺寸压到 0.5、像素上限压到 14px 才是有效的降级。
     */
    uScale: { value: quality === "high" ? 1 : 0.5 },
          uTopOnly: { value: starMode === "top" ? 1 : 0 },
      /*
     * 闪烁强度：明确请求「减少动态效果」时**直接归零**（不是调小）。
     * "调小"仍然在动，而这条偏好的语义是"别动"。
     */
    uTwinkle: { value: reducedMotion ? 0 : quality === "high" ? 1 : 0.3 },
    /** 点精灵的像素尺寸上限（低画质 8px / 高画质 20px）—— 直接影响填充率 */
    // ⚠️ 64 → 20（2026-10，与 shaders.ts 里"430→130"同一次修正）。
    //    64 像素的上限让"凑近看"变成"看一团白云"：相机一近，每颗星都顶到上限，结构全糊。
    //    压到 20 之后，近处看到的仍然是**一颗颗星**，只是更大更亮。
    //    低画质档 14 → 8：那一档的瓶颈是填充率，精灵越小越省。
    /**
     * 点尺寸上限（像素）。
     *
     * ⚠️ **14 → 6**：这是"卡的不行"的第一号原因。
     * 305 万点时一帧的片元数 ≈ 点数 × 每点面积。上限 14 意味着最坏 3M × 196 ≈ 5.9 亿片元，
     * 而它们几乎全部走**加法混合**（不能早期深度剔除）—— 任何 GPU 都扛不住。
     * 6 的时候是 3M × 36 ≈ 1.1 亿，降 5.4 倍；观感上只是"凑近时不糊成一片"，
     * 因为星点本来就该是小硬点（作者要求"实"，见 STAR_FRAG 的说明）。
     */
    uMaxSize: { value: quality === "high" ? 20 : 10 },
    /**
     * 学科染色浓度（**实测旋钮**）—— 见 `STAR_VERT` 的 `aTint` / `uTint` 说明。
     *
     * 值由 `_scratch/probe-tint-sweep.mjs` 扫出来（同一个页面里扫，
     * 判据是整页口径的"有色占比尽量高、而 mean 与过曝不许涨"）。
     * 这一层是**星点**；星云那一层用同一个值，两处不一致会让"雾是彩的、星是白的"。
     */
    uTint: { value: STAR_TINT },
    /** 全局尺寸倍率（诗云叫 uSize，它取 3.0；我们的标定见 shaders.ts 里那段换算） */
    uSize: { value: 0.85 },
    /**
     * 密度归一化：单颗亮度随总点数反比收敛。
     *
     * 基准 61,050 是"演示点集全展开"的规模（八个学科各约 7,600 篇），此时取 1.0
     * —— 也就是**默认视图的观感与标定时一致**，改动只影响"载入全部"之后。
     *
     * 指数用 **sqrt** 而不是 1/N：点分散在整个星系体积里，只有核球那一小部分才真正
     * 完全重叠；取 1/N 会让大点集明显偏暗。实测定标见下面注释里的三个数据点。
     */
    uDensity: { value: Math.sqrt(DENSITY_REF_POINTS / Math.max(1, totalPoints)) },
      /**
       * 选中星的位置与开关。
       *
       * 用"比距离"而不是"传顶点下标"，理由见 shaders.ts 的 uSelPos 注释
       * （GLSL ES 1.00 没有 gl_VertexID，加一个下标属性又要 4 字节/点）。
       * 这里的初值随便给 —— `uSelOn` 为 0 时它在着色器里被整个乘掉。
       */
      uSelPos: { value: new THREE.Vector3() },
      uSelOn: { value: 0 },
    /** 别的团在选中时的亮度系数（1 = 不变）。见 StarLayer 的 useFrame 里那段单中心爆发的说明 */
    uOtherDim: { value: 1 },
    }),
    // 依赖要带上 reducedMotion —— 否则系统偏好变化后着色器不会重建，
    // 表现为"改了系统设置但画面没变"。totalPoints 同理：载入/卸载点集后必须重算。
    [quality, reducedMotion, totalPoints],
  );

  /**
   * 注册"选中星坐标解析器"（见 `anchor.ts`）。
   *
   * 这一层是本团**唯一**知道"某篇论文此刻画在哪"的地方，标记环、冲击波、镜头都来问它 ——
   * 所以不存在第二份位置公式。排列模式切换时坐标会被就地改写，解析器读的就是改写后的属性，
   * 因此三种模式（领域 / 时间 / 影响）自动一致，不必分别处理。
   *
   * ⚠️ 坐标必须从 **geometry 的 position 属性**读，不能读 `points.positions`：
   *    后者永远是领域模式的规范坐标，时间/影响模式会就地改写前者（见上面两个 effect）。
   *    读错的话标记在默认模式下是对的、一切换排列就跑到别处去 —— 这种错很难联想到原因。
   */
  useEffect(() => {
    if (!points) return;
    return registerAnchorResolver(rt.id, (docId, out) => {
      const obj = objRef.current;
      if (!obj) return false;
      const idx = docIndex(points.docIds, docId);
      if (idx < 0) return false;
      const attr = obj.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!attr) return false;
      const arr = attr.array as Float32Array;
      out.local[0] = arr[idx * 3];
      out.local[1] = arr[idx * 3 + 1];
      out.local[2] = arr[idx * 3 + 2];
      // `useFrame` 跑在 three 更新世界矩阵**之前**，直接读 `matrixWorld` 会拿到上一帧的值。
      // 星系本身不转，所以差一帧通常看不出来 —— 但切换排列模式的那一帧会明显错位，
      // 而这类"偶发错位"最难查。这里花一次向上遍历把矩阵刷成当前值，换掉这个不确定性。
      obj.updateWorldMatrix(true, false);
      _anchorV.set(out.local[0], out.local[1], out.local[2]).applyMatrix4(obj.matrixWorld);
      out.world[0] = _anchorV.x;
      out.world[1] = _anchorV.y;
      out.world[2] = _anchorV.z;
      return true;
    });
  }, [points, rt.id]);

  useFrame(({ clock }) => {
    const u = mat.current?.uniforms;
    if (!u) return;
    u.uTime.value = clock.elapsedTime;
    /**
     * 选中那一颗变大变亮（见 shaders.ts 的 uSelOn）。
     *
     * 只有"选中的是**本团**的论文、且本团在场"时才开 ——
     * 别的团跟着亮起来会让人以为选错了。
     */
    const sel = selection;
    if (
      sel?.kind === "paper" &&
      sel.domain === rt.id &&
      resolveAnchor(rt.id, sel.docId, _anchorHit)
    ) {
      u.uSelPos.value.set(_anchorHit.local[0], _anchorHit.local[1], _anchorHit.local[2]);
      u.uSelOn.value = 1;
    } else {
      u.uSelOn.value = 0;
    }
    /**
     * **单中心爆发**：选中一篇论文之后，**别的团整体退下去**，让"一个中心 + 它的关系"
     * 成为画面唯一的主角（作者最早的三条要求之一：「8 团平权总览 + **单中心爆发** + 径向丝线」）。
     *
     * ## 为什么必须由"别的团"来做这件事
     *
     * 原有的压暗只作用在**本团**（星云与核心柔光按 `selectionEnv` 退到 15%），
     * 于是选中之后画面是"本团暗了一点、八团还都在"——**读不出"中心"**。
     * 而八团平权总览本身没有错，它是另一件事（浏览态）；两个状态需要**相反**的处理：
     *   · 平权总览：八团一样亮 ⇒ 谁也不突出；
     *   · 单中心：中心亮、其余退 ⇒ 视线被钉在选中的那一篇上。
     *
     * ⚠️ 用 `aDim`（每颗星的亮度系数）而不是改 `uDensity` 或点尺寸 ——
     *    后两者会改掉"这一团有多少论文"的观感（论文数不能因为选中而变少）。
     */
    const other = selectionEnv.value > 0 && selectionEnv.domain !== rt.id ? selectionEnv.value : 0;
    u.uOtherDim.value = 1 - 0.72 * other;
  });

  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry || !points) return null;

  return (
    <points
      ref={objRef}
      geometry={geometry}
      frustumCulled={false}
      /**
       * ⚠️ **这里不能再挂 `onPointerDown`。**
       *
       * 挂了之后 R3F 会在**每次 pointermove** 都对这一层的全部顶点做射线检测。
       * 42 万点时勉强扛得住；作者要求"每篇论文一个点、八团全量常驻"之后是
       * **3,052,327 点** —— 界面直接卡住、点不上星（实测症状："连星星都点不了"）。
       *
       * 拾取改由 `<StarPicker>` 统一做：只在点击时把所有星点投影一次，
       * 取光标半径内最近的那颗（见 `StarPicker.tsx` 文件头）。
       * `docIds` 与 `domain` 留在这里，就是给拾取用的。
       */
      userData={{ layer: "stars", docIds: points.docIds, domain: rt.id }}
    >
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={STAR_VERT}
        fragmentShader={STAR_FRAG}
        transparent
        depthWrite={false}
        // ⚠️ 2026-10 从 NormalBlending 改成叠加混合。
        //    旧版因为"叠加会烧白"退回了正常混合，代价是星星没有光晕、整片像沙粒。
        //    现在改成"每颗压到极暗 + 高斯软裙 + 颜色预乘"（见 shaders.ts 的 STAR_FRAG），
        //    叠加下等效贡献是 vColor * a² * vAlpha，靠密度累积出亮核 —— 不烧白但有辉光。
        //    改动前后用 window.__three.probeGL() 量 blownPct，别超过参赛材料的 1.5%。
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// ---------------------------------------------------------------- 星云层
export function NebulaLayer({ rt, quality }: { rt: DomainRuntime; quality: "high" | "low" }) {
  const neb = rt.nebula;
  const geometry = useMemo(() => {
    if (!neb) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(neb.positions, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(neb.sizes, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(neb.colors, 3));
    g.setAttribute("aTint", new THREE.BufferAttribute(neb.tints, 3));
    g.computeBoundingSphere();
    return g;
  }, [neb]);
  const uniforms = useMemo(
    () => ({ uScale: { value: quality === "high" ? 1 : 0.75 }, uDim: { value: 1 }, uTint: { value: STAR_TINT } }),
    [quality],
  );
  const mat = useRef<THREE.ShaderMaterial>(null);
  /**
   * 选中本团的论文时把星云压暗（见 selectionEnv.ts 的说明）。
   *
   * 不压暗的话，核心那团强光会把关系线整个吞掉 —— 实测选中靠核心的星时，
   * 截图里几乎找不到线。退到 30% 之后线自己就浮出来了。
   * 这也是参考实现在别的场景用过的同一招（选中之后其余图层退下去）。
   */
  useFrame(() => {
    const m = mat.current;
    if (!m) return;
    const on = selectionEnv.domain === rt.id ? selectionEnv.value : 0;
    // ⚠️ 压暗要改 uDim（颜色），不是 uScale（尺寸）—— 见 shaders.ts 里那段实测说明
    m.uniforms.uDim.value = 1 - 0.85 * on;
  });
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <points geometry={geometry} frustumCulled={false} userData={{ layer: "nebula" }}>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={NEBULA_VERT}
        fragmentShader={NEBULA_FRAG}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// ---------------------------------------------------------------- 虚空尘埃
/**
 * 虚空尘埃：把八团**之间**的空间填满。
 *
 * ## 为什么必须有这一层（实测逼出来的结论）
 *
 * 作者的抱怨是「留白太多了，人家诗云一打开是充满整个屏幕的」。
 * 于是我把诗云线上站点的画面**按同一套口径量了一遍**（见 `_scratch/imgstat.mjs`）：
 *
 * | 指标 | 诗云（默认机位） | 我们（默认机位） |
 * |---|---|---|
 * | 非背景像素 | 94–100% | **11.8%** |
 * | 平均亮度 | 43–111（随状态） | **13.0** |
 * | 带色像素 | 44–95% | **1.4%** |
 * | 亮度 ≤15 的像素 | ~8% | **88.6%** |
 *
 * 也就是说：**我们 88.6% 的屏幕基本是纯黑的**，而它几乎每个像素都有东西。
 *
 * ## 它到底靠什么填满的（逐层归因，别再猜）
 *
 * 用 `THREE_DEVTOOLS` 壳接住它的 scene、再逐层关掉量亮度 —— 结论是：
 *   · **Bloom 贡献 ≈ 0**（把它画质切到"低"就是关掉 EffectComposer，mean 112.5 → 112.7）；
 *   · **核心柔光 Sprite ≈ 0**（关掉 mean 反而升了 1.3）；
 *   · 远星天穹、星系本体各 ≈ 0；
 *   · **整屏那条暖色来自它几千条"赠诗弧"**（用户认领的诗之间画的连线）——
 *     关掉那一层 mean 从 110.9 掉到 **31.8**。它是一屏**关系线**，不是一屏雾。
 *
 * 而作者明确要求过「取消默认连线，点击才显示纤细关系线」——所以我们**不能**抄那层线。
 * 能做的是它画面里另一半：**粒子本身铺满整个空间**（它的虚空里全是尘埃，
 * 那句"点虚空从噪声里捞诗"就是这个设定的台词）。
 * 我们的虚空原来是**字面意义的空**，八团之间的黑就是这个。
 *
 * ## 参数怎么定的
 *
 * 两个成分叠起来，都从固定种子算出来（与本项目"位置由编号算出、不存储"同一条原则，
 * 这一层与天穹一样属于**装饰层**，不承载编号）：
 *   · **贴团**（45%）：绕某团中心、半径 0.25–1.6R 的各向同性云 —— 让八团有"大气"，
 *     边缘不再是硬切；
 *   · **整簇外壳**（55%）：以原点为中心、半径 16–200 的稀疏壳 —— 填八团之间的空隙，
 *     以及整簇之外那一圈。
 *
 * ⚠️ 亮度是**迭代出来的旋钮**（`VOID_BRIGHT`），判据是 `imgstat` 的那四个数
 * （非背景 / 平均亮度 / 有色 / 暖冷比），不是"看着差不多"。
 * 第一版 0.14 时非背景 40%、平均亮度 41。
 */
const VOID_DUST_COUNT = 120_000;
/**
 * 低画质档的尘埃数量。
 *
 * 照诗云的分档思路（它 high/low 的 DUST 是 120k/42k ≈ 35%）。
 * ⚠️ 但**能砍的只有装饰粒子**：论文星点一颗都不能少 —— 每一颗都是一篇论文，
 *    少画一颗就是漏掉一篇真实存在的论文（"3,052,327 篇"那行数字会变成假话）。
 *    所以低画质档的降负载只能落在雾、尘埃、辉光上，这一层是最大的一块。
 */
const VOID_DUST_COUNT_LOW = 45_000;
/** 单颗亮度（**迭代旋钮**，见上面那段判据） */
const VOID_BRIGHT = 0.007;
/** 学科色占比：比星点低（雾要偏暖偏中性，颜色留给星点去区分八团） */
const VOID_TINT = 0.22;

export function VoidDust() {
  const quality = useCloud((s) => s.quality);
  const geometry = useMemo(() => {
    const n = quality === "high" ? VOID_DUST_COUNT : VOID_DUST_COUNT_LOW;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    let seed = 0x5eed1234;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      // 各向同性方向（球面均匀采样，不是"每个分量取随机" —— 那会在立方体角上堆料）
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(2 * rnd() - 1);
      const dx = Math.sin(ph) * Math.cos(th);
      const dy = Math.cos(ph);
      const dz = Math.sin(ph) * Math.sin(th);
      let px: number;
      let py: number;
      let pz: number;
      /** 这一颗属于"贴团云"还是"星桥"—— 两者的亮度不同，见下面的 `shellDim` */
      const isClump = rnd() < 0.55;
      if (isClump) {
        // 贴团：绕某一团的中心
        const dom = DOMAINS[(rnd() * DOMAINS.length) | 0];
        const r = (0.3 + rnd() * 1.7) * dom.radius;
        px = dom.center[0] + dx * r;
        py = dom.center[1] + dy * r * 0.75;
        pz = dom.center[2] + dz * r;
      } else {
        /**
         * **星桥**：在两团之间的一段拱起的细管里采样。
         *
         * ## 为什么把"整簇外壳"换成这个
         *
         * 均匀外壳在屏幕上必然是一张**平底**（这一轮吃过两次亏：一次"噪点板"、一次"米色滤镜"）。
         * 而诗云那屏"满而不糊"的真正原因是**细亮的丝状结构 + 暗底**：
         * 它的角落是 (23,25,20)、中心是 (252,252,239) —— **局部亮、全局暗**。
         * 平滑的雾做不出这个组合：抬它就整体抬、压它就整体压（实测底光从 0.16 扫到 0，
         * 平均亮度 124 → 95，而角落跟着一起掉，对比度只从 0.42 升到 0.55）。
         *
         * 星桥是同一个想法的可落地版本，也正好是这个项目里已有的概念
         * （作者说过「星桥改造为密集丝线，星尘流并入它」）：
         *   · 粒子**只落在两团之间的细管里**，管外是暗的 ⇒ 有明暗起伏；
         *   · 管本身拱起 ⇒ 有空间频率，不是一根直棍；
         *   · 八团两两相连 ⇒ 总量够，但每一段都有边界。
         *
         * 采样：二次贝塞尔 `a中心 → 中点抬高 → b中心`，参数 t 取中段更密
         * （两端自然融进团的大气里），再叠一个各向同性的高斯管半径。
         *
         * ⚠️ 管径是**实测挑的**：7.5% 弦长时整屏又变成均匀亮板（老毛病），2.2% 才有丝状感。
         */
        const a = DOMAINS[(rnd() * DOMAINS.length) | 0];
        const b = DOMAINS[(rnd() * DOMAINS.length) | 0];
        const t = 0.12 + 0.76 * ((rnd() + rnd()) / 2);
        const ax = a.center[0];
        const ay = a.center[1];
        const az = a.center[2];
        const bx = b.center[0];
        const by = b.center[1];
        const bz = b.center[2];
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const mz = (az + bz) / 2;
        const chord = Math.hypot(bx - ax, by - ay, bz - az) || 1;
        const arch = chord * 0.18;
        const cx = mx + dx * arch;
        const cy = my + dy * arch;
        const cz = mz + dz * arch;
        const u = 1 - t;
        px = u * u * ax + 2 * u * t * cx + t * t * bx;
        py = u * u * ay + 2 * u * t * cy + t * t * by;
        pz = u * u * az + 2 * u * t * cz + t * t * bz;
        const tube = chord * 0.022;
        const g1 = (rnd() + rnd() + rnd() - 1.5) * 1.155;
        const g2 = (rnd() + rnd() + rnd() - 1.5) * 1.155;
        const g3 = (rnd() + rnd() + rnd() - 1.5) * 1.155;
        px += g1 * tube;
        py += g2 * tube;
        pz += g3 * tube;
      }
      pos[i * 3] = px;
      pos[i * 3 + 1] = py;
      pos[i * 3 + 2] = pz;

      /**
       * 颜色：**暖金为主**（照诗云的尘埃色温：它的画面里暖冷像素比约 190:1），
       * 掺一点学科色与少量青绿（诗云星海里也有青绿星，全靠暖色会显得单色）。
       */
      const r0 = rnd();
      let cr: number;
      let cg: number;
      let cb: number;
      if (r0 < 0.08) {
        // 青绿点缀
        cr = 0.62;
        cg = 0.92;
        cb = 0.86;
      } else {
        // 暖金 → 米白 的渐变（三段，避免所有尘埃一个颜色）
        const k = rnd();
        if (k < 0.5) {
          cr = 1.0;
          cg = 0.82;
          cb = 0.55;
        } else if (k < 0.85) {
          cr = 1.0;
          cg = 0.9;
          cb = 0.72;
        } else {
          cr = 0.95;
          cg = 0.95;
          cb = 0.98;
        }
        // 学科色只轻轻带一点：雾整体要偏暖，颜色留给星点去区分八团
        const dom = DOMAINS[(rnd() * DOMAINS.length) | 0];
        const d = hexRgb(dom.color);
        cr = cr * (1 - VOID_TINT) + d.r * VOID_TINT;
        cg = cg * (1 - VOID_TINT) + d.g * VOID_TINT;
        cb = cb * (1 - VOID_TINT) + d.b * VOID_TINT;
      }
      /**
       * 亮度：外壳**再压一档**。
       *
       * ⚠️ 这一条是"整屏变成一张均匀噪点板"那个问题的一半解。
       *    第一版两个成分同亮度，而外壳铺满整个视野 ⇒ 屏幕上出现一层**到处一样亮**的灰金噪点，
       *    八团与虚空之间没有明暗差 —— 远看像电视雪花，不像星系。
       *    外壳的职责只有"别让角落纯黑"，所以给它 0.45 的系数，让明暗关系重新回到星团身上。
       */
      /**
       * 星桥的亮度。
       *
       * ⚠️ 具体数字是**实测挑的**：0.55 太暗（构不成结构，有色只有 2.6%）、
       *    1.7 时叠加出过曝 6.7%、1.0 时 5.5% —— 而**整页口径的过曝预算是 5%**
       *    （`verify.mjs` 的判据，也是文档里"取观感、改指标"之后定下的那条）。
       *    0.62 是压进预算的那一档：平均亮度 110.8、局部对比度 0.493、过曝 5.08%。
       */
      const shellDim = isClump ? 1 : 0.15;
      const b = VOID_BRIGHT * shellDim * (0.5 + rnd() * rnd() * 1.6);
      col[i * 3] = cr * b;
      col[i * 3 + 1] = cg * b;
      col[i * 3 + 2] = cb * b;
      siz[i] = 1.6 + rnd() * rnd() * 3.4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(siz, 1));
    return g;
    // ⚠️ 依赖里必须有 quality：它决定粒子数，而 `useMemo` 只在依赖变化时重算 ——
    //    不写的话切画质档时尘埃数量**不会变**（这也是"画质开关看起来没效果"的经典成因）。
  }, [quality]);
  /**
   * ⚠️ `uTint` **必须显式给 0**：这一层复用的是 `NEBULA_VERT`，而那个着色器现在
   * 会读 `aTint` 做学科染色。虚空尘埃**没有** `aTint` 属性（它的颜色是就地算的，
   * 已经带了 `VOID_TINT = 0.22` 的学科色与暖金底），顶点属性缺省值是 `(0,0,0)` ——
   * 一旦 `uTint > 0`，那一段会把它 **mix 到黑色**（`aTint * (lc/lt)` 里 `aTint` 是 0），
   * 整层直接消失。给 0 就是显式声明"这一层不参与学科染色"。
   */
  const uniforms = useMemo(() => ({ uScale: { value: 1 }, uDim: { value: 1 }, uTint: { value: 0 } }), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <points geometry={geometry} frustumCulled={false} userData={{ layer: "voiddust" }}>
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={NEBULA_VERT}
        fragmentShader={VOID_FRAG}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// ---------------------------------------------------------------- 学科星野
/**
 * 学科星野（**照搬诗云的 `StarField`**）—— 本轮找到的、我们缺的那一层。
 *
 * ## 为什么之前"怎么看都不像"
 *
 * 作者拍板对齐的诗云参照帧是**飞出星系之后**那一帧。同口径整页指标：
 *
 *     诗云：mean 39.6 · cv 0.593 · colored 7.6% · blown 0.47%
 *     我们：mean 94.7 · cv 0.574 · colored 8.36% · blown 1.59%
 *
 * `colored` 看起来只差一点，但**机制完全不同**，这才是关键：
 *
 *   · 诗云的彩色来自**一颗颗离散的高饱和星**（它的 `StarField`：26,000 颗、
 *     按"朝代"上色、`gl_FragColor = vec4(vColor * 1.45, a * vTw)`）；
 *   · 我们的彩色来自**两万条常驻关系线的暖色**——把 `field` 关掉，
 *     `colored` 当场从 8.36% 掉到 **1.08%**，而 `mean` 掉 40.05（占了发光量的 46%）。
 *
 * 也就是说：诗云是"**黑底 + 离散的彩色亮星**"，我们是"**一层暖色纤维雾**"。
 * 数字（colored）碰巧接近，观感不是一回事 —— 这正是"指标达标但观感不对"的典型。
 *
 * 我们原来负责"填虚空"的是 `VoidDust`：12 万颗、单颗亮度 `0.007`、
 * 学科色只占 22%。它是**雾**（这是它当年被设计出来的目的，见那一段的说明），
 * 而诗云这一层是**星**。差别不在数量，在"每一颗亮不亮、有没有颜色、大不大"。
 *
 * ## 照搬的参数（逐项对应诗云 `StarField.tsx`）
 *
 * | 项 | 诗云 | 这里 |
 * |---|---|---|
 * | 数量 | 26,000（单档） | 26,000 高 / 10,000 低 |
 * | 颜色 | 每个朝代一个色，**饱和**（`d.color` 直接用） | 每个学科一个色（`DOMAINS[i].color`，宝石色） |
 * | 片元 | `vColor * 1.45`、`a * vTw` | 同 |
 * | 尺寸 | `clamp(aSize * (340 / -mv.z), 1, 42)`，`aSize = 1.1 + rnd²·5.5` | 同公式，`uSizeScale` 按我们的世界尺度重新标定 |
 * | 闪烁 | `vTw = 0.62 + 0.38 sin(uTime·0.8 + aSeed·2π)` | 同（减少动态效果时冻结） |
 * | 混合 | 加法、`depthWrite: false`、一次 draw call | 同 |
 *
 * ⚠️ **订正一处我自己的误读**：第一版这里用的是 `color2`，理由是"星野是暗底上的小亮点，
 *    应该用学科色的亮部"。**这个理由是错的** —— 在 `domains.ts` 里
 *    `color` 才是**宝石主题色**（`#f0b775` 金 / `#9ab8e8` 蓝 / `#6fc9bd` 青 /
 *    `#88c98a` 绿 / `#d9b878` 金 / `#b9a3e0` 紫 / `#d79ab4` 粉 / `#a8a0d8` 薰衣草），
 *    而 `color2` 是**光谱副色**，全是接近白的淡色（`#cfe0ff`、`#e6eeff`、`#d8fff6`…），
 *    它们的用途是"外臂的色温层次"，不是"亮星"。
 *    实测后果：整层星野出来是一片**白色小点**，与诗云那种"一眼能分出颜色"的星海完全不同。
 *    改用 `color` 之后才是它那个观感。
 *    这一条留在这里，是因为"按名字猜语义"这个错很容易再犯 —— 要看 `domains.ts` 里的定义。
 *
 * ⚠️ **`uSizeScale` 必须重新标定**：诗云的"世界尺度"是几千（星系半径 2400），
 *    我们是几十（星团半径 10~24）。直接抄 340 会让每颗星都是 42 像素的巨球。
 */
/**
 * 数量。
 *
 * ⚠️ **26,000 是量出来的，别再往上加**（2026-10 试过 60,000）。
 *
 * 动机是"诗云的 `StarField` 也是 26,000，但那是**一个星系**的量，
 * 我们摊到八个星系 + 一层外壳，每团只有它的八分之一"。看起来该加密，
 * 实测**没用** —— 拉远扫描（`probe-dolly.mjs`）对比"同等 mean 下有多少有色"：
 *
 * ................................................
 *             dist 90 的 mean / colored   比值
 * 26,000 颗     35.3 / 4.11             0.116
 * 60,000 颗     40.7 / 4.59             0.113   ← 密度翻 2.3 倍，比值反而略降
 * ................................................
 *
 * 原因很直白：这一层**已经是有色的**，加它的量会把 `mean` 与 `colored` **同比例**抬上去，
 * 不改变"彩光 / 总光"的比例；而"同取景比观感"比的正是那个比例。
 * **要提比例，只能让那些"中性的大面积层"变彩**（halo / field / stars），
 * 或者让总光变少 —— 不是让彩光变多。
 */
const VOID_STARS_COUNT = 26_000;
const VOID_STARS_COUNT_LOW = 10_000;
/**
 * 尺寸标定（**实测旋钮**）。
 *
 * 诗云是 `340`，但它的星系半径约 2400、我们约 10~24 —— 差两个数量级，
 * 所以这个数必须按"屏幕像素"重标，而不是照抄。
 * 目标与诗云一致：**多数 1~3 像素、少数到 5~6 像素**。
 *
 * ⚠️ 2026-10 从 18 提到 **30**：与 `FilamentField.FIELD_ALPHA` 一起定的档
 * （作者在 `_scratch/probe-final-sweep.mjs` 的二维扫描里挑的）。
 * 那两个旋钮是**互相拉扯**的 —— 压线的亮度会让颜色塌掉，提星野的尺寸把颜色补回来，
 * 但尺寸一大平均亮度和过曝又跟着涨。扫描表：
 *
 * ................................................
 * fieldA  starS   mean    cv     blown%  colored%
 * 0.042   18      97.29   0.563  1.792   8.58     ← 两个旧值
 * 0.012   18      70.54   0.596  0.527   1.90     ← 只压线：颜色塌了
 * 0.012   30      75.88   0.578  0.793   2.91     ← 现在这档
 * 0.012   48      87.42   0.552  1.617   5.21     ← 尺寸再大就回去了
 * ................................................
 */
const VOID_STARS_SIZE_SCALE = 30;

/**
 * **学科染色浓度**（`stars` 与 `nebula` 共用）。
 *
 * ## 定档依据（`_scratch/probe-tint-sweep.mjs`，同一页面、同一机位）
 *
 * ................................................
 * uTint    mean      cv   blown%  colored%
 * 0        90.9   0.575   2.324     2.84      ← 旧观感
 * 0.35     90.9   0.575   2.346     3.93
 * 0.5      90.9   0.575   2.355     4.82
 * 0.65     90.9   0.575   2.366     6.03
 * 0.8      90.9   0.575   2.379     7.52      ← 现在这档（诗云 7.64）
 * 1.0      90.9   0.575   2.394     9.68
 * ................................................
 *
 * **mean 一列到小数点后一位都没动、cv 一动不动、过曝只抬 0.07 个百分点** ——
 * 这正是这条通路的设计目的：`uTint` 是**纯色相旋钮，不是亮度旋钮**
 * （染色时按 luma 之比缩放学科色，见 `STAR_VERT`）。
 * 所以它能把 `colored` 从 2.84% 提到 7.52%，而**不付出任何亮度/过曝代价**。
 *
 * 取 0.8 而不是 1.0：0.8 恰好落在诗云那一帧的 7.64% 上（相对差 1.6%），
 * 再往上就是"为了超过参考而过度染色"了 —— 而这条通路的意义是**对齐**，不是超过。
 */
const STAR_TINT = 0.8;

export function VoidStars() {
  const quality = useCloud((s) => s.quality);
  const reduced = useCloud((s) => s.reducedMotion);
  const mat = useRef<THREE.ShaderMaterial>(null);

  const geometry = useMemo(() => {
    const n = quality === "high" ? VOID_STARS_COUNT : VOID_STARS_COUNT_LOW;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    const sed = new Float32Array(n);
    /** 每颗星属于哪个学科 —— 选中某团时用它把别的团压下去（按顶点，不是按整层） */
    const domIdx = new Float32Array(n);
    let seed = 0x57a2f1e1;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /**
     * 分布：**七成贴着某一团、三成撒在整簇外壳里**。
     *
     * 诗云的朝代是**按半径分带**的（`bandRadius(d.id)`），八带把半径分完，
     * 于是它的星野是"一片球壳里到处都有彩色星"。
     * 我们的八个学科是**并排**的（不是嵌套），所以照搬"分带"没有对应的语义；
     * 对应的做法是"**每一团外面裹一层自己的星野**"，再拿三成铺满整簇，
     * 让团与团之间的暗处也有星 —— 这正是参照帧里"黑底上到处是彩色小星"的来源。
     */
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(2 * rnd() - 1);
      const dx = Math.sin(ph) * Math.cos(th);
      const dy = Math.cos(ph);
      const dz = Math.sin(ph) * Math.sin(th);
      const spec = DOMAINS[(rnd() * DOMAINS.length) | 0];
      let px: number;
      let py: number;
      let pz: number;
      if (rnd() < 0.7) {
        // 贴团：从团心 0.6R 到 2.4R，越外越稀（否则外缘会有一条硬边）
        const r = spec.radius * (0.6 + 1.8 * Math.sqrt(rnd()));
        px = spec.center[0] + dx * r;
        py = spec.center[1] + dy * r * 0.8;
        pz = spec.center[2] + dz * r;
      } else {
        // 整簇外壳：把八团都罩进去，半径取最远团心距的 0.8~1.35 倍
        const far = Math.max(...DOMAINS.map((d) => Math.hypot(d.center[0], d.center[1], d.center[2])));
        const r = far * (0.8 + rnd() * 0.55);
        px = dx * r;
        py = dy * r * 0.8;
        pz = dz * r;
      }
      pos[i * 3] = px;
      pos[i * 3 + 1] = py;
      pos[i * 3 + 2] = pz;
      // ⚠️ 用**学科宝石色**（饱和），不是 `color2`（那套接近白的副色）—— 见上面那处订正
      const c = hexRgb(spec.color);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      // `1.1 + rnd²·5.5`：照诗云。平方分布 ⇒ 绝大多数偏小、少数偏大
      siz[i] = 1.1 + rnd() * rnd() * 5.5;
      sed[i] = rnd();
      domIdx[i] = DOMAIN_IDS.indexOf(spec.id);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(siz, 1));
    g.setAttribute("aSeed", new THREE.BufferAttribute(sed, 1));
    g.setAttribute("aDom", new THREE.BufferAttribute(domIdx, 1));
    return g;
  }, [quality]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSizeScale: { value: VOID_STARS_SIZE_SCALE },
      /** 被选中的学科序号（-1 = 没选中）；配合每顶点的 aDom 只压别的团 */
      uSelDom: { value: -1 },
      /** 别的团压到多暗 */
      uOtherDim: { value: 1 },
    }),
    [],
  );

  useFrame(({ clock }) => {
    const m = mat.current;
    if (!m) return;
    m.uniforms.uTime.value = reduced ? 0 : clock.elapsedTime;
    /**
     * 选中某团时，**别的团的星野**跟着退下去 —— 与 `StarLayer` 的"单中心爆发"同一口径。
     *
     * ⚠️ 压暗是**按顶点**做的（`aDom`），不是整层一起压：这一层八团共用一次 draw call，
     *    整层压会把选中那一团的星野也一起压掉，看起来像"点开之后背景整个熄了"。
     *
     * ⚠️ 写法与 `StarLayer` 那处对齐：`selectionEnv.value` 是**强度**、`.domain` 是**学科 id**。
     *    写成 `selectionEnv.value.domain` 会得到 undefined（它是个 number），
     *    于是这一层在选中时纹丝不动 —— 属于"不报错的错"，所以这里照抄那处的模式。
     */
    const other = selectionEnv.value > 0 ? selectionEnv.value : 0;
    m.uniforms.uSelDom.value = other > 0 ? DOMAIN_IDS.indexOf(selectionEnv.domain ?? "") : -1;
    m.uniforms.uOtherDim.value = 1 - 0.72 * other;
  });

  return (
    <points geometry={geometry} frustumCulled={false} userData={{ layer: "voidstars" }}>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={VOID_STARS_VERT}
        fragmentShader={VOID_STARS_FRAG}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// ---------------------------------------------------------------- 虚空辉光
/**
 * 虚空辉光：**一整片盖住视野的暖色底光**。
 *
 * ## 为什么单靠粒子填不满
 *
 * 虚空尘埃（上一节）解决的是"八团之间不空"，但它有个物理上限：
 * 点精灵的屏幕尺寸是 `200/视距`，**离得越远的粒子越小**。
 * 视野的四个角对应"背向整簇"的方向，那里的尘埃离相机 200+ 单位 ——
 * 实测角落取样只有 `(2,2,2)`（纯黑），而诗云同一个位置是 `(23,25,20)~(58,47,28)`
 * （暗，但**不是黑**）。这一层就是补这个差。
 *
 * ## 为什么用"平顶"贴图而不是高斯
 *
 * `softGlow()` 是高斯（中心 1、边缘 0）。直接放大到盖住全屏，中心会是一颗**巨大的白球**
 * ——在"8 团平权总览"的构图里，那等于在正中间凭空造了一个中心，把八团压成配角。
 * 所以这里另做一张**平顶**贴图：中心一片平坦、到边缘才软下去。
 * 于是全屏得到的是"均匀抬高一点"的深空底光，而不是一颗球。
 *
 * ⚠️ 它是**世界空间**的一个 Sprite（不是屏幕滤镜）：飞远了它就会缩小、消失，
 *    和诗云的核心柔光是同一种东西。这是一条刻意的取舍 ——
 *    屏幕锁死的"滤镜"在漫游时不会跟着变，看起来像贴了一层膜。
 */
let _wash: THREE.Texture | null = null;
function washGlow(): THREE.Texture {
  if (_wash) return _wash;
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  // 平顶：0–45% 半径都是满的，45%→100% 软收（这一条就是"底光"与"光球"的分界）
  g.addColorStop(0, "rgba(255,255,255,0.62)");
  g.addColorStop(0.45, "rgba(255,255,255,0.58)");
  g.addColorStop(0.7, "rgba(255,255,255,0.28)");
  g.addColorStop(0.88, "rgba(255,255,255,0.07)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _wash = new THREE.CanvasTexture(cv);
  return _wash;
}

/** 底光的直径（世界单位）与不透明度 —— **迭代旋钮**，判据是 `imgstat` 的四角取样 */
const WASH_SIZE = 118;
/**
 * ⚠️ **现在是 0 —— 也就是说这一层目前一个像素也不画。**
 *
 * 这是 `probe-wash-sweep.mjs` 扫出来的结论（底光从 0.16 扫到 0）：
 * 抬它就整体抬、压它就整体压，角落跟着一起掉，
 * 平均亮度 124 → 95 而对比度只从 0.42 升到 0.55 —— 而诗云的画面特征是
 * "**局部亮、全局暗**"（角落 (23,25,20)、中心 (252,252,239)），
 * 平滑的雾在数学上做不到这件事。那一层结构后来由**常驻关系线**
 * （`FilamentField`）承担，实测确实拿到了那个特征。
 *
 * **为什么把组件留着而不是删掉**：它是一条**被否掉的路线的记录**，
 * 而且旋钮还在（`setWashOpacity` 是诊断口）。留着零成本的空 Sprite，
 * 比删掉之后下次再有人想"加一层底光试试"、把它重新发明一遍要好。
 *
 * ⚠️ 但**必须写清它当前是 0**：否则下一个读这段注释的人会以为这层在生效，
 *    于是"画面角落为什么还是黑的"会被归因到它头上（实测它贡献 0.00）。
 */
const WASH_OPACITY = 0;

export function VoidGlow() {
  const tex = useMemo(() => washGlow(), []);
  return (
    <sprite scale={[WASH_SIZE, WASH_SIZE, 1]} renderOrder={-10} userData={{ layer: "wash" }}>
      <spriteMaterial
        map={tex}
        color="#ffc266"
        transparent
        opacity={WASH_OPACITY}
        depthWrite={false}
        // 底光必须在一切之后垫着：关掉深度测试 + 最小的 renderOrder
        depthTest={false}
        blending={THREE.AdditiveBlending}
      />
    </sprite>
  );
}

// ---------------------------------------------------------------- 核心柔光
let _soft: THREE.Texture | null = null;
function softGlow(): THREE.Texture {
  if (_soft) return _soft;
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.18, "rgba(255,255,255,0.34)");
  g.addColorStop(0.45, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _soft = new THREE.CanvasTexture(cv);
  _soft.needsUpdate = true;
  return _soft;
}

/**
 * 核心柔光（**照搬诗云的 halo**）。
 *
 * 它的做法：一张 128×128 的径向渐变贴图（0.95 → 0.38 → 0.09 → 0），
 * 一张 `R × 1.05` 的 Sprite，颜色 `#ffe9c4`（暖白），不透明度 **0.24**，叠加混合。
 *
 * 为什么这一张 Sprite 很关键：星点自己叠出来的核心是**斑驳**的（一颗颗都能数出来），
 * 而真实星系的核心是一团**糊开的暖光**。诗云的注释写得很清楚 ——
 * "a soft floor of core glow that bloom lifts further; the bright core itself is particles"：
 * 它是给粒子核心垫的一层底光，真正的亮核仍然由粒子堆出来。
 *
 * ⚠️ 我们原来是 `R × 1.6`、用学科色、不透明度 0.1 —— 三个数都不对：
 *    太大（糊到盘上去了）、太淡（几乎看不见）。
 *
 * ⚠️ **2026-10 颜色又改回"带学科色"了，这里记一下为什么翻转**：
 *    上一版把它定成纯暖白，理由是"核球应该是暖白，用学科色太花"。
 *    那条理由在当时成立 —— 那时整幅画面**偏冷**（暖冷像素比 0.52），需要暖色去中和。
 *    现在虚空尘埃与底光已经把整屏垫成暖琥珀（暖冷比 187:1），暖的问题解决了，
 *    而**学科色的可辨识度反而丢了**（作者要的是"八团有颜色区分"）。
 *    所以这里改成"学科色 : 暖白 = 6 : 4"：八团各有一圈**自己的颜色**的核心辉光，
 *    同时整屏仍然是同一个暖调 —— 两件事不再互斥。
 *
 * ⚠️ **2026-10 再往学科色偏一档：6:4 → 8:2。** 同一次排查里量到这一层是
 *    "中性的大面积光"之一（单独一层时**只有 0.0% 的亮像素有色差**，覆盖 25.5% 的画面），
 *    也就是它在把颜色冲淡。原因不是色相不对（它本来就是 6 成学科色），
 *    而是**彩度不够**：它的像素 `max` 多在 40~60，而"有色"的判据要 `色差 > 18`
 *    ⇒ 需要彩度比 > 0.3~0.45，而"6 成宝石色 + 4 成暖白"混出来的比只有 ~0.28。
 *    同一次还把八个学科色整体提了彩度（见 `domains.ts` 里那段），两处一起才够。
 */
const HALO_WARM = 0.2;
/** 核心柔光的不透明度（实测旋钮：0.24 时核心爆白面积偏大，整页过曝压不进 5%） */
const CORE_GLOW = 0.15;

export function CoreGlow({ rt }: { rt: DomainRuntime }) {
  const dom = DOMAINS.find((d) => d.id === rt.id);
  const tex = useMemo(() => softGlow(), []);
  const mat = useRef<THREE.SpriteMaterial>(null);
  // 选中本团的论文时把核心柔光也退下去（同一个理由：它是"最会吞掉关系线"的那一层）
  useFrame(() => {
    const m = mat.current;
    if (!m) return;
    const on = selectionEnv.domain === rt.id ? selectionEnv.value : 0;
    m.opacity = CORE_GLOW * (1 - 0.7 * on);
  });
  if (!dom) return null;
  const r = dom.radius;
  const c = hexRgb(dom.color);
  const warm = hexRgb("#ffe9c4");
  const haloColor = new THREE.Color(
    c.r * (1 - HALO_WARM) + warm.r * HALO_WARM,
    c.g * (1 - HALO_WARM) + warm.g * HALO_WARM,
    c.b * (1 - HALO_WARM) + warm.b * HALO_WARM,
  );
  return (
    <sprite position={[0, 0, 0]} scale={[r * 1.05, r * 1.05, 1]} userData={{ layer: "halo" }}>
      <spriteMaterial
        ref={mat}
        map={tex}
        color={haloColor}
        transparent
        opacity={CORE_GLOW}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </sprite>
  );
}

// ---------------------------------------------------------------- 远星天穹
/**
 * 远星天穹（**照搬诗云的 dome**）。
 *
 * 它的参数：5200 颗、半径 `2 × 星系半径`、`size 16` + `sizeAttenuation`、
 * 贴 `softGlow` 贴图、`opacity 0.7`、`alphaTest 0.01`、叠加混合。
 * 颜色是 `gg = 0.5 + rnd·0.5` 的灰白（蓝通道 ×1.05 略偏冷）。
 *
 * ## ⚠️ 关键订正：**这一层目前实际贡献为 0，而且诗云的也一样**
 *
 * 上面那段算术（旧值 `size 1.6` ⇒ 0.17 像素，所以"等于不存在"）是对的，
 * 但"换成 `size 20` ⇒ 约 2 像素 ⇒ 修好了"**这个结论是错的** —— 本轮实测：
 *
 * ┌─ 只留 dome（别的层全关），扫 size —— `_scratch/probe-dome-sweep.mjs`
 * │   size  20 → nonBg 0.08%  mean 10.03   ← 与"全关"逐位相同，一个像素都没画
 * │   size  40 → nonBg 0.32%  mean 10.11
 * │   size  60 → nonBg 0.65%  mean 10.24
 * │   size 120 → nonBg 2.01%  mean 10.88
 * │   size 240 → nonBg 7.12%  mean 13.38
 * │   size 400 → nonBg 18.66% mean 19.18
 * │
 * │ 全场景下这一层的**边际贡献**（开/关各量一次）
 * │   size  20 → ΔnonBg 0.01  Δmean 0.01
 * │   size 120 → ΔnonBg 0.05  Δmean 0.38
 * │   size 240 → ΔnonBg 0.16  Δmean 1.49
 * └─（不用三反引号围栏：`deploy/lint-embedded.mjs` 会把它当成 GLSL 模板里的反引号拦下来）
 *
 * `probe-dome-why.mjs` 把候选原因逐项排掉了：对象 `visible=true`、祖先链只有 `Scene:visible`、
 * 5200 个顶点都在、贴图 128px 有效、`alphaTest` 只吃掉一小部分（0.08 → 12.65 里它占 1.8）、
 * 混合与深度都不是原因 —— **唯一的旋钮就是 `size`**。
 *
 * ⚠️ **但 `size 20` 恰好是照诗云换算出来的忠实值**（它 `size 16 @ R=7200`，
 *    我们 `R=9000` ⇒ `16 × 9000/7200 = 20`），而诗云的远星穹本身贡献也 **≈0**
 *    （上一轮逐层关掉量过：星系本体、远星穹各 ≈ 0，整屏亮度来自赠诗弧）。
 *    所以"我们的远星穹看不见"**与参考实现是一致的，不是缺陷**。
 *
 * 于是这里的取舍写明白：
 *   · 要**忠实**（默认）⇒ 保持 `size 20`，接受这一层在指标上不可见；
 *   · 要**真的看见远星** ⇒ `size 120~180` 是实测的可用区间，代价是整屏 mean +0.4~0.9。
 *     这是**刻意偏离参考实现**，改之前先想清楚为什么要偏离。
 *
 * ## 其余照诗云
 *
 * 参数：5200 颗、半径 9000、`size` + `sizeAttenuation`、贴 `softGlow` 贴图、
 * `opacity 0.7`、`alphaTest 0.01`、叠加混合。颜色是 `gg = 0.5 + rnd·0.5` 的灰白（蓝通道 ×1.05 略偏冷）。
 *
 * ## ⚠️ 天穹**不自转**（照诗云：它的 `rotation` 只作用在星系粒子上，dome 是静的）。
 *    旧版给它加了 0.0035 rad/s 的自转，那是我们自己加的，去掉了。
 */
export function StarDome() {
  const n = 5200;
  const tex = useMemo(() => softGlow(), []);
  const geometry = useMemo(() => {
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    let seed = 987654321;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(2 * rnd() - 1);
      pos[i * 3] = 9000 * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = 9000 * Math.cos(ph);
      pos[i * 3 + 2] = 9000 * Math.sin(ph) * Math.sin(th);
      const g = 0.5 + rnd() * 0.5;
      col[i * 3] = g;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = g * 1.05;
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    gg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return gg;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <points geometry={geometry} frustumCulled={false} userData={{ layer: "dome" }}>
      <pointsMaterial
        size={20}
        sizeAttenuation
        vertexColors
        map={tex}
        transparent
        opacity={0.7}
        depthWrite={false}
        alphaTest={0.01}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/**
 * 帧率监视 + 自动降级（P3-5「低画质档自动降级」）。
 *
 * ## 为什么必须有自动降级
 *
 * "载入全部"会把一个学科从 2.9 万点变成 146 万点（50 倍）。
 * 实测在**软件渲染**（SwiftShader）下帧率从 3.5 掉到 0.5 —— 完全不可用。
 * 真机独显不会这么差（146 万点是**一次 draw call**），但用户可能在集显笔记本、
 * 也可能在 4K 屏上打开 —— 与其假设"应该没事"，不如**测了再决定**。
 *
 * ## 判据与节流
 *
 * · 采样窗口 2 秒，窗口内平均帧率 < 12 fps 才降级；
 *   阈值取 12 是因为低于它交互已明显不跟手（拖拽视角会拖影）。
 * · **只降一次**（store 里 perfAutoDegraded 守着），避免在阈值附近反复横跳 ——
 *   那会让画面每隔两秒变一次，比一直低画质更难受。
 * · 用户手动改过画质就不再自动改（尊重用户选择）。
 *
 * 这是纯逻辑组件，不渲染任何东西。
 */
function PerfMonitor() {
  const quality = useCloud((s) => s.quality);
  const autoDegrade = useCloud((s) => s.autoDegradeQuality);
  /**
   * **场景是不是正在干重活**（第三次修同一个错，这次改成"问 store"而不是"猜时长"）。
   *
   * ## 前两次修的是症状，这次修的是病因
   *
   * 同一条判据已经被加载开销骗过两次，每次都是"再加一层时间上的容错"：
   *   1. 第一版从挂载就开始量 ⇒ 首窗必然被"建几何 + 编译着色器"拖低 ⇒ **跳过第一个窗口**；
   *   2. 把默认密度提到每 20 篇取 1 之后，`buildPoints` 占主线程**超过两个窗口**
   *      ⇒ 热身一窗不够 ⇒ **要求连续两窗都慢**；
   *   3. 而本轮实测它**仍然在骗**：无头启动 3 次里有 2 次落到「低（自动）」，
   *      等于**用户与自检都看不到 bloom**（bloom 只在 high 档开）。
   *
   * 前两次的错在同一个地方：**用一个猜出来的时长去圈"哪段不算数"**。
   * 而"加载要多久"取决于磁盘、CPU、点数、边表大小 —— 猜不准，也没有猜的必要：
   * **store 里本来就有这两个标志位。**
   *
   *   · `phase === "loading"`：8 个团的 `buildPoints` 正在同步跑（305k 演示点）；
   *   · `filamentsLoading`：41.6 MB 关系边正在取 + 解析（首屏后 1.2 秒才开始，
   *     正好落在第二个采样窗口里 —— 这就是"连续两窗都慢"也拦不住它的原因）。
   *
   * 所以改成：**干活期间的窗口一律作废**（连热身窗口的身份也重新给），
   * 忙完之后的第一个完整窗口重新当热身。判据回到它本来的问题：
   * "这台机器闲下来之后扛不扛得住高画质"。
   *
   * ⚠️ 这不是放松判据：真扛不住的机器（软件渲染、集显）**闲下来之后**稳态同样低于 12fps，
   *    照样会在随后的连续两个窗口里触发降级。
   */
  const busy = useCloud((s) =>
    Object.values(s.runtime).some((r) => r.phase === "loading" || r.filamentsLoading === true),
  );
  const acc = useRef({ t0: 0, frames: 0 });
  /**
   * ⚠️ **跳过第一个采样窗口（2026-10 加）**。
   *
   * 采样窗口从**挂载那一刻**就开始，而挂载后的头两秒正是最忙的时候：
   * 建 6.1 万个点的几何、编译全部着色器 —— 加了 bloom 之后还要多编译
   * EffectComposer 的 mipmapBlur。于是**首窗平均帧率必然被拖低**，
   * 触发永久降级，而 bloom 又只在 high 档开 ⇒ **用户永远看不到 bloom**。
   *
   * 更要紧的是判据错位：它想问的是"这台机器**扛不扛得住**高画质"，
   * 实际量到的却是"**启动慢不慢**"。实测同一台 4090 D：
   * 加 bloom 前首窗过关、加 bloom 后首窗不过关，而两者稳态都是 60fps。
   *
   * 所以：第一个窗口只用来热身，从第二个窗口起才判。
   * 真扛不住的机器（软件渲染、集显）稳态同样低于 12fps，第二个窗口照样会降级 ——
   * 这不是把判据放松，是把**被启动开销污染的那个样本**去掉。
   */
  const warmed = useRef(false);
  /** 连续多少个 2 秒窗口低于 12fps（见下面降级处的说明：一次偶发卡顿不该改画质） */
  const slowStreak = useRef(0);

  useFrame(() => {
    /*
     * ⚠️ 必须用**挂钟时间**，不能用累加 dt。
     *
     * 第一版写的是"累加 dt，若 dt > 0.5 就跳过"（想避开切后台回来的大 dt）。
     * 后果：**帧率低于 2fps 时每一帧的 dt 都 > 0.5，于是全部被跳过** ——
     * 恰恰在最需要降级的时候永远不触发。实测就是：加载完整点集后帧率降到
     * 0.3fps，自动降级彻底失效（而演示点集下 2–3fps 反而能触发，因为它
     * dt≈0.4 < 0.5）。**"用被测量的量去做有效性过滤"是很隐蔽的自相矛盾。**
     *
     * 正确的做法：用挂钟时间算窗口，用 document.hidden 判断"切后台"。
     */
    if (typeof document !== "undefined" && document.hidden) {
      acc.current = { t0: 0, frames: 0 };
      // 从后台切回来时第一窗同样被"恢复现场"的开销污染，一并算作热身。
      warmed.current = false;
      return;
    }
    /**
     * ⚠️ **正在干重活 ⇒ 这一窗作废**（见上面 `busy` 那一大段）。
     *
     * 三个动作都要做，少一个都不行：
     *   · 清掉累加器 —— 否则"忙碌中被截断的那半窗"会跟"忙完后的半窗"拼成一个假窗口；
     *   · 把热身标记打回 false —— 忙完之后的第一个完整窗口要重新当热身
     *     （着色器重编译、GC、边表的首次触及都在那一窗里）；
     *   · 清掉连续慢计数 —— 忙碌不该被记成"慢"。
     */
    if (busy) {
      acc.current = { t0: 0, frames: 0 };
      warmed.current = false;
      slowStreak.current = 0;
      return;
    }
    const now = performance.now();
    if (acc.current.t0 === 0) {
      acc.current = { t0: now, frames: 0 };
      return;
    }
    acc.current.frames++;
    const elapsed = (now - acc.current.t0) / 1000;
    if (elapsed < 2) return;
    const fps = acc.current.frames / elapsed;
    acc.current = { t0: now, frames: 0 };
    if (!warmed.current) {
      // 首窗数据作废（见上面 warmed 的说明）—— 只热身，不据此降级。
      warmed.current = true;
      return;
    }
    /**
     * ⚠️ **要连续两个窗口都慢才降级**（2026-10 改）。
     *
     * 起因是一次实测：把默认密度从"每 50 篇取 1"提到"每 20 篇取 1"之后，
     * 8 个团的 `buildPoints`（同步 JS）在加载时占住主线程的时间**超过两个采样窗口**，
     * 于是"第一个窗口热身"这条规则不够用了 —— 第二个窗口仍然量到低帧率，直接降级。
     * 也就是说：**它量到的是加载时的构建耗时，不是稳态渲染性能**，
     * 而这条判据的本意是"这台机器是不是慢到交互不跟手"。
     *
     * 为什么是"连续两个"而不是"把窗口拉长"：一次偶发卡顿（切标签页回来、系统更新、
     * 别的进程抢 CPU）不该永久改掉用户的画质 —— 那种"降了就不回来"的行为比慢更让人难受。
     * 连续两个窗口（≈4 秒）持续低于 12fps，才说明是稳态问题。
     * 真扛不住的机器（软件渲染、集显）稳态同样低于 12fps，仍然会在第二个窗口触发。
     */
    if (fps < 12) slowStreak.current++;
    else slowStreak.current = 0;
    if (quality === "high" && slowStreak.current >= 2) autoDegrade(fps);
  });
  return null;
}

// ---------------------------------------------------------------- 场景
// ---------------------------------------------------------------- 自转
/**
 * 共享自转时钟的**唯一推进者**（对应诗云 `Galaxy.tsx` 里那次 `advanceSpin(dt)`）。
 *
 * 为什么必须"只有一个推进者"：多个图层各自累加会让它们**转散** ——
 * 而可点的星与画出来的星一旦错开，点击就会落在错误的星上，那种错极难查
 * （诗云的注释专门记了这件事）。
 */
function SpinClock() {
  const reduced = useCloud((s) => s.reducedMotion);
  useFrame((_, dt) => {
    // 明确请求"减少动态效果"时不推进（与 uTwinkle 归零同一条原则：那条偏好的语义是"别动"）
    if (!reduced) advanceSpin(dt);
  });
  return null;
}

/**
 * 让一组图层绕**本团自己的 Y 轴**刚性自转。
 *
 * `kind` 决定读哪个角：论文层读 `angle`、星云层读 `decorAngle` —— 两者速率不同
 * （0.012 vs 0.019 rad/s），于是弥散的雾会**缓缓流过**论文星，整片星海不再像一个
 * 刚体风车。这是诗云刻意做出来的差速。
 *
 * 角度**只读不写** —— 推进由 `SpinClock` 独家负责。
 */
function SpinGroup({ kind, children }: { kind: "main" | "decor"; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const reduced = useCloud((s) => s.reducedMotion);
  useFrame(() => {
    if (!ref.current) return;
    ref.current.rotation.y = reduced ? 0 : kind === "main" ? galaxySpin.angle : galaxySpin.decorAngle;
  });
  /**
   * 打一个 `userData.spin` 标记，好让调试桥**读回每一组的实际角度**（见 `spinReport`）。
   *
   * 为什么要留这个口：自转这件事有两条**不报错**的坏法 ——
   *   ① 某一层读的角与别的层不一致（"刚性"破了，而画面上只是"有点不对"）；
   *   ② 差速根本没有（星云与论文同速，整片像刚体风车）。
   * 两者都只能靠**读回真实角度**分辨，看截图是看不出来的
   * （0.012 rad/s 在两三秒里只有两三度）。原来的 `probe-spin.mjs` 只验了"论文层在转"，
   * 差速那半条自己写着"由常量保证" —— 常量对不等于接线对。
   */
  return (
    <group ref={ref} userData={{ spin: kind }}>
      {children}
    </group>
  );
}

/**
 * 一团在**当前排列模式下**的世界变换与尺度。
 *
 * ## 为什么必须抽成一个函数
 *
 * 图层的位置/倾角（下面的 JSX）与相机的**引力协转**（`FlyCamera` 的 `bodies`）必须用
 * **同一份**变换。这两处一旦各写一遍，改布局时只会改一处，症状是"星团挪了、镜头却还绕着老圆心转"——
 * 那种错不会报错、截图也看不出来，只有实测（"盯着看十秒，星有没有横移"）才发现得了。
 *
 * 时间模式是个特例：所有论文共用一套**全局坐标**（一片盘），所以八个团不再各自平移/倾斜
 * ——平移会把盘撕成八块。于是引力协转的圆心是原点、轴是世界 Y、半径取盘的外缘。
 */
function domainTransform(dom: DomainSpec, isTime: boolean) {
  if (isTime) return { position: TIME_ORIGIN, rotation: TIME_ORIGIN, radius: TIME_R1 };
  return { position: dom.center, rotation: dom.tilt, radius: dom.radius };
}
const TIME_ORIGIN = [0, 0, 0] as const;

function Scene() {
  const runtime = useCloud((s) => s.runtime);
  const visible = useCloud((s) => s.visibleDomains);
  const quality = useCloud((s) => s.quality);

  const layoutMode = useCloud((s) => s.layoutMode);
  /**
   * 背景开关（作者要求新增）。
   *
   * ⚠️ 用 `visible` 关掉一整组，而不是在每个背景层里各写一次 `if` ——
   *    这样"什么算背景"这件事只有**一份定义**（就是这个 `<group>` 的子节点列表）。
   *    散到各层里去写，将来加一层背景就会漏掉，表现成"点了隐藏，还剩一层没关"。
   */



  /**
   * 引力协转用的天体表（圆心 / 世界轴 / 引力球半径）—— 与下面每团的 `<group>` 同一份变换。
   * 见 `domainTransform` 的说明：这是"星为什么不在屏幕上乱漂"的那一半。
   */
  const spinBodies = useMemo<SpinBody[]>(
    () =>
      visible.flatMap((id) => {
        const dom = DOMAINS.find((d) => d.id === id);
        if (!dom) return [];
        const tr = domainTransform(dom, layoutMode === "time");
        // 转轴 = 把世界 Y 按这团的倾角转过去（`<group rotation={tilt}>` 之后，自转轴不再是世界 Y）
        const axis = new THREE.Vector3(0, 1, 0)
          .applyEuler(new THREE.Euler(tr.rotation[0], tr.rotation[1], tr.rotation[2]))
          .normalize();
        return [
          {
            id,
            center: new THREE.Vector3(tr.position[0], tr.position[1], tr.position[2]),
            axis,
            gravityR: tr.radius * GRAVITY_K,
          },
        ];
      }),
    [visible, layoutMode],
  );
  return (
    <>
      {/*
        ===== 背景层（可整组隐藏）=====
        这四层**不属于任何一个学科团**：远星穹、虚空星野、白噪声洗、虚空薄雾。
        作者明确说过那批彩色小星与"黑底学术星系"打架，所以给了一个一键开关，
        并且默认关闭（见 `cloud.ts` 里 `hideBackground` 的说明）。

        放在同一个 `<group>` 里，`visible=false` 会沿 three 的场景图传播到所有子节点 ——
        **一次赋值关掉四层**，不用逐个改材质或几何体。
      */}
      {/*
        **装饰层已全部删除**（作者："发光的点只能是论文，不会有其他装饰性的东西；
        装饰点去除，完全不要装饰，只留下论文点"）。

        删掉的是：远星穹 StarDome、虚空星野 VoidStars、白噪声洗 VoidGlow、
        虚空薄雾 VoidDust。这些层的点**不是论文**，却和论文点一样亮 —— 混在一起
        就分不清哪个点对应哪篇，而"每个光点=一篇论文"是作者的核心要求。
        连"隐藏开关"一起删：留一个永远关着的开关只会让人以为还藏着东西。
      */}
      <SpinClock />
      {visible.map((id, i) => {
        const rt = runtime[id];
        const dom = DOMAINS.find((d) => d.id === id);
        if (!rt || !dom || (!rt.demoPoints && !rt.points)) return null;
        // 时间模式下所有论文共用一套**全局坐标**（一片盘状星系），
        // 所以星团不再各自平移/倾斜 —— 平移会把盘撕成八块。
        // 星云与核心柔光只在领域模式下画：它们的坐标是按星团中心算的，
        // 留在时间模式里会变成八个孤立的光斑，反而看不出盘形。
        const isTime = layoutMode === "time";
        const tr = domainTransform(dom, isTime);
        return (
          <group
            key={id}
            position={tr.position as unknown as [number, number, number]}
            rotation={tr.rotation as unknown as [number, number, number]}
          >
            {/*
              自转：两层**不同速**（照诗云的差速）——
              星云读 decorAngle（0.019）、论文与丝线读 angle（0.012），
              于是雾会缓缓流过定住的星，整片星海不像刚体风车。
              时间模式不转（那时八个团共用一套全局坐标，转起来会把盘撕开）。
            */}
            <SpinGroup kind="main">
              {/*
                关系丝线：**只在选中之后才画**（作者要求：默认不铺网，点论文才显示关系线）。
                所以这里没有"默认开/关"的判断 —— 组件自己在没有选中项时返回 null。
                坐标是领域模式的局部坐标（与星点同一套，见 build-edges.mjs 里"直接 import 前端几何"那段），
                所以画在团的 `<group>` 里面；挂到外面就得自己再做一次 center/tilt 变换，那是第二份公式。
              */}
              {!isTime && <Filaments rt={rt} />}
              {/*
                **常驻关系线场已删除**（作者原话：「把星与星之间的连接线去掉，
                点击某个星再显示属于他的连接线」）。

                原来这里是 `<FilamentField>`：每团约 2600 条极淡的边（`FIELD_ALPHA=0.012`），
                默认就铺满整个星系。它来自"照搬诗云那片细线"的那一轮，但作者的判断是对的 ——
                默认状态下一根线都不该有：线是**信息**，不是纹理。
                满屏细线的坏处不只是"乱"：它让"点开一颗星才出现的那束扇形"失去了对比，
                点击的反馈被背景噪声吃掉了。

                现在线只有一处来源：`Filaments`（选中才出现，带生长/保持/淡出生命周期）。
              */}
              <StarLayer rt={rt} quality={quality} sectorIdx={i} />
            </SpinGroup>
          </group>
        );
      })}
      {layoutMode === "time" && <TimeRings />}
      {/*
        选中星的爆发与标记。
        挂在这里（Scene 的顶层）而不是某个团的 `<group>` 里面：它用的是**世界坐标**
        （由 anchor.ts 的解析器给出），而团有自己的位移与倾角，挂在团里会二次变换。
      */}
      <FocusOnSelect />
      <StarPicker />
      <LabelTracker />
      <FlyCamera bodies={spinBodies} />
      <PerfMonitor />
    </>
  );
}

/**
 * 时间模式的年代刻度环（每 10 年一圈）。
 *
 * 为什么需要：一片螺旋盘若没有刻度，就读不出"哪一段是哪个年代"——
 * "内老外新"只是我们的设计意图，用户不会猜到。加上刻度之后，
 * "2020 年之后论文量爆炸"这件事**能直接从图上读出来**。
 */
function TimeRings() {
  // 刻度环用**与点位完全相同的映射**（ringRadiusOf），否则环会落在错误的位置上 ——
  // 而这种错位在画面上看起来"只是环画歪了"，很难意识到读数是错的。
  const scale = useCloud((s) => s.yearScales[Object.keys(s.yearScales)[0] ?? ""] ?? null);
  const marks = useMemo(() => {
    const out: Array<{ year: number; r: number }> = [];
    for (let y = 1990; y <= YEAR_MAX; y += 10) out.push({ year: y, r: ringRadiusOf(y, scale) });
    return out;
  }, [scale]);

  return (
    <>
      {marks.map((m) => (
        <mesh key={m.year} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[m.r - 0.004, m.r + 0.004, 160]} />
          <meshBasicMaterial color="#ffd27a" transparent opacity={0.15} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- 调试桥
/**
 * 供无头自检脚本读取场景状态（`deploy/verify.mjs` 用它做可复现判据）。
 *
 * 为什么像素判据要用**离屏渲染**：
 *   直接 `gl.readPixels` 读画布只拿得到当前帧缓冲，浏览器合成后就丢了
 *   （`preserveDrawingBuffer` 默认 false，性能更好）。所以这里渲染到 RenderTarget 再读，
 *   拿到的是真实渲染结果 —— 这也是无头环境下唯一可靠的像素判据。
 */
let _bridge: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera } | null = null;

function DebugBridge() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    _bridge = { renderer: gl, scene, camera };
    /*
     * 同时挂到 window 上。
     *
     * 为什么不能只留模块私有变量：自检脚本要断言"按 W 相机**真的移动了**"，
     * 就必须读得到相机位置 —— 只看画面像素变化无法区分"移动了"与"刚好在闪"。
     * 模块私有变量在页面上下文里取不到，所以必须暴露。
     *
     * 这是**只读的调试出口**，不参与任何产品逻辑；名字带 Debug 以免被误用。
     */
    (window as unknown as { __lunyunDebug?: unknown }).__lunyunDebug = {
      renderer: gl,
      scene,
      camera,
    };
    return () => {
      _bridge = null;
      delete (window as unknown as { __lunyunDebug?: unknown }).__lunyunDebug;
    };
  }, [gl, scene, camera]);
  return null;
}

function renderOffscreen(scale: number): { buf: Uint8Array; w: number; h: number } | null {
  if (!_bridge) return null;
  const { renderer, scene, camera } = _bridge;
  const size = renderer.getSize(new THREE.Vector2());
  const w = Math.max(64, Math.floor(size.x * scale));
  const h = Math.max(64, Math.floor(size.y * scale));
  /**
   * ⚠️ **`colorSpace: SRGBColorSpace` 不是可选项 —— 少了它，所有像素判据都是错的。**
   *
   * ## 这是一个已经骗了我们两轮的 bug
   *
   * 默认的 `WebGLRenderTarget` 色彩空间是线性的：three 在渲染到**画布**时会做线性→sRGB 编码，
   * 渲染到**渲染目标**时不做。于是同一次绘制、同一个场景，两条路径出来的像素差了 2.5 倍：
   *
   * | 同一构建、同一时刻 | 角落取样 | 平均亮度 | 有色 | 暖冷比 | 局部对比度 |
   * |---|---|---|---|---|---|
   * | `Page.captureScreenshot`（用户看到的） | (237,190,98) | **124.7** | 63.9% | 130:1 | **0.418** |
   * | `probeGL` / `snapshot`（线性，错的） | (25,17,11) | **49.4** | 16.8% | 17:1 | 0.919 |
   *
   * 后果不是"数字不好看"，而是**照着错的靶子调了两轮**：
   * 「我们比诗云暗 8 倍、对比度高 2 倍」这个结论**主要是测量口径造成的**，
   * 真实画面上我们已经在参考值附近（诗云 111.5 / 0.429 / 94.8% / 192:1）。
   * 作者几次说"密度/亮度不对"而我这边数字对不上，根子就在这里。
   *
   * ## 另一个必须写下来的差异：这条路径**不含 bloom**
   *
   * `renderer.render(scene, camera)` 绕过了 `EffectComposer`（辉光是后期，不在场景图里），
   * 所以离屏图**永远比屏幕暗一点点**、也没有辉光晕开。
   * 因此：**视觉验收一律以整页截图为口径**（`Page.captureScreenshot`），
   * `probeGL` 只用来回答"这一层画出来了没有 / 参数变了没有"这类**相对**问题。
   */
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  renderer.setRenderTarget(prev);
  rt.dispose();
  return { buf, w, h };
}

/** 像素统计（自检用）。 */
function probeGL() {
  const r = renderOffscreen(0.75);
  if (!r) return null;
  const { buf, w, h } = r;
  let nonBg = 0;
  let blown = 0;
  let colored = 0;
  const hueBins = new Array(12).fill(0);
  for (let i = 0; i < w * h; i++) {
    const rr = buf[i * 4];
    const gg = buf[i * 4 + 1];
    const bb = buf[i * 4 + 2];
    const mx = Math.max(rr, gg, bb);
    const mn = Math.min(rr, gg, bb);
    if (mx > 14) nonBg++;
    if (mx > 250) blown++;
    if (mx - mn > 18 && mx > 40) {
      colored++;
      let hue: number;
      if (mx === rr) hue = ((gg - bb) / (mx - mn) + 6) % 6;
      else if (mx === gg) hue = (bb - rr) / (mx - mn) + 2;
      else hue = (rr - gg) / (mx - mn) + 4;
      hueBins[Math.min(11, Math.max(0, Math.floor((hue / 6) * 12)))]++;
    }
  }
  const n = w * h;
  /**
   * 平均亮度与对比度（标准差 / 均值）。
   *
   * 为什么补这两个：`verify.mjs` 的像素判据需要它们 —— 而这两条**正是"平底 vs 有结构"的判据**。
   * 原来的"有色像素 > 15%"要求一大片饱和亮底，而**参考实现自己过不了那条**
   * （它从外面看时是有色 7.6%：暗底 + 小彩星），于是那条判据在把人往"米色滤镜"推。
   * 对比度是它的正确替代：平坦的雾接近 0，暗底 + 亮结构明显大于 0（参考实测 0.593）。
   */
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < n; i++) {
    const mx = Math.max(buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
    sum += mx;
    sum2 += mx * mx;
  }
  const meanLum = sum / n;
  return {
    w,
    h,
    meanLum: +meanLum.toFixed(2),
    contrast: +(Math.sqrt(Math.max(0, sum2 / n - meanLum * meanLum)) / (meanLum || 1)).toFixed(3),
    nonBgPct: +(100 * (nonBg / n)).toFixed(2),
    blownPct: +(100 * (blown / n)).toFixed(3),
    coloredPct: +(100 * (colored / n)).toFixed(2),
    hueBins,
  };
}

/** 离屏截图（dataURL）。无头 + SwiftShader 下 CDP 截图常常拍不到 WebGL，用这个兜底。 */
function snapshot(scale = 0.8) {
  const r = renderOffscreen(scale);
  if (!r) return null;
  const { buf, w, h } = r;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  // WebGL 原点在左下、canvas 在左上 —— 必须上下翻转，否则画面是倒的
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    img.data.set(buf.subarray(src, src + w * 4), y * w * 4);
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL("image/png");
}

export function installDebugBridge() {
  (window as unknown as { __three?: unknown }).__three = {
    probeGL,
    snapshot,
    cameraPos: () => _bridge?.camera.position.toArray() ?? null,
    /** 相机朝向四元数 —— 验"拖拽真的转头了"必须看它，位置是不动的。 */
    cameraQuat: () => _bridge?.camera.quaternion.toArray() ?? null,
    /**
     * 相机到某颗星的距离（世界单位）。
     *
     * 为什么单独开一个口：自由飞行的**锁定轨道**有两件事要验，而它们都不能靠截图判断 ——
     * ① 点开一颗星之后镜头是不是真的滑到了 `LOCK_DIST` 附近；
     * ② 在那个距离上拖拽是"绕它转"（距离不变、角度变），不是"飞走"。
     * 用 `cameraPos()` 加一次减法也能算，但那要求探针自己知道星在哪 ——
     * 而星是**每帧随星系自转动的**，探针算出来的位置会和相机看到的差一个自转角。
     */
    cameraAnchorDist: (domain: string, docId: number) => {
      if (!_bridge) return null;
      if (!resolveAnchor(domain, docId, _bridgeHit)) return null;
      const p = _bridge.camera.position;
      return Math.hypot(p.x - _bridgeHit.world[0], p.y - _bridgeHit.world[1], p.z - _bridgeHit.world[2]);
    },
    /**
     * 把某颗星投影成**屏幕像素坐标**（CSS 像素，左上角为原点）。
     *
     * 为什么需要它：要验"**鼠标点一下真的能选中**"就必须点到那颗星画的像素上，
     * 而"哪一颗星在屏幕上哪儿"只有页面自己知道（相机每帧在动、星系每帧在自转）。
     * 让探针在外面重算一遍投影，等于把要验的那段代码抄一遍 —— 抄错了也验不出来。
     * 这里直接用**渲染用的那个相机**投影，保证和画面一致。
     */
    projectAnchor: (domain: string, docId: number) => {
      if (!_bridge) return null;
      if (!resolveAnchor(domain, docId, _bridgeHit)) return null;
      const v = _anchorV.set(_bridgeHit.world[0], _bridgeHit.world[1], _bridgeHit.world[2]).project(_bridge.camera);
      const el = _bridge.renderer.domElement;
      return {
        x: (v.x * 0.5 + 0.5) * el.clientWidth,
        y: (-v.y * 0.5 + 0.5) * el.clientHeight,
        w: el.clientWidth,
        h: el.clientHeight,
        ndcZ: v.z,
        inFront: v.z < 1,
      };
    },
    /**
     * **GPU 拾取的直接探针**（调试/自检用，与真实点击走同一个 `gpuPick`）。
     *
     * 为什么另开一个口：`projectAnchor` 能给出"某颗星画在哪"，但"用屏幕坐标去点，
     * 到底点回了哪颗星"必须由**拾取器自己**回答 —— 否则自检等于把投影再抄一遍，
     * 抄错了也验不出来。这个口让探针可以做"投影 → 拾取 → 比对 docId"的闭环。
     *
     * `clientX/clientY` 用浏览器视口坐标（和 PointerEvent 一致）；
     * `radiusCss` 缺省 14 CSS 像素（与 StarPicker 的容差同源）。
     */
    pickAt: (clientX: number, clientY: number, radiusCss?: number) =>
      pickAtScreen(clientX, clientY, radiusCss),
    /** 最近一次拾取的耗时（ms）与命中结果 —— 性能验收读它 */
    pickStats: () => pickAtScreenStats(),
    /** 拾取窗口原始 id 网格（0 = 黑）—— 排查"这个像素为什么不是那颗星"用 */
    pickWindow: (clientX: number, clientY: number, radiusCss?: number) =>
      pickWindowAtScreen(clientX, clientY, radiusCss),
    /**
     * 某颗星**此刻是否真的画在屏幕上**（即是否可拾取）。
     *
     * 为什么拾取自检需要它：探针要验"投影到屏幕 → 点下去 → 点回同一颗"，
     * 但默认 `星：精选` 模式下大量 `aTier=0` 的星**根本没画**；拿它们当基准
     * 会把"拾取正确"误判成"点到了旁边那颗"。这里直接把门控的三个输入暴露出来
     * （`aTier` / `aSize` / `uTopOnly`），探针据此**只挑可见的星**做闭环。
     */
    starVisible: (domain: string, docId: number) => {
      if (!_bridge) return null;
      let out: { tier: number; size: number; topOnly: number; visible: boolean } | null = null;
      _bridge.scene.traverse((o) => {
        if (out || o.userData?.layer !== "stars" || o.userData?.domain !== domain) return;
        const obj = o as THREE.Points;
        const ids = o.userData.docIds as Uint32Array | undefined;
        const geo = obj.geometry;
        if (!ids || !geo) return;
        const tier = geo.getAttribute("aTier");
        const size = geo.getAttribute("aSize");
        if (!tier || !size) return;
        const n = Math.min(tier.count, ids.length);
        for (let i = 0; i < n; i++) {
          if (ids[i] !== docId) continue;
          const mat = (Array.isArray(obj.material) ? obj.material[0] : obj.material) as
            | THREE.ShaderMaterial
            | undefined;
          const t = (tier.array as Float32Array)[i];
          const s = (size.array as Float32Array)[i];
          const topOnly = (mat?.uniforms?.uTopOnly?.value as number | undefined) ?? 0;
          let vis = obj.visible;
          let p: THREE.Object3D | null = obj;
          while (p) {
            if (!p.visible) vis = false;
            p = p.parent;
          }
          out = { tier: t, size: s, topOnly, visible: vis && s >= 0.001 && !(topOnly > 0.5 && t < 0.5) };
          return;
        }
      });
      return out;
    },
    /**
     * 某学科**当前可见**的星抽样（`stride` 步长取点，最多 `max` 颗）。
     *
     * 用途同上：给拾取闭环选基准星。逐颗问 `starVisible` 是 O(点数) × 候选数，
     * 305 万点时会把探针自己变成瓶颈 —— 这里只扫一遍几何体，按步长抽样。
     */
    visibleSample: (domain: string, stride = 997, max = 60) => {
      if (!_bridge) return null;
      let out: number[] | null = null;
      _bridge.scene.traverse((o) => {
        if (out || o.userData?.layer !== "stars" || o.userData?.domain !== domain) return;
        const obj = o as THREE.Points;
        const ids = o.userData.docIds as Uint32Array | undefined;
        const geo = obj.geometry;
        if (!ids || !geo) return;
        const tier = geo.getAttribute("aTier");
        const size = geo.getAttribute("aSize");
        if (!tier || !size) return;
        const mat = (Array.isArray(obj.material) ? obj.material[0] : obj.material) as
          | THREE.ShaderMaterial
          | undefined;
        const topOnly = (mat?.uniforms?.uTopOnly?.value as number | undefined) ?? 0;
        let vis = obj.visible;
        let p: THREE.Object3D | null = obj;
        while (p) {
          if (!p.visible) vis = false;
          p = p.parent;
        }
        const n = Math.min(tier.count, ids.length);
        const ts = tier.array as Float32Array;
        const zs = size.array as Float32Array;
        const acc: number[] = [];
        const step = Math.max(1, Math.floor(stride));
        for (let i = 0; i < n && acc.length < max; i += step) {
          if (zs[i] < 0.001) continue;
          if (topOnly > 0.5 && ts[i] < 0.5) continue;
          acc.push(ids[i]);
        }
        out = vis ? acc : [];
      });
      return out;
    },
    /**
     * 共享自转角（弧度）。
     *
     * 为什么要暴露它：自转是**每帧命令式**改 `rotation.y` 的，
     * 截图上看不出"转没转"（0.012 rad/s 在两三秒里只有两三度），
     * 而"以为在转其实没挂上时钟"是一个不会报错的错误。
     * 有了这个口，自检可以隔一秒读两次、断言它确实前进了。
     */
    spinAngle: () => galaxySpin.angle,
    /**
     * **自转的完整读数**（诊断用）：时钟上的两个角 + 每一组图层的**真实** `rotation.y`。
     *
     * ## 为什么不能只报时钟
     *
     * `spinAngle()` 报的是 `galaxySpin.angle` —— 那是**时钟**，不是画面。
     * "时钟在走"与"图层真的按这个角转了"是两件事，中间隔着
     * `SpinGroup` 的 `useFrame` 接线、`kind` 的分派、以及 reducedMotion 的分支。
     * 而且自转有两条**不报错**的坏法：
     *
     *   · **刚性破了**：某一层读到的角与别的层不一致 —— 画面上只是"有点不对"，
     *     但拾取会与画面错开（点到的星不是看到的那颗），那种错极难查；
     *   · **差速没了**：星云与论文同速，整片星海像一个刚体风车（诗云专门避免这件事）。
     *
     * 两者都只能靠**逐组读回真实角度**分辨。所以这里把每一组的 `kind` 与 `rotation.y`
     * 一起报出来：调用方可以断言"所有 main 组同角"与"decor / main ≈ 0.019/0.012"。
     */
    spinReport: () => {
      if (!_bridge) return null;
      const groups: { kind: string; rotY: number }[] = [];
      _bridge.scene.traverse((o) => {
        const kind = (o.userData as { spin?: string } | undefined)?.spin;
        if (kind) groups.push({ kind, rotY: o.rotation.y });
      });
      return { angle: galaxySpin.angle, decorAngle: galaxySpin.decorAngle, groups };
    },
    /**
     * 按**图层名**开关可见性（stars / nebula / halo / dome），返回改动的对象数。
     *
     * 为什么需要它：排查"选中之后核心那团白光把关系线吞掉"时，必须**逐层关掉再量** ——
     * 我前两轮靠推断（先怪星点、再怪星云）**都错了**，而每一层的贡献其实可以直接量出来。
     * 这是一项正式的诊断能力，不是临时补丁：以后任何"某个效果看不见 / 太亮"的问题都用得上。
     *
     * 不控制 filaments：那一层的可见性由生命周期状态机每帧驱动，
     * 外部强行改会被下一帧覆盖 —— 那会让人以为"开关坏了"。
     */
    setLayer: (name: string, visible: boolean) => {
      if (!_bridge) return 0;
      let n = 0;
      _bridge.scene.traverse((o) => {
        if (o.userData?.layer === name) {
          o.visible = visible;
          n++;
        }
      });
      return n;
    },
    /**
     * **背景层开关的端口**（HUD 开关、`B` 键、自检脚本走的都是这一条通路）。
     *
     * ## 为什么自检要读这么多字段
     *
     * "点了隐藏，画面上少了东西"有三种不同的坏法，只数像素分辨不出来：
     *   · 开关**没接上**（`visible` 根本没改）—— 像素一点不变；
     *   · 只关掉了一半（比如将来有人把某一层挪到 `<group>` 外面）—— 像素少了一部分；
     *   · **关多了**（把八团自己的星云也关掉了）—— 像素少得更多，但看起来"效果很好"。
     *
     * 所以要同时报：仓库里的状态（`hidden`）、那个组的真实 `visible`（`groupVisible`）、
     * 组里到底有几个子对象（`children`）、以及**八团是否还在**（调用方另用 `sceneInfo` 查）。
     */
    background: () => {
      const st = useCloud.getState();
      let groups = 0;
      let groupVisible: boolean | null = null;
      const children: string[] = [];
      _bridge?.scene.traverse((o) => {
        if (o.userData?.layer !== "background") return;
        groups++;
        groupVisible = o.visible;
        for (const c of o.children) children.push(`${c.type}:${c.visible ? "on" : "off"}`);
      });
      return { hidden: st.hideBackground, groups, groupVisible, children };
    },
    /** 设置背景层是否隐藏（走 store ⇒ HUD 的按钮文案会跟着变，不会出现"两处状态不一致"） */
    setBackgroundHidden: (v: boolean) => {
      useCloud.getState().setBackgroundHidden(v);
      return useCloud.getState().hideBackground;
    },
    /**
     * 相机内部状态（自由飞行 / 锁定 / 引力协转）。
     *
     * 为什么必须开这个口："引力协转生效了吗"看截图看不出来 —— 协转成功与"自转压根没跑"
     * 在画面上完全一样（星都不动）。要分辨只能读内部量：这一帧转了 Δ 多少、相机在谁的引力范围里。
     */
    fly: () => ({
      lastDA: flyDebug.lastDA,
      gripping: flyDebug.gripping,
      speed: flyDebug.speed,
      locked: flyDebug.locked,
      lockDist: flyDebug.lockDist,
      bodies: flyDebug.bodies.map((b) => ({
        id: b.id,
        center: b.center.toArray(),
        axis: b.axis.toArray(),
        gravityR: b.gravityR,
      })),
    }),
    /**
     * 读回某一层的对象构成（**诊断用**）：顶点数、材质参数、以及**它自己与所有祖先的可见性**。
     *
     * ## 为什么必须连祖先的可见性一起看
     *
     * 天穹（dome）这一层出过一个典型症状：`setLayer("dome", false)` 之后三个指标
     * **一位小数都没变**，把别的层全关掉只留它、也还是一样 —— 于是"它没画出来"成立，
     * 但**为什么**没画出来分不出来。可能的原因至少四条：尺寸太小、`alphaTest` 把软贴图裁光、
     * 贴图没生效、或者**某个祖先被关掉了**（`o.visible = true` 只管自己，父级不可见时照样不画）。
     * 只看 `o.visible` 会把最后一条整个漏掉，所以这里把祖先链一起报出来。
     *
     * 与 `setWashOpacity` 同一条理由：靠"改一次、重新构建、再拍一张"来定位，
     * 一轮就是几十秒，而且每次都是新页面（噪声不可比）。开一个只读口，
     * 就能在**同一个页面、同一个机位**上把候选原因逐个排掉。
     */
    layerInfo: (name: string) => {
      if (!_bridge) return null;
      const out: {
        type: string;
        visible: boolean;
        ancestors: string[];
        verts: number | null;
        material: Record<string, unknown> | null;
      }[] = [];
      _bridge.scene.traverse((o) => {
        if (o.userData?.layer !== name) return;
        const ancestors: string[] = [];
        let p = o.parent;
        while (p) {
          ancestors.push(`${p.type}:${p.visible ? "visible" : "HIDDEN"}`);
          p = p.parent;
        }
        const g = (o as THREE.Points).geometry;
        const m = (o as THREE.Points).material as THREE.Material | undefined;
        const rec: Record<string, unknown> | null = m
          ? {
              type: m.type,
              // 只挑这一类问题会用到的字段：进了 GPU 的尺寸/裁剪/混合/贴图
              size: (m as THREE.PointsMaterial).size,
              sizeAttenuation: (m as THREE.PointsMaterial).sizeAttenuation,
              opacity: (m as THREE.Material).opacity,
              transparent: (m as THREE.Material).transparent,
              alphaTest: (m as THREE.Material).alphaTest,
              depthTest: (m as THREE.Material).depthTest,
              depthWrite: (m as THREE.Material).depthWrite,
              blending: (m as THREE.Material).blending,
              visible: (m as THREE.Material).visible,
              hasMap: !!(m as THREE.PointsMaterial).map,
              mapW: (m as THREE.PointsMaterial).map?.image?.width ?? null,
              vertexColors: (m as THREE.PointsMaterial).vertexColors,
            }
          : null;
        out.push({
          type: o.type,
          visible: o.visible,
          ancestors,
          verts: g?.getAttribute("position")?.count ?? null,
          material: rec,
        });
      });
      return out;
    },
    /**
     * 改某一层材质的任意一个属性（**诊断用**：排"到底哪个旋钮能让它出现"）。
     *
     * ⚠️ 这是只读世界的一个例外口子，所以限定为**材质标量属性**；
     *    数组/对象（颜色、贴图）不在这里改，免得把诊断口变成第二个配置源。
     */
    setLayerProp: (layer: string, prop: string, value: number | boolean) => {
      if (!_bridge) return 0;
      let n = 0;
      _bridge.scene.traverse((o) => {
        if (o.userData?.layer !== layer) return;
        const m = (o as THREE.Points).material as unknown as Record<string, unknown> | undefined;
        if (!m) return;
        m[prop] = value;
        (m as unknown as THREE.Material).needsUpdate = true;
        n++;
      });
      return n;
    },
    /**
     * 改某一层材质 uniform 的浮点值（**诊断用**：扫旋钮用）。返回命中的材质数。
     *
     * ## 为什么需要它（而不是"改常量、重新构建、再拍一张"）
     *
     * 这一轮的题目是"整屏太亮、没有黑场，要对齐参考实现飞出星系那一帧"。
     * 亮度由**好几层叠出来**（常驻关系线、星云、虚空尘埃、核心柔光），
     * 每层各有一个自己的旋钮，而且它们不是线性叠加的（都是加法混合、会互相饱和）。
     * 靠"改一个常量、跑一次构建 + 一次自检（约 5 分钟）"来扫二维参数，
     * 扫 4×4 就是 80 分钟，且每次都是新页面 —— 噪声不可比，扫出来的最优值不可信。
     *
     * 开这个口之后，**同一个页面、同一个机位**上部扫完，读数才可比。
     *
     * ⚠️ 只对**不是每帧被覆写**的 uniform 有效：`nebula.uDim` 由选中态每帧写，
     *    外部改它会被下一帧盖掉（那会让人以为"这个旋钮没反应"）。
     *    每帧被写的量在各自的组件里改，不要从这里改。
     */
    setUniform: (layer: string, name: string, value: number) => {
      if (!_bridge) return 0;
      let n = 0;
      _bridge.scene.traverse((o) => {
        if (o.userData?.layer !== layer) return;
        const m = (o as THREE.Points).material as THREE.ShaderMaterial | undefined;
        if (m?.uniforms?.[name]) {
          m.uniforms[name].value = value;
          n++;
        }
      });
      return n;
    },
    /** 读回某一层某个 uniform 的当前值（自检用：确认 setter 真的生效了，而不是静默失败） */
    readUniform: (layer: string, name: string) => {
      if (!_bridge) return null;
      let out: number | null = null;
      _bridge.scene.traverse((o) => {
        if (o.userData?.layer !== layer) return;
        const m = (o as THREE.Points).material as THREE.ShaderMaterial | undefined;
        if (m?.uniforms?.[name]) out = m.uniforms[name].value as number;
      });
      return out;
    },
    /**
     * **渲染器级状态**（诊断用）：色调映射、输出色彩空间、当前 ACES/线性曝光等。
     *
     * ## 为什么必须能读它
     *
     * "画质档来回切一次，画面暗了 18% 的 mean、过曝掉了 3 倍" —— 而几何顶点数、
     * 全部 uniform、store 状态、相机六自由度**逐项相同**（见 `probe-tier-roundtrip.mjs`）。
     * 差异又是**全画面**的（`_scratch/diffimg.mjs`：整块画布都在变，只有 HUD 那几列不变），
     * 而不是某一层。
     *
     * "全画面 + 压高光"正是**色调曲线**的形状：three 的 `toneMapping`（R3F 默认
     * `ACESFilmicToneMapping`）就是这种算子，而 `@react-three/postprocessing`
     * 接管渲染时会把它换成 `NoToneMapping`（后期自己做）。所以这个口要先开出来，
     * 才能判断"到底是场景变了还是显影变了" —— 否则只能一直猜。
     */
    rendererInfo: () => {
      if (!_bridge) return null;
      const gl = _bridge.renderer as THREE.WebGLRenderer | undefined;
      if (!gl) return null;
      return {
        toneMapping: gl.toneMapping,
        toneMappingExposure: gl.toneMappingExposure,
        outputColorSpace: gl.outputColorSpace,
        autoClear: gl.autoClear,
        infoRender: { calls: gl.info.render.calls, triangles: gl.info.render.triangles },
        infoMemory: { geometries: gl.info.memory.geometries, textures: gl.info.memory.textures },
      };
    },
    /** 把相机放到指定的世界坐标（**诊断用**：要确定性地"在星团内部"测量，靠 WASD 飞不准也飞不快） */
    placeCamera: (x: number, y: number, z: number) => flyDebug.place(x, y, z),
    /**
     * 改底光（VoidGlow）的不透明度 —— **诊断用**，让"底光该多亮"这件事能一次扫完。
     *
     * ## 为什么要开这个口
     *
     * 底光是"平均亮度 / 局部对比度"这两个指标的主旋钮，而它们是一对**互相拉扯**的目标
     * （诗云的数字特征是"亮而平滑"：mean 111 / 对比度 0.43）。
     * 靠"改一次、重新构建、再拍一张"来调，一轮 50 秒，扫四个值要三分半，
     * 而且每次都是新开的页面（噪声不可比）。开一个 setter，就能在**同一个页面、同一个机位**
     * 上把四个值连拍下来 —— 这才叫扫参数。
     */
    setWashOpacity: (v: number) => {
      if (!_bridge) return null;
      let found: number | null = null;
      _bridge.scene.traverse((o) => {
        if (o.userData?.layer !== "wash") return;
        const m = (o as THREE.Sprite).material as THREE.SpriteMaterial;
        if (m) {
          m.opacity = v;
          found = v;
        }
      });
      return found;
    },
    /** 读回当前底光不透明度（自检用：确认 setter 真的生效了） */
    washOpacity: () => {
      if (!_bridge) return null;
      let out: number | null = null;
      _bridge.scene.traverse((o) => {
        if (o.userData?.layer !== "wash") return;
        const m = (o as THREE.Sprite).material as THREE.SpriteMaterial;
        if (m) out = m.opacity;
      });
      return out;
    },
    /**
     * 找一颗**真的有关系边、而且当前在点集里**的论文。
     *
     * 为什么要开这个口：关系线的自检必须选一颗"能画出线"的星 ——
     * 而演示点集里**约 4% 的论文没有任何边**（`build-edges.mjs` 的记录：
     * physics 28,188/29,272 个起点有边）。随便挑一颗去测，有 4% 的概率量到"一条线都没有"，
     * 然后得出"线层坏了"这个**完全错误**的结论 —— 这个坑这一轮真踩了。
     * 有了这个口，自检选星就从"碰运气"变成"确定性的"。
     */
    sampleSourceWithEdges: (domain: string) => {
      const rt = useCloud.getState().runtime[domain];
      const pts = rt?.points ?? rt?.demoPoints;
      const e = rt?.filamentEdges;
      if (!pts || !e) return null;
      /**
       * 取**边最多**的那个起点，而不是第一个有边的起点。
       *
       * ⚠️ 第一版返回的是"第一个有边的"，实测拿到 docId=0 —— 它只有 **1 条边**，
       *    画出来是孤零零一根线，既不能代表"关系扇形"的观感，也测不出脉冲沿线的变化。
       *    "有边"与"边多"是两个条件，自检要的是后者。
       */
      let bestDoc = -1;
      let bestN = 0;
      for (let i = 0; i < e.srcDocId.length; i++) {
        const start = e.srcOffset[i];
        const end = i + 1 < e.srcDocId.length ? e.srcOffset[i + 1] : e.count;
        const n = end - start;
        if (n <= bestN) continue;
        if (docIndex(pts.docIds, e.srcDocId[i]) < 0) continue;
        bestN = n;
        bestDoc = e.srcDocId[i];
      }
      return bestDoc >= 0 ? bestDoc : null;
    },
    sceneInfo: () => {      if (!_bridge) return null;
      let points = 0;
      let groups = 0;
      /**
       * 线对象与它们的顶点数、可见性。
       *
       * 为什么要连 `visible` 一起报：排查"丝线没画出来"时，
       * **"根本没建出来"和"建出来了但被关掉/画到画外"是两条完全不同的线索**，
       * 而只数顶点数是分不出来的（两种情况都可能给出 0 或者非 0）。
       */
      let lines = 0;
      let lineVerts = 0;
      let linesVisible = 0;
      _bridge.scene.traverse((o) => {
        const pts = o as THREE.Points;
        if (pts.isPoints && pts.geometry) points += pts.geometry.getAttribute("position")?.count ?? 0;
        const ls = o as THREE.LineSegments;
        if (ls.isLineSegments && ls.geometry) {
          lines++;
          lineVerts += ls.geometry.getAttribute("position")?.count ?? 0;
          if (ls.visible) linesVisible++;
        }
        if ((o as THREE.Group).isGroup) groups++;
      });
      return { points, groups, lines, linesVisible, lineVerts };
    },
  };
}

export function Galaxy() {
  const quality = useCloud((s) => s.quality);


  useEffect(() => {
    installDebugBridge();
  }, []);

  return (
    <>
      <HoverTip />
      <Canvas
      className="canvas-layer"
      /**
       * ⚠️ **`[1, 2]` → `[1, 1.5]`**：这是"卡的不行"的第二号原因。
       *
       * `dpr` 直接乘进片元数量（2 倍像素比 = **4 倍**片元）。Retina / 高分屏上
       * `[1,2]` 意味着画面按 2× 渲染，再叠加 305 万点的加法混合与 bloom ——
       * 相当于凭空多花三倍力气换一点点锐度。1.5 倍在观感上几乎看不出差别，
       * 但片元数只有原来的 56%。
       */
      dpr={quality === "high" ? [1, 1.5] : 1}
      /**
       * `antialias: false`：这一层画的全是**点精灵 + 加法混合**，
       * MSAA 对软边圆点几乎不改善（边缘已经是渐变），却要在每个片元上多采几次样。
       * 锐度交给星点本身的核心（`STAR_FRAG`），不交给 MSAA。
       */
      gl={{ antialias: false, logarithmicDepthBuffer: true, powerPreference: "high-performance" }}
      camera={{ fov: 52, near: 0.05, far: 24000, position: [-3.2, 11.2, 28.8] }}
      /* ⚠️ 原来这里挂 onPointerMissed={clearSelection}。摘掉星点上的指针事件之后，
         R3F 在任何位置都"没打中任何对象"，于是每次点击都会触发它 ——
         刚由 StarPicker 选中的论文会被立刻清掉（表现：点了没反应）。
         现在"点空 = 取消选择"由 StarPicker 统一负责（pick 返回 null 时清）。 */
    >
      {/*
        ⚠️ 默认机位 2026-10 调过：`[-4, 17, 44]` → `[-3, 12, 30]`（距原点 47.3 → 32.3）。
        原因不是"好不好看"，是量出来的：原机位下 `__three.probeGL().nonBgPct` 只有 **5.5%**
        —— **94.5% 的像素是纯黑**，8 个星团只占视口中间一小块。
        "不如参考实现震撼"的第一位原因就是这个，不是缺 bloom、也不是点数不够
        （试过把雾点加 7 倍：覆盖率只从 5.5 涨到 6.1，过曝却涨 12 倍 —— 加错了地方）。
        推近 1.46 倍后星团视面积约 ×2.1。用户自己可以拉远（自由飞行下靠 WASD 飞远，
        或滚轮提速后飞出去；锁定时滚轮改轨道距离，上限 400 —— 见 `FlyCamera.tsx`）。
      */}
      <color attach="background" args={["#04050a"]} />
      <Scene />
      <DebugBridge />
      {/*
        HDR 辉光后期。
        ⚠️ 2026-10 新加 —— 此前 `@react-three/postprocessing` **在 package.json 里声明了、
        node_modules 里也装了，但 src 里一次都没 import 过**；当时的"核心柔光"是
        `softGlowTexture()` 画的一颗大贴图（见上面 ④ 的注释，原文就写着"模拟 bloom"）。
        真 bloom 与它不是一个量级：它把**离散的亮点**变成连续的辉光，
        这是"像真实星系"最要紧的一条线索（参考实现的原话）。
        参数按参考实现量出来的量级取：低阈值 + 宽半径 + mipmapBlur（便宜的宽模糊）。
      */}
      {/*
        ## ⚠️ 这个后期**必须常挂**，开关只能走 `intensity`，不能走 `enabled` / 条件渲染

        ### 现象（`_scratch/probe-tier-roundtrip.mjs`，真机 d3d11，high → low → high）

        ................................................
        ① 开机就是 high   mean 93.4  blown 2.631%  点 554,513  离屏 mean 89.36
        ② 切到 low        mean 22.4  blown 0.131%  点 463,513  离屏 mean 69.76
        ③ 切回 high       mean 75.9  blown 0.793%  点 554,513  离屏 mean 77.92
        ................................................

        ③ 与 ① 的**相机六自由度、全部 uniform、几何顶点数、store 状态、渲染器状态
        （toneMapping / exposure / colorSpace / autoClear）、画布与 viewport 尺寸
        逐项相同**，画面却暗了 17.5 的 mean。
        也就是说：自动降级关掉 bloom 之后，用户点「仍然用高画质」**拿不回辉光**，
        那条出口是假的。

        ### 定位过程（两次改错之后才找对）

        · 先猜"实例脏了" ⇒ 加 `key={quality}` 强制重建：**没用**；
        · 再猜"中途挂载没接管渲染循环" ⇒ 常挂 + `enabled={quality === "high"}`：**没用**；
        · 最后靠**逐层归因**定位（两张状态各关掉每一层量一次）：

        ................................................
        layer      ① Δmean   ③ Δmean    差
        stars        13.4       1.2    +12.2   ← 只有它在 ③ 里丢了光
        nebula       14.0      12.3     +1.7
        field         8.7      11.0     −2.3
        halo          7.2       9.1     −1.9
        voidstars     7.1       8.8     −1.7
        voiddust      3.4       4.1     −0.7
        ................................................

        星的 Δmean 从 13.4 掉到 1.2，而**无 bloom 那一轮量的正是 1.0** ——
        这就把"差的是 bloom"钉死了（星是锐利亮点，没有 bloom 时它只占一点面积；
        有了 bloom 才铺开成大片辉光）。**"全画面一起暗"不等于"某一层出问题"，
        必须逐层量才能分辨。**

        ### 结论与修法

        **把 `enabled` 从 true 切回 true 之后，composer 不再接管渲染循环** ——
        它自己在源码里就是靠 `useFrame(cb, enabled ? renderPriority : 0)`
        用**优先级**接管的，而 `@react-three/fiber` 的优先级是个**计数器**
        （订阅 +1、退订 −1），中途反复加减之后循环就切不回去了。
        条件渲染、`key` 重建、`enabled` 开关**三条路都试过，都不行**。

        所以：**composer 永远 `enabled`，开关交给 `Bloom.intensity`。**
        实测这一版 ① 与 ③ **每一个层的 Δmean 差都是 0.00**（往返干净）。

        ⚠️ 代价写清楚：低画质档**仍然会跑后期那几遍**（`intensity=0` 只是让它的
        贡献为 0，pass 本身还在）。也就是说低画质档省下的是**几何与填充率**
        （点精灵上限 14→7、尘埃 12 万→4.5 万、星野 2.6 万→1 万），不是后期。
        这是**刻意的取舍**：弱机器上省那几毫秒，远不如"点『仍然用高画质』拿不回辉光"
        来得严重。
      */}
      <EffectComposer enabled={true}>
        <Bloom
            /**
             * ⚠️ **2026-10 定档：这是"观感档"，不是"守指标档"。**
             *
             * ⚠️ **`intensity` 就是低画质档的开关**（`quality === "high" ? 1.4 : 0`），
             *    **不要**改成 `{quality === "high" && <EffectComposer>}` 或
             *    `enabled={quality === "high"}` —— 那两条路都会让"切回高画质"永久失效，
             *    理由与实测数字见上面那一大段。`0` 是**真的不贡献**：低画质档
             *    实测 mean 22.4，与"整层不挂 composer"时一致。
             *
             * 定档过程（每一档都实测过，blownPct 为三次中位）：
             *   1.4 / 阈值 0.10 → 有辉光感，但当时被"颜色被洗掉"否掉了
             *   0.7 / 阈值 0.65 → 过曝 ~2.5%（单次采样曾误报 1.25%，见下）
             *   0.7 / 阈值 0.75 → 最省，但**没有辉光感**（就是这一档暴露了指标在挡观感）
             *   1.6 / 阈值 0.40 → 过曝最高的一档，但中心糊成一片白（这档是肉眼否掉的，没留数）
             *   **1.4 / 0.10 / 0.28 / 0.85 / mipmapBlur → 现在这档（→4.17%）**
             *
             * ⚠️ **上面那些百分比是老口径的数，别拿去和现在的数比。**
             *    它们是在 `probeGL()` 的离屏读回里量的，而那个离屏 target 当时**漏了 sRGB 编码**
             *    （默认线性，画布却是 sRGB），所有读数系统性偏暗约 2.5× ——
             *    也就是说"1.35%"这种数在当时看起来守住了线，其实根本没对上过一个真实像素。
             *    修好 `colorSpace: THREE.SRGBColorSpace` 之后，**同一档参数在页面口径下是 4.17%**。
             *    这也解释了为什么"守住 1.5%"那几档观感都不对：它们是真的更暗，不是错觉。
             *    **口径提醒**：离屏 `snapshot`/`probeGL` 不含 bloom、也不含 HUD，
             *    只能用来做相对比较；凡是写进结论的绝对值，一律以整页截图为口径。
             *
             * ⚠️ **最后这四个数就是照诗云抄的**（它的 `App.tsx` 里写死的同一组）。
             *    第 14 轮核对时发现上面那行注释还写着"现在这档 = 1.6 / 阈值 0.40"——
             *    **说明与代码不一致**。注释里描述的观感结论仍然成立，但数字必须跟着代码走，
             *    否则下一个读它的人会按"1.6/0.40"去调，而实际生效的是另一组。
             *
             * **为什么明知超出旧的"过曝率 < 1.5%"还要这么开**：那条指标的初衷是
             * "证明不是靠过曝糊弄"，但它挡住的恰好是作品最要紧的观感 ——
             * 参考实现（诗云）的画面本质就是大面积过曝（中心烧成白核、辉光糊满屏）。
             * 已与作者确认：**取观感、同步改指标** —— 阈值从 1.5% 放到 **5%**
             * （`deploy/verify.mjs` 里的闸门与 `docs/02-参赛方向与规划.md` 里那条一起改了），
             * 当前实测 4.17%，在预算之内，不再"明知超线"。
             * **别把它"修"回低阈值** —— 那等于把这条决定又倒回去。
             *
             * ⚠️ 另外记一笔量法：这个指标有 **±0.3 的噪声**（闪烁动画 + 场景朝向），
             * 单次采样会骗人（我就被 1.247 骗过一次）。要比较就三次取中位，
             * 并用 `_scratch/probe-ours-shot.mjs`（它先声明减少动态效果、再重载，才拿得到稳的数）。
             */
            intensity={quality === "high" ? 1.4 : 0}
            luminanceThreshold={0.1}
            luminanceSmoothing={0.28}
            radius={0.85}
            mipmapBlur
          />
      </EffectComposer>
      </Canvas>
    </>
  );
}
