/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 宠物包 REST 路由与上传字段常量 —— 前后端同一份，避免手写路径漂移
 */

/** 宠物包接口路径（不含全局 `/api` 前缀，由各端 request 层拼） */
export const PET_PACK_API = {
  list: '/pet-packs',
  mine: '/pet-packs/mine',
  detail: (id: string) => `/pet-packs/${id}`,
  approve: (id: string) => `/pet-packs/${id}/approve`,
  reject: (id: string) => `/pet-packs/${id}/reject`,
  download: (id: string) => `/pet-packs/${id}/download`,
  review: (id: string) => `/pet-packs/${id}/review`,
} as const;

/** 发布宠物包的 multipart 字段名（后端 FileFieldsInterceptor 与前端表单同一份） */
export const PET_PACK_UPLOAD_FIELDS = {
  /** zip 包体（后端 FileFieldsInterceptor 字段名为 `pack`） */
  file: 'pack',
  preview: 'preview',
  name: 'name',
  description: 'description',
  category: 'category',
  tags: 'tags',
  version: 'version',
} as const;

/** 云同步：DB 枚举标签（下划线风格 `pet_state`，写连字符会触发 22P02） */
export const PET_SYNC_KIND = 'pet_state' as const;
/** 云同步：REST 路径段（连字符风格） */
export const PET_SYNC_ROUTE = 'pet-state' as const;
