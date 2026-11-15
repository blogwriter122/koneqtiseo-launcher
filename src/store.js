/**
 * src/store.js — Settings persistence
 *
 * The API key is never written in plain text (security audit 15 Nov 2026): it is encrypted with Electron's safeStorage
 * (Windows DPAPI / macOS Keychain / Linux secret store — only this PC user can read it) and saved as apiKeyEnc.
 * A settings.json from an older launcher (plain apiKey) is converted on the first read. If the PC has no secret store
 * (some Linux setups) the key stays as it was, as before.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const canEncrypt = () => { try { return !!safeStorage && safeStorage.isEncryptionAvailable(); } catch (_) { return false; } };

class Store {
  constructor() {
    const userDataPath = app ? app.getPath('userData') : path.join(require('os').homedir(), '.koneqtiseo');
    this.filePath = path.join(userDataPath, 'settings.json');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  readRaw() {
    try { if (fs.existsSync(this.filePath)) return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (_) {}
    return { gatewayUrl: 'wss://gateway.koneqtiseo.com' };
  }

  writeRaw(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.filePath, 0o600); } catch (_) {}   // a file from an older launcher keeps its mode otherwise
  }

  get() {
    const raw = this.readRaw();
    let apiKey = '';
    if (raw.apiKeyEnc && canEncrypt()) {
      try { apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64')); } catch (_) { apiKey = ''; }
    } else if (raw.apiKey) {
      apiKey = raw.apiKey;
      if (canEncrypt()) this.save({ apiKey });   // an older plain key: encrypt it now
    }
    const { apiKeyEnc, ...rest } = raw;
    return { gatewayUrl: 'wss://gateway.koneqtiseo.com', ...rest, apiKey };
  }

  save(data) {
    const { apiKey: _plain, ...current } = this.readRaw();
    const next = { ...current, ...data };
    if ('apiKey' in data) {
      delete next.apiKey; delete next.apiKeyEnc;
      if (data.apiKey) {
        if (canEncrypt()) next.apiKeyEnc = safeStorage.encryptString(String(data.apiKey)).toString('base64');
        else next.apiKey = data.apiKey;   // no secret store on this PC
      }
    } else if (_plain && !current.apiKeyEnc) next.apiKey = _plain;
    this.writeRaw(next);
  }
}

module.exports = Store;
