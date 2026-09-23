import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

/** 多智能体协同会话：每个用户 × 智能体档案一条（幂等复用），消息存放于 multi_agent_messages */
@Entity('multi_agent_sessions')
@Index(['ownerId', 'agentProfileId'])
export class MultiAgentSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: User;

  /** 对应 llmProfiles 中的智能体档案 id（其 multiConfig 决定编排行为） */
  @Column({ name: 'agent_profile_id', type: 'text' })
  agentProfileId: string;

  @Column({ type: 'text', default: '' })
  title: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}