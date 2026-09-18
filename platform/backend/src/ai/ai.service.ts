import { Injectable } from '@nestjs/common';
import { cutoutImage } from './cutout';
import { generateSubjectImage } from './image-gen';
import { runPromptAgent, stylePromptOf, PAINT_STYLES, type PromptAgentResult } from './prompt-agent';
import { live2dCapability } from './live2d-pipeline';

/** 基准图链路结果：透明 PNG 立绘 + 提示词元数据 + 主体包围盒 */
export interface BaseImageResult extends PromptAgentResult {
  /** 图像生成渠道 */
  provider: 'seedream' | 'cogview';
  /** 透明背景 PNG 的 dataUrl */
  dataUrl: string;
  transparentPct: number;
  width: number;
  height: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

@Injectable()
export class AiService {
  /** 可选项元数据：画风列表 + 各能力 Key 配置状态（前端据此渲染可用渠道） */
  getMeta() {
    return {
      styles: PAINT_STYLES.map(({ id, label }) => ({ id, label })),
      capabilities: {
        /** 图像生成：CogView 免费 / Seedream 可选 */
        cogview: !!process.env.ZHIPU_API_KEY,
        seedream: !!process.env.ARK_API_KEY,
        /** 通义万相图生视频（路径A 精灵表流水线） */
        wanVideo: !!process.env.DASHSCOPE_API_KEY,
        /** 路径B Live2D（See-through 拆层 + PSD2Live 建模，本机外部工具） */
        live2d: live2dCapability().ok,
        /** 提示词细化 */
        promptAgent: !!(process.env.SPARK_API_KEY || process.env.ZHIPU_API_KEY),
      },
    };
  }

  /** 基准图链路：描述 → 提示词细化 → 图像生成（浅绿幕底）→ 抠图 → 透明立绘 + bbox 元数据 */
  async baseImage(description: string, style?: string): Promise<BaseImageResult> {
    const plan = await runPromptAgent(description, { stylePrompt: stylePromptOf(style) });
    const image = await generateSubjectImage(plan.imagePrompt);
    const cut = await cutoutImage(image.dataUrl);
    return {
      name: plan.name,
      subjectType: plan.subjectType,
      species: plan.species,
      refined: plan.refined,
      imagePrompt: plan.imagePrompt,
      provider: image.provider,
      dataUrl: cut.dataUrl,
      transparentPct: cut.transparentPct,
      width: cut.width,
      height: cut.height,
      bbox: cut.bbox,
    };
  }
}
