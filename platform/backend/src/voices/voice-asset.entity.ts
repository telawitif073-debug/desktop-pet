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

/**
 * 音色资产（商店「音色」板块）：
 * - configSchema = 音色配置（provider/voiceId/model/baseUrl/httpUrl/rate/pitch/guide 等），
 *   不含任何 API Key（Key 由安装者在本机填写，避免发布者凭证泄漏）
 * - fileUrl = 可选试听音频（mp3/m4a/wav），发布者上传；为空则安装后用本机配置现场试听
 */
@Entity('voice_assets')
export class VoiceAsset {
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

  @Column({ name: 'config_schema', type: 'jsonb' })
  configSchema: Record<string, unknown>;

  /** 试听音频（可空） */
  @Column({ name: 'file_url', type: 'varchar', length: 255, nullable: true })
  fileUrl: string | null;

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
