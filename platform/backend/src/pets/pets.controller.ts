import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { PetsService } from './pets.service';
import { CreatePetDto, ListPetsQueryDto, UpdatePetDto } from './dto/pet.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtOptionalGuard } from '../common/guards/jwt-optional.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { ReviewsService } from '../reviews/reviews.service';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { StorageService } from '../uploads/storage.service';
import { validateUploadMetadata, validateUploadFile } from '../uploads/upload-validation';
import { ActionsService } from '../actions/actions.service';
import { CreateActionDto, UpdateActionDto } from '../actions/dto/action.dto';

class PetReviewDto {
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

const uploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_MAX_SIZE || 52428800) },
  fileFilter: (_req: unknown, file: Express.Multer.File, cb: (error: Error | null, accept: boolean) => void) => {
    try { validateUploadMetadata(file.originalname, file.mimetype); cb(null, true); }
    catch (error) { cb(error as Error, false); }
  },
};

@Controller('pets')
export class PetsController {
  constructor(
    private readonly petsService: PetsService,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
    private readonly actionsService: ActionsService,
  ) {}

  @Get()
  @UseGuards(JwtOptionalGuard)
  list(@Query() query: ListPetsQueryDto, @CurrentUser() user: User | null) {
    return this.petsService.list({
      status: query.status,
      category: query.category,
      search: query.search,
      tags: query.tags,
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      isAdmin: user?.role === 'admin',
    });
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser() user: User) {
    return this.petsService.findMine(user.id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileFieldsInterceptor([
    { name: 'file', maxCount: 1 },
    { name: 'preview', maxCount: 1 },
    { name: 'background', maxCount: 1 },
    { name: 'actionFiles', maxCount: 15 },
  ], uploadOptions))
  async create(
    @Body() dto: CreatePetDto,
    @UploadedFiles() files: { file?: Express.Multer.File[]; preview?: Express.Multer.File[]; background?: Express.Multer.File[]; actionFiles?: Express.Multer.File[] },
    @CurrentUser() user: User,
  ) {
    const mainFile = files.file?.[0];
    if (!mainFile && !dto.fileUrl) throw new BadRequestException('必须上传资源文件');
    if (mainFile) {
      try { validateUploadFile(mainFile); } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : '资源文件校验失败');
      }
    }
    const fileUrl = dto.fileUrl ?? await this.storage.upload(mainFile!);

    // 形态判定：显式指定优先（Live2D 与多图包同为 zip，需前端选择）；否则 zip→pack、glb/gltf→model3d、其余（含 gif）→image
    const ext = mainFile ? path.extname(mainFile.originalname).toLowerCase() : '';
    const format = dto.format ?? (ext === '.zip' ? 'pack' : (ext === '.glb' || ext === '.gltf') ? 'model3d' : 'image');

    // 预览图：单独上传 preview 优先；image 形态回退主文件本身
    const previewFile = files.preview?.[0];
    const previewUrl = previewFile
      ? await this.storage.upload(previewFile)
      : (dto.previewUrl ?? (format === 'image' ? fileUrl : null));

    // 背景场景图：独立文件，与主体分开存储
    const backgroundFile = files.background?.[0];
    const backgroundUrl = backgroundFile ? await this.storage.upload(backgroundFile) : dto.backgroundUrl;

    const pet = await this.petsService.create({ ...dto, fileUrl, previewUrl: previewUrl ?? undefined, backgroundUrl, format }, user.id);

    // 附带动作：clipName 动作无需文件；frames 动作必须提供对应 zip（按下标对应 actionFiles）
    const metas = dto.actionsMeta ?? [];
    const actionFiles = files.actionFiles ?? [];
    if (metas.length > 15) throw new BadRequestException('附带动作最多 15 个');
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      if (meta.clipName) {
        await this.actionsService.createForPet(pet.id, meta, user.id, '');
        continue;
      }
      const actionFile = actionFiles[i];
      if (!actionFile) throw new BadRequestException(`动作「${meta.name}」缺少 zip 压缩包`);
      try { validateUploadFile(actionFile); } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : `动作「${meta.name}」文件校验失败`);
      }
      const actionUrl = await this.storage.upload(actionFile);
      await this.actionsService.createForPet(pet.id, meta, user.id, actionUrl);
    }
    return pet;
  }

  /** 宠物的动作清单（公开：商店详情展示 / 客户端安装拉取） */
  @Get(':id/actions')
  listActions(@Param('id') id: string) {
    return this.actionsService.listForPet(id);
  }

  /** 为宠物追加动作（作者/admin）：frames 需上传 zip，clip 填 clipName */
  @Post(':id/actions')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  async addAction(
    @Param('id') id: string,
    @Body() dto: CreateActionDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: User,
  ) {
    const pet = await this.petsService.findOneVisible(id, user.id, user.role === 'admin');
    if (pet.authorId !== user.id && user.role !== 'admin') throw new ForbiddenException('无权为该宠物添加动作');
    let fileUrl = '';
    if (!dto.clipName) {
      if (!file) throw new BadRequestException('必须上传动作帧图压缩包（zip），或填写 clipName');
      try { validateUploadFile(file); } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : '动作文件校验失败');
      }
      fileUrl = await this.storage.upload(file);
    }
    return this.actionsService.createForPet(id, dto, user.id, fileUrl);
  }

  @Put(':id/actions/:actionId')
  @UseGuards(JwtAuthGuard)
  updateAction(
    @Param('id') id: string,
    @Param('actionId') actionId: string,
    @Body() dto: UpdateActionDto,
    @CurrentUser() user: User,
  ) {
    return this.actionsService.update(id, actionId, dto, user.id, user.role === 'admin');
  }

  @Delete(':id/actions/:actionId')
  @UseGuards(JwtAuthGuard)
  removeAction(
    @Param('id') id: string,
    @Param('actionId') actionId: string,
    @CurrentUser() user: User,
  ) {
    return this.actionsService.remove(id, actionId, user.id, user.role === 'admin');
  }

  /** 动作文件下载地址（随宠物安装，不记独立下载统计） */
  @Post(':id/actions/:actionId/download')
  @UseGuards(JwtOptionalGuard)
  async downloadAction(@Param('id') id: string, @Param('actionId') actionId: string) {
    const actions = await this.actionsService.listForPet(id);
    const action = actions.find((item) => item.id === actionId);
    if (!action) throw new NotFoundException('动作不存在');
    return { url: action.fileUrl };
  }

  @Get(':id')
  @UseGuards(JwtOptionalGuard)
  findOne(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.petsService.findOneVisible(id, user?.id, user?.role === 'admin');
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id') id: string, @Body() dto: UpdatePetDto, @CurrentUser() user: User) {
    return this.petsService.update(id, dto, user.id, user.role === 'admin');
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.petsService.remove(id, user.id, user.role === 'admin');
  }

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  approve(@Param('id') id: string) {
    return this.petsService.updateStatus(id, 'approved');
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  reject(@Param('id') id: string) {
    return this.petsService.updateStatus(id, 'rejected');
  }

  @Post(':id/download')
  @UseGuards(JwtOptionalGuard)
  async download(@Param('id') id: string, @CurrentUser() user: User | null) {
    const pet = await this.petsService.findOneVisible(id, user?.id, user?.role === 'admin');
    if (pet.status !== 'approved') {
      throw new ForbiddenException('资源未通过审核');
    }
    await this.petsService.recordDownload(id, user?.id ?? null);
    return { url: pet.fileUrl, downloads: pet.downloads + 1 };
  }

  @Post(':id/review')
  @UseGuards(JwtAuthGuard)
  review(@Param('id') id: string, @Body() body: PetReviewDto, @CurrentUser() user: User) {
    return this.reviewsService.upsertReview({
      userId: user.id, assetType: 'pet', assetId: id, rating: body.rating, comment: body.comment,
    });
  }
}
