import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ReviewsService } from './reviews.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { AssetType } from './review.entity';

class CreateReviewDto {
  @IsIn(['pet', 'agent'])
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
}
