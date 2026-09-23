import { Module } from '@nestjs/common';
import { CrashReportController } from './crash-report.controller';

/**
 * 崩溃上报（诊断用）：客户端把未捕获 JS 错误栈 POST 到 /api/crash-report，
 * 服务端追加到 crash.log（JSONL）。开发端直接读文件即得用户设备真实错误。
 */
@Module({
  controllers: [CrashReportController],
})
export class CrashReportModule {}