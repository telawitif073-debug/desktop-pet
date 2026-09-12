import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { PetAsset } from './pet-asset.entity';
import { CreatePetDto } from './dto/pet.dto';
import { ReviewsService } from '../reviews/reviews.service';
import { UpdatePetDto } from './dto/pet.dto';
import { StorageService } from '../uploads/storage.service';

@Injectable()
export class PetsService {
  constructor(
    @InjectRepository(PetAsset)
    private readonly petsRepo: Repository<PetAsset>,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
  ) {}

  /** 公开列表：默认只展示 approved；admin 可按 status 过滤 */
  async list(opts: {
    status?: 'pending' | 'approved' | 'rejected';
    category?: string;
    search?: string;
    tags?: string[];
    page?: number;
    limit?: number;
    sort?: 'downloads' | 'rating' | 'createdAt';
    isAdmin: boolean;
  }) {
    const qb = this.petsRepo
      .createQueryBuilder('pet')
      .leftJoinAndSelect('pet.author', 'author')
      .orderBy(`pet.${opts.sort ?? 'createdAt'}`, 'DESC');

    if (opts.isAdmin && opts.status) {
      qb.where('pet.status = :status', { status: opts.status });
    } else {
      qb.where('pet.status = :status', { status: 'approved' });
    }
    if (opts.category) qb.andWhere('pet.category = :category', { category: opts.category });
    if (opts.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('pet.name ILIKE :s').orWhere('pet.description ILIKE :s');
        }),
      ).setParameter('s', `%${opts.search}%`);
    }
    if (opts.tags?.length) {
      qb.andWhere('pet.tags @> :tags', { tags: JSON.stringify(opts.tags) });
    }
    const page = Math.max(opts.page ?? 1, 1);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const [items, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  create(dto: CreatePetDto, authorId: string): Promise<PetAsset> {
    const pet = this.petsRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      category: dto.category ?? null,
      tags: dto.tags ?? [],
      previewUrl: dto.previewUrl ?? null,
      fileUrl: dto.fileUrl,
      version: dto.version ?? '1.0.0',
      authorId,
    });
    return this.petsRepo.save(pet);
  }

  findMine(authorId: string): Promise<PetAsset[]> {
    return this.petsRepo.find({
      where: { authorId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOneVisible(id: string, userId?: string, isAdmin = false): Promise<PetAsset> {
    const pet = await this.petsRepo.findOne({ where: { id }, relations: ['author'] });
    if (!pet) throw new NotFoundException('资源不存在');
    const isOwner = userId && pet.authorId === userId;
    if (pet.status !== 'approved' && !isOwner && !isAdmin) {
      throw new ForbiddenException('资源未通过审核');
    }
    return pet;
  }

  async updateStatus(
    id: string,
    status: 'pending' | 'approved' | 'rejected',
  ): Promise<PetAsset> {
    const pet = await this.petsRepo.findOne({ where: { id } });
    if (!pet) throw new NotFoundException('资源不存在');
    pet.status = status;
    return this.petsRepo.save(pet);
  }

  async update(id: string, dto: UpdatePetDto, userId: string, isAdmin: boolean) {
    const pet = await this.findOneVisible(id, userId, isAdmin);
    if (pet.authorId !== userId && !isAdmin) throw new ForbiddenException('无权修改该资源');
    Object.assign(pet, dto);
    return this.petsRepo.save(pet);
  }

  async remove(id: string, userId: string, isAdmin: boolean) {
    const pet = await this.findOneVisible(id, userId, isAdmin);
    if (pet.authorId !== userId && !isAdmin) throw new ForbiddenException('无权删除该资源');
    await this.petsRepo.remove(pet);
    await this.storage.remove(pet.fileUrl);
    return { success: true };
  }

  /** 记录下载并累加计数（下载前请先校验状态为 approved） */
  async recordDownload(id: string, userId?: string | null) {
    await this.reviewsService.recordDownload('pet', id, userId ?? null);
    await this.petsRepo.increment({ id }, 'downloads', 1);
  }
}
