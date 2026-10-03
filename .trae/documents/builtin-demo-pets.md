# 内置原创演示宠物（Built-in Demo Pets）实施方案

## Context（为什么做这件事）

用户原请求是"在 GitHub 检索含 pet 的前 20 个项目，提取全部未加密美术资源并全部整合进本项目"。经核验该请求不可按原样执行：**(a)** GitHub 仓库美术资源默认保留所有权利，"未加密"≠"可授权"，批量并入带公开商店的产品会引入法律风险，且违反本项目"不拷贝 GPL 代码"的既有原则；**(b)** GitHub 没有"每个仓库的下载频次"这一指标，排序口径不成立；**(c)** 当前环境无批量抓取通道，且外部素材格式与本项目宠物规范不兼容。

与用户澄清后确认的口径：

- **真正交付物**：桌面端**内置原创演示宠物**——完全离线、无需登录、开箱即用。
- **节奏**：先做 **1 个精做版**打通全链路，验证通过后扩到 **3 个**。
- **美术来源（两条都用）**：① 程序化原创绘制（纯 Node 逐像素绘制 + 自编码 PNG）；② 形象图用文生图接口生成底图 + 抠底，程序化作为兜底与动画帧来源。
- **GitHub 那一步**：只做**只读阅览并总结**，不落盘任何外部素材（见文末附录）。

预期结果：用户在"宠工坊 → 宠物资源"页可一键切换到原创演示宠物，右键 喂食/休息/玩耍 立刻播出对应帧动画；点"还原默认"后 `config.json` 精确回到基线不变量。

---

## 已确认现状（证据）

| 事实 | 位置 |
| --- | --- |
| 唯一内置形象 `src/assets/pet.png`，兜底 `installedPet?.dataUrl ?? petImg` | [App.tsx](file:///e:/desktop-pet/src/App.tsx#L571-L572) |
| 形态分流：`model3d`→three，`live2d`→Live2D，其余→Pixi（单图无需改渲染） | [App.tsx](file:///e:/desktop-pet/src/App.tsx#L1163-L1173) |
| `getInstalledPet()` 读 `petAssetPath`，图片返回 base64 dataUrl，不存在返回 null | [platformClient.ts](file:///e:/desktop-pet/src/main/platformClient.ts#L489-L508) |
| `PetAction{ id,name,kind,source,frameFiles,frameRate,clipName,petAssetId,interaction,createdAt }`，上限 15 | [config.ts](file:///e:/desktop-pet/src/main/config.ts#L277-L294) |
| 帧图落盘 `userData/pet-actions/<id>/frame_000.png`，≤30 帧，白名单 png/jpg/jpeg/gif/webp | [petActions.ts](file:///e:/desktop-pet/src/main/petActions.ts#L12-L55) |
| 播放：Pixi `AnimatedSprite`，`animationSpeed=frameRate/60`，`loop=false`，onComplete 复位 | [App.tsx](file:///e:/desktop-pet/src/App.tsx#L483-L546) |
| 互动触发仅右键 feed/rest/play；优先 `petActionBindings[kind]`，未绑定按**同名回退**（吃饭/休息/玩耍） | [App.tsx](file:///e:/desktop-pet/src/App.tsx#L404-L412) |
| `petAsset*` 在 loadConfig/saveConfig **不做专门清洗**，靠 `{...parsed}` 透传；saveConfig 传 `undefined` 会被 JSON.stringify 丢弃 | [config.ts](file:///e:/desktop-pet/src/main/config.ts#L586-L635) |
| 打包目前 `asar: true`，**无 extraResource** | [forge.config.ts](file:///e:/desktop-pet/forge.config.ts#L11-L13) |
| 安装平台宠物时 `clearPlatformActions()` 并 saveConfig 四个 `petAsset*` | [platformClient.ts](file:///e:/desktop-pet/src/main/platformClient.ts#L405-L432) |
| 云同步：本地无宠物时按云端 `currentPet` 重装 | [cloudSync.ts](file:///e:/desktop-pet/src/main/cloudSync.ts#L100-L110) |
| `petaction://` 目录白名单仅 `pet-actions`/`pets`/`sherpa-asr` | src/main.ts:1295 附近 |
| 项目**无** sharp/jimp/canvas，**无**任何文生图调用；`@imgly/background-removal` 是浏览器 WASM 包 | package.json |

**用户数据基线不变量**（任何阶段不得破坏）：`%APPDATA%\desktop-pet\config.json` 无 BOM；profiles=1；petActions=0；petActionBindings={}；petWindow 宽 280。

---

## 设计

### 1. 资源分发

新增 `resources/builtin-pets/<petId>/{manifest.json, cover.png, actions/<actionId>/frame_*.png}`，在 `forge.config.ts` 加：

```ts
packagerConfig: { asar: true, extraResource: ['./resources/builtin-pets'] },
```

**统一目录解析（关键，dev 与打包必须双路径）**：

```ts
export function resolveBuiltinPetsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'builtin-pets')
    : path.join(app.getAppPath(), 'resources', 'builtin-pets');
}
```

依据：`@electron-forge/core` 的 start 实现是 `spawn(electronPath, [appPath='.', ...])`，dev 下 `process.resourcesPath` 指向 `node_modules/electron/dist/resources`（不可用）。
**绝不允许把该绝对路径写进 config**（Squirrel 升级会换 `app-<version>` 目录导致路径失效，且会与 `petAssetPath` 的"平台资源"语义混淆）。

### 2. 配置（additive，不动既有语义）

- `AppConfig.builtinPet?: string`——内置演示宠物 id；空/未设 = 维持现状（`pet.png`）。
- `PetAction.builtinPetId?: string`——标记该动作由哪个内置宠物产生，与 `petAssetId` 同构。
- **不新增 `source: 'builtin'`**：那要动 2 处类型镜像 + 3 处文案（PetResources.tsx:150、ActionsPanel.tsx:136、main.ts 约 1200），而 additive 可选字段零 UI 改动且能精确识别/清理内置动作。
- `loadConfig` 增加清洗：`builtinPet: typeof parsed.builtinPet === 'string' ? parsed.builtinPet : undefined`，并过滤 `petActions` 里非法的 `builtinPetId`。

### 3. 主进程新增 `src/main/builtinPets.ts`

```ts
listBuiltinPets(): BuiltinPetSummary[]                 // 读 manifest，目录缺失返回 []
parseBuiltinPetManifest(raw: unknown): BuiltinPetManifest | null   // 纯函数，可单测
applyBuiltinPet(id: string): { success: boolean; error?: string; actionIds?: string[] }
resetBuiltinPet(): { success: boolean }
```

`apply` 步骤（**幂等**，先清后建）：

1. 校验 manifest 与目录存在；预检 `petActions.length + 3 - 本宠已占条数 > PET_ACTIONS_MAX(15)` → 返回明确错误（不改上限）。
2. `clearPlatformActions()` 清平台动作——否则 live2d/3d 的 `clip` 动作残留，在内置单图宠物上右键会**无反应**（Pixi 分支不认 clip）。
3. 按 `builtinPetId` 清掉本演示宠物的旧动作与旧帧目录（幂等重建）。
4. 拷贝帧图到 `userData/pet-actions/<newId>/frame_000.png`…，登记 `PetAction{ source:'manual', builtinPetId:id, name:吃饭|休息|玩耍, frameRate:manifest 值 }`。
5. `saveConfig({ builtinPet:id, petAssetName:<展示名>, petAssetFormat:'image', petAssetId:undefined, petAssetPath:undefined, petActions:[...], petActionBindings:{feed,rest,play} })`。
   - `petAssetFormat:'image'` 是**硬要求**，否则 App.tsx:1163 会走 three/Live2D 分支导致空白。
   - **绑定必须显式写死**：`PetAction.interaction` 字段目前**无任何消费方**（App.tsx:404-412 只读 bindings + 同名回退），所以既写 bindings 又保留同名动作名，双保险。
6. 广播 `notifyPetAssetChanged()`（驱动 Pixi 重建）+ `notifyPetActionsChanged()`。
7. **不调用 `scheduleUpload('config')`**——`uploadNow` 在 `petAssetId` 为空时会上传 `currentPet: null`，抹掉云端宠物引用。

`reset`：删本宠物动作 + 帧目录 + bindings 中指向它们的项，`saveConfig({ builtinPet:undefined, petAssetName:undefined, petAssetFormat:undefined })` → 回落 `pet.png`，config 精确回到基线。

### 4. 其它主进程改动

- `getInstalledPet()`：`petAssetPath` 有效 → 用它；否则若 `config.builtinPet` 且 extraResource 有 `cover.png` → 返回其 dataUrl；否则 null（→ `pet.png`）。
- `platformClient.install('pet')` 的 saveConfig（427-432 行）加 `builtinPet: undefined`。
- `cloudSync.ts:100` 的 `localPetMissing` 加 `&& !cfg.builtinPet`，否则登录拉取会按云端 `currentPet` 重装店宠物、覆盖内置形象并清掉绑定。
- **协议不用改**：形象走 dataUrl，帧走 `userData/pet-actions`（已在白名单内）。

**解析优先级**：`petAssetPath` 有效 → `builtinPet` → `pet.png`。平台宠物卸载后若 `builtinPet` 在则回落内置，否则回 `pet.png`。

### 5. 渲染端 `PetResources.tsx`

在"当前宠物资源"卡下新增"内置演示宠物"区：卡片列表（封面 + 名称 + 描述 + 作者/许可）+「应用」+「还原默认」。
来源文案三态：`petAssetId`→资源中心；`builtinPet`→本机内置演示（附作者/许可）；否则本机内置。
调用后 `await loadConfig()` 刷新（跨窗口一致性由 `config:changed` 广播保证）。

---

## manifest schema（1 → 3 只零改代码）

```jsonc
{
  "schemaVersion": 1,
  "id": "sprout-cat",
  "name": "芽芽猫",
  "description": "青绿色的圆脸小猫，安静黏人",
  "author": "desktop-pet 项目组",
  "license": "CC0-1.0（本项目自产，代码生成）",
  "canvas": { "width": 512, "height": 512, "anchor": "center" },
  "cover": { "file": "cover.png", "sha256": "…" },
  "actions": [
    { "id": "eat", "name": "吃饭", "interaction": "feed", "frameRate": 6,
      "frames": [{ "file": "actions/eat/frame_000.png", "sha256": "…" }] }
  ],
  "provenance": {
    "kind": "procedural | t2i",
    "generator": "scripts/build-builtin-pets.mjs",
    "version": "1.0.0", "seed": 20261002,
    "prompt": "（t2i 时记录）", "model": "（t2i 时记录）", "generatedAt": "2026-10-02"
  }
}
```

---

## 美术生成 `scripts/build-builtin-pets.mjs`（纯 Node，无新依赖）

- **PNG 编码**：`zlib.deflateSync` + 手写 CRC32 表 + IHDR/IDAT/IEND；每行 filter 0；3× 超采样盒式降采样抗锯齿。输出 512×512 透明底 RGBA。
- **程序化绘制**：参数化吉祥物（圆脸 + 耳 + 尾 + 眼/腮红），逐像素解析式着色（椭球 + 软阴影）。
- **动画帧**：确定性派生（同 seed 同一结果）——呼吸起伏（整体 y/scale 微变）、眨眼（眼区重绘）、耳朵抖动、咀嚼（嘴区缩放）、Zzz 叠加。保证"三套动作是同一只宠物"。
- **两条硬约束**：① cover 与所有帧**同画布、同注册点**（App.tsx 里 cover fit 用 `min((W-60)/w,(H-60)/h)`、动作 fit 用同一公式，不一致会跳变）；② 因为 `loop=false`，**每套动作首尾帧必须回到中性姿态**，否则播完回本体时 pop。
- **文生图路线**：只用于生成 cover 一张（提示词锁定"同一角色/固定机位/512×512/透明背景"，可参考 shimeji 社区做法），抠底用**无依赖 flood-fill + 边缘羽化**（`@imgly/background-removal` 是浏览器 WASM 包且从 CDN 拉模型，**纯 Node 脚本用不了**）。失败或质量不达标则整只回退到纯程序化。
- **可追溯**：PNG 内嵌 `tEXt`（generator/version/seed/prompt/license）。
- `package.json` 加脚本 `"build:builtin-pets": "node scripts/build-builtin-pets.mjs"`。

---

## 实施步骤

**阶段一：1 个精做版打通链路**

1. `scripts/build-builtin-pets.mjs` + `package.json` 脚本；产出 `resources/builtin-pets/sprout-cat/**`（含 manifest）。
2. `forge.config.ts` 加 `extraResource`。
3. `src/main/config.ts` + `src/global.d.ts`：`AppConfig.builtinPet?`、`PetAction.builtinPetId?`、loadConfig 清洗。
4. 新增 `src/main/builtinPets.ts`（路径解析 / manifest 解析 / list / apply / reset）。
5. `src/main.ts` 注册 `builtin:list` / `builtin:apply` / `builtin:reset`；`platformClient.ts` 加 `builtinPet: undefined`；`cloudSync.ts` 加守卫；`getInstalledPet()` 扩展。
6. `src/preload.ts` + `src/global.d.ts`：暴露 `electronAPI.builtin.{list,apply,reset}`。
7. `src/components/PetResources.tsx` 新增内置演示宠物区。
8. 新增 `src/main/builtinPets.spec.ts`（manifest 解析、路径解析、优先级、apply 预检等纯函数）。

**阶段二：扩到 3 只（零代码改动，只加数据）**

9. 生成另外 2 只（不同色系/物种：如 芽芽猫 / 云朵兔 / 炭炭犬），落入 `resources/builtin-pets/`，UI 自动列出。
10. 顺带修平台后端的"示例橘猫"文本桩缺陷（`platform/backend/scripts/seed.ts` 的 `fileUrl` 指向纯文本 → 改为可渲染图片或移除该条）。

---

## 验证方案

1. **生成幂等**：连跑两次 `npm run build:builtin-pets` → `git status` 无 diff；产物 sha256 与 manifest 一致。
2. **质量门**：`npx tsc --noEmit -p tsconfig.json` 0 错；`npm run test`（137 + 新增用例）；`npx eslint "src/**/*.{ts,tsx}"` 维持 **8 errors / 6 warnings** 不新增。
3. **真机取证（dev）**：`npm.cmd start` 后台运行，经 env 门控临时钩子驱动真实 DOM：`builtin:list` 返回 1 项；点「应用」后 —— `getInstalledPet()` 返回 `data:image/png;base64,…`；`config.json` 出现 `builtinPet` + 3 条带 `builtinPetId` 的动作 + 3 条 bindings，且**无** `petAsset*` 键；宠物窗画面切换为该形象。
4. **互动取证**：右键 喂食/休息/玩耍 → 观测 `pet:play-action` 的 actionId 三次各不相同且分别等于 bindings 的 feed/rest/play；画面播出对应帧动画（帧序号递增一次即复位）。
5. **还原默认**：点「还原默认」→ config.json 回到基线（profiles=1、petActions=0、bindings={}、无 `builtinPet`/`petAsset*` 键、无 BOM）；窗口回落 `pet.png`；`userData/pet-actions` 内置目录被删；磁盘无残留。
6. **打包路径**：`npm run package` → `out/desktop-pet-win32-x64/resources/builtin-pets/` 存在；直接跑 out 里的 exe 重复 3–5（证明打包态路径解析正确）。
7. **清理**：验收钩子整块删除 + grep 零残留；`%TEMP%` 脚本清理；复核基线不变量。

---

## 风险与未知（需实测确认）

1. **dev 下 `app.getAppPath()` 的实际值**：`@electron-forge/plugin-vite` 实现了 `overrideStartLogic`，需实测确认 dev 的 appPath 仍是工程根目录（若指向 `.vite/build`，`resolveBuiltinPetsDir` 的相对部分要跟着改）。**这是第一个要验证的点。**
2. `extraResource` 与 Vite 插件 `packageAfterCopy` 重写 package.json 的交互未实测。
3. 512×512 透明 PNG 在 280px 宽窗口下的观感、3 套动作的可读性需目测。
4. 文生图 cover 与程序化派生帧的风格一致性只有目测标准，可能需人工修 cover。
5. 用户已有 ≥13 个动作时 apply 会失败——当前方案给明确错误提示（不改上限、不特殊对待内置动作）；如不接受再讨论产品决策。
6. "无 `petAssetId` 即视为无宠物"的隐式假设我只核实了 cloudSync 两处，实施时全量 grep 一次防遗漏。

---

## 附录：GitHub 只读阅览总结（不落盘任何外部素材）

按要求做了只读检索与阅览，结论如下：

- **GitHub 没有"仓库下载频次"指标**，只有 Release 资产下载数且仅覆盖发了 Release 的仓库，故"按 star+下载频次综合排序取前 20"无法成立。按 star 排序的头部仓库（仅作风格参考）：BongoCat（ayangweb，Tauri/Rust，Live2D 模型，约 23.7k stars）、VPet（LorisYounger，C#/WPF，约 5.4k）、Mate-Engine（915）、DyberPet（493）、sakana（约 4.1k）、Alive、Shijima-Qt 等；`desktop-pet` topic 下公开仓库约 49–63 个。
- **三条风格流派**：
  1. **Shimeji 系**（最主流）：本质是"一文件夹编号 PNG 帧 + 两个 XML 行为描述"，美术由社区绘制（DeviantArt 上千套 OC）。→ 直接印证本项目"帧序列 + 行为绑定"的模型是主流做法。
  2. **Live2D / MMD / VRM 系**：BongoCat、Alive、Mate-Engine、yoMMD，形象质量高但依赖模型与运行时。
  3. **像素画 sprite sheet 系**：如 Desktop-Cat、codex-pet-azi（`pet.json` + `spritesheet.webp` 两个文件即一只宠物）。
- **程序化动画有先例**：`geezmolycos/lizard-pet`（love2d）"使用程序动态生成的动画"，与本方案的"程序化派生帧"路线同源。
- **帧动画的工程共识**：从社区实践中提炼出的关键约束与本方案一致——锁定同一角色/同一机位/固定缩放、锚点固定、相邻帧位移极小、输出透明 RGBA、每套动作首尾回中性姿态；状态机通常为 idle / walking / dragging / falling / sitting。

Sources:

- [desktop-pet · GitHub Topics](https://github.com/topics/desktop-pet)
- [BongoCat — 跨平台桌面宠物](https://bongocat.gjxx.dev/)
- [7 Best Shimeji Alternatives in 2026 | OpenPets](https://openpets.dev/alternatives/shimeji)
- [桌面宠物 标签的开源项目 - HelloGitHub](https://hellogithub.com/tags/ea8dJbROzh)
- [给 OpenClaw 搞了只像素龙虾桌宠（帧素材生成提示词实践）](https://xie.infoq.cn/article/843148ed2aabd6c9c47ad6204)
- [ArkPets 明日方舟桌宠](https://arkpets.harryh.cn/)
- [给 Codex 加一只像素宠物：阿梓 Azi](https://blog.csdn.net/madtry/article/details/160936587)