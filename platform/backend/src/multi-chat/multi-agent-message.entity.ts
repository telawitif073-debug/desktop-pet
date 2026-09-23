import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MultiAgentSession } from './multi-agent-session.entity';

/**
 * 多智能体会话消息：记录每次编排的用户输入与最终输出；
 * meta 存协同轨迹（谁调用了谁、输入输出片段、耗时、错误），不存密钥。
 */
@Entity('multi_agent_messages')
@Index(['sessionId'])
export class MultiAgentMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

  @ManyToOne(() => MultiAgentSession, (s) => s.id, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'session_id' })
  session: MultiAgentSession;

  @Column({ type: 'text' })
  role: 'user' | 'assistant';

  /** 子智能体 id（assistant 由哪个 agent 产出；为空表示编排器/汇总模型） */
  @Column({ name: 'agent_id', type: 'text', nullable: true })
  agentId: string | null;

  @Column({ type: 'text', default: '' })
  content: string;

  @Column({ name: 'latency_ms', type: 'integer', nullable: true })
  latencyMs: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  /** 协同轨迹（trace 数组），见 multi-chat.service.ts TraceItem */
  @Column({ type: 'jsonb', nullable: true })
  meta: unknown | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}