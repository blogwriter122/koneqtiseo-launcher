/**
 * src/main.js — Electron Main Process
 * KoneqtiSEO Launcher
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Startup problems are never silent: written to <userData>/launcher.log and shown in a message box
const logFile = () => path.join(app.getPath('userData'), 'launcher.log');
function logLine(text) {
  try { fs.mkdirSync(path.dirname(logFile()), { recursive: true }); fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${text}\n`); } catch (_) {}
}
function fatal(title, err) {
  const msg = err && err.stack ? err.stack : String(err);
  logLine(`${title}: ${msg}`);
  try { dialog.showErrorBox(`KoneqtiSEO Launcher — ${title}`, `${String(err && err.message ? err.message : err).slice(0, 600)}\n\nDetails were saved to:\n${logFile()}`); } catch (_) {}
}
process.on('uncaughtException', (e) => fatal('unexpected error', e));

// One launcher per PC user: opening it again (desktop icon) shows the running one instead of starting a second copy
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

let bridge, Store;
try {
  bridge = require('./bridge');
  Store = require('./store');
} catch (e) {
  app.whenReady().then(() => { fatal('could not start', e); app.exit(1); });
}
const { connectToVPS, disconnect, getStatus, setEventHandler } = bridge || {};

let mainWindow = null;
let tray = null;
const store = Store ? new Store() : null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 600,
    resizable: false,
    title: 'KoneqtiSEO Launcher',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon_16.png'));
  tray = new Tray(icon);

  const updateMenu = () => {
    const status = getStatus();
    const menu = Menu.buildFromTemplate([
      { label: `KoneqtiSEO — ${status.connected ? '🟢 Connected' : '🔴 Disconnected'}`, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: () => mainWindow.show() },
      { label: 'Quit', click: () => { app.exit(0); } },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`KoneqtiSEO — ${status.connected ? 'Connected' : 'Disconnected'}`);
  };

  tray.on('double-click', () => mainWindow.show());
  updateMenu();
  setInterval(updateMenu, 5000);
}

// IPC handlers — UI communicates with main process
ipcMain.handle('get-settings', () => store.get());
ipcMain.handle('save-settings', (_, settings) => {
  store.save(settings);
  return { ok: true };
});
// Bridge events (status, jobs, relay) → UI window
if (setEventHandler) setEventHandler((event, data) => {
  mainWindow?.webContents?.send('bridge-event', { event, data });
});

ipcMain.handle('connect', async (_, { apiKey, gatewayUrl }) => {
  store.save({ apiKey, ...(gatewayUrl ? { gatewayUrl } : {}) });
  connectToVPS(apiKey, gatewayUrl);
  return { ok: true };
});
ipcMain.handle('disconnect', () => disconnect());
ipcMain.handle('get-status', () => getStatus());
ipcMain.handle('get-version', () => app.getVersion());

app.whenReady().then(() => {
  if (!primary || !bridge || !store) return;
  logLine(`started v${app.getVersion()} (Electron ${process.versions.electron}, Node ${process.versions.node})`);
  createWindow();
  try { createTray(); } catch (e) { logLine(`tray: ${e.message}`); }   // the window still works without a tray icon
  // Reconnect with the saved key after a restart, so jobs don't wait for a click
  const saved = store.get();
  if (saved.apiKey) connectToVPS(saved.apiKey, saved.gatewayUrl);
});

app.on('window-all-closed', (e) => e.preventDefault());
