import { useEffect, useRef, useState, useCallback } from 'react';
import * as PIXI from 'pixi.js';
import { GifSprite, GifSource } from 'pixi.js/gif';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import petImg from './assets/pet.png';
import coreJsUrl from './assets/live2dcubismcore.min.js?url';
import { usePetStore } from './store/petStore';
import { useChatStore } from './store/chatStore';
import { SpriteAnimator, type SpriteAnimationsConfig } from './renderer/spriteAnimator';
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

// Cubism Core（Live2D 官方运行时）：需在加载 Live2D 模型前以 <script> 注入全局 window.Live2DCubismCore
let cubismCorePromise: Promise<void> | null = null;

/** 精灵表动画配置加载：animations.json 与 spritesheet.png 同目录，经 petaction:// 协议读取 */
async function loadSpriteAnimations(sheetPath?: string | null): Promise<SpriteAnimationsConfig | null> {
  if (!sheetPath) return null;
  const dir = sheetPath.slice(0, Math.max(sheetPath.lastIndexOf('\\'), sheetPath.lastIndexOf('/')));
  try {
    const res = await fetch(`petaction://local/${encodeURIComponent('animations.json')}?p=${encodeURIComponent(`${dir}/animations.json`)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as SpriteAnimationsConfig | null;
    if (!json || typeof json.frameWidth !== 'number' || typeof json.frameHeight !== 'number' || !json.animations) return null;
    return json;
  } catch {
    return null;
  }
}
const loadCubismCore = (): Promise<void> => {
  if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) return Promise.resolve();
  if (!cubismCorePromise) {
    cubismCorePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = coreJsUrl;
      script.onload = () => resolve();
      script.onerror = () => {
        cubismCorePromise = null;
        reject(new Error('Cubism Core 加载失败'));
      };
      document.head.appendChild(script);
    });
  }
  return cubismCorePromise;
};

const App = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  // 精灵表五状态判定依据（ticker 内读取）：四项数值 + 互动时间戳 + 漫步标志
  const stateRef = useRef({
    hunger: 80, mood: 80, energy: 80, affection: 50,
    lastFeedAt: 0, lastPlayAt: 0, lastRestAt: 0, moving: false,
  });
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // 动作系统：列表 ref（播放查找）+ 播放函数 ref（由 initPixi effect 注入，需访问 Pixi 实例）
  const petActionsRef = useRef<PetAction[]>([]);
  // 互动功能绑定的动作 id（资源库动作上传时可绑定喂食/休息/玩耍），随动作列表一起刷新
  const bindingsRef = useRef<{ feed?: string; rest?: string; play?: string }>({});
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
  /** 精灵表动画驱动（petAssetFormat === 'sprite' 时由 initPixi 注入，五状态切换用） */
  const spriteAnimatorRef = useRef<SpriteAnimator | null>(null);

  const { hunger, mood, energy, affection, lastFeedAt, lastPlayAt, lastRestAt, moving, feed, play, rest, decay, setMoving } = usePetStore();
  const { triggerGreeting } = useChatStore();

  useEffect(() => {
    stateRef.current = { hunger, mood, energy, affection, lastFeedAt, lastPlayAt, lastRestAt, moving };
    // Sync pet state to main process for LLM context
    window.electronAPI?.pet.stateUpdate({ hunger, mood, energy, affection });
  }, [hunger, mood, energy, affection, lastFeedAt, lastPlayAt, lastRestAt, moving]);

  // 随机漫步：主进程回报漫步状态（开始/结束/被拖拽或面板中断），驱动 moving 标志与精灵表 moving 动画
  useEffect(() => {
    const cleanup = window.electronAPI?.pet.onWanderState((v) => setMoving(v));
    return cleanup;
  }, [setMoving]);

  // 漫步调度：每 5s 掷骰（15% 概率 ≈ 平均 33s 漫步一次），方向/幅度/时长随机；
  // 互斥、开关（randomMoveEnabled）与精力门槛由主进程校验，拒绝时静默忽略
  useEffect(() => {
    const timer = setInterval(() => {
      if (Math.random() >= 0.15) return;
      const dx = (Math.random() < 0.5 ? -1 : 1) * (60 + Math.floor(Math.random() * 101));
      const durationMs = 2000 + Math.floor(Math.random() * 1500);
      void window.electronAPI?.pet.wanderStart({ dx, durationMs });
    }, 5000);
    return () => clearInterval(timer);
  }, []);

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

  // 智能体主动发起的对话：气泡展示 10s 后自动消失（同时已写入聊天历史）
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const agentMsgTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const cleanup = window.electronAPI?.onAgentMessage((text) => {
      setAgentMessage(text);
      if (agentMsgTimerRef.current) window.clearTimeout(agentMsgTimerRef.current);
      agentMsgTimerRef.current = window.setTimeout(() => setAgentMessage(null), 10_000);
    });
    return () => {
      cleanup?.();
      if (agentMsgTimerRef.current) window.clearTimeout(agentMsgTimerRef.current);
    };
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

  // 动作列表加载 + 变更监听（删除正在播放的动作时立即停止并复位宠物；同步互动绑定供自动播放使用）
  useEffect(() => {
    const load = () => {
      window.electronAPI?.config.get().then((c) => {
        const list = (c?.petActions as PetAction[]) || [];
        petActionsRef.current = list;
        bindingsRef.current = c?.petActionBindings || {};
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

  // 互动时自动播放动作：优先播放在资源库中绑定给该功能的动作，未绑定回退同名动作（喂食→吃饭、休息→休息、玩耍→玩耍）
  const autoPlayAction = useCallback((kind: 'feed' | 'rest' | 'play') => {
    const actions = petActionsRef.current;
    const boundId = bindingsRef.current[kind];
    const bound = boundId ? actions.find((a) => a.id === boundId) : undefined;
    const fallbackName = kind === 'feed' ? '吃饭' : kind === 'rest' ? '休息' : '玩耍';
    const action = bound ?? actions.find((a) => a.name === fallbackName);
    if (action) playActionRef.current?.(action.id);
  }, []);

  // 右键宠物弹出的原生菜单动作（主进程 Menu 触发）
  useEffect(() => {
    const cleanup = window.electronAPI?.onPetContextAction((action) => {
      if (action === 'feed') { feed(); autoPlayAction('feed'); }
      else if (action === 'play') { play(); autoPlayAction('play'); }
      else if (action === 'rest') { rest(); autoPlayAction('rest'); }
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
    // transition：启动/结束的补间动画（150ms 启动淡入、200ms 结束回归自然姿态）
    type TransitionState = {
      kind: 'in' | 'out';
      start: number;
      duration: number;
      from: { x: number; y: number; rotation: number; scale: number; texture?: PIXI.Texture };
      to: { x: number; y: number; rotation: number; scale: number; texture?: PIXI.Texture };
      afterOut?: () => void;
    };
    let transformPlay: { action: PetAction; start: number; baseX: number; baseY: number; fit: number } | null = null;
    let transition: TransitionState | null = null;
    // 帧序列/GIF 动作精灵（AnimatedSprite 或 GifSprite，二者均为 Sprite 子类）
    let actionSprite: PIXI.AnimatedSprite | GifSprite | null = null;

    // 启动/结束过渡：补间插值 x/y/rotation/scale/texture，让两个状态间不跳变
    const startTransition = (state: Omit<TransitionState, 'start'>) => {
      transition = { ...state, start: Date.now() };
    };
    const startTransformIn = (action: PetAction) => {
      if (!pet) return;
      // 启动 150ms 从自然姿态补到首关键帧
      const kfs = action.transform?.keyframes;
      const firstKf = kfs?.[0];
      if (!firstKf) return;
      startTransition({
        kind: 'in',
        duration: 150,
        from: { x: pet.x, y: pet.y, rotation: pet.rotation, scale: pet.scale.x },
        to: { x: transformPlay!.baseX + firstKf.dx, y: transformPlay!.baseY + firstKf.dy, rotation: firstKf.rotation, scale: transformPlay!.fit * firstKf.scale },
      });
    };
    const stopTransform = () => {
      if (transformPlay && pet) {
        // 结束 200ms 回归自然姿态（非循环动作末帧已归位，循环动作直接回基准）
        const targetX = transformPlay.baseX;
        const targetY = transformPlay.baseY;
        const targetScale = transformPlay.fit;
        startTransition({
          kind: 'out',
          duration: 200,
          from: { x: pet.x, y: pet.y, rotation: pet.rotation, scale: pet.scale.x },
          to: { x: targetX, y: targetY, rotation: 0, scale: targetScale },
        });
      }
      transformPlay = null;
      if (playingActionIdRef) playingActionIdRef.current = null;
    };

    // 播放结束清理：销毁动作精灵并恢复本体显示
    const removeActionSprite = (spr: PIXI.AnimatedSprite | GifSprite, actionId?: string) => {
      spr.stop();
      spr.destroy();
      if (actionSprite === spr) actionSprite = null;
      if (pet) pet.visible = true;
      if (playingActionIdRef && (!actionId || playingActionIdRef.current === actionId)) {
        playingActionIdRef.current = null;
      }
    };

    const stopActionSprite = () => {
      if (actionSprite) removeActionSprite(actionSprite);
      if (pet) pet.visible = true;
      if (playingActionIdRef) playingActionIdRef.current = null;
    };

    const playAction = (action: PetAction) => {
      if (!app || !pet) return;
      stopTransform();
      stopActionSprite();

      if (action.kind === 'transform' && action.transform) {
        transformPlay = {
          action,
          start: Date.now(),
          baseX: width / 2,
          baseY: height / 2,
          fit: pet.scale.x,
        };
        if (playingActionIdRef) playingActionIdRef.current = action.id;
        // 启动过渡：150ms 从当前姿态平滑补到首关键帧，避免状态间跳变
        startTransformIn(action);
        return;
      }

      // 帧序列动作：petaction:// 自定义协议加载本地帧图（http origin 无法直接读磁盘文件）。
      // URL path 段携带真实文件名，供 pixi 解析器按扩展名选择 loader（.gif → GifSource）
      if (action.kind === 'frames' && action.frameFiles?.length) {
        const toUrl = (p: string) => {
          const name = p.split(/[\\/]/).pop() || 'frame.png';
          return `petaction://local/${encodeURIComponent(name)}?p=${encodeURIComponent(p)}`;
        };

        // 单张 GIF：GifSprite 循环播放 3 轮后自动结束
        if (action.frameFiles.length === 1 && /\.gif$/i.test(action.frameFiles[0])) {
          PIXI.Assets.load(toUrl(action.frameFiles[0]))
            .then((loaded) => {
              if (!app || !pet || isCancelled) return;
              pet.visible = false;
              const spr = new GifSprite({ source: loaded as GifSource, loop: true, autoPlay: true });
              spr.anchor.set(0.5);
              const fit = Math.min((width - 60) / spr.width, (height - 60) / spr.height);
              spr.scale.set(fit);
              spr.x = width / 2;
              spr.y = height / 2;
              let loops = 0;
              spr.onLoop = () => {
                loops += 1;
                if (loops >= 3) removeActionSprite(spr, action.id);
              };
              app.stage.addChild(spr);
              actionSprite = spr;
              if (playingActionIdRef) playingActionIdRef.current = action.id;
            })
            .catch(() => { /* GIF 加载失败时保持静态宠物 */ });
          return;
        }

        Promise.all(action.frameFiles.map((p) => PIXI.Assets.load(toUrl(p)).then((res) => {
          // 帧序列混入 gif 时取其首帧纹理，避免 AnimatedSprite 收到 GifSource
          const maybe = res as { textures?: unknown };
          if (maybe && Array.isArray(maybe.textures) && maybe.textures.length) return maybe.textures[0] as PIXI.Texture;
          return res as PIXI.Texture;
        })))
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
            spr.onComplete = () => removeActionSprite(spr, action.id);
            app.stage.addChild(spr);
            actionSprite = spr;
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
    // 删除动作时立即中断播放（stopTransform + stopActionSprite 覆盖各动作类型）
    stopActionRef.current = () => { stopTransform(); stopActionSprite(); };

    const initPixi = async (spriteMode = false) => {
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
      const sourceUrl = installedPet?.dataUrl ?? petImg;
      // GIF 主图：pixi 的 GifAsset 按 data:image/gif 前缀识别，加载结果为 GifSource（多帧动画）
      const isGifMain = typeof sourceUrl === 'string' && sourceUrl.startsWith('data:image/gif');
      let texture: PIXI.Texture | null = null;
      let spriteAnimator: SpriteAnimator | null = null;
      if (spriteMode && typeof sourceUrl === 'string') {
        // 精灵表宠物：animations.json 与 spritesheet.png 同目录，按行列切帧后由 SpriteAnimator 驱动
        const cfg = await loadSpriteAnimations(installedPet?.path);
        const baseTex = await PIXI.Assets.load<PIXI.Texture>(sourceUrl);
        pet = new PIXI.Sprite();
        pet.anchor.set(0.5);
        if (cfg) {
          spriteAnimator = new SpriteAnimator(pet, baseTex, cfg);
        } else {
          pet.texture = baseTex; // 配置缺失：整张表当静态图退化
        }
      } else if (isGifMain) {
        pet = new GifSprite({ source: await PIXI.Assets.load<GifSource>(sourceUrl), loop: true, autoPlay: true });
      } else {
        const tex = await PIXI.Assets.load(sourceUrl);
        texture = tex;
        pet = new PIXI.Sprite(tex);
      }
      spriteAnimatorRef.current = spriteAnimator;
      pet.anchor.set(0.5);
      // 等比缩放保证宠物完整显示（四周留白 30px，避免大图溢出画布被裁切）
      const pad = 30;
      const natW = pet.width;
      const natH = pet.height;
      const fit = Math.min((width - pad * 2) / natW, (height - pad * 2) / natH);
      pet.scale.set(fit);
      pet.x = width / 2;
      pet.y = height / 2;
      app.stage.addChild(pet);

      // 像素级命中测试：sprite 实际矩形 + 纹理 alpha 图（整页穿透，仅宠物本体不透明像素可交互）
      const spriteW = natW * fit;
      const spriteH = natH * fit;
      hitRectRef.current = { left: width / 2 - spriteW / 2, top: height / 2 - spriteH / 2, w: spriteW, h: spriteH };
      try {
        // 三视图仅静态图宠物可派生（GIF 逐帧改写纹理，切换静态视图会破坏播放）
        const tex = texture;
        if (tex) {
          const source = (tex.source as { resource?: CanvasImageSource }).resource;
          if (source) {
            const c = document.createElement('canvas');
            c.width = tex.width;
            c.height = tex.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(source, 0, 0);
              hitAlphaRef.current = {
                data: ctx.getImageData(0, 0, tex.width, tex.height).data,
                w: tex.width,
                h: tex.height,
              };
            }
            // 程序化派生三视图：side=水平压缩模拟侧身，back=水平镜像模拟背面
            const makeView = (apply: (c2d: CanvasRenderingContext2D, w: number, h: number) => void) => {
              const vc = document.createElement('canvas');
              vc.width = tex.width;
              vc.height = tex.height;
              const vctx = vc.getContext('2d');
              if (!vctx) throw new Error('no 2d context');
              apply(vctx, vc.width, vc.height);
              vctx.drawImage(source, 0, 0);
              return PIXI.Texture.from(vc);
            };
            viewTextures = {
              front: tex,
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
        }
      } catch { /* 纹理源不可绘制时退化为矩形命中（三视图不可用则不切换） */ }

      app.ticker.add(() => {
        if (!pet) return;
        // 精灵表动画：按当前状态 fps 步进帧纹理（非 1:1 raf）
        if (spriteAnimator) spriteAnimator.update(newApp.ticker.deltaMS);
        const { energy, mood, hunger } = stateRef.current;
        // 五状态自动绑定（手动动作播放中不抢占）：eating(喂食后4s) > playing(玩耍后4s)
        // > resting(休息后6s 或 精力<20) > moving(漫步) > idle；未收录的状态自动跳过
        if (spriteAnimator && !playingActionIdRef.current) {
          const { moving: isMoving, lastFeedAt: fedAt, lastPlayAt: playedAt, lastRestAt: restedAt } = stateRef.current;
          const now = Date.now();
          const anim = now - fedAt < 4000 ? 'eating'
            : now - playedAt < 4000 ? 'playing'
            : now - restedAt < 6000 || energy < 20 ? 'resting'
            : isMoving ? 'moving'
            : 'idle';
          if (spriteAnimator.has(anim)) spriteAnimator.setAnimation(anim);
        }
        pet.tint = hunger < 30 ? 0xaaaaaa : 0xffffff;

        // 状态过渡补间进行中：插值 x/y/rotation/scale，让姿态平滑衔接不跳变
        if (transition) {
          const f = Math.min(1, (Date.now() - transition.start) / transition.duration);
          const ease = f * (2 - f); // easeOutQuad
          pet.x = transition.from.x + (transition.to.x - transition.from.x) * ease;
          pet.y = transition.from.y + (transition.to.y - transition.from.y) * ease;
          pet.rotation = transition.from.rotation + (transition.to.rotation - transition.from.rotation) * ease;
          pet.scale.set(transition.from.scale + (transition.to.scale - transition.from.scale) * ease);
          if (f >= 1) {
            const done = transition;
            transition = null;
            // 回归完成后切回正面视图
            if (done.kind === 'out' && viewTextures && pet.texture !== viewTextures.front) {
              pet.texture = viewTextures.front;
            }
          }
          return;
        }

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

        // 帧序列/GIF 播放中：隐藏本体，交给动作精灵，不做浮动
        if (actionSprite) return;

        // 待机浮动
        const floatAmplitude = Math.min(10, 10 + (energy / 100) * 15);
        const floatSpeed = 0.5 + (energy / 100) * 1.5;
        pet.y = height / 2 + Math.sin(Date.now() / (1000 / floatSpeed)) * floatAmplitude;
        pet.rotation = mood > 70 ? Math.sin(Date.now() / 800) * 0.1 : 0;
      });
    };

    // ---- three.js 3D 宠物（petAssetFormat === 'model3d'）：与 Pixi 渲染二选一 ----
    let cleanupThree: (() => void) | null = null;
    const initThree = async () => {
      const installedPet = await window.electronAPI?.platform.getInstalledPet();
      const modelPath = installedPet?.path;
      if (!modelPath || isCancelled) return;
      const fileName = modelPath.split(/[\\/]/).pop() || 'model.glb';
      const dir = modelPath.slice(0, Math.max(modelPath.lastIndexOf('\\'), modelPath.lastIndexOf('/')));

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(width, height);
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.pointerEvents = 'none';
      if (isCancelled) { renderer.dispose(); return; }
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
      camera.position.set(0, 0, 5);
      scene.add(new THREE.AmbientLight(0xffffff, 1.4));
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
      keyLight.position.set(2, 3, 4);
      scene.add(keyLight);
      const root = new THREE.Group();
      scene.add(root);

      // GLTF 外部资源（.bin/纹理）相对 URI 解析后丢失 ?p= 参数：
      // URLModifier 按 petaction://local/<相对路径> 拼回模型目录内的绝对路径
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        if (!url.startsWith('petaction://') || url.includes('?p=')) return url;
        const rel = decodeURIComponent(url.slice('petaction://local/'.length));
        const name = rel.split('/').pop() || rel;
        const abs = `${dir}/${rel}`;
        return `petaction://local/${encodeURIComponent(name)}?p=${encodeURIComponent(abs)}`;
      });
      const loader = new GLTFLoader(manager);

      let mixer: THREE.AnimationMixer | null = null;
      let idleAction: THREE.AnimationAction | null = null;
      let oneShot: THREE.AnimationAction | null = null; // 一次性 clip 动作（播完冻结，渐隐回 idle）
      let oneShotEndAt = 0; // 播放截止时间戳（0 = 无待完成动作）
      let oneShotActive = false; // 播放中（含冻结期）：抑制待机浮动
      const animations: THREE.AnimationClip[] = [];
      // 透视相机在 z=5、fov45 下的可视世界高度，用于像素 ↔ 世界单位换算
      const pxToWorld = (2 * 5 * Math.tan((45 / 2) * (Math.PI / 180))) / height;

      // 回到 idle：一次性动作保持冻结姿态，idle 淡入覆盖形成过渡
      const backToIdle = () => {
        oneShotActive = false;
        if (idleAction) {
          idleAction.reset();
          idleAction.setEffectiveWeight(0);
          idleAction.play();
          idleAction.fadeIn(0.3);
        }
        playingActionIdRef.current = null;
      };

      try {
        const gltf = await loader.loadAsync(
          `petaction://local/${encodeURIComponent(fileName)}?p=${encodeURIComponent(modelPath)}`
        );
        if (isCancelled) { renderer.dispose(); return; }
        const model = gltf.scene;
        root.add(model);

        // 等比缩放居中：包围盒最长边映射到画布高度（四周留白 30px）
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const visibleH = 2 * 5 * Math.tan((45 / 2) * (Math.PI / 180));
        const modelScale = (visibleH * ((height - 60) / height)) / maxDim;
        model.scale.setScalar(modelScale);
        model.position.set(-center.x * modelScale, -center.y * modelScale, -center.z * modelScale);

        // 动画：idle/待机命名优先，否则取第一个；无动画则静态模型
        animations.push(...(gltf.animations || []));
        if (animations.length) {
          mixer = new THREE.AnimationMixer(model);
          const idleClip = animations.find((c) => /idle|待机|stand/i.test(c.name)) || animations[0];
          idleAction = mixer.clipAction(idleClip);
          idleAction.play();
        }

        // 命中矩形：缩放居中后的包围盒 8 角投影到画布像素（3D 无像素图，矩形命中）
        const wMin = new THREE.Vector3().subVectors(box.min, center).multiplyScalar(modelScale);
        const wMax = new THREE.Vector3().subVectors(box.max, center).multiplyScalar(modelScale);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const x of [wMin.x, wMax.x]) {
          for (const y of [wMin.y, wMax.y]) {
            for (const z of [wMin.z, wMax.z]) {
              const p = new THREE.Vector3(x, y, z).project(camera);
              const px = (p.x * 0.5 + 0.5) * width;
              const py = (-p.y * 0.5 + 0.5) * height;
              if (px < minX) minX = px;
              if (px > maxX) maxX = px;
              if (py < minY) minY = py;
              if (py > maxY) maxY = py;
            }
          }
        }
        hitRectRef.current = { left: minX, top: minY, w: maxX - minX, h: maxY - minY };
        hitAlphaRef.current = null;
      } catch {
        // 模型加载失败：销毁渲染器（窗口保持透明，不影响其他功能）
        renderer.dispose();
        return;
      }

      // 渲染循环：mixer 更新 + 一次性动作完成检测 + 待机浮动（与 2D 同公式，命中偏移一致）
      let rafId = 0;
      let prev = performance.now();
      const loop = () => {
        rafId = requestAnimationFrame(loop);
        if (isCancelled) return;
        const now = performance.now();
        const delta = Math.min(0.1, (now - prev) / 1000);
        prev = now;
        mixer?.update(delta);
        if (oneShotActive && oneShotEndAt && now >= oneShotEndAt) {
          oneShotEndAt = 0;
          backToIdle();
        }
        if (!oneShotActive) {
          const { energy } = stateRef.current;
          const amp = Math.min(10, 10 + (energy / 100) * 15);
          const speed = 0.5 + (energy / 100) * 1.5;
          root.position.y = Math.sin(now / (1000 / speed)) * amp * pxToWorld;
        }
        renderer.render(scene, camera);
      };
      loop();

      cleanupThree = () => {
        cancelAnimationFrame(rafId);
        mixer?.stopAllAction();
        mixer = null;
        renderer.dispose();
        renderer.forceContextLoss();
        if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
      };

      // clip 动作：0.3s 淡入播放（LoopOnce 一次），播完冻结再淡回 idle；
      // frames/transform 为 2D 覆盖动画，模型宠物下不支持，忽略
      playActionRef.current = (id: string) => {
        const action = petActionsRef.current.find((a) => a.id === id);
        if (!action || action.kind !== 'clip' || !action.clipName || !mixer || !idleAction) return;
        const clip = animations.find((c) => c.name === action.clipName)
          || animations.find((c) => c.name.includes(action.clipName || ''));
        if (!clip) return;
        if (oneShot) { oneShot.stop(); oneShot = null; }
        const next = mixer.clipAction(clip);
        next.reset();
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
        next.setEffectiveWeight(0);
        next.play();
        next.fadeIn(0.3);
        idleAction.fadeOut(0.3);
        oneShot = next;
        oneShotEndAt = performance.now() + clip.duration * 1000;
        oneShotActive = true;
        playingActionIdRef.current = action.id;
      };
      stopActionRef.current = () => {
        if (oneShot) { oneShot.stop(); oneShot = null; }
        oneShotEndAt = 0;
        backToIdle();
      };
    };

    // ---- Live2D 宠物（petAssetFormat === 'live2d'）：@jannchie/pixi-live2d-display（Pixi v8） ----
    // live2d-lite 分层部件描述（AI 生成的轻量 Live2D 包，无 moc3）
    type LitePartMotion = {
      wag?: { amp: number; speed: number };
      breath?: { amp: number; speed: number };
      tilt?: { amp: number; speed: number };
      blink?: { interval: number };
    };
    interface LitePart {
      id: string;
      file: string;
      z: number;
      parent?: string;
      pivot?: { x: number; y: number };
      motion?: LitePartMotion;
    }
    interface LiteModelJson {
      format: string;
      version: number;
      size: { width: number; height: number };
      model?: { sway?: { amp: number; speed: number } };
      parts: LitePart[];
    }

    const initLive2DLite = async (litePath: string) => {
      const fileName = litePath.split(/[\\/]/).pop() || 'live2d-lite.json';
      const dir = litePath.slice(0, Math.max(litePath.lastIndexOf('\\'), litePath.lastIndexOf('/')));
      const toUrl = (rel: string) => {
        const name = rel.split(/[\\/]/).pop() || rel;
        return `petaction://local/${encodeURIComponent(name)}?p=${encodeURIComponent(`${dir}/${rel}`)}`;
      };

      const newApp = new PIXI.Application();
      await newApp.init({ width, height, backgroundAlpha: 0, antialias: true });
      if (isCancelled) {
        newApp.destroy(true);
        return;
      }
      app = newApp;
      container.appendChild(app.canvas as HTMLCanvasElement);
      app.canvas.style.pointerEvents = 'none';

      try {
        const res = await fetch(toUrl(fileName));
        if (!res.ok) throw new Error('live2d-lite.json 加载失败');
        const lite = (await res.json()) as LiteModelJson;
        if (isCancelled) return;
        if (!lite || !Array.isArray(lite.parts) || !lite.parts.length) throw new Error('live2d-lite.json 无部件');

        // 根容器：以模型中心为轴（transform 动作围绕中心旋转/缩放），等比缩放留白 30px
        const root = new PIXI.Container();
        const modelW = lite.size?.width || 300;
        const modelH = lite.size?.height || 300;
        const fit = Math.min((width - 60) / modelW, (height - 60) / modelH);
        root.pivot.set(modelW / 2, modelH / 2);
        root.scale.set(fit);
        root.position.set(width / 2, height / 2);
        app.stage.addChild(root);

        // 部件装载：按 z 序 addChild（渲染顺序=添加顺序）。
        // 耳/眼挂独立"头部轴"容器以跟随头部倾角，同时不破坏 z 序；眼内层精灵另以眼心为轴眨眼。
        const headPart = lite.parts.find((p) => p.id === 'head');
        const headPivot = headPart?.pivot ?? { x: modelW / 2, y: modelH / 2 };
        const ordered = [...lite.parts].sort((a, b) => a.z - b.z);
        const nodes: Array<{ part: LitePart; obj: PIXI.Container; inner: PIXI.Sprite | null }> = [];
        for (const part of ordered) {
          const tex = await PIXI.Assets.load<PIXI.Texture>(toUrl(part.file));
          if (isCancelled) return;
          const sprite = new PIXI.Sprite(tex);
          const px = part.pivot?.x ?? 0;
          const py = part.pivot?.y ?? 0;
          sprite.pivot.set(px, py);
          sprite.position.set(px, py);
          if (part.parent === 'head') {
            const wrap = new PIXI.Container();
            wrap.pivot.set(headPivot.x, headPivot.y);
            wrap.position.set(headPivot.x, headPivot.y);
            wrap.addChild(sprite);
            app.stage.addChild(wrap);
            nodes.push({ part, obj: wrap, inner: sprite });
          } else {
            app.stage.addChild(sprite);
            nodes.push({ part, obj: sprite, inner: null });
          }
        }

        // 命中矩形：模型包围盒（静态估算，轻摆幅度像素级可忽略）
        const b = root.getBounds();
        hitRectRef.current = { left: b.minX, top: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
        hitAlphaRef.current = null;

        // ---- 待机动画 + transform/frames 动作（与平台预览公式一致）----
        let liteTransform: { action: PetAction; start: number } | null = null;
        let liteReturn: { start: number; rot: number; scale: number; dx: number; dy: number } | null = null;
        let liteFrames: PIXI.AnimatedSprite | null = null;
        const swayMotion = lite.model?.sway;

        const removeLiteFrames = () => {
          if (!liteFrames) return;
          liteFrames.stop();
          liteFrames.destroy();
          liteFrames = null;
          root.visible = true;
          if (playingActionIdRef) playingActionIdRef.current = null;
        };
        const stopLiteTransform = () => {
          if (liteTransform) {
            liteReturn = { start: Date.now(), rot: root.rotation, scale: root.scale.x, dx: root.position.x - width / 2, dy: root.position.y - height / 2 };
          }
          liteTransform = null;
        };
        const resetLiteRoot = () => {
          root.rotation = 0;
          root.scale.set(fit);
          root.position.set(width / 2, height / 2);
        };

        app.ticker.add(() => {
          const t = app ? app.ticker.lastTime / 1000 : 0;
          // 回归补间：transform 结束后 200ms easeOut 回自然姿态
          if (liteReturn) {
            const f = Math.min(1, (Date.now() - liteReturn.start) / 200);
            const ease = f * (2 - f);
            root.rotation = liteReturn.rot * (1 - ease);
            const s = liteReturn.scale + (fit - liteReturn.scale) * ease;
            root.scale.set(s);
            root.position.set(width / 2 + liteReturn.dx * (1 - ease), height / 2 + liteReturn.dy * (1 - ease));
            if (f >= 1) { liteReturn = null; resetLiteRoot(); }
            return;
          }
          // transform 动作：关键帧插值（与 Pixi 本体逻辑一致）
          if (liteTransform) {
            const transform = liteTransform.action.transform;
            if (!transform) { stopLiteTransform(); return; }
            const elapsed = Date.now() - liteTransform.start;
            if (!transform.loop && elapsed >= transform.duration) { stopLiteTransform(); return; }
            const kt = (elapsed % transform.duration) / transform.duration;
            const kfs = transform.keyframes;
            let cur = kfs[0];
            let next = kfs[kfs.length - 1];
            for (let i = 0; i < kfs.length - 1; i++) {
              if (kt >= kfs[i].t && kt <= kfs[i + 1].t) { cur = kfs[i]; next = kfs[i + 1]; break; }
            }
            const span = next.t - cur.t || 1;
            const f = Math.min(1, Math.max(0, (kt - cur.t) / span));
            const lerp = (a: number, b: number) => a + (b - a) * f;
            root.position.set(width / 2 + lerp(cur.dx, next.dx) * fit, height / 2 + lerp(cur.dy, next.dy) * fit);
            root.rotation = lerp(cur.rotation, next.rotation);
            root.scale.set(fit * lerp(cur.scale, next.scale));
            return;
          }
          // 帧序列动作播放中：隐藏本体，交给动作精灵
          if (liteFrames) return;

          // 待机：呼吸（身体）/ 眨眼（眼）/ 头部轻摆（头+耳+眼）/ 尾巴摆动 / 整体轻晃
          for (const { part, obj, inner } of nodes) {
            const m = part.motion ?? {};
            if (m.wag) obj.rotation = m.wag.amp * (Math.PI / 180) * Math.sin(Math.PI * m.wag.speed * t);
            if (m.breath) obj.scale.set(1 + m.breath.amp * 0.6 * Math.sin(2 * Math.PI * m.breath.speed * t), 1 + m.breath.amp * Math.sin(2 * Math.PI * m.breath.speed * t));
            if (m.tilt) obj.rotation = m.tilt.amp * (Math.PI / 180) * Math.sin(Math.PI * m.tilt.speed * t);
            if (m.blink && inner) {
              const phase = t % m.blink.interval;
              const open = phase < 0.32 ? Math.max(0.08, 1 - Math.sin((Math.PI * phase) / 0.32) * 0.92) : 1;
              inner.scale.set(1, open);
            }
          }
          if (swayMotion) root.position.x = width / 2 + swayMotion.amp * Math.sin(2 * Math.PI * swayMotion.speed * t) * fit;
        });

        // clip 动作：lite 包无 motion 组，占位忽略；frames/transform 正常播放
        playActionRef.current = (id: string) => {
          const action = petActionsRef.current.find((a) => a.id === id);
          if (!action) return;
          if (action.kind === 'clip') return;
          if (action.kind === 'transform') {
            removeLiteFrames();
            liteReturn = null;
            liteTransform = { action, start: Date.now() };
            if (playingActionIdRef) playingActionIdRef.current = action.id;
            return;
          }
          // frames：petaction:// 加载帧图，AnimatedSprite 覆盖层
          if (action.frameFiles?.length) {
            const toFrameUrl = (p: string) => {
              const name = p.split(/[\\/]/).pop() || 'frame.png';
              return `petaction://local/${encodeURIComponent(name)}?p=${encodeURIComponent(p)}`;
            };
            Promise.all(action.frameFiles.map((p) => PIXI.Assets.load<PIXI.Texture>(toFrameUrl(p))))
              .then((textures) => {
                if (!app || isCancelled) return;
                removeLiteFrames();
                root.visible = false;
                const spr = new PIXI.AnimatedSprite(textures);
                spr.anchor.set(0.5);
                const fsprFit = Math.min((width - 60) / spr.width, (height - 60) / spr.height);
                spr.scale.set(fsprFit);
                spr.x = width / 2;
                spr.y = height / 2;
                spr.animationSpeed = (action.frameRate ?? 6) / 60;
                spr.loop = false;
                spr.onComplete = () => removeLiteFrames();
                app.stage.addChild(spr);
                liteFrames = spr;
                if (playingActionIdRef) playingActionIdRef.current = action.id;
                spr.gotoAndPlay(0);
              })
              .catch(() => { /* 帧图加载失败时保持静态宠物 */ });
          }
        };
        stopActionRef.current = () => {
          liteTransform = null;
          liteReturn = null;
          removeLiteFrames();
          resetLiteRoot();
        };
      } catch {
        app.destroy(true);
        app = null;
      }
    };

    const initLive2D = async () => {
      const installedPetLite = await window.electronAPI?.platform.getInstalledPet();
      const litePath = installedPetLite?.path;
      // AI 生成的轻量 Live2D 包（live2d-lite.json，无 moc3）：走自研轻量渲染器，无需 Cubism Core
      if (litePath && /live2d-lite\.json$/i.test(litePath)) {
        await initLive2DLite(litePath);
        return;
      }
      try {
        await loadCubismCore();
      } catch {
        return; // Core 加载失败：窗口保持空白，不影响其他功能
      }
      if (isCancelled) return;
      const { Live2DModel } = await import('@jannchie/pixi-live2d-display/cubism4');
      if (isCancelled) return;

      const installedPet = await window.electronAPI?.platform.getInstalledPet();
      const modelPath = installedPet?.path;
      if (!modelPath || isCancelled) return;
      const fileName = modelPath.split(/[\\/]/).pop() || 'model.model3.json';

      const newApp = new PIXI.Application();
      await newApp.init({ width, height, backgroundAlpha: 0, antialias: true });
      if (isCancelled) {
        newApp.destroy(true);
        return;
      }
      app = newApp;
      container.appendChild(app.canvas as HTMLCanvasElement);
      app.canvas.style.pointerEvents = 'none';

      try {
        // 相对资源（moc3/纹理/动作文件）由协议 handler 的文件名索引兜底解析
        const model = await Live2DModel.from(
          `petaction://local/${encodeURIComponent(fileName)}?p=${encodeURIComponent(modelPath)}`,
          { autoInteract: false }
        );
        if (isCancelled) {
          model.destroy();
          return;
        }
        model.anchor.set(0.5, 0.5);
        // 等比缩放居中（四周留白 30px）
        const fit = Math.min((width - 60) / model.width, (height - 60) / model.height);
        model.scale.set(fit);
        model.position.set(width / 2, height / 2);
        app.stage.addChild(model);

        // 命中矩形：模型包围盒（3D/Live2D 无像素图，矩形命中）
        const b = model.getBounds();
        hitRectRef.current = { left: b.minX, top: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
        hitAlphaRef.current = null;

        // clip 动作：clipName 为动作组名（可带 "/序号"），FORCE 优先级打断 idle 播放一次，
        // 播完由 Live2D 内部自动回落 idle 组；frames/transform 为 2D 覆盖动画，Live2D 宠物下忽略
        playActionRef.current = (id: string) => {
          const action = petActionsRef.current.find((a) => a.id === id);
          if (!action || action.kind !== 'clip' || !action.clipName) return;
          const [group, idxStr] = action.clipName.split('/');
          const index = idxStr !== undefined ? Number.parseInt(idxStr, 10) : undefined;
          if (playingActionIdRef) playingActionIdRef.current = action.id;
          void model
            .motion(group, Number.isNaN(index) ? undefined : index, 3)
            .finally(() => {
              if (playingActionIdRef.current === action.id) playingActionIdRef.current = null;
            });
        };
        stopActionRef.current = () => {
          if (playingActionIdRef) playingActionIdRef.current = null;
        };
      } catch {
        // 模型加载失败：销毁渲染器
        app.destroy(true);
        app = null;
      }
    };

    // 宠物形态分流：model3d 走 three.js，live2d 走 Live2D，sprite 走 Pixi 精灵表，其余（image/pack/gif）走 Pixi
    void (async () => {
      let format: string | undefined;
      try {
        format = (await window.electronAPI?.config.get())?.petAssetFormat;
      } catch { /* 配置读取失败按 2D 处理 */ }
      if (isCancelled) return;
      if (format === 'model3d') await initThree();
      else if (format === 'live2d') await initLive2D();
      else if (format === 'sprite') await initPixi(true);
      else initPixi();
    })();

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
      cleanupThree?.();
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
        {/* 智能体主动对话气泡（10s 自动消失，可手动关闭） */}
        {agentMessage && (
          <div data-interactive style={bubbleStyle}>
            <span style={{ flex: 1, lineHeight: 1.5 }}>{agentMessage}</span>
            <button
              onClick={() => setAgentMessage(null)}
              style={{
                border: 'none',
                background: 'transparent',
                color: '#999',
                fontSize: '12px',
                cursor: 'pointer',
                padding: '0 2px',
              }}
            >
              ✕
            </button>
          </div>
        )}

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
              autoPlayAction('feed');
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
              autoPlayAction('rest');
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
              autoPlayAction('play');
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

// 智能体主动对话气泡：宠物上方居中，白底深字便于阅读
const bubbleStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  maxWidth: '90%',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 4,
  padding: '8px 10px',
  background: 'rgba(255,255,255,0.96)',
  color: '#333',
  fontSize: '12px',
  borderRadius: '10px',
  boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  zIndex: 30,
  pointerEvents: 'auto',
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
