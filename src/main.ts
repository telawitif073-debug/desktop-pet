import { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, getLLMConfig, DEFAULT_TTS_CLOUD_CONFIG, type AppConfig, type VoiceConfig } from './main/config';
import {
  AbortedError,
  StreamInterruptError,
  createLLMService,
  type ChatMessage,
} from './main/llmService';
import { ConversationManager } from './main/conversationManager';
import { platformClient, type PlatformAssetType, type PublishPayload } from './main/platformClient';
import { ensurePlatformServices } from './main/platformRunner';
import { pullAfterLogin, scheduleUpload, flushAllOnQuit, bindChatStore } from './main/cloudSync';
import { edgeSpeak } from './main/tts';
import { synthVoice, testGptsovitsEngine } from './main/ttsCloud';
import { startAgentProactive } from './main/agentProactive';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

/** 对话窗口 / 工作室窗口的默认尺寸 */
const CHAT_WINDOW_SIZE = { width: 360, height: 620 };
const STUDIO_WINDOW_SIZE = { width: 1100, height: 720 };

let chatWindow: BrowserWindow | null = null;
let studioWindow: BrowserWindow | null = null;
let storeWindow: BrowserWindow | null = null;
/** 内嵌在资源中心窗口内容区的子视图（同一份桌面渲染包 #/workshop/embedded） */
let workshopView: WebContentsView | null = null;
/** 待投放的内嵌工作区（资源中心导航指定，如 agents/voices） */
let workshopTab: string | undefined;

const llmService = createLLMService(getLLMConfig);

const config = loadConfig();
// 第三参 = 旧版单档案聊天记录文件：构造时自动迁移进 config.profileMessages[激活档案] 并删除旧文件
const conversationManager = new ConversationManager(
  config,
  path.join(app.getPath('userData'), 'chat-history.json')
);
bindChatStore(conversationManager);

/** 渲染端入口页（dev 用 Vite server，打包后用构建产物） */
function rendererUrl(hash = ''): { kind: 'url'; url: string } | { kind: 'file'; file: string; hash: string } {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return { kind: 'url', url: `${MAIN_WINDOW_VITE_DEV_SERVER_URL}${hash}` };
  }
  return { kind: 'file', file: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), hash };
}

// ── 窗口创建 ──────────────────────────────────────────────────────────────

/** 对话窗口：承载聊天 UI 与设置面板（普通窗口，非透明） */
function openChatWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return chatWindow;
  }
  chatWindow = new BrowserWindow({
    width: CHAT_WINDOW_SIZE.width,
    height: CHAT_WINDOW_SIZE.height,
    minWidth: 340,
    minHeight: 420,
    title: '对话',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatWindow.on('closed', () => {
    chatWindow = null;
  });
  // 网页 title 不覆盖窗口标题：窗口/Taskbar 保持「对话」
  chatWindow.on('page-title-updated', (event) => event.preventDefault());
  const target = rendererUrl();
  if (target.kind === 'url') void chatWindow.loadURL(target.url);
  else void chatWindow.loadFile(target.file);
  return chatWindow;
}

/** 工作室窗口：智能体 / 音色 / 发布（#/workshop 路由） */
function openStudioWindow(): BrowserWindow {
  if (studioWindow && !studioWindow.isDestroyed()) {
    studioWindow.focus();
    return studioWindow;
  }
  studioWindow = new BrowserWindow({
    width: STUDIO_WINDOW_SIZE.width,
    height: STUDIO_WINDOW_SIZE.height,
    minWidth: 860,
    minHeight: 560,
    title: '创作中心',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  studioWindow.on('closed', () => {
    studioWindow = null;
  });
  // 网页 title 不覆盖窗口标题：窗口/Taskbar 保持「创作中心」
  studioWindow.on('page-title-updated', (event) => event.preventDefault());
  const target = rendererUrl('#/workshop');
  if (target.kind === 'url') void studioWindow.loadURL(target.url);
  else void studioWindow.loadFile(target.file, { hash: '/workshop' });
  return studioWindow;
}

/** 商店启动提示页（拉起平台服务期间展示，避免白屏） */
function storeStatusPage(title: string, detail: string): string {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>资源中心</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1f22;color:#d6d7d9;font-family:system-ui,'Microsoft YaHei',sans-serif}
.box{text-align:center}.spin{width:36px;height:36px;margin:0 auto 18px;border:3px solid #4a5568;border-top-color:#4a9eff;border-radius:50%;animation:s .9s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}h2{font-size:17px;font-weight:600;margin:0 0 10px}p{font-size:13px;color:#8b8f96;margin:0}</style></head>
<body><div class="box"><div class="spin"></div><h2>${title}</h2><p>${detail}</p></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// 资源中心（平台 Web 独立窗口）：浏览/安装资源、我的资源与审核状态、管理后台；
// 发布资源已收口到创作中心「上传/发布」工作区，这里不再有独立的上传页。
async function openStoreWindow(): Promise<{ success: boolean }> {
  if (storeWindow && !storeWindow.isDestroyed()) {
    storeWindow.focus();
    return { success: true };
  }

  const platformConfig = loadConfig().platform;
  storeWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: '资源中心',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  storeWindow.on('closed', () => {
    // 内嵌创作中心视图随宿主窗口一起销毁（否则 webContents 泄漏）
    if (workshopView && !workshopView.webContents.isDestroyed()) workshopView.webContents.close();
    workshopView = null;
    storeWindow = null;
  });
  // 网页 title 不覆盖窗口标题：入口叫「资源中心」时窗口/Taskbar 也要一致
  storeWindow.on('page-title-updated', (event) => event.preventDefault());
  // 整页跳转（含刷新）时先摘掉内嵌视图：新页面的 /workshop 会重新上报显示，
  // 避免创作中心视图残留在其它页面上方
  storeWindow.webContents.on('did-navigate', () => {
    if (workshopView && storeWindow && !storeWindow.isDestroyed()) {
      storeWindow.contentView.removeChildView(workshopView);
    }
  });
  // 平台三件套（便携 PostgreSQL/后端/前端）未运行时先展示提示页并自动拉起，避免商店空白
  storeWindow.loadURL(storeStatusPage('正在启动平台服务', '数据库与平台服务启动中，首次约需 10–30 秒…'));
  const ready = await ensurePlatformServices(app.getAppPath());
  if (!storeWindow || storeWindow.isDestroyed()) return { success: true };
  if (ready) {
    await storeWindow.loadURL(platformConfig.frontendUrl);
  } else {
    await storeWindow.loadURL(
      storeStatusPage('平台服务启动失败', '请检查 platform 目录是否完整，或手动运行 platform\\start-platform.bat 后重开资源中心')
    );
  }
  return { success: ready };
}

ipcMain.handle('platform:open-store', () => openStoreWindow());

// 发布资源（创作中心「上传/发布」工作区）：主进程用配置里的平台令牌发 multipart，令牌不出渲染进程
ipcMain.handle('platform:upload', async (_event, payload: PublishPayload) => {
  try {
    const asset = await platformClient.publish(payload);
    return { success: true, asset };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// 平台账号状态：创作中心「上传/发布」据此显示登录卡或已登录信息
ipcMain.handle('platform:auth-status', () => platformClient.getAuthState());
ipcMain.handle('platform:auth-tokens', () => {
  const platform = loadConfig().platform;
  return { accessToken: platform.accessToken, refreshToken: platform.refreshToken };
});

/** 令牌变更后广播配置：所有窗口的配置副本同步刷新 */
function broadcastConfigChanged(): void {
  const updated = loadConfig();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('config:changed', updated);
  }
}

// 平台 Web 窗口登录/续期/登出后同步令牌到主进程（桌面端下载/安装/上传共用同一登录态）
ipcMain.handle(
  'platform:auth-sync',
  (_event, tokens: { accessToken: string; refreshToken?: string; user?: AppConfig['platform']['user'] }) => {
    const state = platformClient.setTokens(tokens);
    broadcastConfigChanged();
    return state;
  },
);
ipcMain.handle('platform:auth-clear', () => {
  platformClient.logout();
  broadcastConfigChanged();
  return { loggedIn: false };
});

// 平台资源查询 / 下载 / 安装 / 卸载（智能体、音色；商店 Web 窗口与工作台共用）
ipcMain.handle('platform:search', (_event, type: PlatformAssetType, query: string, page = 1) =>
  platformClient.search(type, query, page),
);
ipcMain.handle('platform:getDetail', (_event, type: PlatformAssetType, id: string) =>
  platformClient.getDetail(type, id),
);
ipcMain.handle('platform:download', (_event, type: PlatformAssetType, id: string) =>
  platformClient.download(type, id),
);
ipcMain.handle('platform:install', (_event, type: PlatformAssetType, id: string) =>
  platformClient.install(type, id),
);
ipcMain.handle('platform:uninstall', (_event, type: PlatformAssetType, id: string) =>
  platformClient.uninstall(type, id),
);
ipcMain.handle('platform:getInstalledAgent', () => platformClient.getInstalledAgent());

ipcMain.handle('platform:login', async (_event, identifier: string, password: string) => {
  const result = await platformClient.login(identifier, password);
  // 登录成功后拉取云端数据恢复本地缺失部分（LLM 配置/智能体人设/音色/聊天记录）
  void pullAfterLogin();
  return result;
});
ipcMain.handle('platform:logout', () => platformClient.logout());

// ── 内嵌创作中心视图（资源中心窗口内容区）──────────────────────────────────

/** 创作中心内嵌视图的显示/隐藏请求（由资源中心页面测量内容区后上报） */
interface WorkshopEmbedPayload {
  visible: boolean;
  /** 内容区在窗口内的位置与尺寸（DIP，页面 getBoundingClientRect 口径） */
  rect?: { x: number; y: number; width: number; height: number };
  /** 落地工作区（如 agents / voices） */
  tab?: string;
}

/**
 * 创作中心内嵌视图：同一份桌面渲染包以 `#/workshop/embedded` 挂到资源中心窗口的内容区，
 * 资源中心顶栏/导航常驻，创作中心的一切操作都在这个视图里完成（不再新开窗口）。
 */
function ensureWorkshopView(): WebContentsView {
  if (workshopView && !workshopView.webContents.isDestroyed()) return workshopView;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  view.setBackgroundColor('#1e1f22');
  workshopView = view;
  // 渲染端就绪后再投放目标工作区（视图首次加载时直接 send 会丢）
  view.webContents.once('did-finish-load', () => {
    if (workshopTab) view.webContents.send('studio:workspace', workshopTab);
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void view.webContents.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#/workshop/embedded`);
  } else {
    void view.webContents.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      hash: '/workshop/embedded',
    });
  }
  return view;
}

/** 按页面上报的矩形同步内嵌视图（钳到窗口内容区内，防止异常坐标把视图撑出窗口） */
function syncWorkshopEmbed(payload: WorkshopEmbedPayload): { success: boolean } {
  if (!storeWindow || storeWindow.isDestroyed()) return { success: false };
  if (!payload.visible) {
    if (workshopView) storeWindow.contentView.removeChildView(workshopView);
    return { success: true };
  }
  const view = ensureWorkshopView();
  const [winWidth, winHeight] = storeWindow.getContentSize();
  const rect = payload.rect ?? { x: 0, y: 0, width: winWidth, height: winHeight };
  const x = Math.max(0, Math.min(Math.max(0, winWidth - 1), Math.round(rect.x)));
  const y = Math.max(0, Math.min(Math.max(0, winHeight - 1), Math.round(rect.y)));
  const width = Math.max(1, Math.min(winWidth - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(winHeight - y, Math.round(rect.height)));
  view.setBounds({ x, y, width, height });
  storeWindow.contentView.addChildView(view);
  if (payload.tab) {
    workshopTab = payload.tab;
    if (!view.webContents.isLoading()) view.webContents.send('studio:workspace', payload.tab);
  }
  return { success: true };
}

ipcMain.handle('workshop:embed', (_event, payload: WorkshopEmbedPayload) => syncWorkshopEmbed(payload));

// 导出文本文件（智能体配置 .json 等）：弹出系统保存对话框 → 写盘
ipcMain.handle(
  'dialog:save-text',
  async (_event, args: { defaultFileName: string; content: string; title?: string }) => {
    const target = studioWindow && !studioWindow.isDestroyed() ? studioWindow : undefined;
    const options: Electron.SaveDialogOptions = {
      title: args.title || '导出文件',
      defaultPath: path.join(app.getPath('documents'), args.defaultFileName),
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    };
    const result = target
      ? await dialog.showSaveDialog(target, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };
    try {
      fs.writeFileSync(result.filePath, args.content, 'utf-8');
      return { saved: true, path: result.filePath };
    } catch (e) {
      return { saved: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
);

// ── 配置读写 ──────────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => {
  return loadConfig();
});

ipcMain.handle('config:set', (_event, partial: Partial<AppConfig>) => {
  const updated = saveConfig(partial);
  conversationManager.updateConfig(updated);
  // LLM 配置变更（智能体档案 / 音色 / 云 TTS）：防抖上传云端（多端共享）
  if (partial.llmProfiles || partial.llmActiveProfileId !== undefined || partial.downloadedVoices || partial.ttsCloudConfig) {
    scheduleUpload('config');
  }
  // 多窗口一致性：所有窗口共用同一份配置，广播让持有的旧副本刷新
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('config:changed', updated);
  }
  return updated;
});

// ── 对话（chat:send / retry / clear / history）────────────────────────────

type ChatSendResult = {
  success: boolean;
  text?: string;
  /** 本次思考过程（开启 showThinking 时由模型返回；已随消息持久化） */
  reasoning?: string;
  error?: string;
  /** 收到数据后被网关/网络掐断：渲染端清空占位、1.2 秒后自动重试一次（只一次） */
  interrupted?: boolean;
  /** 用户主动停止生成：保留已生成内容，不标错 */
  aborted?: boolean;
};

/**
 * 一次补全（chat:send 与 chat:retry 共用）：以当前档案历史组装请求，流式推送正文与思考过程。
 * images 仅首次发送携带（重试复用历史里的纯文本）。
 */
async function runChatCompletion(win: BrowserWindow, images?: string[]): Promise<ChatSendResult> {
  const messages = conversationManager.buildMessages();
  // 附图：末条 user 消息转为多模态 content（聊天历史仍存纯文本，token 友好）
  if (images?.length) {
    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      last.content = [
        { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
        ...images.slice(0, 4).map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ];
    }
  }

  let reasoningText = '';
  const fullText = await llmService.chat({
    messages,
    onChunk: (chunk) => {
      if (win.isDestroyed()) return;
      win.webContents.send('chat:chunk', chunk);
    },
    onReasoning: (chunk) => {
      if (win.isDestroyed()) return;
      reasoningText += chunk;
      win.webContents.send('chat:reasoning', chunk);
    },
  });

  conversationManager.addAssistantMessage(fullText, reasoningText);
  scheduleUpload('chat_history');
  return { success: true, text: fullText, reasoning: reasoningText.trim() || undefined };
}

/** 补全失败的统一收口：中断/主动停止单独标记，供渲染端决定是否自动重试 */
function chatFailure(err: unknown): ChatSendResult {
  if (err instanceof AbortedError) {
    return { success: false, error: err.message, aborted: true };
  }
  if (err instanceof StreamInterruptError) {
    return { success: false, error: err.message, interrupted: true };
  }
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

let lastUserMessageAt = 0;

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
    return await runChatCompletion(win, images);
  } catch (err) {
    return chatFailure(err);
  }
});

/**
 * Chat: 重试失败回复（失败气泡点击「重试」）。
 * 不重复写入用户消息：历史里该条 user 消息已在，直接重新补全（中断自动重试亦走此通道）。
 */
ipcMain.handle('chat:retry', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, error: 'No window' };
  if (!llmService.isConfigured()) {
    return { success: false, error: '请先在设置中配置 API Key 和模型。' };
  }
  const history = conversationManager.getHistory();
  if (history[history.length - 1]?.role !== 'user') {
    return { success: false, error: '没有可重试的问题，请重新发送消息' };
  }
  try {
    return await runChatCompletion(win);
  } catch (err) {
    return chatFailure(err);
  }
});

// Chat: clear conversation history
ipcMain.handle('chat:clear', () => {
  conversationManager.clearHistory();
  scheduleUpload('chat_history');
  return { success: true };
});

// Chat: get persisted history (to restore UI after app restart)
ipcMain.handle('chat:history', () => {
  return { success: true, history: conversationManager.getHistory() };
});

// ── 语音合成（朗读 / 试听）────────────────────────────────────────────────

// Edge TTS 语音合成：渲染端传文本与音色/语气参数，返回 mp3 base64（失败 null，渲染端回退系统 TTS）
ipcMain.handle('tts:speak', (_event, args: Parameters<typeof edgeSpeak>[0]) => edgeSpeak(args));

// 云音色合成（OpenAI 兼容 /audio/speech 或自建 GPT-SoVITS）：API Key 留在主进程，
// 渲染端只传「音色配置 + 文本」，返回可直接播放的 data URL；失败带中文指引（渲染端逐级降级）
ipcMain.handle(
  'tts:cloud-speak',
  async (_event, args: { text: string; config: VoiceConfig; speed?: number }) => {
    try {
      const global = loadConfig().ttsCloudConfig ?? DEFAULT_TTS_CLOUD_CONFIG;
      const { dataUrl } = await synthVoice(args.config, global, args.text, args.speed);
      return { success: true, dataUrl };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
);

// GPT-SoVITS 引擎连通性测试（设置页云 TTS 配置的「连接测试」）
ipcMain.handle('tts:test-gptsovits', (_event, baseUrl: string) => testGptsovitsEngine(baseUrl));

// ── 智能体主动对话（定时消息）──────────────────────────────────────────────

/** 智能体消息投递（主动对话）：写入聊天历史并通知对话窗口 */
function deliverAgentMessage(text: string): void {
  conversationManager.addAssistantMessage(text);
  scheduleUpload('chat_history');
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send('chat:agent-message', text);
  }
}

function startProactive() {
  startAgentProactive({
    getConfig: () => loadConfig(),
    isConfigured: () => llmService.isConfigured(),
    isUserActive: () => Date.now() - lastUserMessageAt < 2 * 60_000,
    getSystemPrompt: () => conversationManager.getSystemPrompt(),
    getRecentHistory: (n) => conversationManager.getHistory().slice(-n),
    generate: async (messages) => llmService.chat({ messages }),
    deliver: deliverAgentMessage,
  });
}

// ── 应用生命周期与菜单 ─────────────────────────────────────────────────────

/** 应用菜单：替代宠物右键菜单，提供各窗口的打开入口 */
function buildAppMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: '窗口',
      submenu: [
        { label: '创作中心', click: () => openStudioWindow() },
        { label: '对话', click: () => openChatWindow() },
        { label: '资源中心', click: () => void openStoreWindow() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  buildAppMenu();
  // 启动直接打开工作室（创作中心）窗口；对话与资源中心由菜单按需打开
  openStudioWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openStudioWindow();
  });

  // Start agent proactive conversation scheduler
  startProactive();
});

app.on('before-quit', () => {
  flushAllOnQuit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
