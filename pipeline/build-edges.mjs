/**
 * 论文云 · 关系丝线边构建（**按起点配额**版）
 * ============================================================================
 * 从「同技术路线」的全量边里，为**每一篇在场论文**留下一小撮它自己的边，
 * 于是点开任意一颗星都能立刻画出它自己的关系网。
 *
 * ## 为什么不是"全局均匀抽样"（v1 的做法，已废弃）
 *
 * v1 为了让丝线铺满整个星系，是把全量候选边**均匀抽样**到每团 2 万条。
 * 那样画面上确实有网，但**每一篇论文平均只留下 0.7 条自己的边** ——
 * 点开一颗星，属于它的线几乎一条都没有，"点击看关系"这件事于是做不成。
 *
 * 作者的新要求正是把 v1 那个默认网**去掉**：「把各论文之间的线取消了，
 * 点击某个论文再显示出纤细清晰的关系线」。所以这一版反过来：
 * **每一篇都留，且只留它最强的 K 条**。
 *
 * ## 文件布局（`edges/<domain>.bin`，magic `LUNYEDG2`）
 *
 *   头部：magic(8) | count u32 | srcCount u32 | recBytes u32 | idxBytes u32 = 24
 *   索引：srcCount × (u32 起点 docId | u32 起始下标)      ← 按 docId 升序，可二分
 *   边：  count × (u32 终点 docId | f32 权重 | f32 bx,by,bz)   = 20 字节
 *
 * **为什么不存起点坐标**：起点一定是场上真实画出来的那颗星（构建时就按这个筛的），
 * 浏览器可以用 `docIndex` 从点集里直接读到它的坐标 —— 存一份是白占 12 字节/条。
 *
 * ## 坐标怎么来的：**import 前端那份几何，不重写**
 *
 * `sampleAddress` 从 `src/three/geometry.ts` 直接 import（Node 24 的类型擦除能跑 TS）。
 * 位置公式如果在这里再写一遍，就成了**第二份公式** —— 前端改了、这里忘了跟，
 * 丝线就会静静地连到错误的位置上。`anchor.ts` 顶部对同一个问题有更长的说明。
 *
 * ⚠️ **`src/data/domains.ts` 里改 `LAYOUT_SCALE` 之后必须重跑本脚本**，
 *    否则丝线用的是旧坐标（看起来只是"线有点歪"，很难查）。
 *
 * 用法：
 *   node pipeline/build-edges.mjs                 # 全部学科
 *   node pipeline/build-edges.mjs --domain cs     # 只跑一个
 *   node pipeline/build-edges.mjs --dry           # 只统计，不写文件
 *   node pipeline/build-edges.mjs --k 8           # 每篇留几条（默认 8）
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleAddress } from "../src/three/geometry.ts";
import { DOMAINS } from "../src/data/domains.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "public", "data", "semantic");
const SPINES = join(ROOT, "public", "data");
const OUT = join(ROOT, "public", "data", "edges");
const MANIFEST = join(ROOT, "public", "data", "manifest.json");

const ROUTE_MAGIC = "LUNYROU1";
/** ⚠️ 完整脊柱的 magic 是 `LUNYSPN1`（不是 LUNYSPIN）。写错不会崩 ——
 *  只会让 8 个学科被静默跳过，所以这里必须断言而不是"试一个能跑通的值"。 */
const SPINE_MAGIC = "LUNYSPN1";
const SPINE_DEMO_MAGIC = "LUNYSPD1";
const EDGE_MAGIC = "LUNYEDG2";

export const EDGE_HEAD_BYTES = 24;
export const EDGE_IDX_BYTES = 8;
export const EDGE_REC_BYTES = 20;
const VALUE_BYTES = 32;
const SPINE_REC_BYTES = 72;

const args = process.argv.slice(2);
const argVal = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const ONLY = argVal("--domain", null);
const K = Number(argVal("--k", "8"));
const DRY = args.includes("--dry");

const log = (s) => process.stdout.write(s + "\n");
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

function readSpine(path) {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  const head = Buffer.alloc(32);
  readSync(fd, head, 0, 32, 0);
  const magic = head.toString("latin1", 0, 8);
  const records = head.readUInt32LE(8);
  const recordBytes = head.readUInt32LE(16);
  const stride = magic === SPINE_DEMO_MAGIC ? head.readUInt32LE(20) : 1;
  if (recordBytes !== SPINE_REC_BYTES) {
    closeSync(fd);
    throw new Error(`${path} 的 recordBytes=${recordBytes}，期望 ${SPINE_REC_BYTES}`);
  }
  // 头部长度用「文件长度 − 记录数×72」反推，不照抄常量（抄错会让每条记录整体错位，
  // 而算出来的坐标"看着也挺像星系"，很难发现）
  const headBytes = size - records * SPINE_REC_BYTES;
  if (![20, 24, 32].includes(headBytes)) {
    closeSync(fd);
    throw new Error(`${path} 反推出的头部长度 ${headBytes} 不在 {20,24,32} 里 —— 文件格式变了`);
  }
  const body = Buffer.alloc(records * SPINE_REC_BYTES);
  readSync(fd, body, 0, body.length, headBytes);
  closeSync(fd);
  return { magic, records, stride, body };
}

function addrOf(spine, docId) {
  const off = docId * SPINE_REC_BYTES;
  return BigInt("0x" + spine.body.toString("hex", off, off + VALUE_BYTES));
}

const layoutOf = (domain) => {
  const d = DOMAINS.find((x) => x.id === domain);
  if (!d) throw new Error(`domains.ts 里没有 ${domain}`);
  return { center: d.center, radius: d.radius, tilt: d.tilt };
};

/** 收集：每个起点留它**权重最高的 K 条**。route 文件按起点升序，所以同一个起点的边是连续的。 */
async function collect(domain, demo, full) {
  const src = join(SRC, `${domain}.route.bin`);
  if (!existsSync(src)) return null;
  const size = statSync(src).size;
  const layout = layoutOf(domain);
  const stride = demo.stride;

  const rs = createReadStream(src, { highWaterMark: 1 << 23 });
  let buf = Buffer.alloc(0);
  let declared = null;
  let seen = 0;
  let kept = 0;
  let droppedRange = 0;
  /** src docId → 该起点的边（最多 K 条，按权重降序维护） */
  const bySrc = new Map();

  const consider = (srcDocId, dstDocId, w) => {
    let list = bySrc.get(srcDocId);
    if (!list) {
      list = [];
      bySrc.set(srcDocId, list);
    }
    if (list.length < K) {
      list.push({ dst: dstDocId, w });
      if (list.length === K) list.sort((a, b) => b.w - a.w);
    } else if (w > list[K - 1].w) {
      list[K - 1] = { dst: dstDocId, w };
      list.sort((a, b) => b.w - a.w);
    }
  };

  for await (const chunk of rs) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (declared === null) {
      if (buf.length < 12) continue;
      const magic = buf.toString("latin1", 0, 8);
      if (magic !== ROUTE_MAGIC) throw new Error(`${domain}.route.bin magic=${JSON.stringify(magic)}，期望 ${ROUTE_MAGIC}`);
      declared = buf.readUInt32LE(8);
      buf = buf.subarray(12);
    }
    const usable = buf.length - (buf.length % 12);
    for (let o = 0; o < usable; o += 12) {
      const a = buf.readUInt32LE(o);
      const b = buf.readUInt32LE(o + 4);
      const w = buf.readFloatLE(o + 8);
      seen++;
      // 起点必须在演示点集里（它要是场上真实画出来的那颗星），终点可以是任意一篇
      const aIn = a % stride === 0 && a / stride < demo.records;
      const bIn = b % stride === 0 && b / stride < demo.records;
      const srcDocId = aIn ? a : bIn ? b : -1;
      if (srcDocId < 0) continue;
      const dst = aIn ? b : a;
      if (srcDocId >= full.records || dst >= full.records) {
        droppedRange++;
        continue;
      }
      consider(srcDocId, dst, w);
      kept++;
    }
    buf = buf.subarray(usable);
  }

  if (declared === null) throw new Error(`${domain}.route.bin 读不出头部`);
  if (seen !== declared) {
    throw new Error(`${domain}.route.bin 声明 ${declared} 条，实际读出 ${seen} 条 —— 文件可能被截断`);
  }

  // 算终点坐标（起点坐标不存，浏览器自己从点集里读）
  const sources = [...bySrc.keys()].sort((x, y) => x - y);
  const edges = [];
  for (const s of sources) {
    for (const e of bySrc.get(s)) {
      const p = sampleAddress(addrOf(full, e.dst), layout).pos;
      edges.push({ src: s, dst: e.dst, w: e.w, b: p });
    }
  }
  return { seen, kept, sources, edges, size, droppedRange };
}

function writeEdges(domain, r) {
  const count = r.edges.length;
  const srcCount = r.sources.length;
  const buf = Buffer.alloc(EDGE_HEAD_BYTES + srcCount * EDGE_IDX_BYTES + count * EDGE_REC_BYTES);
  buf.write(EDGE_MAGIC, 0, "latin1");
  buf.writeUInt32LE(count, 8);
  buf.writeUInt32LE(srcCount, 12);
  buf.writeUInt32LE(EDGE_REC_BYTES, 16);
  buf.writeUInt32LE(EDGE_IDX_BYTES, 20);

  // 索引 + 边（边按起点升序，于是索引里的 offset 就是数组下标）
  const off = new Map();
  for (let i = 0; i < count; i++) if (!off.has(r.edges[i].src)) off.set(r.edges[i].src, i);
  for (let i = 0; i < srcCount; i++) {
    const s = r.sources[i];
    buf.writeUInt32LE(s, EDGE_HEAD_BYTES + i * EDGE_IDX_BYTES);
    buf.writeUInt32LE(off.get(s), EDGE_HEAD_BYTES + i * EDGE_IDX_BYTES + 4);
  }
  const base = EDGE_HEAD_BYTES + srcCount * EDGE_IDX_BYTES;
  for (let i = 0; i < count; i++) {
    const e = r.edges[i];
    const o = base + i * EDGE_REC_BYTES;
    buf.writeUInt32LE(e.dst, o);
    buf.writeFloatLE(e.w, o + 4);
    buf.writeFloatLE(e.b[0], o + 8);
    buf.writeFloatLE(e.b[1], o + 12);
    buf.writeFloatLE(e.b[2], o + 16);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${domain}.bin`), buf);
  return buf.length;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const domains = manifest.domains.filter((d) => !ONLY || d.id === ONLY);
if (!domains.length) {
  log(`manifest 里没有学科 ${ONLY}`);
  process.exit(1);
}

log(`按起点配额构建关系丝线边（每篇最多 ${K} 条，权重最高的优先）→ public/data/edges/<d>.bin`);
log(`格式 ${EDGE_MAGIC}：头部 ${EDGE_HEAD_BYTES} + 索引 ${EDGE_IDX_BYTES}/起点 + 边 ${EDGE_REC_BYTES}/条${DRY ? " · --dry" : ""}\n`);

let totSeen = 0;
let totEdges = 0;
let totBytes = 0;
for (const d of domains) {
  const demo = readSpine(join(SPINES, d.id, "spine.demo.bin"));
  const full = readSpine(join(SPINES, d.id, "spine.bin"));
  if (!demo || !full) {
    log(`  ${d.id.padEnd(8)} 跳过（缺 spine）`);
    continue;
  }
  if (full.magic !== SPINE_MAGIC) {
    log(`  ${d.id.padEnd(8)} 跳过（spine.bin magic=${JSON.stringify(full.magic)}）`);
    continue;
  }
  const r = await collect(d.id, demo, full);
  if (!r) {
    log(`  ${d.id.padEnd(8)} 跳过（没有 semantic/${d.id}.route.bin）`);
    continue;
  }
  const perSrc = r.edges.length / Math.max(1, r.sources.length);
  totSeen += r.seen;
  totEdges += r.edges.length;
  log(
    `  ${d.id.padEnd(8)} 全量 ${String(r.seen).padStart(9)} 条 → 有边的起点 ${String(r.sources.length).padStart(6)}` +
      `（演示 ${demo.records} 篇）· 保留 ${String(r.edges.length).padStart(7)} 条（**每篇均 ${perSrc.toFixed(1)} 条**）` +
      ` · 源 ${mb(r.size)}` +
      (r.droppedRange ? ` · ⚠ 越界 ${r.droppedRange}` : ""),
  );
  if (!DRY && r.edges.length) totBytes += writeEdges(d.id, r);
}
log(`\n合计：全量 ${totSeen.toLocaleString("en-US")} 条 → 保留 ${totEdges.toLocaleString("en-US")} 条`);
if (!DRY) log(`写出 ${mb(totBytes)} → public/data/edges/`);
if (DRY) log("（--dry：没有写任何文件）");
