/**
 * 宠物资源包分析（主进程侧：读文件头做内容探测 → 交 `@pet/domain`（共享模块）定性）
 * ---------------------------------------------------------------------------
 * 分工（与设计文档 D2 一致）：
 *   - **纯解析**（字节 → 宽高/帧数/alpha）在共享模块 `@pet/domain` 的 `probe.ts`，
 *     桌面与服务端共用同一份，杜绝「服务端说合格、客户端装不上」；
 *   - 本模块只保留 **IO 适配**：遍历目录、读文件头、把结果拼成分类输入。
 */
import fs from 'fs';
import path from 'path';
import {
  evaluatePetPack,
  isActionPayloadPath,
  isIgnoredPackPath,
  probeByMeta,
  probeImageHead,
  probeNeedsBytes,
  PROBE_HEAD_BYTES,
  type PetPackEvaluation,
  type ResourceEntry,
  type ResourceProbe,
} from '@pet/domain'; // 宠物主体功能模块（共享包）

/**
 * 遍历资源包内文件（跳过隐藏项与 `.git`/`node_modules` 等目录）。
 * 忽略口径由共享包 {@link isIgnoredPackPath} 决定，与后端解包保持一致。
 */
export function walkPackFiles(dir: string, maxFiles = 4000): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (isIgnoredPackPath(rel)) continue;
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  visit(dir);
  return out;
}

// ---------------------------------------------------------------------------
// 头部探测（纯解析在共享包；这里只做「读字节」的 IO）
// ---------------------------------------------------------------------------

/** 内存缓冲探测（上传链路用：文件还没落盘时也要能定性） */
export function probeImageBuffer(buf: Buffer, filename: string): ResourceProbe | undefined {
  return probeImageHead(buf.subarray(0, Math.min(buf.length, PROBE_HEAD_BYTES)), buf.length, filename);
}

/** 只读文件头探测图片/视频元数据；无法识别格式时返回 undefined（分类层会 fail-closed） */
export function probeImageFile(file: string): ResourceProbe | undefined {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return undefined;
  }
  // 视频/模型/Live2D 清单只需扩展名与体积，无需读内容（大文件尤其重要）
  if (!probeNeedsBytes(file)) return probeByMeta(file, size);

  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(size, PROBE_HEAD_BYTES));
    fs.readSync(fd, head, 0, head.length, 0);
    return probeImageHead(head, size, file);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 把一个目录（资源包解压根）变成分类输入：相对路径 + 内容探测。
 * `pet/actions.json` 与 `pet/actions/**`（动作载荷）被排除——动作随宠物安装，
 * 但**不是宠物本体**，混进来会让静态本体被一帧动作顶替（与后端同口径）。
 */
export function buildPackEntries(dir: string): ResourceEntry[] {
  return walkPackFiles(dir)
    .map((file) => ({
      path: path.relative(dir, file).split(path.sep).join('/'),
      probe: probeImageFile(file),
    }))
    .filter((entry) => !isActionPayloadPath(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface PetAppearancePick {
  ok: boolean;
  /** 选中的本体入口绝对路径 */
  path?: string;
  /** 相对包根路径（写进 origin/日志用） */
  relative?: string;
  /** 推断形态：live2d / model3d / pack / image */
  format: 'image' | 'pack' | 'live2d' | 'model3d';
  evaluation: PetPackEvaluation;
  errors: string[];
}

const LIVE2D_ENTRY = /\.(model3|live2d(-lite)?)\.json$/i;
const MODEL3D_ENTRY = /\.(glb|gltf|vrm|fbx|obj)$/i;

/**
 * 从一个已解压的宠物资源包里挑出**本体入口**。
 * - declaredFormat 为 live2d/model3d 时，优先挑对应模型入口（保持既有形态语义）；
 * - 包里没有够格本体 → ok=false，errors 里是显式原因（调用方据此报错，绝不回落第一张图）。
 */
export function pickPetAppearance(dir: string, declaredFormat?: unknown): PetAppearancePick {
  const entries = buildPackEntries(dir);
  const evaluation = evaluatePetPack(entries);
  const errors = [...evaluation.errors];

  const declared =
    declaredFormat === 'live2d' || declaredFormat === 'model3d' || declaredFormat === 'pack' || declaredFormat === 'image'
      ? declaredFormat
      : undefined;

  let chosen = evaluation.entry;
  if (declared === 'live2d') {
    const candidates = evaluation.body.filter((b) => LIVE2D_ENTRY.test(b.path));
    if (!candidates.length) {
      errors.push('声明为 live2d，但包内没有 model3.json / live2d-lite.json 入口');
      return { ok: false, format: 'live2d', evaluation, errors };
    }
    chosen = candidates.sort((a, b) => a.path.localeCompare(b.path))[0];
  } else if (declared === 'model3d') {
    const candidates = evaluation.body.filter((b) => MODEL3D_ENTRY.test(b.path));
    if (!candidates.length) {
      errors.push('声明为 model3d，但包内没有 glb/gltf/vrm 入口');
      return { ok: false, format: 'model3d', evaluation, errors };
    }
    chosen = candidates.sort((a, b) => a.path.localeCompare(b.path))[0];
  }

  if (!chosen) {
    return { ok: false, format: declared ?? 'image', evaluation, errors };
  }

  const format: PetAppearancePick['format'] =
    declared ??
    (LIVE2D_ENTRY.test(chosen.path)
      ? 'live2d'
      : MODEL3D_ENTRY.test(chosen.path)
        ? 'model3d'
        : evaluation.body.length > 1
          ? 'pack'
          : 'image');

  return {
    ok: true,
    path: path.join(dir, ...chosen.path.split('/')),
    relative: chosen.path,
    format,
    evaluation,
    errors,
  };
}
