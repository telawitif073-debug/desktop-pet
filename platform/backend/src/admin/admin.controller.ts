import {
  BadRequestException,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AgentsService } from '../agents/agents.service';
import { PetsService } from '../pets/pets.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly petsService: PetsService,
    private readonly agentsService: AgentsService,
  ) {}

  @Post('approve/:type/:id')
  approve(@Param('type') type: string, @Param('id') id: string) {
    return this.updateStatus(type, id, 'approved');
  }

  @Post('reject/:type/:id')
  reject(@Param('type') type: string, @Param('id') id: string) {
    return this.updateStatus(type, id, 'rejected');
  }

  private updateStatus(
    type: string,
    id: string,
    status: 'approved' | 'rejected',
  ) {
    if (type !== 'pet' && type !== 'agent') {
      throw new BadRequestException('资源类型必须是 pet 或 agent');
    }

    return type === 'pet'
      ? this.petsService.updateStatus(id, status)
      : this.agentsService.updateStatus(id, status);
  }
}