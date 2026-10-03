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
 * 评价针对的独立资源类型。
 *  - `agent` → agent_assets，`voice` → voice_assets，`pet` → **pet_packs（宠物包）**；
 *  - `action` 为历史保留值（动作已并入宠物包内的 pet/actions.json，不再有独立资产表）。
 *
 * 注：`'pet'` 语义没变（载体从「单个文件」变成「包」），因此枚举值沿用旧名而非新造
 * `pet_pack`——跨端与历史数据的 `asset_type` 口径保持不变；
 * 在 migration 1791036000000 中被剔除后，由 1791041000000 回补。
 */
export type AssetType = 'agent' | 'action' | 'voice' | 'pet';

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

  // 'action' 为历史保留值；'pet' 指向 pet_packs（宠物包），由 migration 1791041000000 回补
  @Column({ name: 'asset_type', type: 'enum', enum: ['agent', 'action', 'voice', 'pet'] })
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
