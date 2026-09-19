# 语音识别来源扩展：云端 API（转写/聊天模型）+ 智能体携带 ASR 能力

## Context

上一轮已把语音唤醒模型改为「用户导入本地 sherpa-onnx zip 包」（243MB，门槛高）。本次用户要求：语音识别模型也可以**由用户提供的 API**（两种格式都支持）或**由平台安装的智能体资源携带**。

已确认的现状链路（探索结论）：
- 智能体资源的配置 JSON 由平台上传页生成（`UploadPage.tsx` 结构化表单 → `{name}.agent.json` 文件上传），后端 `configSchema` 是 jsonb **透传，无需改动**；客户端 `platformClient.install()` 把包内第一个 JSON 原样解析进 `config.installedAgentConfig`（[platformClient.ts](file:///e:/desktop-pet/src/main/platformClient.ts#L281-L298)），**也无需改动**——ASR 配置随 JSON 自然带进来。
- 「installedAgentConfig 不得携带 API 参数」的旧约束仅针对聊天 LLM（[config.ts](file:///e:/desktop-pet/src/main/config.ts#L160-L162) 注释）；ASR 是 agent 自带功能配置，用户明确要求支持，需更新注释说明区别。

## 设计总览

识别来源三选一（`config.voiceAsr.source`，默认 `local`）：

| 来源 | 说明 | 唤醒体验 |
|---|---|---|
| `local` | 现有本地 sherpa 模型包，完全离线 | 流式 partial「叫名字立刻回应」（不变） |
| `api` | 用户配置云端识别 API，两种模式：`transcribe`=OpenAI 兼容 `/audio/transcriptions`；`chat`=多模态聊天模型转写（`input_audio`） | 说完一句后识别（无流式 partial，`handleFinalVoice` 兜底唤醒逻辑不变） |
| `agent` | 已安装智能体**可选**携带 `asr` 配置（上传者勾选才有；key 可在客户端覆盖） | 同 api |

- **可选原则**：上传者默认不携带（checkbox 默认关）；客户端默认 `local`，用户在设置里自行切换。
- **文案原则**：所有面向用户的说明用通俗说法（「说话就能被听懂」「不用下载模型包」），不出现 ASR/WASM/流式等技术词。

客户端 Key 不落渲染端：音频经 IPC 到主进程，主进程实时 `loadConfig()` 解析生效配置并发起上游请求（与 LLM 同模式）。

### 配置类型（config.ts 定义并导出）

```ts
export interface VoiceAsrApiConfig {
  mode: 'transcribe' | 'chat';
  baseUrl: string;   // 如 https://api.openai.com/v1
  apiKey: string;
  model: string;     // transcribe: whisper-1；chat: gpt-4o-audio 等
  language?: string; // 仅 transcribe，默认 zh
}
// AppConfig 新增：
voiceAsr?: {
  source?: 'local' | 'api' | 'agent';
  api?: VoiceAsrApiConfig;      // source=api
  agentApiKey?: string;         // source=agent 时覆盖资源自带 key（可选）
};
// installedAgentConfig 允许可选 asr?: VoiceAsrApiConfig（agent 上传时携带）
```

## 改动清单

### 1. 主进程 [src/main.ts](file:///e:/desktop-pet/src/main.ts)

新增 `ipcMain.handle('asr:transcribe', ...)`：
- 入参 `{ wavBase64: string }`；`resolveAsrConfig()`：source=`api` → `voiceAsr.api`；source=`agent` → `installedAgentConfig.asr`（key 用 `voiceAsr.agentApiKey || asr.apiKey`）；未配置/不完整 → `{ ok:false, error:'未配置语音识别 API…' }`
- `transcribe` 模式：`POST {baseUrl}/audio/transcriptions`，`Authorization: Bearer`，FormData（Node18 原生）：`file=Blob(wav,'audio/wav')` + `model` + `language`，取响应 `text`
- `chat` 模式：`POST {baseUrl}/chat/completions`，末条 user content = `[{type:'text',text:'请将这段语音准确转写为文字，只输出转写内容'},{type:'input_audio',input_audio:{data:base64,format:'wav'}}]`，取 `choices[0].message.content`
- 返回 `{ ok, text? , error? }`

### 2. 渲染端新文件 [src/renderer/apiAsr.ts](file:///e:/desktop-pet/src/renderer/apiAsr.ts)

`ApiAsr` 类，接口与 speech-asr 对齐（`init()/start()/stop()/isReady`），使 `refreshMic` 无需改结构：
- `start()`：getUserMedia（echoCancellation/noiseSuppression/autoGainControl）+ AudioContext(16k) + ScriptProcessor(4096)
- `onaudioprocess`：`isSpeaking()` 时丢弃帧（防自听，复用 [speech.ts](file:///e:/desktop-pet/src/renderer/speech.ts)）；**能量 VAD**：RMS 阈值 ~0.015 判说话，静音 ≥800ms 且语音 ≥400ms 切分段
- 分段编码 WAV（16k mono PCM16）→ base64 → `electronAPI.asr.transcribe` → 文本回调 `onResult`
- 发送串行（inFlight 时仅保留最新一段，防堆积）；`onError` 节流回调
- 无 partial（云端无流式）

### 3. 引擎分流 [src/renderer/ambientSense.ts](file:///e:/desktop-pet/src/renderer/ambientSense.ts)

- `ensureAsr()` 读 `config.voiceAsr?.source`：`local` → 现有 sherpa 逻辑不变；`api`/`agent` → `new ApiAsr({ onResult: handleFinalVoice, onError })`
- `asr` 变量类型宽化为 `{ init(); start(); stop() } | null`；`wakeOnPartial` 仅 local 有 partial 触发，api/agent 自然降级为说完回应
- `handleFinalVoice`、唤醒窗、回声过滤全部复用不改

### 4. 设置 UI [src/components/ChatPanel.tsx](file:///e:/desktop-pet/src/components/ChatPanel.tsx)

「语音唤醒模型包」区块改造为「宠物怎么听懂你说话」radio 三选（通俗文案）：
- **本地语音模型**（离线可用）：说明「下载一次模型包后不用联网也能识别」；保留现有 zip 导入 UI
- **在线识别接口**：说明「填写一个支持语音识别的接口地址，不用下载模型包，但要联网」；mode 下拉（转写接口/聊天模型）+ baseUrl/apiKey/model/language 输入
- **智能体自带**：仅当 `config.installedAgentConfig?.asr` 存在时可选；说明「当前智能体「{name}」自带听懂说话的能力，选它就不用任何额外配置」；显示配置摘要（mode/model/baseUrl，key 打码）+ 可选「替换成自己的 Key」输入（说明：「智能体自带的密钥用完或不可用时，可填自己的」）
- form 新增字段、`handleSave` 写入 `config.voiceAsr`；`toggleMic` 失败提示按来源区分（如「还没有可用的语音识别方式，请在设置里选择并配置」）

### 5. 平台上传页 [platform/frontend/src/pages/UploadPage.tsx](file:///e:/desktop-pet/platform/frontend/src/pages/UploadPage.tsx)

- `AgentStructuredConfig`（L14）加可选 `asr?: VoiceAsrApiConfig 形状`
- 结构化表单加可折叠区块「让智能体自带语音识别（可选，默认关闭）」：启用 checkbox + mode 下拉 + baseUrl/apiKey/model/language → 合入 `structuredConfig`（L65-71、L138-149），随 `.agent.json` 下发
- 区块说明用通俗文案：「勾选后，安装这个智能体的人不用下载语音模型包，对着宠物说话就能被它听懂。需要填一个支持语音识别的接口地址。」
- raw 模式用户直接在 JSON 写 `asr` 字段即可（零改动）

### 6. 类型与桥接

- [src/main/config.ts](file:///e:/desktop-pet/src/main/config.ts)：新增类型 + AppConfig 字段；更新 installedAgentConfig 注释（人设 + 可选 asr 能力；聊天 LLM 仍 user-only）
- [src/global.d.ts](file:///e:/desktop-pet/src/global.d.ts)：同步 AppConfig、`electronAPI.asr.transcribe`
- [src/preload.ts](file:///e:/desktop-pet/src/preload.ts)：`asr: { transcribe: (payload) => ipcRenderer.invoke('asr:transcribe', payload) }`

### 7. 平台 seed 示例（端到端验证用）

[platform/backend/scripts/seed.ts](file:///e:/desktop-pet/platform/backend/scripts/seed.ts)（L77-92 参考）：新增一个携带 `asr` 配置的示例智能体（商店描述用通俗文案：「自带语音识别的智能体，安装后不用下载语音模型包就能和它说话」；key 留空，由安装者替换），验证「上传→安装→识别」全链路。

## 验证

1. 客户端 `npx tsc --noEmit`；平台前端 `npx tsc --noEmit`（后端无改动）
2. 云端 API 链路：聊天设置 → 来源=云端 API → 填转写服务配置 → 开持续聆听 → 说话叫名字 → 主进程日志 `[voice] final` → 唤醒/对话正常；重启客户端验证 `voiceAsr` 持久化
3. agent 链路：平台上传带 ASR 的智能体 → 客户端商店安装 → 聊天设置出现「智能体提供」并可选中 → 实测识别（key 覆盖生效）
4. local 回归：切回本地模型包，partial 即时唤醒等原有功能不变
