/**
 * PSD2Live CLI 封装（分层 PSD → .moc3/.model3.json/.cmo3 运行时文件族）
 * ——自平台后端 psd2live.ts 原样移植。
 * 依赖用户本机部署：GitHub tsunehimatoi/psd2live 便携版 ZIP（v0.7.1+，含裁剪 JRE，解压即用）。
 *   env PSD2LIVE_HOME  便携包解压根目录（含 bin/ app/ runtime/ 结构）
 * CLI 与 GUI 共用 mainClass（io.github.psd2live.MainKt），--input 参数即 headless 批处理模式。
 * 导出产物：*.moc3/*.model3.json/*.cdi3.json/*.physics3.json/*.idle.motion3.json/<name>.4096/texture_*.png
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import * as path from 'path';

export interface Psd2liveEntry {
  /** 可执行文件（bat）或 java.exe */
  cmd: string;
  /** cmd 为 java 时附带 -jar <uber.jar> 前缀参数 */
  prefixArgs: string[];
}

const TIMEOUT_MS = 10 * 60 * 1000;

/** 探测便携包 CLI 入口：优先 app/*.jar + runtime JRE（参数透传确定），退回 bin/*.bat */
function findEntry(home: string): Psd2liveEntry | null {
  const appDir = path.join(home, 'app');
  const runtimeJava = path.join(home, 'runtime', 'bin', 'java.exe');
  if (existsSync(appDir) && existsSync(runtimeJava)) {
    const jar = readdirSync(appDir).find((f) => f.toLowerCase().endsWith('.jar'));
    if (jar) return { cmd: runtimeJava, prefixArgs: ['-jar', path.join(appDir, jar)] };
  }
  const binDir = path.join(home, 'bin');
  if (existsSync(binDir)) {
    const bat = readdirSync(binDir).find((f) => f.toLowerCase().endsWith('.bat'));
    if (bat) return { cmd: path.join(binDir, bat), prefixArgs: [] };
  }
  return null;
}

/** 环境是否已配置（HOME 存在且能探测到入口） */
export function psd2liveConfigured(): boolean {
  const home = process.env.PSD2LIVE_HOME;
  return !!(home && existsSync(home) && findEntry(home));
}

/** 配置提示（未配置时给前端/日志看） */
export function psd2liveHint(): string {
  return '需要下载 PSD2Live 便携版（github.com/tsunehimatoi/psd2live/releases）解压，并配置 PSD2LIVE_HOME 环境变量指向解压根目录后重启应用';
}

/** 建模主入口：分层 PSD → 输出目录（自动创建，产物为 .moc3/.model3.json 等文件族） */
export async function buildLive2dModel(psdPath: string, outDir: string): Promise<void> {
  const home = process.env.PSD2LIVE_HOME!;
  const entry = findEntry(home);
  if (!entry) throw new Error('PSD2LIVE_HOME 目录结构不符合预期（缺少 app/*.jar 或 bin/*.bat）');

  const args = [...entry.prefixArgs, '--input', psdPath, '--output', outDir, '--lang', 'zh'];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(entry.cmd, args, { cwd: home, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PSD2Live 建模超时（${TIMEOUT_MS / 60000} 分钟）`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => { void d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`PSD2Live 启动失败：${err.message}`)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`PSD2Live 建模失败（exit ${code}）：${stderr.slice(-1500)}`));
    });
  });

  if (!existsSync(outDir)) throw new Error('PSD2Live 运行完成但输出目录不存在');
}
