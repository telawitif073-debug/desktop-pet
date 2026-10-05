import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Review } from './review.entity';
import { DownloadRecord } from './download-record.entity';
import { AgentAsset } from '../agents/agent-asset.entity';
import { VoiceAsset } from '../voices/voice-asset.entity';
import { PetPack } from '../pet-packs/pet-pack.entity';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';

@Module({
  imports: [
    // 评价/下载记录是多态的：这里注册各资源实体，用于「资源是否存在」校验与评分回写
    TypeOrmModule.forFeature([Review, DownloadRecord, AgentAsset, VoiceAsset, PetPack]),
  ],
  providers: [ReviewsService],
  controllers: [ReviewsController],
  exports: [ReviewsService],
})
export class ReviewsModule {}
