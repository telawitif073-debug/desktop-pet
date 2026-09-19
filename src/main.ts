import { app, BrowserWindow, screen, ipcMain, Menu, protocol, net, desktopCapturer, session } from 'electron';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, getLLMConfig, type AppConfig, type VoiceAsrApiConfig } from './main/config';
import { createLLMService, type ChatMessage } from './main/llmService';
import {
  ConversationManager,
  type PetStateSnapshot,
} from './main/conversationManager';
import { platformClient, type PlatformAssetType } from './main/platformClient';
import { edgeSpeak } from './main/tts';
import { startAgentProactive } from './main/agentProactive';
import { addFramesAction, removeAction } from './main/petActions';
import { isWandering, startWander, stopWander } from './main/wander';
import AdmZip from 'adm-zip';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// petaction:// 协议：渲染端（http origin）加载本地动作帧图/语音识别模型的自定义通道
// （必须在 app ready 前注册；handle 在 whenReady 中挂载。corsEnabled：speech-asr 的
// wasm 运行时经 fetch 加载模型属跨源请求，需允许 CORS 并在响应中带 ACAO 头）
protocol.registerSchemesAsPrivileged([
  { scheme: 'petaction', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const CHAT_WINDOW_SIZE = { width: 650, height: 450 };
const MARGIN = 20;
const PET_SIZE_MIN = 200;
const PET_SIZE_MAX = 600;

function getPetWindowSize() {
  const { width, height } = loadConfig().petWindow;
  const clamp = (value: number) => Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, Math.round(value)));
  return { width: clamp(width), height: clamp(height) };
}

function getPetOpacity() {
  const opacity = loadConfig().petWindow.opacity;
  return Math.min(1, Math.max(0.1, Number.isFinite(opacity) ? opacity : 1));
}

let mainWindow: BrowserWindow | null = null;
let storeWindow: BrowserWindow | null = null;
let isChatOpen = false;
let currentPetState: PetStateSnapshot = { hunger: 80, mood: 80, energy: 80, affection: 50 };

const llmService = createLLMService(getLLMConfig);

const config = loadConfig();
const conversationManager = new ConversationManager(
  config,
  currentPetState,
  path.join(app.getPath('userData'), 'chat-history.json')
);

function getWindowPosition(chatMode: boolean) {
  const { workArea } = screen.getPrimaryDisplay();
  const size = chatMode ? CHAT_WINDOW_SIZE : getPetWindowSize();
  return {
    x: workArea.x + workArea.width - size.width - MARGIN,
    y: workArea.y + workArea.height - size.height - MARGIN,
  };
}

// 气泡窗口扩展：智能体气泡显示期间窗口向上扩展（底边锁定），顶部腾出气泡带。
// 宠物主体在窗口内位置不变 + 窗口底边不动 ⇒ 宠物屏幕位置不变，气泡不遮挡宠物。
let bubbleExpandBase: Electron.Rectangle | null = null;
let bubbleExpandExtra = 0;
const BUBBLE_EXPAND_EXTRA = 90;

function setBubbleExpand(on: boolean): number {
  if (!mainWindow || mainWindow.isDestroyed()) return 0;
  if (on) {
    if (bubbleExpandBase) return bubbleExpandExtra; // 已处于扩展态：幂等
    const base = mainWindow.getBounds();
    const workArea = screen.getDisplayMatching(base).workArea;
    // 底边锁定向上扩展；顶到 workArea 上缘时按实际空间缩减
    const newY = Math.max(workArea.y, base.y - BUBBLE_EXPAND_EXTRA);
    const extra = base.y - newY;
    if (extra <= 0) return 0;
    // 创建/重排时 min/max 尺寸锁在配置值，先解除否则 setBounds 高度会被钳制
    mainWindow.setMinimumSize(PET_SIZE_MIN, PET_SIZE_MIN);
    mainWindow.setMaximumSize(base.width, base.height + BUBBLE_EXPAND_EXTRA + 20);
    mainWindow.setBounds({ x: base.x, y: newY, width: base.width, height: base.height + extra });
    bubbleExpandBase = base;
    bubbleExpandExtra = extra;
    return extra;
  }
  if (!bubbleExpandBase) return 0;
  const base = bubbleExpandBase;
  bubbleExpandBase = null;
  bubbleExpandExtra = 0;
  mainWindow.setBounds(base);
  // 还原 min/max 尺寸约束（拖拽防膨胀依赖固定尺寸钳制）
  const size = getPetWindowSize();
  mainWindow.setMinimumSize(size.width, size.height);
  mainWindow.setMaximumSize(size.width, size.height);
  // 非渲染端发起的复位（拖拽/重载）需同步渲染端画布偏移
  mainWindow.webContents.send('pet:bubble-expand-changed', 0);
  return 0;
}

function applyWindowSize(win: BrowserWindow, chatMode: boolean) {
  // 窗口重排（面板开合/设置变更）：气泡扩展态直接复位，避免叠加错位
  if (bubbleExpandBase) {
    bubbleExpandBase = null;
    bubbleExpandExtra = 0;
    win.webContents.send('pet:bubble-expand-changed', 0);
  }
  const size = chatMode ? CHAT_WINDOW_SIZE : getPetWindowSize();
  const pos = getWindowPosition(chatMode);
  // Remove size constraints temporarily so resize works
  win.setMinimumSize(size.width, size.height);
  win.setMaximumSize(size.width, size.height);
  win.setSize(size.width, size.height);
  if (!chatMode) win.setOpacity(getPetOpacity());
  win.setPosition(pos.x, pos.y);
}

const createWindow = () => {
  const pos = getWindowPosition(false);
  const petSize = getPetWindowSize();

  mainWindow = new BrowserWindow({
    width: petSize.width,
    height: petSize.height,
    minWidth: petSize.width,
    maxWidth: petSize.width,
    minHeight: petSize.height,
    maxHeight: petSize.height,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    // 宠物窗口置顶可配置（设置页开关），默认置顶
    alwaysOnTop: loadConfig().petWindow?.alwaysOnTop !== false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.on('will-resize', (event) => event.preventDefault());
  mainWindow.setOpacity(getPetOpacity());
  // 整页默认点击穿透（仅宠物本体与按钮可交互，渲染端按命中结果动态开关）
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // --- 临时诊断：追踪窗口尺寸/位置的任何变化来源（确认漂移根因后移除） ---
  let lastLog = 0;
  const winRef = mainWindow;
  const logGeo = (src: string) => {
    const now = Date.now();
    if (now - lastLog < 300) return;
    lastLog = now;
    const [x, y] = winRef.getPosition();
    const [w, h] = winRef.getSize();
    console.log(`[geo] ${src}: pos=(${x},${y}) size=${w}x${h}`);
  };
  winRef.on('resize', () => logGeo('resize'));
  winRef.on('move', () => logGeo('move'));

  // 渲染端 console 转发到主进程 stdout（语音识别等渲染端链路诊断用）
  mainWindow.webContents.on('console-message', (...args: unknown[]) => {
    const params = args[1] as { message?: string } | number;
    const msg = typeof params === 'object' && params ? params.message : String(args[2] ?? '');
    if (msg) console.log(`[renderer] ${msg}`);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
};

// --- IPC Handlers ---

/** 在系统提示后注入可用动作列表：智能体可通过回复末尾的 [动作:名称] 标记控制宠物播放动画 */
function withActionPrompt(messages: ChatMessage[]): void {
  const actions = loadConfig().petActions;
  if (!actions.length) return;
  const sys = messages.find((m) => m.role === 'system');
  if (!sys) return;
  sys.content +=
    `\n\n你可以控制桌面宠物的动画播放：在回复的最末尾追加 [动作:动作名] 标记即可触发对应动作（标记会被剥离，不会显示给用户）。` +
    `动作名必须严格从以下列表中选择：${actions.map((a) => a.name).join('、')}。` +
    `仅当动作与对话内容自然相关时才附带，每条回复最多一个，不需要时不要添加。`;
}

/** 解析回复末尾的 [动作:名称] 标记：剥离文本并通过 pet:play-action 触发播放，返回剥离后的文本 */
function extractActionTag(text: string, win: BrowserWindow | null): string {
  const m = text.match(/\s*\[动作[:：]([^\]]{1,30})\]\s*$/);
  if (!m || m.index === undefined) return text;
  const found = loadConfig().petActions.find((a) => a.name === m[1].trim());
  if (found && win && !win.isDestroyed()) {
    win.webContents.send('pet:play-action', found.id);
  }
  return text.slice(0, m.index).trimEnd();
}

// Chat: send a message with streaming response（images 为可选附图 dataUrl，走 OpenAI vision 多模态格式）
ipcMain.handle('chat:send', async (event, message: string, images?: string[]) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, error: 'No window' };

  if (!llmService.isConfigured()) {
    return {
      success: false,
      error: '请先在设置中配置 API Key 和模型。',
    };
  }

  try {
    conversationManager.addUserMessage(message);
    lastUserMessageAt = Date.now();
    const messages = conversationManager.buildMessages();
    withActionPrompt(messages);
    // 附图：末条 user 消息转为多模态 content（聊天历史仍存纯文本，token 友好）
    if (images?.length) {
      const last = messages[messages.length - 1];
      if (last?.role === 'user') {
        last.content = [
          { type: 'text', text: message },
          ...images.slice(0, 4).map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ];
      }
    }

    let streamedTail = '';
    const fullText = await llmService.chat({
      messages,
      onChunk: (chunk) => {
        streamedTail += chunk;
        // 扣留疑似动作标记（"[动" 开头的尾部）不推送，避免标记闪现；完成后以剥离后的全文替换
        const idx = streamedTail.lastIndexOf('[动');
        if (idx >= 0) {
          const safe = streamedTail.slice(0, idx);
          streamedTail = streamedTail.slice(idx);
          if (safe) win.webContents.send('chat:chunk', safe);
        } else {
          win.webContents.send('chat:chunk', streamedTail);
          streamedTail = '';
        }
      },
    });

    const replyText = extractActionTag(fullText, win);
    conversationManager.addAssistantMessage(replyText);
    return { success: true, text: replyText };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
});

// Chat: clear conversation history
ipcMain.handle('chat:clear', () => {
  conversationManager.clearHistory();
  return { success: true };
});

// Chat: get persisted history (to restore UI after app restart)
ipcMain.handle('chat:history', () => {
  return { success: true, history: conversationManager.getHistory() };
});

// Chat: generate a proactive greeting (used by greeting timer)
ipcMain.handle('chat:greet', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, error: 'No window' };

  if (!llmService.isConfigured()) {
    return { success: false, error: 'Not configured' };
  }

  try {
    const messages = conversationManager.buildGreetingMessages();
    withActionPrompt(messages);
    const fullText = await llmService.chat({
      messages,
      onChunk: (chunk) => {
        win.webContents.send('chat:chunk', chunk);
      },
    });
    const replyText = extractActionTag(fullText, win);
    conversationManager.addAssistantMessage(replyText);
    return { success: true, text: replyText };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// Config: get
ipcMain.handle('config:get', () => {
  return loadConfig();
});

// Config: set
ipcMain.handle('config:set', (_event, partial: Partial<AppConfig>) => {
  const updated = saveConfig(partial);
  conversationManager.updateConfig(updated);
  // 宠物窗口设置变更：实时应用大小与透明度，并通知渲染进程重绘
  if (partial.petWindow && mainWindow && !mainWindow.isDestroyed()) {
    console.log(`[geo] config:set petWindow=${JSON.stringify(partial.petWindow)}`);
    if (!isChatOpen) applyWindowSize(mainWindow, false);
    else mainWindow.setOpacity(getPetOpacity());
    // 置顶开关实时生效
    mainWindow.setAlwaysOnTop(updated.petWindow?.alwaysOnTop !== false);
    mainWindow.webContents.send('pet:settings-changed', updated.petWindow);
  }
  // 宠物互动功能开关变更：通知渲染进程实时显隐按钮与进度条
  if (partial.petFeatures && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet:features-changed', updated.petFeatures);
  }
  // 感知开关变更：实时启停桌面持续感知循环（渲染端循环自行监听配置）
  if (partial.petSenses) syncScreenSenseLoop();
  return updated;
});

// Platform: resource search, details, download and installation
ipcMain.handle('platform:search', (_event, type: PlatformAssetType, query: string, page = 1) =>
  platformClient.search(type, query, page),
);

ipcMain.handle('platform:getDetail', (_event, type: PlatformAssetType, id: string) =>
  platformClient.getDetail(type, id),
);

ipcMain.handle('platform:download', (_event, type: PlatformAssetType, id: string) =>
  platformClient.download(type, id),
);

// 安装/卸载宠物资源后通知宠物窗口重新加载（图片与可点击边界随新图重算）
const notifyPetAssetChanged = () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet:asset-changed', null);
  }
};

ipcMain.handle('platform:install', async (_event, type: PlatformAssetType, id: string) => {
  const result = await platformClient.install(type, id);
  if (type === 'pet') {
    notifyPetAssetChanged();
    // 宠物附带动作已随安装注册，通知动作面板刷新列表与互动绑定
    notifyPetActionsChanged();
  }
  return result;
});

ipcMain.handle('platform:uninstall', async (_event, type: PlatformAssetType, id: string) => {
  const result = await platformClient.uninstall(type, id);
  if (type === 'pet') notifyPetAssetChanged();
  return result;
});

ipcMain.handle('platform:getInstalledPet', () => platformClient.getInstalledPet());

ipcMain.handle('platform:getInstalledAgent', () => platformClient.getInstalledAgent());

ipcMain.handle('platform:login', (_event, identifier: string, password: string) =>
  platformClient.login(identifier, password),
);

ipcMain.handle('platform:logout', () => platformClient.logout());

ipcMain.handle('platform:open-store', () => {
  if (storeWindow && !storeWindow.isDestroyed()) {
    storeWindow.focus();
    return { success: true };
  }

  const platformConfig = loadConfig().platform;
  storeWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: '资源商店',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  storeWindow.on('closed', () => {
    storeWindow = null;
  });
  storeWindow.loadURL(platformConfig.frontendUrl);
  return { success: true };
});

// Pet state: update (sent from renderer so main can use it in system prompt)
// Renderer decays pet state every 5s so this IPC fires constantly. Persist to
// disk at most once per minute (debounced) and flush on quit, instead of
// writing config.json ~17k times per day.
const PET_STATE_SAVE_DELAY = 60 * 1000;
let petStateSaveTimer: NodeJS.Timeout | null = null;

function schedulePetStateSave() {
  if (petStateSaveTimer) return;
  petStateSaveTimer = setTimeout(() => {
    petStateSaveTimer = null;
    saveConfig({ petState: currentPetState });
  }, PET_STATE_SAVE_DELAY);
}

function flushPendingPetStateSave() {
  if (!petStateSaveTimer) return;
  clearTimeout(petStateSaveTimer);
  petStateSaveTimer = null;
  saveConfig({ petState: currentPetState });
}

ipcMain.handle('pet:state-update', (_event, state: PetStateSnapshot) => {
  currentPetState = state;
  conversationManager.updatePetState(state);
  schedulePetStateSave();
  return { success: true };
});

// 气泡扩展开关（渲染端在智能体气泡显示期间调用）：返回实际扩展高度 px（0=未扩展）
ipcMain.handle('pet:set-bubble-expand', (_event, on: boolean) => setBubbleExpand(!!on));

// Window: toggle chat mode (resize window)
ipcMain.handle('window:toggle-chat', (event, open: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false };

  isChatOpen = open;
  // 面板展开与漫步互斥：进行中的漫步立即停止（窗口随即按面板尺寸重排）
  if (open && isWandering()) {
    stopWander();
    win.webContents.send('pet:wander-state', false);
  }
  applyWindowSize(win, open);
  return { success: true, isChatOpen: open };
});

ipcMain.handle('window:is-chat-open', () => {
  return isChatOpen;
});

// 动作管理面板：与聊天面板同一窗口尺寸机制（展开 = 面板尺寸）
let isActionsOpen = false;
ipcMain.handle('window:toggle-actions', (event, open: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false };
  isActionsOpen = open;
  // 面板展开与漫步互斥：进行中的漫步立即停止
  if (open && isWandering()) {
    stopWander();
    win.webContents.send('pet:wander-state', false);
  }
  applyWindowSize(win, open);
  return { success: true };
});

// 渲染端按命中测试结果动态开关点击穿透（forward 保持 mousemove 可见以便持续检测）
let ignoreToggleCount = 0;
ipcMain.on('window:set-ignore-mouse', (_event, ignore: boolean) => {
  ignoreToggleCount++;
  if (ignoreToggleCount % 20 === 1) console.log(`[debug] set-ignore-mouse #${ignoreToggleCount} -> ${ignore}`);
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (!win) return;
  win.setIgnoreMouseEvents(ignore, { forward: true });
});

// 宠物拖拽：基线绝对映射 + setBounds 锁定尺寸。
// 根因：缩放屏上反复 setPosition 会因 DIP↔物理像素舍入使窗口外框被逐帧撑大
// （绕过 min/max 约束），累积表现为窗口缓慢变大并向"下延伸"。
// 位置 = 起始窗口位置 + (当前光标 - 起始光标)：坐标差异只是常量偏移，不累积；
// 每次用 setBounds 同时写回固定尺寸，OS 层任何撑大都会被立即纠正。
let petDragging = false;
let petDragTimer: NodeJS.Timeout | null = null;
const petDragBase = {
  cursor: { x: 0, y: 0 },
  win: { x: 0, y: 0 },
  size: { w: 0, h: 0 },
};

function petDragTick() {
  if (!petDragging || !mainWindow || mainWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  mainWindow.setBounds({
    x: petDragBase.win.x + (cursor.x - petDragBase.cursor.x),
    y: petDragBase.win.y + (cursor.y - petDragBase.cursor.y),
    width: petDragBase.size.w,
    height: petDragBase.size.h,
  });
}

ipcMain.on('pet:begin-drag', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 拖拽与漫步互斥：拖拽开始时中断进行中的漫步
  if (isWandering()) {
    stopWander();
    mainWindow.webContents.send('pet:wander-state', false);
  }
  // 退出气泡扩展态：拖拽基线与锁定尺寸按常规窗口计算（内部会通知渲染端复位画布偏移）
  setBubbleExpand(false);
  const [wx, wy] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  petDragBase.cursor = screen.getCursorScreenPoint();
  petDragBase.win = { x: wx, y: wy };
  // 尺寸基准取配置值（聊天/动作面板模式窗口已变尺寸，保持当前值）：
  // 之前会话残留的 DPI 舍入膨胀在开拖瞬间自动归位，蠕动无法跨会话累积
  // （面板展开时若误用配置值基准，会把 650x450 的窗口拖回 300x300，面板被截断）
  const petSize = getPetWindowSize();
  petDragBase.size = isChatOpen || isActionsOpen ? { w, h } : { w: petSize.width, h: petSize.height };
  petDragging = true;
  // 主进程 16ms 轮询兜底：鼠标快速甩动飞出窗口时渲染端 mousemove 会中断，
  // 轮询直接读光标位置继续跟随，松手由渲染端 pet:end-drag 结束
  if (!petDragTimer) petDragTimer = setInterval(petDragTick, 16);
});

// 渲染端 mousemove 触发的即时更新（低于 16ms 轮询延迟，拖拽更跟手）
ipcMain.on('pet:drag-move', () => petDragTick());

ipcMain.on('pet:end-drag', () => {
  petDragging = false;
  if (petDragTimer) {
    clearInterval(petDragTimer);
    petDragTimer = null;
  }
});

// 随机漫步：渲染端调度（5s 一次掷骰），主进程校验互斥/开关/精力后执行窗口平移。
// 漫步状态经 pet:wander-state 推送渲染端，驱动 moving 标志。

/** 移动类动作名（用户手动添加的帧序列/clip 动作可命名为这些名字让宠物具备漫步资格） */
const MOVE_ACTION_RE = /^(moving|move|walk|走路|移动)$/i;

/** 漫步门槛：宠物需具备移动表现——动作列表含移动类动作；否则窗口平移只是无动画滑行 */
function hasMoveCapability(): boolean {
  const config = loadConfig();
  if (config.petActions?.some((a) => MOVE_ACTION_RE.test(a.name))) return true;
  return false;
}

/** media 权限网关：麦克风/摄像头请求按商店设置的感知开关放行（隐私默认全关） */
function setupMediaPermissionGate(): void {
  const allowed = (mediaTypes: string[] | undefined): boolean => {
    const senses = loadConfig().petSenses;
    if (!senses) return false;
    if (mediaTypes?.includes('video')) return !!senses.camera;
    if (mediaTypes?.includes('audio')) return !!senses.mic;
    return !!(senses.mic || senses.camera);
  };
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      callback(allowed((details as { mediaTypes?: string[] }).mediaTypes));
      return;
    }
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    if (permission === 'media') {
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
      return allowed(mediaTypes);
    }
    return true;
  });
}

// --- 持续感知：桌面定时查看（主进程）+ 摄像头帧理解 + 视觉描述 ---
// 视觉理解走智谱 glm-4v-flash（免费，与聊天 Key 共用）；非智谱 API 时用当前模型尝试，失败静默。

const SCREEN_SENSE_MS = 10 * 60 * 1000;
let screenSenseTimer: NodeJS.Timeout | null = null;

/** 视觉理解：描述一张截图/摄像头帧，以桌宠口吻给出一句轻松评论 */
async function describeSenseImage(dataUrl: string, kind: 'screen' | 'camera'): Promise<string | null> {
  const cfg = getLLMConfig();
  if (!cfg.apiKey || !cfg.baseUrl) return null;
  const isZhipu = /bigmodel\.cn/i.test(cfg.baseUrl);
  const model = isZhipu ? 'glm-4v-flash' : cfg.model;
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: kind === 'screen'
                ? '这是用户电脑桌面的截图。观察屏幕上正在发生什么（打开了什么应用/在做什么），用一两句话以桌面宠物的口吻轻松评论（中文，不要逐字读屏幕）。'
                : '这是摄像头拍到的画面。描述你看到的内容，用一两句话以桌面宠物的口吻轻松评论（中文）。',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return text || null;
  } catch {
    return null;
  }
}

async function screenSenseTick(): Promise<void> {
  if (!loadConfig().petSenses?.screen) return;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1024, height: 576 } });
    const primaryId = String(screen.getPrimaryDisplay().id);
    const target = sources.find((s) => s.display_id === primaryId) || sources[0];
    if (!target) return;
    const jpeg = target.thumbnail.toJPEG(70);
    const desc = await describeSenseImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`, 'screen');
    if (desc) deliverAgentMessage(desc);
  } catch {
    // 感知失败静默（截屏被系统拒绝/网络异常等），下轮重试
  }
}

/** 按当前配置启停桌面持续感知循环（config:set 后调用，开关切换实时生效） */
function syncScreenSenseLoop(): void {
  if (screenSenseTimer) {
    clearInterval(screenSenseTimer);
    screenSenseTimer = null;
  }
  if (loadConfig().petSenses?.screen) {
    screenSenseTimer = setInterval(() => void screenSenseTick(), SCREEN_SENSE_MS);
  }
}

ipcMain.handle('pet:wander-start', (_event, opts: { dx: number; durationMs: number }) => {
  const reject = (reason: string) => ({ ok: false, reason });
  if (!mainWindow || mainWindow.isDestroyed()) return reject('no-window');
  if (petDragging || isChatOpen || isActionsOpen || isWandering()) return reject('busy');
  if (!loadConfig().randomMoveEnabled) return reject('disabled');
  if (!hasMoveCapability()) return reject('no-move-anim');
  if (currentPetState.energy <= 30) return reject('tired');
  const dx = Number.isFinite(opts?.dx) ? Math.max(-400, Math.min(400, Math.round(opts.dx))) : 0;
  const durationMs = Math.max(500, Math.min(10_000, Math.round(opts?.durationMs ?? 2500)));
  if (!dx) return reject('noop');
  const win = mainWindow;
  startWander(win, dx, durationMs, () => {
    if (!win.isDestroyed()) win.webContents.send('pet:wander-state', false);
  });
  win.webContents.send('pet:wander-state', true);
  return { ok: true };
});

// Edge TTS 语音合成：渲染端传文本与音色/语气参数，返回 mp3 base64（失败 null，渲染端回退系统 TTS）
ipcMain.handle('tts:speak', (_event, args: Parameters<typeof edgeSpeak>[0]) => edgeSpeak(args));

// --- sherpa-onnx 离线语音识别模型（语音唤醒用） ---
// 识别引擎为 sherpa-onnx zipformer（渲染端 speech-asr SDK）。平台不内置/不自动下载
// 模型（对齐「资源由用户自行配置」原则）：用户在聊天设置中提供模型包（本地 zip 路径
// 或下载 URL），主进程校验解压到 userData 模型目录；wasm 运行时随 npm 包自带。
const SHERPA_DIR_NAME = 'sherpa-asr';
const SHERPA_DATA_MIN_BYTES = 100 * 1024 * 1024; // .data 权重包约 230MB，防半截文件误判
/** 模型包必须包含的关键文件（speech-asr SDK 按 m_path 固定文件名加载） */
const SHERPA_REQUIRED_FILES = [
  'sherpa-onnx-wasm-main-asr.data',
  'sherpa-onnx-wasm-main-asr.js',
  'sherpa-onnx-wasm-main-asr.wasm',
  'sherpa-onnx-asr.js',
];

function sherpaModelDir(): string {
  return path.join(app.getPath('userData'), SHERPA_DIR_NAME);
}

/** 解压产物平铺到目录根：SDK 按 <m_path>/<固定文件名> 拼路径，不认子目录 */
function flattenModelDir(dir: string): void {
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try { fs.rmdirSync(full); } catch { /* 非空目录保留 */ }
      } else if (d !== dir) {
        const target = path.join(dir, entry.name);
        if (!fs.existsSync(target)) fs.renameSync(full, target);
      }
    }
  };
  walk(dir);
}

/** 模型是否已导入就绪 */
function sherpaModelReady(): boolean {
  try {
    const dataPath = path.join(sherpaModelDir(), 'sherpa-onnx-wasm-main-asr.data');
    return fs.statSync(dataPath).size >= SHERPA_DATA_MIN_BYTES;
  } catch {
    return false;
  }
}

/** 未导入提醒节流（渲染端持续聆听/手动识别可能反复询问，10 分钟最多提醒一次） */
let sherpaModelMissingNotifiedAt = 0;

ipcMain.handle('sherpa:get-model', () => {
  if (sherpaModelReady()) return { ok: true, path: sherpaModelDir() };
  if (Date.now() - sherpaModelMissingNotifiedAt > 10 * 60 * 1000) {
    sherpaModelMissingNotifiedAt = Date.now();
    deliverAgentMessage('语音模型包还未导入，请打开聊天设置 →「宠物怎么听懂你说话」导入模型文件，或改用其他识别方式');
  }
  return { ok: false };
});

/** 从用户提供的模型包导入（本地 zip 路径或下载 URL），校验后解压平铺到模型目录 */
async function importSherpaModel(source: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const src = (source || '').trim();
  if (!src) return { ok: false, error: '请填写模型包的本地路径或下载 URL' };
  const dir = sherpaModelDir();
  const tmpZip = path.join(app.getPath('userData'), 'sherpa-model-import.zip');
  const partPath = `${tmpZip}.part`;
  try {
    if (/^https?:\/\//i.test(src)) {
      const resp = await net.fetch(src, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!resp.ok || !resp.body) throw new Error(`下载失败 HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(partPath, buf);
      fs.renameSync(partPath, tmpZip);
    } else {
      const local = path.normalize(src);
      if (!fs.existsSync(local)) throw new Error(`本地文件不存在：${local}`);
      fs.copyFileSync(local, tmpZip);
    }
    // 解压前先校验关键文件齐全，避免污染模型目录
    const zip = new AdmZip(tmpZip);
    const names = zip.getEntries().map((e) => path.basename(e.entryName));
    for (const f of SHERPA_REQUIRED_FILES) {
      if (!names.includes(f)) throw new Error(`模型包缺少文件：${f}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    zip.extractAllTo(dir, true);
    flattenModelDir(dir);
    fs.rmSync(tmpZip, { force: true });
    return { ok: true, path: dir };
  } catch (err) {
    try { fs.rmSync(partPath, { force: true }); } catch { /* 清理失败忽略 */ }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

ipcMain.handle('sherpa:import-model', (_event, source: string) => importSherpaModel(source));

// --- 云端语音识别（宠物「听懂说话」的在线来源） ---
// 音频由渲染端采集并编码 WAV，经 IPC 到主进程发起上游请求（Key 不进渲染端，与 LLM 同模式）。
// 生效配置按 config.voiceAsr.source 实时解析：api=用户自配接口；agent=已安装智能体自带（可替换 Key）。

/** 解析当前生效的云端识别配置；未配置/不完整返回面向用户的错误说明 */
function resolveAsrApiConfig(): { cfg: VoiceAsrApiConfig } | { error: string } {
  const { voiceAsr, installedAgentConfig } = loadConfig();
  const source = voiceAsr?.source || 'local';
  if (source === 'api') {
    const cfg = voiceAsr?.api;
    if (!cfg?.baseUrl || !cfg?.model) return { error: '在线识别接口还没填好（接口地址和模型名必填），请到聊天设置补全' };
    return { cfg };
  }
  if (source === 'agent') {
    const asr = (installedAgentConfig as { asr?: VoiceAsrApiConfig } | null | undefined)?.asr;
    if (!asr?.baseUrl || !asr?.model) return { error: '当前智能体没有自带语音识别，请在聊天设置里换一种方式' };
    return { cfg: { ...asr, apiKey: (voiceAsr?.agentApiKey || '').trim() || asr.apiKey || '' } };
  }
  return { error: '当前使用本地语音模型，不经过在线识别' };
}

/** 调用上游云端识别：transcribe=转写接口；chat=多模态聊天模型 */
async function callAsrUpstream(cfg: VoiceAsrApiConfig, wavBase64: string): Promise<string> {
  const base = cfg.baseUrl.trim().replace(/\/+$/, '');
  if (cfg.mode === 'chat') {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '请将这段语音准确转写为文字，只输出转写内容，不要任何解释。' },
            { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } },
          ],
        }],
      }),
    });
    if (!resp.ok) throw new Error(`识别接口返回 HTTP ${resp.status}`);
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content || '').trim();
  }
  // transcribe：multipart 上传 wav 文件
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(wavBase64, 'base64')], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', cfg.model);
  if (cfg.language) form.append('language', cfg.language);
  const resp = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined,
    body: form,
  });
  if (!resp.ok) throw new Error(`识别接口返回 HTTP ${resp.status}`);
  const data = await resp.json() as { text?: string };
  return (data.text || '').trim();
}

ipcMain.handle('asr:transcribe', async (_event, payload: { wavBase64?: string }) => {
  const wavBase64 = (payload?.wavBase64 || '').trim();
  if (!wavBase64) return { ok: false, error: '没有收到音频数据' };
  const resolved = resolveAsrApiConfig();
  if ('error' in resolved) return { ok: false, error: resolved.error };
  try {
    const text = await callAsrUpstream(resolved.cfg, wavBase64);
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// "重新加载页面"禁止直接 webContents.reload()：透明无边框窗口在 Windows 上重载
// 会丢失透明度（变成不透明白块），且主进程残留状态（isChatOpen/点击穿透标志/拖拽
// 定时器）与重载后渲染端的初始状态不同步，导致应用不可用。改为整窗重建：保留
// 原位置，其余状态全部归零（尺寸回配置值、回到宠物模式）。
function recreatePetWindow() {
  const old = mainWindow;
  if (!old || old.isDestroyed()) return;
  isChatOpen = false;
  isActionsOpen = false;
  petDragging = false;
  bubbleExpandBase = null;
  bubbleExpandExtra = 0;
  stopWander();
  if (petDragTimer) {
    clearInterval(petDragTimer);
    petDragTimer = null;
  }
  const [x, y] = old.getPosition();
  createWindow();
  mainWindow?.setPosition(x, y);
  if (!old.isDestroyed()) old.destroy();
}

// --- 宠物动作系统：手动上传帧序列 / 删除（上限 15 个） ---
function notifyPetActionsChanged() {
  mainWindow?.webContents.send('pet:actions-changed', null);
}

ipcMain.handle(
  'actions:add-frames',
  (_event, name: string, files: Array<{ filename: string; data: Uint8Array }>) => {
    try {
      const buffers = (files || []).map((f) => ({ filename: f.filename, data: Buffer.from(f.data) }));
      const action = addFramesAction(name, buffers);
      notifyPetActionsChanged();
      return { success: true, action };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
);

ipcMain.handle('actions:remove', (_event, id: string) => {
  try {
    removeAction(id);
    notifyPetActionsChanged();
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// 右键宠物：原生上下文菜单（含原页面右键的刷新等选项）
ipcMain.on('pet:show-context-menu', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = (action: string) => mainWindow?.webContents.send('pet:context-action', action);
  // 互动功能开关：关闭的功能不出现在右键菜单中
  const features = loadConfig().petFeatures;
  // 动作子菜单：列出全部动作供播放（上限 15 个）
  const actions = loadConfig().petActions;
  const actionItems: Electron.MenuItemConstructorOptions[] = actions.map((a) => ({
    label: `${a.name}（${a.source === 'ai' ? 'AI' : '手动'}）`,
    click: () => mainWindow?.webContents.send('pet:play-action', a.id),
  }));
  const menu = Menu.buildFromTemplate([
    { label: isChatOpen ? '收起聊天' : '聊天', click: () => send('toggle-chat') },
    { label: '打开商店', click: () => send('open-store') },
    { type: 'separator' },
    ...(features.feedEnabled ? [{ label: '喂食', click: () => send('feed') }] : []),
    ...(features.restEnabled ? [{ label: '休息', click: () => send('rest') }] : []),
    ...(features.playEnabled ? [{ label: '玩耍', click: () => send('play') }] : []),
    { type: 'separator' },
    ...(actionItems.length ? [{ label: '播放动作', submenu: actionItems }] : []),
    { label: '动作管理', click: () => mainWindow?.webContents.send('pet:toggle-actions', null) },
    { type: 'separator' },
    { label: '重新加载页面', click: () => recreatePetWindow() },
    { label: '退出', click: () => app.quit() },
  ]);
  menu.popup({ window: mainWindow });
});

// --- Agent Proactive Conversation（智能体主动发起对话） ---

let lastUserMessageAt = 0;

/** 智能体消息投递（主动对话与持续感知共用）：气泡 + 写入聊天历史 */
function deliverAgentMessage(text: string): void {
  const clean = extractActionTag(text, mainWindow);
  conversationManager.addAssistantMessage(clean);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet:agent-message', clean);
  }
}

function startProactive() {
  startAgentProactive({
    getConfig: () => loadConfig(),
    isConfigured: () => llmService.isConfigured(),
    isUserActive: () => Date.now() - lastUserMessageAt < 2 * 60_000,
    getState: () => currentPetState,
    getSystemPrompt: () => conversationManager.getSystemPrompt(),
    getRecentHistory: (n) => conversationManager.getHistory().slice(-n),
    // 主动对话同样注入动作列表：智能体可在气泡消息中触发动作播放
    generate: async (messages) => {
      withActionPrompt(messages);
      return await llmService.chat({ messages });
    },
    deliver: deliverAgentMessage,
  });
}

app.whenReady().then(() => {
  // 麦克风/摄像头权限网关：按商店设置的感知开关放行
  setupMediaPermissionGate();
  // 感知开关已开时启动桌面持续感知循环
  syncScreenSenseLoop();

  // 录屏源提供（渲染端 getDisplayMedia 必需）：按「查看桌面」开关网关放行
  session.defaultSession.setDisplayMediaRequestHandler((_options, callback) => {
    if (!loadConfig().petSenses?.screen) {
      callback({});
      return;
    }
    void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const primaryId = String(screen.getPrimaryDisplay().id);
      const target = sources.find((s) => s.display_id === primaryId) || sources[0];
      callback({ video: target });
    });
  });

  // 感知-查看桌面：截取屏幕画面返回 jpeg dataUrl（需在商店设置中开启）
  ipcMain.handle('sense:capture-screen', async () => {
    if (!loadConfig().petSenses?.screen) {
      return { success: false, error: '未开启「查看桌面」权限（商店 → 设置 → 感知能力）' };
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const target = sources.find((s) => s.display_id === primaryId) || sources[0];
      if (!target) return { success: false, error: '未找到可截取的屏幕' };
      // NativeImage.toDataURL 不支持质量参数，转 JPEG buffer 控制 base64 体积
      const jpeg = target.thumbnail.toJPEG(75);
      return { success: true, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 感知-摄像头持续帧：渲染端定时抓帧上送，视觉理解后触发主动对话（需在商店设置中开启）
  ipcMain.handle('sense:camera-frame', async (_event, dataUrl: string) => {
    if (!loadConfig().petSenses?.camera) return { success: false, error: '未开启摄像头感知' };
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return { success: false, error: '无效的图像数据' };
    const desc = await describeSenseImage(dataUrl, 'camera');
    if (desc) deliverAgentMessage(desc);
    return { success: true };
  });

  // petaction://local/<filename>?p=<encoded-abs-path> → 本地资源文件
  // （动作帧图 / 3D 模型 / sherpa 语音模型：仅允许 pet-actions、pets 与 sherpa-asr
  //   三个目录内文件；path 段携带真实文件名，供 pixi/three 加载器按扩展名选择解析器）
  const actionsDir = path.join(app.getPath('userData'), 'pet-actions');
  const petsDir = path.join(app.getPath('userData'), 'pets');
  // sherpa 语音模型目录（渲染端 speech-asr SDK 按 <m_path>/<文件名> 经 petaction:// 加载）
  const sherpaAsrDir = sherpaModelDir();
  // 文件名 → 绝对路径索引：Live2D/GLTF 等加载器按模型 URL 解析相对资源时丢失 ?p= 参数，
  // 按 path 段文件名在白名单目录内兜底查找（懒构建，目录小、开销可忽略）
  let fileIndex: Map<string, string> | null = null;
  const buildFileIndex = () => {
    const map = new Map<string, string>();
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (!map.has(entry.name)) map.set(entry.name, full);
      }
    };
    walk(actionsDir);
    walk(petsDir);
    walk(sherpaAsrDir);
    return map;
  };
  protocol.handle('petaction', async (request) => {
    try {
      const url = new URL(request.url);
      let normalized = path.normalize(decodeURIComponent(url.searchParams.get('p') || ''));
      if (!url.searchParams.get('p')) {
        // 无 ?p=：取 path 段末段文件名兜底解析（sherpa 模型目录 URL 即此形式）
        const name = decodeURIComponent(url.pathname.split('/').pop() || '');
        fileIndex = fileIndex ?? buildFileIndex();
        const resolved = fileIndex.get(name);
        if (!name || !resolved) return new Response('not found', { status: 404 });
        normalized = resolved;
      }
      if (
        !normalized ||
        !(normalized.startsWith(actionsDir) || normalized.startsWith(petsDir) || normalized.startsWith(sherpaAsrDir))
      ) {
        return new Response('forbidden', { status: 403 });
      }
      // dev 下渲染端是 http origin，fetch petaction:// 属跨源，需带 CORS 头
      const resp = await net.fetch(pathToFileURL(normalized).toString());
      const headers = new Headers(resp.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(resp.body, { status: resp.status, headers });
    } catch (e) {
      return new Response(`bad request: ${e}`, { status: 400 });
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Start agent proactive conversation scheduler
  startProactive();
});

// Flush any pending debounced pet state write before exiting
app.on('before-quit', flushPendingPetStateSave);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
