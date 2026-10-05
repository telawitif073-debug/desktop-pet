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

/**
 * 评价针对的独立资源类型：`agent` → agent_assets，`voice` → voice_assets，
 * `pet` → pet_packs。
 * 注：宠物系统重建后讨论域资源类型**沿用历史名 `pet`**（与 admin 审核路由的载体名
 * `pet_pack` 刻意不同名，映射见 `pet-domain/api/limits.ts`）。
 * 迁移尚未补齐前，数据库枚举可能暂时与本声明不一致。
 */
export type AssetType = 'agent' | 'voice' | 'pet';

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

  @Column({ name: 'asset_type', type: 'enum', enum: ['agent', 'voice', 'pet'] })
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
