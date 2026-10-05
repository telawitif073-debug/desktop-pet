/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 宠物模块 · 契约层（api）统一入口
 *
 * 只放类型 / 常量 / 路径 / 限额，**无实现、无副作用**。
 * 依赖方向：`domain ← api ← ui`（api 可引用 domain 的类型；反向禁止）。
 */
export * from './limits';
export * from './endpoints';
export * from './contract';
export * from './syncKeys';
