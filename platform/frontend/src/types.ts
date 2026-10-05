export type AssetType = 'agent';
export type AssetStatus = 'pending' | 'approved' | 'rejected';

export interface User {
  id: string;
  email: string;
  username: string;
  role: 'user' | 'admin';
  avatarUrl?: string | null;
}

export interface Asset {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  tags?: string[];
  type?: 'chat' | 'task' | 'mixed';
  configSchema?: Record<string, unknown> | null;
  dependencies?: string[];
  previewUrl?: string | null;
  backgroundUrl?: string | null;
  /** 资源文件地址 */
  fileUrl?: string | null;
  version: string;
  downloads: number;
  rating: number;
  status: AssetStatus;
  author?: { id: string; username: string };
  createdAt: string;
  updatedAt: string;
}

export interface PageResponse {
  items: Asset[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface Review {
  id: string;
  rating?: number | null;
  comment?: string | null;
  createdAt: string;
  user?: { username: string };
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface DownloadedEntry {
  assetType: AssetType;
  assetId: string;
  downloadedAt: string;
  asset: Asset | null;
}

/** 云端同步数据的 LLM 档案 = 智能体（与手机端 mobile/types.ts 的 LlmProfile 同构） */
export interface LlmProfile {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt?: string;
  // 智能体页面 P0 扩展字段（均可选）
  avatar?: string;
  intro?: string;
  domainTags?: string[];
  role?: string;
  style?: string;
  greeting?: string;
  exampleQuestions?: string[];
  enabled?: boolean;
  // 智能体页面 P1-2：多智能体编排配置（含外部依赖与凭证引用，不动原有字段）
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

/** /api/sync/config 返回/提交的载荷 */
export interface SyncConfigPayload {
  llmProfiles: LlmProfile[];
  llmActiveProfileId: string;
  profileMessages?: Record<string, unknown>;
  [key: string]: unknown;
}
