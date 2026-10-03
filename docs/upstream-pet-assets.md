# 上游「pet」开源项目美术资源导入 · 方法与合规说明

本文件说明 `resources/builtin-pets/` 中**非本项目自产**的宠物资源、以及
`resources/pet-asset-library/` 中的静态素材是怎么来的、按什么规则筛的、如何复现。

> 结果报告（含排序表、逐项目处置账本与统计）见 `docs/upstream-pet-assets/report.md`；
> 第三方资源归属声明见 `resources/builtin-pets/ATTRIBUTION.md`。

---

## 1. 流水线（5 个阶段，全部可复现）

| 阶段 | 脚本 | 产物 | 说明 |
|---|---|---|---|
| 1 检索 | `scripts/research/github-pet-rank.mjs` | `.pet-research/candidates.json` | GitHub search API，13 组查询（主检索严格用关键字 `pet`），`per_page=100`，未认证限速 10 次/分钟；响应全部落盘缓存，重跑不重复请求 |
| 2 下载量 | `scripts/research/github-pet-downloads.mjs` | `.pet-research/downloads.json` | GitHub Release 资源下载量（core API 60 次/小时，脚本读 `/rate_limit` 主动等待重置）+ npm 月下载 + PyPI 月下载 |
| 3 资源清点 | `scripts/research/github-pet-assets.mjs` | `.pet-research/assets-inventory.json` + `E:\pet-asset-scratch` | 取源 → 选择性解包 → 逐文件**魔数嗅探**（不信任扩展名） |
| 4 排序与判定 | `scripts/research/rank-report.mjs` | `.pet-research/ranking.{json,csv,md}` | 综合分、许可分层、相关性判定、入选标记 |
| 5 归一化集成 | `scripts/pets/import_pet_assets.py`（+ `scripts/pets/petart.py`） | `resources/builtin-pets/<id>/`、`resources/pet-asset-library/`、`resources/builtin-pets/ATTRIBUTION.md`、`.pet-research/import-report.json` | 用 Pillow 归一化画布、写清单、写资源库索引与归属声明 |

复现：

```bash
node scripts/research/github-pet-rank.mjs --force
node scripts/research/github-pet-downloads.mjs --top=60
node scripts/research/github-pet-assets.mjs --pool=relevant --top=120 --concurrency=4
node scripts/research/rank-report.mjs --top=40
python scripts/pets/import_pet_assets.py --dry-run     # 先看计划
python scripts/pets/import_pet_assets.py --write --projects 20
node scripts/pets/write-report.mjs                     # 生成 docs/upstream-pet-assets/report.md
npm test                                               # 含 importedPets.spec.ts：真实解析器 + sha256 + 帧尺寸
npm run package                                        # 验证 extraResource 把资源带进打包产物
node scripts/pets/verify-package.mjs                   # 打包产物与源资源逐文件 sha256 比对
```

---

## 2. 排序指标（星标/收藏 + 下载频次）

- **favourites** = GitHub `stargazers_count`（星标即「收藏」；`forks_count` 作为次级信号记录但不参与打分）
- **downloads** = GitHub Release 资源 `download_count` 合计 ＋ npm 月下载量 ＋ PyPI 月下载量
  （任一来源缺失记 0，并在数据里标 `downloadsKnown=false`，绝不臆造数值）
- **归一化**：`norm(x) = log1p(x) / log1p(max)`，压缩长尾、量纲无关
- **综合分**：`0.5 × norm(stars) + 0.5 × norm(downloads)`（星标与下载量等权）
- 并列打破：stars ↓ → downloads ↓ → fullName

> 局限：GitHub 未认证 API 有额度上限，Release 下载量只对**进入清点池**的仓库采集；
> 未采集下载量的候选其下载量记为 0 并在 `ranking.csv` 中标记，因此头部名次可信度高于长尾。

---

## 3. 许可分层（决定「能不能打包进本项目」）

本项目是 MIT。把第三方资源纳入分发属于再分发行为，因此**只打包 A 层**：

| 层 | 含义 | 处理 |
|---|---|---|
| **A 可打包** | 仓库级或**资源目录级**宽松许可（MIT / Apache-2.0 / BSD / ISC / CC0 / CC-BY(-SA) / MPL-2.0 / OFL / Unlicense…） | 归一化后纳入 `resources/`，写入归属声明 |
| **B 未声明** | 无 LICENSE / `NOASSERTION` | **只登记不复制**（清单里记录其美术资源存在，但不落盘分发） |
| **C 传染性** | GPL / AGPL / LGPL | 不打包（会把 MIT 项目拖入传染性许可） |
| **D 受限** | `All rights reserved` / 非商用 / 禁止改编 / 仅供学习 | 不打包 |

**判定证据只采信三处**：仓库根目录的 LICENSE/COPYING、**资源目录内**的 LICENSE、根 README 的授权段落。
**绝不采信依赖目录里的第三方许可证**——否则会出现两类反向错误（实测中都发生过）：

- `Adrianotiger/desktopPet` 本身无 LICENSE，但仓库里 vendored 依赖带 MIT 文件 → 早期规则误判为 A（**实际不可打包**）；
- `PC2005-cloud/dsh-pet` 代码是 MIT，但仓库内有 `All rights reserved` 声明 → 早期规则误判为 D（**保守不打包**）。

---

## 4. 相关性判定（避免「pet 只是子串」污染）

`pet` 是子串会命中大量无关项目（`petl` 数据管道、`pettingzoo` 强化学习库、`petit-dom`、
`HotPEToolBox`（WinPE）、`petclinic`/`petastorm`/`petgraph`…）。本项目按**语义**判定相关性：

```
desktop pet | virtual pet | digital pet | tamagotchi | shimeji | 桌宠/桌面宠物/虚拟宠物/电子宠物 | mascot
| pet-(game|simulator|companion|robot|project|assistant) | pets?\b
```

（`pets?\b` 的词边界保证 `petl`、`PettingZoo`、`petit` 不命中；同时结合 topic 白名单。）
不相关的项目即使星标/下载量很高也不入选，并在报告里给出排除理由。

---

## 5. 画布归一化（为什么必须这样做）

渲染端对 cover 与动作帧使用同一缩放公式 `min((W-60)/w, (H-60)/h)`，逐帧不做对齐修正。
因此**「每帧裁紧再各自居中」会导致播放抖动**。导入器采用：

1. 对同一段动画先求**所有帧的并集包围盒**（union bbox）；
2. 用**同一个**缩放系数、**同一个**锚点（脚底基线 `y=452`、水平居中）把每帧放进同尺寸画布；
3. 去背三级降级：自带 alpha → 直接用；四角纯色 → 自边界 flood fill + 1px 羽化；背景复杂 → 整图等比放入（rect 模式，绝不静默丢弃）；
4. 输出确定性 PNG（固定压缩参数、无时间戳），并在 PNG 的 tEXt 里写入 `Source / License / OriginalPath / Role`。

`src/main/importedPets.spec.ts` 会校验：真实解析器接受清单、帧与封面存在且 **sha256 一致**、
同一宠物内帧尺寸一致、许可与来源字段齐备。

---

## 6. 功能扩展：上游静态素材资源库

只有帧序列/动图能直接当动作；静态立绘/图标原本无处可用。为此新增：

- 磁盘：`resources/pet-asset-library/<repoSlug>/<name>.png` ＋ `index.json`（来源仓库、许可、原始路径、sha256）
- 主进程：`src/main/petLibrary.ts`
  - `library.list` 只回元数据（素材可能上千张，一次性回 dataUrl 会撑爆 IPC）
  - `library.read` 按需回单张 dataUrl（渲染端预览）
  - `library.apply` **设为形象**：复制进 `userData/pet-library/` 并走既有 `petAssetPath + petAssetFormat='image'` 链路，同时让出内置演示宠物（形象互斥）
  - `library.add-action` **加为动作**：复用 `actions:add-frames` 包成单帧动作，宠物窗可播放、可绑定互动
- 渲染端：`src/components/PetResources.tsx` 新增「上游资源库」区块（筛选 / 预览 / 设为形象 / 加为动作）
- 打包：`forge.config.ts` 的 `extraResource` 增加 `./resources/pet-asset-library`

因此「导入的素材」与「可被用户使用的素材」是同一条链路，不存在下了却用不上的孤儿文件
（测试里会反向检查资源库目录里的 PNG 是否全部登记在索引中）。

### 6.1 矢量素材（SVG）

Pillow 不能栅格化 SVG（旧版会把这类文件记成「解码失败」而丢弃）。现在：

- SVG 走**独立的矢量通道**登记进资源库（`format: "svg"`，原样保留 + sha256 + 来源/许可），
  UI 中标注「矢量（仅预览）」并可用 `<img>` 预览；
- 「设为形象 / 加为动作」对矢量素材**明确拒绝并给出提示**，而不是静默生成坏宠物；
- 需要把矢量转成可播放素材时，使用可选工具
  `scripts/pets/rasterize-svg.cjs`（用项目自带 Electron/Chromium 栅格化，带透明通道）：

  ```bash
  node_modules\electron\dist\electron.exe scripts\pets\rasterize-svg.cjs \
      E:\pet-asset-scratch\repos\<owner>__<repo> --out=E:\pet-asset-scratch\svg-png --size=512
  ```

  该工具**不在默认管线内**：Chromium 栅格化结果与 DPI/版本相关（实测 150% 缩放输出 770×768、
  100% 输出 512×512），而本管线要求「跑两遍无 diff」，因此默认只登记、不自动栅格化。
  注意：Electron 需以浏览器模式启动，若环境里设了 `ELECTRON_RUN_AS_NODE=1` 要先清掉该变量。

---

> **分类标准已升级（重要）**：本文第 4/6 节描述的是「按路径策略筛选角色美术」的早期口径。
> 现在导入侧统一采用《宠物本体资源分类标准》（12 个角色 + 6 层判定顺序 + 两种证据策略）：
> `src/shared/petResource.ts`（运行期，宽松策略）⇄ `scripts/pets/pet_roles.py`（抓取侧，严格策略），
> 设计动机、反例证据与落地范围见 [`.trae/documents/pet-resource-system-refactor.md`](../.trae/documents/pet-resource-system-refactor.md)。
> 严格策略下：只有**结构性证据**（清单声明 / 本体目录 / 模型扩展名 / 弱状态目录 + 透明通道）才算宠物本体；
> 界面件、表情包、道具、贴图、品牌、文档图、无法判定者一律不入包（fail-closed）。

> **2026-10-03 缺陷修复（重要）**：复核发现「透明通道」曾被当成**可以单独成立**的本体证据，
> 于是键盘键帽精灵、按钮三态（normal/hover/pressed）、贴图集这些「同目录同前缀、尺寸一致、天然带 alpha」
> 的界面件会稳定地伪装成帧序列动画，被装进 `resources/builtin-pets/` 当宠物（实测：BongoCat 的
> `left-keys/Num0.png`、qqpet 的 `iconList/sysSeting/help/stateInfo/img_res/medicine`、VPet 的
> `README.assets`、MonsterEOS 的 `frontend/.../arenas`）。修复分三步：
> 1. 严格模式下**编号序列不再接受透明通道单独作证**（必须落在本体目录，或弱状态目录 + 透明通道）；
> 2. 补齐真实语料的复合目录名子串标记（`readme/tutorial/arenas/iconlist/loginpanel/onlinequitprompt/
>    sysseting/stateinfo/leftkeys/rightkeys/medicine/imgres` + `help`）；
> 3. TS 孪生补齐 `uigraphics/uikit/iconfont` 与**目录名归一化**，消除两份实现的口径分裂。
>
> 修复后以 `--clean --write` 整表重建：**12 个项目 / 29 只宠物 / 71 个动作 / 636 帧 / 286 张资源库**
> （重建前为 17 / 53 / 161 / 960 / 289，多出的 24 只即被判定为非本体的错误宠物）。
> 逐条复核与取舍见重构文档第 6/8 节。复现导入器需要 `numpy + Pillow`，已收拢到
> `Environment/toolchains/pyenv`（见 `Environment/README.md`）。

## 7. 工程约束与已知限制

- **网络通道**：本机 `github.com:443` 不可达（`git clone` 实测 3 次仅 1 次成功），
  故取源改用 `codeload.github.com` 的 zipball（不消耗 API 额度、自带完整文件清单、流式限字节），
  超限仓库回退 `git/trees` API + `raw.githubusercontent.com` 只拉美术文件。
- **Git LFS**：`zipball` 里是 LFS 指针（形如 `version https://git-lfs.github.com/spec/v1`），
  嗅探阶段即判为不可解码并单独计数，绝不当成可用素材。
- **加密/专有格式**：Live2D `.moc3`、Spine `.skel/.atlas`、Unity `.assetbundle`、加密 `.dat/.bin` 等
  判为不可解码，只登记不打包（符合「只取未加密美术资源」）。
- **体积上限**：单仓库动作帧、资源库张数、宠物数均有上限（脚本参数可调），
  超限部分记入 `import-report.json` 的排除账本（含原因），不静默丢弃。
- **未声明许可的项目**：不打包，仅在报告中列出（如需使用请先取得作者授权）。
