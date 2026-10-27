/**
 * 论文云 · 自由飞行相机（**照搬诗云的 FlyControls**）
 * ============================================================================
 * 诗云 HUD 上的那行提示就是它的操作模型（`src/ui/HUD.tsx:122`）：
 *
 *     WASD 飞行 · 拖拽转向 · Q/E 滚转 · 滚轮调速 · F 全屏
 *     速度 ×1.00 · 140 单位/秒
 *
 * 而我们原来用的是 `OrbitControls`：拖拽**绕注视点转**、滚轮**缩放**。
 * 两者读起来完全不同 ——
 *   · OrbitControls：永远盯着一个点，像"看一个模型"；进不去场景里面；
 *   · 自由飞行：**转头**环顾、沿视线飞进去，像"在一个宇宙里"。
 * 作者要的是后者（"漫游宇宙"），所以整个模型照搬过来。
 *
 * ## 两套状态，不是一个（这是最容易做错的地方）
 *
 * 诗云把"自由飞行"与"锁定轨道"的**姿态分开存**（`euler` 与 `lock`），一开始我合并成一套，
 * 立刻就出了两个只有实测才看得见的错：
 *
 *   · **解锁那一瞬间镜头整个翻过来**（上下颠倒地看天）——
 *     锁定时相机是**看着**目标（朝向 = 目标方向），自由飞行的 pitch 是**看向**的方向；
 *     两者差一个符号（offset 的 sin(pitch) 与朝向的 sin(pitch) 反号）。
 *     合并成一套之后，按 Esc 回到自由飞行会用**锁定时那个被镜像过的 pitch**，于是镜头朝天看，
 *     画面里一颗星都没有（`nonBgPct` 从 12.65 掉到 **0.06**，量出来才知道）。
 *     诗云的解法是：锁定分支每帧把 `camera.quaternion` **反解回 euler**
 *     （"so free-fly resumes cleanly on release"），而轨道角度单独存在 `lock` 里互不干扰。
 *
 *   · **拖拽绕不过去** —— 锁定时的 yaw 是"相机在目标的哪个方位"，
 *     若同一帧又被"相机朝向"反解覆盖，下一帧算出来的位置就跳。
 *
 * 所以这里严格分成：
 *   · `fly`  —— 自由飞行的 yaw / pitch / roll + 速度倍率；
 *   · `lock` —— 锁定轨道的 key / dist / yaw / pitch。
 * 锁定时**每帧**把相机朝向反解写回 `fly`，于是解锁无缝（含滚转）。
 *
 * ## 速度标定（**不能照抄 140**）
 *
 * 它的 `BASE_SPEED = 140` 是它世界单位下的（星系半径 3600）⇒ 3.9% R/秒。我们的星团半径约 17，
 * 照抄 140 会瞬间飞出场景。这里按"穿过默认视野要多久"标定：默认视距 31、可见宽度约 1.7×31 ≈ 53，
 * 取约 17 秒穿过 ⇒ `FLY_BASE_SPEED = 3.0` 单位/秒。
 *
 * ## 滚轮：两个模式两套语义（数值照抄）
 *
 *   · **自由飞行** ⇒ 改**速度倍率**：×1.22 / ×0.82，范围 0.1–80（诗云 `speedMul`）；
 *   · **锁定一颗星** ⇒ 改**轨道距离**：×1.12 / ×0.89，范围 `ORBIT_MIN`–`3R`（诗云 `orbitZoom`）。
 * 注意这两组数**不是同一组**：速度那组是**对称**的（1.22 = 1/0.82，来回正好抵消），
 * 距离那组不对称（1.12 × 0.89 = 0.9968）。第一版我把距离那组当成速度档抄了，实测对不上。
 *
 * ## 引力协转（**"星星为什么在漂"的根因**）
 *
 * 诗云在自由飞行里有一句关键的：一旦相机进入星系范围（`GRAVITY_R = 1.15 R`），
 * 就让**相机跟着星系一起转**（位置绕星系轴转同样的 Δ、朝向也 += Δ）——
 * 理由是"否则近处的星星漂得比你点得快"（`FlyControls.tsx` 原注）。
 *
 * 这不是花活：我们的星团自转 0.012 rad/s，离相机 20 单位的一颗星每秒横移 0.24 单位，
 * 在 25 单位视距下约 **9 像素/秒** —— 想点它就得追着点。
 * 协转之后论文星在屏幕上**定住**，而星云层用更快的 `DECOR_RATE`（0.019）继续流过去，
 * 于是"星海在动、但你要点的星不动"——这正是诗云那个差速自转想要的效果。
 *
 * ⚠️ 我们的星团各有**位移与倾角**（`DOMAINS[i].center / tilt`），转轴是 `R_tilt · Y`
 * 而不是世界 Y。所以协转的轴与圆心由 `Scene` 按**和渲染同一个表达式**算出来传进来
 * （`bodies`）—— 自己再写一份公式就是第二份真相，迟早会错开。
 */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useCloud } from "../state/cloud.ts";
import { resolveAnchor, emptyAnchorHit } from "./anchor.ts";
import { galaxySpin } from "./galaxySpin.ts";
import { DOMAINS } from "../data/domains.ts";
import { centroid, classifyGesture, orbitZoom, pinchDistance, pinchSpeed, thrustFromDrag } from "./touchGesture.ts";

/** 相机在"自由飞行"模式下的基准速度（世界单位/秒，倍率 ×1 时） */
export const FLY_BASE_SPEED = 3.0;
/** 滚轮每一档的速度倍率 —— 照抄诗云的 `speedMul`（×1.22 加速 / ×0.82 减速，对称） */
export const SPEED_UP = 1.22;
export const SPEED_DOWN = 0.82;
/** 速度倍率的上下限 —— 照抄诗云的 `Math.min(80, Math.max(0.1, ...))` */
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 80;
/** 拖拽灵敏度（弧度 / 像素）—— 照抄诗云的 `0.005`，我们略收一点（视野更窄） */
const LOOK_SENS = 0.0032;
/** 滚转速度（弧度/秒）—— 诗云 `ROLL_RATE = 1.2` */
const ROLL_RATE = 1.2;
/** 俯仰上限（略小于 90°，避免万向节翻转）—— 诗云自由飞用 π/2−0.02，轨道用 ±1.4 */
const PITCH_LIMIT = Math.PI / 2 - 0.02;
const ORBIT_PITCH_LIMIT = 1.4;
/** 选中一颗星之后，镜头停在离它多远的地方（世界单位）—— 对应诗云的 `dist = 130`（赠诗） */
const LOCK_DIST = 18;
/** 锁定时滚轮调距离的倍率 —— 照抄诗云的 `orbitZoom`（×1.12 拉远 / ×0.89 拉近） */
const ORBIT_ZOOM_UP = 1.12;
const ORBIT_ZOOM_DOWN = 0.89;
/**
 * 轨道距离的上下限：下限 1.5（原 `OrbitControls.minDistance`，已验证过"贴到星团内部不穿模"），
 * 上限照抄诗云的 `ORBIT_MAX_GALAXY = 3R`（它是"整团刚好都在画面里"的那个距离）。
 * ⚠️ 不写死数字，从 `DOMAINS` 算 —— 布局改了这里要跟着走（`RADIUS_BOOST` 已经改过一次）。
 */
const ORBIT_MIN = 1.5;
const ORBIT_MAX = Math.round(Math.max(...DOMAINS.map((d) => d.radius)) * 3);
/** 进入"引力"范围的球半径系数 —— 诗云 `GRAVITY_R = GALAXY.RADIUS * 1.15` */
export const GRAVITY_K = 1.15;
/** 帧率无关阻尼的时间常数 —— 照抄诗云：k = 1 - 0.0025^dt（τ≈0.167s） */
const damp = (dt: number) => 1 - Math.pow(0.0025, dt);
/** 飞向一个目标（聚焦星团）的阻尼更缓 —— 诗云 `flyTarget` 用 0.0015（τ≈0.145s… 更"重"） */
const dampFly = (dt: number) => 1 - Math.pow(0.0015, dt);
/**
 * 位移的 dt 封顶 —— 照抄诗云 `Math.min(dt, 0.05)`。
 * 不封顶的话切后台再回来会"一次按键飞出银河系"。
 */
const MOVE_DT = 0.05;
/**
 * 拖拽超过这个像素数才算"转了头"（不是点击）—— 诗云鼠标 6px / 触屏 14px，这里取 4。
 */
export const DRAG_SLOP = 4;

/**
 * 当前这一次指针拖拽的累计位移（像素），供拾取使用。
 *
 * ## 为什么必须有它
 *
 * 自由飞行里**拖拽 = 转头**，而星点的拾取挂在 pointerdown 上 ——
 * 于是"拖一下看看周围"会**顺带选中一颗星**：用户只是想转个头，却被弹出一个论文面板。
 *
 * 诗云的判定是 slop（它的 FlyControls 里：按下记位置，**抬起时**位移小于阈值才算点击）。
 * 这里照同一套做法：拾取改成"按下时记住候选、抬起时看位移决定要不要真的选中"。
 */
export const pointerDrag = { moved: 0, active: false };

/** 一个"带自转的天体"：相机进入它的引力球就跟着它一起转（见文件头的"引力协转"）。
 *
 * 用 `THREE.Vector3` 而不是元组：这里每帧都要拿它做向量运算，
 * 传元组就得每帧转一次（或者像第一次那样写出 `sub(tuple)` 直接类型报错）。
 */
export interface SpinBody {
  center: THREE.Vector3;
  /** 世界坐标下的自转轴（单位向量） */
  axis: THREE.Vector3;
  /** 引力球半径 */
  gravityR: number;
  /** 这一团的 id（只为诊断可读：自检要能说"相机现在在 cs 的引力范围里"） */
  id: string;
}

/**
 * 相机的**只读诊断出口**（自检用）。
 *
 * ## 为什么需要它
 *
 * "引力协转生效了吗"这个问题**看截图看不出来** —— 协转成功与"自转没跑"画面上完全一样
 * （都是星不动）。而这两种情况的差别决定了点击准不准。
 * 所以必须能把内部状态读出来：这一帧星系转了多少（`lastDA`）、相机在谁的引力范围里（`gripping`）、
 * 引力球的实际圆心与半径（`bodies`）。
 *
 * `place()` 是这个出口里**唯一**会写状态的方法，存在的理由同样是可测性：
 * "相机在星团内部时星星定不定得住"必须能**确定性地**把相机放进星团里，
 * 靠 WASD 飞进去要几十秒、还不一定飞得准。
 */
export const flyDebug = {
  bodies: [] as readonly SpinBody[],
  gripping: "",
  lastDA: 0,
  speed: 1,
  locked: false,
  lockDist: 0,
  place: (_x: number, _y: number, _z: number) => {},
};

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _move = new THREE.Vector3();
const _dest = new THREE.Vector3();
const _off = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _hit = emptyAnchorHit();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _m = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
/** lookAt 的"上"必须传世界 Y 的副本，不能让 lookAt 直接读会被改写的向量 */
const _worldUp = new THREE.Vector3(0, 1, 0);

export function FlyCamera({ bodies }: { bodies: readonly SpinBody[] }) {
  const { camera, gl } = useThree();
  const selection = useCloud((s) => s.selection);
  const clearSelection = useCloud((s) => s.clearSelection);
  const focus = useCloud((s) => s.focusTarget);
  const setFlySpeed = useCloud((s) => s.setFlySpeed);

  /** 自由飞行的姿态与速度倍率（`roll` 是**持有的**滚转角，锁定时也不被覆盖） */
  const fly = useRef({ yaw: 0, pitch: 0, roll: 0, speed: 1 });
  /**
   * 锁定轨道：目标 key + 距离 + 环绕角。
   *
   * ⚠️ 这里存的是"**相机在目标的哪个方位**"（球坐标），与 `fly.yaw/pitch`（相机**看向**哪）
   * 是两个不同的量 —— 见文件头"两套状态"那段。`key` 变了就重新取景（照诗云）。
   */
  const lock = useRef({ key: "", dist: LOCK_DIST, yaw: 0, pitch: 0.32 });
  /** 键盘按住状态 */
  const keys = useRef<Set<string>>(new Set());
  /** 拖拽状态 */
  const drag = useRef({ active: false, id: -1, x: 0, y: 0, moved: 0 });
  /**
   * 当前按在画布上的所有指针（触屏最多同时两根）。
   *
   * 为什么需要一张表而不是"一个拖拽状态"：双指手势要同时知道**两根手指**的坐标
   * （算重心与指距），单指状态装不下。鼠标只有一根指针，走的是同一条路径，所以
   * 桌面端的"拖拽 = 转头"不受影响。
   */
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  /** 双指手势状态（起点重心 / 起始指距 / 上一次指距 / 锁定的模式） */
  const gesture = useRef<{ ox: number; oy: number; startDist: number; prevDist: number; mode: "pan" | "pinch" | null } | null>(null);
  /** 双指推进量（模拟摇杆：按住不放就一直飞），松手归零 */
  const thrust = useRef({ forward: 0, right: 0 });
  /** 上一帧的共享自转角（用来算"这一帧星系转了多少"，见引力协转） */
  const lastAngle = useRef(galaxySpin.angle);
  /** 焦点滑行：目的地 + **看向的目标点** + 开始时间（双击图例 → 飞过去） */
  const flight = useRef<{ pos: THREE.Vector3; look: THREE.Vector3; at: number } | null>(null);
  /** 从"当前朝向"初始化一次（避免开场时相机姿态与 yaw/pitch 不一致） */
  const inited = useRef(false);

  // ---- 初始化：把 yaw/pitch 从相机当前朝向反解出来
  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    _euler.setFromQuaternion(camera.quaternion, "YXZ");
    fly.current.yaw = _euler.y;
    fly.current.pitch = _euler.x;
    fly.current.roll = 0;
  }, [camera]);

  // ---- 诊断出口：把当前生效的天体表与"位移入口"挂上去（见 `flyDebug` 的说明）
  useEffect(() => {
    flyDebug.bodies = bodies;
    flyDebug.place = (x, y, z) => camera.position.set(x, y, z);
  }, [bodies, camera]);

  /** 姿态 → 相机四元数（YXZ 顺序 + 绕视线的滚转） */
  const applyPose = () => {
    const f = fly.current;
    _euler.set(f.pitch, f.yaw, f.roll, "YXZ");
    camera.quaternion.setFromEuler(_euler);
  };

  // ---- 输入：拖拽转向 / 滚轮调速 / 键盘
  useEffect(() => {
    const el = gl.domElement;
    const locked = () => useCloud.getState().selection?.kind === "paper";
    const onDown = (e: PointerEvent) => {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      /**
       * 两根手指 ⇒ 进入**手势模式**（不是"转头"）。
       *
       * 为什么要在这里就把单指拖拽停掉：双指手势期间如果单指拖拽还在跑，
       * 手指的每一次移动都会同时转一次头 —— 用户想做的是"放大"，看到的是"镜头乱晃"。
       */
      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const c = centroid(a, b);
        const d = pinchDistance(a, b);
        gesture.current = { ox: c.x, oy: c.y, startDist: d, prevDist: d, mode: null };
        drag.current.active = false;
        pointerDrag.active = false;
        return;
      }
      if (drag.current.active) return;
      drag.current = { active: true, id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
      pointerDrag.moved = 0;
      pointerDrag.active = true;
    };
    const onMove = (e: PointerEvent) => {
      const p = pointers.current.get(e.pointerId);
      if (p) {
        p.x = e.clientX;
        p.y = e.clientY;
      }
      // ---- 双指手势
      const g = gesture.current;
      if (g && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const c = centroid(a, b);
        const d = pinchDistance(a, b);
        // 先分类（阈值之内不表态），再按锁定的那一种一直做到底
        if (!g.mode) g.mode = classifyGesture({ x: g.ox, y: g.oy }, c, g.startDist, d);
        if (g.mode === "pinch") {
          const f = fly.current;
          if (locked()) {
            const lk = lock.current;
            lk.dist = orbitZoom(lk.dist, g.prevDist, d, ORBIT_MIN, ORBIT_MAX);
          } else {
            f.speed = pinchSpeed(f.speed, g.prevDist, d, SPEED_MIN, SPEED_MAX);
            setFlySpeed(f.speed);
          }
        } else if (g.mode === "pan") {
          // 摇杆式推进：重心相对**手势起点**的位移，按住不放就一直飞
          thrust.current = thrustFromDrag({ x: g.ox, y: g.oy }, c);
        }
        g.prevDist = d;
        return;
      }
      // ---- 单指拖拽（鼠标也走这里）
      const d0 = drag.current;
      if (!d0.active || e.pointerId !== d0.id) return;
      const dx = e.clientX - d0.x;
      const dy = e.clientY - d0.y;
      d0.x = e.clientX;
      d0.y = e.clientY;
      d0.moved += Math.abs(dx) + Math.abs(dy);
      pointerDrag.moved = d0.moved;
      if (locked()) {
        /**
         * 锁定 ⇒ 拖拽**绕目标转**：改的是"相机在目标的哪个方位"（球坐标），
         * 不是相机的朝向 —— 相机每帧仍然 `lookAt` 目标。照诗云的 `lock.current.yaw/pitch`。
         */
        const lk = lock.current;
        lk.yaw -= dx * LOOK_SENS;
        lk.pitch = Math.max(-ORBIT_PITCH_LIMIT, Math.min(ORBIT_PITCH_LIMIT, lk.pitch - dy * LOOK_SENS));
      } else {
        // 自由飞行 ⇒ 拖拽**转头**
        const f = fly.current;
        f.yaw -= dx * LOOK_SENS;
        f.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, f.pitch - dy * LOOK_SENS));
        applyPose();
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) {
        gesture.current = null;
        thrust.current = { forward: 0, right: 0 };
        /**
         * 从两指变回一指时**重新锚定**单指拖拽的起点。
         *
         * 不重锚的话：抬起一根手指之后，第一帧的 `dx` 会是"剩下那根手指到上一次记录位置"的差 ——
         * 那是手势期间累积的一大段位移，镜头会**猛地转过去**。
         */
        const rest = [...pointers.current.entries()][0];
        if (rest) {
          drag.current = { active: true, id: rest[0], x: rest[1].x, y: rest[1].y, moved: pointerDrag.moved };
        }
      }
      if (e.pointerId === drag.current.id) {
        drag.current.active = false;
        pointerDrag.active = false;
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = fly.current;
      if (locked()) {
        // 锁定 ⇒ 滚轮改**轨道距离**（照诗云的 ×1.12 / ×0.89 与上下限）
        const lk = lock.current;
        lk.dist = Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, lk.dist * (e.deltaY > 0 ? ORBIT_ZOOM_UP : ORBIT_ZOOM_DOWN)));
      } else {
        // 自由飞行 ⇒ 滚轮改**速度倍率**（照抄诗云的 ×1.22 / ×0.82，上下限 0.1–80）
        f.speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, f.speed * (e.deltaY > 0 ? SPEED_DOWN : SPEED_UP)));
        setFlySpeed(f.speed);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.code === "KeyF") {
        // F 全屏 —— 照搬诗云的 HUD 提示
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
        return;
      }
      if (e.code === "Escape") {
        clearSelection();
        return;
      }
      keys.current.add(e.code);
      /**
       * 任何移动键都**解锁**（回到自由飞行）—— 照搬诗云的 `MOVE_KEYS → unlock()`。
       * 理由：锁定是"看这一颗"，用户一旦开始自己飞，就说明他想走了。
       * Q/E 滚转**不算移动键**（滚转不该解跟随）—— 诗云专门注了这一点。
       */
      if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(e.code)) {
        const st = useCloud.getState();
        if (st.selection) st.clearSelection();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    const onBlur = () => keys.current.clear();

    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [gl, camera, clearSelection, setFlySpeed]);

  /**
   * 双击图例 ⇒ 飞向那一团。
   *
   * 诗云的 `flyTarget` 分支就是这么做的：目的地 = 目标 + **从当前这一侧**退开一段
   * （`back = normalize(camera − target)`，所以不会绕到目标背后去）、再抬一点高度；
   * 每帧指数阻尼过去，**到位就结束**（`distanceTo(desired) < 24` 时清空目标）。
   *
   * 为什么用"从当前这一侧退开"而不是固定方位：固定方位会让镜头**绕着目标甩半圈**，
   * 用户会短暂失去方位感（"我刚才在看哪儿？"）。
   */
  useEffect(() => {
    if (!focus) return;
    const p = new THREE.Vector3(focus.pos[0], focus.pos[1], focus.pos[2]);
    /**
     * 退开多远：用"这一团的直径"来决定（诗云用 `poemSystemRadius × 1.15 + 130`，
     * 同样是"按目标大小取景"而不是写死一个距离）。2.4R 刚好让整团占满画面高度的一半左右。
     */
    const body = nearestBody(bodies, p);
    const r = body ? body.gravityR / GRAVITY_K : 8;
    _off.copy(camera.position).sub(p);
    if (_off.lengthSq() < 1) _off.set(0, 0, 1);
    _off.normalize();
    const dest = p.clone().addScaledVector(_off, r * 2.4).add(new THREE.Vector3(0, r * 0.35, 0));
    /**
     * ⚠️ **必须同时记下"飞到哪"和"看着哪"**。
     *
     * 第一版只存了目的地，然后每帧 `lookAt(目的地)` —— 那是个**退化**的目标：
     * 相机越靠近它，"朝向"越接近零向量，方向最后会乱翻。
     * 实测表现是"双击图例之后镜头飞过去、然后盯着虚空"（`nonBgPct` 直接 **0**），
     * 而所有接线看起来都对 —— 是"把相机放到单个星团跟前拍特写"这个新探针
     * 一眼看出画面全黑才逮到的。
     *
     * 诗云的 `flyTarget` 分支里这两个量是**分开的**：`tv` 是看向的目标、
     * `desired` 是位置（它的注释专门标注了"四个向量互不相同"）。
     */
    const look = p.clone();
    flight.current = { pos: dest, look, at: performance.now() };
    // 焦点滑行期间不该被"锁定轨道"抢走控制权（图例双击时通常没有选中项，但两者可能重叠）
  }, [focus, camera, bodies]);

  useFrame((_, dtRaw) => {
    // ⚠️ dt 封顶：切后台或卡顿后回来，一帧 dt 可能是好几秒 —— 不封顶会让相机瞬移出去
    const dt = Math.min(dtRaw, 0.1);
    const f = fly.current;

    /**
     * 这一帧星系转了多少（引力协转要用）。
     *
     * 为什么不用 `SPIN_RATE * dt` 自己算：`SpinClock` 在"减少动态效果"下**不推进**角度，
     * 而星点也就没动 —— 那时相机若还按 SPIN_RATE 协转，就变成"星不动、镜头自己在转"。
     * 用**共享角度的真实差分**，等于直接问"画面这一帧转了多少"，天然一致。
     * （取模 2π 后可能得到"绕回去"的大值，所以超过 0.5 弧度就当成跳变丢弃。）
     */
    const raw = (galaxySpin.angle - lastAngle.current + Math.PI * 2) % (Math.PI * 2);
    lastAngle.current = galaxySpin.angle;
    const dA = raw < 0.5 ? raw : 0;
    flyDebug.lastDA = dA;
    flyDebug.speed = f.speed;

    const isPaper = selection?.kind === "paper";
    const key = isPaper ? `${selection.domain}:${selection.docId}` : "";
    flyDebug.locked = isPaper;
    flyDebug.lockDist = lock.current.dist;
    if (isPaper && resolveAnchor(selection.domain, selection.docId, _hit)) {
      // ---- 锁定轨道（照搬诗云：目标每帧重算 + 指数阻尼 + 朝向 slerp）
      const lk = lock.current;
      if (lk.key !== key) {
        lk.key = key;
        lk.dist = LOCK_DIST;
        // 从**当前视角**反解方位角 ⇒ 第一帧的期望位置就等于相机原位，零跳变；
        // 之后距离被拉到 LOCK_DIST ⇒ 观感是"沿视线推近"，方位感不丢。
        _off.set(camera.position.x - _hit.world[0], camera.position.y - _hit.world[1], camera.position.z - _hit.world[2]);
        const d = _off.length();
        if (d > 1) {
          lk.pitch = Math.asin(Math.max(-1, Math.min(1, _off.y / d)));
          lk.yaw = Math.atan2(_off.x, _off.z);
        } else {
          lk.pitch = 0.32;
          lk.yaw = 0;
        }
      }
      // Q/E 滚转（锁定时也生效：滚转是"机身"，不是"移动"，所以不解锁 —— 诗云同样是这个语义）
      if (keys.current.has("KeyQ")) f.roll += ROLL_RATE * dt;
      if (keys.current.has("KeyE")) f.roll -= ROLL_RATE * dt;
      _tgt.set(_hit.world[0], _hit.world[1], _hit.world[2]);
      const cp = Math.cos(lk.pitch);
      _dest.copy(_tgt).add(_off.set(Math.sin(lk.yaw) * cp * lk.dist, Math.sin(lk.pitch) * lk.dist, Math.cos(lk.yaw) * cp * lk.dist));      const k = damp(dt);
      camera.position.lerp(_dest, k);
      // 朝向：先 lookAt 目标，再后乘绕**视线轴**的滚转（Q/E）
      _m.lookAt(camera.position, _tgt, _worldUp);
      _quat.setFromRotationMatrix(_m);
      if (f.roll) _quat.multiply(_rollQuat.setFromAxisAngle(_zAxis, f.roll));
      camera.quaternion.slerp(_quat, k);
      /**
       * 把相机**真实的**朝向反解回自由飞行的 yaw/pitch ——
       * 诗云这一行注释是 "so free-fly resumes cleanly on release (含 roll)"。
       * 不写回就会在解锁时用锁定期那个被镜像过的 pitch，镜头整个朝天（见文件头）。
       * `roll` 不写回：它是用户持有的滚转角（诗云也是把 euler.z 每帧从 roll 重写）。
       */
      _euler.setFromQuaternion(camera.quaternion, "YXZ");
      f.yaw = _euler.y;
      f.pitch = _euler.x;
      flight.current = null;
      return;
    }
    lock.current.key = ""; // 没锁（或解析不到目标）⇒ 下次锁定要重新取景

    // ---- 焦点滑行（双击图例飞过去）：与自由飞行共存，到位就结束
    const fl = flight.current;
    if (fl) {
      const k = dampFly(dt);
      camera.position.lerp(fl.pos, k);
      // 看向**目标点**（不是目的地，见上面那段说明）
      _tgt.copy(fl.look);
      _m.lookAt(camera.position, _tgt, _worldUp);
      _quat.setFromRotationMatrix(_m);
      camera.quaternion.slerp(_quat, k);
      _euler.setFromQuaternion(camera.quaternion, "YXZ");
      f.yaw = _euler.y;
      f.pitch = _euler.x;
      if (camera.position.distanceTo(fl.pos) < Math.max(0.6, fl.pos.length() * 0.01)) flight.current = null;
      return;
    }

    // ---- 引力协转：在某一团的引力球里，相机跟着它一起转
    if (dA) {
      const body = insideBody(bodies, camera.position);
      flyDebug.gripping = body ? body.id : "";
      if (body) {
        _off.copy(camera.position).sub(body.center);
        _quat.setFromAxisAngle(body.axis, dA);
        _off.applyQuaternion(_quat);
        camera.position.copy(body.center).add(_off);
        // 朝向也转同样的 Δ（绕同一根轴）—— 否则"位置跟着转了、视线没转"，画面会横扫
        camera.quaternion.premultiply(_quat);
        /**
         * 把协转后的**真实姿态**反解回三个欧拉角。
         *
         * ⚠️ 这里必须**三个都写回**（含 roll）：不写回的话下一帧 `applyPose()` 会用旧姿态
         * 把这一帧的协转抹掉，表现为"在星团里飞的时候画面在抖"。
         *
         * ⚠️ 也正因为这一步会覆盖 roll，**Q/E 滚转必须放在它后面**（见下面那段）。
         *    我第一次把滚转放在分支之前（照诗云的行序），实测按 Q 只转了 0.7° ——
         *    刚加上去的滚转角被这一行吃掉了。诗云能那样排是因为它的星系绕**世界 Y** 自转、
         *    协转只需要 `euler.y += dA`，从不碰 roll；我们的星团各有倾角，必须整流形写回。
         */
        _euler.setFromQuaternion(camera.quaternion, "YXZ");
        f.yaw = _euler.y;
        f.pitch = _euler.x;
        f.roll = _euler.z;
      }
    }

    /**
     * Q/E 滚转（自由飞行与锁定**两个模式下都生效**）—— 照诗云 `ROLL_RATE = 1.2 rad/s`。
     * 位置：必须在引力协转的"姿态写回"**之后**，否则刚加的滚转会被写回覆盖掉（见上）。
     */
    if (keys.current.has("KeyQ")) f.roll += ROLL_RATE * dt;
    if (keys.current.has("KeyE")) f.roll -= ROLL_RATE * dt;

    applyPose();

    // WASD/Space/Shift 沿**相机基**推进（照诗云：飞行不是平移场景）
    const kk = keys.current;
    _move.set(0, 0, 0);
    camera.getWorldDirection(_fwd);
    _right.crossVectors(_fwd, _worldUp).normalize();
    _up.crossVectors(_right, _fwd).normalize();
    if (kk.has("KeyW")) _move.add(_fwd);
    if (kk.has("KeyS")) _move.sub(_fwd);
    if (kk.has("KeyD")) _move.add(_right);
    if (kk.has("KeyA")) _move.sub(_right);
    if (kk.has("Space")) _move.add(_up);
    if (kk.has("ShiftLeft") || kk.has("ShiftRight")) _move.sub(_up);
    /**
     * 双指手势的模拟推进（与键盘 additive，桌面端恒为 0）。
     *
     * 约定与键盘一致：`forward>0` 沿视线前进、`right>0` 沿右向量平移。
     * 幅度**不归一化到单位长度**：它是模拟量（推得远 = 飞得快），
     * 与 WASD 的"数字量"不同 —— 但两者相加后仍要归一化，否则对角推会比正推快 41%。
     */
    if (thrust.current.forward || thrust.current.right) {
      _move.addScaledVector(_fwd, thrust.current.forward);
      _move.addScaledVector(_right, thrust.current.right);
    }
    if (_move.lengthSq() > 0) {
      _move.normalize().multiplyScalar(FLY_BASE_SPEED * f.speed * Math.min(dt, MOVE_DT));
      camera.position.add(_move);
    }
  });

  return null;
}

/**
 * 下面两个查找用的临时向量。
 *
 * ⚠️ 特意**不复用** `_off`：那两个函数会在调用者正要使用 `_off` 的间隙里被调到，
 * 共用同一个临时对象就会出现"helper 悄悄改了调用者的中间量"这种极难查的错。
 * 一个不共享的 Vector3 成本可以忽略，换掉的是一整类 bug。
 */
const _probe = new THREE.Vector3();

/** 找出把某个点算作"引力球内"的天体（相机在哪一团的引力范围里就跟着哪一团转） */
function insideBody(bodies: readonly SpinBody[], p: THREE.Vector3): SpinBody | null {
  let best: SpinBody | null = null;
  let bestD = Infinity;
  for (const b of bodies) {
    const d2 = _probe.copy(p).sub(b.center).lengthSq();
    if (d2 < b.gravityR * b.gravityR && d2 < bestD) {
      bestD = d2;
      best = b;
    }
  }
  return best;
}

/** 找出离某个点最近的天体（用来按"这一团多大"取景） */
function nearestBody(bodies: readonly SpinBody[], p: THREE.Vector3): SpinBody | null {
  let best: SpinBody | null = null;
  let bestD = Infinity;
  for (const b of bodies) {
    const d2 = _probe.copy(p).sub(b.center).lengthSq();
    if (d2 < bestD) {
      bestD = d2;
      best = b;
    }
  }
  return best;
}
