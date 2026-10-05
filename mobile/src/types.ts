/** 与桌面端共享的数据结构（经平台 /api/sync/* 同步） */

/** LLM API 档案 = 智能体：每个档案就是一个独立智能体，人设 + 独立对话
 *  桌面端 config.llmProfiles 同构，Key 服务端加密落库、传输时解密 */
export interface LlmProfile {
  id: string;
  /** 智能体显示名 */
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 智能体人设（系统提示词） */
  systemPrompt?: string;
  // ── 智能体页面 P0 扩展字段（均可选，旧数据向后兼容）──
  /** 头像（emoji 或文字，不填默认取 name 首字符） */
  avatar?: string;
  /** 简介 */
  intro?: string;
  /** 领域标签（医疗/训练/内容/陪伴/电商等） */
  domainTags?: string[];
  /** 角色（医生/训练师/经纪人/管家等） */
  role?: string;
  /** 风格（温柔/毒舌/专业/搞笑/简短等） */
  style?: string;
  /** 欢迎语（切换/新会话时展示） */
  greeting?: string;
  /** 示例问题（供用户快速提问） */
  exampleQuestions?: string[];
  /** 启停：false 时不可切换为当前智能体，聊天不可用该档案 */
  enabled?: boolean;
  // ── 智能体页面 P1-2：多智能体编排配置（含外部依赖与凭证引用，与桌面端同构）──
  multiConfig?: AgentMultiConfig;
  // ── 智能体自带能力（来自导入 JSON 的主动能力声明 + 用户导入时选择，随云同步）──
  capabilities?: AgentCapabilities;
  /** 专属朗读音色：已安装音色 id（downloadedVoices[].id，含系统/云/GPT-SoVITS 音色）；
   *  缺省或音色已被删除 = 跟随「设置」里的全局音色。属于本机偏好，导出智能体时不外带 */
  boundVoiceId?: string;
}

/** 智能体自带能力种类：tasks=按用户需求排定时任务（到点主动开口）；
 *  proactive=无需用户排期的主动搭话；web=需要时联网查询（用户自配搜索服务）；
 *  weather/stock/football=平台免费技能：查天气/A 股行情/竞彩足球赛程赔率（服务端代理，无需用户配 Key） */
export type AgentCapabilityKind = 'tasks' | 'proactive' | 'web' | 'weather' | 'stock' | 'football';

/** 联网搜索服务提供商（用户自配 Key；接口地址留空用默认） */
export type WebSearchProvider = 'bocha' | 'serper' | 'tavily';

/** 联网查询规格（属于该智能体自己，随档案云同步） */
export interface WebSearchSpec {
  provider: WebSearchProvider;
  apiKey: string;
  /** 自定义接口地址（留空用该提供商默认地址；走代理/自建网关时填） */
  endpoint?: string;
}

/** 能力规格：从该智能体自己的 JSON 读到的设置（缺省用应用兜底值） */
export interface AgentCapabilitySpec {
  /** 联网查询配置（仅 web 能力用） */
  web?: WebSearchSpec;
  /** 主动搭话间隔（分钟），来自 JSON 的 interval_minutes 等 */
  intervalMinutes?: number;
  /** 搭话时段 [start, end)，来自 JSON 的 waking_hours 等 */
  wakingHours?: [number, number];
  /** 示例任务（example_tasks[].user_input），用于合成该智能体的建任务提示词 */
  exampleTasks?: string[];
  /** 每日任务上限（frequency_control.max_active_tasks_per_day） */
  maxActiveTasksPerDay?: number;
  /** 检测时间 */
  detectedAt?: number;
  /** 来源：import=导入 JSON 检测；manual=编辑表单手动开启 */
  source?: 'import' | 'manual';
}

/** 该智能体启用的能力（导入时由用户勾选，编辑表单可调整） */
export interface AgentCapabilities {
  enabled: AgentCapabilityKind[];
  spec: AgentCapabilitySpec;
}

// ── 音色（商店「音色」板块 + 本机云 TTS）─────────────────────────────────

/**
 * 音色引擎配置（商店发布/JSON 导入的就是这份配置，绝不含 API Key）：
 * - system：Android 系统 TTS，voiceName 取系统音色名（离线、机械感）
 * - cloud ：OpenAI 兼容 /audio/speech 云合成，voiceId=音色名（可填克隆音色 id），
 *           接口/模型/Key 由「云 TTS 服务配置」统一提供（用户自己的凭证）
 * - gptsovits：用户自建 GPT-SoVITS 引擎（api_v2，默认端口 9880），
 *           refAudioPath=引擎所在机器上的参考音频路径 + promptText=参考音频说的话，
 *           零样本克隆无需训练；地址可音色自带或跟随全局配置
 */
export interface VoiceConfig {
  engine: 'system' | 'cloud' | 'gptsovits';
  /** engine=system：系统音色 name（listVoices 的 name，空=系统默认） */
  voiceName?: string;
  /** engine=cloud/gptsovits：接口根地址（cloud 如 https://api.openai.com/v1；gptsovits 如 http://192.168.1.5:9880），空=用全局云服务配置 */
  baseUrl?: string;
  /** engine=cloud：模型（tts-1 / gpt-4o-mini-tts / CosyVoice-300M-SFT 等），空=用全局配置 */
  model?: string;
  /** 音色 ID：OpenAI 系 alloy/echo/...；克隆音色填平台给的 voice id；gptsovits 无需填写 */
  voiceId: string;
  /** 风格指令（支持 instructions 的模型生效，如「温柔的大姐姐，语速偏慢」） */
  instructions?: string;
  /** 发布者给的推荐试听文本（安装后试听默认念这句） */
  sampleText?: string;
  // ── engine=gptsovits 专用 ──
  /** 参考音频路径（GPT-SoVITS 引擎所在机器上的绝对路径或 URL，3~10 秒干净人声） */
  refAudioPath?: string;
  /** 参考音频所说的话（决定克隆音色的发音与情感，需与音频内容一致） */
  promptText?: string;
  /** 参考音频语言（zh/en/ja/ko/yue，默认 zh） */
  promptLang?: string;
  /** 待合成文本语言（auto/zh/en/ja/ko/yue，默认 zh） */
  textLang?: string;
}

/** 已安装到本机的音色（商店资产或本机自建；随 config 云同步） */
export interface InstalledVoice {
  /** 商店资产 id；本机自建为 local- 前缀 */
  id: string;
  name: string;
  description?: string;
  config: VoiceConfig;
  /** 商店试听音频绝对地址（可空；为空时用本机配置现场合成试听） */
  sampleUrl?: string | null;
  version?: string;
  installedAt: number;
  fromStore?: boolean;
}

/** 用户自配的云 TTS 服务凭证（全局共享，apiKey 随云同步加密落库）
 *  engine：openai=OpenAI 兼容 /audio/speech（默认）；gptsovits=自建 GPT-SoVITS api_v2（只需地址，无需 Key） */
export interface TtsCloudConfig {
  engine?: 'openai' | 'gptsovits';
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 外部依赖类型：大模型 / 远程子智能体 / 工具 / 记忆库 / 其他 */
export type MultiAgentDepType = 'model' | 'agent_api' | 'tool_api' | 'memory' | 'other';
export type MultiAgentDepProtocol = 'openai' | 'rest' | 'a2a' | 'mcp' | 'other';
export type MultiAgentDepAuth = 'api_key' | 'bearer' | 'oauth' | 'none';

/** 单条外部依赖（识别自配置中的 ${VAR} / {{VAR}} / env:VAR / secret:VAR 占位符） */
export interface MultiAgentDependency {
  /** 占位符变量名（如 MODEL_API） */
  key: string;
  type: MultiAgentDepType;
  protocol: MultiAgentDepProtocol;
  auth: MultiAgentDepAuth;
  /** 用途说明（中文，可被用户改写） */
  usage: string;
  /** 示例值 */
  example: string;
  /** 内部凭证引用，如 cred://dep_1（运行时注入真实值） */
  ref: string;
}

/** 多智能体编排配置（随 LlmProfile 云同步；credentials 上云加密，导出剥离） */
export interface AgentMultiConfig {
  /** 用户原始配置文本（含 ${KEY} 占位符） */
  raw: string;
  format: 'yaml' | 'json';
  /** 依赖清单（含 cred:// 引用） */
  deps: MultiAgentDependency[];
  /** 占位符 key → 真实值（仅本地明文；云同步加密存储；导出剥离） */
  credentials: Record<string, string>;
}

export interface ChatMsg {
  /** 消息稳定 id（历史消息可能没有，渲染时回退下标） */
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思考过程（开启显示思考时由模型返回，DeepSeek 风格卡片展示） */
  reasoning?: string;
  /** 思考用时秒数（发送到收到回复的耗时） */
  thinkSeconds?: number;
  /** 等待模型响应（展示「正在思考」过渡气泡） */
  pending?: boolean;
  /** 流式输出进行中（思考/正文逐字到达） */
  streaming?: boolean;
  /** 请求失败（气泡可点击重试） */
  error?: boolean;
}

/** 定时任务：用户让智能体在指定时间做的事（提醒/主动搭话），到点由智能体主动发消息 */
export interface PetTask {
  id: string;
  /** 归属智能体档案（每个智能体自己的任务） */
  profileId: string;
  /** reminder=提醒类（叫我起床/提醒我喝水）；active_chat=主动搭话类（问我今天开不开心） */
  kind: 'reminder' | 'active_chat';
  /** 用户原话（整句） */
  rawText: string;
  /** 任务内容（剥离时间短语后的原句，如「叫我起床」） */
  content: string;
  /** 创建时的时间展示（今天 15:30 / 每天 08:00） */
  timeLabel: string;
  /** 触发时间戳（ms） */
  due: number;
  /** 一次性 / 每天 / 每周 */
  repeat: 'none' | 'daily' | 'weekly';
  status: 'pending' | 'paused' | 'done' | 'canceled';
  createdAt: number;
  /** 最近一次触发时间（防重复触发） */
  firedAt?: number;
}

/** 聊天人设：来自平台智能体 JSON（installedAgentConfig）或默认 */
export interface AgentConfig {
  /** 智能体唯一 ID（安装时生成，用于隔离消息） */
  id: string;
  name?: string;
  systemPrompt?: string;
  [key: string]: unknown;
}

export interface PlatformUser {
  id: string;
  email: string;
  username: string;
  role?: string;
}

/** 商店资源条目（agents 列表通用） */
export interface AssetItem {
  id: string;
  name: string;
  /** 智能体：配置文件地址 */
  fileUrl?: string;
  format?: string;
  downloads?: number;
  description?: string | null;
  [key: string]: unknown;
}
