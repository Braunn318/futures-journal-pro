'use strict';
// Přesun složky dat (Nastavení → Data a zálohy → umístění dat), 4.8.93.
//
// Proč to existuje: staré kopie se mazaly DŘÍV, než se zapsal ukazatel na nové
// umístění – pád nebo chyba zápisu mezi tím nechal appku ukazovat do prázdné
// složky (prázdný deník, nový API klíč konektoru). Cíl s daty se tiše
// přepsal, kopie se ověřovala jen existencí, ai-export se nestěhoval a vlastní
// složka obrázků uvnitř dat zůstala ukazovat na smazané místo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMain } = require('./helpers/extract');

const NAMES = ['DATA_ENTRIES', 'DATA_ENTRIES_ESSENTIAL', 'writeSafetyBackupBeforeMove', 'dataEntryFiles', 'assertSameDataEntry',
  'moveDataContents', 'readImagesDirFrom', 'dataLocationConfigPath', 'readDataLocationConfig', 'writeDataLocationConfig'];

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-move-'));
  const userData = path.join(root, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const logs = [];
  const imagesDirSetting = { loaded: false, dir: null };
  const app = { getPath: () => userData };
  const api = loadMain(NAMES, {
    fs: overrides.fs || fs, path, app, imagesDirSetting,
    logError: (c, e) => logs.push(c + ': ' + (e?.message || e)), logInfo: (c, m) => logs.push(c + ': ' + m)
  });
  return { root, userData, logs, imagesDirSetting, ...api };
}

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
// Typická složka dat: deník, obrázek, konektor (klíč, exekuce, screenshot), AI export, nastavení, protokol.
function seed(dir, extra = {}) {
  write(path.join(dir, 'journal-data', 'journal_a.json'), '{"trades":[{"id":"t1"}]}');
  write(path.join(dir, 'journal-data', 'images', 'a.webp'), 'IMG-A');
  write(path.join(dir, 'trade-capture', 'settings.json'), '{"apiKey":"KEY-123","accountMap":{"Sim101":"j1"}}');
  write(path.join(dir, 'trade-capture', 'events.json'), '[{"id":"e1"}]');
  write(path.join(dir, 'trade-capture', 'screenshots', 's.png'), 'SHOT');
  write(path.join(dir, 'ai-export', 'index.json'), '{"journals":[{"id":"j1","mode":"BACKTEST"}]}');
  write(path.join(dir, 'ai-export', 'journal_a.json'), '{}');
  write(path.join(dir, 'backup-settings.json'), JSON.stringify({ autoBackup: true, ...extra }));
  write(path.join(dir, 'futures-journal-error.log'), 'old log\n');
  return dir;
}
// Obsah složky jako { relativní cesta: text } – pro porovnání před/po.
function snapshot(dir) {
  const out = {};
  const walk = (abs, rel) => {
    if (!fs.existsSync(abs)) return;
    if (!fs.statSync(abs).isDirectory()) { out[rel] = fs.readFileSync(abs, 'utf8'); return; }
    for (const n of fs.readdirSync(abs)) walk(path.join(abs, n), rel ? rel + '/' + n : n);
  };
  walk(dir, '');
  return out;
}

test('běžný přesun: vše je v nové složce beze změny, ukazatel přepnutý, stará složka uklizená', () => {
  const s = setup();
  const oldDir = seed(path.join(s.root, 'old'));
  const before = snapshot(oldDir);
  const newDir = path.join(s.root, 'E', 'FuturesJournalPRO-Data');
  s.moveDataContents(oldDir, newDir, () => s.writeDataLocationConfig(newDir));
  assert.deepEqual(snapshot(newDir), before);
  assert.equal(s.readDataLocationConfig().customDataDir, newDir);
  for (const name of s.DATA_ENTRIES) assert.equal(fs.existsSync(path.join(oldDir, name)), false, name);
  // Pojistná záloha: deník, klíč konektoru, nastavení, manifest AI exportu – bez obrázků a screenshotů.
  const backups = fs.readdirSync(path.join(s.userData, 'safety-backups'));
  assert.equal(backups.length, 1);
  const backup = snapshot(path.join(s.userData, 'safety-backups', backups[0]));
  assert.deepEqual(Object.keys(backup).sort(), ['ai-export/index.json', 'backup-settings.json', 'journal-data/journal_a.json', 'trade-capture/events.json', 'trade-capture/settings.json']);
});

test('zápis ukazatele selže: ze staré složky se nic nesmaže a z cíle zmizí rozpracovaná kopie', () => {
  const s = setup();
  const oldDir = seed(path.join(s.root, 'old'));
  const before = snapshot(oldDir);
  const newDir = path.join(s.root, 'E', 'FuturesJournalPRO-Data');
  assert.throws(() => s.moveDataContents(oldDir, newDir, () => { throw new Error('EPERM data-location.json'); }), /EPERM/);
  assert.deepEqual(snapshot(oldDir), before);
  assert.equal(fs.existsSync(newDir), false);
  assert.equal(s.readDataLocationConfig().customDataDir, undefined);
});

test('kopie nesedí (jiná velikost): přesun se zastaví před přepnutím, nic se nesmaže', () => {
  const realFs = fs;
  // cpSync zkrátí jeden soubor – simulace vadné kopie (plný disk, síťová složka).
  const brokenFs = { ...realFs, cpSync: (src, dest, opts) => { realFs.cpSync(src, dest, opts); const f = path.join(dest, 'journal_a.json'); if (realFs.existsSync(f)) realFs.writeFileSync(f, '{'); } };
  const s = setup({ fs: brokenFs });
  const oldDir = seed(path.join(s.root, 'old'));
  const before = snapshot(oldDir);
  const newDir = path.join(s.root, 'E', 'FuturesJournalPRO-Data');
  let switched = false;
  assert.throws(() => s.moveDataContents(oldDir, newDir, () => { switched = true; }), /nesedí/);
  assert.equal(switched, false);
  assert.deepEqual(snapshot(oldDir), before);
  assert.equal(fs.existsSync(newDir), false);
});

test('cíl už má data deníku: odmítnuto, obě složky beze změny, bez zálohy', () => {
  const s = setup();
  const oldDir = seed(path.join(s.root, 'old'));
  const newDir = seed(path.join(s.root, 'E', 'FuturesJournalPRO-Data'));
  write(path.join(newDir, 'journal-data', 'journal_other.json'), '{"trades":[{"id":"jiny"}]}');
  const beforeOld = snapshot(oldDir), beforeNew = snapshot(newDir);
  assert.throws(() => s.moveDataContents(oldDir, newDir, () => assert.fail('nepřepnout')), /už jsou data deníku/);
  assert.deepEqual(snapshot(oldDir), beforeOld);
  assert.deepEqual(snapshot(newDir), beforeNew);
  assert.equal(fs.existsSync(path.join(s.userData, 'safety-backups')), false);
});

test('cíl má jen protokol a starý AI export: přesun projde, starý protokol se odloží', () => {
  const s = setup();
  const oldDir = seed(path.join(s.root, 'old'));
  const newDir = path.join(s.root, 'E', 'FuturesJournalPRO-Data');
  write(path.join(newDir, 'futures-journal-error.log'), 'target log\n');
  write(path.join(newDir, 'ai-export', 'stary.json'), '{}');
  s.moveDataContents(oldDir, newDir, () => s.writeDataLocationConfig(newDir));
  assert.equal(fs.readFileSync(path.join(newDir, 'futures-journal-error.log'), 'utf8'), 'old log\n');
  assert.ok(fs.readdirSync(newDir).some(n => n.startsWith('futures-journal-error.log.predchozi-')));
  assert.equal(fs.existsSync(path.join(newDir, 'ai-export', 'stary.json')), false);
  assert.ok(fs.existsSync(path.join(newDir, 'ai-export', 'index.json')));
});

test('pojistná záloha selže: přesun se vůbec nespustí', () => {
  const realFs = fs;
  const s = setup({ fs: { ...realFs, cpSync: (src, dest, opts) => { if (dest.includes('safety-backups')) throw new Error('ENOSPC'); realFs.cpSync(src, dest, opts); } } });
  const oldDir = seed(path.join(s.root, 'old'));
  const before = snapshot(oldDir);
  const newDir = path.join(s.root, 'E', 'FuturesJournalPRO-Data');
  assert.throws(() => s.moveDataContents(oldDir, newDir, () => assert.fail('nepřepnout')), /ENOSPC/);
  assert.deepEqual(snapshot(oldDir), before);
  assert.equal(fs.existsSync(newDir), false);
});

test('návrat na výchozí: ukazatel zmizí až po ověřené kopii; zbytky dat ve výchozí složce = odmítnuto', () => {
  const s = setup();
  const custom = seed(path.join(s.root, 'E', 'FuturesJournalPRO-Data'));
  s.writeDataLocationConfig(custom);
  const drop = () => fs.rmSync(s.dataLocationConfigPath(), { force: true });
  // Zbytek z běhu „Pokračovat s výchozí": deník ve výchozí složce se nepřepíše.
  write(path.join(s.userData, 'journal-data', 'journal_tmp.json'), '{"trades":[]}');
  assert.throws(() => s.moveDataContents(custom, s.userData, drop), /už jsou data deníku/);
  assert.equal(s.readDataLocationConfig().customDataDir, custom);
  fs.rmSync(path.join(s.userData, 'journal-data'), { recursive: true });
  const before = snapshot(custom);
  s.moveDataContents(custom, s.userData, drop);
  assert.equal(fs.existsSync(s.dataLocationConfigPath()), false);
  const after = snapshot(s.userData);
  for (const [rel, text] of Object.entries(before)) assert.equal(after[rel], text, rel);
});

test('vlastní složka obrázků uvnitř přesouvaných dat se přesměruje na nové místo', () => {
  const s = setup();
  const oldDir = path.join(s.root, 'old');
  const ownImages = path.join(oldDir, 'journal-data', 'moje-obrazky');
  seed(oldDir, { imagesDir: ownImages });
  write(path.join(ownImages, 'b.webp'), 'IMG-B');
  const newDir = path.join(s.root, 'E', 'FuturesJournalPRO-Data');
  s.moveDataContents(oldDir, newDir, () => s.writeDataLocationConfig(newDir));
  const moved = path.join(newDir, 'journal-data', 'moje-obrazky');
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'backup-settings.json'), 'utf8')).imagesDir, moved);
  assert.equal(s.imagesDirSetting.dir, moved);
  assert.equal(fs.readFileSync(path.join(moved, 'b.webp'), 'utf8'), 'IMG-B');
});

test('vlastní složka obrázků mimo data zůstane, jak je', () => {
  const s = setup();
  const outside = path.join(s.root, 'obrazky');
  const oldDir = seed(path.join(s.root, 'old'), { imagesDir: outside });
  const newDir = path.join(s.root, 'E', 'FuturesJournalPRO-Data');
  s.moveDataContents(oldDir, newDir, () => s.writeDataLocationConfig(newDir));
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'backup-settings.json'), 'utf8')).imagesDir, outside);
  assert.equal(s.imagesDirSetting.loaded, false);
});

test('nová složka uvnitř přesouvaných dat se odmítne', () => {
  const s = setup();
  const oldDir = seed(path.join(s.root, 'old'));
  const before = snapshot(oldDir);
  assert.throws(() => s.moveDataContents(oldDir, path.join(oldDir, 'journal-data', 'FuturesJournalPRO-Data'), () => {}), /uvnitř přesouvaných dat/);
  assert.deepEqual(snapshot(oldDir), before);
});

test('přesun je synchronní – během něj hlavní proces nevyřídí žádný jiný zápis', () => {
  const s = setup();
  const oldDir = seed(path.join(s.root, 'old'));
  const newDir = path.join(s.root, 'E', 'FuturesJournalPRO-Data');
  const result = s.moveDataContents(oldDir, newDir, () => s.writeDataLocationConfig(newDir));
  assert.ok(Array.isArray(result), 'vrací seznam, ne Promise');
  assert.doesNotMatch(String(s.moveDataContents), /\bawait\b|fs\.promises|\.then\(/);
});
