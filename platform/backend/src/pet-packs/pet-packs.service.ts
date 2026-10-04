import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { PetPack, PetPackStatus } from './pet-pack.entity';
import { CreatePetPackDto, UpdatePetPackDto } from './dto/pet-pack.dto';
import { ReviewsService } from '../reviews/reviews.service';
import { StorageService } from '../uploads/storage.service';
import { PET_PACK_SCHEMA_VERSION, validatePetPackFile } from './pack-inspection';

/** 标签解析：multipart 只有字符串，兼容 JSON 数组与逗号分隔两种写法 */
function parseTags(raw?: string): string[] {
  if (!raw) return [];
  const text = raw.trim();
  if (text.startsWith('[')) {
    try {
      const value = JSON.parse(text);
      if (Array.isArray(value)) {
        return value.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 20);
      }
    } catch {
      /* 落到逗号分隔 */
    }
  }
  return text.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

/**
 * 宠物包（商店宠物板块）的读取、发布与管理。
 *
 * 发布走 {@link PetPacksService.publish}：**上传即解包跑 `evaluatePetPack`**，
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

  /**
   * 发布宠物包（管理员先行）。步骤：
   *  1. 语义校验（{@link validatePetPackFile}：字节级安全校验 + 包内本体判定）；
   *     不合格抛 400 —— 此时**尚未落盘**，无需清理；
   *  2. 落盘包体与可选封面，写 `pet_packs`（`status=pending`，`sha256`/`body_kinds`/`manifest` 全部派生）；
   *  3. 任一步失败回滚已上传文件，避免孤儿文件。
   */
  async publish(input: {
    pack: Express.Multer.File;
    preview?: Express.Multer.File;
    dto: CreatePetPackDto;
    authorId: string;
  }): Promise<PetPack> {
    const { pack, preview, dto, authorId } = input;
    const inspection = validatePetPackFile(pack);

    let packUrl: string | null = null;
    let previewUrl: string | null = null;
    try {
      packUrl = await this.storage.upload(pack);
      if (preview) previewUrl = await this.storage.upload(preview);
      const entity = this.packsRepo.create({
        name: dto.name,
        description: dto.description ?? null,
        category: dto.category ?? null,
        tags: parseTags(dto.tags),
        authorId,
        packUrl,
        packSha256: inspection.sha256,
        packBytes: inspection.bytes,
        packSchemaVersion: PET_PACK_SCHEMA_VERSION,
        manifest: inspection.manifest as unknown as Record<string, unknown>,
        bodyKinds: inspection.bodyKinds,
        previewUrl,
        version: dto.version ?? '1.0.0',
        status: 'pending',
      });
      return await this.packsRepo.save(entity);
    } catch (error) {
      await Promise.allSettled([this.storage.remove(packUrl), this.storage.remove(previewUrl)]);
      throw error;
    }
  }

  async list(opts: {
    status?: PetPackStatus;
    search?: string;
    category?: string;
    bodyKind?: string;
    page?: number;
    limit?: number;
    sort?: 'downloads' | 'rating' | 'createdAt';
    isAdmin: boolean;
  }) {
    const qb = this.packsRepo
      .createQueryBuilder('pack')
      .leftJoinAndSelect('pack.author', 'author')
      .orderBy(`pack.${opts.sort ?? 'createdAt'}`, 'DESC');

    if (opts.isAdmin && opts.status) {
      qb.where('pack.status = :status', { status: opts.status });
    } else {
      qb.where('pack.status = :status', { status: 'approved' });
    }
    if (opts.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('pack.name ILIKE :s').orWhere('pack.description ILIKE :s');
        }),
      ).setParameter('s', `%${opts.search}%`);
    }
    if (opts.category) {
      qb.andWhere('pack.category = :category', { category: opts.category });
    }
    // `body_kinds` 是校验派生的本体类型数组：按「包含」筛选（text[] 的 ANY 语义）
    if (opts.bodyKind) {
      qb.andWhere(':bodyKind = ANY(pack.body_kinds)', { bodyKind: opts.bodyKind });
    }

    const page = Math.max(opts.page ?? 1, 1);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const [items, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  findMine(authorId: string): Promise<PetPack[]> {
    return this.packsRepo.find({
      where: { authorId },
      relations: ['author'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOneVisible(id: string, userId?: string, isAdmin = false): Promise<PetPack> {
    const pack = await this.packsRepo.findOne({ where: { id }, relations: ['author'] });
    if (!pack) throw new NotFoundException('宠物包不存在');
    const isOwner = userId && pack.authorId === userId;
    if (pack.status !== 'approved' && !isOwner && !isAdmin) {
      throw new ForbiddenException('宠物包未通过审核');
    }
    return pack;
  }

  async updateStatus(id: string, status: PetPackStatus): Promise<PetPack> {
    const pack = await this.packsRepo.findOne({ where: { id } });
    if (!pack) throw new NotFoundException('宠物包不存在');
    pack.status = status;
    return this.packsRepo.save(pack);
  }

  async update(id: string, dto: UpdatePetPackDto, userId: string, isAdmin: boolean) {
    const pack = await this.findOneVisible(id, userId, isAdmin);
    if (pack.authorId !== userId && !isAdmin) throw new ForbiddenException('无权修改该宠物包');
    Object.assign(pack, dto);
    return this.packsRepo.save(pack);
  }

  async remove(id: string, userId: string, isAdmin: boolean) {
    const pack = await this.findOneVisible(id, userId, isAdmin);
    if (pack.authorId !== userId && !isAdmin) throw new ForbiddenException('无权删除该宠物包');
    const { packUrl, previewUrl } = pack;
    await this.packsRepo.remove(pack);
    await this.storage.remove(packUrl);
    await this.storage.remove(previewUrl);
    return { success: true };
  }

  /** 下载计数与下载记录（评价/下载记录侧的资源类型沿用 `'pet'`，见 review.entity.ts 注释） */
  async recordDownload(id: string, userId?: string | null) {
    await this.reviewsService.recordDownload('pet', id, userId ?? null);
    await this.packsRepo.increment({ id }, 'downloads', 1);
  }
}
