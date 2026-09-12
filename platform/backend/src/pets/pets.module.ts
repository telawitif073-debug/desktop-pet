import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PetAsset } from './pet-asset.entity';
import { PetsService } from './pets.service';
import { PetsController } from './pets.controller';
import { ReviewsModule } from '../reviews/reviews.module';
import { StorageModule } from '../uploads/storage.module';

@Module({
  imports: [TypeOrmModule.forFeature([PetAsset]), ReviewsModule, StorageModule],
  providers: [PetsService],
  controllers: [PetsController],
  exports: [PetsService],
})
export class PetsModule {}
