# GitHub「pet」项目美术资源导入报告

生成时间：2026-10-03｜方法说明见 [../upstream-pet-assets.md](../upstream-pet-assets.md)

## 1. 结论摘要

- 检索候选：**900** 个仓库（13 组查询，关键字 `pet` 主检索 + 桌宠/虚拟宠物/电子宠物等扩展检索）
- 资源清点：**148** 个仓库已取源并逐文件嗅探，其中含可解码美术 **129** 个
- 宠物语义相关且有可解码美术：**73** 个；其中许可可打包（A 层）**41** 个
- 实际导入项目：**12** 个（按综合分名次自上而下逐名下探，只有含「够格宠物本体」的仓库入选；已清点的候选池到此穷尽）
- 产出内置宠物：**29** 只 / 动作 **71** 个 / 帧 **636** 帧；上游静态资源库 **286** 张
- 逐文件处置：扫描到可解码美术 **8,603** 个 → 按分类标准判为**非宠物本体** 4,422 个（**这正是标准的目的：不入包**）、进入「宠物本体」范围 **4,181** 个
- 本体范围内：使用 **3,151**（75.4%）｜因体量上限未纳入 1,022（可调参数）｜解码失败 8｜账本未覆盖 **0**（必须为 0）

## 2. 指标与筛选口径

- 综合分：`0.5 * norm(log1p(stars)) + 0.5 * norm(log1p(downloads)), norm(x)=x/max over this pool`
- 下载量：GitHub Release asset download_count (paged/cached) + npm last-month + PyPI last-month
- 下载量覆盖度：55/900 个候选取得下载量
- 入选条件：宠物领域相关（语义判定）且有可解码美术资源（魔数嗅探通过）且许可分层为 A（宽松）或 E（开源非商用白名单）
- 许可层级分布（全部候选）：A=432、D=14、C=108、B=345、E=1

## 3. 入选项目（A 层许可 + 宠物相关 + 含可解码美术，按综合分排序）

| # | 项目 | ★ | 下载量 | 综合分 | 许可 | 可解码美术 | 导入宠物 | 动作 | 帧 | 资源库 | 入选依据（相关性） |
|---:|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|
| 1 | [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) | 23,750 | 1,627,429 | 1.0000 | Apache-2.0 | 141 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 2 | [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) | 14,834 | 638,464 | 0.9439 | MIT | 370 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 5 | [shinyflvre/Mate-Engine](https://github.com/shinyflvre/Mate-Engine) | 3,724 | 213,077 | 0.8370 | NOASSERTION | 487 | — | — | — | — | 主题标签命中宠物语义（desktop-pet） |
| 16 | [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) | 1,944 | 47,886 | 0.7526 | MIT | 150 | — | — | — | — | 主题标签命中宠物语义（desktop-pet） |
| 20 | [OpenPetsHQ/openpets](https://github.com/OpenPetsHQ/openpets) | 1,257 | 27,734 | 0.7118 | MIT | 133 | — | — | — | — | 主题标签命中宠物语义（desktop-pet） |
| 21 | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | 971 | 28,056 | 0.6994 | MIT | 150 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 22 | [MemTensor/memmy-agent](https://github.com/MemTensor/memmy-agent) | 2,008 | 9,142 | 0.6963 | MIT | 131 | — | — | — | — | 主题标签命中宠物语义（desktop-pet） |
| 25 | [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) | 716 | 25,748 | 0.6813 | MIT | 105 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 28 | [DoomVoss/BASpark](https://github.com/DoomVoss/BASpark) | 774 | 16,394 | 0.6694 | MIT | 2 | — | — | — | — | 主题标签命中宠物语义（desktop-pet） |
| 32 | [LorisYounger/VPet](https://github.com/LorisYounger/VPet) | 6,854 | 0 | 0.4383 | Apache-2.0 | 1,530 | 1 | 1 | 8 | 200 | 名称/简介命中宠物语义短语 |
| 34 | [infinition/Bjorn](https://github.com/infinition/Bjorn) | 6,316 | 0 | 0.4343 | MIT | 165 | — | — | — | — | 主题标签命中宠物语义（tamagotchi） |
| 50 | [legeling/awesome-codex-pet](https://github.com/legeling/awesome-codex-pet) | 1,051 | 0 | 0.3453 | MIT | 109 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 52 | [DasterProkio/awesome-ai-companion](https://github.com/DasterProkio/awesome-ai-companion) | 846 | 0 | 0.3346 | CC0-1.0 | 7 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 56 | [Playa-Cyrene/Cyrene-Agent](https://github.com/Playa-Cyrene/Cyrene-Agent) | 643 | — | 0.3210 | MIT | 465 | 0 | 0 | 0 | 72 | 主题标签命中宠物语义（desktop-pet） |
| 57 | [andremion/Theatre](https://github.com/andremion/Theatre) | 640 | — | 0.3207 | Apache-2.0 | 36 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 66 | [ykhli/AI-tamago](https://github.com/ykhli/AI-tamago) | 529 | — | 0.3113 | MIT | 1 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 76 | [ema/pets](https://github.com/ema/pets) | 463 | — | 0.3047 | MIT | 1 | — | — | — | — | 名称含 pet 词元且简介含宠物/角色语境 |
| 82 | [cifertech/TamaFi](https://github.com/cifertech/TamaFi) | 443 | — | 0.3025 | MIT | 41 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 84 | [Ido-Levi/claude-code-tamagotchi](https://github.com/Ido-Levi/claude-code-tamagotchi) | 433 | — | 0.3014 | MIT | 3 | — | — | — | — | 名称/简介命中宠物语义短语 |
| 89 | [HanaAyane/remielle-codex-pet](https://github.com/HanaAyane/remielle-codex-pet) | 411 | — | 0.2988 | — | 22 | 1 | 7 | 112 | 0 | 名称/简介命中宠物语义短语 |

> 「入选依据」列是该项目的宠物语义判定理由；许可层级与判定理由（含资源级/根级许可证据）见 `ranking.csv` 与本文第 4 节。
> 说明：部分项目本身是 AI 助手/桌面应用，其简介或主题明确包含「desktop pet / 桌宠」并随包分发宠物美术资源，因此按规则入选；
> 判定完全基于公开的名称/简介/主题字段，规则见 [../upstream-pet-assets.md](../upstream-pet-assets.md) 第 4 节，可逐条复核。

## 4. 综合排序 Top 40（含未入选者与理由）

| # | 项目 | ★ | 下载量 | 综合分 | 许可 | 层 | 宠物相关 | 可解码美术 | 入选 | 未入选原因 |
|---:|---|---:|---:|---:|---|---|:--:|---:|:--:|---|
| 1 | [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) | 23,750 | 1,627,429 | 1.0000 | Apache-2.0 | A | ✔ | 141 | ✔ |  |
| 2 | [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) | 14,834 | 638,464 | 0.9439 | MIT | A | ✔ | 370 | ✔ |  |
| 3 | [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) | 6,348 | 188,554 | 0.8592 | AGPL-3.0 | D | ✔ | 340 |  | 资源级受限声明 |
| 4 | [knqyf263/pet](https://github.com/knqyf263/pet) | 5,358 | 131,058 | 0.8380 | MIT | A |  | 8 |  | 宠物无关（pet 仅为子串） |
| 5 | [shinyflvre/Mate-Engine](https://github.com/shinyflvre/Mate-Engine) | 3,724 | 213,077 | 0.8370 | NOASSERTION | A | ✔ | 487 | ✔ |  |
| 6 | [Farama-Foundation/PettingZoo](https://github.com/Farama-Foundation/PettingZoo) | 3,524 | 212,625 | 0.8342 | MIT | A |  | 275 |  | 宠物无关（pet 仅为子串） |
| 7 | [petl-developers/petl](https://github.com/petl-developers/petl) | 1,319 | 733,520 | 0.8287 | MIT | A |  | 1 |  | 宠物无关（pet 仅为子串） |
| 8 | [crafter-station/petdex](https://github.com/crafter-station/petdex) | 4,185 | 41,012 | 0.7852 | MIT | A |  | 82 |  | 宠物无关（pet 仅为子串） |
| 9 | [uber/petastorm](https://github.com/uber/petastorm) | 1,894 | 121,808 | 0.7839 | Apache-2.0 | D |  | 4 |  | 宠物无关（pet 仅为子串） |
| 10 | [SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat) | 2,298 | 91,118 | 0.7833 | AGPL-3.0 | C | ✔ | 6 |  | 传染性许可 |
| 11 | [vuejs/petite-vue](https://github.com/vuejs/petite-vue) | 9,699 | 9,520 | 0.7758 | MIT | A |  | 0 |  | 宠物无关（pet 仅为子串） |
| 12 | [isHarryh/Ark-Pets](https://github.com/isHarryh/Ark-Pets) | 1,106 | 206,396 | 0.7757 | GPL-3.0 | C | ✔ | 4 |  | 传染性许可 |
| 13 | [VirtualHotBar/HotPEToolBox](https://github.com/VirtualHotBar/HotPEToolBox) | 2,251 | 52,821 | 0.7633 | MIT | A |  | 41 |  | 宠物无关（pet 仅为子串） |
| 14 | [PetoiCamp/OpenCat-Quadruped-Robot](https://github.com/PetoiCamp/OpenCat-Quadruped-Robot) | 5,413 | 14,995 | 0.7628 | MIT | A |  | 42 |  | 宠物无关（pet 仅为子串） |
| 15 | [petoolse/petools](https://github.com/petoolse/petools) | 1,201 | 105,347 | 0.7562 | MIT | A |  | 0 |  | 宠物无关（pet 仅为子串） |
| 16 | [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) | 1,944 | 47,886 | 0.7526 | MIT | A | ✔ | 150 | ✔ |  |
| 17 | [meridianlabs-ai/inspect_petri](https://github.com/meridianlabs-ai/inspect_petri) | 1,356 | 50,164 | 0.7363 | MIT | A |  | 9 |  | 宠物无关（pet 仅为子串） |
| 18 | [kushalpandya/Petrichor](https://github.com/kushalpandya/Petrichor) | 1,705 | 29,930 | 0.7296 | MIT | A |  | 18 |  | 宠物无关（pet 仅为子串） |
| 19 | [Adrianotiger/desktopPet](https://github.com/Adrianotiger/desktopPet) | 1,153 | 51,664 | 0.7293 | — | B | ✔ | 187 |  | 未声明许可 |
| 20 | [OpenPetsHQ/openpets](https://github.com/OpenPetsHQ/openpets) | 1,257 | 27,734 | 0.7118 | MIT | A | ✔ | 133 | ✔ |  |
| 21 | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | 971 | 28,056 | 0.6994 | MIT | E | ✔ | 150 | ✔ |  |
| 22 | [MemTensor/memmy-agent](https://github.com/MemTensor/memmy-agent) | 2,008 | 9,142 | 0.6963 | MIT | A | ✔ | 131 | ✔ |  |
| 23 | [NVIDIA/NVFlare](https://github.com/NVIDIA/NVFlare) | 978 | 23,969 | 0.6943 | Apache-2.0 | A |  | 425 |  | 宠物无关（pet 仅为子串） |
| 24 | [ChaozhongLiu/DyberPet](https://github.com/ChaozhongLiu/DyberPet) | 989 | 16,383 | 0.6815 | GPL-3.0 | C | ✔ | 210 |  | 传染性许可 |
| 25 | [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) | 716 | 25,748 | 0.6813 | MIT | A | ✔ | 105 | ✔ |  |
| 26 | [SeakMengs/WindowPet](https://github.com/SeakMengs/WindowPet) | 670 | 25,176 | 0.6773 | MIT | A |  | 69 |  | 宠物无关（pet 仅为子串） |
| 27 | [tonybaloney/vscode-pets](https://github.com/tonybaloney/vscode-pets) | 4,172 | 1,636 | 0.6724 | MIT | D |  | 557 |  | 宠物无关（pet 仅为子串） |
| 28 | [DoomVoss/BASpark](https://github.com/DoomVoss/BASpark) | 774 | 16,394 | 0.6694 | MIT | A | ✔ | 2 | ✔ |  |
| 29 | [bigscience-workshop/petals](https://github.com/bigscience-workshop/petals) | 10,602 | 206 | 0.6464 | MIT | A |  | 0 |  | 宠物无关（pet 仅为子串） |
| 30 | [steve02081504/fount](https://github.com/steve02081504/fount) | 691 | 2,160 | 0.5930 | NOASSERTION | B | ✔ | 9 |  | 未声明许可 |
| 31 | [spring-projects/spring-petclinic](https://github.com/spring-projects/spring-petclinic) | 9,554 | 0 | 0.4548 | Apache-2.0 | A |  | 7 |  | 宠物无关（pet 仅为子串） |
| 32 | [LorisYounger/VPet](https://github.com/LorisYounger/VPet) | 6,854 | 0 | 0.4383 | Apache-2.0 | A | ✔ | 1530 | ✔ |  |
| 33 | [function3d/petalot](https://github.com/function3d/petalot) | 723 | 21 | 0.4348 | NOASSERTION | A |  | 4 |  | 宠物无关（pet 仅为子串） |
| 34 | [infinition/Bjorn](https://github.com/infinition/Bjorn) | 6,316 | 0 | 0.4343 | MIT | A | ✔ | 165 | ✔ |  |
| 35 | [petgraph/petgraph](https://github.com/petgraph/petgraph) | 4,024 | 0 | 0.4119 | Apache-2.0 | A |  | 10 |  | 宠物无关（pet 仅为子串） |
| 36 | [topotam/PetitPotam](https://github.com/topotam/PetitPotam) | 2,280 | 0 | 0.3837 | — | B |  | 0 |  | 宠物无关（pet 仅为子串） |
| 37 | [spring-petclinic/spring-petclinic-microservices](https://github.com/spring-petclinic/spring-petclinic-microservices) | 2,210 | 0 | 0.3822 | Apache-2.0 | A |  | 12 |  | 宠物无关（pet 仅为子串） |
| 38 | [MetalPetal/MetalPetal](https://github.com/MetalPetal/MetalPetal) | 2,189 | 0 | 0.3817 | MIT | A |  | 32 |  | 宠物无关（pet 仅为子串） |
| 39 | [CollaboratingPlatypus/PetaPoco](https://github.com/CollaboratingPlatypus/PetaPoco) | 2,144 | 0 | 0.3807 | NOASSERTION | A |  | 8 |  | 宠物无关（pet 仅为子串） |
| 40 | [git-goods/gitanimals](https://github.com/git-goods/gitanimals) | 1,782 | 0 | 0.3715 | NOASSERTION | B | ✔ | 215 |  | 未声明许可 |

## 5. 排除分类统计（已清点范围内）

| 分类 | 数量 | 代表项目 |
|---|---:|---|
| 未声明许可（B 层，只登记不复制） | 17 | Adrianotiger/desktopPet、steve02081504/fount、git-goods/gitanimals、graceavery/tamagotchiTemp、FerryYoungFan/VirtualCockroach、Kritzkingvoid/Desktop_Gremlin 等 |
| 传染性许可 GPL/AGPL（C 层，不打包） | 12 | SlimeBoyOwO/LingChat、isHarryh/Ark-Pets、ChaozhongLiu/DyberPet、Zao-chen/ZcChat、useLexora/Lexora、ViciousSquid/Dosidicus 等 |
| 资源级受限（D 层，不打包） | 6 | rullerzhou-afk/clawd-on-desk、OpenBMB/MiniCPM-Desk-Pet、HELPMEEADICE/BANDORI-PET-REV、Hanzoe/Pet-GPT、sam70361/aora-bot、momori777/Artemis |
| 宠物无关（pet 仅为子串） | 71 | knqyf263/pet、Farama-Foundation/PettingZoo、petl-developers/petl、crafter-station/petdex、uber/petastorm、vuejs/petite-vue 等 |
| 宠物相关但无可解码美术 | 4 | timoschick/pet、jcrona/tamalib、wyuenho/emacs-pet、Xiazhixuan119748/codex-pet-and-imagegen |
| 未清点（下载量/资源未采集） | 752 | WhiteHouse/petitions、spring-petclinic/spring-framework-petclinic、petitparser/dart-petitparser、wh0amitz/PetitPotato、ilime/Petal、JinJieTan/peter-code 等 |

> 未声明许可（B）的项目**不是因为没有价值**，而是不能在 MIT 项目里再分发其美术资源。
> 若需使用，请先向作者取得授权，再用同一脚本（`--only=owner/repo --write`）导入。

### 5.1 「开源非商用」（E 层）已批准项目

这些项目**允许开源使用但禁止商用**，属逐仓白名单放行。放行前提是四项硬约束同时成立：
**① 本项目永久非商用；② 逐文件署名原作者；③ 随包附上游许可原文；④ 一旦商业化必须在发布前移除。**
硬约束与决议出处见 [../upstream-pet-assets.md](../upstream-pet-assets.md) §3。

| 项目 | ★ | 可解码美术 | 放行依据 |
|---|---:|---:|---|
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | 971 | 150 | 开源非商用白名单：根 README §许可：代码 MIT；素材（动画/提示词/源视频）「允许开源使用，禁止商用」+ 二创须署名原作者。经项目决议接受四项硬约束后放行 —— 见 .trae/documents/pet-video-actions-and-per-pet-cap.md 与 .trae/documents/pet-store-successor-design.md（D6/§四 第 1 条） |

### 5.2 因「没有够格的宠物本体」被跳过的项目（按名次下探）

分类标准要求资源包内至少有一个**够格本体**：模型（Live2D/3D）、动画（帧序列/动图/视频），
或尺寸 ≥128px 且有 alpha 的静帧。只含界面件/表情包/品牌/文档图/过小图标的项目一律跳过，继续下探名次。

| 名次 | 项目 | 角色分布 | 抽样（路径 → 角色 → 判定依据） |
|---:|---|---|---|
| 1 | ayangweb/BongoCat | ui×126、texture×9、unknown×6 | `resources/icons/tray-macos.png` → ui（目录标记 icons/：界面件目录）<br>`resources/icons/tray-windows.png` → ui（目录标记 icons/：界面件目录） |
| 2 | NanmiCoder/cc-haha | ui×66、unknown×80、texture×6、document×210、branding×8 | `desktop/public/app-icon.png` → ui（文件名标记：应用图标（界面件）（app-icon））<br>`desktop/public/app-icon.svg` → ui（文件名标记：应用图标（界面件）（app-icon）） |
| 5 | shinyflvre/Mate-Engine | unknown×152、document×9、ui×29、texture×296、body-still×1 | `Assets/Editor/sdk.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入））<br>`Assets/LLMUnity/Resources/llmunity_trash_icon.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 16 | xiufengsun/TokenTracker | unknown×120、ui×9、texture×3、document×18 | `dashboard/public/achievements/arctic-code-vault-contributor.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入））<br>`dashboard/public/achievements/big-day.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 20 | OpenPetsHQ/openpets | ui×4、texture×1、unknown×121、branding×2、document×5 | `apps/desktop/assets/app-icon.png` → ui（文件名标记：应用图标（界面件）（app-icon））<br>`apps/desktop/assets/default-pet-spritesheet.webp` → texture（文件名标记：模型贴图/精灵表（非独立动画帧）（default-pet-spritesheet）） |
| 22 | MemTensor/memmy-agent | unknown×78、ui×2、branding×7、body-animation×1、document×43 | `App/frontend/desktop/src/assets/agent-logos/claude-code.svg` → unknown（未知类型（ext=.svg）：不入包）<br>`App/frontend/desktop/src/assets/agent-logos/codex.svg` → unknown（未知类型（ext=.svg）：不入包） |
| 25 | MerZlin/dsh-pet-indesktop | unknown×33、document×72 | `assets/big_blue_fat_fish/big_blue_fat_fish.jpg` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入））<br>`assets/big_blue_fat_fish/big_coming.jpg` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 28 | DoomVoss/BASpark | branding×2 | `assets/logo.png` → branding（文件名标记：品牌标识（logo））<br>`pages/public/logo.png` → branding（文件名标记：品牌标识（logo）） |
| 34 | infinition/Bjorn | unknown×165 | `resources/images/static/AI.bmp` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入））<br>`resources/images/static/attack.bmp` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 50 | legeling/awesome-codex-pet | branding×3、unknown×5、body-cover×1、document×15、texture×85 | `assets/brand/chatgpt-app.png` → branding（目录标记 brand/：品牌/字体目录）<br>`assets/brand/codex-app-dark.png` → branding（目录标记 brand/：品牌/字体目录） |
| 52 | DasterProkio/awesome-ai-companion | unknown×7 | `assets/awesome-ai-companion-banner.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入））<br>`assets/awesome-ai-companion-icon.svg` → unknown（未知类型（ext=.svg）：不入包） |
| 57 | andremion/Theatre | unknown×9、body-animation×1、ui×26 | `art/clean.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入））<br>`art/data.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 66 | ykhli/AI-tamago | unknown×1 | `public/Tamagotchi.svg` → unknown（未知类型（ext=.svg）：不入包） |
| 76 | ema/pets | unknown×1 | `design.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 82 | cifertech/TamaFi | document×3、ui×38 | `PCB/PCB Dimension.jpg` → document（目录标记 PCB/：文档/示意目录（非本体））<br>`Schematic/BOM.jpg` → document（文件名标记：工程图（非角色美术）（BOM）） |
| 84 | Ido-Levi/claude-code-tamagotchi | unknown×3 | `assets/thoughts_demo.gif` → unknown（严格模式：无本体目录声明且无透明通道的动画（疑似录屏/宣传图）→ 不作为本体）<br>`assets/violation_example.jpeg` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 96 | ntd4996/agentpet | branding×2、unknown×34、document×7、ui×19 | `assets/banner.png` → branding（文件名标记：社交/宣传图（banner））<br>`assets/demo.gif` → unknown（严格模式：无本体目录声明且无透明通道的动画（疑似录屏/宣传图）→ 不作为本体） |
| 111 | Marksonthegamer/Mate-Engine-Linux-Port | unknown×150、document×8、ui×28、texture×295、body-still×1 | `Assets/Editor/sdk.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入））<br>`Assets/LLMUnity/Resources/llmunity_trash_icon.png` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 115 | six-nut/PocketMen-with-you | branding×4、document×1 | `assets/logo-128.png` → branding（文件名标记：品牌标识（logo-128））<br>`assets/logo-512.png` → branding（文件名标记：品牌标识（logo-512）） |
| 120 | yumiaura/myCat | document×3、unknown×9 | `docs/cat.gif` → document（目录标记 docs/：文档/示意目录（非本体））<br>`docs/classic.gif` → document（目录标记 docs/：文档/示意目录（非本体）） |
| 130 | jeppeman/android-jetpack-playground | ui×17、unknown×5 | `app/src/main/ic_launcher-playstore.png` → ui（文件名标记：应用/控件图标（界面件）（ic_launcher-playstore））<br>`app/src/main/ic_launcher-web.png` → ui（文件名标记：应用/控件图标（界面件）（ic_launcher-web）） |
| 143 | DD-MASTERT/AI-Girlfriend-Desktop-Pet | unknown×9、texture×2 | `config/123.jpg` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入））<br>`ico/1.jpg` → unknown（严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）） |
| 150 | Berational91/DigimonVPet | document×1 | `screenshot.jpg` → document（文件名标记：截图（文档/说明用）（screenshot）） |
| 157 | YashjitPal/BetterGravity | branding×6、unknown×12、ui×1、body-still×1、document×8 | `apps/installer/public/logo.png` → branding（文件名标记：品牌标识（logo））<br>`apps/installer/src/assets/logo.png` → branding（文件名标记：品牌标识（logo）） |
| 183 | MonsterEOS/monstereos | document×19、branding×3、unknown×237、ui×1 | `docs/assets/setupsh.png` → document（目录标记 docs/：文档/示意目录（非本体））<br>`logo-monster.png` → branding（文件名标记：品牌标识（logo-monster）） |

## 6. 逐文件利用率账本（每个取得的文件恰好一个处置）

| 处置 | 数量 | 含义 |
|---|---:|---|
| `excluded:cap-library` | 1,022 | 超过单仓库资源库上限 |
| `excluded:non-body` | 4,422 | 非宠物本体（界面件/表情包/品牌/文档图等，按分类标准排除） |
| `excluded:undecodable` | 8 | 解码失败（含 LFS 指针 / 专有格式 / 尺寸不一致） |
| `unaccounted` | 0 | 账本未覆盖（异常，应为 0） |
| `used:action` | 2,730 | 进入某只宠物的动作帧（已归一化为统一画布） |
| `used:dedup` | 135 | 与已入库素材内容相同（sha256 去重，内容仍可用） |
| `used:library` | 286 | 进入上游资源库（可设为形象 / 加为动作） |

> 口径说明：`excluded:non-body` 是**分类标准主动排除**的结果（界面件/表情包/品牌/文档图/无法判定），
> 不是利用率损失——被排除的东西本来就不该进宠物资源包。真正影响覆盖度的是 `excluded:cap-*`（体量上限），
> 它们由 `--max-frames-per-repo` / `--max-pets-per-repo` / `--max-library-per-repo` 控制，按需调大即可纳入更多。

### 逐项目账本

| 项目 | 取得 | 使用 | 排除 | 宠物 | 帧 | 资源库 | 账本覆盖 |
|---|---:|---:|---:|---:|---:|---:|:--:|
| LorisYounger/VPet | 1530 | 343 | 1187 | 1 | 8 | 200 | ✔ |
| Playa-Cyrene/Cyrene-Agent | 465 | 72 | 393 | 0 | 0 | 72 | ✔ |
| HanaAyane/remielle-codex-pet | 22 | 7 | 15 | 1 | 112 | 0 | ✔ |
| QCYTSN/dsh-dafeiyu | 2660 | 2604 | 56 | 16 | 244 | 1 | ✔ |
| rainnoon/oc-claw | 54 | 10 | 44 | 2 | 64 | 0 | ✔ |
| vlln/whale-girl | 32 | 9 | 23 | 0 | 0 | 9 | ✔ |
| blairjordan/codachi | 33 | 9 | 24 | 2 | 83 | 0 | ✔ |
| dee-dee-catorce/desksaw | 104 | 4 | 100 | 1 | 3 | 1 | ✔ |
| xuemian168/qqpet_automation | 3646 | 84 | 3562 | 4 | 88 | 0 | ✔ |
| ssssssanjiu/clawd-conduit | 7 | 2 | 5 | 1 | 30 | 0 | ✔ |
| kk43994/kkclaw | 37 | 4 | 33 | 1 | 4 | 0 | ✔ |
| 1190fasheqi/dafeiyu-pet | 13 | 3 | 10 | 0 | 0 | 3 | ✔ |

## 7. 复现命令

```bash
node scripts/research/github-pet-rank.mjs --force
node scripts/research/github-pet-downloads.mjs --top=60
node scripts/research/github-pet-assets.mjs --pool=relevant --top=120 --concurrency=4
node scripts/research/rank-report.mjs --top=40
python scripts/pets/import_pet_assets.py --dry-run
python scripts/pets/import_pet_assets.py --write --projects 20
node scripts/pets/write-report.mjs
npm test        # 含 src/main/importedPets.spec.ts：真实解析器 + sha256 + 帧尺寸一致性校验
npm run package # 打包，验证 extraResource 把资源带进产物
node scripts/pets/verify-package.mjs   # 打包产物与源资源逐文件 sha256 比对
```

## 8. 合规与限制

- 仅再分发 A 层（宽松许可）项目的美术资源，并在 `resources/builtin-pets/ATTRIBUTION.md` 逐项目标注来源、许可、原始路径与修改方式。
- B/C/D 层项目的美术资源**不落盘**，仅在报告中登记（含理由）。
- 加密 / 专有 / Git LFS 指针类素材判定为不可解码，不计入导入。
- 本机 `github.com:443` 不可达，取源采用 codeload zipball（无 API 额度消耗）；超大仓库回退 trees+raw，个别仓库（如 VPet、Mate-Engine）在本网络下取源失败，已在账本中标记为未清点。
- Release 下载量受未认证 API 额度限制，仅对进入清点池的仓库采集；未采集者按 0 计并在 CSV 中标注 `downloadsKnown=false`。
