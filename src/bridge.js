/**
 * src/bridge.js — WebSocket bridge to VPS gateway
 */

const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const os = require('os');

const CHROME_PATHS = {
  win32:  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux:  ['/usr/bin/google-chrome', '/usr/bin/chromium-browser'],
};

let ws = null;
let status = { connected: false, jobsCompleted: 0, lastJob: null };
let reconnectTimer = null;
let onEvent = null;

function findChrome() {
  const fs = require('fs');
  for (const p of (CHROME_PATHS[process.platform] || [])) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function launchChrome(profileName, debugPort = 9222) {
  const chromePath = findChrome();
  if (!chromePath) return { error: 'Chrome not found' };
  const profileDir = path.join(os.homedir(), 'koneqtiseo-profiles', profileName);
  const proc = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' });
  proc.unref();
  return { pid: proc.pid, debugPort };
}

async function handleJob(job) {
  const { id, type, profile, debugPort } = job;
  let result;

  switch (type) {
    case 'launch_chrome': result = launchChrome(profile || 'default', debugPort || 9222); break;
    case 'check_status':  result = { connected: true, platform: process.platform, chrome: !!findChrome() }; break;
    default:              result = { error: `Unknown: ${type}` };
  }

  status.jobsCompleted++;
  status.lastJob = { type, completedAt: new Date().toISOString() };
  onEvent?.('job-complete', { id, type, result });

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'job_result', id, result }));
  }
}

function connectToVPS(gatewayUrl, apiKey, eventCallback) {
  onEvent = eventCallback;
  status.connected = false;

  try {
    ws = new WebSocket(`${gatewayUrl}/ws/launcher`, {
      headers: { 'x-api-key': apiKey },
    });

    ws.on('open', () => {
      status.connected = true;
      onEvent?.('status', { connected: true, message: 'Connected to KoneqtiSEO' });
      ws.send(JSON.stringify({ type: 'register', platform: process.platform, chrome: !!findChrome() }));
    });

    ws.on('message', (data) => {
      try { handleJob(JSON.parse(data.toString())); } catch (_) {}
    });

    ws.on('close', () => {
      status.connected = false;
      onEvent?.('status', { connected: false, message: 'Disconnected — retrying...' });
      reconnectTimer = setTimeout(() => connectToVPS(gatewayUrl, apiKey, eventCallback), 5000);
    });

    ws.on('error', (err) => {
      onEvent?.('status', { connected: false, message: `Error: ${err.message}` });
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) { ws.terminate(); ws = null; }
  status.connected = false;
  return { ok: true };
}

function getStatus() { return status; }

module.exports = { connectToVPS, disconnect, getStatus, findChrome };
