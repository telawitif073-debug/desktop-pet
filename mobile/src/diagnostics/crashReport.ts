/** 崩溃自动上报（诊断用）：未捕获错误 / 错误边界捕获时，把错误栈 fire-and-forget POST 到服务器
 *  /api/crash-report（无需登录，登录前也生效），排查时直接读服务器 crash.log 即得真实错误栈。 */
import { DEFAULT_BASE_URL } from '../store/appStore';

let inflight = false;

export function reportCrash(msg: string, stack: string, screen?: string): void {
  if (inflight) return; // 单飞，避免错误风暴打爆网络
  inflight = true;
  const url = `${DEFAULT_BASE_URL.replace(/\/$/, '')}/crash-report`;
  const body = JSON.stringify({
    msg: String(msg ?? '').slice(0, 800),
    stack: String(stack ?? '').slice(0, 4000),
    appVer: '',
    screen: screen ?? '',
    ts: Date.now(),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal })
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timer);
      inflight = false;
    });
}