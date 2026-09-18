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

  // PG enum 保留 'action' 值以避免 ALTER TYPE 迁移，新数据不再写入该值（动作随宠物下载）
  @Column({ name: 'asset_type', type: 'enum', enum: ['pet', 'agent', 'action'] })
  assetType: AssetType;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId: string;

  @CreateDateColumn({ name: 'downloaded_at' })
  downloadedAt: Date;
}
