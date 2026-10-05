import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PetPack, PetPackStatus } from './pet-pack.entity';
import { CreatePetPackDto, UpdatePetPackDto } from './dto/pet-pack.dto';
import { ReviewsService } from '../reviews/reviews.service';
import { StorageService } from '../uploads/storage.service';

/**
 * 宠物包（商店宠物板块）的读取、发布与管理。
 *
 * ⚠ 当前为**骨架**（Phase 1b）：方法签名与依赖已定型，实现留待后续阶段。
 * 每个未实现的方法一律 `throw new Error('pet: skeleton')`，避免误调用返回假数据。
 *
 * 发布走 {@link PetPacksService.create}：**上传即解包跑 `evaluatePetPack`**，
 * 不合格直接 400（设计文档 D3）。该路由当前**仅管理员可用**（先行用于内部/测试发布与联调）。
 */
@Injectable()
export class PetPacksService {
  constructor(
    @InjectRepository(PetPack)
    private readonly packsRepo: Repository<PetPack>,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
  ) {}

  /** 商店列表：普通用户恒定只看 approved，管理员可按 status 过滤 */
  async list(opts: {
    status?: PetPackStatus;
    search?: string;
    category?: string;
    bodyKind?: string;
    page?: number;
    limit?: number;
    sort?: 'downloads' | 'rating' | 'createdAt';
    isAdmin: boolean;
  }): Promise<{ items: PetPack[]; total: number; page: number; limit: number; totalPages: number }> {
    throw new Error('pet: skeleton');
  }

  /** 当前用户发布的宠物包 */
  findMine(authorId: string): Promise<PetPack[]> {
    throw new Error('pet: skeleton');
  }

  /** 按可见性读取单个宠物包（非 approved 仅 owner/admin 可见） */
  async findOneVisible(id: string, userId?: string, isAdmin = false): Promise<PetPack> {
    throw new Error('pet: skeleton');
  }

  /**
   * 发布宠物包（管理员先行）：校验解包 → 落盘 → 写库（status=pending）。
   * 派生字段（packUrl / packSha256 / packBytes / bodyKinds / manifest）由服务端校验结果写入。
   */
  async create(input: {
    file: Express.Multer.File;
    dto: CreatePetPackDto;
    authorId: string;
  }): Promise<PetPack> {
    throw new Error('pet: skeleton');
  }

  /** 更新宠物包元信息（派生字段不可改） */
  async update(id: string, dto: UpdatePetPackDto, userId: string, isAdmin: boolean) {
    throw new Error('pet: skeleton');
  }

  /** 删除宠物包并级联清理评价/下载记录与已上传文件 */
  async remove(id: string, userId: string, isAdmin: boolean) {
    throw new Error('pet: skeleton');
  }

  /** 审核状态流转（approve / reject） */
  async updateStatus(id: string, status: PetPackStatus): Promise<PetPack> {
    throw new Error('pet: skeleton');
  }

  /** 下载计数与下载记录 */
  async recordDownload(id: string, userId?: string | null) {
    throw new Error('pet: skeleton');
  }
}
