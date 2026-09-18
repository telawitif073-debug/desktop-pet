import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AiService } from './ai.service';
import { PAINT_STYLES } from './prompt-agent';
import { startSpritePetJob } from './sprite-pipeline';
import { startLive2dPetJob, live2dCapability } from './live2d-pipeline';
import { getJob } from './jobs';
import { dashscopeKey } from './dashscope';

const STYLE_IDS = PAINT_STYLES.map((s) => s.id);

class BaseImageDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  description!: string;

  /** 画风（须在 GET /ai/meta 返回的 styles 内，默认可爱） */
  @IsOptional()
  @IsIn(STYLE_IDS)
  style?: string;
}

/** AI 生成接口：基准图（路径A 精灵表 / 路径B Live2D 的共用起点）与后续精灵表流水线 */
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /** 可选项元数据：画风列表 + 各能力 Key 配置状态（前端下拉与可用性提示） */
  @Get('meta')
  getMeta() {
    return this.aiService.getMeta();
  }

  /** 基准图链路：描述 → 细化 → 出图 → 抠图，返回透明 PNG 立绘（dataUrl）与元数据 */
  @Post('base-image')
  async baseImage(@Body() dto: BaseImageDto) {
    return this.aiService.baseImage(dto.description, dto.style);
  }

  /** 路径A 精灵表生成：异步任务，立即返回 jobId（前端轮询 GET /ai/jobs/:id） */
  @Post('sprite-pet')
  spritePet(@Body() dto: BaseImageDto) {
    if (!dashscopeKey()) throw new BadRequestException('后端未配置 DASHSCOPE_API_KEY，无法使用图生视频生成精灵表');
    const job = startSpritePetJob(dto.description, dto.style);
    return { jobId: job.id };
  }

  /** 路径B Live2D 生成：See-through 拆层 + PSD2Live 建模（本机外部工具），异步任务 */
  @Post('live2d-pet')
  live2dPet(@Body() dto: BaseImageDto) {
    const cap = live2dCapability();
    if (!cap.ok) throw new BadRequestException(cap.error);
    const job = startLive2dPetJob(dto.description, dto.style);
    return { jobId: job.id };
  }

  /** 任务进度/结果轮询 */
  @Get('jobs/:id')
  job(@Param('id') id: string) {
    const job = getJob(id);
    if (!job) throw new NotFoundException('任务不存在或已过期');
    return job;
  }
}
