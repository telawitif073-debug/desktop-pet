/**
 * 本机宠物库（主进程，骨架）
 * ---------------------------------------------------------------------------
 * 已安装宠物登记在 config.pet.downloadedPets（随 config 云同步）；本模块只做
 * 「列出 / 安装登记 / 卸载登记」。资源包解包与本体判定见 petPack.ts（当前为签名级骨架）。
 */
import {
  DEFAULT_PET_SETTINGS,
  loadConfig,
  saveConfig,
  type InstalledPet,
  type PetSettings,
} from '../config';

/** 列出本机已安装宠物 */
export function listInstalledPets(): InstalledPet[] {
  return loadConfig().pet?.downloadedPets ?? [];
}

/**
 * 安装宠物（骨架：仅登记到本机宠物库；同 id 覆盖）。
 * 真实解包流程（读取 zip → 共享模块 evaluatePetPack 校验本体 → 落盘）后续在 petPack.ts 补齐。
 */
export function installPet(pet: InstalledPet): InstalledPet[] {
  const config = loadConfig();
  const current = config.pet ?? DEFAULT_PET_SETTINGS;
  const downloadedPets = [
    ...current.downloadedPets.filter((p) => p.id !== pet.id),
    { ...pet, installedAt: pet.installedAt || Date.now() },
  ];
  const next: PetSettings = { ...current, downloadedPets };
  saveConfig({ pet: next });
  return next.downloadedPets;
}

/** 卸载宠物：从本机宠物库移除；若正是当前选用形象，一并清空当前宠物 */
export function uninstallPet(id: string): { success: boolean; pets: InstalledPet[] } {
  const current = loadConfig().pet ?? DEFAULT_PET_SETTINGS;
  const downloadedPets = current.downloadedPets.filter((p) => p.id !== id);
  const next: PetSettings = {
    ...current,
    downloadedPets,
    ...(current.currentPet === id ? { currentPet: '', petStateReady: false } : {}),
  };
  saveConfig({ pet: next });
  return { success: true, pets: downloadedPets };
}
