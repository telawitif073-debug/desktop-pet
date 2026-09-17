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

/** 宠物动作：kind=transform 为程序化变换动画（AI 生成），kind=frames 为帧序列（手动上传图片） */
export interface PetAction {
  id: string;
  name: string;
  kind: 'transform' | 'frames';
  source: 'ai' | 'manual';
  transform?: PetActionTransform;
  frameFiles?: string[];
  frameRate?: number;
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
  llm: LLMConfig;
  platform: PlatformConfig;
  petAssetPath?: string;
  /** 当前安装宠物的资源名称（如"橘猫桌面形象"），供 AI 生成动作时感知宠物形象 */
  petAssetName?: string;
  /** 动作生成专用 AI 覆盖（可选） */
  actionLLM?: ActionLLMConfig;
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
        platform: { ...DEFAULT_CONFIG.platform, ...(parsed.platform || {}) },
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
    llm: { ...current.llm, ...(config.llm || {}) },
    platform: { ...current.platform, ...(config.platform || {}) },
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
