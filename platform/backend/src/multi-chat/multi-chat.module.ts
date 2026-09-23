import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MultiAgentSession } from './multi-agent-session.entity';
import { MultiAgentMessage } from './multi-agent-message.entity';
import { MultiChatService } from './multi-chat.service';
import { MultiChatController } from './multi-chat.controller';
import { SyncModule } from '../sync/sync.module';

/** 多智能体运行时编排：会话表 + 编排服务 + REST 接口 */
@Module({
  imports: [TypeOrmModule.forFeature([MultiAgentSession, MultiAgentMessage]), SyncModule],
  controllers: [MultiChatController],
  providers: [MultiChatService],
})
export class MultiChatModule {}