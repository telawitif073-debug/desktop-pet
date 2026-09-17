import { useEffect, useRef, useState, useCallback } from 'react';
import * as PIXI from 'pixi.js';
import petImg from './assets/pet.png';
import { usePetStore } from './store/petStore';
import { useChatStore } from './store/chatStore';
import ChatPanel from './components/ChatPanel';
import ActionsPanel from './components/ActionsPanel';
import type { PetAction } from './global.d';

// 宠物窗口设置（资源库"设置"页调整，主进程实时推送变更）
interface PetWindowSettings {
  width: number;
  height: number;
  opacity: number;
}

// 宠物互动功能开关（资源库"设置"页调整，主进程实时推送变更）
interface PetFeatures {
  feedEnabled: boolean;
  restEnabled: boolean;
  playEnabled: boolean;
  affectionEnabled: boolean;
}
const DEFAULT_FEATURES: PetFeatures = { feedEnabled: true, restEnabled: true, playEnabled: true, affectionEnabled: true };

const App = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ hunger: 80, mood: 80, energy: 80, affection: 50 });
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // 动作系统：列表 ref（播放查找）+ 播放函数 ref（由 initPixi effect 注入，需访问 Pixi 实例）
  const petActionsRef = useRef<PetAction[]>([]);
  const playActionRef = useRef<((id: string) => void) | null>(null);
  // 当前播放中的动作 id + 立即停止回调：删除动作时用于中断播放并复位宠物
  const playingActionIdRef = useRef<string | null>(null);
  const stopActionRef = useRef<(() => void) | null>(null);
  const [petSettings, setPetSettings] = useState<PetWindowSettings>({ width: 300, height: 300, opacity: 1 });
  const [petFeatures, setPetFeatures] = useState<PetFeatures>(DEFAULT_FEATURES);
  // decay 定时器内通过 ref 读取，避免闭包过期（开关变更不重建 Pixi 实例）
  const featuresRef = useRef<PetFeatures>(DEFAULT_FEATURES);
  useEffect(() => { featuresRef.current = petFeatures; }, [petFeatures]);
  // 整页点击穿透：命中测试数据（sprite 矩形 + 可选 alpha 像素图），由 initPixi 在纹理加载后填充
  const ignoreRef = useRef(true);
  const hitRectRef = useRef<{ left: number; top: number; w: number; h: number } | null>(null);
  const hitAlphaRef = useRef<{ data: Uint8ClampedArray; w: number; h: number } | null>(null);

  const { hunger, mood, energy, affection, feed, play, rest, decay } = usePetStore();
  const { triggerGreeting } = useChatStore();

  useEffect(() => {
    stateRef.current = { hunger, mood, energy, affection };
    // Sync pet state to main process for LLM context
    window.electronAPI?.pet.stateUpdate({ hunger, mood, energy, affection });
  }, [hunger, mood, energy, affection]);

  // 读取宠物窗口设置与互动功能开关，并监听资源库设置页的实时变更
  useEffect(() => {
    let disposed = false;
    window.electronAPI?.config.get().then((config) => {
      if (!disposed) {
        if (config.petWindow) setPetSettings(config.petWindow);
        if (config.petFeatures) setPetFeatures({ ...DEFAULT_FEATURES, ...config.petFeatures });
      }
    }).catch(() => {});
    const cleanup = window.electronAPI?.onPetSettingsChanged((settings) => setPetSettings(settings));
    const cleanupFeatures = window.electronAPI?.onPetFeaturesChanged((features) => setPetFeatures({ ...DEFAULT_FEATURES, ...features }));
    return () => {
      disposed = true;
      cleanup?.();
      cleanupFeatures?.();
    };
  }, []);

  // 资源安装/卸载后主进程通知：重新加载宠物图片并重算可点击边界（不同宠物边界不同）
  const [assetVersion, setAssetVersion] = useState(0);
  useEffect(() => {
    const cleanup = window.electronAPI?.onPetAssetChanged(() => setAssetVersion((v) => v + 1));
    return cleanup;
  }, []);

  // 整页点击穿透：仅宠物本体（像素级命中）与 data-interactive 元素可交互
  useEffect(() => {
    let dragging = false;
    // 重载/重建后与主进程对齐初始穿透状态（渲染端默认整页穿透，mousemove 随后自动修正）
    window.electronAPI?.window.setIgnoreMouseEvents(true);
    const setIgnore = (v: boolean) => {
      if (ignoreRef.current !== v) {
        ignoreRef.current = v;
        window.electronAPI?.window.setIgnoreMouseEvents(v);
      }
    };
    const hitPet = (e: MouseEvent): boolean => {
      const rect = hitRectRef.current;
      const canvas = containerRef.current?.querySelector('canvas');
      if (!rect || !canvas) return false;
      // 命中矩形是画布本地坐标；聊天面板展开时宠物区域整体右移，须先换算为画布本地坐标
      const canvasRect = canvas.getBoundingClientRect();
      const localX = e.clientX - canvasRect.left;
      const localY = e.clientY - canvasRect.top;
      const { energy } = stateRef.current;
      // 与渲染 ticker 同公式：浮动动画实时改变本体纵向位置
      const amplitude = Math.min(10, 10 + (energy / 100) * 15);
      const speed = 0.5 + (energy / 100) * 1.5;
      const offsetY = Math.sin(Date.now() / (1000 / speed)) * amplitude;
      const top = rect.top + offsetY;
      if (localX < rect.left || localX > rect.left + rect.w) return false;
      if (localY < top || localY > top + rect.h) return false;
      const alpha = hitAlphaRef.current;
      if (!alpha) return true; // 无法提取 alpha 时退化为矩形命中
      const px = Math.floor((localX - rect.left) / rect.w * alpha.w);
      const py = Math.floor((localY - top) / rect.h * alpha.h);
      if (px < 0 || px >= alpha.w || py < 0 || py >= alpha.h) return false;
      return alpha.data[(py * alpha.w + px) * 4 + 3] > 16;
    };
    const onMove = (e: MouseEvent) => {
      const overUI = !!(e.target as Element | null)?.closest?.('[data-interactive]');
      const over = dragging || overUI || hitPet(e);
      setIgnore(!over);
      if (dragging && e.buttons === 1) {
        // 事件驱动相对移动：仅按真实鼠标增量移动窗口，事件停则窗口停
        window.electronAPI?.window.dragMove({ dx: e.movementX, dy: e.movementY });
      }
      if (!e.buttons && dragging) {
        // 兜底：漏收 mouseup 时结束拖拽
        dragging = false;
        window.electronAPI?.window.endDrag();
      }
    };
    const onDown = (e: MouseEvent) => {
      // 目标是按钮/聊天面板时不进入拖拽（部分按钮与宠物矩形重叠，避免点击时窗口被拖走）
      const overUI = !!(e.target as Element | null)?.closest?.('[data-interactive]');
      if (e.button === 0 && !overUI && hitPet(e)) {
        dragging = true;
        // 拖拽循环在主进程轮询光标完成，规避渲染端坐标在缩放屏上的偏差导致的漂移
        window.electronAPI?.window.beginDrag();
        setIgnore(false);
      }
    };
    const onUp = () => {
      if (dragging) {
        dragging = false;
        window.electronAPI?.window.endDrag();
      }
    };
    const onContextMenu = (e: MouseEvent) => {
      const overUI = !!(e.target as Element | null)?.closest?.('[data-interactive]');
      if (!overUI && hitPet(e)) {
        e.preventDefault();
        window.electronAPI?.window.showContextMenu();
      }
    };
    const onLeave = () => { if (!dragging) setIgnore(true); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('contextmenu', onContextMenu);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('contextmenu', onContextMenu);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      window.electronAPI?.window.endDrag();
    };
  }, []);

  // Handle proactive greeting trigger from main process (8.4)
  useEffect(() => {
    const cleanup = window.electronAPI?.onGreetingTrigger(() => {
      if (!chatOpen) {
        handleToggleChat(true);
      }
      triggerGreeting();
    });
    return cleanup;
  }, [chatOpen, triggerGreeting]);

  const handleToggleChat = useCallback(async (open: boolean) => {
    await window.electronAPI?.window.toggleChat(open);
    chatOpenRef.current = open;
    setChatOpen(open);
    if (open) setActionsOpen(false); // 与动作管理面板互斥
  }, []);

  const handleToggleActions = useCallback(async (open: boolean) => {
    await window.electronAPI?.window.toggleActions(open);
    setActionsOpen(open);
    if (open) {
      chatOpenRef.current = false;
      setChatOpen(false);
    }
  }, []);

  // 动作列表加载 + 变更监听（删除正在播放的动作时立即停止并复位宠物）
  useEffect(() => {
    const load = () => {
      window.electronAPI?.config.get().then((c) => {
        const list = (c?.petActions as PetAction[]) || [];
        petActionsRef.current = list;
        const playing = playingActionIdRef.current;
        if (playing && !list.some((a) => a.id === playing)) stopActionRef.current?.();
      }).catch(() => {});
    };
    load();
    const cleanup = window.electronAPI?.onPetActionsChanged(load);
    return cleanup;
  }, []);

  // 主进程触发：右键菜单播放动作 / 打开动作管理面板
  useEffect(() => {
    const cleanupPlay = window.electronAPI?.onPlayAction((id) => playActionRef.current?.(id));
    const cleanupToggle = window.electronAPI?.onToggleActions(() => { handleToggleActions(true); });
    return () => {
      cleanupPlay?.();
      cleanupToggle?.();
    };
  }, [handleToggleActions]);

  // 互动时自动播放同名动作（喂食→吃饭、休息→休息、玩耍→玩耍；未创建则跳过）
  const autoPlayAction = useCallback((name: string) => {
    const action = petActionsRef.current.find((a) => a.name === name);
    if (action) playActionRef.current?.(action.id);
  }, []);

  // 右键宠物弹出的原生菜单动作（主进程 Menu 触发）
  useEffect(() => {
    const cleanup = window.electronAPI?.onPetContextAction((action) => {
      if (action === 'feed') { feed(); autoPlayAction('吃饭'); }
      else if (action === 'play') { play(); autoPlayAction('玩耍'); }
      else if (action === 'rest') { rest(); autoPlayAction('休息'); }
      else if (action === 'open-store') window.electronAPI?.platform.openStore();
      else if (action === 'toggle-chat') handleToggleChat(!chatOpenRef.current);
    });
    return cleanup;
  }, [feed, play, rest, handleToggleChat, autoPlayAction]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { width, height } = petSettings;
    let app: PIXI.Application | null = null;
    let isCancelled = false;
    let pet: PIXI.Sprite | null = null;
    // 三视图纹理：由宠物原图程序化派生（front=原图、side=水平压缩模拟转身、back=水平镜像）
    let viewTextures: { front: PIXI.Texture; side: PIXI.Texture; back: PIXI.Texture } | null = null;
    // 动作播放状态（effect 局部：Pixi 重建后旧播放自然失效）
    let transformPlay: { action: PetAction; start: number; baseX: number; baseY: number; fit: number } | null = null;
    let framesSprite: PIXI.AnimatedSprite | null = null;

    const stopTransform = () => {
      if (transformPlay && pet) {
        pet.x = transformPlay.baseX;
        pet.y = transformPlay.baseY;
        pet.rotation = 0;
        pet.scale.set(transformPlay.fit);
        if (viewTextures) pet.texture = viewTextures.front;
      }
      transformPlay = null;
      if (playingActionIdRef) playingActionIdRef.current = null;
    };

    const stopFrames = () => {
      if (framesSprite) {
        framesSprite.stop();
        framesSprite.destroy();
        framesSprite = null;
      }
      if (pet) pet.visible = true;
      if (playingActionIdRef) playingActionIdRef.current = null;
    };

    const playAction = (action: PetAction) => {
      if (!app || !pet) return;
      stopTransform();
      stopFrames();

      if (action.kind === 'transform' && action.transform) {
        transformPlay = {
          action,
          start: Date.now(),
          baseX: width / 2,
          baseY: height / 2,
          fit: pet.scale.x,
        };
        if (playingActionIdRef) playingActionIdRef.current = action.id;
        return;
      }

      // 帧序列动作：petaction:// 自定义协议加载本地帧图（http origin 无法直接读磁盘文件）
      if (action.kind === 'frames' && action.frameFiles?.length) {
        const urls = action.frameFiles.map((p) => `petaction://local/?p=${encodeURIComponent(p)}`);
        Promise.all(urls.map((u) => PIXI.Assets.load(u)))
          .then((textures) => {
            if (!app || !pet || isCancelled) return;
            pet.visible = false;
            const spr = new PIXI.AnimatedSprite(textures);
            spr.anchor.set(0.5);
            const fit = Math.min((width - 60) / spr.width, (height - 60) / spr.height);
            spr.scale.set(fit);
            spr.x = width / 2;
            spr.y = height / 2;
            // animationSpeed 单位：每 tick(60fps) 推进的帧数
            spr.animationSpeed = (action.frameRate ?? 6) / 60;
            spr.loop = false;
            spr.onComplete = () => {
              spr.destroy();
              if (framesSprite === spr) framesSprite = null;
              if (pet) pet.visible = true;
              if (playingActionIdRef?.current === action.id) playingActionIdRef.current = null;
            };
            app.stage.addChild(spr);
            framesSprite = spr;
            if (playingActionIdRef) playingActionIdRef.current = action.id;
            spr.gotoAndPlay(0);
          })
          .catch(() => { /* 帧图加载失败时保持静态宠物 */ });
      }
    };
    playActionRef.current = (id: string) => {
      const found = petActionsRef.current.find((a) => a.id === id);
      if (found) playAction(found);
    };
    // 删除动作时立即中断播放（stopTransform + stopFrames 覆盖两种动作类型）
    stopActionRef.current = () => { stopTransform(); stopFrames(); };

    const initPixi = async () => {
      const newApp = new PIXI.Application();
      await newApp.init({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
      });

      if (isCancelled) {
        newApp.destroy(true);
        return;
      }

      app = newApp;
      container.appendChild(app.canvas as HTMLCanvasElement);
      app.canvas.style.pointerEvents = 'none';

      const installedPet = await window.electronAPI?.platform.getInstalledPet();
      const texture = await PIXI.Assets.load(installedPet?.dataUrl ?? petImg);
      pet = new PIXI.Sprite(texture);
      pet.anchor.set(0.5);
      // 等比缩放保证宠物完整显示（四周留白 30px，避免大图溢出画布被裁切）
      const pad = 30;
      const fit = Math.min((width - pad * 2) / texture.width, (height - pad * 2) / texture.height);
      pet.scale.set(fit);
      pet.x = width / 2;
      pet.y = height / 2;
      app.stage.addChild(pet);

      // 像素级命中测试：sprite 实际矩形 + 纹理 alpha 图（整页穿透，仅宠物本体不透明像素可交互）
      const spriteW = texture.width * fit;
      const spriteH = texture.height * fit;
      hitRectRef.current = { left: width / 2 - spriteW / 2, top: height / 2 - spriteH / 2, w: spriteW, h: spriteH };
      try {
        const source = (texture.source as { resource?: CanvasImageSource }).resource;
        if (source) {
          const c = document.createElement('canvas');
          c.width = texture.width;
          c.height = texture.height;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(source, 0, 0);
            hitAlphaRef.current = {
              data: ctx.getImageData(0, 0, texture.width, texture.height).data,
              w: texture.width,
              h: texture.height,
            };
          }
          // 程序化派生三视图：side=水平压缩模拟侧身，back=水平镜像模拟背面
          const makeView = (apply: (c2d: CanvasRenderingContext2D, w: number, h: number) => void) => {
            const vc = document.createElement('canvas');
            vc.width = texture.width;
            vc.height = texture.height;
            const vctx = vc.getContext('2d');
            if (!vctx) throw new Error('no 2d context');
            apply(vctx, vc.width, vc.height);
            vctx.drawImage(source, 0, 0);
            return PIXI.Texture.from(vc);
          };
          viewTextures = {
            front: texture,
            side: makeView((c2d, w) => {
              c2d.translate(w / 2, 0);
              c2d.scale(0.72, 1);
              c2d.translate(-w / 2, 0);
            }),
            back: makeView((c2d, w) => {
              c2d.translate(w, 0);
              c2d.scale(-1, 1);
            }),
          };
        }
      } catch { /* 纹理源不可绘制时退化为矩形命中（三视图不可用则不切换） */ }

      app.ticker.add(() => {
        if (!pet) return;
        const { energy, mood, hunger } = stateRef.current;
        pet.tint = hunger < 30 ? 0xaaaaaa : 0xffffff;

        // 变换动画播放中：按关键帧插值，不叠加待机浮动
        if (transformPlay) {
          const transform = transformPlay.action.transform;
          if (!transform) { stopTransform(); return; }
          const elapsed = Date.now() - transformPlay.start;
          if (!transform.loop && elapsed >= transform.duration) { stopTransform(); return; }
          const t = (elapsed % transform.duration) / transform.duration;
          const kfs = transform.keyframes;
          let cur = kfs[0];
          let next = kfs[kfs.length - 1];
          for (let i = 0; i < kfs.length - 1; i++) {
            if (t >= kfs[i].t && t <= kfs[i + 1].t) {
              cur = kfs[i];
              next = kfs[i + 1];
              break;
            }
          }
          const span = next.t - cur.t || 1;
          const f = Math.min(1, Math.max(0, (t - cur.t) / span));
          const lerp = (a: number, b: number) => a + (b - a) * f;
          pet.x = transformPlay.baseX + lerp(cur.dx, next.dx);
          pet.y = transformPlay.baseY + lerp(cur.dy, next.dy);
          pet.rotation = lerp(cur.rotation, next.rotation);
          pet.scale.set(transformPlay.fit * lerp(cur.scale, next.scale));

          // 三视图切换：取 t 之前最近关键帧的 view（front/side/back）
          if (viewTextures) {
            let view = kfs[0].view ?? 'front';
            for (let i = 0; i < kfs.length; i++) {
              if (t >= kfs[i].t) view = kfs[i].view ?? 'front';
            }
            const target = viewTextures[view];
            if (pet.texture !== target) pet.texture = target;
          }
          return;
        }

        // 帧序列播放中：隐藏本体，交给 AnimatedSprite，不做浮动
        if (framesSprite) return;

        // 待机浮动
        const floatAmplitude = Math.min(10, 10 + (energy / 100) * 15);
        const floatSpeed = 0.5 + (energy / 100) * 1.5;
        pet.y = height / 2 + Math.sin(Date.now() / (1000 / floatSpeed)) * floatAmplitude;
        pet.rotation = mood > 70 ? Math.sin(Date.now() / 800) * 0.1 : 0;
      });
    };

    initPixi();

    const decayInterval = setInterval(() => {
      const f = featuresRef.current;
      decay({ feed: f.feedEnabled, play: f.playEnabled, rest: f.restEnabled });
    }, 5000);

    return () => {
      isCancelled = true;
      clearInterval(decayInterval);
      playActionRef.current = null;
      stopActionRef.current = null;
      if (app) app.destroy(true);
    };
  }, [petSettings, assetVersion]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: 'transparent',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Chat Panel (left side, shown when chat is open) */}
      {chatOpen && (
        <div data-interactive style={{ display: 'flex', height: '100%' }}>
          <ChatPanel onClose={() => handleToggleChat(false)} />
        </div>
      )}

      {/* Actions Panel（动作管理：与聊天面板互斥、同尺寸机制） */}
      {actionsOpen && (
        <div data-interactive style={{ display: 'flex', height: '100%' }}>
          <ActionsPanel
            onClose={() => handleToggleActions(false)}
            onPlay={(id) => playActionRef.current?.(id)}
          />
        </div>
      )}

      {/* Pet Area (right side, always visible) */}
      <div
        ref={containerRef}
        style={{
          width: petSettings.width,
          height: '100%',
          position: 'relative',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        {/* Status display（进度条随对应功能开关显隐：喂食→饱食、休息→精力、玩耍→心情） */}
        {(petFeatures.feedEnabled || petFeatures.playEnabled || petFeatures.restEnabled || petFeatures.affectionEnabled) && (
          <div style={statusStyle}>
            {petFeatures.feedEnabled && <span>饱:{Math.round(hunger)} </span>}
            {petFeatures.playEnabled && <span>心:{Math.round(mood)} </span>}
            {petFeatures.restEnabled && <span>精:{Math.round(energy)} </span>}
            {petFeatures.affectionEnabled && <span>好:{Math.round(affection)}</span>}
          </div>
        )}

        {/* 聊天与商店入口已移至右键菜单（pet:context-action） */}

        {/* Action buttons（随互动功能开关显隐） */}
        {petFeatures.feedEnabled && (
          <button
            data-interactive
            onClick={(e) => {
              e.stopPropagation();
              feed();
              autoPlayAction('吃饭');
            }}
            style={{ ...btnBaseStyle, bottom: 20, right: 5 }}
          >
            喂食
          </button>
        )}
        {petFeatures.restEnabled && (
          <button
            data-interactive
            onClick={(e) => {
              e.stopPropagation();
              rest();
              autoPlayAction('休息');
            }}
            style={{ ...btnBaseStyle, bottom: 40, right: 5 }}
          >
            休息
          </button>
        )}
        {petFeatures.playEnabled && (
          <button
            data-interactive
            onClick={(e) => {
              e.stopPropagation();
              play();
              autoPlayAction('玩耍');
            }}
            style={{ ...btnBaseStyle, bottom: 0, right: 5 }}
          >
            玩耍
          </button>
        )}
      </div>
    </div>
  );
};

const statusStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 5,
  left: 5,
  fontSize: '10px',
  color: 'white',
  background: 'rgba(0,0,0,0.5)',
  padding: '2px 5px',
  borderRadius: '3px',
  pointerEvents: 'none',
  zIndex: 20,
};

const btnBaseStyle: React.CSSProperties = {
  position: 'absolute',
  opacity: 0.8,
  fontSize: '12px',
  zIndex: 20,
  pointerEvents: 'auto',
  padding: '2px 6px',
  border: '1px solid rgba(255,255,255,0.3)',
  borderRadius: '4px',
  background: 'rgba(0,0,0,0.6)',
  color: 'white',
  cursor: 'pointer',
};

export default App;
