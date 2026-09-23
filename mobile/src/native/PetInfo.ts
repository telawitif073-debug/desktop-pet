import { NativeModules } from 'react-native';

/** 原生「关于/更新」信息：系统安装的真实版本（防止 JS 常量与构建版本漂移） */
interface PetInfoNative {
  versionCode: number;
  versionName: string;
}

const native: PetInfoNative | undefined = NativeModules.PetInfo as
  | PetInfoNative
  | undefined;

/** 系统安装的真实 versionCode；旧包无此模块返回 0（由调用方回退 JS 常量） */
export const nativeVersionCode: number =
  typeof native?.versionCode === 'number' ? native.versionCode : 0;

/** 系统安装的真实 versionName；旧包无此模块返回空串 */
export const nativeVersionName: string = native?.versionName ?? '';