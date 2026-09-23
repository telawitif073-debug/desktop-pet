/** 与桌面端共享的数据结构（经平台 /api/sync/* 同步） */

/** LLM API 档案 = 智能体：每个档案就是一个独立智能体，绑定专属宠物形象与独立对话
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
  /** 绑定的宠物形象 ID（一个智能体必须且只能绑定一个宠物形象） */
  petAssetId?: string;
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
  /** 智能体唯一 ID（安装时生成，用于隔离消息与绑定形象） */
  id: string;
  name?: string;
  systemPrompt?: string;
  /** 绑定的宠物形象 ID（一个智能体必须且只能绑定一个宠物形象） */
  petAssetId?: string;
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
