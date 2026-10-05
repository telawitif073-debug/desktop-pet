import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { DEFAULT_VITALS, normalizeVitals, type PetVitals } from '@pet/domain';

export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  /** 采样温度；未配置时 llmService 用默认值 0.8（平台/智能体不再提供覆盖） */
  temperature?: number;
  /** 是否显示/请求思考过程（随 AppConfig.showThinking 生效；未开启不注入 thinking 参数） */
  showThinking?: boolean;
  /** 思考语言：auto=跟随模型 zh/en=强制模型用对应语言思考（注入末条用户消息 + 系统提示词） */
  thinkingLang?: 'auto' | 'zh' | 'en';
}

/** 多 API 配置档案：聊天设置中可保存多个 API 并一键切换生效。
 *  LlmProfile = 智能体（与手机端 mobile/src/types.ts 同构）：档案自带人设、绑定专属音色，
 *  对话与定时任务都按档案隔离。 */
export interface LlmProfile {
  id: string;
  /** 展示名（如"DeepSeek 官方"） */
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 档案级系统提示词；空 = 沿用默认 llm 的提示词 */
  systemPrompt?: string;
  // ── 智能体扩展字段（与手机端一致；均可选，旧 6 字段档案自动升级）──
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
  /** 启停：false 时不参与激活选择，聊天不可用该档案 */
  enabled?: boolean;
  /** 多智能体编排配置（含外部依赖与凭证引用） */
  multiConfig?: AgentMultiConfig;
  /** 智能体自带能力（导入 JSON 的能力声明 + 用户勾选） */
  capabilities?: AgentCapabilities;
  /** 专属朗读音色：已安装音色 id（downloadedVoices[].id）；缺省或音色已删除 = 跟随全局音色。
   *  属于本机偏好，导出智能体时不外带 */
  boundVoiceId?: string;
}

// ── 智能体能力（对齐 mobile/src/types.ts）────────────────────────────────

/** 智能体自带能力种类：tasks=按用户需求排定时任务；proactive=无需排期的主动搭话；
 *  web=需要时联网查询（用户自配搜索服务）；weather/stock/football=平台免费技能 */
export type AgentCapabilityKind = 'tasks' | 'proactive' | 'web' | 'weather' | 'stock' | 'football';

/** 联网搜索服务提供商（用户自配 Key；接口地址留空用默认） */
export type WebSearchProvider = 'bocha' | 'serper' | 'tavily';

/** 联网查询规格（属于该智能体自己，随档案云同步） */
export interface WebSearchSpec {
  provider: WebSearchProvider;
  apiKey: string;
  /** 自定义接口地址（留空用该提供商默认地址） */
  endpoint?: string;
}

/** 能力规格：从该智能体自己的 JSON 读到的设置（缺省用应用兜底值） */
export interface AgentCapabilitySpec {
  /** 联网查询配置（仅 web 能力用） */
  web?: WebSearchSpec;
  /** 主动搭话间隔（分钟） */
  intervalMinutes?: number;
  /** 搭话时段 [start, end) */
  wakingHours?: [number, number];
  /** 示例任务（example_tasks[].user_input） */
  exampleTasks?: string[];
  /** 每日任务上限 */
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

// ── 多智能体编排（对齐 mobile/src/types.ts）──────────────────────────────

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

// ── 音色（对齐 mobile/src/types.ts；桌面上线三引擎，Edge 为桌面特有引擎）────

/**
 * 音色引擎配置（商店发布/JSON 导入的就是这份配置，绝不含 API Key）：
 * - system：系统 TTS（桌面为 Web Speech 离线音色，机械感）
 * - cloud ：OpenAI 兼容 /audio/speech 云合成，voiceId=音色名（可填克隆音色 id），
 *           接口/模型/Key 由「云 TTS 服务配置」统一提供（用户自己的凭证）
 * - gptsovits：用户自建 GPT-SoVITS 引擎（api_v2，默认端口 9880），
 *           refAudioPath=引擎所在机器上的参考音频路径 + promptText=参考音频说的话，
 *           零样本克隆无需训练；地址可音色自带或跟随全局配置
 */
export interface VoiceConfig {
  engine: 'system' | 'cloud' | 'gptsovits';
  /** engine=system：系统音色 name（空=系统默认） */
  voiceName?: string;
  /** engine=cloud/gptsovits：接口根地址，空=用全局云服务配置 */
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
  /** 参考音频所说的话（需与音频内容一致） */
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

/** 云 TTS 服务配置默认值（engine=openai） */
export const DEFAULT_TTS_CLOUD_CONFIG: TtsCloudConfig = {
  engine: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
};

/** 会话历史消息（按档案隔离存储的最小形态；system 提示词不落盘） */
export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 思考过程（开启 showThinking 时由模型返回，随消息持久化） */
  reasoning?: string;
}

/**
 * 尚无任何智能体档案时，聊天记录挂靠的保留键：
 * 旧版单档案 chat-history.json 会迁移到这里，保证「未建档案时聊天记录不丢失」。
 * 用户创建首个档案后由档案自己的历史接管（旧记录仍保留在本键下，随 config 云同步）。
 */
export const UNBOUND_PROFILE_ID = '__unbound__';

export interface UserProfile {
  name: string;
  preferences: Record<string, unknown>;
}

export interface PlatformConfig {
  baseUrl: string;
  frontendUrl: string;
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; email: string; role: 'user' | 'admin' } | null;
}

/** 智能体主动对话配置：定时以消息发起聊天（仅唤醒时段 8-22 点） */
export interface AgentProactiveConfig {
  enabled: boolean;
  /** 发起间隔（分钟），下限 10 分钟 */
  intervalMinutes: number;
}

/** 语音朗读配置（Edge TTS 免费 Neural 音色优先，系统 Web Speech 兜底） */
export interface SpeechSettings {
  /** 总开关：关闭后回复不朗读 */
  enabled: boolean;
  /** 音色：'' 或 'edge:ShortName'（Edge 神经音色）| 'sys:voiceURI'（系统声音）；空 = Edge 默认晓晓 */
  voice?: string;
  /** @deprecated 旧系统音色字段，迁移至 voice（sys: 前缀），读取时兼容 */
  voiceURI?: string;
  /** 语气预设：natural=自然 happy=开心 gentle=温柔 serious=严肃 lazy=慵懒 */
  tone: 'natural' | 'happy' | 'gentle' | 'serious' | 'lazy';
  /** 语速 0.5~2（1=正常） */
  rate: number;
  /** 声线（音调）0~2（1=正常，越高越尖锐） */
  pitch: number;
  /** 音量 0~1 */
  volume: number;
}

// ── 宠物（共享模块 pet/ 的桌面配置形态）────────────────────────────────────

/** 宠物动作定义（帧序列 / 模型内置 clip / 视频；与 pet/domain 的 PetActionLike 对齐） */
export interface PetActionConfig {
  id: string;
  name: string;
  kind: 'frames' | 'clip' | 'video';
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  frameRate?: number;
  frameFiles?: string[];
  clipName?: string;
  videoFile?: string;
  petAssetId?: string;
  builtinPetId?: string;
}

/** 互动绑定：feed/rest/play → 动作 id（缺省 = 按动作池自动挑选） */
export type PetActionBindings = Partial<Record<'feed' | 'rest' | 'play', string>>;

/** 已安装到本机的宠物（资源包 / 内置形象） */
export interface InstalledPet {
  id: string;
  name: string;
  /** image / pack / live2d / model3d */
  format: string;
  localPath?: string;
  version?: string;
  installedAt: number;
  fromStore?: boolean;
}

/** 宠物窗口外观 */
export interface PetWindowSettings {
  width: number;
  height: number;
  /** 0~1 透明度 */
  opacity: number;
}

/** 宠物功能开关（喂食/玩耍/休息；关闭的维度不衰减） */
export interface PetFeatureSettings {
  feedEnabled: boolean;
  playEnabled: boolean;
  restEnabled: boolean;
}

/**
 * 宠物系统设置：与 `pet/api/syncKeys.ts` 的 PET_CONFIG_KEYS 12 个键一一对应，
 * 外加窗口外观 / 功能开关 / 总开关 / 聊天联动心情四个本机偏好。
 */
export interface PetSettings {
  petAssetPath: string;
  petAssetName: string;
  petAssetId: string;
  petAssetFormat: string;
  builtinPet: string;
  petActions: PetActionConfig[];
  petActionBindings: PetActionBindings;
  petState: PetVitals;
  petStateReady: boolean;
  petSelfDescription: string;
  currentPet: string;
  downloadedPets: InstalledPet[];
  petWindow: PetWindowSettings;
  petFeatures: PetFeatureSettings;
  petSystemEnabled: boolean;
  moodFromChat: boolean;
}

/** 宠物设置默认值（四维沿用共享模块的 DEFAULT_VITALS） */
export const DEFAULT_PET_SETTINGS: PetSettings = {
  petAssetPath: '',
  petAssetName: '',
  petAssetId: '',
  petAssetFormat: '',
  builtinPet: '',
  petActions: [],
  petActionBindings: {},
  petState: { ...DEFAULT_VITALS },
  petStateReady: false,
  petSelfDescription: '',
  currentPet: '',
  downloadedPets: [],
  petWindow: { width: 220, height: 260, opacity: 0.9 },
  petFeatures: { feedEnabled: true, playEnabled: true, restEnabled: true },
  petSystemEnabled: true,
  moodFromChat: true,
};

export interface AppConfig {
  agentType: string;
  userProfile: UserProfile;
  platform: PlatformConfig;
  /** 智能体主动对话配置 */
  agentProactive?: AgentProactiveConfig;
  /** 语音朗读配置（渲染端 Web Speech API） */
  speech?: SpeechSettings;
  /** 多 API 配置档案：聊天 API 全部由用户在客户端配置（平台不提供），列表内各档案同级、选中即生效 */
  llmProfiles?: LlmProfile[];
  /** 当前生效的档案 id */
  llmActiveProfileId?: string;
  /** 各档案的聊天记录（按档案 id 隔离；随 config 云同步，旧单档案 chat-history.json 自动迁移到激活档案） */
  profileMessages?: Record<string, StoredChatMessage[]>;
  /** 已安装音色（本机音色库；随 config 云同步，不含任何 API Key） */
  downloadedVoices?: InstalledVoice[];
  /** 全局音色选择（downloadedVoices[].id）；空 = 用桌面 Edge/系统音色 */
  activeCloudVoiceId?: string;
  /** 云 TTS 服务凭证（全局共享；云同步时 apiKey 由服务端加密落库） */
  ttsCloudConfig?: TtsCloudConfig;
  /** 是否显示思考过程（DeepSeek 风格思考卡） */
  showThinking?: boolean;
  /** 思考语言：auto=跟随模型 zh/en=提示模型用对应语言思考 */
  thinkingLang?: 'auto' | 'zh' | 'en';
  /** 清空对话前是否弹确认：ask=每次询问（默认） never=直接清空（用户选过"以后不再询问"，设置中可改回） */
  chatClearConfirm?: 'ask' | 'never';
  agentConfigPath?: string;
  installedAgentId?: string;
  /** 已安装智能体：人设（name/systemPrompt）；聊天 LLM 参数仍一律由用户配置（平台不提供 API） */
  installedAgentConfig?: unknown;
  /** 宠物系统设置（与共享模块 pet/api 的 12 个配置键对应，另含窗口/开关等本机偏好） */
  pet?: PetSettings;
}

const DEFAULT_CONFIG: AppConfig = {
  agentType: 'default',
  userProfile: {
    name: '',
    preferences: {},
  },
  platform: {
    baseUrl: 'http://localhost:3001/api',
    frontendUrl: 'http://localhost:5174',
    accessToken: '',
    refreshToken: '',
    user: null,
  },
  agentProactive: {
    enabled: true,
    intervalMinutes: 30,
  },
  // ── 智能体档案 / 音色 / 对话与任务（与手机端同构的初始值）──
  llmProfiles: [],
  llmActiveProfileId: '',
  profileMessages: {},
  downloadedVoices: [],
  activeCloudVoiceId: '',
  ttsCloudConfig: { ...DEFAULT_TTS_CLOUD_CONFIG },
  showThinking: false,
  thinkingLang: 'auto',
  // 宠物设置（默认关闭状态就绪，形象/动作由用户导入或安装后填充）
  pet: normalizePetSettings(DEFAULT_PET_SETTINGS),
};

let cachedConfig: AppConfig | null = null;

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** 档案归一化（旧 6 字段档案向新形态升级，幂等）：剔除非法条目、字符串字段补空串、
 *  enabled 缺省视为启用。
 *  返回 changed=true 表示发生过结构升级，启动时一次性回写磁盘。 */
function normalizeProfiles(value: unknown): { profiles: LlmProfile[]; changed: boolean } {
  if (!Array.isArray(value)) return { profiles: [], changed: Array.isArray(value) === false && value != null };
  let changed = false;
  const profiles: LlmProfile[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      changed = true;
      continue;
    }
    const p = item as LlmProfile;
    if (typeof p.id !== 'string' || !p.id) {
      changed = true;
      continue;
    }
    const apiKey = typeof p.apiKey === 'string' ? p.apiKey : '';
    const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : '';
    const model = typeof p.model === 'string' ? p.model : '';
    const enabled = p.enabled !== false;
    if (apiKey !== p.apiKey || baseUrl !== p.baseUrl || model !== p.model || enabled !== p.enabled) {
      changed = true;
    }
    profiles.push({ ...p, apiKey, baseUrl, model, enabled });
  }
  return { profiles, changed };
}

/** 历史消息归一化（外部边界清洗：只保留 user/assistant 且 content 为字符串的条目） */
export function sanitizeMessages(value: unknown): StoredChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as { role?: unknown; content?: unknown; reasoning?: unknown };
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (typeof msg.content !== 'string') continue;
    out.push({
      role: msg.role,
      content: msg.content,
      ...(typeof msg.reasoning === 'string' && msg.reasoning ? { reasoning: msg.reasoning } : {}),
    });
  }
  return out;
}

/** profileMessages 归一化：按档案 id 清洗消息（云端旧档可能类型不对） */
function normalizeProfileMessages(value: unknown): Record<string, StoredChatMessage[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, StoredChatMessage[]> = {};
  for (const [id, messages] of Object.entries(value as Record<string, unknown>)) {
    if (!id) continue;
    const clean = sanitizeMessages(messages);
    if (clean.length) out[id] = clean;
  }
  return out;
}

/** 已安装音色归一化：剔除无 id/无合法 config 的条目，补默认值 */
function normalizeVoices(value: unknown): InstalledVoice[] {
  if (!Array.isArray(value)) return [];
  const out: InstalledVoice[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const v = item as InstalledVoice;
    if (typeof v.id !== 'string' || !v.id) continue;
    const cfg = v.config as VoiceConfig | undefined;
    if (!cfg || typeof cfg !== 'object' || typeof cfg.engine !== 'string') continue;
    out.push({
      ...v,
      name: typeof v.name === 'string' && v.name ? v.name : v.id,
      installedAt: typeof v.installedAt === 'number' ? v.installedAt : Date.now(),
      config: { ...cfg, voiceId: typeof cfg.voiceId === 'string' ? cfg.voiceId : '' },
    });
  }
  return out;
}

/** 云 TTS 凭证归一化（engine 缺省 openai，其余字符串补空串） */
function normalizeTtsCloudConfig(value: unknown): TtsCloudConfig {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<TtsCloudConfig>;
  return {
    engine: v.engine === 'gptsovits' ? 'gptsovits' : 'openai',
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : '',
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
    model: typeof v.model === 'string' ? v.model : '',
  };
}

/** 宠物动作归一化：剔除无 id/无 name 的条目，补齐 kind 与数值字段（幂等） */
function normalizePetActions(value: unknown): PetActionConfig[] {
  if (!Array.isArray(value)) return [];
  const out: PetActionConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Partial<PetActionConfig>;
    if (typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || !a.name) continue;
    out.push({
      id: a.id,
      name: a.name,
      kind: a.kind === 'clip' || a.kind === 'video' ? a.kind : 'frames',
      ...(a.interaction ? { interaction: a.interaction } : {}),
      ...(typeof a.frameRate === 'number' && Number.isFinite(a.frameRate) ? { frameRate: a.frameRate } : {}),
      ...(Array.isArray(a.frameFiles)
        ? { frameFiles: a.frameFiles.filter((f): f is string => typeof f === 'string') }
        : {}),
      ...(typeof a.clipName === 'string' ? { clipName: a.clipName } : {}),
      ...(typeof a.videoFile === 'string' ? { videoFile: a.videoFile } : {}),
      ...(typeof a.petAssetId === 'string' ? { petAssetId: a.petAssetId } : {}),
      ...(typeof a.builtinPetId === 'string' ? { builtinPetId: a.builtinPetId } : {}),
    });
  }
  return out;
}

/** 已安装宠物归一化：剔除无 id 的条目，补齐 name/format/installedAt */
function normalizeInstalledPets(value: unknown): InstalledPet[] {
  if (!Array.isArray(value)) return [];
  const out: InstalledPet[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Partial<InstalledPet>;
    if (typeof p.id !== 'string' || !p.id) continue;
    out.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name ? p.name : p.id,
      format: typeof p.format === 'string' ? p.format : '',
      ...(typeof p.localPath === 'string' ? { localPath: p.localPath } : {}),
      ...(typeof p.version === 'string' ? { version: p.version } : {}),
      installedAt: typeof p.installedAt === 'number' ? p.installedAt : 0,
      ...(p.fromStore === true ? { fromStore: true } : {}),
    });
  }
  return out;
}

/**
 * 宠物设置归一化（幂等）：缺失/类型不对的字段回落默认值，四维走共享模块 normalizeVitals 消毒。
 * 兼容旧配置：老版本可能只写入了 PET_CONFIG_KEYS 里的部分键。
 */
export function normalizePetSettings(value: unknown): PetSettings {
  const src = (value && typeof value === 'object' ? value : {}) as Partial<PetSettings>;
  const win = (src.petWindow && typeof src.petWindow === 'object' ? src.petWindow : {}) as Partial<PetWindowSettings>;
  const feats = (src.petFeatures && typeof src.petFeatures === 'object' ? src.petFeatures : {}) as Partial<PetFeatureSettings>;
  const bindings = (src.petActionBindings && typeof src.petActionBindings === 'object'
    ? src.petActionBindings
    : {}) as PetActionBindings;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const size = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
  const ratio = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  return {
    petAssetPath: str(src.petAssetPath),
    petAssetName: str(src.petAssetName),
    petAssetId: str(src.petAssetId),
    petAssetFormat: str(src.petAssetFormat),
    builtinPet: str(src.builtinPet),
    petActions: normalizePetActions(src.petActions),
    petActionBindings: {
      ...(typeof bindings.feed === 'string' ? { feed: bindings.feed } : {}),
      ...(typeof bindings.rest === 'string' ? { rest: bindings.rest } : {}),
      ...(typeof bindings.play === 'string' ? { play: bindings.play } : {}),
    },
    petState: normalizeVitals(src.petState),
    petStateReady: src.petStateReady === true,
    petSelfDescription: str(src.petSelfDescription),
    currentPet: str(src.currentPet),
    downloadedPets: normalizeInstalledPets(src.downloadedPets),
    petWindow: {
      width: size(win.width, DEFAULT_PET_SETTINGS.petWindow.width),
      height: size(win.height, DEFAULT_PET_SETTINGS.petWindow.height),
      opacity: ratio(win.opacity, DEFAULT_PET_SETTINGS.petWindow.opacity),
    },
    petFeatures: {
      feedEnabled: feats.feedEnabled !== false,
      playEnabled: feats.playEnabled !== false,
      restEnabled: feats.restEnabled !== false,
    },
    petSystemEnabled: src.petSystemEnabled !== false,
    moodFromChat: src.moodFromChat !== false,
  };
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const { profiles, changed: profilesChanged } = normalizeProfiles(parsed.llmProfiles);
      const loaded: AppConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        platform: { ...DEFAULT_CONFIG.platform, ...(parsed.platform || {}) },
        agentProactive: {
          enabled: parsed.agentProactive?.enabled ?? DEFAULT_CONFIG.agentProactive!.enabled,
          intervalMinutes: parsed.agentProactive?.intervalMinutes ?? DEFAULT_CONFIG.agentProactive!.intervalMinutes,
        },
        llmProfiles: profiles,
        llmActiveProfileId: typeof parsed.llmActiveProfileId === 'string' ? parsed.llmActiveProfileId : '',
        profileMessages: normalizeProfileMessages(parsed.profileMessages),
        downloadedVoices: normalizeVoices(parsed.downloadedVoices),
        activeCloudVoiceId: typeof parsed.activeCloudVoiceId === 'string' ? parsed.activeCloudVoiceId : '',
        ttsCloudConfig: normalizeTtsCloudConfig(parsed.ttsCloudConfig),
        showThinking: parsed.showThinking === true,
        thinkingLang: parsed.thinkingLang === 'zh' || parsed.thinkingLang === 'en' ? parsed.thinkingLang : 'auto',
        pet: normalizePetSettings(parsed.pet),
      };
      if (loaded.platform.frontendUrl === 'http://localhost:5173') {
        loaded.platform.frontendUrl = DEFAULT_CONFIG.platform.frontendUrl;
      }
      // 先入缓存再回写：saveConfig 内部的 loadConfig 直接命中缓存，不会递归
      cachedConfig = loaded;
      // 旧 6 字段档案升级为新形态后一次性落盘（幂等：升级后 changed=false，不再写）
      if (profilesChanged) saveConfig(loaded);
    } else {
      cachedConfig = { ...DEFAULT_CONFIG };
      saveConfig(cachedConfig);
    }
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  return cachedConfig!;
}

export function saveConfig(config: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  cachedConfig = {
    ...current,
    ...config,
    userProfile: { ...current.userProfile, ...(config.userProfile || {}) },
    platform: { ...current.platform, ...(config.platform || {}) },
    agentProactive: {
      enabled: config.agentProactive?.enabled ?? current.agentProactive?.enabled ?? true,
      intervalMinutes: config.agentProactive?.intervalMinutes ?? current.agentProactive?.intervalMinutes ?? 30,
    },
    // 档案与多档消息：整体替换语义（写入方必须给全量字典，删除档案消息才能生效）
    llmProfiles: config.llmProfiles !== undefined
      ? normalizeProfiles(config.llmProfiles).profiles
      : current.llmProfiles,
    profileMessages: config.profileMessages !== undefined
      ? normalizeProfileMessages(config.profileMessages)
      : current.profileMessages,
    // 音色库：整体替换（下载/删除即全量写回）
    downloadedVoices: config.downloadedVoices !== undefined
      ? normalizeVoices(config.downloadedVoices)
      : current.downloadedVoices ?? [],
    activeCloudVoiceId: config.activeCloudVoiceId !== undefined
      ? config.activeCloudVoiceId
      : current.activeCloudVoiceId ?? '',
    ttsCloudConfig: config.ttsCloudConfig !== undefined
      ? normalizeTtsCloudConfig({ ...(current.ttsCloudConfig || {}), ...config.ttsCloudConfig })
      : current.ttsCloudConfig,
    showThinking: config.showThinking ?? current.showThinking ?? false,
    thinkingLang: config.thinkingLang ?? current.thinkingLang ?? 'auto',
    // 宠物设置：局部补丁浅合并后归一化（幂等；未给 pet 时保留当前值）
    pet: config.pet !== undefined
      ? normalizePetSettings({ ...(current.pet || {}), ...config.pet })
      : current.pet ?? DEFAULT_PET_SETTINGS,
  };
  const configPath = getConfigPath();
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(cachedConfig, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
  return cachedConfig;
}

/** 未配置 API 时的兜底系统提示词（保持基本人格，聊天会因缺少 Key 而提示配置） */
const FALLBACK_SYSTEM_PROMPT = '你是一个乐于助人的智能助手，用简短、友好的语气回复用户。';

/** 档案是否启用（旧档无该字段 = 启用） */
export function isProfileEnabled(profile: LlmProfile): boolean {
  return profile.enabled !== false;
}

/**
 * 生效档案选择（对齐手机端激活规则 + 启用态过滤）：
 * 1) llmActiveProfileId 指向且未停用 → 取它；
 * 2) 否则取首个未停用档案（激活档案被停用/删除时自动让位）；
 * 3) 全部停用或无档案 → 无生效档案（聊天给出未配置提示）。
 */
export function resolveActiveProfile(config?: AppConfig): LlmProfile | undefined {
  const cfg = config ?? loadConfig();
  const profiles = Array.isArray(cfg.llmProfiles) ? cfg.llmProfiles : [];
  if (!profiles.length) return undefined;
  const active = profiles.find((p) => p.id === cfg.llmActiveProfileId);
  if (active && isProfileEnabled(active)) return active;
  return profiles.find(isProfileEnabled);
}

/** 生效档案 id（'' = 无可用档案） */
export function resolveActiveProfileId(config?: AppConfig): string {
  return resolveActiveProfile(config)?.id ?? '';
}

/**
 * 聊天 LLM 生效配置：API 全部由用户在客户端配置（平台不提供任何默认 API）。
 * 只认 llmProfiles 档案列表：激活档案（未停用）优先，停用/删除后回落首个启用档案；
 * 一个可用档案都没有时返回空配置（apiKey/baseUrl 为空，llmService 会给出明确提示）。
 * 已安装智能体只提供人设，不再覆盖 model/baseUrl/temperature。
 */
export function getLLMConfig(): LLMConfig {
  const config = loadConfig();
  const thinking = {
    showThinking: config.showThinking === true,
    thinkingLang: config.thinkingLang ?? 'auto',
  };
  const activeProfile = resolveActiveProfile(config);
  if (!activeProfile) {
    return {
      provider: 'openai',
      apiKey: '',
      baseUrl: '',
      model: '',
      systemPrompt: FALLBACK_SYSTEM_PROMPT,
      ...thinking,
    };
  }
  return {
    provider: 'openai',
    apiKey: activeProfile.apiKey || '',
    baseUrl: activeProfile.baseUrl || '',
    model: activeProfile.model || '',
    systemPrompt: activeProfile.systemPrompt || FALLBACK_SYSTEM_PROMPT,
    ...thinking,
  };
}
