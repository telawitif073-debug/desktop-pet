const path = require('path');
const { getDefaultConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * 说明：移动端经 watchFolders 引用仓库根目录的共享宠物模块 `pet/`（纯 TS，零依赖），
 * 与桌面端 `src/pet`、平台前端共用同一份领域逻辑；RN 侧经 `mobile/src/pet/domain.ts`
 * 再导出 shim 引用。`pet/resources/upstream` 是第三方素材（约 60MB，不参与打包），
 * 列入 blockList 避免 Metro 扫描，防止触发文件监听上限/拖慢启动。
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = getDefaultConfig(__dirname);

// 共享宠物模块源码目录（位于 mobile/ 之外，需显式加入监听与解析范围）
config.watchFolders = [path.resolve(__dirname, '..', 'pet')];

// 排除宠物模块内的第三方素材目录（体积大、无 JS 依赖，无需被 Metro 扫描）
const petUpstream = /[\\/]pet[\\/]resources[\\/]upstream[\\/].*/;
const defaultBlockList = config.resolver.blockList;
config.resolver.blockList = Array.isArray(defaultBlockList)
  ? [...defaultBlockList, petUpstream]
  : [defaultBlockList, petUpstream].filter(Boolean);

module.exports = config;
