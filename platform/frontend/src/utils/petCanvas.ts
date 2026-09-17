/** AI 生成的宠物形象参数（与后端 ai.service 的 PetDesign 对应） */
export interface PetDesign {
  name: string;
  bodyColor: string;
  bellyColor: string;
  earShape: 'pointy' | 'round' | 'long';
  earColor: string;
  eyeColor: string;
  pattern: 'none' | 'stripes' | 'spots';
  patternColor: string;
  hasTail: boolean;
  tailStyle: 'curl' | 'straight' | 'fluffy';
  cheek: boolean;
  desc: string;
}

function darken(hex: string, ratio: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * (1 - ratio));
  const g = Math.round(((n >> 8) & 255) * (1 - ratio));
  const b = Math.round((n & 255) * (1 - ratio));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** 按形象参数在 300x300 透明底画布上绘制卡通宠物（参数化形状，代码保证成图质量） */
export function drawPetDesign(canvas: HTMLCanvasElement, d: PetDesign): void {
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, 300, 300);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const outline = darken(d.bodyColor, 0.4);
  const stroke = () => { ctx.strokeStyle = outline; ctx.lineWidth = 3; ctx.stroke(); };

  // ---- 尾巴（先画，根部被身体遮挡）----
  if (d.hasTail) {
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
      stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.translate(224, 190);
      ctx.rotate(-0.4);
      ctx.beginPath();
      ctx.ellipse(26, 0, 40, 26, 0, 0, Math.PI * 2);
      ctx.fill();
      stroke();
      ctx.fillStyle = d.bellyColor;
      ctx.beginPath();
      ctx.ellipse(42, -4, 12, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---- 耳朵（画在头之前，耳根被头部遮挡）----
  ctx.fillStyle = d.earColor;
  if (d.earShape === 'pointy') {
    const ear = (pts: [number, number][]) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.closePath();
      ctx.fill();
      stroke();
    };
    ear([[100, 70], [110, 10], [150, 44]]);
    ear([[200, 70], [190, 10], [150, 44]]);
    ctx.fillStyle = '#ffc9d6';
    const inner = (pts: [number, number][]) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.closePath();
      ctx.fill();
    };
    inner([[107, 56], [113, 26], [134, 42]]);
    inner([[193, 56], [187, 26], [166, 42]]);
  } else if (d.earShape === 'round') {
    for (const cx of [104, 196]) {
      ctx.fillStyle = d.earColor;
      ctx.beginPath();
      ctx.arc(cx, 50, 21, 0, Math.PI * 2);
      ctx.fill();
      stroke();
      ctx.fillStyle = '#ffc9d6';
      ctx.beginPath();
      ctx.arc(cx, 52, 10, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    for (const cx of [114, 186]) {
      ctx.fillStyle = d.earColor;
      ctx.beginPath();
      ctx.ellipse(cx, 40, 17, 44, 0, 0, Math.PI * 2);
      ctx.fill();
      stroke();
      ctx.fillStyle = '#ffc9d6';
      ctx.beginPath();
      ctx.ellipse(cx, 42, 8, 27, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- 身体与肚皮 ----
  ctx.fillStyle = d.bodyColor;
  ctx.beginPath();
  ctx.ellipse(150, 195, 82, 66, 0, 0, Math.PI * 2);
  ctx.fill();
  stroke();
  ctx.fillStyle = d.bellyColor;
  ctx.beginPath();
  ctx.ellipse(150, 214, 50, 40, 0, 0, Math.PI * 2);
  ctx.fill();

  // 前爪
  ctx.fillStyle = d.bodyColor;
  for (const cx of [118, 182]) {
    ctx.beginPath();
    ctx.ellipse(cx, 254, 22, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    stroke();
  }

  // ---- 头部 ----
  ctx.fillStyle = d.bodyColor;
  ctx.beginPath();
  ctx.arc(150, 98, 62, 0, Math.PI * 2);
  ctx.fill();
  stroke();

  // ---- 花纹 ----
  if (d.pattern === 'stripes') {
    ctx.strokeStyle = d.patternColor;
    ctx.lineWidth = 7;
    const lines: [number, number, number, number][] = [
      [134, 46, 137, 64], [150, 42, 150, 64], [166, 46, 163, 64],
      [104, 168, 128, 176], [196, 168, 172, 176],
    ];
    for (const [x1, y1, x2, y2] of lines) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  } else if (d.pattern === 'spots') {
    ctx.fillStyle = d.patternColor;
    for (const [x, y, r] of [[112, 162, 10], [188, 172, 9], [133, 228, 8], [172, 146, 7], [124, 64, 6], [178, 66, 6]] as const) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- 眼睛 ----
  ctx.fillStyle = d.eyeColor;
  for (const cx of [127, 173]) {
    ctx.beginPath();
    ctx.arc(cx, 94, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (const cx of [130, 176]) {
    ctx.beginPath();
    ctx.arc(cx, 91, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- 鼻与嘴 ----
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

  // ---- 腮红 ----
  if (d.cheek) {
    ctx.fillStyle = 'rgba(255,140,150,0.45)';
    for (const cx of [108, 192]) {
      ctx.beginPath();
      ctx.arc(cx, 116, 11, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- 胡须（尖耳物种）----
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
}
