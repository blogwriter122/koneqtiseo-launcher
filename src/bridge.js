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
  markProfileExitClean, listLocalProfiles, findFreePort,
} = require('./profile-manager');

const DEFAULT_GATEWAY_WS = process.env.GATEWAY_WS || 'wss://gateway.koneqtiseo.com/ws';

// Accept "wss://gateway.koneqtiseo.com" or ".../ws" from settings; always connect to /ws
function gatewayWsUrl(url) {
  const u = String(url || '').trim() || DEFAULT_GATEWAY_WS;
  return /\/ws\/?$/.test(u) ? u : u.replace(/\/+$/, '') + '/ws';
}

let ws = null;
let status = { connected: false, jobsCompleted: 0, lastJob: null, openProfiles: [] };
let reconnectTimer = null;
let onEvent = null;
let apiKey = null;
let gatewayUrl = null;
let manualDisconnect = false;   // user pressed Disconnect → don't auto-reconnect
let heartbeat = null;           // every 20 s: "ping" to the gateway; a silent line is dropped and reconnected

// Heartbeat as a normal message (WebSocket ping frames may not cross the Cloudflare tunnel; normal messages do).
// Also keeps the tunnel from closing an idle connection. No answer for 50 s = the line is dead (it can look open
// for minutes): close it and reconnect.
const HEARTBEAT_MS = 20000, DEAD_AFTER_MS = 50000;
function startHeartbeat(sock) {
  stopHeartbeat();
  sock._lastSeen = Date.now();
  heartbeat = setInterval(() => {
    if (sock !== ws) return stopHeartbeat();
    // only judge silence once the gateway has shown it answers heartbeats (an older gateway does not)
    if (sock._answersPing && Date.now() - sock._lastSeen > DEAD_AFTER_MS) {
      console.log('[bridge] No answer from the gateway for 50 s — reconnecting');
      try { sock.terminate(); } catch (_) {}
      return;
    }
    try { sock.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (_) {}
    try { sock.ping(); } catch (_) {}
  }, HEARTBEAT_MS);
}
function stopHeartbeat() { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } }

// Track which profiles are currently open { name → { browser, page, port } }
const openProfiles = new Map();

function setEventHandler(fn) { onEvent = fn; }
function getStatus() { return { ...status, openProfiles: Array.from(openProfiles.keys()) }; }

/**
 * Connect to the VPS gateway
 */
function connectToVPS(key, url) {
  apiKey = key;
  if (url !== undefined) gatewayUrl = url;
  manualDisconnect = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { const old = ws; ws = null; try { old.close(); } catch (_) {} }

  const sock = new WebSocket(gatewayWsUrl(gatewayUrl), {
    headers: { 'x-api-key': key },
  });
  ws = sock;

  sock.on('open', () => {
    status.connected = true;
    onEvent?.('status', status);
    // Register this launcher with the user's key
    ws.send(JSON.stringify({ type: 'register', apiKey: key, platform: process.platform }));
    console.log('[bridge] Connected to gateway, registered');
    startHeartbeat(sock);
  });
  sock.on('pong', () => { sock._lastSeen = Date.now(); });

  sock.on('message', async (raw) => {
    sock._lastSeen = Date.now();
    let job;
    try { job = JSON.parse(raw.toString()); } catch (_) { return; }
    if (job.type === 'pong') { sock._answersPing = true; return; }   // heartbeat answer
    if (job.type === 'registered') {                                       // gateway confirmation, not a job
      status.userId = job.userId || null;
      status.plan = job.plan || null;
      onEvent?.('status', status);
      return;
    }
    if (job.type === 'error') {                                            // gateway refused us (e.g. invalid key)
      status.error = job.error === 'invalid_key' ? 'API key not recognised' : job.error;
      onEvent?.('status', status);
      return;
    }
    if (job.type && job.type.startsWith('cdp_')) return handleCdp(job);   // browser relay
    await handleJob(job);
  });

  sock.on('close', (code, reason) => {
    if (sock !== ws) return;   // an older socket we replaced — ignore
    stopHeartbeat();
    for (const [, sess] of cdpSessions) { try { sess.local.close(); } catch (_) {} }
    cdpSessions.clear();
    status.connected = false;
    // 4001 = gateway rejected the key (unknown or revoked): retrying won't help
    status.error = code === 4001 ? (reason?.toString() || 'API key rejected') : null;
    onEvent?.('status', status);
    if (manualDisconnect || code === 4001) { console.log(`[bridge] Disconnected (${code})`); return; }
    console.log('[bridge] Disconnected — reconnecting in 5s');
    scheduleReconnect();
  });

  sock.on('error', (err) => {
    console.error('[bridge] WS error:', err.message);
    if (sock !== ws) return;
    status.connected = false;
    onEvent?.('status', status);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (apiKey && !manualDisconnect) connectToVPS(apiKey);
  }, 5000);
}

function disconnect() {
  manualDisconnect = true;
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
    const known = openProfiles.get(name);
    // The user may have closed that Chrome window since — only reuse it if it still answers
    if (known.port && await chromeWsUrl(known.port).then(() => true, () => false)) {
      return { ready: true, name, port: known.port, reused: true };
    }
    openProfiles.delete(name);
  }

  const profile = {
    name,
    dir: job.profile_dir || job.dir,
    // The relay needs to know the debug port, so pick one now if none was given
    port: job.profile_port || job.port || await findFreePort(),
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

// ─── CDP relay (Model A) ─────────────────────────────────────────────────────
// The VPS drives a Chrome profile on THIS PC through the gateway:
//   VPS Playwright ⇄ gateway /cdp ⇄ (this WebSocket) ⇄ local Chrome DevTools
// Chrome runs here: the user's IP, the user's accounts. No ports are opened to the internet.
const http = require('http');
const cdpSessions = new Map();   // session → { local, profileName }

function relaySend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function chromeWsUrl(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (r) => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b).webSocketDebuggerUrl); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error(`Chrome on port ${port} did not answer`)));
  });
}

async function handleCdp(msg) {
  const { session } = msg;
  if (msg.type === 'cdp_open') {
    try {
      const p = msg.profile || {};
      // p.dir is a path on the VPS, not on this PC — the folder is picked here by profile name
      const opened = await ensureProfileOpen({ profile_name: p.name, profile_port: p.port, browser_type: p.browserType, ads_power_id: p.adsPowerId, ix_profile_id: p.ixProfileId });
      const url = await chromeWsUrl(opened.port);
      const local = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      cdpSessions.set(session, { local, profileName: p.name });
      local.on('open', () => {
        relaySend({ type: 'cdp_ready', session });
        onEvent?.('relay', { session, profile: p.name, state: 'connected' });
      });
      local.on('message', (data) => relaySend({ type: 'cdp_msg', session, data: data.toString() }));
      local.on('close', () => { cdpSessions.delete(session); relaySend({ type: 'cdp_closed', session }); });
      local.on('error', (e) => relaySend({ type: 'cdp_error', session, error: e.message }));
    } catch (e) {
      relaySend({ type: 'cdp_error', session, error: e.message });
    }
    return;
  }
  const sess = cdpSessions.get(session);
  if (!sess) return;
  if (msg.type === 'cdp_msg') { try { sess.local.send(msg.data); } catch (_) {} }
  if (msg.type === 'cdp_close') { try { sess.local.close(); } catch (_) {} cdpSessions.delete(session); }
}

module.exports = { connectToVPS, disconnect, getStatus, setEventHandler };
