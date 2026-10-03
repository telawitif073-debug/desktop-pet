import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

/** 评价针对独立资源（宠物/智能体/音色）；动作随宠物，不单独评价 */
export type AssetType = 'pet' | 'agent' | 'voice';

@Entity('reviews')
@Index(['assetType', 'assetId'])
export class Review {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // PG enum 保留 'action' 值以避免 ALTER TYPE 迁移；'voice' 为音色板块（部署时 ALTER TYPE ADD VALUE）
  @Column({ name: 'asset_type', type: 'enum', enum: ['pet', 'agent', 'action', 'voice'] })
  assetType: AssetType;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId: string;

  @Column({ type: 'int', nullable: true })
  rating: number | null; // 1-5

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
