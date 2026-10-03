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

/** 评价针对独立资源（智能体/音色）；动作与旧宠物资源已随宠物功能域重建下线 */
export type AssetType = 'agent' | 'action' | 'voice';

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

  // 'action' 为历史保留值；'pet' 已由 migration 1791036000000 从枚举中剔除
  @Column({ name: 'asset_type', type: 'enum', enum: ['agent', 'action', 'voice'] })
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
