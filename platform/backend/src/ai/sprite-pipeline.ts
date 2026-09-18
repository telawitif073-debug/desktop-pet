/**
 * 路径A 精灵表生成任务编排：
 *   基准图（提示词细化 → 出图，浅绿幕底原稿既作视频首帧也作抠图预览）
 *   → 五状态逐串行：万相 i2v（失败重试 1 次）→ ffmpeg 均匀截 6 帧
 *   → 统一抠图拼精灵表 → JobStore 记录结果。
 * 状态间串行避免限流；整任务 5-25 分钟，由前端轮询 JobStore 跟进。
 */

import { imageToVideo } from './dashscope';
import { createJob, getJob, patchJob, stepJob, type SpriteJob } from './jobs';
import { generateSubjectImage } from './image-gen';
import { runPromptAgent, stylePromptOf } from './prompt-agent';
import { buildSpriteSheet, extractFrames, STATE_ROWS, type StateName } from './spritesheet';
import { cutoutImage } from './cutout';

/** 五状态视频动作提示词（视频模型只负责动效；背景/外观约束固定钉死） */
const STATE_VIDEO_PROMPTS: Record<StateName, string> = {
  idle: '角色保持原地站立，轻微的呼吸起伏，身体和头发有自然的小幅晃动，循环往复',
  moving: '角色面向镜头方向原地小碎步左右平移走动，身体上下轻微弹跳，步伐轻快，循环往复',
  eating: '角色低头做咀嚼进食的动作，嘴巴一张一合重复咀嚼，身体随咀嚼轻微起伏，循环往复',
  resting: '角色慢慢蹲下蜷缩闭眼打盹休息，只有呼吸的缓慢起伏，动作幅度很小，循环往复',
  playing: '角色开心地原地跳跃玩耍，跳起后落地，动作活泼欢快，循环往复',
};

/** 视频提示词固定后缀：外观一致 + 纯色背景不变 + 镜头固定（抠图管线依赖背景稳定） */
function withVideoSuffix(action: string): string {
  return `${action}。角色的外观、颜色、大小与图中完全一致，不发生任何变化；背景保持图中的纯色不变，无阴影无光效，背景中不出现任何新物体；镜头固定不动，画面为固定机位。`;
}

async function videoWithRetry(imgDataUrl: string, prompt: string): Promise<Buffer> {
  try {
    return await imageToVideo(imgDataUrl, prompt);
  } catch {
    // 失败自动重试 1 次（限流/偶发任务失败）
    return imageToVideo(imgDataUrl, prompt);
  }
}

/** 启动精灵表生成任务（异步执行，立即返回 jobId） */
export function startSpritePetJob(description: string, style?: string): SpriteJob {
  const job = createJob();
  void runSpritePetJob(job.id, description, style).catch((err: unknown) => {
    patchJob(job.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
  });
  return job;
}

async function runSpritePetJob(jobId: string, description: string, style?: string): Promise<void> {
  // ① 基准图：提示词细化 → 出图（浅绿幕底原稿 = 视频首帧）→ 抠图校验（顺便拿角色名）
  stepJob(jobId, { stage: 'base', current: '生成基准图' });
  const plan = await runPromptAgent(description, { stylePrompt: stylePromptOf(style) });
  const image = await generateSubjectImage(plan.imagePrompt);
  const cut = await cutoutImage(image.dataUrl);
  stepJob(jobId);

  // ② 五状态：i2v → 截帧
  const stateFrames = {} as Record<StateName, Buffer[]>;
  for (const state of STATE_ROWS) {
    stepJob(jobId, { stage: 'video', current: state });
    const video = await videoWithRetry(image.dataUrl, withVideoSuffix(STATE_VIDEO_PROMPTS[state]));
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
