/**
 * 内存 JobStore：图生视频全流程耗时 5-25 分钟，HTTP 同步不可行。
 * POST /ai/sprite-pet 返回 jobId，前端轮询 GET /ai/jobs/:id 获取进度与结果。
 * 进程重启后任务丢失（可接受，重新发起即可）。
 */

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

export interface SpriteJob {
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

const jobs = new Map<string, SpriteJob>();

export function createJob(): SpriteJob {
  const job: SpriteJob = {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    stage: 'base',
    done: 0,
    total: 12,
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): SpriteJob | undefined {
  return jobs.get(id);
}

export function patchJob(id: string, patch: Partial<SpriteJob>): void {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
}

/** 步进进度（每完成一个单元调用） */
export function stepJob(id: string, step: Partial<Pick<SpriteJob, 'stage' | 'current'>> = {}): void {
  const job = jobs.get(id);
  if (!job) return;
  job.done += 1;
  if (step.stage) job.stage = step.stage;
  if (step.current !== undefined) job.current = step.current;
}
