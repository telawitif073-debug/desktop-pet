import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { PetPack, PetPackStatus } from './pet-pack.entity';
import { UpdatePetPackDto } from './dto/pet-pack.dto';
import { ReviewsService } from '../reviews/reviews.service';
import { StorageService } from '../uploads/storage.service';

/**
 * 宠物包（商店宠物板块）的读取与管理。
 *
 * ⚠️ 这里**没有 create**：发布必须「上传即解包跑 `evaluatePetPack`」，
 * 不合格直接拒绝（设计文档 D3），而解包/探测能力在实施清单第 3 步（`pack-inspection.ts`）。
 * 在该能力落地前刻意不开放发布入口，避免出现「随便一个文件就能当宠物发布」的旧缺陷。
 */
@Injectable()
export class PetPacksService {
  constructor(
    @InjectRepository(PetPack)
    private readonly packsRepo: Repository<PetPack>,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
  ) {}

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
