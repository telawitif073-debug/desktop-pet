import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSyncData } from './user-sync-data.entity';
import { DownloadRecord } from '../reviews/download-record.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [TypeOrmModule.forFeature([UserSyncData, DownloadRecord])],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
