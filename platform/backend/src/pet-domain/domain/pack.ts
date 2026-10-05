/* eslint-disable */
// ⚠ 本文件由 pet/tools/sync-to-backend.mjs 从 pet/ 同步生成，请勿手改。
// 修改请改 pet/ 下的源文件，然后运行：node pet/tools/sync-to-backend.mjs

/**
 * 宠物包清单模型（pack manifest）——纯逻辑，无 IO / 无 Node 内置
 * ---------------------------------------------------------------------------
 * 「宠物包」是平台商店分发宠物的载体：一个 zip，包内约定
 *   - `pet/body.*`            本体入口（image / 帧序列 / live2d / model3d）
 *   - `pet/actions.json`      动作模型快照（见 ./actionModel）
 *   - `pet/actions/<动作名>/` 动作载荷（frame_*.png 或 clip.webm）
 *   - `manifest.json`         本模块描述的清单（可选但推荐）
 *
 * 本模块只做两件事：① 清单文本 → 结构化 + 校验（错误可枚举、不静默兜底）；
 * ② 条目「摘要串」的规范化拼接。读 zip、算 sha256、落盘等 IO 全部留在各端适配层。
 */

/** 当前支持的清单 schema 版本 */
export const PACK_MANIFEST_VERSION = 1;

/** 宠物包清单（manifest.json） */
export interface PetPackManifest {
  /** 清单 schema 版本（当前 1；高于本端支持版本时拒绝） */
  schemaVersion: number;
  /** 展示名（必填，非空） */
  name: string;
  /** 语义化版本（必填，非空） */
  version: string;
  /** 本体入口相对路径（必填，如 pet/body.png） */
  entry: string;
  /** 本体形态（image / frames / live2d / model3d，可多值）；缺省由 entry 推断 */
  bodyKinds: string[];
  /** 简介 */
  description?: string;
  /** 许可标识（如 MIT / CC-BY-4.0 / SourceAvailable-NonCommercial） */
  license?: string;
  /** 预览图相对路径 */
  preview?: string;
  /** 标签 */
  tags?: string[];
}

export type PetPackManifestResult =
  | { ok: true; manifest: PetPackManifest }
  | { ok: false; errors: string[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 由入口路径粗判本体形态（纯字符串判断，不做字节探测） */
export function inferBodyKinds(entry: string): string[] {
  const p = entry.toLowerCase();
  if (p.endsWith('.glb') || p.endsWith('.gltf')) return ['model3d'];
  if (p.endsWith('.model3.json') || p.endsWith('.moc3')) return ['live2d'];
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(p)) return ['image'];
  if (p.endsWith('.zip')) return ['frames'];
  return ['unknown'];
}

/** 解析并校验宠物包清单；失败返回可枚举错误（不抛异常、不静默兜底） */
export function parsePetPackManifest(raw: unknown): PetPackManifestResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest 必须是对象'] };
  }
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];

  const schemaVersion = typeof o.schemaVersion === 'number' ? o.schemaVersion : NaN;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    errors.push('schemaVersion 必须是 >=1 的整数');
  } else if (schemaVersion > PACK_MANIFEST_VERSION) {
    errors.push(`schemaVersion ${schemaVersion} 高于本端支持的 ${PACK_MANIFEST_VERSION}`);
  }

  const name = str(o.name);
  if (!name) errors.push('name 不能为空');

  const version = str(o.version);
  if (!version) errors.push('version 不能为空');

  const entry = str(o.entry);
  if (!entry) errors.push('entry 不能为空');

  let bodyKinds: string[] = [];
  if (o.bodyKinds === undefined) {
    bodyKinds = entry ? inferBodyKinds(entry) : [];
  } else if (Array.isArray(o.bodyKinds) && o.bodyKinds.every((x) => typeof x === 'string')) {
    bodyKinds = [...new Set((o.bodyKinds as string[]).map((x) => x.trim()).filter(Boolean))];
    if (!bodyKinds.length) errors.push('bodyKinds 不能为空数组');
  } else {
    errors.push('bodyKinds 必须是字符串数组');
  }

  const tags = Array.isArray(o.tags) && o.tags.every((x) => typeof x === 'string')
    ? (o.tags as string[]).map((x) => x.trim()).filter(Boolean)
    : undefined;

  if (errors.length) return { ok: false, errors };

  const description = str(o.description);
  const license = str(o.license);
  const preview = str(o.preview);
  return {
    ok: true,
    manifest: {
      schemaVersion,
      name,
      version,
      entry,
      bodyKinds,
      ...(description ? { description } : {}),
      ...(license ? { license } : {}),
      ...(preview ? { preview } : {}),
      ...(tags && tags.length ? { tags } : {}),
    },
  };
}

/** 参与内容指纹计算的条目（sha256 由调用端计算，本模块不做 IO/hash） */
export interface PetPackDigestEntry {
  path: string;
  sha256: string;
}

/**
 * 规范摘要串：按路径升序拼「路径\0sha256\n」。
 * 调用端对该串取 sha256 即得包内容指纹——跨端口径一致、与条目顺序无关。
 */
export function canonicalDigestEntries(entries: readonly PetPackDigestEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}\0${e.sha256}\n`)
    .join('');
}
