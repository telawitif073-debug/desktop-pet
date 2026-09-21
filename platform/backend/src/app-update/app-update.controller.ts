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
      const file = path.join(process.cwd(), 'app-update.json');
      return JSON.parse(fs.readFileSync(file, 'utf8')) as AppUpdateManifest;
    } catch {
      return { versionCode: 0, versionName: '', apkUrl: '', notes: '' };
    }
  }
}
