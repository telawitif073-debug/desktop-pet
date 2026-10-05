/**
 * 宠物包解包（主进程，骨架）
 * ---------------------------------------------------------------------------
 * 平台分发的宠物是一个 zip：包内约定 `pet/body.*`（本体）、`pet/actions.json`
 * （动作模型快照）、`pet/actions/<动作名>/`（动作载荷）、`manifest.json`（清单）。
 * 解包与校验应复用共享模块的 `parsePetPackManifest` / `evaluatePetPack` / `isIgnoredPackPath`。
 *
 * 当前为 Phase 1b 骨架：只固定签名与返回口径，真实实现后续补齐。
 */
export interface PetPackExtractResult {
  ok: boolean;
  /** 解包目标目录（成功时） */
  dir?: string;
  error?: string;
}

/** 解包宠物包到目标目录（targetDir 缺省由调用方给出，通常是 userData/pets/<id>） */
export async function extractPetPack(zipPath: string, targetDir: string): Promise<PetPackExtractResult> {
  void zipPath;
  void targetDir;
  return { ok: false, error: '宠物包解包尚未实现' };
}
