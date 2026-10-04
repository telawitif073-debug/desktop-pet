/**
 * 宠物包发布前的本地组装（解包 → 预校验 → 注入动作 → 重打包）
 * ---------------------------------------------------------------------------
 * 为什么单独成模块：这段逻辑只用 `fs` / `adm-zip` / 共享包，**不碰 electron**，
 * 因此可以被 vitest 直接覆盖；而 `platformClient` 依赖 electron，进程级不可单测。
 *
 * 动作在包内的布局（发布端写入 / 安装端读取必须同口径）：
 *   pet/actions.json                     —— {@link PetActionModel} 快照（元数据/池/权重）
 *   pet/actions/<动作名>/frame_000.png…  —— 帧图动作（目录名由 actionPayloadDirName 派生）
 *   pet/actions/<动作名>/clip.webm       —— 视频动作（清单里写相对路径）
 * 该子树不参与宠物本体判定（见 resource.ts 的 isActionPayloadPath）。
 */
import AdmZip from 'adm-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ACTION_PAYLOAD_DIR,
  ACTION_PAYLOAD_MANIFEST,
  actionPayloadDirName,
  modelFromActions,
  type PetActionLike,
} from '../pet';
import { PET_ACTIONS_MAX_PER_PET } from '../shared/actionQuota';
import { pickPetAppearance } from './petPack';

/** 发布载荷里的「附带动作」（与 global.d.ts 的 PublishPackAction 同构，去掉 UI 字段） */
export interface PackActionInput {
  name: string;
  interaction?: 'none' | 'feed' | 'rest' | 'play';
  kind: 'frames' | 'clip' | 'video';
  clipName?: string;
  file?: { name: string; bytes: Uint8Array };
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp)$/i;
const EBML_MAGIC = Buffer.from('1a45dfa3', 'hex');

/** 递归收集目录下全部文件 */
function listFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** 帧图按文件名自然序（frame_2 在 frame_10 之前） */
const byFrameName = (a: string, b: string): number =>
  path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true });

/** 把附带动作写进已解包目录：帧图/视频落 `pet/actions/<动作名>/`，元数据汇总为 `pet/actions.json` */
export function injectPackActions(extractDir: string, actions: PackActionInput[]): void {
  if (actions.length > PET_ACTIONS_MAX_PER_PET) {
    throw new Error(`附带动作过多（${actions.length} > 单宠上限 ${PET_ACTIONS_MAX_PER_PET}）`);
  }
  const likeList: PetActionLike[] = [];
  const seen = new Set<string>();

  actions.forEach((action, index) => {
    const name = String(action.name ?? '').trim();
    if (!name) throw new Error(`第 ${index + 1} 个动作缺少名称`);
    if (seen.has(name)) throw new Error(`动作名重复：${name}`);
    seen.add(name);

    const dirName = actionPayloadDirName(name);
    if (action.kind === 'frames') {
      if (!action.file) throw new Error(`动作「${name}」缺少帧图 zip`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-act-'));
      try {
        const zipPath = path.join(tmp, 'frames.zip');
        fs.writeFileSync(zipPath, Buffer.from(action.file.bytes));
        const extracted = path.join(tmp, 'x');
        new AdmZip(zipPath).extractAllTo(extracted, true);
        const frames = listFiles(extracted).filter((p) => IMAGE_EXTS.test(p)).sort(byFrameName);
        if (!frames.length) throw new Error(`动作「${name}」的 zip 里没有帧图（png/jpg/gif/webp）`);
        if (frames.length > 30) throw new Error(`动作「${name}」帧数过多（${frames.length} > 30）`);
        const dir = path.join(extractDir, ACTION_PAYLOAD_DIR, dirName);
        fs.mkdirSync(dir, { recursive: true });
        frames.forEach((src, i) => {
          const ext = path.extname(src).toLowerCase() || '.png';
          fs.copyFileSync(src, path.join(dir, `frame_${String(i).padStart(3, '0')}${ext}`));
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      likeList.push({ id: `act_${index}`, name, kind: 'frames', frameRate: 6, interaction: action.interaction });
    } else if (action.kind === 'video') {
      if (!action.file) throw new Error(`动作「${name}」缺少视频文件`);
      const ext = path.extname(action.file.name).toLowerCase();
      const data = Buffer.from(action.file.bytes);
      if (ext !== '.webm') throw new Error(`动作「${name}」的视频必须是 .webm（收到 ${action.file.name}）`);
      if (!data.subarray(0, 4).equals(EBML_MAGIC)) throw new Error(`动作「${name}」不是有效的 WebM（缺少 EBML 头）`);
      const dir = path.join(extractDir, ACTION_PAYLOAD_DIR, dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'clip.webm'), data);
      likeList.push({
        id: `act_${index}`,
        name,
        kind: 'video',
        videoFile: `${ACTION_PAYLOAD_DIR}/${dirName}/clip.webm`,
        interaction: action.interaction,
      });
    } else {
      likeList.push({ id: `act_${index}`, name, kind: 'clip', clipName: (action.clipName || name).trim(), interaction: action.interaction });
    }
  });

  const { model } = modelFromActions(likeList);
  // `modelFromActions` 只把 clip 动作记进 `modelClips`（一串名字），互动绑定会丢失。
  // 这里按名字补一条 spec 把 interaction 带过去（安装端优先读 spec，再兜底 modelClips）。
  for (const item of likeList) {
    if (item.kind !== 'clip') continue;
    model.actions[item.name] = {
      ref: item.name,
      kind: 'clip',
      clip: true,
      frameRate: 6,
      loop: false,
      holdLeadSec: 0.35,
      holdTailSec: 0.35,
      interaction: item.interaction ?? 'none',
      priority: 0,
      noMirror: false,
    };
  }
  const manifestPath = path.join(extractDir, ...ACTION_PAYLOAD_MANIFEST.split('/'));
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
}

/**
 * 宠物包发布前的完整本地组装：解包 → 本地预校验（与安装侧同一标准）→ 注入动作 → 重打包。
 * 预校验不通过直接抛错（**不做任何上传**），把所有临时文件清理干净后返回新的 zip 字节。
 */
export function buildPetPackForPublish(zipBytes: Buffer, actions: PackActionInput[] = []): Buffer {
  if (zipBytes.length < 4 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) {
    throw new Error('宠物包不是有效的 zip（缺少 PK 文件头）');
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-pack-'));
  try {
    const extractDir = path.join(work, 'extract');
    try {
      new AdmZip(zipBytes).extractAllTo(extractDir, true);
    } catch (e) {
      throw new Error(`宠物包解压失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // 本地预校验：与安装侧同一套标准（src/pet/resource.ts），不合格就别上传了
    const pick = pickPetAppearance(extractDir);
    if (!pick.ok) {
      const rejected = pick.evaluation.rejected
        .slice(0, 5)
        .map((r) => `${r.path}（${r.role}：${r.evidence[0]}）`)
        .join('；');
      throw new Error(`宠物包校验未通过：${pick.errors.join('；')}` + (rejected ? `｜被拒资源：${rejected}` : ''));
    }

    if (actions.length) injectPackActions(extractDir, actions);

    const zip = new AdmZip();
    zip.addLocalFolder(extractDir);
    return zip.toBuffer();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
