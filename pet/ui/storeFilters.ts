/**
 * 宠物商店列表的筛选/排序/格式化 —— 纯函数，无副作用
 * ---------------------------------------------------------------------------
 * 平台前端（Web）与桌面内嵌工坊都复用同一份，避免两端筛选口径漂移。
 */
import type { PetPackSort, PetPackStatus, PetPackSummary } from '../api/contract';

export interface PetPackFilterOptions {
  search?: string;
  /** 本体形态过滤（image / frames / live2d / model3d） */
  bodyKind?: string;
  sort?: PetPackSort;
}

/** 先按「形态命中 + 关键词命中」过滤，再排序（默认按创建时间倒序） */
export function filterPetPacks(
  items: readonly PetPackSummary[],
  opts: PetPackFilterOptions = {},
): PetPackSummary[] {
  const search = (opts.search ?? '').trim().toLowerCase();
  const filtered = items.filter((it) => {
    if (opts.bodyKind && !it.bodyKinds.includes(opts.bodyKind)) return false;
    if (search) {
      const hay = `${it.name} ${it.description ?? ''} ${it.tags.join(' ')}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const sort = opts.sort ?? 'createdAt';
  return [...filtered].sort((a, b) => {
    if (sort === 'downloads') return b.downloads - a.downloads;
    if (sort === 'rating') return b.rating - a.rating;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
}

/** 审核状态 → 中文标签 */
export function petPackStatusLabel(status: PetPackStatus): string {
  if (status === 'approved') return '已通过';
  if (status === 'rejected') return '已驳回';
  return '待审核';
}

/** 字节数 → 可读体积（未知返回破折号） */
export function formatPackBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
