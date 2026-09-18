export type AssetType = 'pet' | 'agent';
export type AssetStatus = 'pending' | 'approved' | 'rejected';
/** 宠物资源形态：image=单张图片（含 GIF），pack=多图模型包，live2d=Live2D 模型包，model3d=3D 模型 */
export type PetFormat = 'image' | 'pack' | 'live2d' | 'model3d' | 'sprite';

/** 宠物附带的动作（随宠物上传/安装，不可跨宠物使用） */
export interface PetActionSummary {
  id: string;
  name: string;
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  kind: 'frames' | 'clip';
  clipName?: string | null;
}

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
  /** 宠物资源形态 */
  format?: PetFormat;
  /** 宠物附带的动作清单（详情接口返回） */
  actions?: PetActionSummary[];
  configSchema?: Record<string, unknown> | null;
  dependencies?: string[];
  previewUrl?: string | null;
  backgroundUrl?: string | null;
  fileUrl: string;
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

// 桌面宠物客户端的宠物窗口设置
export interface PetWindowSettings {
  width: number;
  height: number;
  opacity: number;
}

// 桌面宠物客户端的宠物互动功能开关（关闭后隐藏对应按钮与进度条）
export interface PetFeaturesSettings {
  feedEnabled: boolean;
  restEnabled: boolean;
  playEnabled: boolean;
  affectionEnabled: boolean;
}
