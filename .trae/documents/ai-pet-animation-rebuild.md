# AI 生成宠物动画功能重建计划

> **【已废弃 2026-09-19】**：本计划对应的全部功能（路径A 动画宠物 / 路径B Live2D 生成 / 五状态变换动画 / 绿幕抠图管线 / AI 生成动作）已按用户指令整体删除，仅保留平台上传页「AI 扣取」面板（SubjectExtractionPanel，@imgly/background-removal 纯前端）。本文仅作历史存档。

> **2026-09-19 方案变更（路径A）**：按用户指令「不需要生成视频，动画依靠图片的晃动/位移/旋转实现，使用免费方案」，路径A 已整体重构并落地：
> - **新路径A = 动画宠物**：基准立绘（细化→CogView/Seedream 出图→绿幕抠图）→ 五状态**变换动画**（整图 dx/dy/rotation/scale 关键帧，LLM 设计：星火 lite→glm-4-flash，失败回退内置模板），全程免费、无视频、无 ffmpeg。
> - **资产契约**：zip（`main.png` + `animations.json`），animations.json 首字段 `{renderMode:'transform', animations:{idle:{loop,duration,keyframes:[{t,dx,dy,rotation,scale}]},...}}`；商店 format 沿用 `'image'`，客户端按 renderMode 判别并注册 5 条 transform 动作（setStateActions）。
> - **播放端**：客户端 `src/renderer/transformAnimator.ts`（状态驱动关键帧插值，手动动作让位、200ms 缓回中性）；关键帧首末强制中性姿态保证状态切换平滑。
> - **接口**：平台 `POST /ai/animated-pet`（原 sprite-pet 删除）+ `GET /ai/jobs/:id`；客户端 IPC `ai:generate-pet`（原 ai:generate-sprite）；平台/客户端各自流水线 2 步（base→anims），约 1-2 分钟。
> - 下文万相 i2v / ffmpeg / 精灵表相关描述仅作历史参考，已全部移除实现（dashscope.ts、spritesheet.ts、ffmpeg-static 均已删）。

## Context（背景与目标）

现有「AI 生成宠物」功能（后端三智能体链路：生成→检测→抠图→检测，+ 前端参数化 Canvas 派生 image/gif/live2d/model3d）整体删除，按用户提供的《AI生成宠物动画功能——可实施方案》重头实现：

- **路径A 精灵表**：基准立绘 → 通义万相图生视频（保证帧间一致性）→ ffmpeg 截帧 → 透明化 → 6列×5行精灵表 → PixiJS SpriteAnimator 播放
- **路径B Live2D**：基准立绘 → See-through 拆层（本机 N 卡 conda 环境）→ PSD2Live 自动建模 → .moc3 + .model3.json
- **五状态绑定**：idle/moving/eating/resting/playing ↔ 现有 petStore（hunger/energy/mood、feed/rest/play）
- **双轨架构**（用户已确认）：平台 Key 走平台后端生成；用户自备 Key 在客户端本地生成（提供商列表与平台同款）
- **API**：图生视频用通义万相（阿里云百炼 DashScope，用户有 Key）；基准图沿用免费链路（星火/智谱细化 + CogView-3-Flash，配 ARK_API_KEY 时用 Seedream）
- **删除边界**（用户已确认）：参数化 Canvas 宠物链路一并删除；「文件上传→商店→下载」链路保留；客户端聊天/主动对话/AI 动作不受影响

## 关键技术结论（已查证）

- **万相图生视频 API**（help.aliyun.com 百炼）：异步任务制。`POST /api/v1/services/aigc/image2video/video-synthesis`（Header `X-DashScope-Async: enable`，Authorization Bearer）→ `task_id` → 轮询 `GET /api/v1/tasks/{task_id}` → `video_url`。模型 `wan2.2-i2v-flash`（480P ¥0.1/秒、5s 固定、30fps MP4）；API 调用默认无水印。输入图支持 Base64。5 状态 × 5s × 480P ≈ **¥2.5/只**
- **See-through**：GitHub `shitagaki-lab/see-through`（代码+权重已开源，arXiv:2602.03749），另有 ComfyUI 节点 `jtydhr88/ComfyUI-See-through`。单张动漫立绘 → 分层 PSD（带深度排序、遮挡修复）。RTX 级 GPU 实时推理
- **PSD2Live**：⚠️ 未检索到官方下载源。按用户方案文档的 `psd2live-cli.exe --input xxx.psd --output ./models --auto-rig` 流程设计；**实施 M6 第一步先验证可获取性**，不可用则降级（见风险）
- **客户端现状**（探索确认）：
  - 设置体系：`src/main/config.ts`（LLM/ActionLLM 配置 + loadConfig/saveConfig）；UI 在 `ChatPanel.tsx`（llm 表单）与 `ActionsPanel.tsx`（actionLLM 覆盖）
  - 状态系统：`src/store/petStore.ts` — hunger/mood/energy/affection + feed/play/rest/decay
  - 渲染分流：`src/App.tsx` L1085-1089（model3d→initThree / live2d→initLive2D / 其余 Pixi）
  - 资产形态推断：`src/main/platformClient.ts` L164-173 resolveFormat（live2d-lite.json/model3.json→live2d、glb→model3d、多图→pack）
  - 资产安装目录：`userData/pets` 与 `userData/pet-actions`（petaction:// 协议服务）
- **平台现状**：`platform/backend/src/ai/` 为独立 AiModule（仅 AiController+AiService，全是生成功能，可整删）；上传/下载在 `pets.controller.ts` L90-147/L241-249（保留）；UploadPage AI 挂载点 L11-13、L98-116、L274-302；api.ts AI 段 L173-235

## 核心设计决策

1. **路径A 简化**：不按方案原文生成「各状态首尾帧」（图像模型难以保证与基准一致），改为**基准图即首帧**——透明基准 PNG 合成绿幕底色（沿用 #E9FFEB）后直接送万相 i2v，提示词描述该状态动作+循环。帧间一致性由视频模型天然保证，比首尾帧方案少 10 次图像调用且更稳
2. **截帧后抠图复用绿幕逻辑**：视频背景即绿幕底色，逐帧按行基准估背景色 + 洪泛抠图（重写精简版，思路同旧 petCutout）；全部帧用基准图统一 bbox 裁剪对齐，避免帧间抖动
3. **异步任务制**：5 状态 × 1-5 分钟视频生成，HTTP 同步不可行。后端内存 JobStore（Map，重启丢失可接受），`POST /ai/sprite-pet` 返回 jobId，前端轮询 `GET /ai/jobs/:id`（含每状态进度）
4. **精灵表资产格式**：zip（`spritesheet.png` + `animations.json`），`animations.json` 按方案：`{renderMode:'sprite', animations:{idle:{row,frames,fps},...}}`；商店 format 值新增 `'sprite'`；客户端 resolveFormat 加 zip 内 animations.json 识别
5. **moving 实现**：新增窗口级随机漫步（主进程 setBounds 左右平移，精力>30 且开关开启、随机间隔），绑定 moving 动画
6. **Live2D 五状态驱动**：PSD2Live 产出自带 idle 循环；eating/resting/playing 优先播模型 motion，缺失时参数级模拟（ParamEyeLOpen→0 闭眼、呼吸/摇摆幅度随状态调整）

## 删除清单（M0）

**后端**（`platform/backend/src/`）：
- 整目录 `src/ai/`：ai.module.ts、ai.controller.ts、ai.service.ts、painting-agent.ts、cutout-agent.ts、detect-agent.ts
- `app.module.ts`：移除 AiModule import 与注册

**平台前端**（`platform/frontend/src/`）：
- `components/AiPetGeneratorPanel.tsx`（整文件）
- `utils/petGif.ts`、`utils/petLite.ts`、`utils/pet3d.ts`、`utils/petCanvas.ts`（已确认仅 AI 面板引用）
- `api.ts`：删 L173-235 AI 段全部函数与类型（PetGenFormat/PetGenResult/PetRefineResult/PaintFraming/DetectReport/PaintingResourceResult/CutoutAgentResult/AiGenMeta）
- `pages/UploadPage.tsx`：删 AiPetGeneratorPanel import（L11-12）、PetDesign 类型引用（L13）、handleApplyAiPet（L98-116）、面板挂载块（L274-302）

**不动**：pets/assets 上传下载端点、客户端全部代码、聊天/主动对话/AI 动作。

## 实施步骤

### M1 后端新 ai 模块骨架 + 基准图链路
新建 `platform/backend/src/ai/`（全部重写）：
- `ai.module.ts` / `ai.controller.ts`：`POST /ai/base-image`（描述→LLM 细化提示词→CogView/Seedream 出图→绿幕抠图→透明基准 PNG + bbox 元数据）
- `prompt-agent.ts`：精简版提示词细化（星火/智谱免费模型，Key 缺失用本地模板兜底）；绿幕约束提示词沿用项目既有规范（浅绿 #E9FFEB 平涂、无阴影光晕、全身正面、四边留白）
- `image-gen.ts`：CogView-3-Flash（免费）与 Seedream（ARK_API_KEY 时）双路由
- `cutout.ts`：精简绿幕抠图（四边估背景色→逐行基准→洪泛→绿残差清扫→羽化），服务于基准图与后续截帧
- `.env` 新增 `DASHSCOPE_API_KEY=`（占位，用户已有 Key 填入）

### M2 路径A 后端：精灵表流水线
- `dashscope.ts`：万相 i2v 封装（base64 首帧 + 提示词 → 任务提交 → 轮询 → video_url 下载）
- `ffmpeg`：依赖 `ffmpeg-static` npm 包（免系统安装）；`ffmpeg -i video.mp4` 每状态均匀截 6 帧
- `spritesheet.ts`：逐帧抠图 → 统一 bbox 裁剪 → 6列×5行拼合（每格 256×256）→ 生成 `animations.json`
- `jobs.ts`：内存 JobStore（状态机：pending→base→per-state(0-4)→assembling→done/failed，含进度与错误信息）
- 路由：`POST /ai/sprite-pet`（body: description）→ `{jobId}`；`GET /ai/jobs/:id` → 进度/结果（spritesheet dataUrl + animations.json + 预览帧）
- 五状态提示词模板表（常量）：idle 呼吸轻晃 / moving 左右平移弹跳 / eating 低头咀嚼 / resting 蜷缩闭眼 / playing 跳跃旋转

### M3 平台前端：新 AI 生成面板
- 新 `components/AiPetStudioPanel.tsx`：描述输入 + 路径选择（精灵表/Live2D）+ 提交后轮询进度（状态行进度条）+ 完成预览（Canvas 上用 SpriteAnimator 播五状态，可点击切换）+ 「填入上传表单」
- `UploadPage.tsx`：挂载新面板；apply 时 file=zip（spritesheet+animations.json 由前端打包）、preview=代表帧、format='sprite'
- `api.ts`：新增 `startSpritePet()` / `getJob()` /（M6 加）`startLive2dPet()`

### M4 客户端：sprite 格式渲染
- 新 `src/renderer/spriteAnimator.ts`：按方案文档实现 SpriteAnimator（基纹理 + 行列矩形切分 + setAnimation/update）
- `platformClient.ts` resolveFormat：zip 内 `animations.json` → `'sprite'`；PetFormat 类型扩展
- `App.tsx`：petAssetFormat==='sprite' 分支（Pixi AnimatedSprite/自绘 ticker），纹理从 petaction:// 加载
- 平台端 `pets.controller.ts`：format 合法值加 `'sprite'`（与 'live2d' 共存）

### M5 客户端：五状态-动作绑定 + 随机漫步
- `petStore.ts`：新增派生状态（eating/playing/resting 由交互瞬时置位、moving 由漫步器驱动）；现有 decay 逻辑不动
- 新 `src/main/wander.ts`：随机漫步调度（精力>30 且 config 开关开启；setBounds 左右平移 + 随机间隔/幅度；边界回弹；与拖拽互斥）
- `App.tsx`：订阅 store → 状态优先级 eating > playing > resting(energy<20) > moving > idle → SpriteAnimator.setAnimation；feed/rest/play 交互触发对应状态动画（对齐 L261-281 既有交互播放逻辑）

### M6 路径B 后端：Live2D 流水线
- **先验证 PSD2Live 便携包可获取**（用户方案文档来源）；不可用走降级（见风险）
- See-through 本机部署：conda 环境（python 3.12 + torch cu128）+ `inference_psd.py`；后端 child_process spawn 调用（路径经 env `SEETHROUGH_PYTHON` 配置）
- `PSD2Live` CLI 封装（env `PSD2LIVE_HOME`）：分层 PSD → .moc3/.model3.json/.cmo3 → 打包 zip
- 路由：`POST /ai/live2d-pet` → jobId（复用 JobStore）；产出 zip + 预览图
- 上传格式：format='live2d'（客户端已有该格式识别与渲染）

### M7 客户端：用户自备 Key 本地生成
- `config.ts`：AppConfig 新增 `aiGen?: { dashscopeKey?: string; imageProvider?: 'cogview'|'seedream'; arkKey?: string; ... }`
- 新 `src/components/GenSettingsPanel.tsx`（或挂入 ChatPanel 设置区）：提供商 Key 填写（与平台同款列表：CogView/Seedream 图像 + 万相视频）
- 新 `src/main/aiGen.ts`：主进程流水线（DashScope 调用 + ffmpeg-static 截帧 + 简化绿幕抠图 + 拼表 + See-through/PSD2Live spawn）；IPC `ai:generate-sprite` / `ai:generate-live2d` / `ai:gen-job-status`，preload 暴露 `electronAPI.aiGen.*`
- 客户端本地生成结果直接写 `userData/pets/` 安装并切换（不经平台上传）

### M8 端到端验证与收尾
- `npx tsc --noEmit`：后端 + 平台前端 + 客户端三处全过
- 后端 build + 重启，`/api` 验活
- 真实链路测试（需 DASHSCOPE_API_KEY）：一只宠物走完 生成→预览→上传→商店→客户端下载→五状态播放 全流程；目检精灵表帧一致性（体型/配色不漂移、背景无残留、无水印）
- 性能抽查：精灵表动画 ≥30fps（Pixi 自绘 ticker 按 fps 配置步进，非 1:1 raf）
- 提交 GitHub（走既有 plumbing 绕过流程）

## 风险与应对

| 风险 | 应对 |
|---|---|
| PSD2Live 无官方可验证下载源 | M6 首项验证；不可用则降级：①See-through 产出分层 PSD 直接交付（用户可在免费版 Cubism Editor 手工完成绑定），②或 Live2D 路径改为「上传现成 moc3/model3.json」+ 状态驱动增强 |
| 万相视频背景不稳（绿幕渐变/偏色） | 提示词强调背景纯色不变；抠图按逐行背景基准自适应估色（容忍渐变）；不合格状态自动重试 1 次 |
| 帧间抖动 | 全帧统一基准图 bbox 裁剪 + 居中放格 |
| 生成耗时长（5-25 分钟） | 异步 JobStore + 前端进度轮询；状态间串行避免限流（RPM 120 充裕） |
| ffmpeg 打包体积 | ffmpeg-static 按平台二进制，仅后端与客户端主进程引用 |

## 验证命令备忘

- 后端：`cd platform/backend && npx tsc --noEmit && npm run build`，重启后 `curl http://localhost:3001/api/ai/meta`（新 meta 端点返回可用能力）
- 平台前端：`cd platform/frontend && npx tsc --noEmit && npm run dev`（5174）
- 客户端：`npx tsc --noEmit`；dev 启动验证五状态切换与漫步
