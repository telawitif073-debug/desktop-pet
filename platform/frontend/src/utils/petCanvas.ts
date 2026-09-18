/** AI 生成的宠物形象参数（与后端 ai.service 的 PetDesign 对应） */
export interface PetDesign {
  name: string;
  /** 物种原型：决定整体轮廓，不同物种外形差异显著 */
  species: 'cat' | 'rabbit' | 'bear' | 'fox' | 'panda' | 'dragon' | 'penguin' | 'bird' | 'slime' | 'aquatic';
  bodyColor: string;
  bellyColor: string;
  earShape: 'pointy' | 'round' | 'long' | 'none';
  earColor: string;
  eyeColor: string;
  pattern: 'none' | 'stripes' | 'spots';
  patternColor: string;
  hasTail: boolean;
  tailStyle: 'curl' | 'straight' | 'fluffy' | 'none';
  /** 翅膀/鳍肢（龙/鸟/企鹅），画在身体后侧 */
  hasWings: boolean;
  /** 四肢/鳍颜色（空串 = 跟随 bodyColor） */
  pawColor: string;
  cheek: boolean;
  desc: string;
}

/** 头身一体物种：头画进身体轮廓，无独立头部件（头部摆动动画对其无效） */
const ONE_PIECE: ReadonlySet<PetDesign['species']> = new Set(['penguin', 'bird', 'slime', 'aquatic']);

export const isOnePieceSpecies = (d: PetDesign): boolean => ONE_PIECE.has(d.species);

/** pawColor 兼容旧资源（空串跟随 bodyColor） */
export function pawColorOf(d: PetDesign): string {
  return d.pawColor && /^#[0-9a-fA-F]{6}$/.test(d.pawColor) ? d.pawColor : d.bodyColor;
}

/** GIF 动效参数（与后端 ai.service 的 PetMotion 对应；swaySpeed 仅前端内部使用） */
export interface PetMotion {
  bounceAmp: number;
  bounceSpeed: number;
  blinkRate: number;
  tailWag: number;
  tailSpeed: number;
  swayAmp: number;
  swaySpeed?: number;
}

/** 单帧姿态：整体位移 / 尾巴角度 / 眼睛开合 / 呼吸缩放 / 头部倾角 */
export interface PetPose {
  bounce: number;
  sway: number;
  tailAngle: number;
  eyeOpen: number;
  breath: number;
  headTilt: number;
}

/** 静止姿态（形象图 / Live2D 部件源图共用） */
export const NEUTRAL_MOTION: PetMotion = {
  bounceAmp: 0, bounceSpeed: 0, blinkRate: 0, tailWag: 0, tailSpeed: 0, swayAmp: 0,
};

/**
 * 将动效速度量化到指定循环时长：让各正弦分量的周期整除循环时长，
 * 保证 GIF 最后一帧与第一帧姿态衔接，循环播放不跳变。预览与 GIF 编码须共用同一结果。
 */
export function quantizeMotionToLoop(motion: PetMotion, loopMs: number): PetMotion {
  const T = loopMs / 1000;
  // 弹跳 |sin(π·s·t)| 周期 1/s → s·T 取整；摇摆/尾巴 sin(2π·f·t) → f·T 取整
  const qFreq = (f: number) => (f <= 0 ? 0 : Math.max(1, Math.round(f * T)) / T);
  const blinkInterval = motion.blinkRate > 0 ? 10 / motion.blinkRate : 0;
  // 眨眼间隔对齐循环（起始时刻落在循环边界上，闭眼过程不会跨越接缝）
  const qInterval = blinkInterval > 0 ? T * Math.max(1, Math.round(blinkInterval / T)) : 0;
  return {
    bounceAmp: motion.bounceAmp,
    bounceSpeed: qFreq(motion.bounceSpeed),
    blinkRate: qInterval > 0 ? 10 / qInterval : 0,
    tailWag: motion.tailWag,
    tailSpeed: qFreq(motion.tailSpeed * 0.5) * 2,
    swayAmp: motion.swayAmp,
    swaySpeed: qFreq(0.6),
  };
}

/** 按动效参数计算 t 时刻姿态（GIF 逐帧 / 面板预览共用） */
export function computePetPose(motion: PetMotion, tMs: number): PetPose {
  const t = tMs / 1000;
  const bounce = motion.bounceAmp * Math.abs(Math.sin(Math.PI * motion.bounceSpeed * t));
  const sway = motion.swayAmp * Math.sin(2 * Math.PI * (motion.swaySpeed ?? 0.6) * t);
  const tailAngle = motion.tailWag * Math.sin(2 * Math.PI * motion.tailSpeed * 0.5 * t);
  let eyeOpen = 1;
  if (motion.blinkRate > 0) {
    const interval = 10 / motion.blinkRate;
    const phase = t % interval;
    if (phase < 0.32) eyeOpen = Math.max(0.08, 1 - Math.sin((Math.PI * phase) / 0.32) * 0.92);
  }
  const breath = 0.025 * Math.sin(2 * Math.PI * 0.9 * t);
  return { bounce, sway, tailAngle, eyeOpen, breath, headTilt: 0 };
}

function darken(hex: string, ratio: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * (1 - ratio));
  const g = Math.round(((n >> 8) & 255) * (1 - ratio));
  const b = Math.round((n & 255) * (1 - ratio));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

type Ctx = CanvasRenderingContext2D;

function strokeShape(ctx: Ctx, outline: string): void {
  ctx.strokeStyle = outline;
  ctx.lineWidth = 3;
  ctx.stroke();
}

const rad = (deg: number) => (deg * Math.PI) / 180;

// ---- 尾巴（围绕尾根 210,220 旋转；画在最底层，根部被身体遮挡）----
function paintTail(ctx: Ctx, d: PetDesign, angleDeg: number): void {
  const outline = darken(d.bodyColor, 0.4);
  const paw = pawColorOf(d);
  ctx.save();
  ctx.translate(210, 220);
  ctx.rotate(rad(angleDeg));
  ctx.translate(-210, -220);
  // 水生物种：新月形尾鳍
  if (d.species === 'aquatic') {
    ctx.fillStyle = paw;
    ctx.beginPath();
    ctx.moveTo(216, 220);
    ctx.quadraticCurveTo(268, 214, 282, 172);
    ctx.quadraticCurveTo(272, 214, 284, 246);
    ctx.quadraticCurveTo(262, 224, 216, 220);
    ctx.closePath();
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.restore();
    return;
  }
  // 鸟类：三片扇形尾羽
  if (d.species === 'bird') {
    ctx.fillStyle = paw;
    for (const [dy, rot] of [[-10, -0.35], [0, 0], [10, 0.35]] as const) {
      ctx.save();
      ctx.translate(222, 205);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.ellipse(36, dy, 34, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      strokeShape(ctx, outline);
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  if (d.tailStyle === 'none') {
    ctx.restore();
    return;
  }
  ctx.fillStyle = d.bodyColor;
  if (d.tailStyle === 'curl') {
    ctx.strokeStyle = d.bodyColor;
    ctx.lineWidth = 22;
    ctx.beginPath();
    ctx.moveTo(210, 220);
    ctx.quadraticCurveTo(262, 210, 248, 140);
    ctx.stroke();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(210, 209);
    ctx.quadraticCurveTo(251, 202, 239, 143);
    ctx.stroke();
  } else if (d.tailStyle === 'straight') {
    ctx.save();
    ctx.translate(222, 200);
    ctx.rotate(-0.55);
    ctx.beginPath();
    ctx.ellipse(28, 0, 42, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.restore();
  } else {
    ctx.save();
    ctx.translate(224, 190);
    ctx.rotate(-0.4);
    ctx.beginPath();
    ctx.ellipse(26, 0, 40, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = d.bellyColor;
    ctx.beginPath();
    ctx.ellipse(42, -4, 12, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ---- 单侧耳朵（side=-1 左 / 1 右，右侧镜像绘制；跟随头部倾角）----
function paintEar(ctx: Ctx, d: PetDesign, side: -1 | 1, tiltDeg: number): void {
  if (d.earShape === 'none') return;
  const outline = darken(d.bodyColor, 0.4);
  ctx.save();
  // 耳朵与头部同轴（150,150）旋转，保证倾角时耳头一体
  if (tiltDeg) {
    ctx.translate(150, 150);
    ctx.rotate(rad(tiltDeg));
    ctx.translate(-150, -150);
  }
  if (side === 1) {
    ctx.translate(300, 0);
    ctx.scale(-1, 1);
  }
  ctx.fillStyle = d.earColor;
  if (d.earShape === 'pointy') {
    ctx.beginPath();
    ctx.moveTo(100, 70);
    ctx.lineTo(110, 10);
    ctx.lineTo(150, 44);
    ctx.closePath();
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = '#ffc9d6';
    ctx.beginPath();
    ctx.moveTo(107, 56);
    ctx.lineTo(113, 26);
    ctx.lineTo(134, 42);
    ctx.closePath();
    ctx.fill();
  } else if (d.earShape === 'round') {
    ctx.beginPath();
    ctx.arc(104, 50, 21, 0, Math.PI * 2);
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = '#ffc9d6';
    ctx.beginPath();
    ctx.arc(104, 52, 10, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(114, 40, 17, 44, 0, 0, Math.PI * 2);
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = '#ffc9d6';
    ctx.beginPath();
    ctx.ellipse(114, 42, 8, 27, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---- 翅膀（龙膜翅 / 通用水滴翅；画在身体后侧，随整体呼吸）----
function paintWings(ctx: Ctx, d: PetDesign, breath: number): void {
  const outline = darken(d.bodyColor, 0.4);
  const paw = pawColorOf(d);
  ctx.save();
  if (breath) {
    ctx.translate(150, 262);
    ctx.scale(1 + breath * 0.6, 1 + breath);
    ctx.translate(-150, -262);
  }
  for (const side of [-1, 1] as const) {
    ctx.save();
    if (side === 1) {
      ctx.translate(300, 0);
      ctx.scale(-1, 1);
    }
    ctx.fillStyle = paw;
    if (d.species === 'dragon') {
      // 膜翅：三指折边
      ctx.beginPath();
      ctx.moveTo(112, 150);
      ctx.lineTo(30, 108);
      ctx.lineTo(64, 146);
      ctx.lineTo(26, 176);
      ctx.lineTo(66, 182);
      ctx.lineTo(48, 224);
      ctx.closePath();
      ctx.fill();
      strokeShape(ctx, outline);
    } else {
      // 水滴翅（鸟等）
      ctx.save();
      ctx.translate(104, 168);
      ctx.rotate(side * -0.5);
      ctx.beginPath();
      ctx.ellipse(0, 0, 48, 20, 0, 0, Math.PI * 2);
      ctx.fill();
      strokeShape(ctx, outline);
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}

// ---- 身体 + 肚皮 + 前爪/鳍肢 + 身体花纹（呼吸：绕底部 150,262 纵向缩放）----
function paintBody(ctx: Ctx, d: PetDesign, breath: number): void {
  const outline = darken(d.bodyColor, 0.4);
  const paw = pawColorOf(d);
  ctx.save();
  if (breath) {
    ctx.translate(150, 262);
    ctx.scale(1 + breath * 0.6, 1 + breath);
    ctx.translate(-150, -262);
  }
  ctx.fillStyle = d.bodyColor;
  if (d.species === 'penguin') {
    // 直立水滴：头身一体（顶 62 → 底 268）
    ctx.beginPath();
    ctx.moveTo(150, 62);
    ctx.bezierCurveTo(84, 74, 58, 150, 62, 196);
    ctx.bezierCurveTo(66, 246, 106, 268, 150, 268);
    ctx.bezierCurveTo(194, 268, 234, 246, 238, 196);
    ctx.bezierCurveTo(242, 150, 216, 74, 150, 62);
    ctx.closePath();
    ctx.fill();
    strokeShape(ctx, outline);
    // 白肚皮
    ctx.fillStyle = d.bellyColor;
    ctx.beginPath();
    ctx.ellipse(150, 206, 58, 62, 0, 0, Math.PI * 2);
    ctx.fill();
    // 鳍肢
    ctx.fillStyle = paw;
    for (const [fx, rot] of [[62, 0.5], [238, -0.5]] as const) {
      ctx.save();
      ctx.translate(fx, 186);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, 15, 42, 0, 0, Math.PI * 2);
      ctx.fill();
      strokeShape(ctx, outline);
      ctx.restore();
    }
    // 橙蹼脚
    ctx.fillStyle = paw;
    for (const cx of [124, 176]) {
      ctx.beginPath();
      ctx.ellipse(cx, 264, 16, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      strokeShape(ctx, outline);
    }
    // 橙喙 + 腮红
    ctx.fillStyle = paw;
    ctx.beginPath();
    ctx.moveTo(138, 116);
    ctx.lineTo(162, 116);
    ctx.lineTo(150, 130);
    ctx.closePath();
    ctx.fill();
    strokeShape(ctx, outline);
  } else if (d.species === 'bird') {
    // 圆头身一体 + 细腿
    ctx.beginPath();
    ctx.ellipse(150, 172, 80, 74, 0, 0, Math.PI * 2);
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = d.bellyColor;
    ctx.beginPath();
    ctx.ellipse(150, 196, 48, 44, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 3;
    for (const cx of [132, 168]) {
      ctx.beginPath();
      ctx.moveTo(cx, 238);
      ctx.lineTo(cx, 262);
      ctx.stroke();
      ctx.fillStyle = paw;
      ctx.beginPath();
      ctx.ellipse(cx, 264, 14, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      strokeShape(ctx, outline);
    }
    ctx.fillStyle = paw;
    ctx.beginPath();
    ctx.moveTo(136, 112);
    ctx.lineTo(164, 112);
    ctx.lineTo(150, 128);
    ctx.closePath();
    ctx.fill();
    strokeShape(ctx, outline);
  } else if (d.species === 'slime') {
    // 果冻半圆 + 底部波浪 + 高光
    ctx.beginPath();
    ctx.moveTo(58, 254);
    ctx.quadraticCurveTo(56, 148, 150, 142);
    ctx.quadraticCurveTo(244, 148, 242, 254);
    for (const [x1, x2] of [[242, 192], [192, 150], [150, 108], [108, 58]] as const) {
      ctx.quadraticCurveTo((x1 + x2) / 2, 268, x2, 254);
    }
    ctx.closePath();
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = d.bellyColor;
    ctx.beginPath();
    ctx.ellipse(150, 236, 54, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(116, 186, 16, 10, -0.6, 0, Math.PI * 2);
    ctx.fill();
  } else if (d.species === 'aquatic') {
    // 流线纺锤 + 侧鳍
    ctx.beginPath();
    ctx.ellipse(150, 196, 92, 62, 0, 0, Math.PI * 2);
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = d.bellyColor;
    ctx.beginPath();
    ctx.ellipse(150, 214, 62, 36, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = paw;
    for (const fx of [96, 204]) {
      ctx.save();
      ctx.translate(fx, 214);
      ctx.rotate(fx < 150 ? 0.5 : -0.5);
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(0, 8);
      ctx.lineTo(fx < 150 ? -26 : 26, 16);
      ctx.closePath();
      ctx.fill();
      strokeShape(ctx, outline);
      ctx.restore();
    }
  } else {
    // 两段式物种：椭圆身（bear/panda 更胖，rabbit 略窄）
    const fat = d.species === 'bear' || d.species === 'panda' ? 1.1 : 1;
    ctx.beginPath();
    ctx.ellipse(150, 195, 82 * fat, 66, 0, 0, Math.PI * 2);
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = d.bellyColor;
    ctx.beginPath();
    ctx.ellipse(150, 214, 50 * fat, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    // 前爪
    ctx.fillStyle = paw;
    for (const cx of [118, 182]) {
      ctx.beginPath();
      ctx.ellipse(cx, 254, 22, 13, 0, 0, Math.PI * 2);
      ctx.fill();
      strokeShape(ctx, outline);
    }
  }
  // 身体花纹
  if (d.pattern === 'stripes') {
    ctx.strokeStyle = d.patternColor;
    ctx.lineWidth = 7;
    for (const [x1, y1, x2, y2] of [[104, 168, 128, 176], [196, 168, 172, 176]] as const) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  } else if (d.pattern === 'spots') {
    ctx.fillStyle = d.patternColor;
    for (const [x, y, r] of [[112, 162, 10], [188, 172, 9], [133, 228, 8], [172, 146, 7]] as const) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---- 头部 + 头顶花纹 + 鼻嘴 + 腮红 + 胡须（绕颈部 150,150 旋转；头身一体物种由身体层绘制，返回；hideFace 仅保留轮廓与花纹用于背面视图）----
function paintHead(ctx: Ctx, d: PetDesign, tiltDeg: number, opts?: ViewOpts): void {
  if (ONE_PIECE.has(d.species)) return;
  const outline = darken(d.bodyColor, 0.4);
  ctx.save();
  if (tiltDeg) {
    ctx.translate(150, 150);
    ctx.rotate(rad(tiltDeg));
    ctx.translate(-150, -150);
  }
  ctx.fillStyle = d.bodyColor;
  ctx.beginPath();
  ctx.arc(150, 98, 62, 0, Math.PI * 2);
  ctx.fill();
  strokeShape(ctx, outline);
  // 头顶花纹
  if (d.pattern === 'stripes') {
    ctx.strokeStyle = d.patternColor;
    ctx.lineWidth = 7;
    for (const [x1, y1, x2, y2] of [[134, 46, 137, 64], [150, 42, 150, 64], [166, 46, 163, 64]] as const) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  } else if (d.pattern === 'spots') {
    ctx.fillStyle = d.patternColor;
    for (const [x, y, r] of [[124, 64, 6], [178, 66, 6]] as const) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (opts?.hideFace) {
    ctx.restore();
    return;
  }
  // 鼻与嘴（狐：白色尖吻 + 黑鼻头；其余：粉色三角鼻 + w 嘴）
  if (d.species === 'fox') {
    ctx.fillStyle = d.bellyColor;
    ctx.beginPath();
    ctx.ellipse(150, 118, 30, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    strokeShape(ctx, outline);
    ctx.fillStyle = '#3a2a20';
    ctx.beginPath();
    ctx.arc(150, 112, 5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = '#e8836f';
    ctx.beginPath();
    ctx.moveTo(144, 106);
    ctx.lineTo(156, 106);
    ctx.lineTo(150, 112);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = d.eyeColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(150, 112);
    ctx.quadraticCurveTo(144, 120, 138, 115);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(150, 112);
    ctx.quadraticCurveTo(156, 120, 162, 115);
    ctx.stroke();
  }
  // 腮红
  if (d.cheek) {
    ctx.fillStyle = 'rgba(255,140,150,0.45)';
    for (const cx of [108, 192]) {
      ctx.beginPath();
      ctx.arc(cx, 116, 11, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 胡须（尖耳物种）
  if (d.earShape === 'pointy') {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      for (const [dy, len] of [[-3, 30], [4, 26]] as const) {
        ctx.beginPath();
        ctx.moveTo(150 + side * 72, 104 + dy);
        ctx.lineTo(150 + side * (72 + len), 100 + dy * 2);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** 三视图绘制选项：hideFace=隐藏五官（背面视图）；singleSide=只画单侧耳与单眼（侧面视图） */
interface ViewOpts {
  hideFace?: boolean;
  singleSide?: -1 | 1;
}

// ---- 眼睛（按物种定位；panda 黑眼圈；跟随头部倾角 + 眨眼纵向缩放；singleSide 仅画一侧眼）----
function paintEyes(ctx: Ctx, d: PetDesign, pose: PetPose, opts?: ViewOpts): void {
  ctx.save();
  if (pose.headTilt) {
    ctx.translate(150, 150);
    ctx.rotate(rad(pose.headTilt));
    ctx.translate(-150, -150);
  }
  // 一体物种头区位置不同；鱼眼偏两侧
  const [lx, rx, ey] = d.species === 'penguin' ? [127, 173, 104]
    : d.species === 'bird' ? [127, 173, 108]
    : d.species === 'slime' ? [122, 178, 186]
    : d.species === 'aquatic' ? [118, 182, 178]
    : [127, 173, 94];
  const eyeXs = opts?.singleSide === -1 ? [lx] : opts?.singleSide === 1 ? [rx] : [lx, rx];
  // 一体物种腮红（两段式在头部层绘制）
  if (d.cheek && ONE_PIECE.has(d.species)) {
    ctx.fillStyle = 'rgba(255,140,150,0.45)';
    for (const cx of [lx - 18, rx + 18]) {
      ctx.beginPath();
      ctx.arc(cx, ey + 14, 11, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const cx of eyeXs) {
    ctx.save();
    ctx.translate(cx, ey);
    ctx.scale(1, pose.eyeOpen);
    if (d.species === 'panda') {
      ctx.fillStyle = d.eyeColor;
      ctx.beginPath();
      ctx.ellipse(0, 0, 15, 13, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = d.eyeColor;
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(3, -3, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** 物种是否始终有尾/尾鳍/尾羽（aquatic 尾鳍、bird 尾羽不依赖 hasTail） */
const hasTailVisual = (d: PetDesign): boolean =>
  d.hasTail || d.species === 'aquatic' || d.species === 'bird';

/** 按姿态在 300x300 透明画布上绘制完整宠物（分层顺序：翅 → 尾 → 耳 → 身体 → 头 → 眼；opts 用于三视图变体） */
export function paintPet(ctx: Ctx, d: PetDesign, pose: PetPose, opts?: ViewOpts): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // 头身一体物种无独立头部件，头部摆动置 0
  const tilt = ONE_PIECE.has(d.species) ? 0 : pose.headTilt;
  ctx.translate(pose.sway, -pose.bounce);
  if (d.hasWings && d.species !== 'penguin') paintWings(ctx, d, pose.breath);
  if (hasTailVisual(d)) paintTail(ctx, d, pose.tailAngle);
  if (!opts?.singleSide || opts.singleSide === -1) paintEar(ctx, d, -1, tilt);
  if (!opts?.singleSide || opts.singleSide === 1) paintEar(ctx, d, 1, tilt);
  paintBody(ctx, d, pose.breath);
  paintHead(ctx, d, tilt, opts);
  if (!opts?.hideFace) paintEyes(ctx, d, { ...pose, headTilt: tilt }, opts);
  ctx.restore();
}

/** 按姿态渲染一帧（GIF 逐帧 / 面板动画预览共用） */
export function drawPetFrame(canvas: HTMLCanvasElement, d: PetDesign, motion: PetMotion, tMs: number): void {
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, 300, 300);
  paintPet(ctx, d, computePetPose(motion, tMs));
}

/** 按形象参数在 300x300 透明底画布上绘制静态卡通宠物（参数化形状，代码保证成图质量） */
export function drawPetDesign(canvas: HTMLCanvasElement, d: PetDesign): void {
  drawPetFrame(canvas, d, NEUTRAL_MOTION, 0);
}

/** live2d-lite 分层部件：每个部件独立一张 300x300 透明 PNG（绘制于静止姿态） */
export type PetPartId = 'tail' | 'earL' | 'earR' | 'body' | 'head' | 'eyes';

/** 绘制单个部件源图（部件不含姿态变换，动效由客户端轻量渲染器按参数驱动） */
export function drawPetPart(canvas: HTMLCanvasElement, part: PetPartId, d: PetDesign): void {
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, 300, 300);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const neutral: PetPose = { bounce: 0, sway: 0, tailAngle: 0, eyeOpen: 1, breath: 0, headTilt: 0 };
  switch (part) {
    case 'tail': if (hasTailVisual(d)) paintTail(ctx, d, 0); break;
    case 'earL': paintEar(ctx, d, -1, 0); break;
    case 'earR': paintEar(ctx, d, 1, 0); break;
    case 'body': paintBody(ctx, d, 0); break;
    case 'head': paintHead(ctx, d, 0); break; // 头身一体物种为空图（头部由身体层绘制）
    case 'eyes': paintEyes(ctx, d, neutral); break;
  }
}

// ==================== 三视图与骨骼绑定（分步生成预览用，线框不进入成品资源） ====================

/** 三视图类型：front=正面（成品视角） side=侧面 back=背面 */
export type PetView = 'front' | 'side' | 'back';

const NEUTRAL_POSE: PetPose = { bounce: 0, sway: 0, tailAngle: 0, eyeOpen: 1, breath: 0, headTilt: 0 };

/**
 * 绘制宠物三视图之一（300x300）。side：水平压缩 ~0.78 + 只画近侧（右）耳与单眼模拟侧身；
 * back：隐藏五官，仅保留轮廓、花纹、耳/尾/翅膀（用于确认背面花纹与尾部绑定）。
 */
export function paintPetView(ctx: Ctx, d: PetDesign, view: PetView): void {
  if (view === 'front') {
    paintPet(ctx, d, NEUTRAL_POSE);
    return;
  }
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (view === 'side') {
    ctx.translate(150, 0);
    ctx.scale(0.78, 1);
    ctx.translate(-150, 0);
    paintPet(ctx, d, NEUTRAL_POSE, { singleSide: 1 });
  } else {
    paintPet(ctx, d, NEUTRAL_POSE, { hideFace: true });
  }
  ctx.restore();
}

/** 在画布上绘制指定三视图（300x300 透明底；骨骼线框须在调用后另行 drawBoneOverlay 叠加） */
export function drawPetView(canvas: HTMLCanvasElement, d: PetDesign, view: PetView): void {
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, 300, 300);
  paintPetView(ctx, d, view);
}

/** 骨骼绑定部位矩形（300x300 坐标系，与 paintPet 绘制坐标一致），标识四肢/头部等动画变形锚点 */
export interface PetBoneRect {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 骨骼绑定映射：头/身/四肢/尾（动画与 Live2D rig 按锚点变形的部位参照） */
export interface PetBoneMap {
  head: PetBoneRect;
  body: PetBoneRect;
  limbs: PetBoneRect[];
  tail?: PetBoneRect;
}

/** 按物种推导骨骼绑定锚点（坐标对应 paintPet 各部件绘制区域；slime 无肢无尾） */
export function boneMapOf(d: PetDesign): PetBoneMap {
  const s = d.species;
  if (s === 'penguin') {
    return {
      head: { id: 'head', label: '头部', x: 94, y: 62, w: 112, h: 70 },
      body: { id: 'body', label: '身体', x: 64, y: 132, w: 172, h: 136 },
      limbs: [
        { id: 'finL', label: '左鳍', x: 44, y: 146, w: 34, h: 82 },
        { id: 'finR', label: '右鳍', x: 222, y: 146, w: 34, h: 82 },
        { id: 'footL', label: '左脚', x: 106, y: 252, w: 38, h: 18 },
        { id: 'footR', label: '右脚', x: 156, y: 252, w: 38, h: 18 },
      ],
    };
  }
  if (s === 'bird') {
    return {
      head: { id: 'head', label: '头部', x: 100, y: 94, w: 100, h: 76 },
      body: { id: 'body', label: '身体', x: 70, y: 152, w: 160, h: 94 },
      limbs: [
        { id: 'legL', label: '左腿', x: 118, y: 230, w: 28, h: 38 },
        { id: 'legR', label: '右腿', x: 154, y: 230, w: 28, h: 38 },
        { id: 'wingL', label: '左翅', x: 52, y: 146, w: 52, h: 44 },
        { id: 'wingR', label: '右翅', x: 196, y: 146, w: 52, h: 44 },
      ],
      tail: { id: 'tail', label: '尾羽', x: 188, y: 184, w: 86, h: 44 },
    };
  }
  if (s === 'slime') {
    return {
      head: { id: 'head', label: '头部', x: 92, y: 144, w: 116, h: 64 },
      body: { id: 'body', label: '身体', x: 58, y: 200, w: 184, h: 68 },
      limbs: [],
    };
  }
  if (s === 'aquatic') {
    return {
      head: { id: 'head', label: '头部', x: 90, y: 148, w: 120, h: 78 },
      body: { id: 'body', label: '身体', x: 58, y: 134, w: 184, h: 124 },
      limbs: [
        { id: 'finL', label: '左鳍', x: 66, y: 196, w: 56, h: 34 },
        { id: 'finR', label: '右鳍', x: 178, y: 196, w: 56, h: 34 },
      ],
      tail: { id: 'tail', label: '尾鳍', x: 214, y: 166, w: 74, h: 84 },
    };
  }
  // 两段式物种（cat/rabbit/bear/fox/panda/dragon）：独立头 + 椭圆身 + 前爪
  const fat = s === 'bear' || s === 'panda' ? 1.1 : 1;
  const bw = Math.round(164 * fat);
  const limbs: PetBoneRect[] = [
    { id: 'pawL', label: '左爪', x: 94, y: 240, w: 48, h: 28 },
    { id: 'pawR', label: '右爪', x: 158, y: 240, w: 48, h: 28 },
  ];
  if (d.hasWings) {
    limbs.push(
      s === 'dragon'
        ? { id: 'wingL', label: '左翅', x: 22, y: 96, w: 92, h: 78 }
        : { id: 'wingL', label: '左翅', x: 50, y: 128, w: 54, h: 46 },
      s === 'dragon'
        ? { id: 'wingR', label: '右翅', x: 186, y: 96, w: 92, h: 78 }
        : { id: 'wingR', label: '右翅', x: 196, y: 128, w: 54, h: 46 },
    );
  }
  return {
    head: { id: 'head', label: '头部', x: 88, y: 36, w: 124, h: 124 },
    body: { id: 'body', label: '身体', x: Math.round(150 - bw / 2), y: 129, w: bw, h: 132 },
    limbs,
    tail: hasTailVisual(d) ? { id: 'tail', label: '尾巴', x: 208, y: 138, w: 84, h: 96 } : undefined,
  };
}

const BONE_COLORS: Record<string, string> = {
  head: '#e05656',
  body: '#3a7bd5',
  limb: '#2ba14a',
  tail: '#8e44ad',
};

/** 在三视图上叠加骨骼绑定可视化（骨骼连线 + 关节点 + 虚线部位框与标签；仅预览，不进入成品） */
export function drawBoneOverlay(ctx: Ctx, bones: PetBoneMap): void {
  ctx.save();
  ctx.font = '10px sans-serif';
  const center = (b: PetBoneRect) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const boxes: Array<[PetBoneRect, string]> = [
    [bones.head, BONE_COLORS.head],
    [bones.body, BONE_COLORS.body],
    ...bones.limbs.map((b) => [b, BONE_COLORS.limb] as [PetBoneRect, string]),
  ];
  if (bones.tail) boxes.push([bones.tail, BONE_COLORS.tail]);
  // 骨骼连线：脊柱（头→身）与四肢/尾分支
  const bodyC = center(bones.body);
  const headC = center(bones.head);
  ctx.strokeStyle = 'rgba(20,20,20,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(headC.x, headC.y + bones.head.h / 2);
  ctx.lineTo(bodyC.x, bodyC.y);
  for (const b of [...bones.limbs, ...(bones.tail ? [bones.tail] : [])]) {
    const p = center(b);
    ctx.moveTo(bodyC.x, bodyC.y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  // 部位虚线框 + 标签 + 关节点
  for (const [b, color] of boxes) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.fillText(b.label, b.x + 2, b.y + 11);
    const p = center(b);
    ctx.fillStyle = 'rgba(20,20,20,0.6)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
