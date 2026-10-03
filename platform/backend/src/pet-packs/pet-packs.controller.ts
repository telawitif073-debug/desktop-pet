import {
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
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PetPacksService } from './pet-packs.service';
import { ListPetPacksQueryDto, UpdatePetPackDto } from './dto/pet-pack.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtOptionalGuard } from '../common/guards/jwt-optional.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { ReviewsService } from '../reviews/reviews.service';

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
 * ⚠️ 刻意**没有 POST /**（发布）：发布必须先在服务端解包跑 `evaluatePetPack` 并
 * 对不合格包直接拒绝（设计文档 D3），该能力属实施清单第 3 步。在此之前不开放发布入口，
 * 以免重演旧 `pet_assets` 「一张图也能当宠物」的缺陷。
 */
@Controller('pet-packs')
export class PetPacksController {
  constructor(
    private readonly petPacksService: PetPacksService,
    private readonly reviewsService: ReviewsService,
  ) {}

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
