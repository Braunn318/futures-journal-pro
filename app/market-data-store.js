'use strict';
// Nastavení „Data trhu" – soubor <userData>/market-data/settings.json (jen main proces).
// Platí pro celou aplikaci, stejně jako nastavení LTA levelů.

const path = require('path');
const FJMarket = require('./market-data.js');

function createMarketStore({ userDataDir, fs = require('fs') }) {
  const root = path.join(userDataDir, 'market-data');
  const settingsPath = path.join(root, 'settings.json');

  function getSettings() {
    try { return FJMarket.cleanMarketSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
    catch { return FJMarket.cleanMarketSettings({}); }
  }

  function setSettings(patch) {
    const next = FJMarket.applyPatch(getSettings(), patch);
    fs.mkdirSync(root, { recursive: true });
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, settingsPath);
    return next;
  }

  return { getSettings, setSettings, root };
}

module.exports = { createMarketStore };
