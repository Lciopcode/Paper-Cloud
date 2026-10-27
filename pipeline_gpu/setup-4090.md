# 4090 机器上从零跑通语义层

本文假设你拿到的是**整个 `v2/lunyun` 目录的副本**（或 git clone + 数据目录）。
基座（编号 / 层级 / 同领域关系 / 前端）都已经在本机做完，这里只跑语义层。

---

## 0. 先确认显卡与驱动

```bash
nvidia-smi
# 期望看到：RTX 4090, 24564 MiB, Driver Version >= 550, CUDA Version >= 12.4
```

驱动低于 12.4 就先升级驱动（不是升级 CUDA Toolkit，两者不是一回事）。

---

## 1. 建环境

```bash
conda create -n lunyun python=3.11 -y
conda activate lunyun

# faiss-gpu 只有 conda 有官方包，pip 装不上 —— 这一步必须用 conda
conda install -c conda-forge faiss-gpu=1.8.0 -y

pip install -r pipeline_gpu/requirements-gpu.txt
```

**验证：**

```bash
# ⚠️ 用仓库 venv 的解释器（PATH 上的 python 是系统 python，没装这些依赖）
.venv\Scripts\python.exe -c "import torch, faiss; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('faiss', faiss.__version__, 'gpus', faiss.get_num_gpus() if hasattr(faiss,'get_num_gpus') else 'n/a')"
```

**期望值有两种，都是正常的**（别以为第二种是装坏了）：

| 情形 | 输出 | 说明 |
|---|---|---|
| 装到了 GPU 版 | `faiss 1.8.0 gpus 1`（或 2） | `knn.py` 走 GPU |
| **装的是 `faiss-cpu`**（本机就是） | `torch 2.1.1+cu121 cuda True` + `faiss 1.8.0 gpus 0` | `knn.py` **自动退回 CPU 精确检索** |

> ⚠️ 原文这里写的是"期望 `torch 2.4.1 cuda True` / `faiss-gpu 1`"，**两处都与本机不符**：
> 本机 `torch` 是 **2.1.1+cu121**（系统已装，venv 用 `--system-site-packages` 复用它），
> 而**PyPI 上没有 GPU 版 faiss**（`faiss-gpu` / `faiss-gpu-cu12` 都是
> "No matching distribution found"），本机也没有 conda —— 所以装的是 `faiss-cpu`。
>
> **这不构成阻塞**：`IndexFlatIP` 是**精确**检索，CPU 结果与 GPU **完全一致**，
> 只是慢一点。实测 math（1,150 万条近邻边）**31.5 秒**、11.5M 边 28.3 秒 ——
> 对全量跑来说完全可以接受。详见 §1.5。

若 `torch.cuda.is_available()` 是 False：

```bash
pip uninstall -y torch torchvision
pip install torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cu124
```

### 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `faiss.get_num_gpus()` 返回 0 | 装成了 CPU 版 faiss | `conda remove faiss-cpu faiss-gpu` 后重装 `faiss-gpu` |
| `undefined symbol: ...cublas...` | torch 与 faiss 的 CUDA 版本不一致 | 让两者都基于 cu124 |
| `numpy 2.x` 下 faiss 崩溃 | faiss 1.8 与 numpy 2 不兼容 | 锁 `numpy==1.26.4`（已在 requirements 里） |
| 第一次跑模型很慢 | 在下载 bge-m3（约 2.2 GB） | 先手动 `huggingface-cli download BAAI/bge-m3` |

---

## 1.5 若这台机器**没有 conda**（本机实测路径，先看这节）

上面那套是 conda 路线。**本机（RTX 4090 D）没有 conda**，实测走通了下面这条 venv 路线，
而且它**不用重新下载 2.5 GB 的 CUDA 版 torch** —— 直接复用系统里已装好的那一份：

```bash
python -m venv .venv --system-site-packages
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install "sentence-transformers==3.2.1" "transformers==4.45.2" "tokenizers==0.20.1" "igraph==0.11.8" "leidenalg==0.10.2" "python-louvain==0.16" brotli "faiss-cpu==1.8.0.post1"
```

### 四个实测踩到的坑

**1）`transformers` 与 `torch` 的版本必须对得上 —— 最容易白折腾半天的坑**

本机系统里是 **torch 2.1.1+cu121**。若只写 `pip install sentence-transformers==3.2.1`
而不锁 transformers，pip 会解析到 **4.57**，导入时直接炸：

```
AttributeError: module 'torch.utils._pytree' has no attribute 'register_pytree_node'
```

新 transformers 用了 torch ≥ 2.2 才有的 API。
**所以 transformers 必须显式锁 4.45.2**（与 `requirements-gpu.txt` 一致），
tokenizers 跟着锁 0.20.1（4.45.2 要求 `tokenizers>=0.20,<0.21`）。

> 另一种解法是把 torch 升到 2.4.1。取舍：锁 transformers 只是 ~9 MB 的小下载，
> 升级 torch 是 ~2.5 GB，而系统里那份 torch 的 CUDA 已验证可用，所以选前者。

**2）`--system-site-packages` 是省时间的关键**

不加它，pip 会去装一份完整的 CUDA 版 torch（2.5 GB）。加了之后 `import torch`
直接命中系统那份，实测 `torch 2.1.1+cu121 · cuda True · RTX 4090 D`。
**新装的包仍然只落在 `.venv` 里**，不污染系统 Python（已用 `__file__` 逐个核对）。

**3）PyPI 上*没有* GPU 版 faiss**

实测 `pip index versions faiss-gpu` 与 `faiss-gpu-cu12` 都是
`No matching distribution found`，只有 `faiss-cpu` 有轮子。

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. faiss-cpu（本机采用）** | `pip install "faiss-cpu==1.8.0.post1"` | `knn.py` 会打印"kNN 后端：**CPU**"并正常工作。`IndexFlatIP` 是精确检索，**结果与 GPU 完全一致**，只是慢 |
| B. 装 miniconda 拿 faiss-gpu | 装 miniconda 后照 §1 走 | 多装一个 conda；大团值得 |

`knn.py` 现在**自动判断**走哪条路，不再在没有 faiss-gpu 时抛 `AttributeError`。

**4）`.venv/` 与 `semantic/` 已加进 `.gitignore`**

`semantic/` 是 GPU 的**中间产物**目录（与架构文档里写的 `emb/`、`cluster/` 同性质）。

### 用 venv 跑

把 §3 命令里的 `python` 换成 `.venv\Scripts\python.exe` 即可。

> **实测结论（econ，12,486 篇）**：八个步骤全部跑通，
> `verify_semantic.py --domain econ` **全部 OK**，135 个研究点起了名，
> 标签可辨认（carbon climate emissions / volatility jumps / panel data / dyadic peer network）。
> 那次是用小模型（all-MiniLM-L6-v2）验证**流程机制**；真实产物要用默认的 `BAAI/bge-m3` 重跑。

---

## 2. 确认输入数据在位

```bash
ls -la text/ | head            # 8 个 <domain>.jsonl.gz，合计约 1.3 GB
ls public/data/manifest.json   # 层号 → 层 的对应
ls public/data/physics/rank.bin
```

若 `text/` 不在（因为体积大没随仓库走），先用本机的语料重建：

```bash
# 需要 data/corpus/domain_<id>.db（arXiv 语料，约 10.7 GB）
node pipeline/export-text.mjs
```

---

## 3. 跑语义层

```bash
# 逐步骤跑，每步都能单独验、单独重来
# ⚠️ 用 **venv 的解释器**：系统 python 没装 sentence-transformers / faiss，
#    裸 `python` 会在第一步就 ModuleNotFoundError（这是最初踩的坑）。
# ⚠️ 模型要指到本地目录，否则 embed.py 会去 huggingface.co 现下 2.3 GB
#    （本网络实测 0.08–1.3 MB/s，而且 hub 下载器在大文件上会卡死在 0 字节）。
.venv\Scripts\python.exe pipeline_gpu/embed.py     --domain cs --model models/bge-m3 --shard 200000 --batch 64
.venv\Scripts\python.exe pipeline_gpu/cluster.py   --domain cs
.venv\Scripts\python.exe pipeline_gpu/knn.py       --domain cs --k 20
.venv\Scripts\python.exe pipeline_gpu/community.py --domain cs
.venv\Scripts\python.exe pipeline_gpu/label.py     --domain cs --topk 12
.venv\Scripts\python.exe pipeline_gpu/export.py    --all

# 全量（八团）
# Windows（本机就是）：用 PowerShell 版 —— **本机 PATH 上没有 bash**，
#   文档原来写的 `bash pipeline_gpu/run-all.sh` 会直接 command not found。
powershell -ExecutionPolicy Bypass -File pipeline_gpu\run-all.ps1
powershell -ExecutionPolicy Bypass -File pipeline_gpu\run-all.ps1 -Domains cs,physics

# 有 bash 的环境（Linux / macOS / 装了 git-bash 并加进 PATH）：
bash pipeline_gpu/run-all.sh
```

> **关于 `cluster.py` 的参数**：本文档原来写的是 `cluster.py --domain cs --per-stratum 16` ——
> **没有 `--per-stratum` 这个参数**（实测 `error: unrecognized arguments`，exit 2）。
> 现在的簇数是**按层自适应**算出来的：`clip(round(sqrt(m/2)), --min-k, --max-k)`，
> 默认 2–64。想让某层更细就调 `--max-k`。

> **实测耗时**（bge-m3 / 256 token / batch 64 / 4090 D，**145–176 篇/秒**）：
> 八团全量约 **5 小时**（原文档写"3–6 小时"，落在区间内）。
> math（575,978 篇）实测 **54.4 分钟**；cs（806,174）约 76 分钟；physics（1,463,588）约 139 分钟。
> **两块卡可以分卡并行**（不同学科互不相干），本机就是这么把 cs 与 physics 同时跑完的 ——
> 省下约 76 分钟。**同一学科绝不要并行**（两个进程会写同一份产物）。

---

## 4. 验收

```bash
# ⚠️ 用仓库 venv 的解释器（PATH 上的 python 是系统 python，没装这些依赖）
# ⚠️ 必须给 --domain 或 --all —— 裸跑会报 "必须给 --domain <id> 或 --all"
.venv\Scripts\python.exe pipeline_gpu/verify_semantic.py --domain cs
# 八团一起验：
.venv\Scripts\python.exe pipeline_gpu/verify_semantic.py --all
```

必须全部通过才能拿回本仓库用。然后：

```bash
# 把 semantic 登记进 manifest（前端据此自动发现，**不需要改前端代码**）
.venv\Scripts\python.exe pipeline_gpu/register.py

# 回到前端验证
node deploy/verify.mjs
node deploy/verify-all.mjs        # 13 项，约 210 秒，会自己起服务器
```

---

## 5. 拿回本机之后

```bash
# ⚠️ 这两条**不能照抄** —— public/ 下没有任何文件被 git 跟踪：
#     .gitignore 第 16 行是 `public/data/`，所以 `git add public/data/...` 会报
#     "The following paths are ignored by one of your .gitignore files" 并以 exit 1 结束。
#     实测：git ls-files public → 空；git check-ignore -v public/data/manifest.json → .gitignore:16
#
# 这是**有意的**：public/data 是 4.4 GB 的可重建产物，随交付目录走，不由 git 携带。
# 所以跑完语义层之后，**git 里没有需要提交的东西**（要提交的只有代码与文档）。
```

产物本身照常交付：`public/data/semantic/` 与 `public/data/manifest.json`
**放在交付目录里一起拷**即可（它们不入库，但必须在包里）。

前端会自动发现 `manifest.semantic` 并显示第 5/6 层与"同路线"边 ——
**前端代码确实不需要改**（这是当初把格式先定死的原因）。

> ⚠️ 但原文那句"不需要改任何前端代码"在**接手前是不成立的**：
> `contract.ts` 里当时没有 `semantic` 字段、也没有任何 loader，前端**完全不读**语义层。
> 这块已经补上（`src/data/semantic.ts` + `Hud.tsx` 的面板 + 180 项单测），
> 所以现在这句话才成立 —— 完整说明见交付包里的 `接手核对报告.md` §3.1 与 §13。

---

## 资源预估（305 万篇全量）

| 步骤 | 4090 上耗时 | 产物大小 |
|---|---|---|
| embed（bge-m3，256 维 int8） | 3–6 小时 | 约 0.8 GB |
| cluster（层内 KMeans） | 20–40 分钟 | 约 12 MB |
| knn（层内 ANN，k=20） | 1–2 小时 | 中间产物，约 2 GB（可删） |
| community（Leiden） | 30–60 分钟 | — |
| route 边导出 | 10 分钟 | 约 200 MB |
| label（c-TF-IDF；LLM 起名可选） | 20 分钟 | 几 MB |

显存峰值：嵌入约 6–8 GB（batch 64）· kNN 约 10 GB（按层内最大 133,725 篇）——
24 GB 是够的，但**不要**把整个学科一次性塞进 faiss 索引。
