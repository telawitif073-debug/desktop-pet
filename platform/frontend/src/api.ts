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

/** AI 生成形态：image=单图 gif=GIF 动图 live2d=轻量 Live2D 包 model3d=3D 模型（四形态统一走 AI 绘图智能体链路） */
export type PetGenFormat = 'image' | 'gif' | 'live2d' | 'model3d';

/** AI 生成结果：形象参数 + 形态专属参数（gif→motion / live2d→rig / model3d→model3d） */
export interface PetGenResult {
  design: import('./utils/petCanvas').PetDesign;
  motion?: import('./utils/petCanvas').PetMotion;
  rig?: import('./utils/petLite').PetRig;
  model3d?: import('./utils/pet3d').PetModel3D;
}

export async function generatePetDesign(description: string, format: PetGenFormat = 'image', model?: string, style?: string, refined?: string) {
  const response = await api.post<PetGenResult>('/ai/generate-pet', { description, format, model, style, refined });
  return response.data;
}

/** 分步生成步骤一结果：识别物种 + 细化描述 + 确认问题（≤3） + 形象参数初稿 */
export interface PetRefineResult {
  species: import('./utils/petCanvas').PetDesign['species'];
  refined: string;
  questions: string[];
  design: import('./utils/petCanvas').PetDesign;
}

export async function refinePetDesign(description: string, model?: string, style?: string) {
  const response = await api.post<PetRefineResult>('/ai/refine-pet', { description, model, style });
  return response.data;
}

/** 精绘构图：full=全身（默认） half=半身 */
export type PaintFraming = 'full' | 'half';

/** 检测智能体报告（生成稿/抠图稿各一份，与后端 detect-agent.ts DetectResult 对齐） */
export interface DetectReport {
  pass: boolean;
  /** 未配置视觉模型时为 true（视为放行） */
  skipped: boolean;
  issues: string[];
  checks: Record<string, boolean>;
}

/**
 * 生成智能体完整链路结果（后端编排：生成智能体 → 检测 → 抠图智能体 → 检测，不合格自动重试最多 3 轮）。
 * dataUrl 为验收后的透明 PNG 成品；detect 为两道检测报告。
 */
export interface PaintingResourceResult {
  name: string;
  subjectType: 'person' | 'animal';
  /** 物种标签：'person' 或 PetDesign.species 之一，仅用于展示 */
  species: string;
  refined: string;
  imagePrompt: string;
  dataUrl: string;
  tolerance: number;
  transparentPct: number;
  detect: { generated: DetectReport; cutout: DetectReport };
  attempts: number;
}

export async function runPaintingResource(description: string, framing: PaintFraming = 'full', style?: string, refined?: string) {
  const response = await api.post<PaintingResourceResult>('/ai/painting-resource', { description, framing, style, refined });
  return response.data;
}

/** 抠图智能体结果（两段链路第二段，后端 cutout-agent.ts）：服务端去背自检后的透明 PNG */
export interface CutoutAgentResult {
  dataUrl: string;
  tolerance: number;
  transparentPct: number;
}

export async function cutoutAgentImage(image: string) {
  const response = await api.post<CutoutAgentResult>('/ai/cutout-agent', { image });
  return response.data;
}

/** AI 生成可选项：按提供商分组的模型列表 + 风格列表（后端 GET /ai/meta） */
export interface AiGenMeta {
  providers: Array<{ provider: string; label: string; available: boolean; models: Array<{ id: string; label: string }> }>;
  styles: Array<{ id: string; label: string }>;
}

export async function getAiGenMeta() {
  const response = await api.get<AiGenMeta>('/ai/meta');
  return response.data;
}
