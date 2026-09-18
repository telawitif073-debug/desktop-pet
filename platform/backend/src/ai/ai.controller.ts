import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AiService, PET_STYLES, type PetGenFormat } from './ai.service';
import { runPaintingAgent, PAINT_STYLE_PROMPTS, type PaintFraming } from './painting-agent';
import { cutoutImage, type CutoutResult } from './cutout-agent';
import { runDetectAgent, type DetectResult } from './detect-agent';

const FORMATS: PetGenFormat[] = ['image', 'gif', 'live2d', 'model3d'];
const STYLE_IDS = PET_STYLES.map((s) => s.id);

class GeneratePetDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  description!: string;

  /** 生成形态：image/gif/live2d/model3d，默认 image */
  @IsOptional()
  @IsIn(FORMATS)
  format?: PetGenFormat;

  /** AI 模型（须在 GET /ai/meta 返回的注册表内；未注册回退各形态默认模型） */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  /** 风格（须在 PET_STYLES 内，默认可爱） */
  @IsOptional()
  @IsIn(STYLE_IDS)
  style?: string;

  /** 分步流程：细化描述（优先拼入 description 之前，原描述作参照） */
  @IsOptional()
  @IsString()
  @MaxLength(800)
  refined?: string;
}

/** AI 精绘：图像生成模型（CogView）绘制成品插画，与 Canvas 几何拼图形态区分 */
class GeneratePetImageDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  description!: string;

  /** 图像生成模型（默认 cogview-3-flash，可用 AI_IMAGE_MODEL 覆盖） */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  /** 风格（须在 PET_STYLES 内，默认可爱） */
  @IsOptional()
  @IsIn(STYLE_IDS)
  style?: string;

  /** 分步流程：细化描述（优先作为绘画主题，原描述作参照） */
  @IsOptional()
  @IsString()
  @MaxLength(800)
  refined?: string;

  /** 绘制目标：subject=宠物主体（默认，纯色简洁背景）；scene=背景场景（无角色，独立文件） */
  @IsOptional()
  @IsIn(['subject', 'scene'])
  kind?: 'subject' | 'scene';

  /** 绘图智能体产出的最终绘画提示词（优先于本地拼装；由 POST /ai/painting-agent 获得） */
  @IsOptional()
  @IsString()
  @MaxLength(900)
  imagePrompt?: string;

  /** 构图：full=全身（默认） half=半身（仅本地兜底拼装时使用） */
  @IsOptional()
  @IsIn(['full', 'half'])
  framing?: PaintFraming;
}

/** AI 精绘绘图智能体（painting-agent.ts，讯飞星火驱动）：描述 → 主体类型判别 + 细化 + 最终绘画提示词 */
class PaintingAgentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  description!: string;

  /** 构图：full=全身（默认） half=半身 */
  @IsOptional()
  @IsIn(['full', 'half'])
  framing?: PaintFraming;

  /** 风格（须在 PET_STYLES 内） */
  @IsOptional()
  @IsIn(STYLE_IDS)
  style?: string;

  /** 分步流程：用户确认后的细化文案（优先作为细化基础） */
  @IsOptional()
  @IsString()
  @MaxLength(800)
  refined?: string;
}

/** AI 精绘·生成智能体（painting-agent + CogView 内部编排）：一步产出符合要求的原始立绘资源 */
class PaintingResourceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  description!: string;

  /** 构图：full=全身（默认） half=半身 */
  @IsOptional()
  @IsIn(['full', 'half'])
  framing?: PaintFraming;

  /** 风格（须在 PET_STYLES 内） */
  @IsOptional()
  @IsIn(STYLE_IDS)
  style?: string;

  /** 分步流程：用户确认后的细化文案（优先作为细化基础） */
  @IsOptional()
  @IsString()
  @MaxLength(800)
  refined?: string;
}

/** AI 精绘·抠图智能体：入参为 CogView 原始立绘 dataUrl（1024 图 base64 约 1-2MB） */
class CutoutAgentDto {
  @IsString()
  @MinLength(32)
  @MaxLength(12_000_000)
  image!: string;
}

/** 分步生成步骤一：细化描述并识别物种 */
class RefinePetDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  description!: string;

  /** AI 模型（须在 GET /ai/meta 返回的注册表内） */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  /** 风格（须在 PET_STYLES 内，默认可爱） */
  @IsOptional()
  @IsIn(STYLE_IDS)
  style?: string;
}

/** AI 生成接口：文字描述 → 宠物形象参数（各形态由前端程序化生成资源后走上传流程） */
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /** 可选项元数据：按提供商分组的模型列表（含 Key 配置状态）+ 风格列表（前端下拉选项） */
  @Get('meta')
  getMeta() {
    return {
      providers: this.aiService.listModels(),
      styles: PET_STYLES.map(({ id, label }) => ({ id, label })),
    };
  }

  @Post('generate-pet')
  async generatePet(@Body() dto: GeneratePetDto) {
    const result = await this.aiService.generatePetDesign(
      dto.description,
      dto.format ?? 'image',
      dto.model,
      dto.style,
      dto.refined,
    );
    return result;
  }

  /** 分步生成步骤一：细化描述 + 识别物种 + 确认问题 + 形象参数初稿（生成成品仍走 generate-pet，refined 传回） */
  @Post('refine-pet')
  async refinePet(@Body() dto: RefinePetDto) {
    return this.aiService.refinePetDesign(dto.description, dto.model, dto.style);
  }

  /** AI 精绘：图像生成模型绘制成品插画，返回 { url, prompt, dataUrl }（dataUrl 供前端直接展示/转文件上传） */
  @Post('generate-pet-image')
  async generatePetImage(@Body() dto: GeneratePetImageDto) {
    return this.aiService.generatePetImage(
      dto.description,
      dto.model,
      dto.style,
      dto.refined,
      dto.kind ?? 'subject',
      dto.imagePrompt,
      dto.framing ?? 'full',
    );
  }

  /** AI 精绘绘图智能体（讯飞星火）：返回 { name, subjectType, species, refined, imagePrompt }，imagePrompt 随 generate-pet-image 传回 */
  @Post('painting-agent')
  async paintingAgent(@Body() dto: PaintingAgentDto) {
    return runPaintingAgent(dto.description, {
      framing: dto.framing ?? 'full',
      stylePrompt: dto.style ? PAINT_STYLE_PROMPTS[dto.style] : undefined,
      refined: dto.refined,
    });
  }

  /**
   * AI 精绘·生成智能体（完整链路编排）：生成智能体（painting-agent + CogView）→ 检测智能体验收原图 →
   * 抠图智能体去背 → 检测智能体验收成品。任一环节不合格把 issues 反馈给绘图智能体自动重试
   * （最多 3 轮；全部不合格时返回末稿并附检测报告，不抛错）。dataUrl 为透明 PNG 成品。
   */
  @Post('painting-resource')
  async paintingResource(@Body() dto: PaintingResourceDto) {
    const framing: PaintFraming = dto.framing ?? 'full';
    const stylePrompt = dto.style ? PAINT_STYLE_PROMPTS[dto.style] : undefined;
    const MAX_ATTEMPTS = 3;
    let corrections: string[] = [];
    let agent = await runPaintingAgent(dto.description, { framing, stylePrompt, refined: dto.refined });
    let image = await this.aiService.generatePetImage(dto.description, undefined, dto.style, agent.refined, 'subject', agent.imagePrompt, framing);
    let detectGenerated: DetectResult = { pass: true, skipped: true, issues: [], checks: {} };
    let detectCutout: DetectResult = { pass: true, skipped: true, issues: [], checks: {} };
    let cut: CutoutResult = { dataUrl: image.dataUrl, tolerance: 0, transparentPct: 0 };
    let attempts = 1;

    for (; attempts <= MAX_ATTEMPTS; attempts += 1) {
      // 检测一：原始立绘验收（单主体/构图/朝向/纯色平涂/无水印/留边）
      detectGenerated = await runDetectAgent('generated', image.dataUrl, { framing });
      if (!detectGenerated.pass) {
        corrections = detectGenerated.issues;
        if (attempts >= MAX_ATTEMPTS) break;
        agent = await runPaintingAgent(dto.description, { framing, stylePrompt, refined: dto.refined, corrections });
        image = await this.aiService.generatePetImage(dto.description, undefined, dto.style, agent.refined, 'subject', agent.imagePrompt, framing);
        continue;
      }
      // 检测二：透明成品验收（无残留/主体完整/无水印/边缘干净）
      cut = await cutoutImage(image.dataUrl);
      detectCutout = await runDetectAgent('cutout', cut.dataUrl, { transparentPct: cut.transparentPct });
      if (detectCutout.pass) break;
      corrections = detectCutout.issues;
      if (attempts >= MAX_ATTEMPTS) break;
      agent = await runPaintingAgent(dto.description, { framing, stylePrompt, refined: dto.refined, corrections });
      image = await this.aiService.generatePetImage(dto.description, undefined, dto.style, agent.refined, 'subject', agent.imagePrompt, framing);
    }

    return {
      name: agent.name,
      subjectType: agent.subjectType,
      species: agent.species,
      refined: agent.refined,
      imagePrompt: agent.imagePrompt,
      dataUrl: cut.dataUrl,
      tolerance: cut.tolerance,
      transparentPct: cut.transparentPct,
      detect: { generated: detectGenerated, cutout: detectCutout },
      attempts,
    };
  }

  /** AI 精绘·抠图智能体（两段链路第二段）：接收纯白底原始立绘 dataUrl，服务端洪泛去背返回透明 PNG（带自检重试） */
  @Post('cutout-agent')
  async cutoutAgent(@Body() dto: CutoutAgentDto) {
    return cutoutImage(dto.image);
  }
}
