# 手机端支持 + 平台数据共享（分三阶段）

## Context

项目需同时支持桌面（现有 Electron）与手机。已确认方向：
- **技术方案**：React Native（`e:\desktop-pet\mobile\`，Android 优先，iOS 后续）
- **宠物形态**：App 内宠物 + Android 悬浮窗宠物（悬浮窗在应用内开关开启；iOS 系统不支持悬浮窗，App 内形态即为 iOS 形态）
- **数据共享**（全量）：账号+资源库、LLM API 配置（**加密上云**）、宠物状态+聊天记录

架构：`src/`（桌面，现有）+ `platform/`（平台后端/前端，现有，扩展同步模块）+ `mobile/`（RN 新增）。

复用基础（已探明）：后端 NestJS 模块化 + `synchronize: true`（加表免 migration）+ 全局前缀 `/api` + CORS 已开；JWT 认证（`JwtAuthGuard` 可复用，`auth.service.ts` 签发 access/refresh token）；桌面端 `platformClient.ts` 已有 Bearer token 模式（`config.platform.accessToken`）。

## 阶段 1：平台同步 API + 桌面端接入（数据共享地基）

### 后端 `platform/backend/src/sync/`（照现有模块风格新建）

- **实体**（TypeORM 自动建表）：
  - `user_config`：`userId` PK/FK、`data` jsonb（LLM profiles 等配置整体）、`updatedAt`
  - `user_pet_state`：`userId` PK、`state` jsonb（hunger/mood/energy/affection/petAssetId/petName）、`updatedAt`
  - `user_chat_history`：`userId` PK、`messages` jsonb（与桌面 chat-history.json 同构）、`updatedAt`
  - `user_library`：自增 id、`userId`+`assetType`+`assetId` 联合唯一、`assetName`、`addedAt`
- **API**（全部挂 `JwtAuthGuard`）：
  - `GET/PUT /api/sync/config`、`GET/PUT /api/sync/pet-state`、`GET/PUT /api/sync/chat-history`
  - `GET /api/sync/library`；资源库记录在现有 install/uninstall 流程中写入（pets/agents controller 加一行）
- **加密**（硬约束「云同步需加密」）：`sync.service` 内 AES-256-GCM，密钥取 `process.env.SYNC_ENCRYPTION_KEY`（.env 新增），**仅加密 LLM profiles 中的 Key/URL 等敏感字段**，密文落库；响应时解密。防拖库明文泄露。
- 冲突策略 v1：last-write-wins（PUT 覆盖并返回服务端 `updatedAt`）

### 桌面端接入

- 新文件 `src/main/cloudSync.ts`：登录成功后拉取四类数据（云端 `updatedAt` 较新才覆盖本地对应部分；LLM profiles 云端有而本地空时直接采用）；本地变更 60s 防抖上传 + `before-quit` flush
- `platformClient.ts` 加 sync 系列方法；`main.ts` 挂 `sync:now` IPC（设置里手动「立即同步」可选）
- 卸载重装登录后能拉回全部配置验证闭环

## 阶段 2：RN 手机端骨架（`mobile/`）

- **RN 0.7x + TypeScript，bare RN**（非 Expo，为阶段 3 原生模块留路），Android 优先
- 结构：
  - `mobile/src/api/`：平台 API 客户端（`/auth/login`、资源列表/详情/下载、`/sync/*`），token 存 AsyncStorage
  - `mobile/src/screens/`：Login / Pet / Chat / Store / Settings，底部 tab 导航
  - **宠物渲染分流**：`image/pack/gif` → RN 原生（Image + 帧序列定时器动画）；`live2d/model3d` → `react-native-webview` 加载打包好的 web 渲染页（复用桌面端 web 渲染管线，资源走平台下载 URL）
  - 聊天：手机直连用户 LLM API（OpenAI 兼容 fetch 流式），system prompt 由同步来的 agent config + petSelfDescription 组装；记录走 `/sync/chat-history`
  - 同步：登录后拉取、变更防抖上传（与桌面同策略，两端共用后端即为共享）
- 交付：可构建的 Android 工程 + 构建说明（`npx react-native run-android`）

## 阶段 3：Android 悬浮窗宠物

- Kotlin 原生模块：`SYSTEM_ALERT_WINDOW` 权限引导（`Settings.canDrawOverlays` → 跳系统授权）+ Foreground Service + `WindowManager` 添加透明 WebView（加载与 App 内相同的宠物渲染页，可拖动、点击互动）+ 通知渠道
- RN 设置页「悬浮窗宠物」开关：应用内开启 → 权限引导 → 启动服务；关闭即停
- iOS：不支持悬浮窗（App 内形态替代），不阻塞交付

## 阶段 2 交付说明（已完成骨架）

### 工程结构（mobile/，RN 0.87 + TS bare，Android 优先）

- `src/api/platform.ts`：平台 API 客户端（auth/login、auth/register、pets/agents 列表与详情、download、`/sync/*`）；token 与 baseUrl 从 store 读取，401 自动退登
- `src/api/sync.ts`：云同步（与桌面端 cloudSync.ts 同策略：登录拉取仅补本地缺失、60s 防抖上传、退后台 flush）
- `src/store/appStore.ts`：zustand 全局状态 + AsyncStorage 白名单持久化（1.5s 防抖落盘）
- `src/chat/llm.ts`：直连用户 LLM 档案（OpenAI 兼容 `/chat/completions` 非流式）；人设 = 已安装智能体 systemPrompt + petSelfDescription
- `src/pet/PetView.tsx`：image/gif → 原生 Image；pack → zip 下载解压（@dr.pogodin/react-native-fs + react-native-zip-archive）帧序列定时器动画；live2d/model3d → 占位提示（WebView 渲染页后续接入）
- `src/screens/`：Login / Pet / Chat / Store / Settings，底部 Tab 导航
- 数据结构对齐：config 同步载荷 = `llmProfiles + llmActiveProfileId + petSelfDescription + installedAgentConfig`（桌面端 cloudSync.ts 已同步扩展）；petState 四数值；chatHistory = `[{role, content}]`
- Android：`usesCleartextTraffic="true"`（允许 http 访问本机平台）

### 数值与交互规则（与桌面端一致）

feed：饱足+15 好感+2；play：心情+20 精力-10 好感+5；rest：精力+30 饥饿-5；每 5s 衰减 饱足-0.5/心情-0.2/精力-0.1

### 构建运行

1. 前置：JDK 17 + Android SDK（Android Studio）；平台三件套运行中（后端 3001）
2. `cd mobile && npm install`
3. 模拟器：`npx react-native run-android`；服务器地址默认 `http://10.0.2.2:3001/api`（模拟器映射宿主机）
4. 真机：手机与电脑同局域网，设置页把服务器地址改为电脑局域网 IP（如 `http://192.168.x.x:3001/api`）
5. 登录与桌面端同一账号 → LLM 档案/宠物状态/聊天记录/已安装智能体自动同步；商店安装的宠物记录进入云端资源库

## 阶段 3 交付说明（已完成 Android 悬浮窗宠物）

### 新增原生侧文件（mobile/android/app/src/main/）

- `java/com/mobilepet/OverlayPetModule.kt`：原生模块 `OverlayPet`（暴露 4 个 `@ReactMethod`）
  - `checkPermission()` → 返回 `Settings.canDrawOverlays()` 状态
  - `requestPermission()` → 跳系统「显示在其他应用上层」授权页
  - `startOverlay(htmlUrl)` → 启动前台服务并传入渲染页 URL
  - `stopOverlay()` → 停止服务、移除悬浮窗
- `java/com/mobilepet/OverlayPetPackage.kt`：ReactPackage，把模块注册到 NativeModules
- `java/com/mobilepet/OverlayPetService.kt`：前台服务
  - `onCreate` 建通知渠道（`IMPORTANCE_LOW`，`overlay_pet_channel`），`startForeground` 用 `NOTIFICATION_ID=0x5D01`、`foregroundServiceType="mediaPlayback"`
  - `WindowManager.addView` 添加透明 WebView（`TYPE_APPLICATION_OVERLAY`，180dp × 180dp，初始 `Gravity.BOTTOM | START`）
  - 自带 OnTouchListener：移动 >8dp 视为拖动，未拖动则把 DOWN/UP 重新分发给 WebView（点击仍能触达网页）
- `MainApplication.kt`：`PackageList.apply { add(OverlayPetPackage()) }` 手动注册
- `AndroidManifest.xml`：新增权限与 `<service>` 声明
  - `SYSTEM_ALERT_WINDOW`、`POST_NOTIFICATIONS`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK`
  - `<service android:name=".OverlayPetService" android:exported="false" android:foregroundServiceType="mediaPlayback" />`
- `assets/overlay.html`：悬浮窗 WebView 渲染页（query 入参驱动，与桌面渲染管线对齐）
  - `?format=image|gif&src=<url>&name=<n>&base=<root>` → 直接 `<img>`
  - `?format=pack&manifest=<json-url>` → canvas 120ms 帧序列动画
  - `?format=live2d&model=<url>` → unpkg 加载 Pixi v8 + `@jannchie/pixi-live2d-display`（与桌面 `@jannchie/pixi-live2d-display` cubism4 对齐）
  - `?format=model3d&model=<url>` → unpkg 加载 three.js r169 + GLTFLoader + AnimationMixer（与桌面 three.js 渲染对齐）
  - 点击宠物触发 CSS bounce 动画（轻量互动反馈）
  - 资源 URL 走 `base` 自动补全为完整平台地址（`/uploads/...` 静态公开）

### 新增 RN 侧文件（mobile/src/）

- `native/OverlayPet.ts`：TS 封装
  - `isOverlaySupported()`：仅 Android 且 NativeModules.OverlayPet 存在
  - `checkOverlayPermission() / requestOverlayPermission() / startOverlay(asset) / stopOverlay()`
  - `buildOverlayUrl(asset)`：按宠物形态拼 `file:///android_asset/overlay.html?<qs>`
  - pack 形态暂走平台 `/api/pets/:id/manifest` 占位（平台后续补接口即生效，无需改这里）
- `store/appStore.ts`：新增 `overlayEnabled: boolean` 状态 + `setOverlayEnabled` action + 持久化（`PERSIST_KEYS`、`hydrate` 加载）
- `screens/SettingsScreen.tsx`：激活「悬浮窗宠物」Switch
  - 开启流程：`checkOverlayPermission` → 无权限 `requestOverlayPermission`（Alert 引导用户去系统授权后回来再开）→ 有权限 `startOverlay(petAsset)` + `setOverlayEnabled(true)`
  - 关闭流程：`stopOverlay` + `setOverlayEnabled(false)`
  - iOS / 无 OverlayPet 模块时 Switch 禁用并展示原因文案
  - 没有宠物时给出「将显示占位提示」辅助说明

### 验证步骤（需 Android SDK + 真机/模拟器）

1. 前置：JDK 17 + Android SDK（Android Studio 内置 `jbr-21` 即可）；平台三件套运行中（后端 3001）
2. `cd mobile && npm install`
3. 模拟器或真机：`npx react-native run-android`（首装会自动 Gradle build，包含原生模块注册）
4. 登录账号（与桌面同账号）→ 商店领养一只 image/gif 宠物 → 设置页打开「悬浮窗宠物」开关
5. 弹出权限引导 → 系统设置开启「显示在其他应用上层」→ 返回 App 再次打开开关
6. 状态栏出现常驻通知「宠物悬浮中」；宠物悬浮于桌面/其他应用上方可拖动到任意位置；点击宠物有 bounce 动画
7. 切到 live2d/model3d 形态宠物再开开关 → CDN 加载 Pixi/three.js 渲染（需联网）
8. 关闭开关 → 通知与悬浮窗同时消失

### 已知限制

- iOS 不支持悬浮窗，Switch 在 iOS 上禁用并展示说明（不阻塞交付）
- pack 形态依赖平台后续提供 `/api/pets/:id/manifest` 帧清单 JSON；当前未提供时 overlay.html 会显示加载失败提示，但 image/gif/live2d/model3d 形态可正常渲染
- Live2D/3D 形态需联网加载 unpkg CDN 库；离线环境下仅 image/gif 可用

## 收尾补齐（按计划书逐项核查）

### 当前宠物形象跨设备共享（currentPet）

问题：config 同步载荷原先只含 LLM 档案/人设/自我描述，换机或重装登录后当前宠物形象无法恢复，不满足「拉回全部配置」验收。

- 载荷扩展（两端同构）：`config.currentPet = { id, name, format } | null`（本地路径/URL 不跨设备，只同步平台资源 ID）
- 桌面端 `src/main/cloudSync.ts`：
  - `uploadNow('config')` 从 `cfg.petAssetId/Name/Format` 构造 currentPet
  - `pullAfterLogin` 新增 1b 段：本地 `petAssetId` 缺失或本地资源文件不存在（重装/换机）且云端有 currentPet 时，直接复用 `platformClient.install('pet', id)` 重新下载安装（含附带动作），返回 `petReinstalled`
  - `src/main.ts` 登录回调：`petReinstalled` 时发 `notifyPetAssetChanged + notifyPetActionsChanged` 刷新宠物窗口；安装/卸载 IPC 补 `scheduleUpload('config')`
- 手机端 `src/api/sync.ts`：上传从 `store.petAsset` 构造 currentPet；拉取时本地无宠物则用 id 调 `GET /pets/:id` 恢复 petAsset（资源文件由 PetView 懒下载）；`StoreScreen` 安装宠物后补 `scheduleUpload('config')`

### App 内 Live2D/3D 渲染页接入（阶段2计划项）

问题：App 内 PetView 的 live2d/model3d 原为占位文本，计划书要求 react-native-webview 加载渲染页。

- `mobile/src/pet/PetView.tsx`：live2d/model3d 分支改用 `react-native-webview` 加载 `file:///android_asset/overlay.html`（`buildOverlayUrl(asset)` 复用悬浮窗同一 URL 构造，App 内与悬浮窗完全同页：Pixi v8 Live2D / three.js GLTF 管线）
- WebView 透明背景、`allowFileAccess`、`mixedContentMode=always`（平台 http 资源）、禁滚动；iOS 显示「仅支持 Android」占位（项目 Android 优先）

## 验证

1. **阶段 1**：curl 注册/登录 → PUT/GET `/api/sync/*`；数据库中 LLM Key 为密文；桌面改配置 → 重装登录 → 配置/状态/聊天拉回一致
2. **阶段 2**：模拟器/真机登录同一账号 → 宠物显示互动、聊天连续（与桌面同一套 LLM 配置）、商店可安装资源、状态与桌面同步
3. **阶段 3**：开启悬浮窗开关 → 授权 → 宠物悬浮于其他应用上方可拖动互动；关闭开关消失

## 说明

三阶段独立可交付，按序执行；每阶段完成后验证再进入下一阶段。工作量集中在阶段 2/3（RN 工程 + 原生模块），阶段 1 是数据共享前提。
