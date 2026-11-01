'use strict';
// LTA Custom Levels – čtení složky a archiv verzí (jen main proces).
//
// LTA soubory přepisuje každých ~5 minut a drží v nich jen aktuální stav.
// Aby šly levely přiřadit i obchodu zapsanému později (večer, další den),
// ukládá se při každé SKUTEČNÉ změně levelů verze do
// <userData>/lta-levels/RRRR-MM-DD.json = { versions: [{ from, signature, levels }] }.
//
// Šetrnost (požadavek uživatele: nezatížit PC, deník ani NT8):
//  - časovač jednou za 5 minut udělá jen fs.stat cca 20 souborů,
//  - soubor se čte a parsuje jen tehdy, když se mu změnil čas zápisu nebo velikost,
//  - verze se zapíše jen tehdy, když se levely opravdu liší (podpis obsahu),
//  - do složky NinjaTraderu / LTA se nikdy nezapisuje,
//  - vypnutý import nebo archiv = časovač neběží.

const path = require('path');
const FJLta = require('./lta-levels.js');

const SUBFOLDERS = ['System', 'Local'];
const TIMER_MS = 5 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function localDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function createLtaStore({ userDataDir, documentsDir, fs = require('fs'), log = () => {}, now = () => Date.now() }) {
  const root = path.join(userDataDir, 'lta-levels');
  const settingsPath = path.join(root, 'settings.json');
  const fileCache = new Map();      // abs → { mtimeMs, size, levels }
  const lastSignature = new Map();  // den → podpis poslední verze
  let timer = null;
  let lastSnapshot = null;          // { at, levelCount, written }
  let busy = null;

  function ensureRoot() { fs.mkdirSync(root, { recursive: true }); }

  function writeAtomic(file, text) {
    ensureRoot();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }

  function getSettings() {
    try { return FJLta.cleanSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
    catch { return FJLta.cleanSettings({}); }
  }

  function setSettings(patch) {
    const next = FJLta.cleanSettings({ ...getSettings(), ...(patch && typeof patch === 'object' ? patch : {}) });
    writeAtomic(settingsPath, JSON.stringify(next, null, 2));
    restartTimer();
    return next;
  }

  function defaultFolder() { return path.join(documentsDir, ...FJLta.DEFAULT_SUBDIR); }

  function folder(settings = getSettings()) { return settings.folder || defaultFolder(); }

  // Seznam XML souborů v System a Local (bez nastavení LTA v kořeni složky).
  async function listFiles(settings = getSettings()) {
    const base = folder(settings);
    const disabled = new Set(settings.disabledFiles);
    const out = [];
    for (const sub of SUBFOLDERS) {
      let names = [];
      try { names = await fs.promises.readdir(path.join(base, sub)); } catch { continue; }
      for (const name of names.filter(n => /\.xml$/i.test(n)).sort((a, b) => a.localeCompare(b))) {
        const abs = path.join(base, sub, name);
        try {
          const st = await fs.promises.stat(abs);
          if (!st.isFile()) continue;
          const rel = sub + '/' + name;
          out.push({ rel, abs, mtimeMs: st.mtimeMs, size: st.size, enabled: !disabled.has(rel) });
        } catch { /* soubor zmizel mezi readdir a stat */ }
      }
    }
    return out;
  }

  // Aktuální levely ze zapnutých souborů. Soubor beze změny se nečte znovu.
  async function readCurrent(settings = getSettings()) {
    const files = await listFiles(settings);
    const levels = [];
    for (const f of files) {
      if (!f.enabled) continue;
      const cached = fileCache.get(f.abs);
      if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) {
        f.count = cached.levels.length;
        levels.push(...cached.levels);
        continue;
      }
      try {
        const parsed = FJLta.parseLtaXml(await fs.promises.readFile(f.abs, 'utf8'), f.rel);
        fileCache.set(f.abs, { mtimeMs: f.mtimeMs, size: f.size, levels: parsed });
        f.count = parsed.length;
        levels.push(...parsed);
      } catch (err) {
        // LTA soubor právě přepisuje – příště se přečte znovu.
        f.error = String(err?.message || err);
      }
    }
    return { files, levels };
  }

  function dayPath(day) { return path.join(root, day + '.json'); }

  function readDay(day) {
    try {
      const data = JSON.parse(fs.readFileSync(dayPath(day), 'utf8'));
      return Array.isArray(data?.versions) ? data.versions : [];
    } catch { return []; }
  }

  // Uloží verzi, jen když se levely změnily od poslední verze dne.
  async function snapshot() {
    if (busy) return busy;
    busy = (async () => {
      const settings = getSettings();
      if (!settings.enabled || !settings.archive) return { written: false, reason: 'off' };
      const { levels } = await readCurrent(settings);
      const at = now();
      if (!levels.length) { lastSnapshot = { at, levelCount: 0, written: false }; return { written: false, reason: 'empty' }; }
      const day = localDate(at);
      const signature = FJLta.levelsSignature(levels);
      if (!lastSignature.has(day)) {
        const versions = readDay(day);
        lastSignature.set(day, versions.length ? versions[versions.length - 1].signature : null);
      }
      if (lastSignature.get(day) === signature) {
        lastSnapshot = { at, levelCount: levels.length, written: false };
        return { written: false, reason: 'same' };
      }
      const versions = readDay(day);
      versions.push({ from: new Date(at).toISOString(), signature, levels });
      writeAtomic(dayPath(day), JSON.stringify({ versions }));
      lastSignature.set(day, signature);
      lastSnapshot = { at, levelCount: levels.length, written: true };
      log('info', `LTA levely: uložena verze ${day} (${levels.length} levelů).`);
      return { written: true, day, count: levels.length };
    })();
    try { return await busy; } finally { busy = null; }
  }

  function archiveDays() {
    try { return fs.readdirSync(root).filter(n => DAY_FILE_RE.test(n)).sort(); } catch { return []; }
  }

  function prune(settings = getSettings()) {
    const cutoff = localDate(now() - settings.retentionDays * 864e5);
    let removed = 0;
    for (const name of archiveDays()) {
      if (DAY_FILE_RE.exec(name)[1] < cutoff) {
        try { fs.unlinkSync(path.join(root, name)); removed++; } catch { /* ignore */ }
      }
    }
    return removed;
  }

  // Levely pro obchod: verze platná v čase vstupu ze dne vstupu; bez archivu
  // pro dnešek živé soubory. `levels` jsou jen levely daného instrumentu.
  async function levelsFor({ root: instrumentRoot, instrumentFull, entryISO } = {}) {
    const settings = getSettings();
    if (!settings.enabled) return { ok: true, levels: [], source: 'off' };
    const entryMs = Date.parse(entryISO);
    const t = Number.isFinite(entryMs) ? entryMs : now();
    const day = localDate(t);
    let levels = null;
    let source = 'none';
    let versionFrom = null;
    if (settings.archive) {
      if (day === localDate(now())) await snapshot();
      const v = FJLta.versionAt(readDay(day), t);
      if (v) { levels = v.levels; source = 'archive'; versionFrom = v.from; }
    }
    if (!levels && day === localDate(now())) {
      levels = (await readCurrent(settings)).levels;
      source = 'live';
    }
    const disabled = new Set(settings.disabledFiles);
    const list = FJLta.levelsForInstrument((levels || []).filter(l => !disabled.has(l.source)), instrumentRoot, instrumentFull, new Date(t).toISOString());
    return { ok: true, levels: list, source: levels ? source : 'none', day, versionFrom };
  }

  async function status() {
    const settings = getSettings();
    const base = folder(settings);
    let folderExists = false;
    try { folderExists = fs.statSync(base).isDirectory(); } catch { /* chybí */ }
    const { files, levels } = folderExists ? await readCurrent(settings) : { files: [], levels: [] };
    const days = archiveDays();
    let bytes = 0;
    for (const name of days) { try { bytes += fs.statSync(path.join(root, name)).size; } catch { /* ignore */ } }
    return {
      ok: true, settings, folder: base, defaultFolder: defaultFolder(), folderExists,
      files: files.map(({ abs, ...f }) => f), levelCount: levels.length,
      archive: { days: days.length, first: days[0]?.slice(0, 10) || null, last: days[days.length - 1]?.slice(0, 10) || null, bytes },
      lastSnapshot
    };
  }

  function restartTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    const settings = getSettings();
    if (!settings.enabled || !settings.archive) return;
    timer = setInterval(() => { snapshot().catch(err => log('warn', 'LTA levely: snímek selhal: ' + (err?.message || err))); }, TIMER_MS);
    if (timer.unref) timer.unref();
  }

  function start() {
    try { prune(); } catch { /* ignore */ }
    restartTimer();
    snapshot().catch(err => log('warn', 'LTA levely: první snímek selhal: ' + (err?.message || err)));
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { getSettings, setSettings, folder, defaultFolder, listFiles, readCurrent, snapshot, levelsFor, status, prune, start, stop, root };
}

module.exports = { createLtaStore, localDate, TIMER_MS };
