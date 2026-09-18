import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  /** 采样温度；未配置时 llmService 用默认值 0.8。
   * 已安装智能体的 temperature/model/baseUrl 会在 getLLMConfig 中覆盖此处的值 */
  temperature?: number;
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
}

/** 宠物互动功能开关（喂食/休息/玩耍/好感度），可在资源库"设置"页调整；
 * 关闭后隐藏对应按钮与进度条，并冻结对应数值的衰减 */
export interface PetFeaturesConfig {
  feedEnabled: boolean;
  restEnabled: boolean;
  playEnabled: boolean;
  affectionEnabled: boolean;
}

/** 变换动画关键帧：dx/dy 相对基准位置的像素偏移，rotation 弧度，scale 缩放系数。
 * view 标记该关键帧使用的宠物视图（front=正面 side=侧面 back=背面），
 * 渲染端由宠物原图程序化派生三视图，播放时切换以表现转身等动作 */
export interface PetActionKeyframe {
  t: number;
  dx: number;
  dy: number;
  rotation: number;
  scale: number;
  view?: 'front' | 'side' | 'back';
}

/** 变换动画配置（AI 生成）：对宠物精灵做补间 */
export interface PetActionTransform {
  loop: boolean;
  duration: number;
  keyframes: PetActionKeyframe[];
}

/** 宠物资源形态：image=单张图片（含 GIF），pack=多图帧序列包，live2d=Live2D 模型包，model3d=3D 模型（glb/gltf） */
export type PetFormat = 'image' | 'pack' | 'live2d' | 'model3d' | 'sprite';

/** 宠物动作：kind=transform 为程序化变换动画（AI 生成），kind=frames 为帧序列（手动/宠物资源包附带），
 * kind=clip 为 Live2D/3D 模型内置动画 clip（仅模型宠物可用）。
 * petAssetId 标记动作属于哪个宠物资源（动作随宠物，不可跨宠物使用） */
export interface PetAction {
  id: string;
  name: string;
  kind: 'transform' | 'frames' | 'clip';
  source: 'ai' | 'manual' | 'platform';
  transform?: PetActionTransform;
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

/** 动作生成专用 AI 覆盖（可选）：不设置时使用全局 llm 配置（不含智能体覆盖）。
 * 整体替换语义；推理类模型思维链会耗尽输出额度，动作生成建议用 deepseek-chat 等非推理模型 */
export interface ActionLLMConfig {
  model?: string;
  baseUrl?: string;
  temperature?: number;
}

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

/** AI 生成宠物（客户端本地流水线）用户自备 Key，仅存本机 config.json */
export interface AiGenConfig {
  /** 阿里云百炼 DashScope Key：通义万相图生视频（精灵表路径必需） */
  dashscopeKey?: string;
  /** 火山方舟 Key：Seedream 基准图出图（可选，未配置时回退 CogView 免费模型） */
  arkKey?: string;
  /** 智谱 Key：CogView-3-Flash 免费出图 + glm-4-flash 提示词细化（推荐配置） */
  zhipuKey?: string;
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
  llm: LLMConfig;
  platform: PlatformConfig;
  petAssetPath?: string;
  /** 当前安装宠物的资源名称（如"橘猫桌面形象"），供 AI 生成动作时感知宠物形象 */
  petAssetName?: string;
  /** 当前安装宠物的资源 id（动作随宠物挂靠） */
  petAssetId?: string;
  /** 当前安装宠物的资源形态（image/pack/live2d/model3d），渲染端据此选择渲染方式 */
  petAssetFormat?: PetFormat;
  /** 动作生成专用 AI 覆盖（可选） */
  actionLLM?: ActionLLMConfig;
  /** 智能体主动对话配置 */
  agentProactive?: AgentProactiveConfig;
  /** AI 生成宠物（本地生成）用户自备 Key */
  aiGen?: AiGenConfig;
  agentConfigPath?: string;
  installedAgentId?: string;
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
  llm: {
    provider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    systemPrompt: '',
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
        aiGen: parsed.aiGen && typeof parsed.aiGen === 'object' ? (parsed.aiGen as AiGenConfig) : {},
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
    llm: { ...current.llm, ...(config.llm || {}) },
    platform: { ...current.platform, ...(config.platform || {}) },
    agentProactive: {
      enabled: config.agentProactive?.enabled ?? current.agentProactive?.enabled ?? true,
      intervalMinutes: config.agentProactive?.intervalMinutes ?? current.agentProactive?.intervalMinutes ?? 30,
    },
    aiGen: { ...current.aiGen, ...(config.aiGen || {}) },
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

export function getLLMConfig(): LLMConfig {
  const config = loadConfig();
  // 已安装智能体可覆盖 LLM 参数（temperature / model / baseUrl），
  // 使聊天中的"智能体设置"真正生效，而非仅追加系统提示词
  const agent = config.installedAgentConfig;
  const fields = agent && typeof agent === 'object'
    ? (agent as { model?: unknown; baseUrl?: unknown; temperature?: unknown })
    : null;
  return {
    ...config.llm,
    ...(typeof fields?.model === 'string' && fields.model ? { model: fields.model } : {}),
    ...(typeof fields?.baseUrl === 'string' && fields.baseUrl ? { baseUrl: fields.baseUrl } : {}),
    ...(typeof fields?.temperature === 'number'
      ? { temperature: Math.min(2, Math.max(0, fields.temperature)) }
      : {}),
  };
}
