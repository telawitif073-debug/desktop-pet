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
import { AssetType } from './review.entity';

@Entity('download_records')
@Index(['assetType', 'assetId'])
export class DownloadRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  // 'action' 为历史保留值；'pet' 指向 pet_packs（宠物包），由 migration 1791041000000 回补
  @Column({ name: 'asset_type', type: 'enum', enum: ['agent', 'action', 'voice', 'pet'] })
  assetType: AssetType;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId: string;

  @CreateDateColumn({ name: 'downloaded_at' })
  downloadedAt: Date;
}
