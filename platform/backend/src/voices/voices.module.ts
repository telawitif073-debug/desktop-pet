import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VoiceAsset } from './voice-asset.entity';
import { VoicesService } from './voices.service';
import { VoicesController } from './voices.controller';
import { ReviewsModule } from '../reviews/reviews.module';
import { StorageModule } from '../uploads/storage.module';

@Module({
  imports: [TypeOrmModule.forFeature([VoiceAsset]), ReviewsModule, StorageModule],
  providers: [VoicesService],
  controllers: [VoicesController],
  exports: [VoicesService],
})
export class VoicesModule {}
