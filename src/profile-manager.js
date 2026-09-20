/**
 * browser.js - Chrome CDP management with human behavior
 * Supports: Regular Chrome, AdsPower API, iX Browser API
 * Works on: Windows AND Linux VPS
 */

const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Auto-detect Chrome path by OS
const IS_WINDOWS = os.platform() === 'win32';
const CHROME_PATH = IS_WINDOWS
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome';

// ── Profile/port reliability helpers ──────────────────────────────
// Base profile dir: a profile you log into ONCE; new profiles are cloned from it.
const BASE_PROFILE_DIR = process.env.KONEQTISEO_BASE_PROFILE
  || (IS_WINDOWS ? 'C:\\koneqtiseo-base-profile' : path.join(os.homedir(), 'koneqtiseo-base-profile'));
// Where auto-created profile folders live when a profile has no explicit dir.
const PROFILES_BASE_DIR = process.env.KONEQTISEO_PROFILES_DIR
  || (IS_WINDOWS ? 'C:\\koneqtiseo-profiles' : path.join(os.homedir(), 'koneqtiseo-profiles'));

// Track the OS process id of each Chrome we spawn, keyed by profile name, so we
// can FORCE-KILL the real chrome.exe tree on close — closing the CDP/Playwright
// connection alone does not reliably terminate a detached Chrome process, which
// left the previous profile's user-data-dir locked and broke the NEXT run with
// "Chrome CDP not ready" (a new Chrome can't fully start against a locked dir).
const spawnedPids = new Map(); // profile.name -> pid

// Ask the OS for a free TCP port (avoids manual ports + collisions)
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Remove stale Chrome lock files (safe only when NO live Chrome owns the dir)
function cleanStaleLocks(dir) {
  const locks = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];
  for (const fn of locks) {
    try { const p = path.join(dir, fn); if (fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch (_) {}
  }
}

// Rewrite a profile's last-exit markers so Chrome believes it closed cleanly,
// suppressing the "Restore pages? / Chrome didn't shut down correctly" bubble
// that otherwise appears after we force-kill Chrome. Chrome records the exit
// state in <profile>/Default/Preferences as { "profile": { "exit_type": ... }}
// and in Local State. Setting exit_type to "Normal" and exited_cleanly to true
// is the documented, side-effect-free way to stop the restore prompt.
function markProfileExitClean(userDataDir) {
  const targets = [
    path.join(userDataDir, 'Default', 'Preferences'),
    path.join(userDataDir, 'Local State'),
  ];
  for (const file of targets) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw) continue;
      let json;
      try { json = JSON.parse(raw); } catch (_) { continue; }

      // Preferences: profile.exit_type / profile.exited_cleanly
      if (json.profile && typeof json.profile === 'object') {
        json.profile.exit_type = 'Normal';
        json.profile.exited_cleanly = true;
      }
      // Some Chrome builds mirror the flag at the top level too.
      if ('exit_type' in json) json.exit_type = 'Normal';
      if ('exited_cleanly' in json) json.exited_cleanly = true;

      fs.writeFileSync(file, JSON.stringify(json));
    } catch (_) { /* best effort per file */ }
  }
}

// Force-kill a Chrome process (and its child processes) by PID. Cross-platform.
// This is what actually frees the user-data-dir lock — closing the CDP
// connection or calling browser.close() on a connectOverCDP() session does NOT
// reliably do this for a detached, unref'd process.
function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (IS_WINDOWS) {
      // /T kills the whole process tree (Chrome spawns helper processes).
      // CRITICAL: a hung/"Not Responding" Chrome can make taskkill itself block
      // while Windows tears the process down. execSync with NO timeout would
      // then freeze the entire Node event loop — every profile stops, the
      // watchdog heartbeat dies, and the run wedges for hours (observed: a
      // 13-hour dead stall after "Aw Snap / Not Responding"). The timeout makes
      // taskkill give up instead of blocking; a leaked process is far better
      // than a frozen agent.
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 10000, windowsHide: true });
    } else {
      // Negative pid sends the signal to the whole process group
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { process.kill(pid, 'SIGKILL'); }
    }
  } catch (_) {
    // Already exited, or taskkill timed out — either way, move on. Never let a
    // kill failure propagate and stall recovery.
  }
}

// Kill EVERY orphaned Chrome from previous runs/crashes at agent startup.
// Over time, crashed or force-killed runs leave dozens of zombie chrome.exe
// processes — each still holding RAM — that accumulate until the machine runs
// OUT OF MEMORY (observed: "Killed 13 orphaned Chrome" per profile, and then
// "Aw Snap: Out of Memory" once enough piled up). The per-profile cleanup only
// fires when that profile launches; this sweeps ALL bot Chromes up front so a
// run starts from a clean, low-memory baseline. Only targets Chrome launched
// with a botdata_/koneqti profile dir — never the user's own Chrome.
function killAllBotChrome(onLog = () => {}) {
  try {
    if (IS_WINDOWS) {
      // Match chrome.exe whose command line references a bot profile dir.
      let out = '';
      try {
        out = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -match 'botdata_|koneqtiseo-profiles|\\\\.koneqti' } | Select-Object -ExpandProperty ProcessId"`,
          { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true }
        ).toString();
      } catch (_) { out = ''; }
      const pids = out.split(/\s+/).map((x) => parseInt(x, 10)).filter((n) => n > 0);
      let killed = 0;
      for (const pid of pids) {
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 8000, windowsHide: true }); killed++; } catch (_) {}
      }
      if (killed) onLog(`[startup] swept ${killed} orphaned Chrome process(es) from previous runs`);
    } else {
      try {
        execSync(`pkill -f "user-data-dir=.*\\(botdata_\\|koneqtiseo-profiles\\|\\.koneqti\\)"`, { stdio: 'ignore', timeout: 10000 });
      } catch (_) {}
    }
  } catch (_) { /* best-effort */ }
}

// Best-effort: kill any chrome.exe still holding a lock on this specific
// user-data-dir, in case the tracked PID is stale (e.g. agent restarted).
function killChromeUsingDir(dir) {
  if (!dir) return;
  try {
    if (IS_WINDOWS) {
      // wmic is deprecated/removed on newer Windows builds — use PowerShell's
      // CIM cmdlet instead (works on Windows 10/11 and Server 2019/2022/2025).
      let out = '';
      try {
        out = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`,
          { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }
        ).toString();
      } catch (_) {
        // Fallback for older systems where wmic still exists.
        try {
          out = execSync(
            `wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:csv`,
            { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }
          ).toString();
        } catch (_e2) { out = ''; }
      }
      for (const line of out.split('\n')) {
        if (line.includes(dir)) {
          const match = line.match(/(\d+)\s*$/) || line.match(/,\s*(\d+)\s*"?$/);
          const pid = match ? match[1] : null;
          if (pid) killProcessTree(parseInt(pid, 10));
        }
      }
    } else {
      const out = execSync(`pgrep -f "user-data-dir=${dir}"`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString();
      for (const pid of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
        killProcessTree(parseInt(pid, 10));
      }
    }
  } catch (_) {
    // No matching process found — fine, nothing to clean up.
  }
}

// Best-effort: kill whatever process (if any) is bound to a specific port.
// Used for FIXED-port profiles, so a stuck/zombie process from a previous run
// never blocks this profile's assigned port from being reused.
function killProcessOnPort(port) {
  if (!port) return;
  try {
    if (IS_WINDOWS) {
      const out = execSync(`netstat -ano | findstr :${port}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, windowsHide: true }).toString();
      const pids = new Set();
      for (const line of out.split('\n')) {
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) killProcessTree(parseInt(pid, 10));
    } else {
      const out = execSync(`lsof -ti tcp:${port}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString();
      for (const pid of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
        killProcessTree(parseInt(pid, 10));
      }
    }
  } catch (_) {
    // Nothing was using the port — fine.
  }
}

// Resolve a profile's data dir. If it doesn't exist, clone it from the base profile
// (so it inherits Pinterest/ChatGPT/LabFlow logins). Existing dirs are used as-is.
function resolveProfileDir(profile) {
  let dir = profile.dir;
  if (!dir) {
    // No explicit dir → auto folder under PROFILES_BASE_DIR by profile name
    const safe = String(profile.name || 'profile').replace(/[^a-zA-Z0-9_-]/g, '_');
    dir = path.join(PROFILES_BASE_DIR, safe);
  }
  if (!fs.existsSync(dir)) {
    if (fs.existsSync(BASE_PROFILE_DIR)) {
      console.log(`[${profile.name}] Creating profile from base → ${dir}`);
      // cpSync with recursive creates the destination (and parents) itself —
      // do NOT mkdir the parent separately (parent may be a drive root like C:\ → EPERM).
      fs.cpSync(BASE_PROFILE_DIR, dir, { recursive: true });
      cleanStaleLocks(dir); // clone carries base's locks — drop them
    } else {
      console.log(`[${profile.name}] No base profile at ${BASE_PROFILE_DIR} — starting empty profile ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  return dir;
}

// AdsPower local API (default port 50325)
const ADSPOWER_API = process.env.ADSPOWER_API || 'http://local.adspower.net:50325';
// iX Browser local API (default port 53200)
const IXBROWSER_API = process.env.IXBROWSER_API || 'http://127.0.0.1:53200';

function randomDelay(min = 1000, max = 3000) {
  return new Promise(r => setTimeout(r, Math.random() * (max - min) + min));
}
function humanDelay() { return randomDelay(800, 2500); }
function shortDelay() { return randomDelay(300, 800); }
function longDelay()  { return randomDelay(3000, 6000); }

// ── HTTP GET helper for browser APIs ──────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Invalid API response')); }
      });
    }).on('error', reject);
  });
}

async function waitForCDP(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((res, rej) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, r => { r.resume(); res(); });
        req.on('error', rej);
        req.setTimeout(1000, () => { req.destroy(); rej(); });
      });
      return true;
    } catch(_) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Chrome CDP not ready on port ${port} after ${timeoutMs}ms`);
}

// ── Open via AdsPower API ─────────────────────────────────────────
async function openAdsPower(profile) {
  // profile.adsPowerId = the AdsPower user_id
  console.log(`[${profile.name}] Opening AdsPower profile ${profile.adsPowerId}...`);
  const res = await httpGet(`${ADSPOWER_API}/api/v1/browser/start?user_id=${profile.adsPowerId}`);
  if (res.code !== 0) throw new Error(`AdsPower error: ${res.msg}`);

  // AdsPower returns the CDP websocket endpoint
  const wsEndpoint = res.data.ws.puppeteer;
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 60000 });
  const context = browser.contexts()[0];
  const page = await context.newPage();
  console.log(`[${profile.name}] AdsPower connected!`);
  return { browser, context, page };
}

// ── Open via iX Browser API ───────────────────────────────────────
async function openIxBrowser(profile) {
  // profile.ixProfileId = the iX browser profile id
  console.log(`[${profile.name}] Opening iX profile ${profile.ixProfileId}...`);
  const res = await httpGet(`${IXBROWSER_API}/api/v2/profile-open?profile_id=${profile.ixProfileId}`);
  if (!res.data || !res.data.ws) throw new Error(`iX Browser error: ${JSON.stringify(res)}`);

  const wsEndpoint = res.data.ws;
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 60000 });
  const context = browser.contexts()[0];
  const page = await context.newPage();
  console.log(`[${profile.name}] iX Browser connected!`);
  return { browser, context, page };
}

// ── Stealth: rely on the REAL Chrome fingerprint, do NOT spoof ────
//
// IMPORTANT LESSON (v1.5.4 regression): a previous version injected JS to fake
// navigator.webdriver=undefined, a synthetic plugins array, chrome.runtime, and
// permission responses. That BROKE more than it fixed. Cloudflare Turnstile
// (the "Verifying you are human" loop on auth.openai.com) does advanced
// fingerprinting that specifically flags INCONSISTENT spoofing:
//   - real Chrome has navigator.webdriver === false, not undefined; the
//     override was itself a bot tell;
//   - a plugins array built from Plugin.prototype tricks doesn't match a real
//     PluginArray and is a known Turnstile signal;
//   - patching chrome.runtime to an empty object mismatches real Chrome's shape.
// The result was a Cloudflare challenge that never passed even for a human,
// because the fingerprint was internally contradictory.
//
// Since we launch the user's REAL Google Chrome (not headless Chromium) with a
// real user-data-dir and a real (non-zero) debug port, the genuine fingerprint
// is already correct: navigator.webdriver is already false (per MDN it's only
// true with --enable-automation, --headless, or --remote-debugging-port=0), and
// real plugins / chrome object / WebGL / canvas are all present. So the right
// move is to inject NOTHING and pass no automation flags — let the authentic
// browser through.
//
// This function is kept as a documented no-op so the call site is stable and
// the reasoning is preserved for the next person who is tempted to "add
// stealth" — don't; it makes Cloudflare worse, not better.
async function applyStealthEvasions(_context) {
  // Intentionally empty. See the note above. Real Chrome + the launch flag is
  // the correct and sufficient configuration.
  return;
}

// ── Open via regular Chrome (launch with profile folder) ──────────
async function openRegularChrome(profile) {
  // DEBUG: show exactly what port value (and type) this profile arrived with,
  // so we can confirm whether the DB's saved port is actually reaching here.
  console.log(`[${profile.name}] DEBUG profile.port = ${JSON.stringify(profile.port)} (type: ${typeof profile.port})`);

  // If the profile already specified a port AND a live Chrome answers on it, reuse it.
  if (profile.port) {
    try {
      await waitForCDP(profile.port, 3000);
      console.log(`[${profile.name}] Already open on port ${profile.port}`);
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${profile.port}`, { timeout: 60000 });
      const ctx = b.contexts()[0];
      const pg = await ctx.newPage();
      console.log(`[${profile.name}] Connected (existing)!`);
      return { browser: b, context: ctx, page: pg };
    } catch (_) { /* no live chrome on that port → launch fresh below */ }
  }

  // Resolve the data dir (auto-clone from base profile if missing → inherits logins)
  const dir = resolveProfileDir(profile);

  // Make sure NOTHING from a previous run is still holding this profile's
  // directory before we try to launch a fresh Chrome into it. This is the fix
  // for "Chrome CDP not ready" on the 2nd+ run of the same profile: a previous
  // detached Chrome process can outlive browser.close()/disconnect() and keep
  // the dir locked, so the next launch silently fails to fully start.
  const trackedPid = spawnedPids.get(profile.name);
  if (trackedPid) {
    killProcessTree(trackedPid);
    spawnedPids.delete(profile.name);
  }
  killChromeUsingDir(dir);
  // Give the OS a brief moment to actually release the lock file after the kill.
  await new Promise(r => setTimeout(r, 500));

  // No live Chrome here → any lock in this dir is stale → remove it so Chrome opens cleanly
  cleanStaleLocks(dir);

  // Use the profile's FIXED port if one is configured (matches the working PC
  // setup); otherwise auto-assign a free port. Previously, when no Chrome was
  // already running on the fixed port, the code fell through to a RANDOM port
  // instead of actually launching on the assigned one — on this VPS, random
  // high ports were apparently unreliable/blocked, causing "CDP not ready".
  // Using the fixed port (same one that works reliably on the PC) avoids that.
  const port = profile.port || await findFreePort();
  console.log(`[${profile.name}] Launching Chrome on port ${port}${profile.port ? ' (fixed)' : ' (auto)'} (dir: ${dir})`);

  // Kill any Chrome still holding THIS profile directory. A crashed run leaves
  // Chrome alive locking botdata_*, and a new Chrome cannot take over a locked
  // profile — every later launch then failed with "CDP not ready". Matching on
  // the directory works for auto-assigned ports too (the port-based cleanup
  // below only ran when a fixed port was configured, so it never fired here).
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      const q = String(dir).replace(/\\/g, '\\\\');
      const cmd = `wmic process where "name='chrome.exe' and commandline like '%%${q}%%'" get processid`;
      const out = execSync(cmd, { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const pids = out.split(/\s+/).map(x => parseInt(x, 10)).filter(n => n > 0);
      for (const pid of pids) {
        try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, stdio: 'ignore' }); } catch (_) {}
      }
      if (pids.length) {
        console.log(`[${profile.name}] Killed ${pids.length} orphaned Chrome holding ${dir}`);
        await new Promise(r => setTimeout(r, 800));
      }
    }
  } catch (_) { /* cleanup is best-effort */ }

  // If using a FIXED port, make sure nothing stale is still bound to it
  // (e.g. a zombie Chrome from a previous crashed run) before launching.
  if (profile.port) {
    killProcessOnPort(port);
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Kill the "Restore pages? Chrome didn't shut down correctly" bubble ──────
  // We force-kill Chrome (taskkill /F) on recycle and shutdown — that is a hard
  // exit, so on the NEXT launch Chrome thinks it crashed and shows the Restore
  // bubble (and a "Chrome didn't shut down correctly" toast). That bubble steals
  // focus and can sit over the composer, which is what forced a manual click.
  // The reliable fix is to rewrite the profile's last-exit markers to "Normal"
  // BEFORE launching, so Chrome believes the previous session closed cleanly.
  // --disable-session-crashed-bubble alone does NOT cover the newer bubble.
  try {
    markProfileExitClean(dir);
  } catch (_) { /* best effort; the flags below still help */ }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    // Also hide the crash-restore bubble via the newer flag name and stop Chrome
    // from restoring the previous (crashed) session, which is what triggers the
    // "Restore pages?" prompt in current Chrome builds.
    '--hide-crash-restore-bubble',
    '--disable-features=InfiniteSessionRestore',
    // NOTE: we deliberately do NOT pass --disable-blink-features=AutomationControlled.
    // Per MDN, navigator.webdriver is only true in Chrome when --enable-automation
    // or --headless is set, or --remote-debugging-port=0 (port ZERO). We launch
    // real Chrome with a real non-zero debug port and none of those flags, so
    // webdriver is ALREADY false — the flag added no stealth benefit and instead
    // made Chrome show a yellow "You are using an unsupported command-line flag"
    // banner that alarmed users and could overlap the composer.
    '--disable-infobars',
    // Suppress the first-run "make Chrome your default / sign in" promos that
    // can also steal focus on a fresh-ish profile.
    '--disable-features=ChromeWhatsNewUI',
    '--no-service-autorun',
    '--password-store=basic',
  ];
  if (!IS_WINDOWS) {
    args.push('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  } else {
    args.push('--start-maximized');
  }
  const child = spawn(CHROME_PATH, args, {
    detached: true,
    stdio: 'ignore',
    // On Linux, run Chrome in its own process group so killProcessTree's
    // negative-PID kill can take down all its helper processes together.
    ...(IS_WINDOWS ? {} : { detached: true }),
  });
  child.unref();
  spawnedPids.set(profile.name, child.pid);

  try {
    await waitForCDP(port, 30000);
  } catch (e) {
    // Launch failed to come up — clean up the half-started process so it
    // doesn't linger and block the NEXT attempt too.
    killProcessTree(child.pid);
    spawnedPids.delete(profile.name);
    throw e;
  }
  await new Promise(r => setTimeout(r, 3000));

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 60000 });
  const context = browser.contexts()[0];

  // ── JS evasion layer ───────────────────────────────────────────────────────
  // --disable-blink-features handles the Chrome side. But Playwright's CDP
  // connection injects its own webdriver flag through a separate channel that
  // Chrome args alone can't stop. Patch it out at the JS layer by injecting a
  // script that runs on EVERY page before any other script does, including
  // ChatGPT's bot-detection checks.
  await applyStealthEvasions(context);

  const page = await context.newPage();
  console.log(`[${profile.name}] Connected!`);
  return { browser, context, page };
}

// ── Main openChrome — auto-detects browser type ───────────────────
async function openChrome(profile) {
  // Determine which browser system to use, based on profile config
  const type = profile.browserType || 'chrome'; // 'chrome' | 'adspower' | 'ix'

  if (type === 'adspower' && profile.adsPowerId) {
    return await openAdsPower(profile);
  }
  if (type === 'ix' && profile.ixProfileId) {
    return await openIxBrowser(profile);
  }
  // Default: regular Chrome
  return await openRegularChrome(profile);
}

// ── Close AdsPower profile (call when done) ───────────────────────
async function closeAdsPower(profile) {
  try {
    await httpGet(`${ADSPOWER_API}/api/v1/browser/stop?user_id=${profile.adsPowerId}`);
    console.log(`[${profile.name}] AdsPower profile closed`);
  } catch (e) {
    console.log(`[${profile.name}] AdsPower close error: ${e.message}`);
  }
}

// ── Universal graceful close (all browser types) ──────────────────
async function closeBrowser(profile, browser, page) {
  const type = profile.browserType || 'chrome';
  try {
    // Close the page first (gentle)
    if (page) { try { await page.close(); } catch (_) {} }

    if (type === 'adspower' && profile.adsPowerId) {
      await closeAdsPower(profile);
    } else if (browser) {
      // Regular Chrome / iX over CDP: disconnect, then try close
      try { await browser.close(); }
      catch (_) {
        try { await browser.disconnect(); } catch (__) {}
      }

      // IMPORTANT FIX: browser.close()/disconnect() over CDP often does NOT
      // terminate the actual chrome.exe process when it was launched detached
      // (unref'd). The process can keep running and hold a lock on the profile's
      // user-data-dir, which breaks the NEXT run of this same profile with
      // "Chrome CDP not ready" (a new Chrome can't fully initialize against a
      // dir that's still locked). So for regular/ix Chrome we now force-kill
      // the tracked OS process directly, instead of only closing the CDP link.
      if (type !== 'adspower') {
        const pid = spawnedPids.get(profile.name);
        if (pid) {
          killProcessTree(pid);
          spawnedPids.delete(profile.name);
        } else {
          // No tracked pid (e.g. we reconnected to an already-open Chrome) —
          // fall back to finding it by profile dir.
          const dir = profile.dir || path.join(
            PROFILES_BASE_DIR,
            String(profile.name || 'profile').replace(/[^a-zA-Z0-9_-]/g, '_')
          );
          killChromeUsingDir(dir);
        }
      }

      // Give the OS a moment to fully release the profile folder lock after
      // the kill, before the next profile run tries to reuse it.
      await new Promise(r => setTimeout(r, 1500));
      console.log(`[${profile.name}] browser closed`);
    }
  } catch (e) {
    console.log(`[${profile.name}] close error: ${e.message}`);
  }
}

// Human-like typing
async function humanType(page, selector, text) {
  await page.click(selector);
  await shortDelay();
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.random() * 80 + 30 });
  }
  await shortDelay();
}

// Paste text via clipboard (faster for long text)
async function pasteText(page, text) {
  await page.evaluate(async (t) => {
    await navigator.clipboard.writeText(t);
  }, text);
  await page.keyboard.press('Control+v');
  await shortDelay();
}

// Keep page active (prevent sleep/freeze)
async function keepAlive(page) {
  try {
    await page.mouse.move(
      Math.random() * 100 + 100,
      Math.random() * 100 + 100
    );
  } catch(_) {}
}

// List Chrome profile folders on this PC (scan PROFILES_BASE_DIR)
async function listLocalProfiles() {
  const found = [];
  const bases = [PROFILES_BASE_DIR];
  if (IS_WINDOWS) bases.push('C:\\');
  else bases.push(os.homedir());

  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base)) {
        const full = path.join(base, entry);
        let isDir = false;
        try { isDir = fs.statSync(full).isDirectory(); } catch (_) {}
        if (!isDir) continue;
        const looksLikeProfile =
          fs.existsSync(path.join(full, 'Default')) ||
          fs.existsSync(path.join(full, 'Local State'));
        if (looksLikeProfile && (entry.startsWith('botdata_') || base === PROFILES_BASE_DIR)) {
          const name = entry.replace(/^botdata_/, '');
          if (!found.find(f => f.name === name)) found.push({ name, dir: full });
        }
      }
    } catch (_) {}
  }
  return found;
}

module.exports = {
  openChrome,
  closeAdsPower,
  closeBrowser,
  listLocalProfiles,
  humanType,
  pasteText,
  humanDelay,
  shortDelay,
  longDelay,
  randomDelay,
  keepAlive,
  // Exposed so the manual profile launcher opens the EXACT same folder the bot
  // uses (and marks a clean exit so no "Restore pages" bubble appears).
  resolveProfileDir,
  markProfileExitClean,
  cleanStaleLocks,
  killAllBotChrome,
  CHROME_PATH,
  BASE_PROFILE_DIR,
  PROFILES_BASE_DIR,
  IS_WINDOWS,
};
