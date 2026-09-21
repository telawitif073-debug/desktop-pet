/**
 * 平台服务运行器：客户端内自动拉起平台三件套（便携 PostgreSQL 5432 / 后端 3001 / 前端 5174）。
 * 打开商店时若服务未运行则自动启动并等待就绪，避免「商店无法正常显示」。
 * 依赖随仓库分发的便携 PostgreSQL（platform/.pg）与 dev 模式服务；打包发布时需改为连接远程/预装服务。
 */

import { spawn } from 'child_process';
import net from 'net';
import path from 'path';

const PG_PORT = 5432;
const BACKEND_PORT = 3001;
const FRONTEND_PORT = 5174;

/** 端口是否在监听（短超时探测，未监听/拒绝/超时一律 false） */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** 轮询等待端口就绪 */
function waitPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const tick = async (): Promise<boolean> => {
    if (await isPortOpen(port)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
    return tick();
  };
  return tick();
}

/** 后台启动 npm 服务（隐藏窗口；不随客户端退出，与一键脚本行为一致） */
function spawnNpmTask(cwd: string, script: string): void {
  const child = spawn('cmd.exe', ['/c', `npm run ${script}`], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

let ensuring: Promise<boolean> | null = null;

/** 确保平台三件套就绪（幂等；并发调用共享同一次启动流程），返回是否全部就绪 */
export function ensurePlatformServices(appRoot: string): Promise<boolean> {
  if (!ensuring) {
    ensuring = (async () => {
      const platformDir = path.join(appRoot, 'platform');
      // 1. PostgreSQL（便携版，非 Windows 服务，重启后需重新启动）
      if (!(await isPortOpen(PG_PORT))) {
        console.log('[platform-runner] starting portable PostgreSQL (5432)…');
        const pgCtl = path.join(platformDir, '.pg', 'pgsql', 'bin', 'pg_ctl.exe');
        const pgData = path.join(platformDir, '.pg', 'data');
        const pgLog = path.join(platformDir, '.pg', 'logs', 'pg.log');
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(pgCtl, ['-D', pgData, '-l', pgLog, 'start'], { windowsHide: true, stdio: 'ignore' });
            child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pg_ctl exit ${code}`))));
            child.once('error', reject);
          });
        } catch (err) {
          console.log('[platform-runner] pg_ctl failed:', err);
          return false;
        }
        if (!(await waitPort(PG_PORT, 20_000))) {
          console.log('[platform-runner] PostgreSQL not ready in 20s');
          return false;
        }
        console.log('[platform-runner] PostgreSQL ready (5432)');
      }
      // 2. 后端（NestJS dev watch）
      if (!(await isPortOpen(BACKEND_PORT))) {
        console.log('[platform-runner] starting platform backend (3001)…');
        spawnNpmTask(path.join(platformDir, 'backend'), 'start:dev');
        if (!(await waitPort(BACKEND_PORT, 60_000))) {
          console.log('[platform-runner] backend not ready in 60s');
          return false;
        }
        console.log('[platform-runner] backend ready (3001)');
      }
      // 3. 前端（vite dev）
      if (!(await isPortOpen(FRONTEND_PORT))) {
        console.log('[platform-runner] starting platform frontend (5174)…');
        spawnNpmTask(path.join(platformDir, 'frontend'), 'dev');
        if (!(await waitPort(FRONTEND_PORT, 30_000))) {
          console.log('[platform-runner] frontend not ready in 30s');
          return false;
        }
        console.log('[platform-runner] frontend ready (5174)');
      }
      console.log('[platform-runner] platform services ready');
      return true;
    })()
      .catch((err) => {
        console.log('[platform-runner] ensure failed:', err);
        return false;
      })
      .finally(() => {
        ensuring = null; // 失败后允许重试（下次打开商店重新走一遍）
      });
  }
  return ensuring;
}
