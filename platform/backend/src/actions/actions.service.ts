import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActionAsset, ActionInteraction } from './action-asset.entity';
import { PetAsset } from '../pets/pet-asset.entity';
import { UpdateActionDto } from './dto/action.dto';
import { StorageService } from '../uploads/storage.service';

/** 创建/更新动作的元数据（来自 pets 上传表单的 actionsMeta 项或子资源接口） */
export interface ActionMetaInput {
  name: string;
  description?: string;
  interaction?: ActionInteraction;
  clipName?: string;
}

@Injectable()
export class ActionsService {
  constructor(
    @InjectRepository(ActionAsset)
    private readonly actionsRepo: Repository<ActionAsset>,
    @InjectRepository(PetAsset)
    private readonly petsRepo: Repository<PetAsset>,
    private readonly storage: StorageService,
  ) {}

  /** 宠物上传时附带动作（zip 帧图包或 clip 名）：kind 由 clipName 是否存在决定 */
  createForPet(
    petId: string,
    meta: ActionMetaInput,
    authorId: string,
    fileUrl: string,
  ): Promise<ActionAsset> {
    const action = this.actionsRepo.create({
      petId,
      name: meta.name,
      description: meta.description ?? null,
      interaction: meta.interaction ?? 'none',
      kind: meta.clipName ? 'clip' : 'frames',
      clipName: meta.clipName ?? null,
      fileUrl,
      authorId,
    });
    return this.actionsRepo.save(action);
  }

  /** 某宠物的动作清单（公开：客户端安装宠物时拉取） */
  listForPet(petId: string): Promise<ActionAsset[]> {
    return this.actionsRepo.find({
      where: { petId },
      order: { createdAt: 'ASC' },
    });
  }

  private async findOneInPet(petId: string, actionId: string): Promise<ActionAsset> {
    const action = await this.actionsRepo.findOne({ where: { id: actionId, petId } });
    if (!action) throw new NotFoundException('动作不存在');
    return action;
  }

  /** 编辑动作（名称/互动绑定）：仅宠物作者或 admin */
  async update(petId: string, actionId: string, dto: UpdateActionDto, userId: string, isAdmin: boolean) {
    const action = await this.findOneInPet(petId, actionId);
    const pet = await this.petsRepo.findOne({ where: { id: petId } });
    if (!pet) throw new NotFoundException('宠物资源不存在');
    if (pet.authorId !== userId && !isAdmin) throw new ForbiddenException('无权修改该动作');
    if (dto.name !== undefined) action.name = dto.name;
    if (dto.description !== undefined) action.description = dto.description;
    if (dto.interaction !== undefined) action.interaction = dto.interaction;
    return this.actionsRepo.save(action);
  }

  /** 删除动作：仅宠物作者或 admin */
  async remove(petId: string, actionId: string, userId: string, isAdmin: boolean) {
    const action = await this.findOneInPet(petId, actionId);
    const pet = await this.petsRepo.findOne({ where: { id: petId } });
    if (!pet) throw new NotFoundException('宠物资源不存在');
    if (pet.authorId !== userId && !isAdmin) throw new ForbiddenException('无权删除该动作');
    await this.actionsRepo.remove(action);
    await this.storage.remove(action.fileUrl);
    return { success: true };
  }
}
