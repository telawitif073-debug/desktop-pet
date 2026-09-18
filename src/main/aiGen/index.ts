/**
 * AI 生成宠物（客户端本地流水线，用户自备 Key，双路径）：
 *   路径A 精灵表：基准图 → 万相 i2v ×5 状态 → ffmpeg 截帧 → 绿幕抠图 → 6×5 精灵表
 *   路径B Live2D：基准图 → See-through 拆层 → PSD2Live 建模 → zip
 *   产物直接写 userData/pets/ 安装并切换当前宠物（不经平台上传）。
 * 内存 JobStore（重启丢失可接受）+ IPC：
 *   ai:generate-sprite / ai:generate-live2d / ai:gen-job-status / ai:gen-install
 */

import { app, ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { loadConfig, saveConfig } from '../config';
import { clearPlatformActions } from '../petActions';
import { cutoutImage } from './cutout';
import { buildSpriteSheet, extractFrames, STATE_ROWS, type StateName } from './spritesheet';
import { runPromptAgent, stylePromptOf, STATE_VIDEO_PROMPTS, withVideoSuffix } from './prompts';
import { generateSubjectImage, imageToVideo, type AiGenKeys } from './remote';
import { decomposeToPsd, seethroughConfigured, seethroughHint } from './seethrough';
import { buildLive2dModel, psd2liveConfigured, psd2liveHint } from './psd2live';

// ---------- JobStore ----------

export type JobStage = 'base' | 'video' | 'frames' | 'assemble' | 'layers' | 'rig' | 'pack';

export interface SpriteJobResult {
  kind: 'sprite';
  name: string;
  /** 精灵表 PNG 的 dataUrl（1536×1280，6列×5行，每格 256×256） */
  sheetDataUrl: string;
  /** animations.json 内容（renderMode/frameWidth/frameHeight/animations） */
  animations: Record<string, unknown>;
  /** 预览图（idle 首帧）dataUrl */
  previewDataUrl: string;
}

export interface Live2dJobResult {
  kind: 'live2d';
  name: string;
  /** 模型文件族 zip 的 dataUrl（model3.json + moc3 + physics3 + idle.motion3 + cdi3 + 纹理目录） */
  zipDataUrl: string;
  /** 预览图（基准立绘）dataUrl */
  previewDataUrl: string;
}

export type JobResult = SpriteJobResult | Live2dJobResult;

export interface AiGenJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  stage: JobStage;
  /** 当前进度（0..total）：精灵表 = 1 基准图 + 5 视频 + 5 截帧 + 1 拼表 = 12；Live2D = 基准图/拆层/建模/打包 4 步 */
  done: number;
  total: number;
  /** 当前处理的状态名（video/frames 阶段展示用） */
  current?: string;
  error?: string;
  result?: JobResult;
}

const jobs = new Map<string, AiGenJob>();

function createJob(): AiGenJob {
  const job: AiGenJob = {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    stage: 'base',
    done: 0,
    total: 12,
  };
  jobs.set(job.id, job);
  return job;
}

function getJob(id: string): AiGenJob | undefined {
  return jobs.get(id);
}

function patchJob(id: string, patch: Partial<AiGenJob>): void {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
}

/** 步进进度（每完成一个单元调用） */
function stepJob(id: string, step: Partial<Pick<AiGenJob, 'stage' | 'current'>> = {}): void {
  const job = jobs.get(id);
  if (!job) return;
  job.done += 1;
  if (step.stage) job.stage = step.stage;
  if (step.current !== undefined) job.current = step.current;
}

function jobError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- 流水线 ----------

function getKeys(): AiGenKeys {
  const aiGen = loadConfig().aiGen;
  return {
    dashscopeKey: aiGen?.dashscopeKey,
    arkKey: aiGen?.arkKey,
    zhipuKey: aiGen?.zhipuKey,
  };
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.replace(/^data:[^;,]+;base64,/, '');
  return Buffer.from(base64, 'base64');
}

async function videoWithRetry(imgDataUrl: string, prompt: string, keys: AiGenKeys): Promise<Buffer> {
  try {
    return await imageToVideo(imgDataUrl, prompt, keys);
  } catch {
    // 失败自动重试 1 次（限流/偶发任务失败）
    return imageToVideo(imgDataUrl, prompt, keys);
  }
}

/** 启动精灵表生成任务（异步执行，立即返回 jobId） */
function startSpriteJob(description: string, style?: string): AiGenJob {
  const job = createJob();
  void runSpriteJob(job.id, description, style).catch((err: unknown) => {
    patchJob(job.id, { status: 'failed', error: jobError(err) });
  });
  return job;
}

async function runSpriteJob(jobId: string, description: string, style?: string): Promise<void> {
  const keys = getKeys();
  // ① 基准图：提示词细化 → 出图（浅绿幕底原稿 = 视频首帧）→ 抠图校验（顺便拿角色名）
  stepJob(jobId, { stage: 'base', current: '生成基准图' });
  const plan = await runPromptAgent(description, { stylePrompt: stylePromptOf(style), zhipuKey: keys.zhipuKey });
  const image = await generateSubjectImage(plan.imagePrompt, keys);
  const cut = await cutoutImage(image.dataUrl);
  stepJob(jobId);

  // ② 五状态：i2v → 截帧（状态间串行避免限流）
  const stateFrames = {} as Record<StateName, Buffer[]>;
  for (const state of STATE_ROWS) {
    stepJob(jobId, { stage: 'video', current: state });
    const video = await videoWithRetry(image.dataUrl, withVideoSuffix(STATE_VIDEO_PROMPTS[state]), keys);
    stepJob(jobId, { stage: 'frames', current: state });
    stateFrames[state] = await extractFrames(video, 6);
    stepJob(jobId);
  }

  // ③ 拼精灵表
  stepJob(jobId, { stage: 'assemble', current: '拼合精灵表' });
  const sheet = await buildSpriteSheet(stateFrames);
  stepJob(jobId);

  patchJob(jobId, {
    status: 'done',
    stage: 'assemble',
    current: undefined,
    result: {
      kind: 'sprite',
      name: plan.name,
      sheetDataUrl: sheet.sheetDataUrl,
      animations: sheet.animations,
      previewDataUrl: sheet.previewDataUrl || cut.dataUrl,
    },
  });
}

/** 前端可用性检查：两项外部工具均已部署（Live2D 路径） */
function live2dCapability(): { ok: boolean; error?: string } {
  if (!seethroughConfigured()) return { ok: false, error: seethroughHint() };
  if (!psd2liveConfigured()) return { ok: false, error: psd2liveHint() };
  return { ok: true };
}

/** 启动 Live2D 生成任务（异步执行，立即返回 jobId） */
function startLive2dJob(description: string, style?: string): AiGenJob {
  const job = createJob();
  job.total = 4;
  void runLive2dJob(job.id, description, style).catch((err: unknown) => {
    patchJob(job.id, { status: 'failed', error: jobError(err) });
  });
  return job;
}

async function runLive2dJob(jobId: string, description: string, style?: string): Promise<void> {
  let workDir: string | null = null;
  try {
    const keys = getKeys();
    // ① 基准图：细化 → 出图（浅绿幕底）→ 抠图（透明立绘）
    stepJob(jobId, { stage: 'base', current: '生成基准图' });
    const plan = await runPromptAgent(description, { stylePrompt: stylePromptOf(style), zhipuKey: keys.zhipuKey });
    const image = await generateSubjectImage(plan.imagePrompt, keys);
    const cut = await cutoutImage(image.dataUrl);
    stepJob(jobId);

    // ②③ 外部工具拆层 + 建模（临时目录中转）
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-live2d-'));
    const basePng = path.join(workDir, 'base.png');
    await fs.promises.writeFile(basePng, dataUrlToBuffer(cut.dataUrl));

    stepJob(jobId, { stage: 'layers', current: 'See-through 拆层（约 3-15 分钟）' });
    const psdPath = await decomposeToPsd(basePng);
    stepJob(jobId);

    stepJob(jobId, { stage: 'rig', current: 'PSD2Live 自动建模' });
    const outDir = path.join(workDir, 'model');
    await buildLive2dModel(psdPath, outDir);
    stepJob(jobId);

    // ④ 打包：model3.json 置于 zip 根（安装入口选择按 model3.json 识别）
    stepJob(jobId, { stage: 'pack', current: '打包模型文件族' });
    const zip = new AdmZip();
    for (const abs of walkFilesSync(outDir)) {
      zip.addLocalFile(abs, path.relative(outDir, path.dirname(abs)).replace(/\\/g, '/'));
    }
    const zipBuf = zip.toBuffer();
    stepJob(jobId);

    patchJob(jobId, {
      status: 'done',
      stage: 'pack',
      current: undefined,
      result: {
        kind: 'live2d',
        name: plan.name,
        zipDataUrl: `data:application/zip;base64,${zipBuf.toString('base64')}`,
        previewDataUrl: cut.dataUrl,
      },
    });
  } finally {
    if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function walkFilesSync(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFilesSync(full));
    else out.push(full);
  }
  return out;
}

// ---------- 结果安装（写 userData/pets/ 并切换当前宠物） ----------

function findFirstFile(directory: string, predicate: (filePath: string) => boolean): string | null {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFirstFile(entryPath, predicate);
      if (nested) return nested;
    } else if (predicate(entryPath)) {
      return entryPath;
    }
  }
  return null;
}

/** 安装任务结果：精灵表 → spritesheet.png + animations.json；Live2D → zip 解压取 model3.json 入口 */
async function installJobResult(
  jobId: string,
  notifyPetAssetChanged: () => void,
): Promise<{ success: true; name: string; path: string; format: 'sprite' | 'live2d' }> {
  const job = getJob(jobId);
  if (!job) throw new Error('任务不存在或已丢失（应用可能已重启），请重新生成');
  if (job.status === 'failed') throw new Error(`任务失败：${job.error || '未知错误'}`);
  if (job.status !== 'done' || !job.result) throw new Error('任务尚未完成');

  const petId = `ai-${Date.now().toString(36)}`;
  const installDir = path.join(app.getPath('userData'), 'pets', petId);
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(installDir, { recursive: true });

  let entryPath: string;
  let format: 'sprite' | 'live2d';
  if (job.result.kind === 'sprite') {
    fs.writeFileSync(path.join(installDir, 'spritesheet.png'), dataUrlToBuffer(job.result.sheetDataUrl));
    fs.writeFileSync(path.join(installDir, 'animations.json'), JSON.stringify(job.result.animations, null, 2), 'utf-8');
    entryPath = path.join(installDir, 'spritesheet.png');
    format = 'sprite';
  } else {
    const tempZip = path.join(os.tmpdir(), `ai-pet-${petId}.zip`);
    try {
      fs.writeFileSync(tempZip, dataUrlToBuffer(job.result.zipDataUrl));
      new AdmZip(tempZip).extractAllTo(installDir, true);
    } finally {
      fs.rmSync(tempZip, { force: true });
    }
    entryPath = findFirstFile(installDir, (p) => /model3\.json$/i.test(p))
      ?? findFirstFile(installDir, () => true)
      ?? path.join(installDir, 'model3.json');
    format = 'live2d';
  }

  // 换宠物：清除旧宠物的资源库动作（动作随宠物，不可跨宠物使用），再注册新资产并通知渲染端重载
  clearPlatformActions();
  saveConfig({
    petAssetPath: entryPath,
    petAssetName: job.result.name || 'AI 宠物',
    petAssetId: petId,
    petAssetFormat: format,
  });
  notifyPetAssetChanged();
  return { success: true, name: job.result.name || 'AI 宠物', path: entryPath, format };
}

// ---------- IPC 注册 ----------

export function registerAiGenIpc(opts: { notifyPetAssetChanged: () => void }): void {
  ipcMain.handle('ai:generate-sprite', (_event, description: string, style?: string) => {
    const desc = String(description || '').trim();
    if (!desc) throw new Error('请先填写宠物描述');
    const job = startSpriteJob(desc, style);
    return { jobId: job.id };
  });

  ipcMain.handle('ai:generate-live2d', (_event, description: string, style?: string) => {
    const desc = String(description || '').trim();
    if (!desc) throw new Error('请先填写宠物描述');
    const cap = live2dCapability();
    if (!cap.ok) return { ok: false, error: cap.error };
    const job = startLive2dJob(desc, style);
    return { ok: true, jobId: job.id };
  });

  ipcMain.handle('ai:gen-job-status', (_event, jobId: string) => {
    return getJob(String(jobId || '')) ?? null;
  });

  ipcMain.handle('ai:gen-install', async (_event, jobId: string) => {
    return installJobResult(String(jobId || ''), opts.notifyPetAssetChanged);
  });
}
