import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { PetsModule } from '../pets/pets.module';
import { AgentsModule } from '../agents/agents.module';
import { VoicesModule } from '../voices/voices.module';

@Module({
  imports: [PetsModule, AgentsModule, VoicesModule],
  controllers: [AdminController],
})
export class AdminModule {}
