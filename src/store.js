/**
 * src/store.js — Settings persistence
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Store {
  constructor() {
    const userDataPath = app ? app.getPath('userData') : path.join(require('os').homedir(), '.koneqtiseo');
    this.filePath = path.join(userDataPath, 'settings.json');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  get() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (_) {}
    return { apiKey: '', gatewayUrl: 'wss://gateway.koneqtiseo.com' };
  }

  save(data) {
    const current = this.get();
    fs.writeFileSync(this.filePath, JSON.stringify({ ...current, ...data }, null, 2));
  }
}

module.exports = Store;
