import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, isUUID } from 'class-validator';
import { ReviewsService } from './reviews.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { AssetType } from './review.entity';

class CreateReviewDto {
  // 通用评价入口只覆盖 agent / pet；voice 走 `POST /voices/:id/review` 自身路由
  @IsIn(['agent', 'pet'])
  assetType: AssetType;

  @IsUUID()
  assetId: string;

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

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get()
  list(
    @Query('assetType') assetType: AssetType,
    @Query('assetId') assetId: string,
  ) {
    // 入参必须显式校验：`asset_type` 现在是收窄过的枚举（agent/voice/pet），
    // 传旧值（如 'action'）或不合法 uuid 会被 Postgres 拒绝并冒成 500，而不是干净的 400。
    if (assetType !== 'agent' && assetType !== 'voice' && assetType !== 'pet') {
      throw new BadRequestException('资源类型必须是 agent / voice / pet');
    }
    if (!isUUID(assetId)) {
      throw new BadRequestException('assetId 必须是 uuid');
    }
    return this.reviewsService.listForAsset(assetType, assetId);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateReviewDto, @CurrentUser() user: User) {
    return this.reviewsService.upsertReview({
      userId: user.id,
      assetType: dto.assetType,
      assetId: dto.assetId,
      rating: dto.rating,
      comment: dto.comment,
    });
  }

  /** 当前用户下载过的资源列表（个人中心"已下载资源"板块） */
  @Get('downloads/mine')
  @UseGuards(JwtAuthGuard)
  myDownloads(@CurrentUser() user: User) {
    return this.reviewsService.listDownloaded(user.id);
  }

  /** 删除当前用户对某资源的下载记录（个人中心移除已下载资源） */
  @Delete('downloads/:assetType/:assetId')
  @UseGuards(JwtAuthGuard)
  removeDownload(
    @CurrentUser() user: User,
    @Param('assetType') assetType: AssetType,
    @Param('assetId') assetId: string,
  ) {
    if (assetType !== 'agent' && assetType !== 'voice' && assetType !== 'pet') {
      throw new BadRequestException('资源类型必须是 agent / voice / pet');
    }
    return this.reviewsService.deleteDownload(assetType, assetId, user.id);
  }
}
