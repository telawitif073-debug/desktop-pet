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

export type AssetType = 'pet' | 'agent';

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

  @Column({ name: 'asset_type', type: 'enum', enum: ['pet', 'agent'] })
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
