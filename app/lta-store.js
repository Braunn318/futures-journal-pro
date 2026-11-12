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

// `exportDir()` = složka ai-export/lta-levels, když je zapnutý export archivu
// pro Backtest Lab (Nastavení → Data trhu), jinak null.
function createLtaStore({ userDataDir, documentsDir, fs = require('fs'), log = () => {}, now = () => Date.now(), exportDir = () => null }) {
  const root = path.join(userDataDir, 'lta-levels');
  const settingsPath = path.join(root, 'settings.json');
  const fileCache = new Map();      // abs → { mtimeMs, size, levels }
  const lastSignature = new Map();  // den → podpis poslední verze
  let timer = null;
  let lastSnapshot = null;          // { at, levelCount, written }
  let busy = null;
  let retentionChecked = false;

  function ensureRoot() { fs.mkdirSync(root, { recursive: true }); }

  function writeAtomic(file, text) {
    ensureRoot();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }

  // Do 4.8.101 se archiv po 90 dnech mazal (výchozí hodnota). Mazání je ztráta
  // dat, proto se stará výchozí 90 jednou převede na „bez mazání" (0) – se
  // zálohou settings.pred-retenci.json. Jinou ruční hodnotu převod nemění.
  function migrateRetention() {
    if (retentionChecked) return;
    retentionChecked = true;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return; }
    if (!raw || typeof raw !== 'object' || raw.retentionMigrated === true) return;
    const old = raw.retentionDays === undefined || Number(raw.retentionDays) === 90;
    try {
      if (old) fs.copyFileSync(settingsPath, path.join(root, 'settings.pred-retenci.json'));
      writeAtomic(settingsPath, JSON.stringify(FJLta.cleanSettings({ ...raw, ...(old ? { retentionDays: 0 } : {}), retentionMigrated: true }), null, 2));
      if (old) log('info', 'LTA levely: archiv se už nemaže (90 dní → bez mazání), záloha settings.pred-retenci.json.');
    } catch (err) {
      log('warn', 'LTA levely: převod retence selhal: ' + (err?.message || err));
    }
  }

  function getSettings() {
    migrateRetention();
    try { return FJLta.cleanSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
    // Bez souboru = nová instalace: výchozí „bez mazání", převod už není potřeba.
    catch { return FJLta.cleanSettings({ retentionMigrated: true }); }
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
      try { exportDays([day + '.json']); } catch (err) { log('warn', 'LTA levely: export do ai-export selhal: ' + (err?.message || err)); }
      return { written: true, day, count: levels.length };
    })();
    try { return await busy; } finally { busy = null; }
  }

  function archiveDays() {
    try { return fs.readdirSync(root).filter(n => DAY_FILE_RE.test(n)).sort(); } catch { return []; }
  }

  // Kopie archivu pro Backtest Lab: ai-export/lta-levels/RRRR-MM-DD.json =
  // { day, versions: [{ from, signature, levels }] } se všemi instrumenty.
  // Soubor se přepíše jen tehdy, když se obsah liší. Vypnutý export nic nemaže.
  function exportDays(names) {
    let dir = null;
    try { dir = exportDir(); } catch { dir = null; }
    if (!dir) return { written: 0, same: 0, off: true };
    let written = 0;
    let same = 0;
    for (const name of names) {
      const day = DAY_FILE_RE.exec(name)?.[1];
      if (!day) continue;
      const text = JSON.stringify({ day, versions: readDay(day) });
      const target = path.join(dir, name);
      let current = null;
      try { current = fs.readFileSync(target, 'utf8'); } catch { /* ještě není */ }
      if (current === text) { same++; continue; }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target + '.tmp', text, 'utf8');
      fs.renameSync(target + '.tmp', target);
      written++;
    }
    return { written, same };
  }

  function exportArchive() { return exportDays(archiveDays()); }

  // Pracovní dny mezi prvním dnem archivu a včerejškem, pro které archiv není
  // (deník ten den neběžel). Nejnovější první.
  function missingWeekdays(days) {
    if (!days.length) return [];
    const have = new Set(days.map(n => n.slice(0, 10)));
    const [y, m, d] = days[0].slice(0, 10).split('-').map(Number);
    const cur = new Date(y, m - 1, d);
    const today = localDate(now());
    const out = [];
    while (localDate(cur.getTime()) < today) {
      const wd = cur.getDay();
      const key = localDate(cur.getTime());
      if (wd !== 0 && wd !== 6 && !have.has(key)) out.push(key);
      cur.setDate(cur.getDate() + 1);
    }
    return out.reverse();
  }

  // 0 = bez mazání (výchozí od 4.8.102).
  function prune(settings = getSettings()) {
    if (!(settings.retentionDays > 0)) return 0;
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
      const cur = await readCurrent(settings);
      levels = cur.levels;
      source = 'live';
      // Živé soubory: „verze" platí od posledního zápisu použitých souborů.
      const changed = Math.max(0, ...cur.files.filter(f => f.enabled && !f.error).map(f => f.mtimeMs));
      versionFrom = changed > 0 ? new Date(changed).toISOString() : null;
    }
    // Verze, kterou deník uložil (nebo LTA zapsal) až po vstupu, může obsahovat
    // levely, které při vstupu ještě nebyly – pohled do budoucnosti.
    const versionAfterEntry = !!(levels && versionFrom && Number.isFinite(entryMs) && Date.parse(versionFrom) > entryMs);
    const disabled = new Set(settings.disabledFiles);
    // Vyloučené názvy (Nastavení → LTA levely) se nedoplňují; archiv je drží
    // dál, takže zrušení vyloučení platí i pro starší dny.
    const list = FJLta.levelsForInstrument((levels || []).filter(l => !disabled.has(l.source) && !FJLta.isExcluded(l.name, settings)), instrumentRoot, instrumentFull, new Date(t).toISOString());
    return { ok: true, levels: list, source: levels ? source : 'none', day, versionFrom, versionAfterEntry };
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
      // `names` = názvy levelů v souboru – pro výběr, co se doplňuje.
      files: files.map(({ abs, ...f }) => {
        const cached = f.enabled ? fileCache.get(abs) : null;
        return cached ? { ...f, names: [...new Set(cached.levels.map(l => l.name))].sort((a, b) => a.localeCompare(b)) } : f;
      }), levelCount: levels.length,
      archive: (() => {
        const missing = missingWeekdays(days);
        return { days: days.length, first: days[0]?.slice(0, 10) || null, last: days[days.length - 1]?.slice(0, 10) || null, bytes, missingWeekdays: missing.slice(0, 60), missingCount: missing.length };
      })(),
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
    try { exportArchive(); } catch (err) { log('warn', 'LTA levely: export do ai-export selhal: ' + (err?.message || err)); }
    restartTimer();
    snapshot().catch(err => log('warn', 'LTA levely: první snímek selhal: ' + (err?.message || err)));
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // Dny archivu (RRRR-MM-DD) – pro zpětné doplnění svíček (Data trhu).
  function archiveDayList() { return archiveDays().map(n => n.slice(0, 10)); }

  return { getSettings, setSettings, folder, defaultFolder, listFiles, readCurrent, snapshot, levelsFor, status, prune, exportArchive, archiveDayList, start, stop, root };
}

module.exports = { createLtaStore, localDate, TIMER_MS };
