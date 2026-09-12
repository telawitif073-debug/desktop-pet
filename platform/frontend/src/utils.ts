import type { AxiosError } from 'axios';

export function getErrorMessage(error: unknown, fallback = '操作失败，请稍后重试') {
  const axiosError = error as AxiosError<{ message?: string | string[] }>;
  const message = axiosError.response?.data?.message;
  if (Array.isArray(message)) return message.join('，');
  return message || (error instanceof Error ? error.message : fallback);
}

export function formatDate(value?: string) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value));
}
