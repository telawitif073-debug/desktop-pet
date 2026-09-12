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

export type AgentType = 'chat' | 'task' | 'mixed';

@Entity('agent_assets')
export class AgentAsset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'author_id' })
  author: User;

  @Column({ type: 'enum', enum: ['chat', 'task', 'mixed'], default: 'chat' })
  type: AgentType; // 对话 / 任务 / 混合

  @Column({ name: 'config_schema', type: 'jsonb', nullable: true })
  configSchema: Record<string, unknown> | null;

  @Column({ type: 'jsonb', default: [] })
  dependencies: string[];

  @Column({ name: 'file_url', type: 'varchar', length: 255 })
  fileUrl: string;

  @Column({ name: 'preview_url', type: 'varchar', length: 255, nullable: true })
  previewUrl: string | null;

  @Column({ type: 'varchar', length: 20, default: '1.0.0' })
  version: string;

  @Column({ type: 'int', default: 0 })
  downloads: number;

  @Column({ type: 'float', default: 0 })
  rating: number;

  @Index()
  @Column({ type: 'enum', enum: ['pending', 'approved', 'rejected'], default: 'pending' })
  status: 'pending' | 'approved' | 'rejected';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
