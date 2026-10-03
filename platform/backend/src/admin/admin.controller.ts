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
import { PetPacksService } from '../pet-packs/pet-packs.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly voicesService: VoicesService,
    private readonly petPacksService: PetPacksService,
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
    // `type` 是**资源载体**名：agent → agent_assets、voice → voice_assets、pet_pack → pet_packs。
    // 注意与 reviews/download_records 的 `asset_type='pet'` 不同名——后者是评价域的
    // 资源类型（历史上就叫 pet），语义没变，故不随载体改名。
    if (type !== 'agent' && type !== 'voice' && type !== 'pet_pack') {
      throw new BadRequestException('资源类型必须是 agent / voice / pet_pack');
    }

    if (type === 'voice') return this.voicesService.updateStatus(id, status);
    if (type === 'pet_pack') return this.petPacksService.updateStatus(id, status);
    return this.agentsService.updateStatus(id, status);
  }
}