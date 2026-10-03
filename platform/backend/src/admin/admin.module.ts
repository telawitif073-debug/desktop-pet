import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AgentsModule } from '../agents/agents.module';
import { VoicesModule } from '../voices/voices.module';
import { PetPacksModule } from '../pet-packs/pet-packs.module';

@Module({
  imports: [AgentsModule, VoicesModule, PetPacksModule],
  controllers: [AdminController],
})
export class AdminModule {}
