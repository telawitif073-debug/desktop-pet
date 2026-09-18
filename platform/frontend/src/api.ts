import axios from 'axios';
import type { Asset, AssetType, AuthResponse, DownloadedEntry, PageResponse, Review, User } from './types';

const TOKEN_KEY = 'platform_access_token';
const REFRESH_TOKEN_KEY = 'platform_refresh_token';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      window.dispatchEvent(new Event('platform:logout'));
    }
    return Promise.reject(error);
  },
);

export function assetUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http')) return url;
  const apiBase = import.meta.env.VITE_API_BASE_URL || '/api';
  return `${apiBase.replace(/\/api\/?$/, '')}${url.startsWith('/') ? url : `/${url}`}`;
}

export function saveAuth(auth: AuthResponse) {
  localStorage.setItem(TOKEN_KEY, auth.accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, auth.refreshToken);
  localStorage.setItem('platform_user', JSON.stringify(auth.user));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem('platform_user');
}

export function getStoredUser(): User | null {
  try {
    const value = localStorage.getItem('platform_user');
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export async function login(identifier: string, password: string) {
  const response = await api.post<AuthResponse>('/auth/login', { identifier, password });
  saveAuth(response.data);
  return response.data;
}

export async function register(email: string, username: string, password: string) {
  const response = await api.post<AuthResponse>('/auth/register', { email, username, password });
  saveAuth(response.data);
  return response.data;
}

export async function getMe() {
  const response = await api.get<User>('/auth/me');
  localStorage.setItem('platform_user', JSON.stringify(response.data));
  return response.data;
}

export async function listAssets(type: AssetType, params: { search?: string; page?: number; limit?: number; sort?: string; category?: string; status?: string }) {
  const response = await api.get<PageResponse>(`/${type}s`, { params });
  return response.data;
}

export async function approveAsset(type: AssetType, id: string) {
  const response = await api.post(`/${'admin'}/approve/${type}/${id}`);
  return response.data;
}

export async function rejectAsset(type: AssetType, id: string) {
  const response = await api.post(`/${'admin'}/reject/${type}/${id}`);
  return response.data;
}

export async function getAsset(type: AssetType, id: string) {
  const response = await api.get<Asset>(`/${type}s/${id}`);
  return response.data;
}

export async function downloadAsset(type: AssetType, id: string) {
  const response = await api.post<{ url: string; downloads: number }>(`/${type}s/${id}/download`);
  return response.data;
}

export async function listReviews(type: AssetType, id: string) {
  const response = await api.get<Review[]>('/reviews', { params: { assetType: type, assetId: id } });
  return response.data;
}

export async function submitReview(type: AssetType, id: string, rating: number, comment: string) {
  const response = await api.post<Review>(`/${type}s/${id}/review`, { rating, comment });
  return response.data;
}

export async function listMine(type: AssetType) {
  const response = await api.get<Asset[]>(`/${type}s/mine`);
  return response.data;
}

export async function listDownloaded() {
  const response = await api.get<DownloadedEntry[]>('/reviews/downloads/mine');
  return response.data;
}

export async function deleteDownloaded(assetType: AssetType, assetId: string) {
  await api.delete(`/reviews/downloads/${assetType}/${assetId}`);
}

export async function updateAsset(type: AssetType, id: string, values: Record<string, unknown>) {
  const response = await api.put<Asset>(`/${type}s/${id}`, values);
  return response.data;
}

export async function deleteAsset(type: AssetType, id: string) {
  await api.delete(`/${type}s/${id}`);
}

export async function uploadAsset(type: AssetType, values: Record<string, unknown>, file: File) {
  const form = new FormData();
  form.append('file', file);
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      form.append(key, Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  });
  const response = await api.post<Asset>(`/${type}s`, form);
  return response.data;
}

/** 上传宠物（主文件 + 可选预览图 + 附带动作 zip/clip），动作随宠物上传 */
export interface PetActionUpload {
  name: string;
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  clipName?: string;
  file?: File;
}

export async function uploadPet(
  values: Record<string, unknown>,
  file: File | null,
  preview: File | null,
  actions: PetActionUpload[],
) {
  const form = new FormData();
  if (file) form.append('file', file);
  if (preview) form.append('preview', preview);
  actions.forEach((action) => { if (action.file) form.append('actionFiles', action.file); });
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      form.append(key, Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  });
  form.append('actionsMeta', JSON.stringify(actions.map(({ file: _file, ...meta }) => meta)));
  const response = await api.post<Asset>('/pets', form);
  return response.data;
}

/** ============ AI 生成宠物（精灵表流水线） ============ */

/** GET /ai/meta：画风列表 + 各能力 Key 配置状态 */
export interface AiGenMeta {
  styles: Array<{ id: string; label: string }>;
  capabilities: { cogview: boolean; seedream: boolean; wanVideo: boolean; live2d: boolean; promptAgent: boolean };
}

export async function getAiGenMeta() {
  const response = await api.get<AiGenMeta>('/ai/meta');
  return response.data;
}

/** AI 生成任务进度（精灵表 / Live2D 共用，后端内存 JobStore，进程重启即失效） */
export interface SpriteJobView {
  id: string;
  status: 'running' | 'done' | 'failed';
  stage: 'base' | 'video' | 'frames' | 'assemble' | 'layers' | 'rig' | 'pack';
  done: number;
  total: number;
  /** 当前处理的状态名或阶段说明 */
  current?: string;
  error?: string;
  result?: {
    kind: 'sprite' | 'live2d';
    name: string;
    /** sprite：精灵表 PNG dataUrl（1536×1280，6列×5行，每格 256×256） */
    sheetDataUrl?: string;
    animations?: Record<string, unknown>;
    /** live2d：模型文件族 zip dataUrl（model3.json + moc3 + physics3 + idle.motion3 + cdi3 + 纹理） */
    zipDataUrl?: string;
    previewDataUrl: string;
  };
}

/** 发起精灵表生成（异步），返回 jobId */
export async function startSpritePet(description: string, style?: string) {
  const response = await api.post<{ jobId: string }>('/ai/sprite-pet', { description, style });
  return response.data;
}

/** 发起 Live2D 生成（异步，需后端本机部署 See-through + PSD2Live），返回 jobId */
export async function startLive2dPet(description: string, style?: string) {
  const response = await api.post<{ jobId: string }>('/ai/live2d-pet', { description, style });
  return response.data;
}

export async function getSpriteJob(id: string) {
  const response = await api.get<SpriteJobView>(`/ai/jobs/${id}`);
  return response.data;
}
