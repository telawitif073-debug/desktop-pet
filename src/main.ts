import { app, BrowserWindow, screen, ipcMain } from 'electron';
import path from 'path';
import { loadConfig, saveConfig, getLLMConfig, type AppConfig } from './main/config';
import { createLLMService } from './main/llmService';
import {
  ConversationManager,
  type PetStateSnapshot,
} from './main/conversationManager';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const PET_WINDOW_SIZE = { width: 300, height: 300 };
const CHAT_WINDOW_SIZE = { width: 650, height: 450 };
const MARGIN = 20;

let mainWindow: BrowserWindow | null = null;
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
  const size = chatMode ? CHAT_WINDOW_SIZE : PET_WINDOW_SIZE;
  return {
    x: workArea.x + workArea.width - size.width - MARGIN,
    y: workArea.y + workArea.height - size.height - MARGIN,
  };
}

function applyWindowSize(win: BrowserWindow, chatMode: boolean) {
  const size = chatMode ? CHAT_WINDOW_SIZE : PET_WINDOW_SIZE;
  const pos = getWindowPosition(chatMode);
  // Remove size constraints temporarily so resize works
  win.setMinimumSize(size.width, size.height);
  win.setMaximumSize(size.width, size.height);
  win.setSize(size.width, size.height);
  win.setPosition(pos.x, pos.y);
}

const createWindow = () => {
  const pos = getWindowPosition(false);

  mainWindow = new BrowserWindow({
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
    minWidth: PET_WINDOW_SIZE.width,
    maxWidth: PET_WINDOW_SIZE.width,
    minHeight: PET_WINDOW_SIZE.height,
    maxHeight: PET_WINDOW_SIZE.height,
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
  return updated;
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

// Move window (for IPC-based drag fallback)
ipcMain.on('move-window', (_event, data: { screenX: number; screenY: number; offsetX: number; offsetY: number }) => {
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (!win) return;
  win.setPosition(data.screenX - data.offsetX, data.screenY - data.offsetY);
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
