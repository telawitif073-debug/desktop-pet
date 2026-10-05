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
 * 宠物包（宠物商店的**唯一**分发单位）
 * ===========================================================================
 * 为什么是「包」而不是「一张图」（历史教训，改动前务必先读
 * `.trae/documents/pet-store-successor-design.md` §1.1）：
 * 旧的 `pet_assets` 把一只宠物定义成**单个 `file_url`**，于是无法表达
 * 「这是宠物本体」，只能靠文件名 glob 猜 → 图标/背景/键帽都能被当宠物装上。
 * 新标准（`src/pet/resource.ts` 的 `evaluatePetPack`）要求一个宠物必须是资源包，
 * 且包内**至少有一个「够格本体」**（body-model / body-animation / body-still），
 * 否则整个包判 invalid。
 *
 * 因此本表以 `pack_url`（zip）为唯一必填载体，并配套：
 *  - `pack_sha256`：完整性校验（下载/安装两侧都比对）；
 *  - `body_kinds`：**由服务端校验结果派生**（不是用户填的），可据此做
 *    「只看 Live2D / 只看像素动画」这类筛选；
 *  - `manifest`：校验时的清单快照，审核页与商店详情直接展示，无需重新解包；
 *  - `preview_url`：仅卡片图，**不参与本体判定**（避免重演「封面当宠物」）。
 *
 * 动作为包内 `pet/actions.json` 的一部分（见 `actionModel.ts` 的 v2 模型），
 * 刻意**不建动作表**——独立表会诱使「动作可脱离宠物存在」。
 */
export type PetPackBodyKind = 'body-model' | 'body-animation' | 'body-still';
export type PetPackStatus = 'pending' | 'approved' | 'rejected';

@Entity('pet_packs')
export class PetPack {
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
  category: string | null;

  @Column({ type: 'jsonb', default: [] })
  tags: string[];

  /** 宠物包 zip 的存放地址（商店唯一必填载体；单张图片不再是合法宠物） */
  @Column({ name: 'pack_url', type: 'varchar', length: 255 })
  packUrl: string;

  /** 包体 sha256（十六进制小写），下载与安装两侧都比对 */
  @Column({ name: 'pack_sha256', type: 'varchar', length: 64 })
  packSha256: string;

  @Column({ name: 'pack_bytes', type: 'integer', nullable: true })
  packBytes: number | null;

  /** 包格式版本：将来角色/结构升级时用于判定 `body_kinds` / `manifest` 是否需要重算 */
  @Column({ name: 'pack_schema_version', type: 'integer', default: 1 })
  packSchemaVersion: number;

  /** 服务端校验时的清单快照（pet/actions.json + 资源角色分类结果） */
  @Column({ type: 'jsonb', nullable: true })
  manifest: Record<string, unknown> | null;

  /** 包内合格本体类型（由 `evaluatePetPack` 结果派生，不是用户填的） */
  @Column({ name: 'body_kinds', type: 'text', array: true, default: () => "'{}'" })
  bodyKinds: PetPackBodyKind[];

  /** 商店卡片图（= 包内 body-cover，可选）。**不参与本体判定** */
  @Column({ name: 'preview_url', type: 'varchar', length: 255, nullable: true })
  previewUrl: string | null;

  @Column({ type: 'varchar', length: 20, default: '1.0.0' })
  version: string;

  @Column({ type: 'int', default: 0 })
  downloads: number;

  @Column({ type: 'float', default: 0 })
  rating: number;

  @Index()
  @Column({ type: 'enum', enum: ['pending', 'approved', 'rejected'], default: 'pending' })
  status: PetPackStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
