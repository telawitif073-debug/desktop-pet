/**
 * 宠物本体资源分类（纯逻辑：无 electron / 无 DOM / 无 IO）
 * ---------------------------------------------------------------------------
 * 为什么需要它：安装链路过去只有「文件名 glob + 取目录里第一个文件」的兜底
 * （`platformClient.ts` 的 `findFirstFile(installDir, () => true)`），没有「宠物本体」定义，
 * 于是图标、背景、截图、表情包都可能被当成宠物形象装进宠物资源包。
 * 本模块把「什么算宠物本体」写成**可测试、可审计、fail-closed** 的显式标准。
 *
 * 判定顺序（首个命中即定性，全程记录 evidence）：
 *   1. declared  清单/注册表显式声明（最高信任；用于自带清单的资源包）
 *   2. filename  硬性非本体文件名标记（cursor-/notify-/ic_launcher/logo/screenshot/pcb/…）
 *                —— 安全优先：即使它躺在 body 目录里也不认作本体
 *   3. dir       目录角色（pet/body/sprite/... → 本体；preview/cover → 派生；
 *                memes/ui/branding/docs/... → 非本体）
 *   4. ext       扩展名定类（Live2D/3D 模型 → 本体模型；音频 → audio；字体 → branding）
 *   5. content   内容与几何（有帧 → 本体动画；有效 alpha + 尺寸达标 → 本体静帧；
 *                无 alpha / 极端长宽比 / 过小 → 文档图，**不认作本体**）
 *   6. fallback  其余 → unknown（**不入包**，记录原因）
 *
 * 包级规则：`evaluatePetPack` 要求包内至少 1 个「够格的本体」——
 *   body-model / body-animation / 尺寸达标且有 alpha 的 body-still；
 * 只有图标、只有封面、只有文档图、只有过小的静帧 → **invalid** 并给出显式原因。
 */

import { ACTION_PAYLOAD_DIR, ACTION_PAYLOAD_MANIFEST } from './actionModel';

export type PetResourceRole =
  | 'body-animation'
  | 'body-still'
  | 'body-model'
  | 'body-cover'
  | 'ui'
  | 'meme'
  | 'prop'
  | 'texture'
  | 'branding'
  | 'document'
  | 'audio'
  | 'unknown';

/** 宠物本体角色（可作形象/动作/模型） */
export const PET_BODY_ROLES: readonly PetResourceRole[] = ['body-model', 'body-animation', 'body-still'];
/** 本体派生角色（封面/预览：可展示，但不作为独立动作） */
export const PET_DERIVED_ROLES: readonly PetResourceRole[] = ['body-cover'];

export const isPetBodyRole = (role: PetResourceRole): boolean => PET_BODY_ROLES.includes(role);
export const isPetDerivedRole = (role: PetResourceRole): boolean => PET_DERIVED_ROLES.includes(role);
/** 允许进入宠物资源包的角色（本体 + 本体派生）。其余一律不得进包 */
export const isPackEligibleRole = (role: PetResourceRole): boolean => isPetBodyRole(role) || isPetDerivedRole(role);

/** 内容探测结果：由调用方注入（Node 侧读文件头；浏览器侧读 Image/Video 元数据） */
export interface ResourceProbe {
  width?: number;
  height?: number;
  /** 动图/视频帧数（未知不填） */
  frames?: number;
  /** 是否存在有效 alpha（抠像素材） */
  hasAlpha?: boolean;
  animated?: boolean;
  bytes?: number;
}

/** 待分类的一项资源 */
export interface ResourceEntry {
  /** 相对资源包根的路径（正斜杠或反斜杠均可，内部归一化） */
  path: string;
  probe?: ResourceProbe;
  /** 清单/注册表显式声明的角色（可选） */
  declaredRole?: PetResourceRole;
  /** 清单声明的 sha256（可选；由调用方与磁盘互校） */
  declaredSha256?: string;
}

export type DecisionLayer = 'declared' | 'filename' | 'dir' | 'ext' | 'content' | 'fallback';

export interface ClassifiedResource {
  path: string;
  role: PetResourceRole;
  decidedBy: DecisionLayer;
  /** 判定依据（可读、可审计；失败时即「为什么被拒」） */
  evidence: string[];
  probe?: ResourceProbe;
}

export interface PetPackEvaluation {
  valid: boolean;
  /** 选中的本体入口（body-model > body-animation > body-still，同类取面积最大，路径次序兜底） */
  entry: ClassifiedResource | null;
  body: ClassifiedResource[];
  derived: ClassifiedResource[];
  /** 被拒资源（非本体/无法判定），含原因，供 UI 与报告展示 */
  rejected: ClassifiedResource[];
  errors: string[];
  /** 需要内容探测才能定性的条目（调用方应补探测后重跑） */
  needProbe: string[];
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------
const ANIM_EXTS = new Set(['.gif', '.webp', '.apng', '.webm', '.mp4', '.mov', '.mkv', '.avi']);
const STILL_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.bmp', '.avif', '.tiff', '.tif', '.ico']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac', '.opus', '.oga']);
const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2', '.eot']);
const MODEL_EXTS = new Set(['.moc3', '.cmo3', '.glb', '.gltf', '.vrm', '.fbx', '.obj']);
const VIDEO_EXTS = new Set(['.webm', '.mp4', '.mov', '.mkv', '.avi']);

/** 硬性非本体文件名标记：命中即定类，且**优先于目录**（安全优先、fail-closed） */
const HARD_NAME_RULES: Array<{ re: RegExp; role: PetResourceRole; why: string }> = [
  // 模型贴图/图集/精灵表：不是「一帧动画」，而是模型的贴图页或整张精灵表
  { re: /(^|[-_])(texture|textures|tex|atlas|atlases|sheet|sheets|spritesheet|sprite[-_]?sheet|tileset|tilesets)[-_]?\d*([-_]|$)/i, role: 'texture', why: '模型贴图/精灵表（非独立动画帧）' },
  { re: /^(cursor|pointer)[-_]?/i, role: 'ui', why: '光标资源（界面件）' },
  { re: /^(notify|notification|toast|alert)[-_]?/i, role: 'ui', why: '通知/提示图标（界面件）' },
  { re: /^ic[_-]?(launcher|menu|toolbar|tab|action)/i, role: 'ui', why: '应用/控件图标（界面件）' },
  { re: /^(app[-_]?icon|appicon|favicon|splash[-_]?icon)/i, role: 'ui', why: '应用图标（界面件）' },
  { re: /^(logo|brand|brandmark|wordmark|watermark)/i, role: 'branding', why: '品牌标识' },
  { re: /^(og[-_]?image|social[-_]?(preview|card)|twitter[-_]?card|banner|poster[-_]?social)/i, role: 'branding', why: '社交/宣传图' },
  { re: /(screenshot|screen[_-]?shot|屏幕截图)/i, role: 'document', why: '截图（文档/说明用）' },
  { re: /(^|[-_])(pcb|schematic|wiring|circuit|blueprint)([-_]|$)/i, role: 'document', why: '硬件示意图（非角色美术）' },
  { re: /(^|[-_])(bom|dimension|dimensions|pinout|footprint)([-_]|$)/i, role: 'document', why: '工程图（非角色美术）' },
  { re: /(diagram|flowchart|architecture|uml)/i, role: 'document', why: '结构/流程示意图' },
  { re: /^(readme|changelog|license|licence|notice)([-_.]|$)/i, role: 'document', why: '说明/许可文档' },
];

/** 目录角色标记（先查非本体目录，再查本体目录） */
const NON_BODY_DIRS: Array<{ names: Set<string>; role: PetResourceRole; why: string }> = [
  { names: new Set(['texture', 'textures', 'atlas', 'atlases', 'spritesheet', 'spritesheets', 'tileset', 'tilesets', '贴图', '图集', '精灵表']), role: 'texture', why: '模型贴图/精灵表目录（非独立动画帧）' },
  { names: new Set(['commodity', 'commoditys', 'item', 'items', 'prop', 'props', 'food', 'foods', 'goods', 'inventory', 'backpack', 'shop', 'store', '道具', '物品', '商品', '食物', '背包']), role: 'prop', why: '物品/道具目录（喂食物品、商品、背包图标，非宠物本体）' },
  { names: new Set(['meme', 'memes', 'sticker', 'stickers', 'emoji', 'emojis', 'reaction', 'reactions', '表情包', '表情', '贴纸', '梗图']), role: 'meme', why: '表情包目录（对话配图，非本体）' },
  { names: new Set(['ui', 'icon', 'icons', 'chrome', 'widget', 'widgets', 'button', 'buttons', 'scrollbar', 'cursor', 'cursors', 'notify', 'notification', 'badge', 'badges', 'toolbar', 'mipmap', 'drawable', 'res', 'uigraphics', 'uikit', 'iconfont', 'help', '图标', '光标', '界面', '控件', '帮助']), role: 'ui', why: '界面件目录' },
  { names: new Set(['brand', 'branding', 'logo', 'logos', 'social', 'marketing', 'press', 'font', 'fonts', '品牌', '宣传', '字体']), role: 'branding', why: '品牌/字体目录' },
  { names: new Set(['doc', 'docs', 'document', 'documents', 'screenshot', 'screenshots', 'schematic', 'schematics', 'pcb', 'hardware', 'wiring', 'reference', 'references', 'sample', 'samples', 'example', 'examples', 'gallery', 'diagram', 'diagrams', '截图', '文档', '说明', '示意图', '原理图', '电路', '硬件']), role: 'document', why: '文档/示意目录（非本体）' },
  { names: new Set(['preview', 'previews', 'thumb', 'thumbs', 'thumbnail', 'thumbnails', 'cover', 'covers', 'poster', 'posters', 'showcase', '预览', '封面', '缩略图']), role: 'body-cover', why: '预览/封面目录（本体派生）' },
];

/**
 * 目录名「子串」标记（`scripts/pets/pet_roles.py` 的 NON_BODY_DIR_SUBSTR 同口径）。
 * 真实语料里大量非本体素材放在复合目录名里（README.assets / Tutorial.assets / iconList /
 * sysSeting / stateInfo / left-keys / img_res / medicine / arenas…），归一化后（去空格/下划线/连字符）
 * 不会与上面的精确词表相等 → 必须按子串命中。只作用于「目录段」，不参与文件名判定。
 */
const NON_BODY_DIR_SUBSTR: Array<{ token: string; role: PetResourceRole; why: string }> = [
  { token: 'readme', role: 'document', why: '说明/文档素材目录（非本体）' },
  { token: 'tutorial', role: 'document', why: '教程素材目录（非本体）' },
  { token: 'arenas', role: 'document', why: '场景/竞技场背景图（非宠物本体）' },
  { token: 'iconlist', role: 'ui', why: '图标清单目录（界面件）' },
  { token: 'loginpanel', role: 'ui', why: '登录面板素材（界面件）' },
  { token: 'onlinequitprompt', role: 'ui', why: '退出确认按钮素材（界面件）' },
  { token: 'sysseting', role: 'ui', why: '系统设置界面素材（界面件）' },
  { token: 'syssetting', role: 'ui', why: '系统设置界面素材（界面件）' },
  { token: 'stateinfo', role: 'ui', why: '状态信息界面素材（界面件）' },
  { token: 'leftkeys', role: 'ui', why: '键盘按键精灵（输入层，非宠物本体）' },
  { token: 'rightkeys', role: 'ui', why: '键盘按键精灵（输入层，非宠物本体）' },
  { token: 'medicine', role: 'prop', why: '药品/道具图标（非宠物本体）' },
  { token: 'imgres', role: 'prop', why: '游戏资源图（物品/界面，非宠物本体）' },
];
const BODY_DIRS = new Set([
  'pet', 'pets', 'body', 'character', 'characters', 'sprite', 'sprites', 'spriteframe', 'spriteframes',
  'frame', 'frames', 'action', 'actions', 'anim', 'anims', 'animation', 'animations', 'motion', 'motions',
  'state', 'states', 'idle', 'walk', 'walking', 'run', 'running', 'drag', 'dragging', 'climb', 'fall', 'sit',
  '角色', '立绘', '宠物', '桌宠', '精灵', '形象',
]);

/** 派生文件名标记（封面/预览） */
const DERIVED_NAME_RE = /^(cover|preview|thumb|thumbnail|poster|avatar|portrait)/i;
/** 本体静帧的尺寸门槛：小于此值不足以作为宠物形象（防图标混入） */
export const MIN_BODY_STILL_EDGE = 128;
/** 本体静帧的最大长宽比：超过则视为横幅/文档图 */
export const MAX_BODY_ASPECT = 2.5;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const normalize = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

const segments = (p: string): string[] => normalize(p).split('/').filter((s) => s && s !== '.');

/**
 * 目录名归一化：小写并去掉空格/下划线/连字符，使 `Ui Graphics` / `ui-graphics` / `ui_graphics`
 * 同一口径（与 `scripts/pets/pet_roles.py` 的 `norm_dir` 逐字对应）。
 */
const normDir = (name: string): string => String(name ?? '').toLowerCase().replace(/[\s_\-]+/g, '');

/**
 * 打包时应忽略的目录名（小写）。
 * 桌面端 `walkPackFiles`（解压后的目录）与服务端解包（zip 条目名）**必须同一口径**，
 * 否则会出现「服务端按某文件判合格、客户端却忽略该文件装不上」——这正是设计文档 §3.3 要避免的。
 */
export const PACK_SKIP_DIRS: readonly string[] = [
  '.git', '.github', 'node_modules', '__macosx', 'dist', 'build', '.vite', 'out', 'coverage',
];

/**
 * 该包内相对路径是否应被忽略：隐藏项（任一层以 `.` 开头）或位于 {@link PACK_SKIP_DIRS} 目录内。
 * 只作用于「路径」，与探测/分类无关，供目录遍历与 zip 解包两侧共用。
 */
export function isIgnoredPackPath(relPath: string): boolean {
  const segs = segments(relPath);
  return segs.some((seg, i) => {
    if (seg.startsWith('.')) return true;
    // 仅目录段参与 SKIP_DIRS 判定（末段是文件名）
    return i < segs.length - 1 && PACK_SKIP_DIRS.includes(seg.toLowerCase());
  });
}

/**
 * 包内「动作载荷」区：`pet/actions.json` 与 `pet/actions/**`。
 * ---------------------------------------------------------------------------
 * 动作是宠物包的一部分（见 `actionModel.ts`），但**不是宠物本体**：把帧图目录当成
 * 本体会让「静态本体 + 帧动作」的包选中一帧动作当形象。因此这棵子树**不参与本体判定**，
 * 由客户端安装时按约定装配（帧图 = `pet/actions/<动作名>/frame_*.png`）。
 * 桌面与服务端两侧必须同口径，否则又会出现「服务端说合格、客户端装不上」。
 */
export function isActionPayloadPath(relPath: string): boolean {
  const p = normalize(relPath).toLowerCase();
  return p === ACTION_PAYLOAD_MANIFEST.toLowerCase() || p.startsWith(`${ACTION_PAYLOAD_DIR.toLowerCase()}/`);
}

/** Live2D 清单后缀（与 `pet_roles.py` 的 `stem_of` 三条后缀逐字对应） */
const LIVE2D_SUFFIXES = ['.model3.json', '.live2d-lite.json', '.live2d.json'];
const live2dSuffixOf = (lowerBase: string): string | undefined =>
  LIVE2D_SUFFIXES.find((s) => lowerBase.endsWith(s));

const extOf = (p: string): string => {
  const base = normalize(p).split('/').pop() ?? '';
  const lower = base.toLowerCase();
  // 复合扩展名优先（Live2D 的 xxx.model3.json / xxx.live2d.json / xxx.live2d-lite.json）
  if (live2dSuffixOf(lower)) return '.model3.json';
  const i = lower.lastIndexOf('.');
  return i > 0 ? lower.slice(i) : '';
};

const stemOf = (p: string): string => {
  const base = normalize(p).split('/').pop() ?? '';
  const lower = base.toLowerCase();
  const suffix = live2dSuffixOf(lower);
  if (suffix) return base.slice(0, base.length - suffix.length);
  const i = base.lastIndexOf('.');
  return base.slice(0, i > 0 ? i : base.length);
};

const isImageLike = (ext: string): boolean => ANIM_EXTS.has(ext) || STILL_EXTS.has(ext);
const areaOf = (c: ClassifiedResource): number => {
  const w = c.probe?.width ?? 0;
  const h = c.probe?.height ?? 0;
  return w > 0 && h > 0 ? w * h : 0;
};

/** 帧序列命名：前缀 + 结尾编号（frame_000 / 0001 / idle-3 …） */
const SEQ_NAME_RE = /^(.*?)[-_ .]?(\d{1,4})$/;

/**
 * 识别「帧序列」：同一目录 + 同前缀 + 尺寸一致（且尺寸已知）的 ≥2 个条目。
 * 为什么要单独识别：像素画序列（如 32×32 的 shimeji 精灵）单帧尺寸很小，
 * 若逐帧按静帧门槛判定会被误杀；按「序列」整体看，它就是本体动画。
 */
export function groupFrameSequences(entries: ResourceEntry[]): Set<string> {
  const groups = new Map<string, ResourceEntry[]>();
  for (const e of entries) {
    const p = normalize(e.path);
    const m = SEQ_NAME_RE.exec(stemOf(p));
    if (!m) continue;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const key = `${dir}::${m[1].toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const out = new Set<string>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const dims = new Set(list.map((x) => `${x.probe?.width ?? 0}x${x.probe?.height ?? 0}`));
    if (dims.size !== 1 || dims.has('0x0')) continue; // 尺寸必须已知且一致
    for (const e of list) out.add(normalize(e.path));
  }
  return out;
}

/** 是否「够格的本体」：模型 / 动画 / 尺寸达标且有 alpha 的静帧 */export function isQualifiedBody(c: ClassifiedResource): boolean {
  if (c.role === 'body-model') return true;
  if (c.role === 'body-animation') return true;
  if (c.role !== 'body-still') return false;
  const { width = 0, height = 0, hasAlpha } = c.probe ?? {};
  if (!(width >= MIN_BODY_STILL_EDGE && height >= MIN_BODY_STILL_EDGE)) return false;
  const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
  if (aspect > MAX_BODY_ASPECT) return false;
  // 未探测 alpha 时不否决（调用方可能无探测能力），但会记入 evidence
  return hasAlpha !== false;
}

// ---------------------------------------------------------------------------
// 单项分类
// ---------------------------------------------------------------------------
export function classifyResource(entry: ResourceEntry, opts: { inSequence?: boolean } = {}): ClassifiedResource {
  const p = normalize(entry.path);
  const ext = extOf(p);
  const stem = stemOf(p);
  const segs = segments(p);
  // 目录段同时保留原文（写进 evidence，便于人工复核）与归一化形式（用于词表/子串命中）
  const rawDirs = segs.slice(0, -1);
  const dirs = rawDirs.map((s) => normDir(s));
  const probe = entry.probe;

  // 1) 清单显式声明：最高信任
  if (entry.declaredRole) {
    return { path: p, role: entry.declaredRole, decidedBy: 'declared', evidence: [`清单声明为 ${entry.declaredRole}`], probe };
  }

  // 2) 硬性非本体文件名标记（优先于目录：避免 body/ 目录里的 cursor-/logo 被误收）
  for (const rule of HARD_NAME_RULES) {
    if (rule.re.test(stem)) {
      return { path: p, role: rule.role, decidedBy: 'filename', evidence: [`文件名标记：${rule.why}（${stem}）`], probe };
    }
  }

  // 3) 目录角色：按「角色特异性」优先，而不是按路径深度——
  //    `res/atlases/char.png` 里 `atlases`（贴图）比 `res`（泛资源目录）更具体，应该判 texture。
  //    规则组内部顺序即特异性顺序（贴图 > 道具 > 表情包 > 界面件 > 品牌 > 文档 > 派生素材）。
  for (const rule of NON_BODY_DIRS) {
    const idx = dirs.findIndex((seg) => rule.names.has(seg));
    if (idx >= 0) {
      return { path: p, role: rule.role, decidedBy: 'dir', evidence: [`目录标记 ${rawDirs[idx]}/：${rule.why}`], probe };
    }
  }
  // 复合目录名（README.assets / Ui Graphics / left-keys …）：归一化后按子串命中
  for (const rule of NON_BODY_DIR_SUBSTR) {
    const idx = dirs.findIndex((seg) => seg.includes(rule.token));
    if (idx >= 0) {
      return { path: p, role: rule.role, decidedBy: 'dir', evidence: [`目录标记 ${rawDirs[idx]}/：${rule.why}`], probe };
    }
  }
  const bodyIdx = dirs.findIndex((d) => BODY_DIRS.has(d));
  const bodyDirHit = bodyIdx >= 0 ? rawDirs[bodyIdx] : undefined;

  // 4) 扩展名定类
  if (MODEL_EXTS.has(ext) || ext === '.model3.json') {
    return { path: p, role: 'body-model', decidedBy: 'ext', evidence: [`模型扩展名 ${ext}（本体模型）`], probe };
  }
  if (FONT_EXTS.has(ext)) {
    return { path: p, role: 'branding', decidedBy: 'ext', evidence: [`字体文件 ${ext}`], probe };
  }
  if (AUDIO_EXTS.has(ext)) {
    return { path: p, role: 'audio', decidedBy: 'ext', evidence: [`音频文件 ${ext}（非美术本体）`], probe };
  }

  // 4.5) 帧序列成员：单帧可能很小，但作为「序列」整体就是本体动画
  if (opts.inSequence && isImageLike(ext)) {
    return {
      path: p,
      role: 'body-animation',
      decidedBy: 'content',
      evidence: ['帧序列成员（同目录同前缀 ≥2 帧且尺寸一致）→ 本体动画'],
      probe,
    };
  }

  // 5) 内容与几何
  const frames = probe?.frames ?? 0;
  const animated = probe?.animated === true || frames > 1;

  if (bodyDirHit && isImageLike(ext)) {
    if (animated || VIDEO_EXTS.has(ext)) {
      return { path: p, role: 'body-animation', decidedBy: 'content', evidence: [`本体目录 ${bodyDirHit}/ 且为动画/序列（frames=${frames || 'video'}）`], probe };
    }
    const w = probe?.width ?? 0;
    const h = probe?.height ?? 0;
    const aspect = w > 0 && h > 0 ? Math.max(w, h) / Math.max(1, Math.min(w, h)) : 0;
    if (probe === undefined) {
      // 目录声明为本体，但缺内容探测：登记为「候选本体静帧，待补探测」。
      // 严格模式（默认）不把它算作够格本体；调用方补探测后重跑即可定性。
      return {
        path: p,
        role: 'body-still',
        decidedBy: 'dir',
        evidence: [`本体目录 ${bodyDirHit}/（缺少内容探测：尺寸/alpha 待确认）`],
        probe,
      };
    }
    if (w >= MIN_BODY_STILL_EDGE && h >= MIN_BODY_STILL_EDGE && aspect <= MAX_BODY_ASPECT) {
      return { path: p, role: 'body-still', decidedBy: 'content', evidence: [`本体目录 ${bodyDirHit}/，静帧 ${w}×${h}（长宽比 ${aspect.toFixed(2)}）`], probe };
    }
    if (!w || !h) {
      return { path: p, role: 'unknown', decidedBy: 'fallback', evidence: ['本体目录内，但读不出图像尺寸（文件截断/格式不支持）：fail-closed，不认作本体'], probe };
    }
    return {
      path: p,
      role: 'unknown',
      decidedBy: 'fallback',
      evidence: [
        `本体目录 ${bodyDirHit}/，但静帧尺寸/比例不达标（${w}×${h}，需 ≥${MIN_BODY_STILL_EDGE}px 且长宽比 ≤${MAX_BODY_ASPECT}）`,
        'fail-closed：不认作本体',
      ],
      probe,
    };
  }

  if (DERIVED_NAME_RE.test(stem)) {
    return { path: p, role: 'body-cover', decidedBy: 'filename', evidence: [`文件名标记：封面/预览（${stem}）`], probe };
  }

  if (isImageLike(ext)) {
    const w = probe?.width ?? 0;
    const h = probe?.height ?? 0;
    const aspect = w > 0 && h > 0 ? Math.max(w, h) / Math.max(1, Math.min(w, h)) : 0;
    const hasAlpha = probe?.hasAlpha;
    if (animated || VIDEO_EXTS.has(ext)) {
      return { path: p, role: 'body-animation', decidedBy: 'content', evidence: [`动画/视频（frames=${frames || 'video'}，无目录声明）`], probe };
    }
    if (hasAlpha === true && w >= MIN_BODY_STILL_EDGE && h >= MIN_BODY_STILL_EDGE && aspect <= MAX_BODY_ASPECT) {
      return { path: p, role: 'body-still', decidedBy: 'content', evidence: [`静帧带有效 alpha 且尺寸达标（${w}×${h}，长宽比 ${aspect.toFixed(2)}）`], probe };
    }
    if (probe === undefined) {
      return { path: p, role: 'unknown', decidedBy: 'fallback', evidence: ['孤立静帧且缺少内容探测：无法确认是否本体（fail-closed）'], probe };
    }
    if (!w || !h) {
      // 读不出尺寸（文件截断 / 格式不支持）→ 无法判定，不能当成「文档图」定性
      return { path: p, role: 'unknown', decidedBy: 'fallback', evidence: ['读不出图像尺寸（文件截断/格式不支持）：无法判定，fail-closed'], probe };
    }
    const why: string[] = [];
    if (hasAlpha !== true) why.push('无有效 alpha（疑似含背景的截图/照片）');
    if (!(w >= MIN_BODY_STILL_EDGE && h >= MIN_BODY_STILL_EDGE)) why.push(`尺寸过小（${w}×${h}）`);
    if (aspect > MAX_BODY_ASPECT) why.push(`长宽比 ${aspect.toFixed(2)} 超过 ${MAX_BODY_ASPECT}（横幅/文档图）`);
    return { path: p, role: 'document', decidedBy: 'content', evidence: [`非本体图：${why.join('；')}`, 'fail-closed：不认作本体'], probe };
  }

  // 6) 其余无法判定
  return { path: p, role: 'unknown', decidedBy: 'fallback', evidence: [`未知类型（ext=${ext || '无'}）：不入包`, 'fail-closed'], probe };
}

// ---------------------------------------------------------------------------
// 包级评估
// ---------------------------------------------------------------------------
export interface EvaluateOptions {
  /** 允许「未探测内容」的本体静帧算作本体（默认 false：严格模式，要求探测） */
  allowUnprobedBodyStill?: boolean;
}

/**
 * 评估一个宠物资源包：选出本体入口、列出被拒资源与原因。
 * 判定为 invalid 的典型情形：只有图标/文档图、只有封面、只有过小静帧、包里没有本体。
 */
export function evaluatePetPack(entries: ResourceEntry[], opts: EvaluateOptions = {}): PetPackEvaluation {
  const sequences = groupFrameSequences(entries);
  const classified = entries.map((e) => classifyResource(e, { inSequence: sequences.has(normalize(e.path)) }));
  const body = classified.filter((c) => isPetBodyRole(c.role));
  const derived = classified.filter((c) => isPetDerivedRole(c.role));
  const rejected = classified.filter((c) => !isPackEligibleRole(c.role));

  const qualified = body.filter((c) => isQualifiedBody(c) || (opts.allowUnprobedBodyStill && c.role === 'body-still' && c.probe === undefined));
  const errors: string[] = [];
  const needProbe = classified.filter((c) => c.evidence.some((e) => e.includes('缺少内容探测'))).map((c) => c.path);

  let entry: ClassifiedResource | null = null;
  if (qualified.length) {
    const rank: Record<string, number> = { 'body-model': 0, 'body-animation': 1, 'body-still': 2 };
    entry = [...qualified].sort(
      (a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9) || areaOf(b) - areaOf(a) || a.path.localeCompare(b.path),
    )[0];
  } else if (body.length) {
    errors.push('包内有候选本体资源，但没有一个「够格的本体」（模型/动画，或尺寸达标且有 alpha 的静帧）');
  } else if (derived.length) {
    errors.push('包内只有封面/预览图，没有本体资源（宠物资源包必须含本体）');
  } else if (rejected.length) {
    errors.push(`包内没有宠物本体资源（${rejected.length} 项均为非本体：${[...new Set(rejected.map((r) => r.role))].join('/')}）`);
  } else {
    errors.push('资源包为空');
  }

  return { valid: !!entry, entry, body, derived, rejected, errors, needProbe };
}

/** 角色统计（报告/UI 用） */
export function summarizeRoles(list: ClassifiedResource[]): Record<PetResourceRole, number> {
  const out = {
    'body-animation': 0, 'body-still': 0, 'body-model': 0, 'body-cover': 0,
    ui: 0, meme: 0, prop: 0, texture: 0, branding: 0, document: 0, audio: 0, unknown: 0,
  } as Record<PetResourceRole, number>;
  for (const c of list) out[c.role] = (out[c.role] ?? 0) + 1;
  return out;
}
