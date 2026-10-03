const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * 关键点：**共享桌面端与移动端的宠物主体功能模块**。
 * `src/pet/**`（以及它依赖的 `src/shared/**`）是纯 TypeScript、无 DOM/Node 依赖的领域逻辑，
 * 桌面与移动必须给出同一套数值规则（否则两边状态会漂移）。这些文件在 mobile/ 之外，
 * 因此必须把它们加入 watchFolders，Metro 才能解析并打包。
 *
 * 注意：watchFolders 只加 `src/`（不含任何 node_modules），不会引入重复模块解析问题。
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, '..', 'src')],
  resolver: {
    // 共享源码希望优先用 mobile 自己的依赖（如 zustand 只有 mobile 装）
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
