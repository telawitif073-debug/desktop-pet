import {
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

interface CrashBody {
  msg?: string;
  stack?: string;
  appVer?: string;
  screen?: string;
  ts?: number;
}

/** 追加写入：backend 根目录 crash.log（dist/crash → ../../ = backend 根） */
function logPath(): string {
  return path.join(__dirname, '..', '..', 'crash.log');
}

@Controller('crash-report')
export class CrashReportController {
  @Post()
  report(@Body() body: CrashBody): { ok: true } {
    try {
      const line = JSON.stringify({
        ts: body.ts ?? Date.now(),
        appVer: body.appVer ?? '',
        msg: String(body.msg ?? '').slice(0, 800),
        stack: String(body.stack ?? '').slice(0, 4000),
        screen: String(body.screen ?? ''),
      });
      fs.appendFileSync(logPath(), line + '\n');
    } catch {
      // 日志写失败不影响业务
    }
    return { ok: true };
  }

  @Get()
  list(): string {
    try {
      return fs.readFileSync(logPath(), 'utf8');
    } catch {
      return '(empty)';
    }
  }
}