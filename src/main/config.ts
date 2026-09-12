import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
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
  llm: LLMConfig;
  platform: PlatformConfig;
  petAssetPath?: string;
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
      cachedConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        platform: { ...DEFAULT_CONFIG.platform, ...(parsed.platform || {}) },
      };
      if (cachedConfig.platform.frontendUrl === 'http://localhost:5173') {
        cachedConfig.platform.frontendUrl = DEFAULT_CONFIG.platform.frontendUrl;
      }
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
  return loadConfig().llm;
}
