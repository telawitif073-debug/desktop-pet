import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import * as PIXI from 'pixi.js';
import { GifSprite, GifSource } from 'pixi.js/gif';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import petImg from './assets/pet.png';
import coreJsUrl from './assets/live2dcubismcore.min.js?url';
import { usePetStore } from './store/petStore';
import { useChatStore } from './store/chatStore';
import { speak, speakContextFromConfig } from './renderer/speech';
import { resolveInteractionTrigger } from './shared/petPlayback';
import { syncAmbientSenses } from './renderer/ambientSense';
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

// 面板内容布局高（与主进程 CHAT_WINDOW_SIZE 同源；窗口物理尺寸恒定 650x690，
// 面板态 650x450 内容贴窗底渲染，顶部 240px 透明）
const CHAT_PANEL_H = 450;
// 气泡预留带高度（与主进程 BUBBLE_RESERVE 同源，90px；窗口 690 高 = 视觉上限 600 + 90）
const BUBBLE_RESERVE_PX = 90;

// Cubism Core（Live2D 官方运行时）：需在加载 Live2D 模型前以 <script> 注入全局 window.Live2DCubismCore
let cubismCorePromise: Promise<void> | null = null;

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
  const actionsOpenRef = useRef(false);
  // 动作系统：列表 ref（播放查找）+ 播放函数 ref（由 initPixi effect 注入，需访问 Pixi 实例）
  const petActionsRef = useRef<PetAction[]>([]);
  // 互动功能绑定的动作 id（资源库动作上传时可绑定喂食/休息/玩耍），随动作列表一起刷新
  const bindingsRef = useRef<{ feed?: string; rest?: string; play?: string }>({});
  const playActionRef = useRef<((id: string) => void) | null>(null);
  // 当前播放中的动作 id + 立即停止回调：删除动作时用于中断播放并复位宠物
  const playingActionIdRef = useRef<string | null>(null);
  const stopActionRef = useRef<(() => void) | null>(null);
  // 当前形象导出闭包（三形态初始化就绪后赋值）：自我形象识别用
  const selfieExportRef = useRef<(() => string | null) | null>(null);
  // 渲染层视口自适应（Ctrl+滚轮缩放）：由 PIXI/three/live2d 各分支注入，
  // 收到 pet:zoom-changed 时平滑 renderer.resize，不重建渲染器；面板模式下复位到基础尺寸
  const applyViewportRef = useRef<((w: number, h: number) => void) | null>(null);
  const [petSettings, setPetSettings] = useState<PetWindowSettings>({ width: 300, height: 300, opacity: 1 });
  // 固定窗模型：OS 窗口恒 650x690，舞台像素尺寸=视觉 side（滚轮缩放经 IPC 实时更新）；
  // 面板模式容器固定用 petSettings.width。初值与 petSettings 默认一致，配置到达后同步
  const [stageSize, setStageSize] = useState({ w: 300, h: 300 });
  // 最新视觉 side（滚轮缩放只走 IPC 不更新 petSettings；面板关闭复位视口时以此为准）
  const petSideRef = useRef(300);
  const [petFeatures, setPetFeatures] = useState<PetFeatures>(DEFAULT_FEATURES);
  // decay 定时器内通过 ref 读取，避免闭包过期（开关变更不重建 Pixi 实例）
  const featuresRef = useRef<PetFeatures>(DEFAULT_FEATURES);
  useEffect(() => {
    featuresRef.current = petFeatures;
    // 精力系统（休息功能）关闭时精力恒为默认值 80：历史低值不再触发疲劳状态与漫步拒绝
    if (!petFeatures.restEnabled || !petFeatures.feedEnabled || !petFeatures.playEnabled) {
      usePetStore.getState().resetVitals({ feed: petFeatures.feedEnabled, play: petFeatures.playEnabled, rest: petFeatures.restEnabled });
    }
  }, [petFeatures]);
  // 整页点击穿透：命中测试数据（sprite 矩形 + 可选 alpha 像素图），由 initPixi 在纹理加载后填充
  const ignoreRef = useRef(true);
  const hitRectRef = useRef<{ left: number; top: number; w: number; h: number } | null>(null);
  const hitAlphaRef = useRef<{ data: Uint8ClampedArray; w: number; h: number } | null>(null);
  /** 宠物头顶锚点（容器内坐标，由 hitRect 派生）：消息气泡定位用 */
  const [headAnchor, setHeadAnchor] = useState<{ x: number; y: number } | null>(null);
  /** 统一登记命中矩形：同时派生头顶锚点（气泡挂在宠物头顶居中） */
  const setHitRect = useCallback((rect: { left: number; top: number; w: number; h: number }) => {
    hitRectRef.current = rect;
    setHeadAnchor({ x: rect.left + rect.w / 2, y: rect.top });
  }, []);

  const { hunger, mood, energy, affection, lastFeedAt, lastPlayAt, lastRestAt, moving, feed, play, rest, decay, setMoving } = usePetStore();
  // 持续感知（麦克风语音对话/摄像头定时看一眼）：按商店设置启停，config 变化实时生效
  const petSenses = useChatStore((s) => s.config?.petSenses);
  useEffect(() => {
    syncAmbientSenses(petSenses ?? undefined);
  }, [petSenses]);
  // 宠物状态总开关（聊天设置 → 对话体验）：关闭后数值不衰减、不显示、互动按钮隐藏。
  // 定时器内通过 ref 读取，避免开关变更触发 PIXI/three 主 effect 重建
  const petSystemEnabled = useChatStore((s) => s.config?.petSystemEnabled !== false);
  const petSystemRef = useRef(true);
  useEffect(() => {
    petSystemRef.current = petSystemEnabled;
    if (!petSystemEnabled) {
      // 关闭时四维数值归位默认（历史低值不再影响疲劳状态与漫步判定）
      usePetStore.getState().resetVitals({ feed: false, play: false, rest: false });
    }
  }, [petSystemEnabled]);
  // 启动即加载聊天配置（此前仅打开聊天面板时才加载，导致持续聆听/感知开机不生效）
  useEffect(() => {
    void useChatStore.getState().loadConfig();
  }, []);

  useEffect(() => {
    stateRef.current = { hunger, mood, energy, affection, lastFeedAt, lastPlayAt, lastRestAt, moving };
    // Sync pet state to main process for LLM context
    window.electronAPI?.pet.stateUpdate({ hunger, mood, energy, affection });
  }, [hunger, mood, energy, affection, lastFeedAt, lastPlayAt, lastRestAt, moving]);

  // 随机漫步：主进程回报漫步状态（开始/结束/被拖拽或面板中断），驱动 moving 标志
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

  // 智能体变更（主进程通知）：宠物重新「看一眼」自己并更新形象记忆（主进程按指纹去重）
  useEffect(() => {
    const cleanup = window.electronAPI?.onSelfieRequest(() => {
      window.setTimeout(() => {
        const dataUrl = selfieExportRef.current?.();
        if (dataUrl) void window.electronAPI?.self?.recognize(dataUrl)?.catch?.(() => {});
      }, 800);
    });
    return cleanup;
  }, []);

  // 智能体主动发起的对话：气泡展示 10s 后自动消失（同时已写入聊天历史）
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  // 气泡预留带（纯渲染层布局，窗口尺寸恒定 650x690）：气泡显示且宠物态时，stage 顶部
  // 保留 90px、画布下移贴 stage 底，头顶空间恒可容纳气泡，无需任何窗口 resize
  const bubbleReserve = agentMessage && !chatOpen && !actionsOpen ? BUBBLE_RESERVE_PX : 0;
  // 气泡边界钳制：头顶上方空间不足时避免被 stage 边缘裁剪
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [bubblePos, setBubblePos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!agentMessage || !el || !headAnchor) {
      setBubblePos(null);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    // 坐标均相对 pet-stage：画布在 stage 内 left=0、top=bubbleReserve；
    // stage 宽=视觉 side，高=side+预留带
    const stageW = stageSize.w;
    const stageH = stageSize.h + BUBBLE_RESERVE_PX;
    // 首选头顶上方（预留带内）；放不下时压到 stage 顶部之内（不溢出）
    const top = Math.max(0, Math.min(BUBBLE_RESERVE_PX + headAnchor.y - 6 - height, stageH - height));
    const left = Math.max(0, Math.min(headAnchor.x - width / 2, stageW - width));
    setBubblePos({ top, left });
  }, [agentMessage, headAnchor, stageSize.w, stageSize.h]);

  // 视觉 side 同步到舞台：启动配置加载、设置页滑杆（petSettings 变化）、面板关闭回宠物态。
  // 注意舞台取值用 petSideRef：滚轮缩放只走 IPC 不更新 petSettings（避免触发渲染主 effect
  // 全量重建），关面板时必须恢复到最新缩放值而非过期的配置值。固定窗模型不监听 resize。
  useEffect(() => {
    if (petSettings.width !== petSideRef.current) petSideRef.current = petSettings.width;
    if (!chatOpen && !actionsOpen) {
      const side = petSideRef.current;
      setStageSize({ w: side, h: side });
      applyViewportRef.current?.(side, side);
    }
  }, [petSettings, chatOpen, actionsOpen]);

  // Ctrl+滚轮缩放：主进程持久化后广播新 side，渲染端平滑 resize 渲染器，不重建 PIXI/three
  useEffect(() => {
    const cleanup = window.electronAPI?.pet.onZoomChanged((side) => {
      petSideRef.current = side;
      setStageSize({ w: side, h: side });
      applyViewportRef.current?.(side, side);
    });
    return cleanup;
  }, []);
  const agentMsgTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const cleanup = window.electronAPI?.onAgentMessage((text) => {
      setAgentMessage(text);
      // 宠物语音：主动消息同步朗读（智能体专属音色 → 全局云音色 → Edge → 系统）
      speak(text, speakContextFromConfig(useChatStore.getState().config));
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
    // Ctrl+滚轮缩放：累积 deltaY 按鼠标滚轮一格(≈100)量化一档，120ms 节流（触控板连续小值平滑收敛）
    let wheelAccum = 0;
    let lastWheelZoomAt = 0;
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
      const top = rect.top;
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
    const onWheel = (e: WheelEvent) => {
      // 防误触：需 Ctrl（macOS 触控板捏合为 ctrlKey，兼容 Cmd）；面板/UI 上不缩放
      if (!(e.ctrlKey || e.metaKey)) return;
      const overUI = !!(e.target as Element | null)?.closest?.('[data-interactive]');
      if (overUI || chatOpenRef.current || actionsOpenRef.current) return;
      e.preventDefault();
      wheelAccum += e.deltaY;
      const now = performance.now();
      if (Math.abs(wheelAccum) >= 100 && now - lastWheelZoomAt >= 120) {
        void window.electronAPI?.window.zoomPet(wheelAccum < 0 ? 1 : -1);
        wheelAccum = 0;
        lastWheelZoomAt = now;
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('wheel', onWheel, { passive: false });
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('wheel', onWheel);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      window.electronAPI?.window.endDrag();
    };
  }, []);

  const handleToggleChat = useCallback(async (open: boolean) => {
    // ref 先于主进程 setBounds 置位，保证开合瞬间的 resize 事件按面板模式处理
    chatOpenRef.current = open;
    if (open) actionsOpenRef.current = false;
    await window.electronAPI?.window.toggleChat(open);
    setChatOpen(open);
    if (open) {
      setActionsOpen(false); // 与动作管理面板互斥
      // 面板为 650x450 固定布局：画布回到基础宠物尺寸，避免被缩放后的大画布裁切
      applyViewportRef.current?.(petSettings.width, petSettings.height);
    }
  }, [petSettings.width, petSettings.height]);

  const handleToggleActions = useCallback(async (open: boolean) => {
    actionsOpenRef.current = open;
    if (open) chatOpenRef.current = false;
    await window.electronAPI?.window.toggleActions(open);
    setActionsOpen(open);
    if (open) {
      setChatOpen(false);
      applyViewportRef.current?.(petSettings.width, petSettings.height);
    }
  }, [petSettings.width, petSettings.height]);

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

  // 互动时自动播放动作：统一走标准动作模型（src/shared/petPlayback）的决策——
  // 绑定优先 → 互动池（不连播当前动作）→ 显式失败原因（不再静默"什么都不播"）。
  // 池划分沿用配置迁移规则：显式 interaction 字段，其次历史同名约定（吃饭/休息/玩耍）。
  const autoPlayAction = useCallback((kind: 'feed' | 'rest' | 'play') => {
    const actions = petActionsRef.current;
    const currentId = playingActionIdRef.current;
    const decision = resolveInteractionTrigger({
      kind,
      boundActionId: bindingsRef.current[kind],
      actions,
      currentActionName: currentId ? actions.find((a) => a.id === currentId)?.name : undefined,
    });
    if (!decision.ok || !decision.actionId) {
      console.warn('[pet] 互动触发无可播动作：', decision.reason, decision.evidence);
      return;
    }
    playActionRef.current?.(decision.actionId);
  }, []);

  // 右键宠物弹出的原生菜单动作（主进程 Menu 触发）
  useEffect(() => {
    const cleanup = window.electronAPI?.onPetContextAction((action) => {
      if (action === 'feed') { feed(); autoPlayAction('feed'); }
      else if (action === 'play') { play(); autoPlayAction('play'); }
      else if (action === 'rest') { rest(); autoPlayAction('rest'); }
      // 资源中心入口由主进程直接开窗（右键菜单 → openStoreWindow），此处只处理宠物互动与聊天
      else if (action === 'toggle-chat') handleToggleChat(!chatOpenRef.current);
    });
    return cleanup;
  }, [feed, play, rest, handleToggleChat, autoPlayAction]);

  // 配置广播：创作中心等其他窗口改动配置（智能体档案/音色等）后同步刷新本窗口
  useEffect(() => {
    const cleanup = window.electronAPI?.onConfigChanged((next) =>
      useChatStore.setState({ config: next }),
    );
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 视口尺寸：初始化取配置值；滚轮缩放时由各分支的 applyViewport 闭包就地更新。
    // 用 let 而非解构 const：playAction/ticker 等后定义闭包即可始终读到最新画布尺寸，
    // 缩放只走 renderer.resize，不重建 PIXI/three、不重载纹理、不重复触发形象识别。
    let width = petSettings.width;
    let height = petSettings.height;
    let app: PIXI.Application | null = null;
    applyViewportRef.current = null;
    let isCancelled = false;
    let pet: PIXI.Sprite | null = null;
    // 帧序列/GIF 动作精灵（AnimatedSprite 或 GifSprite，二者均为 Sprite 子类）
    let actionSprite: PIXI.AnimatedSprite | GifSprite | null = null;

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

    // 形象就绪后交主进程识别并记住（指纹未变时主进程跳过）；延后给动画首帧留渲染时间
    const requestSelfRecognize = () => {
      if (!window.electronAPI?.self?.recognize) return;
      window.setTimeout(() => {
        const dataUrl = selfieExportRef.current?.();
        if (!dataUrl) return;
        window.electronAPI.self
          .recognize(dataUrl)
          .then((res) => {
            if (res?.ok && !res.skipped) console.log(`[self] 形象已记住: ${res.description}`);
            else if (res && !res.ok) console.log(`[self] 形象识别失败: ${res.error}`);
          })
          .catch(() => { /* 主进程未就绪等场景静默 */ });
      }, 800);
    };

    const playAction = (action: PetAction) => {
      if (!app || !pet) return;
      stopActionSprite();

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
    // 删除动作时立即中断播放
    stopActionRef.current = () => { stopActionSprite(); };

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
      const sourceUrl = installedPet?.dataUrl ?? petImg;
      // GIF 主图：pixi 的 GifAsset 按 data:image/gif 前缀识别，加载结果为 GifSource（多帧动画）
      const isGifMain = typeof sourceUrl === 'string' && sourceUrl.startsWith('data:image/gif');
      let texture: PIXI.Texture | null = null;
      if (isGifMain) {
        pet = new GifSprite({ source: await PIXI.Assets.load<GifSource>(sourceUrl), loop: true, autoPlay: true });
      } else {
        const tex = await PIXI.Assets.load(sourceUrl);
        texture = tex;
        pet = new PIXI.Sprite(tex);
      }
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

      // 形象导出闭包：Pixi v8 extract 输出透明背景 PNG（不含聊天面板等 DOM）
      selfieExportRef.current = () => {
        if (!app) return null;
        try {
          const canvas = app.renderer.extract.canvas(app.stage) as HTMLCanvasElement | null;
          return canvas?.toDataURL('image/png') ?? null;
        } catch {
          return null;
        }
      };
      requestSelfRecognize();

      // 像素级命中测试：sprite 实际矩形 + 纹理 alpha 图（整页穿透，仅宠物本体不透明像素可交互）
      const spriteW = natW * fit;
      const spriteH = natH * fit;
      setHitRect({ left: width / 2 - spriteW / 2, top: height / 2 - spriteH / 2, w: spriteW, h: spriteH });
      try {
        // alpha 图仅静态图宠物可提取（GIF 逐帧改写纹理，无法静态采样）
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
          }
        }
      } catch { /* 纹理源不可绘制时退化为矩形命中 */ }

      app.ticker.add(() => {
        if (!pet) return;
        const { hunger } = stateRef.current;
        pet.tint = hunger < 30 ? 0xaaaaaa : 0xffffff;
      });

      // 滚轮缩放：渲染器原地 resize + 本体/动作精灵等比重排与命中框重算
      applyViewportRef.current = (w, h) => {
        if (!app) return;
        width = w;
        height = h;
        app.renderer.resize(w, h);
        if (pet) {
          const fit = Math.min((w - pad * 2) / natW, (h - pad * 2) / natH);
          pet.scale.set(fit);
          pet.x = w / 2;
          pet.y = h / 2;
          const spriteW = natW * fit;
          const spriteH = natH * fit;
          setHitRect({ left: w / 2 - spriteW / 2, top: h / 2 - spriteH / 2, w: spriteW, h: spriteH });
        }
        if (actionSprite) {
          const baseW = actionSprite.width / (Math.abs(actionSprite.scale.x) || 1);
          const baseH = actionSprite.height / (Math.abs(actionSprite.scale.y) || 1);
          const fit = Math.min((w - 60) / baseW, (h - 60) / baseH);
          actionSprite.scale.set(fit);
          actionSprite.x = w / 2;
          actionSprite.y = h / 2;
        }
      };
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

        // 命中矩形：缩放居中后的包围盒 8 角投影到画布像素（3D 无像素图，矩形命中）。
        // 抽为函数：滚轮缩放重设相机/模型比例后需用同一逻辑重算命中框。
        const updateHitRect = (scaleNow: number) => {
          const wMin = new THREE.Vector3().subVectors(box.min, center).multiplyScalar(scaleNow);
          const wMax = new THREE.Vector3().subVectors(box.max, center).multiplyScalar(scaleNow);
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
          setHitRect({ left: minX, top: minY, w: maxX - minX, h: maxY - minY });
        };
        updateHitRect(modelScale);
        hitAlphaRef.current = null;

        // 滚轮缩放：渲染器/相机比例/模型缩放/命中框联动，不重新加载 GLTF
        applyViewportRef.current = (w, h) => {
          width = w;
          height = h;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          const visibleH = 2 * 5 * Math.tan((45 / 2) * (Math.PI / 180));
          const ms = (visibleH * ((h - 60) / h)) / maxDim;
          model.scale.setScalar(ms);
          model.position.set(-center.x * ms, -center.y * ms, -center.z * ms);
          updateHitRect(ms);
        };

        // 形象导出闭包：手动渲染一帧后同步读取像素（规避 preserveDrawingBuffer 空帧问题）
        selfieExportRef.current = () => {
          try {
            renderer.render(scene, camera);
            return renderer.domElement.toDataURL('image/png');
          } catch {
            return null;
          }
        };
        requestSelfRecognize();
      } catch {
        // 模型加载失败：销毁渲染器（窗口保持透明，不影响其他功能）
        renderer.dispose();
        return;
      }

      // 渲染循环：mixer 更新 + 一次性动作完成检测
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

        // 根容器：以模型中心为轴，等比缩放留白 30px
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
        setHitRect({ left: b.minX, top: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY });
        hitAlphaRef.current = null;

        // ---- 待机动画 + frames 动作 ----
        let liteFrames: PIXI.AnimatedSprite | null = null;
        const swayMotion = lite.model?.sway;

        // 滚轮缩放：根容器/帧动作/命中框按新视口重排（ticker 的 sway 基准读外层 let width）
        const reflowLite = (w: number, h: number) => {
          if (!app) return;
          app.renderer.resize(w, h);
          const f = Math.min((w - 60) / modelW, (h - 60) / modelH);
          root.scale.set(f);
          root.position.set(w / 2, h / 2);
          if (liteFrames) {
            const baseW = liteFrames.width / (Math.abs(liteFrames.scale.x) || 1);
            const baseH = liteFrames.height / (Math.abs(liteFrames.scale.y) || 1);
            const ff = Math.min((w - 60) / baseW, (h - 60) / baseH);
            liteFrames.scale.set(ff);
            liteFrames.x = w / 2;
            liteFrames.y = h / 2;
          }
          const bb = root.getBounds();
          setHitRect({ left: bb.minX, top: bb.minY, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY });
        };
        applyViewportRef.current = (w, h) => {
          width = w;
          height = h;
          reflowLite(w, h);
        };

        const removeLiteFrames = () => {
          if (!liteFrames) return;
          liteFrames.stop();
          liteFrames.destroy();
          liteFrames = null;
          root.visible = true;
          if (playingActionIdRef) playingActionIdRef.current = null;
        };
        const resetLiteRoot = () => {
          root.rotation = 0;
          reflowLite(width, height);
        };

        app.ticker.add(() => {
          const t = app ? app.ticker.lastTime / 1000 : 0;
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

        // clip 动作：lite 包无 motion 组，占位忽略；frames 正常播放
        playActionRef.current = (id: string) => {
          const action = petActionsRef.current.find((a) => a.id === id);
          if (!action) return;
          if (action.kind === 'clip') return;
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
        // 本地基准尺寸（scale 写入前捕获，滚轮缩放按此重算比例）
        const modelBaseW = model.width;
        const modelBaseH = model.height;
        // 等比缩放居中（四周留白 30px）
        const fit = Math.min((width - 60) / modelBaseW, (height - 60) / modelBaseH);
        model.scale.set(fit);
        model.position.set(width / 2, height / 2);
        app.stage.addChild(model);

        // 形象导出闭包：Live2D 同挂 Pixi stage，与 2D 相同的 extract 途径
        selfieExportRef.current = () => {
          if (!app) return null;
          try {
            const canvas = app.renderer.extract.canvas(app.stage) as HTMLCanvasElement | null;
            return canvas?.toDataURL('image/png') ?? null;
          } catch {
            return null;
          }
        };
        requestSelfRecognize();

        // 命中矩形：模型包围盒（3D/Live2D 无像素图，矩形命中）
        const b = model.getBounds();
        setHitRect({ left: b.minX, top: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY });
        hitAlphaRef.current = null;

        // 滚轮缩放：模型等比重排（Cubism 内部矩阵随 scale/position 自适应），不重新 from()
        applyViewportRef.current = (w, h) => {
          if (!app) return;
          width = w;
          height = h;
          app.renderer.resize(w, h);
          const fit = Math.min((w - 60) / modelBaseW, (h - 60) / modelBaseH);
          model.scale.set(fit);
          model.position.set(w / 2, h / 2);
          const bb = model.getBounds();
          setHitRect({ left: bb.minX, top: bb.minY, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY });
        };

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

    // 宠物形态分流：model3d 走 three.js，live2d 走 Live2D，其余（image/pack/gif）走 Pixi
    void (async () => {
      let format: string | undefined;
      try {
        format = (await window.electronAPI?.config.get())?.petAssetFormat;
      } catch { /* 配置读取失败按 2D 处理 */ }
      if (isCancelled) return;
      if (format === 'model3d') await initThree();
      else if (format === 'live2d') await initLive2D();
      else initPixi();
    })();

    const decayInterval = setInterval(() => {
      const f = featuresRef.current;
      // 宠物状态总开关关闭时全部冻结（不衰减、数值锁定默认 80）
      const on = petSystemRef.current;
      const gates = { feed: on && f.feedEnabled, play: on && f.playEnabled, rest: on && f.restEnabled };
      decay(gates);
      // 精力系统关闭：精力锁定默认值 80（低精力不再影响休息动画与漫步校验）
      if (!gates.rest || !gates.feed || !gates.play) {
        usePetStore.getState().resetVitals(gates);
      }
    }, 5000);

    return () => {
      isCancelled = true;
      clearInterval(decayInterval);
      playActionRef.current = null;
      stopActionRef.current = null;
      selfieExportRef.current = null;
      applyViewportRef.current = null;
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
        // 固定窗 650x690：面板态内容 450 高贴窗底（顶部透明），宠物态舞台亦贴窗底
        alignItems: 'flex-end',
        background: 'transparent',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Chat Panel (left side, shown when chat is open) */}
      {chatOpen && (
        <div data-interactive style={{ display: 'flex', height: CHAT_PANEL_H }}>
          <ChatPanel onClose={() => handleToggleChat(false)} />
        </div>
      )}

      {/* Actions Panel（动作管理：与聊天面板互斥、同尺寸机制） */}
      {actionsOpen && (
        <div data-interactive style={{ display: 'flex', height: CHAT_PANEL_H }}>
          <ActionsPanel
            onClose={() => handleToggleActions(false)}
            onPlay={(id) => playActionRef.current?.(id)}
          />
        </div>
      )}

      {/* Pet Area (right side, always visible) */}
      <div
        id="pet-stage"
        ref={containerRef}
        style={{
          // 宠物模式视觉 side（滚轮缩放经 IPC 实时变化）；面板模式固定基础宠物区宽
          width: chatOpen || actionsOpen ? petSettings.width : stageSize.w,
          // 宠物模式：视觉 side + 气泡预留带；面板模式：450 高内容贴窗底
          height: chatOpen || actionsOpen ? CHAT_PANEL_H : stageSize.h + bubbleReserve,
          position: 'relative',
          flexShrink: 0,
          overflow: 'hidden',
          // 宠物模式在固定 650 宽窗内水平居中（底边由父容器 align-items:flex-end 锁定）
          margin: chatOpen || actionsOpen ? 0 : '0 auto',
          // 画布顶部下移量：与 stage 顶部预留带等高，canvas 底边即 stage 底边
          ['--bubble-extra' as string]: `${chatOpen || actionsOpen ? 0 : bubbleReserve}px`,
        } as React.CSSProperties}
      >
        {/* 智能体主动对话气泡（10s 自动消失，可手动关闭）：挂在宠物头顶居中，测量后钳制在窗口边界内 */}
        {agentMessage && (
          <div
            ref={bubbleRef}
            data-interactive
            style={{
              ...bubbleStyle,
              ...(bubblePos ? { top: bubblePos.top, left: bubblePos.left, transform: 'none' } : {}),
            }}
          >
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
        {(petSystemEnabled && (petFeatures.feedEnabled || petFeatures.playEnabled || petFeatures.restEnabled || petFeatures.affectionEnabled)) && (
          <div style={statusStyle}>
            {petFeatures.feedEnabled && <span>饱:{Math.round(hunger)} </span>}
            {petFeatures.playEnabled && <span>心:{Math.round(mood)} </span>}
            {petFeatures.restEnabled && <span>精:{Math.round(energy)} </span>}
            {petFeatures.affectionEnabled && <span>好:{Math.round(affection)}</span>}
          </div>
        )}

        {/* 聊天与商店入口已移至右键菜单（pet:context-action） */}

        {/* Action buttons（随互动功能开关与宠物状态总开关显隐） */}
        {petSystemEnabled && petFeatures.feedEnabled && (
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
        {petSystemEnabled && petFeatures.restEnabled && (
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
        {petSystemEnabled && petFeatures.playEnabled && (
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
