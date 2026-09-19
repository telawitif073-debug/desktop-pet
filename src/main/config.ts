import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  /** 采样温度；未配置时 llmService 用默认值 0.8（平台/智能体不再提供覆盖） */
  temperature?: number;
}

/** 多 API 配置档案：聊天设置中可保存多个 API 并一键切换生效 */
export interface LlmProfile {
  id: string;
  /** 展示名（如"DeepSeek 官方"） */
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 档案级系统提示词；空 = 沿用默认 llm 的提示词 */
  systemPrompt?: string;
}

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

/** 宠物窗口设置（大小 / 透明度），可在资源库"设置"页调整 */
export interface PetWindowConfig {
  width: number;
  height: number;
  opacity: number;
  /** 是否置顶显示（窗口保持在其他应用之上），默认 true */
  alwaysOnTop?: boolean;
}

/** 宠物互动功能开关（喂食/休息/玩耍/好感度），可在资源库"设置"页调整；
 * 关闭后隐藏对应按钮与进度条，并冻结对应数值的衰减 */
export interface PetFeaturesConfig {
  feedEnabled: boolean;
  restEnabled: boolean;
  playEnabled: boolean;
  affectionEnabled: boolean;
}

/** 宠物资源形态：image=单张图片（含 GIF），pack=多图帧序列包，live2d=Live2D 模型包，model3d=3D 模型（glb/gltf） */
export type PetFormat = 'image' | 'pack' | 'live2d' | 'model3d';

/** 宠物动作：kind=frames 为帧序列（手动上传/宠物资源包附带），
 * kind=clip 为 Live2D/3D 模型内置动画 clip（仅模型宠物可用）。
 * petAssetId 标记动作属于哪个宠物资源（动作随宠物，不可跨宠物使用） */
export interface PetAction {
  id: string;
  name: string;
  kind: 'frames' | 'clip';
  source: 'ai' | 'manual' | 'platform';
  frameFiles?: string[];
  frameRate?: number;
  /** kind=clip 时的模型内置动画名称 */
  clipName?: string;
  /** 所属宠物资源 id（platform 来源动作） */
  petAssetId?: string;
  /** 互动绑定（feed/rest/play），安装时写入 petActionBindings */
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  createdAt: number;
}

/** 动作数量上限 */
export const PET_ACTIONS_MAX = 15;

/** 互动功能绑定的动作 id：喂食/休息/玩耍触发时优先播放绑定的资源库动作，未绑定回退同名动作 */
export interface PetActionBindings {
  feed?: string;
  rest?: string;
  play?: string;
}

/** 智能体主动对话配置：定时以气泡发起聊天（仅唤醒时段 8-22 点），状态低值时提醒 */
export interface AgentProactiveConfig {
  enabled: boolean;
  /** 发起间隔（分钟），下限 10 分钟 */
  intervalMinutes: number;
}

/** 宠物语音朗读配置（Edge TTS 免费 Neural 音色优先，系统 Web Speech 兜底） */
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

/** 语音配置默认值见渲染端 renderer/speech.ts DEFAULT_SPEECH（主进程仅持久化类型） */

/** 云端语音识别接口配置（OpenAI 兼容）：转写接口或多模态聊天模型均可 */
export interface VoiceAsrApiConfig {
  /** transcribe=OpenAI 兼容 /audio/transcriptions 转写接口；chat=多模态聊天模型转写（input_audio） */
  mode: 'transcribe' | 'chat';
  /** 接口根地址，如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** transcribe: whisper-1 等；chat: gpt-4o-audio 等支持音频输入的模型 */
  model: string;
  /** 语言提示（仅 transcribe 生效，默认 zh） */
  language?: string;
}

/** 宠物「听懂说话」的来源配置：本地模型包 / 用户自配在线接口 / 已安装智能体自带（可选携带） */
export interface VoiceAsrConfig {
  /** local=本地 sherpa 模型包（默认，离线） api=用户自配在线接口 agent=智能体自带 */
  source?: 'local' | 'api' | 'agent';
  /** source=api 时的接口配置 */
  api?: VoiceAsrApiConfig;
  /** source=agent 时替换智能体自带密钥（可选；智能体自带密钥用完/不可用时填自己的） */
  agentApiKey?: string;
}

export interface AppConfig {
  petSystemEnabled: boolean;
  foodSystemEnabled: boolean;
  randomMoveEnabled: boolean;
  agentType: string;
  userProfile: UserProfile;
  petState: {
    hunger: number;
    mood: number;
    energy: number;
    affection: number;
  };
  petWindow: PetWindowConfig;
  petFeatures: PetFeaturesConfig;
  petActions: PetAction[];
  petActionBindings?: PetActionBindings;
  platform: PlatformConfig;
  petAssetPath?: string;
  /** 当前安装宠物的资源名称（如"橘猫桌面形象"） */
  petAssetName?: string;
  /** 当前安装宠物的资源 id（动作随宠物挂靠） */
  petAssetId?: string;
  /** 当前安装宠物的资源形态（image/pack/live2d/model3d），渲染端据此选择渲染方式 */
  petAssetFormat?: PetFormat;
  /** 智能体主动对话配置 */
  agentProactive?: AgentProactiveConfig;
  /** 宠物语音朗读配置（渲染端 Web Speech API） */
  speech?: SpeechSettings;
  /** 多 API 配置档案：聊天 API 全部由用户在客户端配置（平台不提供），列表内各档案同级、选中即生效 */
  llmProfiles?: LlmProfile[];
  /** 当前生效的档案 id */
  llmActiveProfileId?: string;
  /** 清空对话前是否弹确认：ask=每次询问（默认） never=直接清空（用户选过"以后不再询问"，设置中可改回） */
  chatClearConfirm?: 'ask' | 'never';
  /** 感知能力开关（隐私敏感，默认全关）：screen=查看桌面（截屏附图） mic=麦克风语音输入 camera=摄像头拍照 */
  petSenses?: { screen: boolean; mic: boolean; camera: boolean };
  /** 宠物名字（语音唤醒词，听到名字回应并聆听需求） */
  petName?: string;
  /** 唤醒后对话模式：once=每次对话后需重新叫名字（默认） continuous=连续对话，叫一次名字后可持续说，超时自动结束 */
  voiceWakeMode?: 'once' | 'continuous';
  /** 语音唤醒模型包来源（本地 zip 路径或下载 URL），由用户在聊天设置中配置导入 */
  voiceModelSource?: string;
  /** 宠物「听懂说话」来源：本地模型包 / 在线接口 / 智能体自带（详见 VoiceAsrConfig） */
  voiceAsr?: VoiceAsrConfig;
  agentConfigPath?: string;
  installedAgentId?: string;
  /** 已安装智能体：人设（name/systemPrompt）+ 可选自带语音识别（asr）；聊天 LLM 参数仍一律由用户配置（平台不提供 API） */
  installedAgentConfig?: unknown;
}

const DEFAULT_CONFIG: AppConfig = {
  petSystemEnabled: true,
  foodSystemEnabled: true,
  randomMoveEnabled: false,
  agentType: 'default',
  userProfile: {
    name: '',
    preferences: {},
  },
  petState: {
    hunger: 80,
    mood: 80,
    energy: 80,
    affection: 50,
  },
  petWindow: {
    width: 300,
    height: 300,
    opacity: 1,
  },
  petFeatures: {
    feedEnabled: true,
    restEnabled: true,
    playEnabled: true,
    affectionEnabled: true,
  },
  petActions: [],
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
};

let cachedConfig: AppConfig | null = null;

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const loaded: AppConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        petWindow: { ...DEFAULT_CONFIG.petWindow, ...(parsed.petWindow || {}) },
        petFeatures: { ...DEFAULT_CONFIG.petFeatures, ...(parsed.petFeatures || {}) },
        petActions: Array.isArray(parsed.petActions) ? (parsed.petActions as PetAction[]) : [],
        petActionBindings: parsed.petActionBindings && typeof parsed.petActionBindings === 'object'
          ? (parsed.petActionBindings as PetActionBindings)
          : {},
        platform: { ...DEFAULT_CONFIG.platform, ...(parsed.platform || {}) },
        agentProactive: {
          enabled: parsed.agentProactive?.enabled ?? DEFAULT_CONFIG.agentProactive!.enabled,
          intervalMinutes: parsed.agentProactive?.intervalMinutes ?? DEFAULT_CONFIG.agentProactive!.intervalMinutes,
        },
      };
      if (loaded.platform.frontendUrl === 'http://localhost:5173') {
        loaded.platform.frontendUrl = DEFAULT_CONFIG.platform.frontendUrl;
      }
      cachedConfig = loaded;
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
    petState: { ...current.petState, ...(config.petState || {}) },
    petWindow: { ...current.petWindow, ...(config.petWindow || {}) },
    petFeatures: { ...current.petFeatures, ...(config.petFeatures || {}) },
    petActions: Array.isArray(config.petActions) ? config.petActions : current.petActions,
    petActionBindings: config.petActionBindings !== undefined
      ? (config.petActionBindings || {})
      : current.petActionBindings,
    platform: { ...current.platform, ...(config.platform || {}) },
    agentProactive: {
      enabled: config.agentProactive?.enabled ?? current.agentProactive?.enabled ?? true,
      intervalMinutes: config.agentProactive?.intervalMinutes ?? current.agentProactive?.intervalMinutes ?? 30,
    },
    petSenses: {
      screen: config.petSenses?.screen ?? current.petSenses?.screen ?? false,
      mic: config.petSenses?.mic ?? current.petSenses?.mic ?? false,
      camera: config.petSenses?.camera ?? current.petSenses?.camera ?? false,
    },
    petName: (config.petName ?? current.petName ?? '小宠').slice(0, 12),
    voiceWakeMode: config.voiceWakeMode ?? current.voiceWakeMode ?? 'once',
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
const FALLBACK_SYSTEM_PROMPT = '你是一个可爱的桌面宠物，用简短、俏皮的语气回复主人。';

/**
 * 聊天 LLM 生效配置：API 全部由用户在客户端配置（平台不提供任何默认 API）。
 * 只认 llmProfiles 档案列表：激活的档案优先，未激活任何档案时回落第一个；
 * 一个档案都没有时返回空配置（apiKey/baseUrl 为空，llmService 会给出明确提示）。
 * 已安装智能体只提供人设，不再覆盖 model/baseUrl/temperature。
 */
export function getLLMConfig(): LLMConfig {
  const config = loadConfig();
  const profiles = Array.isArray(config.llmProfiles) ? config.llmProfiles : [];
  const activeProfile = profiles.find((p) => p.id === config.llmActiveProfileId) ?? profiles[0];
  if (!activeProfile) {
    return { provider: 'openai', apiKey: '', baseUrl: '', model: '', systemPrompt: FALLBACK_SYSTEM_PROMPT };
  }
  return {
    provider: 'openai',
    apiKey: activeProfile.apiKey || '',
    baseUrl: activeProfile.baseUrl || '',
    model: activeProfile.model || '',
    systemPrompt: activeProfile.systemPrompt || FALLBACK_SYSTEM_PROMPT,
  };
}
