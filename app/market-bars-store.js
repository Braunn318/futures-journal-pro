'use strict';
// Data trhu – minutové svíčky dne (J2), jen main proces.
//
// <userData>/market/<ROOT>/<RRRR-MM-DD>.json – jeden soubor na kořen a den
// (tvar viz app/market-bars.js). Soubor se přepíše jen tehdy, když přibyly
// svíčky. Kopie pro Backtest Lab jde do ai-export/market/<ROOT>/<den>.json,
// když je zapnuté ukládání svíček (`exportDir()` vrací složku, jinak null).
// Nic se samo nemaže – mazání jen ručně.

const path = require('path');
const FJMarketBars = require('./market-bars.js');

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const ROOT_RE = /^[A-Z0-9_.-]{1,20}$/;

function createMarketBarsStore({ userDataDir, fs = require('fs'), exportDir = () => null, now = () => Date.now() }) {
  const root = path.join(userDataDir, 'market');

  function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', text, 'utf8');
    fs.renameSync(file + '.tmp', file);
  }

  function fileOf(instrumentRoot, day) {
    const r = FJMarketBars.rootOf(instrumentRoot);
    if (!ROOT_RE.test(r) || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return null;
    return path.join(root, r, day + '.json');
  }

  function read(instrumentRoot, day) {
    const file = fileOf(instrumentRoot, day);
    if (!file) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  function safeExportDir() {
    try { return exportDir() || null; } catch { return null; }
  }

  function mirror(r, day, text) {
    const dir = safeExportDir();
    if (!dir) return false;
    const target = path.join(dir, r, day + '.json');
    let current = null;
    try { current = fs.readFileSync(target, 'utf8'); } catch { /* ještě není */ }
    if (current === text) return false;
    writeAtomic(target, text);
    return true;
  }

  // Zpráva market_bars z konektoru → soubor dne.
  function save(payload) {
    const norm = FJMarketBars.normalizeBarsPayload(payload, new Date(now()).toISOString());
    if (!norm.ok) return { ok: false, error: norm.error };
    const data = norm.data;
    const file = fileOf(data.root, data.day);
    if (!file) return { ok: false, error: 'invalid' };
    const current = read(data.root, data.day);
    if (!FJMarketBars.shouldReplace(current, data)) {
      return { ok: true, written: false, reason: 'not_longer', bars: current?.bars?.length || 0, root: data.root, day: data.day };
    }
    const text = JSON.stringify(data);
    writeAtomic(file, text);
    mirror(data.root, data.day, text);
    return { ok: true, written: true, bars: data.bars.length, dropped: norm.dropped, root: data.root, day: data.day };
  }

  function roots() {
    try { return fs.readdirSync(root).filter(n => ROOT_RE.test(n)).sort(); } catch { return []; }
  }

  function daysOf(r) {
    try { return fs.readdirSync(path.join(root, r)).filter(n => DAY_FILE_RE.test(n)).sort(); } catch { return []; }
  }

  // { 'ROOT|den': úplný? } – pro plán zpětného doplnění.
  function storedIndex() {
    const out = {};
    for (const r of roots()) for (const name of daysOf(r)) {
      const day = name.slice(0, 10);
      out[r + '|' + day] = FJMarketBars.isComplete(read(r, day));
    }
    return out;
  }

  function status() {
    let days = 0;
    let bytes = 0;
    const list = roots();
    for (const r of list) for (const name of daysOf(r)) {
      days++;
      try { bytes += fs.statSync(path.join(root, r, name)).size; } catch { /* ignore */ }
    }
    return { days, roots: list.filter(r => daysOf(r).length), bytes, folder: root };
  }

  // Dorovná kopii v ai-export (po zapnutí ukládání svíček).
  function exportAll() {
    if (!safeExportDir()) return { written: 0, same: 0, off: true };
    let written = 0;
    let same = 0;
    for (const r of roots()) for (const name of daysOf(r)) {
      let text;
      try { text = fs.readFileSync(path.join(root, r, name), 'utf8'); } catch { continue; }
      if (mirror(r, name.slice(0, 10), text)) written++; else same++;
    }
    return { written, same };
  }

  return { save, read, storedIndex, status, exportAll, root };
}

module.exports = { createMarketBarsStore };
