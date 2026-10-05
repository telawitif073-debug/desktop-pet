import { describe, expect, it } from 'vitest';
import type { PetPackSummary } from '../api/contract';
import { filterPetPacks, formatPackBytes, petPackStatusLabel } from './storeFilters';

const pack = (p: Partial<PetPackSummary> & { id: string }): PetPackSummary => ({
  name: p.id,
  description: null,
  category: null,
  tags: [],
  previewUrl: null,
  bodyKinds: ['image'],
  version: '1.0.0',
  downloads: 0,
  rating: 0,
  status: 'approved',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...p,
});

describe('filterPetPacks', () => {
  const items: PetPackSummary[] = [
    pack({ id: 'a', name: '芽芽猫', bodyKinds: ['image'], downloads: 5, createdAt: '2026-01-01T00:00:00.000Z' }),
    pack({ id: 'b', name: '云朵兔', bodyKinds: ['live2d'], downloads: 50, createdAt: '2026-02-01T00:00:00.000Z' }),
    pack({ id: 'c', name: '炭炭犬', description: '黑色小狗', bodyKinds: ['model3d'], downloads: 20, createdAt: '2026-03-01T00:00:00.000Z' }),
  ];

  it('默认按创建时间倒序', () => {
    expect(filterPetPacks(items).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('按下载量排序', () => {
    expect(filterPetPacks(items, { sort: 'downloads' }).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('按本体形态过滤', () => {
    expect(filterPetPacks(items, { bodyKind: 'live2d' }).map((x) => x.id)).toEqual(['b']);
  });

  it('关键词命中名称与描述', () => {
    expect(filterPetPacks(items, { search: '黑' }).map((x) => x.id)).toEqual(['c']);
    expect(filterPetPacks(items, { search: '兔' }).map((x) => x.id)).toEqual(['b']);
  });

  it('不改动入参数组', () => {
    const snapshot = items.map((x) => x.id);
    filterPetPacks(items, { sort: 'downloads' });
    expect(items.map((x) => x.id)).toEqual(snapshot);
  });
});

describe('petPackStatusLabel', () => {
  it('三种状态各有中文标签', () => {
    expect(petPackStatusLabel('approved')).toBe('已通过');
    expect(petPackStatusLabel('rejected')).toBe('已驳回');
    expect(petPackStatusLabel('pending')).toBe('待审核');
  });
});

describe('formatPackBytes', () => {
  it('按量级切换单位，未知给破折号', () => {
    expect(formatPackBytes(null)).toBe('—');
    expect(formatPackBytes(512)).toBe('512 B');
    expect(formatPackBytes(2048)).toBe('2.0 KB');
    expect(formatPackBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});
