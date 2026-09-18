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
import { PetAsset } from '../pets/pet-asset.entity';

/** 动作绑定的互动功能：安装后该动作在对应互动（喂食/休息/玩耍）时自动播放 */
export type ActionInteraction = 'none' | 'feed' | 'rest' | 'play';

/** 动作形态：frames=帧序列（1 帧即"改变造型的图片"，N>=2 为动画）；
 * clip=模型内嵌动画（Live2D motion 分组名 / 3D 动画 clip 名） */
export type ActionKind = 'frames' | 'clip';

/** 动作隶属于宠物资源（不可跨宠物使用），随宠物审核与安装 */
@Entity('action_assets')
@Index(['petId'])
export class ActionAsset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'pet_id', type: 'uuid' })
  petId: string;

  @ManyToOne(() => PetAsset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pet_id' })
  pet: PetAsset;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'author_id' })
  author: User;

  @Index()
  @Column({ type: 'enum', enum: ['none', 'feed', 'rest', 'play'], default: 'none' })
  interaction: ActionInteraction;

  @Column({ type: 'enum', enum: ['frames', 'clip'], default: 'frames' })
  kind: ActionKind;

  /** clip 动作的标识：Live2D motion 分组名 / 3D 动画 clip 名 */
  @Column({ name: 'clip_name', type: 'varchar', length: 100, nullable: true })
  clipName: string | null;

  @Column({ name: 'frame_count', type: 'int', default: 0 })
  frameCount: number;

  @Column({ name: 'file_url', type: 'varchar', length: 255 })
  fileUrl: string;

  @Column({ type: 'varchar', length: 20, default: '1.0.0' })
  version: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
