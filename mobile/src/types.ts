/** 与桌面端共享的数据结构（经平台 /api/sync/* 同步） */

/** LLM API 档案（桌面端 config.llmProfiles 同构，Key 服务端加密落库、传输时解密） */
export interface LlmProfile {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt?: string;
}

/** 宠物状态（与桌面端 petStore 同构） */
export interface PetState {
  hunger: number; // 饱足感 0-100，100 为饱
  mood: number; // 心情 0-100
  energy: number; // 精力 0-100
  affection: number; // 好感度 0-100，只增不减
}

export const DEFAULT_PET_STATE: PetState = { hunger: 80, mood: 80, energy: 80, affection: 50 };

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

/** 聊天人设：来自平台智能体 JSON（installedAgentConfig）或默认 */
export interface AgentConfig {
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

/** 宠物资源形态（与桌面端 PetFormat 一致） */
export type PetFormat = 'image' | 'pack' | 'live2d' | 'model3d';

/** 商店资源条目（pets / agents 列表通用） */
export interface AssetItem {
  id: string;
  name: string;
  fileUrl: string;
  format?: string;
  downloads?: number;
  description?: string | null;
  [key: string]: unknown;
}

/** 把平台返回的 format 字符串归一化为合法形态，未知值按 image 处理 */
export function normalizeFormat(value: unknown): PetFormat {
  return value === 'pack' || value === 'live2d' || value === 'model3d' || value === 'image'
    ? value
    : 'image';
}
