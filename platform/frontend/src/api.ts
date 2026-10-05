import axios from 'axios';
import { PET_PACK_API, PET_PACK_UPLOAD_FIELDS } from '@pet/api';
import type { Asset, AssetType, AuthResponse, CreatePetPackInput, DownloadedEntry, ListPetPacksQuery, PageResponse, PetPackDetail, PetPackDownloadResult, PetPackSummary, Review, SyncConfigPayload, User } from './types';

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

/** 资源载体路径：宠物包走 /pet-packs，其余（智能体）走 /agents */
function assetPath(type: AssetType): string {
  if (type === 'pet') return 'pet-packs';
  return 'agents';
}

/** admin 审核载体名：与「评价域资源类型」一致，见后端 `admin.controller.ts` 的 updateStatus */
function adminCarrierName(type: AssetType): string {
  if (type === 'pet') return 'pet_pack';
  return 'agent';
}

export function assetUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http')) return url;
  const apiBase = import.meta.env.VITE_API_BASE_URL || '/api';
  return `${apiBase.replace(/\/api\/?$/, '')}${url.startsWith('/') ? url : `/${url}`}`;
}

// 桌面客户端桥接（浏览器环境下不存在）：登录态与主进程互通，
// 桌面端下载/安装/上传与本站共用同一份令牌（避免一处登录、另一处显示未登录）
const bridge = () => window.electronAPI?.platform;

export function saveAuth(auth: AuthResponse) {
  localStorage.setItem(TOKEN_KEY, auth.accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, auth.refreshToken);
  localStorage.setItem('platform_user', JSON.stringify(auth.user));
  // 登录与无感续期都会走这里：把（可能已轮换的）令牌同步给桌面主进程
  void bridge()?.syncAuth?.({ accessToken: auth.accessToken, refreshToken: auth.refreshToken, user: auth.user });
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem('platform_user');
  void bridge()?.clearAuth?.();
}

/** 把本窗口当前令牌同步给桌面主进程（须在校验通过后调用，避免推送失效令牌） */
export function syncAuthToDesktop(user?: User | null): void {
  const accessToken = localStorage.getItem(TOKEN_KEY);
  if (!accessToken) return;
  void bridge()?.syncAuth?.({
    accessToken,
    refreshToken: localStorage.getItem(REFRESH_TOKEN_KEY) || '',
    user: user ?? getStoredUser(),
  });
}

/**
 * 桌面端已登录而本窗口没有令牌时沿用桌面端登录态（启动时调用一次）。
 * 反向（本窗口有令牌）交给调用方先 getMe 校验，通过后再 syncAuthToDesktop。
 */
export async function adoptDesktopAuth(): Promise<void> {
  const desktop = bridge();
  if (!desktop?.authTokens || localStorage.getItem(TOKEN_KEY)) return;
  try {
    const tokens = await desktop.authTokens();
    if (tokens?.accessToken) {
      localStorage.setItem(TOKEN_KEY, tokens.accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken || '');
    }
  } catch {
    /* 桥异常按未登录处理 */
  }
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
  const response = await api.get<PageResponse>(`/${assetPath(type)}`, { params });
  return response.data;
}

export async function approveAsset(type: AssetType, id: string) {
  const response = await api.post(`/admin/approve/${adminCarrierName(type)}/${id}`);
  return response.data;
}

export async function rejectAsset(type: AssetType, id: string) {
  const response = await api.post(`/admin/reject/${adminCarrierName(type)}/${id}`);
  return response.data;
}

export async function getAsset(type: AssetType, id: string) {
  const response = await api.get<Asset>(`/${assetPath(type)}/${id}`);
  return response.data;
}

export async function downloadAsset(type: AssetType, id: string) {
  const response = await api.post<{ url: string; sha256?: string; bytes?: number | null; version?: string; downloads: number }>(`/${assetPath(type)}/${id}/download`);
  return response.data;
}

export async function listReviews(type: AssetType, id: string) {
  // 评价域资源类型与载体一致（见后端 review.entity.ts 注释）
  const response = await api.get<Review[]>('/reviews', { params: { assetType: type, assetId: id } });
  return response.data;
}

export async function submitReview(type: AssetType, id: string, rating: number, comment: string) {
  const response = await api.post<Review>(`/${assetPath(type)}/${id}/review`, { rating, comment });
  return response.data;
}

export async function listMine(type: AssetType) {
  const response = await api.get<Asset[]>(`/${assetPath(type)}/mine`);
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
  const response = await api.put<Asset>(`/${assetPath(type)}/${id}`, values);
  return response.data;
}

export async function deleteAsset(type: AssetType, id: string) {
  await api.delete(`/${assetPath(type)}/${id}`);
}

// ── 宠物包（/api/pet-packs，路径常量取自共享模块 pet/api）──

/** 商店列表（分页 + 筛选，直接透传查询参数） */
export async function listPetPacks(params: ListPetPacksQuery = {}) {
  const response = await api.get<PageResponse<PetPackSummary>>(PET_PACK_API.list, { params });
  return response.data;
}

/** 我发布的宠物包（不分页） */
export async function listMyPetPacks() {
  const response = await api.get<PetPackSummary[]>(PET_PACK_API.mine);
  return response.data;
}

/** 宠物包详情（含载体 URL、体积与清单） */
export async function getPetPack(id: string) {
  const response = await api.get<PetPackDetail>(PET_PACK_API.detail(id));
  return response.data;
}

/** 下载凭据（仅已通过审核的宠物包可下载） */
export async function downloadPetPack(id: string) {
  const response = await api.post<PetPackDownloadResult>(PET_PACK_API.download(id));
  return response.data;
}

/** 发布宠物包（multipart：zip 包 + 可选预览图 + 元信息；仅管理员） */
export async function publishPetPack(input: CreatePetPackInput & { file: File; preview?: File }) {
  const form = new FormData();
  form.append(PET_PACK_UPLOAD_FIELDS.file, input.file);
  if (input.preview) form.append(PET_PACK_UPLOAD_FIELDS.preview, input.preview);
  form.append(PET_PACK_UPLOAD_FIELDS.name, input.name);
  if (input.description) form.append(PET_PACK_UPLOAD_FIELDS.description, input.description);
  if (input.category) form.append(PET_PACK_UPLOAD_FIELDS.category, input.category);
  if (input.tags?.length) form.append(PET_PACK_UPLOAD_FIELDS.tags, input.tags.join(','));
  if (input.version) form.append(PET_PACK_UPLOAD_FIELDS.version, input.version);
  // 不手写 Content-Type：交给 axios 依 FormData 自动带 boundary
  const response = await api.post<PetPackDetail>(PET_PACK_API.list, form);
  return response.data;
}

// ── 个人智能体云同步（/api/sync/config，与手机端/桌面端共库） ──

/** 拉取当前用户的同步配置（含 llmProfiles = 智能体列表） */
export async function getSyncConfig<T = SyncConfigPayload>() {
  const response = await api.get<{ data: T }>('/sync/config');
  return response.data.data;
}

/** 整包提交同步配置（llmProfiles 全量覆盖；后端对 apiKey 加密落库、传输时解密） */
export async function putSyncConfig(payload: SyncConfigPayload) {
  const response = await api.put('/sync/config', { data: payload });
  return response.data;
}

/** 智能体外部依赖连通性测试：后端代发探测请求，返回 ok/status/latencyMs/error */
export async function verifyDependency(options: {
  url: string;
  protocol?: string;
  auth?: string;
  apiKey?: string;
}) {
  const response = await api.post<{ ok: boolean; status: number | null; latencyMs: number | null; error?: string }>(
    '/agents/deps/verify',
    options,
  );
  return response.data;
}

