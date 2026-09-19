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

/** 正在进行的 refreshToken 续期（并发 401 共享同一次刷新，避免重复请求） */
let refreshing: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
      if (!refreshToken) return null;
      try {
        // 用独立 axios 调用，避免走本拦截器形成递归
        const response = await axios.post<AuthResponse>(
          `${api.defaults.baseURL || '/api'}/auth/refresh`,
          { refreshToken },
        );
        saveAuth(response.data);
        return response.data.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

function forceLogout() {
  clearAuth();
  window.dispatchEvent(new Event('platform:logout'));
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status: number | undefined = error.response?.status;
    const url: string = error.config?.url || '';
    const isAuthEndpoint = /\/auth\/(login|register|refresh)$/.test(url);
    if (status === 401 && error.config) {
      if (isAuthEndpoint) {
        // 登录/刷新自身失败：按未登录处理
        forceLogout();
      } else if (!(error.config as { _retried?: boolean })._retried) {
        // 业务请求 401：先用 refreshToken 无感续期并重试一次
        (error.config as { _retried?: boolean })._retried = true;
        const newToken = await refreshAccessToken();
        if (newToken) {
          error.config.headers.Authorization = `Bearer ${newToken}`;
          return api.request(error.config);
        }
        forceLogout();
      }
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

