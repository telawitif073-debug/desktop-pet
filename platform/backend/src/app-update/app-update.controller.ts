import { Controller, Get } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface AppUpdateManifest {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  notes: string;
}

/**
 * 客户端更新清单：读取 backend 根目录的 app-update.json（每次请求实时读盘，
 * 改文件即生效，无需重启）。发布流程：重打 APK → 覆盖 dist-share → 更新 app-update.json。
 */
@Controller('app-update')
export class AppUpdateController {
  @Get()
  show(): AppUpdateManifest {
    try {
      // 用 __dirname 定位（dist/app-update → ../../ = backend 根目录），不依赖进程启动目录；
      // 剥离可能存在的 UTF-8 BOM（部分 Windows 工具写入会带），否则 JSON.parse 失败
      const file = path.join(__dirname, '..', '..', 'app-update.json');
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw) as AppUpdateManifest;
    } catch {
      return { versionCode: 0, versionName: '', apkUrl: '', notes: '' };
    }
  }
}
