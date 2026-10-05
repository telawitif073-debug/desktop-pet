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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PetPacksService } from './pet-packs.service';
import { CreatePetPackDto, ListPetPacksQueryDto, UpdatePetPackDto } from './dto/pet-pack.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtOptionalGuard } from '../common/guards/jwt-optional.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { ReviewsService } from '../reviews/reviews.service';
import { PET_PACK_MAX_BYTES } from './pack-inspection';
import { validateUploadMetadata } from '../uploads/upload-validation';

class PetPackReviewDto {
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

/**
 * 宠物商店（宠物包）接口。
 *
 * 发布（`POST /pet-packs`）当前**仅管理员可用**（先行用于内部/测试发布与真实包联调）：
 * 它必须在服务端解包跑 `evaluatePetPack`（设计文档 D3），不合格直接 400 —— 避免重演旧
 * `pet_assets`「一张图也能当宠物」的缺陷。等桌面端 pack 流程（第 4 步）就绪后再放开给普通用户。
 */
@Controller('pet-packs')
export class PetPacksController {
  constructor(
    private readonly petPacksService: PetPacksService,
    private readonly reviewsService: ReviewsService,
  ) {}

  /**
   * 发布宠物包（管理员）。
   * multipart：`pack`（必填 .zip）、`preview`（可选卡片图）、文本字段见 {@link CreatePetPackDto}。
   * 校验不通过 → 400（响应体含 `errors` / `rejected`）；通过 → 落库 `status=pending`。
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'pack', maxCount: 1 },
        { name: 'preview', maxCount: 1 },
      ],
      {
        storage: memoryStorage(),
        limits: { fileSize: PET_PACK_MAX_BYTES, files: 2 },
        fileFilter: (_req, file, cb) => {
          try {
            if (file.fieldname === 'pack') {
              if (path.extname(file.originalname).toLowerCase() !== '.zip') {
                throw new BadRequestException('宠物包必须是 .zip 压缩包');
              }
            } else {
              validateUploadMetadata(file.originalname, file.mimetype);
            }
            cb(null, true);
          } catch (error) {
            cb(error as Error, false);
          }
        },
      },
    ),
  )
  publish(
    @UploadedFiles() files: { pack?: Express.Multer.File[]; preview?: Express.Multer.File[] },
    @Body() dto: CreatePetPackDto,
    @CurrentUser() user: User,
  ) {
    const pack = files?.pack?.[0];
    if (!pack) throw new BadRequestException('未收到宠物包文件（字段名 pack）');
    return this.petPacksService.publish({ pack, preview: files?.preview?.[0], dto, authorId: user.id });
  }

  @Get()
  @UseGuards(JwtOptionalGuard)
  list(@Query() query: ListPetPacksQueryDto, @CurrentUser() user: User | null) {
    return this.petPacksService.list({
      status: query.status,
      search: query.search,
      category: query.category,
      bodyKind: query.bodyKind,
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      isAdmin: user?.role === 'admin',
    });
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser() user: User) {
    return this.petPacksService.findMine(user.id);
  }

  @Get(':id')
  @UseGuards(JwtOptionalGuard)
  findOne(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.petPacksService.findOneVisible(id, user?.id, user?.role === 'admin');
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id') id: string, @Body() dto: UpdatePetPackDto, @CurrentUser() user: User) {
    return this.petPacksService.update(id, dto, user.id, user.role === 'admin');
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.petPacksService.remove(id, user.id, user.role === 'admin');
  }

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  approve(@Param('id') id: string) {
    return this.petPacksService.updateStatus(id, 'approved');
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  reject(@Param('id') id: string) {
    return this.petPacksService.updateStatus(id, 'rejected');
  }

  /**
   * 下载：返回包地址与 `sha256`。安装侧必须比对 `sha256` **并再次跑 `evaluatePetPack`**
   * （不信任服务端）——服务端校验是商店门禁，客户端校验是本机安全边界。
   */
  @Post(':id/download')
  @UseGuards(JwtOptionalGuard)
  async download(@Param('id') id: string, @CurrentUser() user: User | null) {
    const pack = await this.petPacksService.findOneVisible(id, user?.id, user?.role === 'admin');
    if (pack.status !== 'approved') throw new ForbiddenException('宠物包未通过审核');
    await this.petPacksService.recordDownload(id, user?.id ?? null);
    return {
      url: pack.packUrl,
      sha256: pack.packSha256,
      bytes: pack.packBytes,
      version: pack.version,
      downloads: pack.downloads + 1,
    };
  }

  @Post(':id/review')
  @UseGuards(JwtAuthGuard)
  review(@Param('id') id: string, @Body() body: PetPackReviewDto, @CurrentUser() user: User) {
    return this.reviewsService.upsertReview({
      userId: user.id, assetType: 'pet', assetId: id, rating: body.rating, comment: body.comment,
    });
  }
}
