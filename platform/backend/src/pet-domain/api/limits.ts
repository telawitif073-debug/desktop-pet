/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 宠物包限额与域常量 —— 跨端唯一来源
 * ---------------------------------------------------------------------------
 * 限额与后端 `pack-inspection` 的校验严格对应，改这里必须同步后端。
 * `PET_ASSET_TYPE` 是评价/下载多态域的 discriminator，`PET_ADMIN_CARRIER`
 * 是 admin 审核路由的载体名——两者**刻意不同名**（沿用既有契约），
 * 映射只在此处集中，避免各端手写字符串漂移。
 */

/** 128 MiB：包体（zip）上限 */
export const PET_PACK_MAX_ARCHIVE_BYTES = 134217728;
/** 3000：包内条目数上限 */
export const PET_PACK_MAX_ENTRIES = 3000;
/** 32 MiB：单条目解压后上限 */
export const PET_PACK_MAX_ENTRY_BYTES = 33554432;
/** 256 MiB：解压总量上限（防 zip 炸弹） */
export const PET_PACK_MAX_UNCOMPRESSED_BYTES = 268435456;

/** 评价 / 下载记录多态域的 assetType */
export const PET_ASSET_TYPE = 'pet' as const;
/** admin 审核路由的载体名（与 PET_ASSET_TYPE 刻意不同名） */
export const PET_ADMIN_CARRIER = 'pet_pack' as const;

/** 宠物包发布仅限管理员 */
export const PET_PACK_PUBLISH_ROLE = 'admin' as const;
