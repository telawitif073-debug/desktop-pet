/**
 * 精灵表动画驱动（路径A 客户端渲染）：
 * 基纹理按 6列×N行 切分为帧纹理；按各状态 fps 以 deltaMS 累计步进（非 1:1 raf），
 * setAnimation 切换状态行并从头播放。animations.json 结构与平台后端 spritesheet.ts 产出一致。
 */

import { Rectangle, Texture, type Sprite } from 'pixi.js';

export interface SpriteAnimationMeta {
  /** 精灵表中的行号（0 起） */
  row: number;
  frames: number;
  fps: number;
}

export interface SpriteAnimationsConfig {
  frameWidth: number;
  frameHeight: number;
  animations: Record<string, SpriteAnimationMeta>;
}

export class SpriteAnimator {
  private readonly textures = new Map<string, Texture[]>();
  private readonly meta: SpriteAnimationsConfig;
  private currentName = '';
  private index = 0;
  private elapsed = 0;

  constructor(private readonly sprite: Sprite, baseTexture: Texture, meta: SpriteAnimationsConfig) {
    this.meta = meta;
    const source = baseTexture.source;
    const cols = Math.max(1, Math.floor(baseTexture.width / meta.frameWidth));
    for (const [name, cfg] of Object.entries(meta.animations)) {
      const frames: Texture[] = [];
      for (let i = 0; i < cfg.frames; i += 1) {
        frames.push(new Texture({
          source,
          frame: new Rectangle((i % cols) * meta.frameWidth, cfg.row * meta.frameHeight, meta.frameWidth, meta.frameHeight),
        }));
      }
      this.textures.set(name, frames);
    }
    this.currentName = this.textures.has('idle') ? 'idle' : [...this.textures.keys()][0] ?? '';
    const first = this.framesOf(this.currentName)[0];
    if (first) this.sprite.texture = first;
  }

  get config(): SpriteAnimationsConfig {
    return this.meta;
  }

  get animation(): string {
    return this.currentName;
  }

  has(name: string): boolean {
    return this.textures.has(name);
  }

  /** 切换状态动画（从头播放；同名或未知状态忽略） */
  setAnimation(name: string): void {
    if (!this.textures.has(name) || name === this.currentName) return;
    this.currentName = name;
    this.index = 0;
    this.elapsed = 0;
    const first = this.framesOf(name)[0];
    if (first) this.sprite.texture = first;
  }

  /** 按当前状态 fps 步进帧序号（ticker 每帧调用，deltaMs 为毫秒） */
  update(deltaMs: number): void {
    const frames = this.framesOf(this.currentName);
    const cfg = this.meta.animations[this.currentName];
    if (!frames || !cfg || cfg.fps <= 0) return;
    this.elapsed += deltaMs;
    const step = 1000 / cfg.fps;
    while (this.elapsed >= step) {
      this.elapsed -= step;
      this.index = (this.index + 1) % frames.length;
      this.sprite.texture = frames[this.index];
    }
  }

  private framesOf(name: string): Texture[] {
    return this.textures.get(name) ?? [];
  }
}
