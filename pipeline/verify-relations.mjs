// 校验邻接表：邻居是否真的同层、跨步是否铺满整层、记录是否自洽
import { readFileSync } from "node:fs";

const VALUE_BYTES = 32;
const RANK_BASE = 16 + VALUE_BYTES * 2;
const RANK_REC = 40;
const HEAD = 24;
const REC = 4;

const domain = process.argv[2] || "qfin";
const domainIndex = Number(process.argv[3] ?? 7);

// 层号 + docId
const rank = readFileSync(`public/data/${domain}/rank.bin`);
const count = rank.readUInt32LE(8);
const stratumOfRankRec = new Uint16Array(count);
const docIdOfRankRec = new Uint32Array(count);
for (let i = 0; i < count; i++) {
  const o = RANK_BASE + i * RANK_REC;
  docIdOfRankRec[i] = rank.readUInt32LE(o);
  stratumOfRankRec[i] = rank.readUInt16LE(o + 4 + VALUE_BYTES + 2);
}
// docId → 层号
const stratumOfDoc = new Map();
for (let i = 0; i < count; i++) stratumOfDoc.set(docIdOfRankRec[i], stratumOfRankRec[i]);

const nbr = readFileSync(`public/data/relations/${domain}.nbr.bin`);
if (nbr.subarray(0, 8).toString("ascii") !== "LUNYNBR1") throw new Error("魔法数不对");
const nCount = nbr.readUInt32LE(8);
const K = nbr.readUInt32LE(12);
const recBytes = nbr.readUInt32LE(16);
const di = nbr.readUInt32LE(20);
console.log(`${domain}: count=${nCount} K=${K} recBytes=${recBytes} domainIndex=${di}（期望 ${domainIndex}）`);
console.log(`文件长度 = ${nbr.length}，期望 = ${HEAD + nCount * (K + 1) * REC}`);

const unpack = (p) => ({ kind: p & 3, uid: p >>> 2 });
let selfBad = 0;
let notSameField = 0;
let crossDomain = 0;
let kindBad = 0;
let empty = 0;
let ok = 0;
const spanStats = [];

for (let docId = 0; docId < nCount; docId++) {
  const o = HEAD + docId * (K + 1) * REC;
  const selfPacked = nbr.readUInt32LE(o);
  const self = unpack(selfPacked);
  // 自检：第 0 条必须是自己
  if (self.uid !== ((domainIndex << 24) | docId) || self.kind !== 1) selfBad++;

  const nbrs = [];
  for (let j = 1; j <= K; j++) {
    const packed = nbr.readUInt32LE(o + j * REC);
    if (packed === 0) { empty++; continue; }
    const { kind, uid } = unpack(packed);
    if (kind !== 1) kindBad++;
    const nDocId = uid & 0xffffff;
    const nDi = uid >>> 24;
    if (nDi !== domainIndex) crossDomain++;
    const mine = stratumOfDoc.get(docId);
    const theirs = stratumOfDoc.get(nDocId);
    if (mine !== theirs) notSameField++;
    else ok++;
    nbrs.push(nDocId);
  }
  if (nbrs.length >= 2) {
    // 邻居之间的 docId 跨度（相对层大小）
    const spread = Math.max(...nbrs) - Math.min(...nbrs);
    spanStats.push(spread);
  }
}

console.log(`\n自检条(自己)错误: ${selfBad}`);
console.log(`空槽: ${empty}（占 ${((100 * empty) / (nCount * K)).toFixed(1)}%）`);
console.log(`类型位错误: ${kindBad}`);
console.log(`跨学科边（不该有）: ${crossDomain}`);
console.log(`同领域校验：正确 ${ok}，错误 ${notSameField}`);
spanStats.sort((a, b) => a - b);
const median = spanStats[Math.floor(spanStats.length / 2)] ?? 0;
console.log(`邻居 docId 跨度中位数 = ${median.toLocaleString()}（层大小 2,382 ⇒ 跨度接近层大小说明铺满了整层）`);

// 抽样看一篇论文的邻居
const probe = Math.floor(nCount / 2);
const o = HEAD + probe * (K + 1) * REC;
const list = [];
for (let j = 1; j <= K; j++) {
  const p = nbr.readUInt32LE(o + j * REC);
  if (p) list.push(unpack(p).uid & 0xffffff);
}
console.log(`\n论文 docId=${probe}（层号 ${stratumOfDoc.get(probe)}）的邻居: ${list.join(", ")}`);
console.log(`  邻居层号: ${list.map((d) => stratumOfDoc.get(d)).join(", ")}`);
