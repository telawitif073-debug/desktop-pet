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

export type AssetStatus = 'pending' | 'approved' | 'rejected';

@Entity('pet_assets')
export class PetAsset {
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

  @Column({ type: 'varchar', length: 50, nullable: true })
  category: string | null; // 图片 / 动画 / 3D

  @Column({ type: 'jsonb', default: [] })
  tags: string[];

  @Column({ name: 'preview_url', type: 'varchar', length: 255, nullable: true })
  previewUrl: string | null;

  @Column({ name: 'file_url', type: 'varchar', length: 255 })
  fileUrl: string;

  @Column({ type: 'varchar', length: 20, default: '1.0.0' })
  version: string;

  @Column({ type: 'int', default: 0 })
  downloads: number;

  @Column({ type: 'float', default: 0 })
  rating: number;

  @Index()
  @Column({ type: 'enum', enum: ['pending', 'approved', 'rejected'], default: 'pending' })
  status: AssetStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
