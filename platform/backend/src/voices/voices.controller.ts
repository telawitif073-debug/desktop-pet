import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import * as path from 'path';
import { VoicesService } from './voices.service';
import { CreateVoiceDto, ListVoicesQueryDto, UpdateVoiceDto } from './dto/voice.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtOptionalGuard } from '../common/guards/jwt-optional.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { ReviewsService } from '../reviews/reviews.service';
import { StorageService } from '../uploads/storage.service';
import { validateUploadFile, validateUploadMetadata } from '../uploads/upload-validation';

const SAMPLE_EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/x-aac': '.aac',
};
const SAMPLE_ALLOWED_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac']);
const SAMPLE_MAX_BYTES = Number(process.env.VOICE_SAMPLE_MAX_SIZE || 5 * 1024 * 1024);

/** 服务端代拉试听样本：限 http(s)、5MB、魔数校验，返回可交给 StorageService 的伪 File */
async function fetchRemoteSample(urlStr: string): Promise<Express.Multer.File> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new BadRequestException('试听样本地址不是合法 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BadRequestException('试听样本地址仅支持 http(s)');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(urlStr, { signal: ctrl.signal, redirect: 'follow' });
  } catch {
    throw new BadRequestException('试听样本下载失败（网络错误）');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new BadRequestException(`试听样本下载失败 HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > SAMPLE_MAX_BYTES) throw new BadRequestException('试听样本超过 5MB');
  // 扩展名优先取 URL 路径，再按 content-type 推断
  let ext = path.extname(u.pathname).toLowerCase();
  const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!SAMPLE_ALLOWED_EXT.has(ext)) ext = SAMPLE_EXT_BY_MIME[ctype] ?? '';
  if (!ext) throw new BadRequestException('无法识别样本格式，链接需以 .mp3/.m4a/.aac/.wav 结尾或返回正确音频类型');
  // octet-stream 等宽松类型直接按扩展默认值，魔数校验兜底防伪
  const mimetype = ctype && ctype !== 'application/octet-stream' ? ctype : (
    ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/aac'
  );
  const pseudo = { originalname: `sample${ext}`, mimetype, buffer } as Express.Multer.File;
  validateUploadFile(pseudo);
  return pseudo;
}

class VoiceReviewDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  comment?: string;
}

@Controller('voices')
export class VoicesController {
  constructor(
    private readonly voicesService: VoicesService,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @UseGuards(JwtOptionalGuard)
  list(@Query() query: ListVoicesQueryDto, @CurrentUser() user: User | null) {
    return this.voicesService.list({
      status: query.search ? undefined : undefined,
      search: query.search,
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      isAdmin: user?.role === 'admin',
    });
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser() user: User) {
    return this.voicesService.findMine(user.id);
  }

  /**
   * 发布音色：multipart/form-data
   * - name/description/version 文本字段；config 为音色配置 JSON 字符串（必填）
   * - file：可选试听音频（mp3/m4a/wav）
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: Number(process.env.VOICE_SAMPLE_MAX_SIZE || 5 * 1024 * 1024) },
      fileFilter: (_req, file, cb) => {
        // 音色只允许音频；无文件时 multer 不会调用该过滤器
        try {
          const ext = validateUploadMetadata(file.originalname, file.mimetype);
          if (!['.mp3', '.m4a', '.wav', '.aac'].includes(ext)) {
            cb(new BadRequestException('试听仅支持 mp3 / m4a / aac / wav，单个不超过 5MB'), false);
            return;
          }
          cb(null, true);
        } catch (error) {
          cb(error as Error, false);
        }
      },
    }),
  )
  async create(@Body() dto: CreateVoiceDto, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: User) {
    if (!dto.configSchema || typeof dto.configSchema !== 'object' || Array.isArray(dto.configSchema)) {
      throw new BadRequestException('音色配置 config 为必填 JSON');
    }
    let sampleUrl: string | null = null;
    if (file) {
      sampleUrl = await this.storage.upload(file);
    } else if (dto.sampleUrl?.trim()) {
      // 无直传文件时服务端代拉样本直链（App 热更无法新增文件选择器，故用 URL 方式）
      const remote = await fetchRemoteSample(dto.sampleUrl.trim());
      sampleUrl = await this.storage.upload(remote);
    }
    return this.voicesService.create(dto, user.id, sampleUrl);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id') id: string, @Body() dto: UpdateVoiceDto, @CurrentUser() user: User) {
    return this.voicesService.update(id, dto, user.id, user.role === 'admin');
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.voicesService.remove(id, user.id, user.role === 'admin');
  }

  @Get(':id')
  @UseGuards(JwtOptionalGuard)
  findOne(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.voicesService.findOneVisible(id, user?.id, user?.role === 'admin');
  }

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  approve(@Param('id') id: string) {
    return this.voicesService.updateStatus(id, 'approved');
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  reject(@Param('id') id: string) {
    return this.voicesService.updateStatus(id, 'rejected');
  }

  /** 安装音色：计数并返回配置（配置本身不含 Key）与试听地址 */
  @Post(':id/download')
  @UseGuards(JwtOptionalGuard)
  async download(@Param('id') id: string, @CurrentUser() user: User | null) {
    const voice = await this.voicesService.findOneVisible(id, user?.id, user?.role === 'admin');
    if (voice.status !== 'approved') throw new ForbiddenException('音色未通过审核');
    await this.voicesService.recordDownload(id, user?.id ?? null);
    return {
      config: voice.configSchema,
      sampleUrl: voice.fileUrl,
      name: voice.name,
      version: voice.version,
      downloads: voice.downloads + 1,
    };
  }

  @Post(':id/review')
  @UseGuards(JwtAuthGuard)
  review(@Param('id') id: string, @Body() body: VoiceReviewDto, @CurrentUser() user: User) {
    return this.reviewsService.upsertReview({
      userId: user.id,
      assetType: 'voice',
      assetId: id,
      rating: body.rating,
      comment: body.comment,
    });
  }
}
