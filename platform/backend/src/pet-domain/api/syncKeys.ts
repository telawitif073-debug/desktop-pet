/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 云同步键与载荷类型 —— 客户端 config jsonb + `pet_state` 同步的契约
 * ---------------------------------------------------------------------------
 * 这 12 个键是「宠物系统在 config jsonb 里的全部键」，与旧契约一字不差；
 * 后端对 config 是 jsonb 透传（无白名单），键由客户端首次写入自然出现。
 */
import type { PetVitals } from '../domain/vitals';

/** config jsonb 中属于宠物系统的键 */
export const PET_CONFIG_KEYS = [
  'petAssetPath',
  'petAssetName',
  'petAssetId',
  'petAssetFormat',
  'builtinPet',
  'petActions',
  'petActionBindings',
  'petState',
  'petStateReady',
  'petSelfDescription',
  'currentPet',
  'downloadedPets',
] as const;

export type PetConfigKey = (typeof PET_CONFIG_KEYS)[number];

/** 当前安装/选用的宠物形象引用（跨端契约） */
export interface PetAssetRef {
  id: string;
  name: string;
  /** image / pack / live2d / model3d */
  format: string;
  packUrl?: string;
  entryPath?: string;
  localPath?: string;
}

/** `pet_state` 同步载荷 */
export interface PetStatePayload {
  vitals: PetVitals;
  ready: boolean;
  updatedAt: number;
}
