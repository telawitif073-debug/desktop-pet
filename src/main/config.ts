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
      cachedConfig = { ...DEFAULT_CONFIG, ...parsed };
    } else {
      cachedConfig = { ...DEFAULT_CONFIG };
      saveConfig(cachedConfig);
    }
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  return cachedConfig;
}

export function saveConfig(config: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  cachedConfig = {
    ...current,
    ...config,
    userProfile: { ...current.userProfile, ...(config.userProfile || {}) },
    petState: { ...current.petState, ...(config.petState || {}) },
    llm: { ...current.llm, ...(config.llm || {}) },
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
