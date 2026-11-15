/**
 * src/preload.js — the only bridge between the launcher window and the app (security audit 15 Nov 2026).
 * The window runs with contextIsolation on and no Node: it can call these few functions and nothing else, so text
 * shown in the window can never run code on the PC.
 */
const { contextBridge, ipcRenderer, shell } = require('electron');

const ALLOWED = ['get-version', 'get-settings', 'get-status', 'connect', 'disconnect'];
contextBridge.exposeInMainWorld('launcher', {
  invoke: (channel, data) => (ALLOWED.includes(channel) ? ipcRenderer.invoke(channel, data) : Promise.reject(new Error('not allowed'))),
  onEvent: (fn) => ipcRenderer.on('bridge-event', (_e, payload) => fn(payload)),
  openSettingsPage: () => shell.openExternal('https://koneqtiseo.com/settings'),
  platform: process.platform,
});
