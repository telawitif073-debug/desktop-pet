import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Review, AssetType } from './review.entity';
import { DownloadRecord } from './download-record.entity';
import { PetAsset } from '../pets/pet-asset.entity';
import { AgentAsset } from '../agents/agent-asset.entity';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(Review)
    private readonly reviewsRepo: Repository<Review>,
    @InjectRepository(DownloadRecord)
    private readonly downloadsRepo: Repository<DownloadRecord>,
    @InjectRepository(PetAsset)
    private readonly petsRepo: Repository<PetAsset>,
    @InjectRepository(AgentAsset)
    private readonly agentsRepo: Repository<AgentAsset>,
  ) {}

  listForAsset(assetType: AssetType, assetId: string) {
    return this.reviewsRepo.find({
      where: { assetType, assetId },
      relations: ['user'],
      order: { createdAt: 'DESC' },
    });
  }

  /** 创建或更新当前用户对该资源的评论/评分，并重算资源平均分 */
  async upsertReview(input: {
    userId: string;
    assetType: AssetType;
    assetId: string;
    rating?: number;
    comment?: string;
  }) {
    await this.assertAssetExists(input.assetType, input.assetId);

    let review = await this.reviewsRepo.findOne({
      where: {
        userId: input.userId,
        assetType: input.assetType,
        assetId: input.assetId,
      },
    });
    if (!review) {
      review = this.reviewsRepo.create({
        userId: input.userId,
        assetType: input.assetType,
        assetId: input.assetId,
      });
    }
    review.rating = input.rating ?? review.rating ?? null;
    review.comment = input.comment ?? review.comment ?? null;
    const saved = await this.reviewsRepo.save(review);
    await this.recomputeRating(input.assetType, input.assetId);
    return saved;
  }

  async recordDownload(assetType: AssetType, assetId: string, userId: string | null) {
    await this.assertAssetExists(assetType, assetId);
    const record = this.downloadsRepo.create({ assetType, assetId, userId });
    return this.downloadsRepo.save(record);
  }

  private async assertAssetExists(assetType: AssetType, assetId: string) {
    if (assetType === 'pet') {
      if (!(await this.petsRepo.findOne({ where: { id: assetId } }))) {
        throw new NotFoundException('宠物资源不存在');
      }
    } else {
      if (!(await this.agentsRepo.findOne({ where: { id: assetId } }))) {
        throw new NotFoundException('智能体资源不存在');
      }
    }
  }

  /** 重算资源平均评分 */
  async recomputeRating(assetType: AssetType, assetId: string) {
    const rows = await this.reviewsRepo.find({
      where: { assetType, assetId, rating: In([1, 2, 3, 4, 5]) },
    });
    const rating =
      rows.length > 0
        ? rows.reduce((sum, r) => sum + (r.rating ?? 0), 0) / rows.length
        : 0;
    if (assetType === 'pet') {
      await this.petsRepo.update({ id: assetId }, { rating });
    } else {
      await this.agentsRepo.update({ id: assetId }, { rating });
    }
    return rating;
  }
}
