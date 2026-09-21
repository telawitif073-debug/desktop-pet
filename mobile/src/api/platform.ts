/**
 * 平台 API 客户端：auth/login、资源列表/详情/下载、/sync/* 同步。
 * 所有方法从 useAppStore 读取 token 与 baseUrl，401 时清登录态。
 */
import { useAppStore } from '../store/appStore';
import type { AssetItem } from '../types';

function buildUrl(path: string): string {
  const base = useAppStore.getState().baseUrl.replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

function authHeaders(): Record<string, string> {
  const { token } = useAppStore.getState();
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(buildUrl(path), { ...init, headers: { ...authHeaders(), ...(init?.headers || {}) } });
  if (res.status === 401) {
    useAppStore.getState().logout();
    throw new ApiError(401, '登录已过期，请重新登录');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// --- 静态资源 URL（/uploads 公开直出，无需鉴权） ---
export function assetUrl(fileUrl: string): string {
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  const root = useAppStore.getState().baseUrl.replace(/\/api\/?$/, '');
  return `${root}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;
}

// --- 鉴权 ---
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; username: string; role?: string };
}

export async function login(identifier: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
}

export async function register(email: string, username: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, username, password }),
  });
}

// --- 资源列表 ---
export interface ListAssetParams {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
  sort?: string;
}

export async function listAssets(type: 'pet' | 'agent', params?: ListAssetParams | string): Promise<{ items: AssetItem[]; total: number }> {
  let query = '';
  if (typeof params === 'string') {
    query = params ? `?search=${encodeURIComponent(params)}` : '';
  } else if (params) {
    const usp = new URLSearchParams();
    if (params.search) usp.set('search', params.search);
    if (params.status) usp.set('status', params.status);
    if (params.page) usp.set('page', String(params.page));
    if (params.limit) usp.set('limit', String(params.limit));
    if (params.sort) usp.set('sort', params.sort);
    query = usp.toString() ? `?${usp.toString()}` : '';
  }
  const res = await request<{ items: AssetItem[]; total: number }>(`/${type}s${query}`);
  // 平台返回 items/total，兼容直接返回数组
  return Array.isArray(res) ? { items: res, total: res.length } : res;
}

// --- 管理员审核（需 admin 角色，后端 RolesGuard 校验） ---
export async function approveAsset(type: 'pet' | 'agent', id: string): Promise<void> {
  await request(`/admin/approve/${type}/${id}`, { method: 'POST' });
}

export async function rejectAsset(type: 'pet' | 'agent', id: string): Promise<void> {
  await request(`/admin/reject/${type}/${id}`, { method: 'POST' });
}

export async function getAssetDetail(type: 'pet' | 'agent', id: string): Promise<AssetItem> {
  return request<AssetItem>(`/${type}s/${id}`);
}

/** 下载资源触发后端计数 + 返回可直接使用的文件 URL（拼接平台根域名） */
export async function downloadAsset(type: 'pet' | 'agent', id: string): Promise<{ url: string }> {
  const res = await request<{ url: string }>(`/${type}s/${id}/download`, { method: 'POST' });
  const { baseUrl } = useAppStore.getState();
  const root = baseUrl.replace(/\/api\/?$/, '');
  return { url: new URL(res.url, `${root}/`).toString() };
}

// --- 用户数据云同步（与桌面端 cloudSync.ts 对齐的 kind 命名） ---
type SyncKind = 'config' | 'pet-state' | 'chat-history' | 'library';

export async function syncGet(kind: SyncKind): Promise<{ data: unknown; updatedAt: string | null }> {
  return request<{ data: unknown; updatedAt: string | null }>(`/sync/${kind}`);
}

export async function syncPut(kind: SyncKind, data: unknown): Promise<{ updatedAt: string }> {
  return request<{ updatedAt: string }>(`/sync/${kind}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}
