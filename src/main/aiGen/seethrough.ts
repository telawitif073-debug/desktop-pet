/**
 * See-through 拆层封装（单张立绘 → 分层 PSD）——自平台后端 seethrough.ts 原样移植。
 * 依赖用户本机部署：conda 环境（python 3.12 + torch cu128）+ shitagaki-lab/see-through 仓库。
 *   env SEETHROUGH_HOME    仓库根目录（必须，inference/scripts/inference_psd.py 相对它运行）
 *   env SEETHROUGH_PYTHON  conda 环境的 python.exe 绝对路径（必须）
 *   env SEETHROUGH_SCRIPT  可选，默认 inference/scripts/inference_psd.py（8GB 显存可配 inference_psd_quantized.py）
 *   env SEETHROUGH_ARGS    可选，追加 CLI 参数（如 --group_offload）
 * 输出固定落在仓库 workspace/layerdiff_output/ 下，跑完后扫描最新 .psd 返回。
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import * as path from 'path';

const DEFAULT_SCRIPT = 'inference/scripts/inference_psd.py';
/** 单图拆层耗时数分钟到十几分钟（含模型加载），超时 30 分钟 */
const TIMEOUT_MS = 30 * 60 * 1000;

/** 环境是否已配置（配置且文件存在才可用） */
export function seethroughConfigured(): boolean {
  const home = process.env.SEETHROUGH_HOME;
  const python = process.env.SEETHROUGH_PYTHON;
  return !!(home && python && existsSync(home) && existsSync(python));
}

/** 配置提示（未配置时给前端/日志看） */
export function seethroughHint(): string {
  return '需要配置 SEETHROUGH_HOME（see-through 仓库根目录）与 SEETHROUGH_PYTHON（conda 环境 python.exe）环境变量后重启应用';
}

function runPython(script: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const python = process.env.SEETHROUGH_PYTHON!;
    const child = spawn(python, [script, ...args], { cwd, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`See-through 拆层超时（${TIMEOUT_MS / 60000} 分钟）`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => { void d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`See-through python 启动失败：${err.message}`)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`See-through 拆层失败（exit ${code}）：${stderr.slice(-1500)}`));
    });
  });
}

/** 扫描 layerdiff_output 下最新的 .psd（mtime 最新优先） */
function findLatestPsd(home: string): string | null {
  const outRoot = path.join(home, 'workspace', 'layerdiff_output');
  if (!existsSync(outRoot)) return null;
  const candidates: Array<{ file: string; mtime: number }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith('.psd')) candidates.push({ file: full, mtime: st.mtimeMs });
    }
  };
  walk(outRoot);
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file ?? null;
}

/**
 * 拆层主入口：透明立绘 PNG → 分层 PSD（绝对路径）。
 * 注意会往仓库 workspace/layerdiff_output 写中间产物（See-through 固定行为，不做清理）。
 */
export async function decomposeToPsd(basePngPath: string): Promise<string> {
  const home = process.env.SEETHROUGH_HOME!;
  const script = process.env.SEETHROUGH_SCRIPT || DEFAULT_SCRIPT;
  if (!existsSync(path.join(home, script))) {
    throw new Error(`See-through 脚本不存在：${script}（检查 SEETHROUGH_HOME 与仓库版本）`);
  }
  const extra = (process.env.SEETHROUGH_ARGS || '').split(' ').map((s) => s.trim()).filter(Boolean);
  await runPython(script, ['--srcp', basePngPath, '--save_to_psd', ...extra], home);
  const psd = findLatestPsd(home);
  if (!psd) throw new Error('See-through 运行完成但未找到输出 PSD（workspace/layerdiff_output 为空）');
  return psd;
}
