# 变更记录（Changelog）

> 论文云 Paper Cloud · 仓库 `lunyun`。
> 版本号规则：**主版本**=架构/语义不兼容级变化（目前仍为 0.x），**次版本**=一个可交付的功能轮次，
> **修订号**=只修 bug/文档。标注日期为 2026 年（Asia/Shanghai）。
> 每个版本对应的 git tag 与提交哈希见下方；推送前请先阅读根目录 `交付安排.md` §12（版本与上传状态）。

---

## v0.3.2 — 2026-10-22 · 上帝视角品牌统一为「群星」

- 浏览器标题：`群星 · 上帝视角 — 把 arXiv 全部开放论文排成可漫游的三维星系`
- 左栏字标：`群星 / GOD VIEW`，副标 `ALL-SKY OBSERVATORY / 上帝视角`（不再出现「论文云 / 研云」）。
- 仅改 `index.html` + `Hud.tsx` 文案；星空渲染与左右栏布局不动。

---

## v0.3.1 — 2026-10-22 · 上帝视角左右侧栏视觉重设计（对齐群星私人天文台）

**范围（严格）**
- 只改 `src/ui/Hud.tsx` + `src/styles.css` 的左右侧栏；**不碰 3D 星点/星空渲染**，
  选中星浮动标签、hover 论文名、星点着色/密度/亮度全部保持原样（已核对 CSS 与未改 three 代码）。
- 左栏：研云 · GOD VIEW 字标 + 四格遥测（PAPERS/FIELDS/READY/POINTS）；
  编号章节 01 星团目录 / 02 观测控制 / 03 排列与检索；目录行更紧凑，底部加星表读数。
- 右栏：选中论文面板改为 OBSERVATION LOG / 观测记录 气质。
- 飞行提示仍留在左栏内，不新增底部浮条；不改变画布交互。

**验收**
- `pnpm build` / `vitest` 250 passed / `verify:layout` / `verify:mobile` / `verify:css` / `verify:a11y` 全绿。
- 截图：`shots/lunyun-after.png`、`shots/lunyun-selection.png`。

---

## v0.3.0 — 2026-10-21 · 用户自带 key（BYOK）+「数据源」面板

**新增**
- `src/state/apiKeys.ts`：用户 key store（localStorage 四键 + `apiKeyHeaders()` 唯一出口）。
- `src/ui/SourcePanel.tsx` + HUD「数据源」入口：粘贴/测试/清除 S2、OpenAlex key 与 mailto；
  列出「这个 key 能用哪些数据源」（arXiv 本地语料 / Semantic Scholar / OpenAlex）。
- `deploy/probe-source-keys.mjs`：BYOK 端到端验收（10 条，约 2 分钟）。
- `src/state/apiKeys.test.ts`：12 项单测。

**服务端**
- `/api/refs`：请求头 `x-user-s2-key` / `x-user-openalex-key` / `x-user-openalex-mailto`
  **优先于内置 key**；响应新增 `auth:{s2,openalex} = user|builtin|anonymous`（不回显/不落盘 key）。
- 新增 `GET /api/sources`、`GET /api/key-check?provider=s2|openalex`（用你的 key 发一次最小查询）。
- `allowLiveRefs`：没有静态引用表的学科，点星时也可从数据库实时取（默认关，首次需建索引 10–30 秒）。
- 修复：服务端索引 OOM（`--max-old-space-size=8192` + in-flight 去重 + 全局串行队列）。

**验收**
- `probe-source-keys` 10/10 PASS；`vitest` 250 passed / 1 skipped；`verify.mjs` 全绿；
  `lint-embedded` 100 文件；`snap` 15.18 / 24.47 / 0.386（同一时刻抖动内）。
- 提交：`1c751ce`（功能）+ `3f7d6e7`（版本记录）· tag `v0.3.0`

---

## v0.2.0 — 2026-10-21 · GPU 拾取 / 居中验证 / OpenAlex 反查

**新增**
- `src/three/gpuPick.ts`：GPU 颜色 ID 拾取（`aId` + PickMaterial + `camera.setViewOffset` 小窗口读回）。
- `deploy/probe-pick.mjs`（拾取验收）、`deploy/probe-focus.mjs`（居中验收）、
  `deploy/probe-openalex-cites.mjs`（OpenAlex 反查验收）。

**修改**
- `StarPicker`：CPU 投影 → GPU 拾取；悬停节流 250ms → 60ms；交互语义不变。
- `Galaxy`：StarLayer 几何加 `aId`；调试桥加 `pickAt/pickStats/pickWindow/starVisible/visibleSample`。
- `api-refs`：OpenAlex 补 `filter=cites` 反向；按 mode 只取所需方向；429 单次退避。

**验收**
- 拾取中位：305k **0.7ms** / 3.05M **1.8ms**（旧 CPU 等价基准 26.5 / 215.5ms）；
  正确性：点到不可见星 0、点空 0、固定点 99/99。
- 居中 PASS 8/8（相机移动 26.8 单位，锁定距离 18，偏差 3.33px）。
- OpenAlex `physics/1`：`mode=cites` in 0→16；`vitest` 238 passed；`verify.mjs` 全绿。
- 提交：`99cd8d7`（tag `v0.2.0`）

---

## v0.1.0 — 2026-10-21 · 交付基线

- 首份交接文档 `交付安排.md`：项目定位、已完成功能清单、已知问题根因、文件地图、开发纪律、
  密钥与数据、复验命令。
- 既有能力：305 万点星系、GPU 着色/叠加混合、LOD 精选、检索、三种排列、层级下潜、
  点星取引用（S2 + OpenAlex）、HUD/论文面板、大量自检脚本。
- 提交：`fb05eeb`（tag `v0.1.0`）

---

## 版本之外：数据源接入边界（2026-10-21 讨论记录）

用户问"有自己付费数据库 key 是不是也能用"。结论记录在这里，避免以后重复讨论：

| 数据源类型 | 能否填 key 直接用 | 说明 |
|---|---|---|
| Semantic Scholar / OpenAlex（含付费/免费 key） | ✅ 能 | 已有完整适配器；key 优先级高于内置 |
| 有公开 REST API + key 的库（Crossref、CORE、Dimensions 等，视条款） | ⚠️ 需加适配器 | 端点/认证/分页/字段解析 + 映射回 arXiv docId；不是"填 key 就行" |
| Web of Science / Scopus / IEEE / CNKI 等机构库 | ❌ 不能 | 多为机构 IP / OAuth / 专用客户端，无第三方按需公开 API；需机构网络或导出文件 |
| 任何库的导出文件（BibTeX / CSV / RIS） | ⚠️ 另一条路 | 可做「导入引用文件」：作为该篇的引用覆盖/缓存，不依赖 API、不碰许可灰区 |

三条不变的前提：
1. **接上外部库也不会扩充星图语料** —— 星图固定为本地 arXiv 3,052,327 篇；
   外部数据只补「这篇引用了谁 / 谁引用了它」的连线与库外论文列表。
2. **许可**：`data/refs-cache/` 会落盘复用；付费库条款常禁止缓存/再分发，接之前须确认。
3. **安全**：用户 key 只存浏览器 localStorage、只发给 `127.0.0.1` 的本地服务，不回显、不落盘、不记日志。
