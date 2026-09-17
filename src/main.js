/**
 * src/main.js — Electron Main Process
 * KoneqtiSEO Launcher
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { connectToVPS, disconnect, getStatus } = require('./bridge');
const Store = require('./store');

let mainWindow = null;
let tray = null;
const store = new Store();

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
ipcMain.handle('connect', async (_, { apiKey, gatewayUrl }) => {
  store.save({ apiKey, gatewayUrl });
  return connectToVPS(gatewayUrl, apiKey, (event, data) => {
    mainWindow?.webContents?.send(event, data);
  });
});
ipcMain.handle('disconnect', () => disconnect());
ipcMain.handle('get-status', () => getStatus());

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', (e) => e.preventDefault());
