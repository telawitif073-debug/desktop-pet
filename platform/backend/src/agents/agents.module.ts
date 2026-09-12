import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentAsset } from './agent-asset.entity';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';
import { ReviewsModule } from '../reviews/reviews.module';
import { StorageModule } from '../uploads/storage.module';

@Module({
  imports: [TypeOrmModule.forFeature([AgentAsset]), ReviewsModule, StorageModule],
  providers: [AgentsService],
  controllers: [AgentsController],
  exports: [AgentsService],
})
export class AgentsModule {}
