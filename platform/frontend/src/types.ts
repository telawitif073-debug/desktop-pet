export type AssetType = 'pet' | 'agent';
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
