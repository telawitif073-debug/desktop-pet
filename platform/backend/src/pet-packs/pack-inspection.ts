/**
 * 服务端宠物包校验（发布门禁，设计文档 §3.2 / §四 第 3 步）
 * ===========================================================================
 * 流程：
 *   zip 字节 → 读中央目录 → 逐条「肩部」探测（`bytes` 上限保护）→ `ResourceEntry[]`
 *   → `evaluatePetPack`（与客户端**同一份**标准，D2）
 *        ├─ invalid → 抛 400，附 `errors` / `rejected[]`（逐条角色与理由）
 *        └─ valid   → 返回入口 + `body_kinds` + 角色统计 + 清单快照（写 `pet_packs.manifest`）
 *
 * 与 `uploads/upload-validation.ts` **叠加**使用：后者做扩展名/MIME/文件头签名的字节级安全校验，
 * 本模块做「包内是否有合格宠物本体」的语义校验，两者缺一不可（见 {@link validatePetPackFile}）。
 */

import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  evaluatePetPack,
  isIgnoredPackPath,
  isQualifiedBody,
  probeByMeta,
  probeImageHead,
  probeNeedsBytes,
  PROBE_HEAD_BYTES,
  summarizeRoles,
  type ClassifiedResource,
  type PetPackEvaluation,
  type PetResourceRole,
  type ResourceEntry,
} from '../pet-domain';
import { PetPackBodyKind } from './pet-pack.entity';
import { ZipFormatException, readZipDirectory, readZipEntry, type ZipEntry } from './zip-reader';
import { validateUploadFile } from '../uploads/upload-validation';

// ---------------------------------------------------------------------------
// 限额（设计文档 §六 风险 3：从「一张图」变成「一个包」必须定上限）
// ---------------------------------------------------------------------------
/** 包体上限（zip 字节数） */
export const PET_PACK_MAX_BYTES = Number(process.env.PET_PACK_MAX_BYTES || 32 * 1024 * 1024);
/** 包内条目数上限 */
export const PET_PACK_MAX_ENTRIES = Number(process.env.PET_PACK_MAX_ENTRIES || 3000);
/** 单条解压上限 */
export const PET_PACK_MAX_ENTRY_BYTES = Number(process.env.PET_PACK_MAX_ENTRY_BYTES || 32 * 1024 * 1024);
/** 全部条目解压后总量上限（zip 炸弹兜底） */
export const PET_PACK_MAX_UNCOMPRESSED_BYTES = Number(process.env.PET_PACK_MAX_UNCOMPRESSED_BYTES || 128 * 1024 * 1024);

/** 包内 `actions.json` 的相对路径（动作是包的一部分，不建独立表，见 D4） */
const ACTIONS_PATH_RE = /^pet\/actions\.json$/i;

const BODY_KIND_RANK: Record<PetPackBodyKind, number> = {
  'body-model': 0,
  'body-animation': 1,
  'body-still': 2,
};

/** 清单快照（写进 `pet_packs.manifest`，审核页/商店详情直接展示，无需重新解包） */
export interface PetPackManifest {
  entryCount: number;
  bytes: number;
  entry: { path: string; role: PetResourceRole } | null;
  bodyKinds: PetPackBodyKind[];
  roles: Record<PetResourceRole, number>;
  body: Array<{ path: string; role: PetResourceRole; evidence: string[] }>;
  rejected: Array<{ path: string; role: PetResourceRole; evidence: string[] }>;
  /** 包内 `pet/actions.json` 快照（无则 null；解析失败记入 warnings） */
  actions: unknown;
  warnings: string[];
  inspectedAt: string;
}

export interface PackInspectionResult {
  /** 包体 sha256（十六进制小写），写入 `pet_packs.pack_sha256` */
  sha256: string;
  bytes: number;
  /** 参与判定的资源条目数（已排除目录项与忽略项） */
  entryCount: number;
  /** 由校验结果派生的合格本体类型（写 `pet_packs.body_kinds`） */
  bodyKinds: PetPackBodyKind[];
  /** 选中的本体入口（写日志/审核展示） */
  entry: ClassifiedResource | null;
  evaluation: PetPackEvaluation;
  manifest: PetPackManifest;
}

const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`);

/** 归一化 zip 条目名：反斜杠转正斜杠、去掉 `./` 前缀 */
const normalizeEntryName = (name: string): string => name.replace(/\\/g, '/').replace(/^\.\//, '');

const toBadRequest = (e: unknown): BadRequestException =>
  e instanceof ZipFormatException ? new BadRequestException(`宠物包格式不合法：${e.message}`) : (e as BadRequestException);

/** 把分类结果压成清单里的一行（只留可审计字段） */
const packLine = (c: ClassifiedResource) => ({ path: c.path, role: c.role, evidence: c.evidence });

/**
 * 解包 → 逐文件探测 → `evaluatePetPack`。
 * 不合格抛 400（响应体含 `errors` / `rejected`），合格返回入口与派生信息。
 */
export function inspectPetPack(buf: Buffer): PackInspectionResult {
  if (!buf || buf.length === 0) throw new BadRequestException('宠物包为空');
  if (buf.length > PET_PACK_MAX_BYTES) {
    throw new BadRequestException(`宠物包过大（${fmtBytes(buf.length)} > ${fmtBytes(PET_PACK_MAX_BYTES)}）`);
  }
  if (buf.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new BadRequestException('宠物包必须是 ZIP（缺少 PK 文件头）');
  }

  let dirEntries: ZipEntry[];
  try {
    dirEntries = readZipDirectory(buf, { maxEntries: PET_PACK_MAX_ENTRIES, maxEntryBytes: PET_PACK_MAX_ENTRY_BYTES });
  } catch (e) {
    throw toBadRequest(e);
  }

  const warnings: string[] = [];
  const resourceEntries: ResourceEntry[] = [];
  let totalUncompressed = 0;
  let actions: unknown = null;

  for (const entry of dirEntries) {
    if (entry.name.endsWith('/')) continue; // 目录项
    const path = normalizeEntryName(entry.name);
    if (!path) continue;
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new BadRequestException(`ZIP 条目包含非法路径：${entry.name}`);
    }
    if (isIgnoredPackPath(path)) continue; // 与客户端同一忽略口径

    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > PET_PACK_MAX_UNCOMPRESSED_BYTES) {
      throw new BadRequestException(`宠物包解压后过大（> ${fmtBytes(PET_PACK_MAX_UNCOMPRESSED_BYTES)}），疑似 zip 炸弹`);
    }

    if (ACTIONS_PATH_RE.test(path)) {
      try {
        actions = JSON.parse(readZipEntry(buf, entry, { maxEntryBytes: PET_PACK_MAX_ENTRY_BYTES }).toString('utf8'));
      } catch (e) {
        warnings.push(`包内 ${path} 解析失败：${(e as Error).message}`);
      }
      continue; // 清单文件不是「资源」，不进分类
    }

    let probe;
    if (probeNeedsBytes(path)) {
      // 栅格图：解压后只看头部（体积上限由 readZipEntry 兜底）
      let content: Buffer;
      try {
        content = readZipEntry(buf, entry, { maxEntryBytes: PET_PACK_MAX_ENTRY_BYTES });
      } catch (e) {
        throw toBadRequest(e);
      }
      probe = probeImageHead(content.subarray(0, Math.min(content.length, PROBE_HEAD_BYTES)), content.length, path);
    } else {
      // 视频/模型/Live2D 清单：无需解压，只看扩展名与体积
      probe = probeByMeta(path, entry.uncompressedSize);
    }
    resourceEntries.push({ path, probe });
  }

  resourceEntries.sort((a, b) => a.path.localeCompare(b.path));
  const evaluation = evaluatePetPack(resourceEntries);

  if (!evaluation.valid) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: '宠物包校验未通过：包内没有合格的宠物本体资源',
      errors: evaluation.errors,
      rejected: evaluation.rejected.map(packLine),
      needProbe: evaluation.needProbe,
    });
  }

  const qualified = evaluation.body.filter(isQualifiedBody);
  const bodyKinds = [...new Set(qualified.map((c) => c.role as PetPackBodyKind))].sort((a, b) => BODY_KIND_RANK[a] - BODY_KIND_RANK[b]);

  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
    entryCount: resourceEntries.length,
    bodyKinds,
    entry: evaluation.entry,
    evaluation,
    manifest: {
      entryCount: resourceEntries.length,
      bytes: buf.length,
      entry: evaluation.entry ? { path: evaluation.entry.path, role: evaluation.entry.role } : null,
      bodyKinds,
      roles: summarizeRoles([...evaluation.body, ...evaluation.derived, ...evaluation.rejected]),
      body: evaluation.body.map(packLine),
      rejected: evaluation.rejected.map(packLine),
      actions,
      warnings,
      inspectedAt: new Date().toISOString(),
    },
  };
}

/**
 * 发布入口的完整校验：**叠加**字节级安全校验（扩展名/MIME/文件头签名）与语义校验（包内本体）。
 * 未来开放 `POST /pet-packs` 时应直接调用它，避免只做其中一层。
 */
export function validatePetPackFile(
  file: Pick<Express.Multer.File, 'originalname' | 'mimetype' | 'buffer'>,
): PackInspectionResult {
  const extension = validateUploadFile(file);
  if (extension !== '.zip') throw new BadRequestException('宠物包必须是 .zip 压缩包');
  return inspectPetPack(file.buffer);
}
