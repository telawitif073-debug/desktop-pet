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

/** 同步数据类别：客户端配置（含 LLM profiles）/ 宠物状态 / 聊天记录 */
export type SyncKind = 'config' | 'pet_state' | 'chat_history';

/** 用户云同步数据：每用户每类别一行，last-write-wins（updatedAt 判新旧） */
@Entity('user_sync_data')
@Index(['userId', 'kind'], { unique: true })
export class UserSyncData {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: ['config', 'pet_state', 'chat_history'] })
  kind: SyncKind;

  @Column({ type: 'jsonb' })
  data: unknown;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
