# 宠物自我形象识别与记忆（更换形象/智能体时识别自己并记住）

## Context

用户需求：**当更换宠物形象或智能体时，宠物主动识别自己的形象并记住**，此后对话中（如被问「你长什么样」、自我介绍）能准确描述自己——而非问答瞬间临时截图。

设计：形象就绪时渲染端从宠物画布导出 PNG（Pixi extract / three.js 手动渲染后 toDataURL，天然透明、不含聊天面板）→ 主进程调一次多模态 LLM 生成简短外观描述 → **描述文本存入 config（petSelfDescription）** → 注入后续所有对话的 system prompt。纯文本模型也能「知道自己长相」（描述是文本），不依赖每次带图，token 成本极低。

去重：主进程按「资产标识 + agentId」指纹判断，指纹未变时跳过识别（避免每次启动/切换面板重复调 LLM）；指纹变化（换形象/换智能体）才重新识别覆盖旧描述。

## 改动文件

### 1. src/main/config.ts + src/global.d.ts — 新增配置字段

```ts
/** 宠物自我形象描述（多模态 LLM 识别生成，注入对话 system prompt） */
petSelfDescription?: string;
/** 上次形象识别的指纹（资产标识+agentId），变化时才重新识别 */
selfImageFingerprint?: string;
```

### 2. src/main.ts — 识别 IPC + system prompt 注入

**`self:recognize` IPC handler**（渲染端 invoke，参数 dataUrl）：
1. 计算当前指纹：`asset 标识（installedPet 资产路径/url + petAssetFormat）+ 当前 agentId`（主进程已有 platformClient 安装态/config 可查；具体字段以现有 installedPet/agent config 结构为准，执行时读取确认）
2. 指纹与 `config.selfImageFingerprint` 相同 → 直接返回 `{ ok: true, skipped: true }`，不调 LLM
3. `llmService.isConfigured()` 检查；未配置返回 `{ ok: false, error: 'NO_LLM' }`
4. 单次调用 `llmService.chat`：system =「你是宠物形象描述员」，user = 附 dataUrl（复用 chat:send 的多模态 content 组装模式，main.ts:L224-233）+ 指令「用不超过 60 字第三人称描述这只宠物/角色的外观（外形、颜色、表情风格），不要提及名字以外的人物设定」
5. 描述写 `saveConfig({ petSelfDescription: text, selfImageFingerprint: 指纹 })`，返回 `{ ok: true, description }`
6. 失败（含模型不支持视觉）返回 `{ ok: false, error }`；主进程 `deliverAgentMessage` 提示一次「宠物形象识别失败：当前模型可能不支持看图」（节流）

**system prompt 注入**：`chat:send` 中 `withActionPrompt(messages)` 之后加 `withSelfDescription(messages)`（同款模式）：`loadConfig().petSelfDescription` 存在时在 system 末尾追加：

```
你的桌面宠物形象描述（回答外观/形象相关话题时以此为准）：{petSelfDescription}
```

**agent 变更触发**：主进程在智能体安装/卸载/切换成功处（platformClient install/uninstall 相关回调，执行时定位）`win.webContents.send('pet:selfie-request')`，让渲染端重新导出画布。

### 3. src/preload.ts + src/global.d.ts — 桥接

- `self` 命名空间：`recognize: (dataUrl: string) => ipcRenderer.invoke('self:recognize', dataUrl)`
- `pet` 命名空间：`onSelfieRequest: createListener('pet:selfie-request')`

### 4. src/renderer/App.tsx — 画布导出与触发（三形态分流在 L960-968）

**`exportSelfieDataUrl(): string | null`**（按当前 petAssetFormat）：
- image/pack/gif 与 live2d（Pixi app）：`app.renderer.extract.canvas(app.stage)` → `toDataURL('image/png')`（v8 extract API，保留透明；Live2D 同挂 Pixi stage）
- model3d（three.js）：先手动 `renderer.render(scene, camera)` 一帧再同步 `renderer.domElement.toDataURL('image/png')`（规避 preserveDrawingBuffer 空帧）
- 资产未就绪/异常返回 null

**触发时机**：
- 资产加载完成（三形态就绪的现有 effect/回调处）：`exportSelfieDataUrl()` → `window.electronAPI?.self?.recognize(dataUrl)`（isElectron 判空守卫）；启动时若描述缺失/指纹变了自动补识别（首次使用、换形象后重开均覆盖）
- 监听 `onSelfieRequest`（agent 变更时主进程通知）→ 同样导出 + invoke
- 识别结果可选轻提示（console.log 即可，成功不打扰）

## 复用点

- 多模态 content 组装：main.ts L224-233
- llmService.chat 单次调用与错误抛出：src/main/llmService.ts（流式 onChunk 可传空实现）
- system 注入模式：withActionPrompt（main.ts L185-194）
- createListener 模式：src/preload.ts L5-11

## 验证

1. `npx tsc --noEmit` 通过
2. 右键「重新加载页面」后：
   - 首次启动（无描述）→ 主进程日志显示识别调用成功，config.json 出现 `petSelfDescription` 与指纹；再次重载客户端 → 指纹未变，不重复调 LLM（skipped 日志）
   - 更换宠物形象 → 自动重新识别，描述更新
   - 更换智能体 → 触发重新识别
   - 问「你长什么样」→ 宠物按记住的描述回答（**不触发任何截图**，纯文本模型也有效）
   - 配置不支持的模型时识别失败 → 气泡提示一次，聊天正常
