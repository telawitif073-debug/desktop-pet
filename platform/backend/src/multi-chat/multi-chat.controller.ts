import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { MultiChatService } from './multi-chat.service';

/**
 * 多智能体运行时 API：会话（幂等创建/列表）与消息发送（执行编排）。
 * 依赖：用户云同步 config 中的 LlmProfile.multiConfig（credentials 已解密）。
 */
@Controller('multi-chat')
@UseGuards(JwtAuthGuard)
export class MultiChatController {
  constructor(private readonly multiChat: MultiChatService) {}

  @Post('sessions')
  createSession(
    @CurrentUser() user: User,
    @Body() body: { agentProfileId?: string; title?: string },
  ) {
    return this.multiChat.ensureSession(user.id, body.agentProfileId ?? '', body.title);
  }

  @Get('sessions')
  listSessions(@CurrentUser() user: User) {
    return this.multiChat.listSessions(user.id);
  }

  @Get('sessions/:id/messages')
  listMessages(@CurrentUser() user: User, @Param('id') id: string) {
    return this.multiChat.listMessages(user.id, id);
  }

  @Post('sessions/:id/messages')
  sendMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: { content?: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> | null },
  ) {
    return this.multiChat.sendMessage(user.id, id, { content: body.content, history: body.history });
  }
}