/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 宠物包 HTTP 契约（DTO / 视图 / 错误码）—— 前后端同一份
 * ---------------------------------------------------------------------------
 * 派生字段（packUrl / packSha256 / packBytes / bodyKinds / manifest）一律由
 * 服务端从 zip 派生，客户端**不得**提交这些字段。
 */
import type { PetPackManifest } from '../domain/pack';

/** 审核状态 */
export type PetPackStatus = 'pending' | 'approved' | 'rejected';

/** 排序键 */
export type PetPackSort = 'createdAt' | 'downloads' | 'rating';

/** 列表 / 卡片视图（不含载体 URL） */
export interface PetPackSummary {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  previewUrl: string | null;
  bodyKinds: string[];
  version: string;
  downloads: number;
  rating: number;
  status: PetPackStatus;
  author?: { id: string; username: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** 详情视图（含载体与清单） */
export interface PetPackDetail extends PetPackSummary {
  packUrl: string;
  packSha256: string;
  packBytes: number | null;
  packSchemaVersion: number;
  manifest: PetPackManifest | null;
}

/** 下载凭据（仅 approved 可下载） */
export interface PetPackDownloadResult {
  url: string;
  sha256: string;
  bytes: number | null;
  version: string;
  downloads: number;
}

/** 发布入参（不含派生字段） */
export interface CreatePetPackInput {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  version?: string;
}

/** 更新入参（不含派生字段） */
export type UpdatePetPackInput = Partial<
  Pick<CreatePetPackInput, 'name' | 'description' | 'category' | 'tags' | 'version'>
>;

/** 列表查询 */
export interface ListPetPacksQuery {
  search?: string;
  status?: PetPackStatus;
  category?: string;
  bodyKind?: string;
  sort?: PetPackSort;
  page?: number;
  limit?: number;
}

/** 校验/发布错误码（后端 400 响应 errors[] 与前端展示共用同一份文案） */
export const PET_PACK_ERRORS = {
  ARCHIVE_TOO_LARGE: '包体超过上限（128 MiB）',
  TOO_MANY_ENTRIES: '包内条目过多（上限 3000）',
  ENTRY_TOO_LARGE: '单条解压后超过上限（32 MiB）',
  UNCOMPRESSED_TOO_LARGE: '解压总量超过上限（256 MiB）',
  BAD_ARCHIVE: '不是有效的 zip 包',
  SHA_MISMATCH: '文件哈希与声明不一致',
  MANIFEST_INVALID: '包清单（manifest.json）不合法',
  ACTION_MODEL_INVALID: '动作模型（pet/actions.json）不合法',
  NO_BODY: '包内未找到合格的宠物本体',
} as const;

export type PetPackErrorCode = keyof typeof PET_PACK_ERRORS;
