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

export async function generatePetDesign(description: string) {
  const response = await api.post<{ design: import('./utils/petCanvas').PetDesign }>('/ai/generate-pet', { description });
  return response.data.design;
}
