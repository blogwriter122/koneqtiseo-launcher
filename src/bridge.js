/**
 * src/bridge.js — WebSocket bridge to VPS gateway
 *
 * Model A: This runs on the USER's PC. It:
 *   1. Connects to gateway.koneqtiseo.com via WebSocket
 *   2. Registers with the user's API key
 *   3. Receives jobs (open_profile, post_content, etc.)
 *   4. Opens the RIGHT Chrome profile on THIS PC
 *   5. VPS connects via CDP over the tunnel to run the automation
 *   6. Chrome renders here — user's IP, user's accounts
 */

const WebSocket = require('ws');
const {
  openChrome, closeBrowser, resolveProfileDir, cleanStaleLocks,
  markProfileExitClean, listLocalProfiles,
} = require('./profile-manager');

const GATEWAY_WS = process.env.GATEWAY_WS || 'wss://gateway.koneqtiseo.com/ws';

let ws = null;
let status = { connected: false, jobsCompleted: 0, lastJob: null, openProfiles: [] };
let reconnectTimer = null;
let onEvent = null;
let apiKey = null;

// Track which profiles are currently open { name → { browser, page, port } }
const openProfiles = new Map();

function setEventHandler(fn) { onEvent = fn; }
function getStatus() { return { ...status, openProfiles: Array.from(openProfiles.keys()) }; }

/**
 * Connect to the VPS gateway
 */
function connectToVPS(key) {
  apiKey = key;
  if (ws) { try { ws.close(); } catch (_) {} }

  ws = new WebSocket(GATEWAY_WS, {
    headers: { 'x-api-key': key },
  });

  ws.on('open', () => {
    status.connected = true;
    onEvent?.('status', status);
    // Register this launcher with the user's key
    ws.send(JSON.stringify({ type: 'register', apiKey: key, platform: process.platform }));
    console.log('[bridge] Connected to gateway, registered');
  });

  ws.on('message', async (raw) => {
    let job;
    try { job = JSON.parse(raw.toString()); } catch (_) { return; }
    await handleJob(job);
  });

  ws.on('close', () => {
    status.connected = false;
    onEvent?.('status', status);
    console.log('[bridge] Disconnected — reconnecting in 5s');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[bridge] WS error:', err.message);
    status.connected = false;
    onEvent?.('status', status);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (apiKey) connectToVPS(apiKey);
  }, 5000);
}

function disconnect() {
  if (ws) { try { ws.close(); } catch (_) {} }
  ws = null;
  status.connected = false;
  onEvent?.('status', status);
}

/**
 * Handle a job from the VPS
 */
async function handleJob(job) {
  const { id, type } = job;
  let result;

  try {
    switch (type) {
      case 'open_profile':
        result = await openProfileForLogin(job);
        break;

      case 'run_profile':
        // VPS wants a profile open + CDP port ready so it can drive the automation
        result = await ensureProfileOpen(job);
        break;

      case 'close_profile':
        result = await closeProfile(job.name);
        break;

      case 'list_profiles':
        result = { profiles: await listLocalProfiles() };
        break;

      case 'profile_status':
        result = {
          open: openProfiles.has(job.name),
          port: openProfiles.get(job.name)?.port || null,
        };
        break;

      case 'check_status':
        result = { connected: true, platform: process.platform, openProfiles: Array.from(openProfiles.keys()) };
        break;

      default:
        result = { error: `Unknown job type: ${type}` };
    }
  } catch (e) {
    result = { error: e.message };
  }

  status.jobsCompleted++;
  status.lastJob = { type, at: new Date().toISOString() };
  onEvent?.('job', { id, type, result });

  // Send result back to VPS
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'job_result', id, result }));
  }
}

/**
 * Open a profile in a VISIBLE window so the user can log in accounts manually.
 * (Like koneqti.com open-profile.js)
 */
async function openProfileForLogin(job) {
  const profile = {
    name: job.name,
    dir: job.dir,
    port: job.port,
    browserType: job.browser_type || 'chrome',
    adsPowerId: job.ads_power_id,
    ixProfileId: job.ix_profile_id,
  };

  console.log(`[bridge] Opening profile "${profile.name}" for login on port ${profile.port}`);

  const { browser, page, context } = await openChrome(profile);
  openProfiles.set(profile.name, { browser, page, context, port: profile.port });

  // Navigate to a helpful landing page based on platform
  const landingUrls = {
    linkedin: 'https://www.linkedin.com/login',
    reddit: 'https://www.reddit.com/login',
    medium: 'https://medium.com/m/signin',
    claude: 'https://claude.ai',
    twitter: 'https://twitter.com/login',
  };
  const url = landingUrls[job.platform] || 'https://www.google.com';
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}

  onEvent?.('profile-opened', { name: profile.name, message: `${profile.name} is open — log into your accounts, then leave it open or close when done.` });

  return { opened: true, name: profile.name, port: profile.port };
}

/**
 * Ensure a profile is open with CDP ready (for VPS to drive automation)
 */
async function ensureProfileOpen(job) {
  const name = job.profile_name || job.name;
  if (openProfiles.has(name)) {
    return { ready: true, name, port: openProfiles.get(name).port, reused: true };
  }

  const profile = {
    name,
    dir: job.profile_dir || job.dir,
    port: job.profile_port || job.port,
    browserType: job.browser_type || 'chrome',
    adsPowerId: job.ads_power_id,
    ixProfileId: job.ix_profile_id,
  };

  const { browser, page, context } = await openChrome(profile);
  openProfiles.set(name, { browser, page, context, port: profile.port });

  return { ready: true, name, port: profile.port };
}

/**
 * Close a profile
 */
async function closeProfile(name) {
  const p = openProfiles.get(name);
  if (!p) return { closed: false, reason: 'not open' };
  try {
    await closeBrowser({ name }, p.browser, p.page);
  } catch (_) {}
  openProfiles.delete(name);
  return { closed: true, name };
}

module.exports = { connectToVPS, disconnect, getStatus, setEventHandler };
