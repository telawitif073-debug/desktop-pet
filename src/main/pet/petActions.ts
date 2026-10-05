/**
 * 宠物动作读写（主进程，骨架）
 * ---------------------------------------------------------------------------
 * 动作定义与互动绑定落在 config.pet.petActions / petActionBindings；
 * 标准动作模型（schemaVersion 3：动作池/权重/事件档位）由共享模块 `@pet/domain`
 * 的 `modelFromActions` 从旧形态无损迁移，这里不重复实现迁移规则。
 */
import {
  DEFAULT_PET_SETTINGS,
  loadConfig,
  saveConfig,
  type PetActionBindings,
  type PetActionConfig,
  type PetSettings,
} from '../config';
import { modelFromActions, type PetActionLike, type PetActionModel } from '@pet/domain';

/** 读取本机宠物动作列表 */
export function loadActions(): PetActionConfig[] {
  return loadConfig().pet?.petActions ?? [];
}

/** 保存宠物动作列表（整体替换语义） */
export function saveActions(actions: PetActionConfig[]): PetActionConfig[] {
  const current = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  const next: PetSettings = { ...current, petActions: actions };
  saveConfig({ pet: next });
  return next.petActions;
}

/** 读取互动绑定（feed/rest/play → 动作 id） */
export function loadActionBindings(): PetActionBindings {
  return loadConfig().pet?.petActionBindings ?? {};
}

/** 保存互动绑定（整体替换语义） */
export function saveActionBindings(bindings: PetActionBindings): PetActionBindings {
  const current = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  const next: PetSettings = { ...current, petActionBindings: bindings };
  saveConfig({ pet: next });
  return next.petActionBindings;
}

/** 由动作列表构建标准动作模型（迁移/权重不变量由共享模块保证） */
export function buildActionModel(actions: PetActionConfig[] = loadActions()): PetActionModel {
  return modelFromActions(actions as PetActionLike[]).model;
}
