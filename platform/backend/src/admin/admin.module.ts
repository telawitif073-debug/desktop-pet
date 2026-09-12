import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { PetsModule } from '../pets/pets.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [PetsModule, AgentsModule],
  controllers: [AdminController],
})
export class AdminModule {}