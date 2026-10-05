/**
 * 宠物领域逻辑 shim：把仓库根目录的共享包 `pet/domain` 再导出给移动端。
 * Metro 经 `mobile/metro.config.js` 的 watchFolders 解析 mobile/ 之外的源码；
 * 移动端一律经 `../pet/domain` 引用，避免各文件手写冗长的相对路径。
 */
export * from '../../../pet/domain';
