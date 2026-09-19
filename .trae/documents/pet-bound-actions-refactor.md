# 重构：动作挂靠宠物 + 宠物多形态（单图/模型包/3D）

## Context

用户指出当前动作系统设计错误：动作是可跨宠物安装的独立平台资源，但实际上**每个宠物的动作是不同的，动作根据宠物生成，不可通用**。同时明确三点需求：

1. 动作全部随宠物走：移除商店独立"动作"资源类型；动作隶属于宠物，随宠物上传/安装
2. 宠物三种形态：`image` 单图（现状）、`pack` 多图模型包（zip，PixiJS 2D）、`model3d` 3D 模型（glb/gltf，three.js）
3. "改变造型的图片"类动作 = 1 帧帧序列：播放期间整体贴图切换、结束恢复原形象（现有 frames 播放 onComplete 已满足，N=1 即造型图，无需新 kind）

分两个阶段：阶段一完成动作挂靠 + image/pack 形态；阶段二完成 3D。

---

## 阶段一：动作挂靠宠物 + image/pack

### 后端（platform/backend，synchronize:true 自动迁移）

**数据模型**
- [pets/pet-asset.entity.ts](file:///e:/desktop-pet/platform/backend/src/pets/pet-asset.entity.ts)：加 `format` enum 列 `['image','pack','live2d','model3d']` default 'image'（一次加齐四值）
- [actions/action-asset.entity.ts](file:///e:/desktop-pet/platform/backend/src/actions/action-asset.entity.ts)：加 `petId`(uuid NOT NULL, `@ManyToOne(()=>PetAsset,{onDelete:'CASCADE'})`)、`kind` enum `['frames','clip']` default 'frames'；**删除独立审核用 `status` 列**（动作随宠物审核）
- 风险：petId NOT NULL 对存量行迁移失败 → 启动前 `TRUNCATE action_assets`（开发期可接受）
- [reviews/review.entity.ts](file:///e:/desktop-pet/platform/backend/src/reviews/review.entity.ts)、[download-record.entity.ts](file:///e:/desktop-pet/platform/backend/src/reviews/download-record.entity.ts)：**PG enum 保留 'action' 值**（避免 ALTER TYPE 失败），仅 TS `AssetType` 收窄为 `'pet'|'agent'`；[reviews.service.ts](file:///e:/desktop-pet/platform/backend/src/reviews/reviews.service.ts) 删 actionsRepo 注入与 action 分支，`listDownloaded` 过滤 action 记录
- [admin/admin.controller.ts](file:///e:/desktop-pet/platform/backend/src/admin/admin.controller.ts)：删 'action' 分发；[admin.module.ts](file:///e:/desktop-pet/platform/backend/src/admin/admin.module.ts)、[app.module.ts](file:///e:/desktop-pet/platform/backend/src/app.module.ts) 移除 ActionsModule

**路由**：actions/ 目录仅保留 entity+service，删除独立 ActionsController；[pets.controller.ts](file:///e:/desktop-pet/platform/backend/src/pets/pets.controller.ts) 增加子资源：
- `GET /pets/:id/actions` 公开（客户端安装拉清单）
- `POST /pets/:id/actions`（作者本人，zip 上传）+ `PUT /pets/:id/actions/:actionId`（编辑名称/interaction）+ `DELETE /pets/:id/actions/:actionId`
- 动作下载复用宠物子路由 `POST /pets/:id/actions/:actionId/download`（不记独立 download_records）

**上传流程**（pets create 改造）
- `FileFieldsInterceptor([{name:'file',maxCount:1},{name:'preview',maxCount:1},{name:'actionFiles',maxCount:15}])` + `actionsMeta` JSON 字符串字段 `[{name,interaction,clipName?}]` 与 actionFiles 按下标对应
- format 判定：主文件 `.zip`→pack、`.glb/.gltf`→model3d（阶段二）、其余→image
- **previewUrl 约定**：image 不传则用 fileUrl；pack/model3d 必须单独传 preview 图（后端不解 zip）
- pets.service.create：建宠物后循环 `ActionsService.createForPet(petId, meta, file)`（复用 validateUploadFile PK 校验 + storage.upload）

### 平台前端（platform/frontend）

- [types.ts](file:///e:/desktop-pet/platform/frontend/src/types.ts)：`AssetType='pet'|'agent'`；宠物 Asset 加 `format`、`actions?: {id,name,interaction,clipName}[]`
- [api.ts](file:///e:/desktop-pet/platform/frontend/src/api.ts)：宠物上传改专用 `uploadPet(values, mainFile, previewFile, actionFiles)` 拼 FormData（actionsMeta + 多文件）
- [UploadPage.tsx](file:///e:/desktop-pet/platform/frontend/src/pages/UploadPage.tsx)：删独立 action 分支；宠物表单加"附带动作包" Form.List 区块（动作名 + 绑定互动 Radio + zip 文件，可加多条）；pack/model3d 时 preview 必填校验；AI 生成宠物卡不变（仍产出 image 宠物）
- [ResourceListPage.tsx](file:///e:/desktop-pet/platform/frontend/src/pages/ResourceListPage.tsx)：删 action tab 与 interactionLabels
- [ResourceDetailPage.tsx](file:///e:/desktop-pet/platform/frontend/src/pages/ResourceDetailPage.tsx)：删 action 下载分支；宠物详情展示附带动作列表（名称 + 绑定标签）
- [ProfilePage.tsx](file:///e:/desktop-pet/platform/frontend/src/pages/ProfilePage.tsx)：删动作 tab、`activeIds.action`、"安装动作"按钮；ACTIVE_ID_PATTERN 移除 actions 分支
- [vite-env.d.ts](file:///e:/desktop-pet/platform/frontend/src/vite-env.d.ts)：install/uninstall type 删 'action'

### 客户端（e:/desktop-pet/src）

- [config.ts](file:///e:/desktop-pet/src/main/config.ts)：PetAction 加 `petAssetId?: string`；AppConfig 加 `petAssetFormat?: 'image'|'pack'|'model3d'`
- [petActions.ts](file:///e:/desktop-pet/src/main/petActions.ts)：新增 `clearPlatformActions()`——遍历 source==='platform' 的动作调 removeAction（清 userData/pet-actions/<id>/）并重置 petActionBindings={}`；`addFramesAction` 加可选 petAssetId 参数
- [platformClient.ts](file:///e:/desktop-pet/src/main/platformClient.ts)：
  - `PlatformAssetType` 收回 `'pet'|'agent'`（assetPath/assertAssetType/extension 删 action 分支）
  - 新增 `listPetActions(petId)`、`downloadPetAction(petId, actionId)`
  - `install('pet')`：解压落 userData/pets/<id>/ 后**先 clearPlatformActions()**，再逐动作下载 zip → listFiles 图片按文件名排序 → `addFramesAction(name, frames, petId)` → 写 bindings；返回 `{actionsCount}`
  - 主图约定：包内 `main.*` 优先，否则首张图
- [main.ts](file:///e:/desktop-pet/src/main.ts)：install handler 删 action 分支；**仅 actionsCount===0 时**跑 autoGenerateBaseActions（避免与附带动作重复）
- [global.d.ts](file:///e:/desktop-pet/src/global.d.ts)：platform 方法 type 删 'action'；PetAction 加 petAssetId
- pack 渲染阶段一最小实现：仍渲染主图（App.tsx 不改），动作帧照旧拷贝到 pet-actions/（播放与清理逻辑零改动）

---

## 阶段二：多形态渲染 —— GIF / Live2D / 3D 模型

### 2a. GIF 动图支持（ PixiJS v8 内置，改动小）
- 客户端 pixi.js 8.20 **内置 GIF 解析**（`GifSprite` + Assets 自动识别 .gif），无需新依赖
- 宠物主图为 .gif：[App.tsx](file:///e:/desktop-pet/src/App.tsx) 加载分支——Assets.load 返回 GifSprite 时直接作为宠物精灵（自动循环播放）；三视图派生对 GIF 禁用（用首帧静态图做 side/back 派生或仅 front）
- 动作帧含 GIF：单张 .gif 的动作 → GifSprite 播放（kind 仍 'frames'，渲染端按扩展名分流）；多帧混排仍 AnimatedSprite
- format 判定不变：GIF 归入 `image`（.zip→pack、.glb/.gltf→model3d、.live2d 包→live2d、其余含 .gif→image）
- 平台预览图静态首帧（可接受）

### 2b. Live2D 宠物（新 format 'live2d'）
- 数据模型：format enum 即含 `['image','pack','live2d','model3d']`（阶段一已一次加齐）
- 上传约定：live2d 宠物 zip 内含 `model3.json`（+ moc3/贴图/motions）；**动作 = motion 分组名**，前端上传时解析 model3.json 的 `FileReferences.Motions` 生成分组下拉，clipName 随 actionsMeta 提交（后端与主进程不解 zip、不引 Live2D SDK）
- 客户端渲染：
  - 依赖：`pixi-live2d-display`（需 Pixi v8 兼容版本，优先官方仓；若不支持 v8 则用社区 fork `pixi-live2d-display-lipsyncpatch`，风险点见下）+ 本地 vendor `live2dcubismcore.min.js`（index.html 引入，随安装包分发）
  - [App.tsx]：format==='live2d' 分支——Live2D 模型挂独立 canvas/容器，`model.motion(clipName)` 播放动作，结束后回 idle 分组；隐藏 Pixi canvas
  - [platformClient.ts]：live2d zip 解压落 userData/pets/<id>/，主文件定位 model3.json，saveConfig `petAssetFormat:'live2d'`；IPC `platform:getPetModel` 同 3D 复用（ArrayBuffer 或直接文件路径，模型目录已在 userData 内）
- PetAction kind `'clip'`（与 3D 动画统一）：`{clipName, loop}`

### 2c. 3D 模型宠物（three.js）
- 客户端 `npm i three @types/three`
- 上传端解析 clip：平台前端用 three `GLTFLoader.parse(buffer)` 读 animations 供表单下拉，clipName 随 actionsMeta 提交（后端与主进程不引 three）
- [App.tsx]：format==='model3d' 分支——`THREE.WebGLRenderer({alpha:true})` 挂同一容器，AnimationMixer 播 clip，finished 恢复静止姿态
- 点击判定简化：live2d/model3d 下不做像素级 alpha 采样，整窗矩形命中
- 明确不做：骨骼编辑、物理、Draco 解码、灯光/材质调参 UI、Live2D 唇形同步/视线追踪调参

**渲染分支总览**（App.tsx 按 petAssetFormat 分流）：image(含GIF)→Pixi Sprite/GifSprite；pack→主图 Sprite+包内造型图；live2d→Live2D motion；model3d→three AnimationMixer。四种 format 的"动作播放"统一走 playAction(action)：frames→帧序列/GIF，transform→补间，clip→motion/AnimationMixer。

### 2d. 状态间过渡动画（跨形态统一，AI 生成同样遵守）

模型类宠物（live2d/model3d）在两个状态（idle ↔ 动作、动作 ↔ 动作）之间必须有平滑过渡，不做硬切：

- **3D（three.js）**：AnimationMixer 用 `crossFadeTo(targetAction, 0.3s)` / `fadeIn/fadeOut`；动作结束 `crossFadeTo(idleAction)` 回静止姿态；被新动作打断时同样 crossFade 而非 stop
- **Live2D**：Cubism motion 自带 fade（model3.json 的 FadeInTime/FadeOutTime，缺省 ~0.5s）；优先播放模型 motion 分组，确保存在 idle 分组作为回退；pixi-live2d-display 自动处理淡入淡出
- **2D（image/pack，transform 补间）**：动作启动时从当前姿态（位置/缩放/旋转/贴图 alpha）向新动作首帧做 150~300ms 插值过渡；动作结束向基准姿态做 ~200ms 回归补间，替代现有瞬时复位
- **AI 生成约束**（[petActions.ts](file:///e:/desktop-pet/src/main/petActions.ts) generateAction）：提示词明确"首末关键帧必须回到自然站立姿态（dx=dy=0、rotation=0、scale=1、view=front），便于与其他动作/静止状态平滑过渡"；clampKeyframe 对首末关键帧强制归位（末帧位置强制 dx=dy=0、scale=1、rotation=0），保证任何 AI 产出都能无缝衔接
- 帧序列动作（frames）：GIF/多帧自然衔接；结束后同样走 200ms 回归补间（贴图切回主形象）

---

## 阶段三：智能体控制动画播放 + 主动发起对话

智能体（含已安装智能体的 systemPrompt/模型覆盖，经 getLLMConfig() 生效）获得两个主动能力：

### 3.1 聊天回复驱动动画播放
- **协议**：动作列表注入 systemPrompt（chat handler 发送前拼接）：`你可以让宠物做动作。可用动作：吃饭、走路、休息、玩耍…。需要时在回复末尾附加标记 [动作:名称]（最多一个），该标记不会显示给用户。`
- **解析**：主进程 chat handler 拿到 LLM 回复后，用正则 `/\[动作[:：](.+?)\]\s*$/` 提取并从展示文本中剥离；按名称（回退绑定名）在 config.petActions 中查 id
- **播放**：复用现有 `mainWindow.webContents.send('pet:play-action', id)`（右键菜单已用此通道，渲染端 onPlayAction 已监听），无需新增 IPC
- AI 生成动作的名称自动进入可用列表，pack/model3d 动作同理

### 3.2 主动发起对话
- **配置**：[config.ts](file:///e:/desktop-pet/src/main/config.ts) 加 `agentProactive: { enabled: boolean; intervalMinutes: number }`（默认 `{enabled:true, intervalMinutes:30}`）；设置页（petFeatures 同区）加开关与间隔选择
- **触发器**（主进程新增 agentProactive.ts，setInterval 按配置间隔）：
  - 周期性主动：到点即生成一句问候/闲聊
  - 状态驱动：生成前读 config.petState，饥饿/精力/心情低于阈值（<30）时在提示词中要求"提醒主人"（喂食/休息/玩耍），天然与动作播放联动
- **生成**：llmService.chat（getLLMConfig() 已合并已安装智能体覆盖 → 智能体人设驱动主动消息），提示词含宠物状态摘要 + 最近 2 条聊天记录避免重复
- **送达**：写入聊天历史（chat-history.json 持久化通道）+ `pet:agent-message` 新 IPC 推渲染端；聊天面板展开→追加消息，收起→宠物旁气泡显示（点击打开聊天），气泡 10s 自动消失
- **限流**：主动消息最小间隔 10 分钟，避免与用户对话撞车（用户 2 分钟内发过消息则跳过本轮）

### 涉及文件
- 主进程：[main.ts](file:///e:/desktop-pet/src/main.ts)（chat handler 注入动作列表+解析标记；注册 proactive 定时器与新 IPC）、新增 src/main/agentProactive.ts、[config.ts](file:///e:/desktop-pet/src/main/config.ts)、preload（pet:agent-message 监听）
- 渲染端：[App.tsx](file:///e:/desktop-pet/src/App.tsx)（气泡组件+监听）、chatStore（历史已由主进程写则自动带出）
- 设置 UI：现有设置面板加 agentProactive 开关

---

## 验证

1. 编译：`npx tsc --noEmit`（根客户端 + platform/frontend）、后端 `npx tsc -p tsconfig.build.json`
2. 重启顺序：PostgreSQL → `TRUNCATE action_assets` → 后端 `node dist/main.js` → 平台前端 `npm run dev` → 客户端 `npm start`（Electron 均需 dangerouslyDisableSandbox）
3. 端到端：上传带 2 个动作包的 pack 宠物（preview 必填）→ admin 审核通过 → 商店详情见动作列表 → 客户端安装 → 动作面板见 2 个"资源库"动作且喂食绑定生效 → 安装另一宠物后旧 platform 动作与帧目录消失、bindings 重置 → 若新宠物无附带动作则 AI 自动生成 4 个基础动作
4. 阶段三验证：聊天说"跳个舞"→ 宠物播放对应动作且回复无 [动作:] 标记残留；将 agentProactive.intervalMinutes 临时调为 1 → 到点宠物旁冒气泡（收起时）且聊天面板出现智能体主动消息；饥饿 <30 时主动消息为提醒喂食类；设置页关闭开关后不再触发
5. 阶段二验证：上传 .gif 宠物 → 安装后自动循环播放；上传含 model3.json 的 live2d 包（动作=motion 分组）→ 安装后播放对应 motion；glb 宠物播放 AnimationMixer clip；**连续触发两个不同动作 → 状态间为平滑过渡无硬切**；AI 生成的"走路"动作播完 → 宠物回到基准站立姿态（末帧归位）

## 风险与决策点

- **Live2D × Pixi v8 兼容**：`pixi-live2d-display` 官方版可能不支持 Pixi v8，需用社区 fork（如 lipsyncpatch 版）或退级方案（Cubism Web Framework 直连渲染，不经 Pixi）。实施时先跑通最小 demo 再接入；Cubism Core 运行时文件需随客户端 vendor 分发
- 动作挂靠后 petId NOT NULL 迁移：开发库 TRUNCATE action_assets（已写入验证步骤）
- 智能体 [动作:名称] 标记依赖 LLM 遵循格式：解析失败仅降级为纯文本回复，不影响聊天
