import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { VoiceAsset } from './voice-asset.entity';
import { CreateVoiceDto, UpdateVoiceDto } from './dto/voice.dto';
import { ReviewsService } from '../reviews/reviews.service';
import { StorageService } from '../uploads/storage.service';

@Injectable()
export class VoicesService {
  constructor(
    @InjectRepository(VoiceAsset)
    private readonly voicesRepo: Repository<VoiceAsset>,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
  ) {}

  async list(opts: {
    status?: 'pending' | 'approved' | 'rejected';
    search?: string;
    page?: number;
    limit?: number;
    sort?: string;
    isAdmin: boolean;
  }) {
    const sortable = ['downloads', 'rating', 'createdAt'];
    const sort = sortable.includes(opts.sort ?? '') ? (opts.sort as string) : 'createdAt';
    const qb = this.voicesRepo
      .createQueryBuilder('voice')
      .leftJoinAndSelect('voice.author', 'author')
      .orderBy(`voice.${sort}`, 'DESC');

    if (opts.isAdmin && opts.status) {
      qb.where('voice.status = :status', { status: opts.status });
    } else {
      qb.where('voice.status = :status', { status: 'approved' });
    }
    if (opts.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('voice.name ILIKE :s').orWhere('voice.description ILIKE :s');
        }),
      ).setParameter('s', `%${opts.search}%`);
    }
    const page = Math.max(opts.page ?? 1, 1);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const [items, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  create(dto: CreateVoiceDto, authorId: string, sampleUrl: string | null): Promise<VoiceAsset> {
    const voice = this.voicesRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      configSchema: dto.configSchema ?? {},
      fileUrl: sampleUrl,
      version: dto.version ?? '1.0.0',
      authorId,
    });
    return this.voicesRepo.save(voice);
  }

  findMine(authorId: string): Promise<VoiceAsset[]> {
    return this.voicesRepo.find({ where: { authorId }, order: { createdAt: 'DESC' } });
  }

  async findOneVisible(id: string, userId?: string, isAdmin = false): Promise<VoiceAsset> {
    const voice = await this.voicesRepo.findOne({ where: { id }, relations: ['author'] });
    if (!voice) throw new NotFoundException('音色不存在');
    const isOwner = userId && voice.authorId === userId;
    if (voice.status !== 'approved' && !isOwner && !isAdmin) {
      // 对外一律按「不存在」处理：403 等于告诉外界「这个 id 存在但没通过审核」
      throw new NotFoundException('音色不存在');
    }
    return voice;
  }

  async updateStatus(id: string, status: 'pending' | 'approved' | 'rejected'): Promise<VoiceAsset> {
    const voice = await this.voicesRepo.findOne({ where: { id } });
    if (!voice) throw new NotFoundException('音色不存在');
    voice.status = status;
    return this.voicesRepo.save(voice);
  }

  async update(id: string, dto: UpdateVoiceDto, userId: string, isAdmin: boolean) {
    const voice = await this.findOneVisible(id, userId, isAdmin);
    if (voice.authorId !== userId && !isAdmin) throw new ForbiddenException('无权修改该音色');
    Object.assign(voice, dto);
    return this.voicesRepo.save(voice);
  }

  async remove(id: string, userId: string, isAdmin: boolean) {
    const voice = await this.findOneVisible(id, userId, isAdmin);
    if (voice.authorId !== userId && !isAdmin) throw new ForbiddenException('无权删除该音色');
    await this.voicesRepo.remove(voice);
    // 级联清理：否则评价与下载记录会留下指向已删音色的孤儿行
    await this.reviewsService.purgeAsset('voice', id);
    await this.storage.remove(voice.fileUrl);
    return { success: true };
  }

  async recordDownload(id: string, userId: string | null) {
    await this.reviewsService.recordDownload('voice', id, userId);
    await this.voicesRepo.increment({ id }, 'downloads', 1);
  }
}
