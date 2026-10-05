import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PetPack } from './pet-pack.entity';
import { PetPacksService } from './pet-packs.service';
import { PetPacksController } from './pet-packs.controller';
import { ReviewsModule } from '../reviews/reviews.module';
import { StorageModule } from '../uploads/storage.module';

@Module({
  imports: [TypeOrmModule.forFeature([PetPack]), ReviewsModule, StorageModule],
  providers: [PetPacksService],
  controllers: [PetPacksController],
  exports: [PetPacksService],
})
export class PetPacksModule {}
