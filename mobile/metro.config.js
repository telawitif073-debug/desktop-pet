const { getDefaultConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * 说明：此前移动端引用桌面端共享的宠物主体功能模块（`src/pet/**` / `packages/pet-domain`），
 * 故在 watchFolders 里加入了 mobile/ 之外的源码目录；宠物系统下线后移动端不再引用任何
 * mobile/ 之外的源码，watchFolders 及共享源码解析一并移除，回到 RN 默认配置。
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
module.exports = getDefaultConfig(__dirname);
