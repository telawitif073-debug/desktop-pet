/**
 * 桌面端 · 宠物共享模块再导出 shim
 * ---------------------------------------------------------------------------
 * 共享模块的唯一事实来源在仓库根 `pet/`（domain/api/ui 三层，纯 TS 零依赖）。
 * 桌面代码沿用 `src/pet/*` 的既有引用风格，因此这里把 domain 层整体再导出；
 * 需要 api/ui 时请直接引用 `@pet/api` / `@pet/ui`（vite alias 与 tsconfig paths 已就绪）。
 */
export * from '../../pet/domain';
