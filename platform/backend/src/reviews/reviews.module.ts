import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Review } from './review.entity';
import { DownloadRecord } from './download-record.entity';
import { PetAsset } from '../pets/pet-asset.entity';
import { AgentAsset } from '../agents/agent-asset.entity';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Review, DownloadRecord, PetAsset, AgentAsset]),
  ],
  providers: [ReviewsService],
  controllers: [ReviewsController],
  exports: [ReviewsService],
})
export class ReviewsModule {}
