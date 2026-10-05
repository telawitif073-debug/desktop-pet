import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AgentsModule } from '../agents/agents.module';
import { VoicesModule } from '../voices/voices.module';

@Module({
  imports: [AgentsModule, VoicesModule],
  controllers: [AdminController],
})
export class AdminModule {}
