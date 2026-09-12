import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
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
import { validateUploadMetadata } from '../uploads/upload-validation';

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

@Controller('pets')
export class PetsController {
  constructor(
    private readonly petsService: PetsService,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
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
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: Number(process.env.UPLOAD_MAX_SIZE || 52428800) },
    fileFilter: (_req, file, cb) => {
      try { validateUploadMetadata(file.originalname, file.mimetype); cb(null, true); }
      catch (error) { cb(error as Error, false); }
    },
  }))
  async create(@Body() dto: CreatePetDto, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: User) {
    if (!file && !dto.fileUrl) throw new BadRequestException('必须上传资源文件');
    const fileUrl = dto.fileUrl ?? await this.storage.upload(file);
    return this.petsService.create({ ...dto, fileUrl }, user.id);
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
