import { app, BrowserWindow, screen, ipcMain, Menu, protocol, net, nativeImage } from 'electron';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, getLLMConfig, type AppConfig } from './main/config';
import { createLLMService } from './main/llmService';
import {
  ConversationManager,
  type PetStateSnapshot,
} from './main/conversationManager';
import { platformClient, type PlatformAssetType } from './main/platformClient';
import {
  actionLLMService,
  addFramesAction,
  generateAction,
  removeAction,
  resolvePetInfo,
} from './main/petActions';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// petaction:// 协议：渲染端（http origin）加载本地动作帧图的自定义通道
// （必须在 app ready 前注册；handle 在 whenReady 中挂载）
protocol.registerSchemesAsPrivileged([
  { scheme: 'petaction', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } },
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

function applyWindowSize(win: BrowserWindow, chatMode: boolean) {
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
    alwaysOnTop: true,
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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
};

// --- IPC Handlers ---

// Chat: send a message with streaming response
ipcMain.handle('chat:send', async (event, message: string) => {
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
    const messages = conversationManager.buildMessages();

    const fullText = await llmService.chat({
      messages,
      onChunk: (chunk) => {
        win.webContents.send('chat:chunk', chunk);
      },
    });

    conversationManager.addAssistantMessage(fullText);
    return { success: true, text: fullText };
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
    const fullText = await llmService.chat({
      messages,
      onChunk: (chunk) => {
        win.webContents.send('chat:chunk', chunk);
      },
    });
    conversationManager.addAssistantMessage(fullText);
    return { success: true, text: fullText };
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
    mainWindow.webContents.send('pet:settings-changed', updated.petWindow);
  }
  // 宠物互动功能开关变更：通知渲染进程实时显隐按钮与进度条
  if (partial.petFeatures && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet:features-changed', updated.petFeatures);
  }
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
    // 安装新宠物后自动生成配套基础动作（已存在同名则跳过；后台异步，不阻塞安装返回）
    void autoGenerateBaseActions();
  }
  return result;
});

/** 安装宠物后自动生成基础动作：吃饭/走路/休息/玩耍（AI 按当前宠物形象与物种特征设计） */
async function autoGenerateBaseActions() {
  // 等配置写入（petAssetName/petAssetPath）完成后再读宠物信息
  await new Promise((r) => setTimeout(r, 800));
  const BASE_ACTIONS = ['吃饭', '走路', '休息', '玩耍'];
  const existing = new Set(loadConfig().petActions.map((a) => a.name));
  const petInfo = await resolvePetInfo(async (id) => {
    try {
      return (await platformClient.getDetail('pet', id)) as { name?: string };
    } catch {
      return {};
    }
  });
  for (const name of BASE_ACTIONS) {
    try {
      if (existing.has(name)) continue;
      await generateAction(actionLLMService, name, petInfo);
      notifyPetActionsChanged();
    } catch {
      // 单个动作生成失败不阻断其余动作（LLM 不可用/上限等）
      break;
    }
  }
}

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

// Window: toggle chat mode (resize window)
ipcMain.handle('window:toggle-chat', (event, open: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false };

  isChatOpen = open;
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
  if (petDragTimer) {
    clearInterval(petDragTimer);
    petDragTimer = null;
  }
  const [x, y] = old.getPosition();
  createWindow();
  mainWindow?.setPosition(x, y);
  if (!old.isDestroyed()) old.destroy();
}

// --- 宠物动作系统：AI 生成变换动画 / 手动上传帧序列 / 删除（上限 15 个） ---
function notifyPetActionsChanged() {
  mainWindow?.webContents.send('pet:actions-changed', null);
}

ipcMain.handle('actions:generate', async (_event, name: string) => {
  try {
    // 注入当前宠物形象信息（资源名 + 图片尺寸），使 AI 生成的动作贴合现有宠物样式
    const petInfo = await resolvePetInfo(async (id) => {
      try {
        const detail = (await platformClient.getDetail('pet', id)) as { name?: string };
        return detail;
      } catch {
        return {};
      }
    });
    const cfg = loadConfig();
    if (cfg.petAssetPath && fs.existsSync(cfg.petAssetPath)) {
      try {
        const size = nativeImage.createFromPath(cfg.petAssetPath).getSize();
        if (size.width && size.height) {
          petInfo.width = size.width;
          petInfo.height = size.height;
        }
      } catch { /* 图片尺寸读取失败时仅用名称描述 */ }
    }
    const action = await generateAction(actionLLMService, name, petInfo);
    notifyPetActionsChanged();
    return { success: true, action };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
});

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

// --- Proactive Greeting Timer (8.4) ---

let greetingTimer: NodeJS.Timeout | null = null;

function scheduleNextGreeting() {
  if (greetingTimer) clearTimeout(greetingTimer);

  // Random interval between 2-4 hours, only during waking hours
  const hour = new Date().getHours();
  const isWakingHour = hour >= 8 && hour < 22;

  if (!isWakingHour || !llmService.isConfigured()) {
    // Check again in 30 minutes
    greetingTimer = setTimeout(scheduleNextGreeting, 30 * 60 * 1000);
    return;
  }

  const interval = (2 + Math.random() * 2) * 60 * 60 * 1000; // 2-4 hours
  greetingTimer = setTimeout(async () => {
    if (mainWindow && !mainWindow.isDestroyed() && llmService.isConfigured()) {
      mainWindow.webContents.send('chat:greeting-trigger', null);
    }
    scheduleNextGreeting();
  }, interval);
}

app.whenReady().then(() => {
  // petaction://local/?p=<encoded-abs-path> → 本地动作帧图（仅允许 pet-actions 目录内文件）
  const actionsDir = path.join(app.getPath('userData'), 'pet-actions');
  protocol.handle('petaction', (request) => {
    try {
      const filePath = decodeURIComponent(new URL(request.url).searchParams.get('p') || '');
      const normalized = path.normalize(filePath);
      if (!normalized || !normalized.startsWith(actionsDir)) {
        return new Response('forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(normalized).toString());
    } catch (e) {
      return new Response(`bad request: ${e}`, { status: 400 });
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Start proactive greeting scheduler
  scheduleNextGreeting();
});

// Flush any pending debounced pet state write before exiting
app.on('before-quit', flushPendingPetStateSave);

app.on('window-all-closed', () => {
  if (greetingTimer) clearTimeout(greetingTimer);
  if (process.platform !== 'darwin') app.quit();
});
