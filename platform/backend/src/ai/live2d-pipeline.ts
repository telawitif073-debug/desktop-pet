/**
 * 路径B Live2D 生成任务编排：
 *   基准图（提示词细化 → 出图 → 绿幕抠图 → 透明立绘）
 *   → See-through 拆层（本机 python 推理，产出分层 PSD）
 *   → PSD2Live 建模（本机 java CLI，产出 .moc3/.model3.json 文件族）
 *   → 打包 zip（入口 model3.json，客户端 resolveFormat 识别为 live2d）。
 * 两个外部工具为重依赖（conda 环境 + 数 GB 权重 / 便携包），未部署时 /ai/meta 报告不可用。
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { createJob, patchJob, stepJob } from './jobs';
import { generateSubjectImage } from './image-gen';
import { runPromptAgent, stylePromptOf } from './prompt-agent';
import { cutoutImage } from './cutout';
import { decomposeToPsd, seethroughConfigured, seethroughHint } from './seethrough';
import { buildLive2dModel, psd2liveConfigured, psd2liveHint } from './psd2live';

/** 前端/控制器可用性检查：两项外部工具均已部署 */
export function live2dCapability(): { ok: boolean; error?: string } {
  if (!seethroughConfigured()) return { ok: false, error: seethroughHint() };
  if (!psd2liveConfigured()) return { ok: false, error: psd2liveHint() };
  return { ok: true };
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64, 'base64');
}

/** 启动 Live2D 生成任务（异步执行，立即返回 jobId） */
export function startLive2dPetJob(description: string, style?: string) {
  const job = createJob();
  job.total = 4;
  void runLive2dPetJob(job.id, description, style).catch((err: unknown) => {
    patchJob(job.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
  });
  return job;
}

async function runLive2dPetJob(jobId: string, description: string, style?: string): Promise<void> {
  let workDir: string | null = null;
  try {
    // ① 基准图：细化 → 出图（浅绿幕底）→ 抠图（透明立绘）
    stepJob(jobId, { stage: 'base', current: '生成基准图' });
    const plan = await runPromptAgent(description, { stylePrompt: stylePromptOf(style) });
    const image = await generateSubjectImage(plan.imagePrompt);
    const cut = await cutoutImage(image.dataUrl);
    stepJob(jobId);

    // ②③ 外部工具拆层 + 建模（临时目录中转）
    workDir = await mkdtemp(path.join(tmpdir(), 'ai-live2d-'));
    const basePng = path.join(workDir, 'base.png');
    await writeFile(basePng, dataUrlToBuffer(cut.dataUrl));

    stepJob(jobId, { stage: 'layers', current: 'See-through 拆层（约 3-15 分钟）' });
    const psdPath = await decomposeToPsd(basePng);
    stepJob(jobId);

    stepJob(jobId, { stage: 'rig', current: 'PSD2Live 自动建模' });
    const outDir = path.join(workDir, 'model');
    await buildLive2dModel(psdPath, outDir);
    stepJob(jobId);

    // ④ 打包：model3.json 置于 zip 根（客户端入口选择按 model3.json 识别）
    stepJob(jobId, { stage: 'pack', current: '打包模型文件族' });
    const zip = new JSZip();
    for (const abs of await walkFiles(outDir)) {
      zip.file(path.relative(outDir, abs).replace(/\\/g, '/'), await readFile(abs));
    }
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
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
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}
