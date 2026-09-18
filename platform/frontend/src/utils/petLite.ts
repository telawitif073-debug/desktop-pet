import JSZip from 'jszip';
import { drawPetDesign, drawPetPart, paintPet, type PetDesign, type PetPartId, type PetPose } from './petCanvas';

/** live2d-lite 绑定参数（与后端 ai.service 的 PetRig 对应） */
export interface PetRig {
  breathAmp: number;
  breathSpeed: number;
  blinkInterval: number;
  headTiltAmp: number;
  headTiltSpeed: number;
  tailWagAmp: number;
  tailSpeed: number;
  swayAmp: number;
}

/** live2d-lite 模型描述：分层部件 + 待机动效参数（客户端轻量渲染器解析） */
export interface LiteModelJson {
  format: 'live2d-lite';
  version: 1;
  size: { width: number; height: number };
  model: { sway?: { amp: number; speed: number } };
  parts: Array<{
    id: PetPartId;
    file: string;
    z: number;
    parent?: 'head';
    pivot?: { x: number; y: number };
    motion?: {
      wag?: { amp: number; speed: number };
      breath?: { amp: number; speed: number };
      tilt?: { amp: number; speed: number };
      blink?: { interval: number };
    };
  }>;
}

/** 由形象与绑定参数构建 live2d-lite 模型描述（部件坐标与 petCanvas 绘制一致） */
export function buildLiteModelJson(design: PetDesign, rig: PetRig): LiteModelJson {
  const parts: LiteModelJson['parts'] = [
    { id: 'earL', file: 'parts/earL.png', z: 1, parent: 'head' },
    { id: 'earR', file: 'parts/earR.png', z: 1, parent: 'head' },
    {
      id: 'body', file: 'parts/body.png', z: 2,
      pivot: { x: 150, y: 262 },
      motion: { breath: { amp: rig.breathAmp, speed: rig.breathSpeed } },
    },
    {
      id: 'head', file: 'parts/head.png', z: 3,
      pivot: { x: 150, y: 150 },
      motion: { tilt: { amp: rig.headTiltAmp, speed: rig.headTiltSpeed } },
    },
    {
      id: 'eyes', file: 'parts/eyes.png', z: 4, parent: 'head',
      pivot: { x: 150, y: 94 },
      motion: { blink: { interval: rig.blinkInterval } },
    },
  ];
  if (design.hasTail) {
    parts.unshift({
      id: 'tail', file: 'parts/tail.png', z: 0,
      pivot: { x: 210, y: 220 },
      motion: { wag: { amp: rig.tailWagAmp, speed: rig.tailSpeed } },
    });
  }
  return {
    format: 'live2d-lite',
    version: 1,
    size: { width: 300, height: 300 },
    model: rig.swayAmp > 0 ? { sway: { amp: rig.swayAmp, speed: 0.6 } } : {},
    parts,
  };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画布导出失败'))), 'image/png');
  });
}

/** 由绑定参数计算 t 时刻姿态（面板 Live2D 预览用；客户端轻量渲染器使用相同公式） */
export function computeRigPose(rig: PetRig, tMs: number): PetPose {
  const t = tMs / 1000;
  const half = (speed: number) => 2 * Math.PI * speed * 0.5 * t;
  let eyeOpen = 1;
  const phase = t % rig.blinkInterval;
  if (phase < 0.32) eyeOpen = Math.max(0.08, 1 - Math.sin((Math.PI * phase) / 0.32) * 0.92);
  return {
    bounce: 0,
    sway: rig.swayAmp * Math.sin(2 * Math.PI * 0.6 * t),
    tailAngle: rig.tailWagAmp * Math.sin(half(rig.tailSpeed)),
    eyeOpen,
    breath: rig.breathAmp * Math.sin(2 * Math.PI * rig.breathSpeed * t),
    headTilt: rig.headTiltAmp * Math.sin(half(rig.headTiltSpeed)),
  };
}

/** 按绑定参数渲染 live2d-lite 待机动画帧（面板预览用） */
export function drawLiteFrame(canvas: HTMLCanvasElement, d: PetDesign, rig: PetRig, tMs: number): void {
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, 300, 300);
  paintPet(ctx, d, computeRigPose(rig, tMs));
}

/**
 * 构建 live2d-lite 宠物 zip（live2d 格式资源）：
 * parts/*.png 分层部件 + live2d-lite.json 模型描述 + preview.png 商店预览图。
 */
export async function buildLiteZip(design: PetDesign, rig: PetRig): Promise<{ zip: Blob; preview: Blob }> {
  const zip = new JSZip();
  const partIds: PetPartId[] = design.hasTail
    ? ['tail', 'earL', 'earR', 'body', 'head', 'eyes']
    : ['earL', 'earR', 'body', 'head', 'eyes'];
  for (const part of partIds) {
    const c = document.createElement('canvas');
    drawPetPart(c, part, design);
    zip.file(`parts/${part}.png`, await canvasToBlob(c));
  }
  zip.file('live2d-lite.json', JSON.stringify(buildLiteModelJson(design, rig), null, 2));

  const previewCanvas = document.createElement('canvas');
  drawPetDesign(previewCanvas, design);
  const preview = await canvasToBlob(previewCanvas);
  zip.file('preview.png', preview);

  return { zip: await zip.generateAsync({ type: 'blob' }), preview };
}

/** AI 主体图默认绑定参数（绘图智能体不产出 rig，统一用这套温和待机动效） */
export const DEFAULT_SUBJECT_RIG: PetRig = {
  breathAmp: 0.05,
  breathSpeed: 1.2,
  blinkInterval: 4,
  headTiltAmp: 4,
  headTiltSpeed: 0.8,
  tailWagAmp: 12,
  tailSpeed: 1.2,
  swayAmp: 3,
};

/**
 * 由 AI 主体透明 PNG 构建 live2d-lite zip：单 body 部件（整图铺入 300×300，底部留边）
 * + 呼吸/摆动绑定。客户端轻量渲染器按 parts 数组通用解析，单部件即可驱动待机动画。
 */
export async function buildLiteZipFromImage(dataUrl: string, rig: PetRig = DEFAULT_SUBJECT_RIG): Promise<{ zip: Blob; preview: Blob }> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('主体图加载失败'));
    img.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');
  const scale = Math.min((300 * 0.88) / img.width, (300 * 0.88) / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (300 - w) / 2, 300 - h - 300 * 0.06, w, h);
  const bodyBlob = await canvasToBlob(canvas);

  const zip = new JSZip();
  zip.file('parts/body.png', bodyBlob);
  zip.file('live2d-lite.json', JSON.stringify({
    format: 'live2d-lite',
    version: 1,
    size: { width: 300, height: 300 },
    model: rig.swayAmp > 0 ? { sway: { amp: rig.swayAmp, speed: 0.6 } } : {},
    parts: [
      {
        id: 'body',
        file: 'parts/body.png',
        z: 2,
        pivot: { x: 150, y: 270 },
        motion: { breath: { amp: rig.breathAmp, speed: rig.breathSpeed } },
      },
    ],
  }, null, 2));

  const preview = await (await fetch(dataUrl)).blob();
  zip.file('preview.png', preview);

  return { zip: await zip.generateAsync({ type: 'blob' }), preview };
}
