# 论文云 · 语义层 GPU 管线

本目录是**为 4090 机器准备的交接包**。目标：用 GPU 跑出语义层，补上八层结构里
**第 5 层（具体研究点）** 与 **第 6 层（技术路线）**，以及第三类关系边（同路线边）。

## 为什么必须分出来

语义层需要**神经网络嵌入 + 近邻搜索 + 社区发现**，三件事都需要 GPU：

| 步骤 | 为什么需要 GPU | 本机（AMD 核显 / 无 CUDA） |
|---|---|---|
| 文本嵌入 | bge-m3 前向推理，305 万篇 | 不可行（实测：本机 Python 3.14 无 torch wheel） |
| 近邻搜索 | 按层内做 ANN，最大层 133,725 篇 | 可用 CPU 但很慢 |
| 社区发现 | Louvain / Leiden 在 k-NN 图上迭代 | 可用 CPU 但很慢 |

所以基座（编号/层级/同领域关系/渲染）全部在本机做完，
语义层**只做"往已有结构里填内容"**这一件事 —— 输入输出格式都已固定，见下。

## 输入（本机已产出，随仓库一起搬过去）

```
text/<domain>.jsonl.gz          每篇一行：{ docId, title, abstract, primaryCat, cats, year }
                                八团合计约 1.3 GB
public/data/manifest.json       层号 → 层 的对应（strata 数组）
public/data/<domain>/rank.bin   编号表：docId + rank + tokens + **层号**
public/data/relations/<d>.nbr.bin  同领域邻接表（可选：用作 k-NN 的"同层约束"）
```

`text/*.jsonl.gz` 若不在仓库里，在 4090 机器上按 `pipeline/export-text.mjs` 从语料重建
（语料是 arXiv OAI-PMH 抓的 SQLite，`data/corpus/domain_<id>.db`）。

## 输出（必须严格按这几个格式，才能被前端直接读）

### 1. `public/data/semantic/<domain>.emb.bin` — 嵌入

```
magic "LUNYEMB1"(8) | count(u32) | dim(u32) | quant(u32=1 表示 int8) | scale(f32)
记录：dim × int8           （反量化：value = int8 × scale）
按 **docId** 索引 —— 与邻接表同一套约定，保证 O(1) 随机访问
```

用 **bge-m3 + Matryoshka 256 维**：305 万篇 × 256 B ≈ 0.8 GB（int8），可整份加载进浏览器。

### 2. `public/data/semantic/<domain>.clu.bin` — 聚类归属（第 5 层）

```
magic "LUNYCLU1"(8) | count(u32) | k(u32) | recBytes(u32=4)
记录：u16 clusterId + u16 保留(恒为 0)
按 **docId** 索引
```

聚类必须**在层内做**（同一 L3 内聚成若干 L5），否则会把"物理"和"经济"聚到一起，
层级就失去意义了。

**关于 `k` 的两个口径（容易读错，写清楚）**：

- 头部的 `k` 是**全局最大层内簇数**（所有层里最大的那个 `k_s`），**不是**每层都用这么大；
- 每层的簇数是自适应的：`k_s = clip(round(sqrt(m/2)), 2, 64)`（`m` = 该层篇数），
  **不足 4 篇的层直接跳过不聚类**（该层簇号恒为 0，表示"这一层只有一个研究点"，是诚实的结果）。

> ⚠️ **记录必须是 4 字节**（`u16 簇号 + u16 保留`）。
> 这里出过一次真实的错：头部声明 `recBytes=4`，实际却只写 2 字节/条，
> 于是文件长度 `20+2n` 与声明的 `20+4n` 差一倍 —— 而且**不崩**，
> 下一步按 4 字节去读就整体错位。
> 现在由 `python pipeline_gpu/selftest_clu.py` 守住这条契约
> （它会**故意写一份 2 字节的错文件**来确认自己真的会报错，见该脚本说明）。

### 3. `public/data/semantic/<domain>.route.bin` — 同路线边（第三类关系）

```
magic "LUNYROU1"(8) | count(u32) | 每条边：u32 a + u32 b + f32 weight
（a、b 是 docId，a < b，按 a 升序排好）
```

> ⚠️ **magic 必须是 8 字节。** 这里原来写的是 `"LUNYRT1"` —— 那是 **7** 个字符，
> 而头部布局与所有读取端（`export.py` / `register.py` / `verify_semantic.py`）
> 都按"8 字节 magic + offset 8 取 count"设计。后果是**整条 route 链路从来没通过过验收**：
> 文件头判据恒为假、offset 8 取到的 count 整体错位、`register.py` 永远发现不了 routes。
> 本目录其余 12 个 magic 全是 8 字节，只有它漏了一个字符。
> 现已统一为 `LUNYROU1`，并在 `community.py` 里留了一句 `assert len(MAGIC_ROUTE) == 8`。

**来源**：设计意图是「**共被引 ∩ 语义近邻**」（用户原话："同一路线"），
即要求语义与引用**两路证据都成立**。

> ⚠️ **实际上目前只有语义这一路。** 共被引**从数据上就无从算起**：
> 仓库里没有任何"谁引用了谁"的边表。
>
> **这两份文件到底是什么，可以自己复核 —— 但别靠猜字节，布局写在产出方的注释里：**
>
> | 文件 | 布局 | 是引用边吗 |
> |---|---|---|
> | `data/cites/<学科>.bin` | `u32 cites \| u16 year \| u8 venueTier \| u8 flags`，**按 docId 索引**（`harvest-cites.mjs` 产出，布局写在 `pipeline/harvest-cites.mjs` 顶部） | ❌ 一篇一个**数** |
> | `public/data/cites/<学科>.bin` | `LUNYCITE` + count + 每篇 8 字节（引用数/期刊档/引用档/保留），由上一份经 `build-cites.mjs` 生成 | ❌ 一篇一个**数** |
>
> 实测：`data/cites/physics.bin` 11,708,704 字节 ÷ 8 = **1,463,588 条**，
> 正好等于物理团论文数 ⇒ 一篇一条。它**没有文件头**（是纯记录数组），
> 所以头 8 字节 `19 00 00 00 c2 07 00 00` 是 **docId 0 的记录本身**
> （cites=25、year=1986），不是 magic —— magic 检查必然不通过，这是格式使然。
> （`u32` 那个字段是**引用数**不是 docId：物理团该字段最大 20,140、只有 1,665 个
> 不同值，明显不是 id 序列。我最初读成了 `(docId=25, 年份=1986)`，是错的。）
>
> 换句话说：**把 magic 校验去掉也没用**，文件里只有计数。
>
> **怎么补这一路**（别搞混两件事）：跑现有的 `pnpm harvest:cites` **补不上** ——
> `harvest-cites.mjs` 抓的是引用**次数**（给"亮度"编码用），它本身不产出边。
> 要拿到边得换成 S2 的 `/references`（**不能批量**，一篇一次请求）或
> OpenAlex 的 `referenced_works`（要先建一张 OpenAlex ID → docId 映射表，
> 约 30 天配额）。两条路各自的障碍写在 `docs/HANDOFF-当前状态与后续.md` §3.3 ——
> **拿到免费学术 API key 之后是可做的**，不是永远做不了。
>
> `community.py` 里的 `load_cocitation()` 因此是个**可用性探针，恒返回 None**；
> 脚本走降级分支：**仅语义近邻 + 更高的相似度阈值**，
> 并把这件事**如实**写进 `communities.json` 的 `degraded` / `degradedReason`。
>
> 所以读这个文件时要知道：**它是"语义同一路线"，不是"共被引验证过的同一路线"。**
> 脚本没有掩盖这一点，文档也不该掩盖。

### 4. 层标签（第 5 层的中文名）

`public/data/semantic/<domain>.labels.json`
```json
{
  "domain": "cs",
  "method": "c-TF-IDF",
  "globalK": 64,
  "strata": {
    "17": [ { "id": 0, "papers": 4213, "zh": "目标检测", "top": ["detr","yolo","…"] } ]
  }
}
```
`strata` 的键是**层号**（字符串形式），值是这一层内各个簇的标签。
标签用 **c-TF-IDF 关键词 + 可选 LLM 润色**（LLM 只是"起名"，不影响数据结构）。

### 5. 第 6 层「技术路线」（Leiden 社区）—— **两个文件**

```
public/data/semantic/<domain>.cmu.bin
    magic "LUNYCMU1"(8) | count(u32) | k(u32) | recBytes(u32=4)
    记录：u32 社区号；0xFFFFFFFF = 该篇不属于任何路线（没有同路线边）
    按 **docId** 索引，count = 该学科篇数

public/data/semantic/<domain>.communities.json
    { domain, k, nodes, edges, modularity, resolution, threshold,
      evidence, degraded, degradedReason, membershipCount }   ← **不含 membership**
```

**第 5 层与第 6 层是两件不同的事**，别混：

| | 第 5 层 | 第 6 层 |
|---|---|---|
| 产出 | `cluster.py` | `community.py` |
| 算法 | **层内** KMeans | **跨层** Leiden 社区发现 |
| 语义 | 某个研究方向**内部**的具体研究点 | 一条**技术路线**（可横跨 cv/lg/ml 几个方向） |
| 文件 | `clu.bin`（u16 簇号，**要配合层号**才成立） | `cmu.bin`（u32 社区号，全局） |

**为什么归属表走二进制而不是 JSON**：`membership` 是个 `{docId: 社区号}` 对象，
econ 只有 672 条，但**物理团量级会有上百万条** —— JSON 既慢又占内存，
而界面要的是"点开一篇就知道它属于哪条路线"（O(1)）。
这正是 `src/data/contract.ts` 开头写的原则 2：定宽二进制而非 JSON。
元信息留在 JSON 里，因为它**是人读的**，且保留原文件名便于溯源。

**阈值怎么定的（0.65，是量出来的）**：见 `community.py` 顶部那张表 ——
原来的 0.80 落在余弦分布的 p99.5 之外，把图切碎了（最大"技术路线"只有 8 篇、
模块度 0.99+）。要按学科微调就跑：

```bash
python pipeline_gpu/analyze_route_threshold.py --domain econ
python pipeline_gpu/analyze_route_threshold.py --all
```

它只读 `knn-k*.bin`，对一串候选阈值报告「边数 / 节点 / 连通分量 / 最大分量 /
社区数 / 最大社区 / 单例社区 / 模块度」，不改任何数据。

**读法**：**别只看模块度** —— 它接近 1 有两种相反成因（图碎成很多小块／真有强社区结构），
单看它分不开。判据是**"最大社区够不够大 + 单例社区够不够少"**。

数学团就是反例（实测，`--domain math`）：

| 阈值 | 最大社区 | 单例社区 | 连通分量 | 模块度 |
|---:|---:|---:|---:|---:|
| 0.60 | 58,683 | 195 | 272 | 0.939 |
| **0.65** | **56,560** | 2,627 | 3,399 | **0.927** |
| 0.70 | 22,287 | 14,905 | 22,025 | 0.929 |
| 0.80 | **969** | 27,300 | 37,832 | 0.995 |

0.65 的模块度 0.927 比 econ 的 0.713 高得多，**但它不是碎片**（最大社区 56,560 篇）；
真碎的是 0.80。所以「0.65 ⇒ 模块度落在 0.71–0.86」这个说法是按五个小团归纳的、
**已被数学团证伪**，别当规律用。

> ⚠️ **这张表必须与产物同源。** 该工具原来**漏传 `weights`**，跑的是无权重 Leiden，
> 而 `community.py` 跑的是**有权重**（边权 = 余弦值）—— 于是它给的数字对不上产物
> （math @ 0.65：无权重 3,452 社区 / 最大 56,725；有权重 3,475 / 最大 56,560）。
> 已修，现在 `--domain math --thresholds 0.65` 与 `semantic/math/communities.json`
> 里现算的结果**逐项相同**。

## 步骤

```
1. embed.py      文本 → 向量（bge-m3，Matryoshka 截到 256 维，int8 量化）
                 分片可续跑：每 20 万篇落一次盘，中途断了能接着来。
                 `.ok` 存的是**产出指纹**（模型/维度/序列长度/分片大小）——
                 换过任何一项都会重算，不会静默复用别的模型算出的向量
                 （判定规则见 selftest_resume.py）
2. cluster.py    在**每个 L3 层内**跑 MiniBatchKMeans → clu.bin
3. knn.py        层内 ANN（faiss；GPU 优先，没有 faiss-gpu 时自动退回 CPU 精确检索）
4. community.py  在 k-NN 图上跑 Leiden → route.bin + communities.json（第 6 层）
5. label.py      c-TF-IDF 关键词 + 可选 LLM 起名 → labels.json
6. export.py     按上面 5 个格式写文件（含 cmu.bin），并输出校验报告
```

## 验收（在 4090 机器上跑完必须能通过这些）

```bash
python verify_semantic.py --domain cs
#   · 嵌入：count 与该学科篇数一致；长度自洽；维度 256 / int8；模长在合理区间；无全零向量
#   · 语义：同层余弦均值 > 跨层均值（证明嵌入真的抓住了"研究方向"）
#   · 聚类：声明的 recBytes 与文件一致；长度自洽；保留位全为 0；簇号 < 声明的 k；
#           **参与聚类的层（≥4 篇）都至少 2 个簇**
#   · 同路线边：文件头与长度自洽；a < b、无自环、按 a 升序
#   · 可复现：同一篇两次读出的字节一致
#   · 另有格式契约自检：python pipeline_gpu/selftest_clu.py（含"故意写错必须被抓"）
```

## 跑完之后：前端**已经能显示**第 5/6 层（缺口已补上）

> 这一段原来写的是"⚠️ 跑完之后前端**还看不到**第 5/6 层（这是本交接包最大的缺口）"。
> 那个缺口是真实的：交接文档承诺过"格式先定死、跑完 register.py 前端一行代码都不用改"，
> 但实际上 `DomainEntry` 里没有 `semantic` 字段、资产层里也没有任何 loader ——
> **格式只定死了生产者，消费者那一端从来没写**，于是登记得再成功界面也不会有变化。
>
> 现在补上了：

| 位置 | 现状 |
|---|---|
| `src/data/contract.ts` | 新增 `SemanticAssets` 接口；`DomainEntry.semantic`、`Manifest.semanticBuiltAt` |
| `src/data/semantic.ts` | **新模块**（照 `cites.ts` 的样子写的）：4 个解析器 + `loadSemantic()`，一律按 docId O(1) |
| `src/ui/Hud.tsx` | 论文面板新增「语义层」区块：**研究点**（第 5 层 + 中文名 + 特征词）与**同路线**邻居列表 |
| `src/data/semantic.test.ts` | 58 项单测，其中 4 项是**跨语言契约**：直接读 `pipeline_gpu/*.py` 写出的真实文件 |

所以现在的流程确实是"跑完 GPU → 搬回文件 → `register.py` → 界面多出内容"。

### 两个刻意的取舍

**1）同路线边**不走 `relations.kinds`**，而是单独一块。**

`relations.kinds` 声明的是 `relations/<d>.nbr.bin` 里实际有哪些边，
而同路线边住在**另一个文件** `semantic/<d>.route.bin`。
把 `sameRoute` 塞进 `kinds` 会让界面多出一个**一条边都筛不出来**的筛选 ——
正是 `contract.ts` 注释里明确禁止的"谎报"。
所以 `register.py` **不再**往 `kinds` 里加 `sameRoute`，
界面改从 `entry.semantic.routes` 判断并在「语义层」区块里单列。

**2）前端会校验 `clu.bin` 的保留位哨兵。**

每条记录的第 2 个 u16 恒为 0。加载时若发现非 0，直接抛错而不是继续读 ——
因为那正是"写出端按 2 字节错位"的症状（这个 bug 真的发生过）。
让它在加载时炸，比画出满屏乱簇之后才被人察觉要好得多。

## 环境

```
requirements-gpu.txt     固定版本，避免"在 4090 上能跑、换机器就崩"
setup-4090.md            从零到跑通的步骤（含 CUDA / faiss-gpu 的常见坑）
```

## 明确不做的事

· **不重算编号与坐标** —— 编号、层级、同领域关系全部沿用本机产出，GPU 只填内容。
  这样才能保证"位置由编号唯一决定"这条不变量不被破坏。
· **不引入需要联网的推理服务** —— 嵌入模型本地跑，保证离线可复现（也是参赛"可验证性"的要求）。
