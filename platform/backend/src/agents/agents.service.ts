import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AgentAsset } from './agent-asset.entity';
import { CreateAgentDto } from './dto/agent.dto';
import { ReviewsService } from '../reviews/reviews.service';
import { UpdateAgentDto } from './dto/agent.dto';
import { StorageService } from '../uploads/storage.service';

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(AgentAsset)
    private readonly agentsRepo: Repository<AgentAsset>,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
  ) {}

  async list(opts: {
    status?: 'pending' | 'approved' | 'rejected';
    search?: string;
    page?: number;
    limit?: number;
    sort?: 'downloads' | 'rating' | 'createdAt';
    isAdmin: boolean;
  }) {
    const qb = this.agentsRepo
      .createQueryBuilder('agent')
      .leftJoinAndSelect('agent.author', 'author')
      .orderBy(`agent.${opts.sort ?? 'createdAt'}`, 'DESC');

    if (opts.isAdmin && opts.status) {
      qb.where('agent.status = :status', { status: opts.status });
    } else {
      qb.where('agent.status = :status', { status: 'approved' });
    }
    if (opts.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('agent.name ILIKE :s').orWhere('agent.description ILIKE :s');
        }),
      ).setParameter('s', `%${opts.search}%`);
    }
    const page = Math.max(opts.page ?? 1, 1);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const [items, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  create(dto: CreateAgentDto, authorId: string): Promise<AgentAsset> {
    const agent = this.agentsRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      type: dto.type ?? 'chat',
      configSchema: dto.configSchema ?? null,
      dependencies: dto.dependencies ?? [],
      fileUrl: dto.fileUrl,
      previewUrl: dto.previewUrl ?? null,
      version: dto.version ?? '1.0.0',
      authorId,
    });
    return this.agentsRepo.save(agent);
  }

  findMine(authorId: string): Promise<AgentAsset[]> {
    return this.agentsRepo.find({
      where: { authorId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOneVisible(id: string, userId?: string, isAdmin = false): Promise<AgentAsset> {
    const agent = await this.agentsRepo.findOne({ where: { id }, relations: ['author'] });
    if (!agent) throw new NotFoundException('资源不存在');
    const isOwner = userId && agent.authorId === userId;
    if (agent.status !== 'approved' && !isOwner && !isAdmin) {
      throw new ForbiddenException('资源未通过审核');
    }
    return agent;
  }

  async updateStatus(
    id: string,
    status: 'pending' | 'approved' | 'rejected',
  ): Promise<AgentAsset> {
    const agent = await this.agentsRepo.findOne({ where: { id } });
    if (!agent) throw new NotFoundException('资源不存在');
    agent.status = status;
    return this.agentsRepo.save(agent);
  }

  async update(id: string, dto: UpdateAgentDto, userId: string, isAdmin: boolean) {
    const agent = await this.findOneVisible(id, userId, isAdmin);
    if (agent.authorId !== userId && !isAdmin) throw new ForbiddenException('无权修改该资源');
    Object.assign(agent, dto);
    return this.agentsRepo.save(agent);
  }

  async remove(id: string, userId: string, isAdmin: boolean) {
    const agent = await this.findOneVisible(id, userId, isAdmin);
    if (agent.authorId !== userId && !isAdmin) throw new ForbiddenException('无权删除该资源');
    await this.agentsRepo.remove(agent);
    await this.storage.remove(agent.fileUrl);
    return { success: true };
  }

  async recordDownload(id: string, userId?: string | null) {
    await this.reviewsService.recordDownload('agent', id, userId ?? null);
    await this.agentsRepo.increment({ id }, 'downloads', 1);
  }
}
