import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActionAsset } from './action-asset.entity';
import { PetAsset } from '../pets/pet-asset.entity';
import { ActionsService } from './actions.service';
import { StorageModule } from '../uploads/storage.module';

/** 动作作为宠物子资源：无独立控制器/审核/下载，接口由 PetsController 以 /pets/:id/actions 暴露 */
@Module({
  imports: [TypeOrmModule.forFeature([ActionAsset, PetAsset]), StorageModule],
  providers: [ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
