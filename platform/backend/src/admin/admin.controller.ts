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
import { VoicesService } from '../voices/voices.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly voicesService: VoicesService,
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
    // 旧宠物资源（pet）已随宠物功能域重建下线，不再是可审核的资源类型
    if (type !== 'agent' && type !== 'voice') {
      throw new BadRequestException('资源类型必须是 agent / voice');
    }

    if (type === 'voice') return this.voicesService.updateStatus(id, status);
    return this.agentsService.updateStatus(id, status);
  }
}