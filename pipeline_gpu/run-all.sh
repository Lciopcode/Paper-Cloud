#!/usr/bin/env bash
# 论文云 · 语义层全量跑一遍（4090 机器）
#
# 设计原则：**每一步都能单独重跑**。中途失败时，直接重跑整条命令即可。
#
# 续跑规则（重要）：`embed.py` 的 `.ok` 存的是**产出指纹**（模型/维度/序列长度/分片大小）。
#   指纹一致才跳过；换过其中任何一项（或 `.ok` 是旧格式）都会**重算**该分片。
#   也就是说"换个模型重跑"不会静默复用旧向量 —— 判定规则见 selftest_resume.py。
#
# 用法：
#   bash run-all.sh                 # 八个学科全跑
#   bash run-all.sh cs math         # 只跑指定的学科
set -euo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# 解释器：优先用仓库里的 venv（本机没有 conda，且**系统 python 没装
# sentence-transformers / faiss**，直接用 `python` 会在第一步就 ModuleNotFoundError）。
# ---------------------------------------------------------------------------
PY="python"
for cand in ".venv/Scripts/python.exe" ".venv/bin/python" "venv/Scripts/python.exe"; do
  if [ -x "$cand" ]; then PY="$cand"; break; fi
done

# ---------------------------------------------------------------------------
# 模型：优先用**本地目录**，否则 `BAAI/bge-m3` 会去 huggingface.co 现下 2.2 GB
# （实测该站点在本网络只有 0.08–1.3 MB/s，而且 hub 下载器在大文件上会卡死在 0 字节）。
# 本机是把权重下到 models/bge-m3 的，见 setup-4090.md §1.5。
# ---------------------------------------------------------------------------
MODEL="BAAI/bge-m3"
if [ -d "models/bge-m3" ]; then MODEL="models/bge-m3"; fi

# 序列长度：文档规定"标题+摘要 256 token 截断"。bge-m3 自己的默认是 8192，
# embed.py 已显式设成 256，这里不用再传；要改就加 --max-seq-len。
DOMAINS=("$@")
if [ ${#DOMAINS[@]} -eq 0 ]; then
  DOMAINS=(qfin bio stat eess econ math cs physics)
fi

echo "=== 论文云 · 语义层 ==="
echo "解释器：$PY"
echo "模型  ：$MODEL"
echo "学科  ：${DOMAINS[*]}"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || true

for d in "${DOMAINS[@]}"; do
  echo ""
  echo "################ $d ################"

  # 实测速率（bge-m3 / 256 token / batch 64 / 4090 D）：**145–176 篇/秒**
  #   逐团实测：econ 145 · qfin 149 · bio 158 · stat 163 · eess 161 · math 176
  #   实测耗时：econ 86s · math(575,978) **54.4 分**
  #   外推：cs(806,174) ≈ 76 分 · physics(1,463,588) ≈ 139 分
  #   ⇒ 单卡全量约 5 小时；**两块卡可以分卡并行**（cs 一块、physics 一块，实测各约 390 W），
  #     两者同时开始同时结束，省下约 76 分钟。同一学科不要并行（会写同一份产物）。
  echo "--- 1/5 嵌入（最慢的一步，实测 145–176 篇/秒）---"
  "$PY" pipeline_gpu/embed.py --domain "$d" --model "$MODEL" --shard 200000 --batch 64

  echo "--- 2/5 层内聚类（第 5 层：具体研究点）---"
  "$PY" pipeline_gpu/cluster.py --domain "$d"

  echo "--- 3/5 层内近邻（供社区发现用）---"
  "$PY" pipeline_gpu/knn.py --domain "$d" --k 20

  echo "--- 4/5 社区发现 + 同路线边（第 6 层 / 第三类关系）---"
  "$PY" pipeline_gpu/community.py --domain "$d"

  echo "--- 5/5 层标签（c-TF-IDF 关键词）---"
  "$PY" pipeline_gpu/label.py --domain "$d" --topk 12
done

echo ""
echo "=== 导出 + 登记 + 验收 ==="
"$PY" pipeline_gpu/export.py --all
"$PY" pipeline_gpu/register.py
"$PY" pipeline_gpu/verify_semantic.py --all

echo ""
echo "格式契约自检（含「故意写错必须被抓」）："
"$PY" pipeline_gpu/selftest_formats.py
echo "续跑判定自检："
"$PY" pipeline_gpu/selftest_resume.py

echo ""
echo "全部通过。"
echo ""
echo "⚠️ 关于 git：**语义层的产物不进 git** —— \`.gitignore\` 里有一行 \`public/data/\`，"
echo "   所以 public/ 下没有任何文件被跟踪，\`git add public/data/...\` 会**直接报错**"
echo "   （\"The following paths are ignored by one of your .gitignore files\"）。"
echo "   这是有意的：public/data 是 4.4 GB 的**可重建**产物，随交付目录走，不由 git 携带。"
echo "   所以跑完之后 git 里**没有需要提交的东西**；要提交的只有代码与文档。"
echo "   （若确实想把它纳入版本控制，得用 \`git add -f\`，但那会让仓库膨胀到 GB 级 —— 不建议。）"
echo ""
echo "前端验收（不需要 Chrome，Edge 即可）："
echo "  node deploy/verify-all.mjs      # 13/13，约 210 秒（它会自拉服务器并清理 profile）"
