const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * 关键点：**共享桌面端与移动端的宠物主体功能模块**。
 * 纯 TypeScript、无 DOM/Node 依赖的领域逻辑现在归位于共享包 `packages/pet-domain/src/**`，
 * 桌面侧通过 `src/pet/**` 的再导出 shim 引用它，移动端则直接引用（`src/pet/vitals`）。
 * 两条路径都落在 mobile/ 之外，因此必须把 `src/` 与 `packages/` 都加入 watchFolders，
 * Metro 才能解析并打包。桌面与移动必须给出同一套数值规则（否则两边状态会漂移）。
 *
 * 注意：watchFolders 只加源码目录（不含任何 node_modules），不会引入重复模块解析问题。
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, '..', 'src'), path.resolve(__dirname, '..', 'packages')],
  resolver: {
    // 共享源码希望优先用 mobile 自己的依赖（如 zustand 只有 mobile 装）
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
