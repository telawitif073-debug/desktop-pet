import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsDefined } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { SyncService } from './sync.service';

class SyncDataDto {
  // data 形态随 kind 而异：config/pet_state 为对象，chat_history 为数组（空数组=清空语义）
  @IsDefined()
  data!: unknown;
}

/** 用户数据云同步：桌面端与手机端共用，登录后拉取、本地变更上传 */
@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('config')
  getConfig(@CurrentUser() user: User) {
    return this.syncService.getKind(user.id, 'config');
  }

  @Put('config')
  putConfig(@CurrentUser() user: User, @Body() dto: SyncDataDto) {
    return this.syncService.putKind(user.id, 'config', dto.data);
  }

  @Get('pet-state')
  getPetState(@CurrentUser() user: User) {
    return this.syncService.getKind(user.id, 'pet_state');
  }

  @Put('pet-state')
  putPetState(@CurrentUser() user: User, @Body() dto: SyncDataDto) {
    return this.syncService.putKind(user.id, 'pet_state', dto.data);
  }

  @Get('chat-history')
  getChatHistory(@CurrentUser() user: User) {
    return this.syncService.getKind(user.id, 'chat_history');
  }

  @Put('chat-history')
  putChatHistory(@CurrentUser() user: User, @Body() dto: SyncDataDto) {
    return this.syncService.putKind(user.id, 'chat_history', dto.data);
  }

  @Get('library')
  getLibrary(@CurrentUser() user: User) {
    return this.syncService.getLibrary(user.id);
  }
}
