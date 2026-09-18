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

/** 宠物资源形态：image=单张图片（含 GIF 动图），pack=多图模型包（zip），
 * live2d=Live2D 模型包（zip 含 model3.json），model3d=3D 模型（glb/gltf） */
export type PetFormat = 'image' | 'pack' | 'live2d' | 'model3d' | 'sprite';

@Entity('pet_assets')
export class PetAsset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Index()
  @Column({ type: 'enum', enum: ['image', 'pack', 'live2d', 'model3d', 'sprite'], default: 'image' })
  format: PetFormat;

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

  /** 可选背景场景图（与主体分开的独立文件，桌宠窗口背景） */
  @Column({ name: 'background_url', type: 'varchar', length: 255, nullable: true })
  backgroundUrl: string | null;

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
