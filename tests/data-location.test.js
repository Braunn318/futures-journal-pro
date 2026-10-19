'use strict';
// Umístění dat vůči složce programu (4.8.9).
//
// Proč to existuje: uživatel si data přesunul do
// E:\Programme\Futures Journal PRO\FuturesJournalPRO-Data, tedy dovnitř
// instalace. Aktualizace starou instalaci odinstalovala a smazala složku celou –
// i se screenshoty. Aplikace pak nenašla nastavenou složku a potichu přešla na
// AppData, takže to vypadalo, že se „cesta resetla".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMain } = require('./helpers/extract');

const NAMES = ['dataLocationConfigPath', 'readDataLocationConfig', 'writeDataLocationConfig', 'installDir', 'isInsideInstallDir', 'INSTALL_DIR_ERROR', 'dataDirState', 'checkDataLocationAtStartup'];

function setup({ answers = [], picks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-location-'));
  const inst = path.join(root, 'Programme', 'Futures Journal PRO');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(inst, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const shown = [];
  const app = {
    isPackaged: true,
    getPath: name => (name === 'exe' ? path.join(inst, 'Futures Journal PRO.exe') : userData),
    exit: () => { shown.push('exit'); }
  };
  const dialog = {
    showMessageBoxSync: opts => { shown.push(opts.message); return answers.length ? answers.shift() : 3; },
    showOpenDialogSync: () => (picks.length ? [picks.shift()] : undefined)
  };
  const api = loadMain(NAMES, { fs, path, app, dialog, process, logInfo: () => {} });
  return { root, inst, userData, shown, ...api };
}

test('složka uvnitř instalace se pozná, i s jinou velikostí písmen', () => {
  const s = setup();
  assert.equal(s.isInsideInstallDir(path.join(s.inst, 'FuturesJournalPRO-Data')), true);
  assert.equal(s.isInsideInstallDir(path.join(s.inst.toUpperCase(), 'data')), true);
  assert.equal(s.isInsideInstallDir(s.inst), true);
  assert.equal(s.isInsideInstallDir(path.join(s.root, 'FuturesJournalPRO-Data')), false);
  // Jen začátek jména není totéž co složka uvnitř.
  assert.equal(s.isInsideInstallDir(s.inst + ' Data'), false);
});

test('ve zdrojové verzi (bez instalace) se nic neodmítá', () => {
  const s = setup();
  const api = loadMain(['installDir', 'isInsideInstallDir'], { path, app: { isPackaged: false, getPath: () => s.inst }, process: { env: {} } });
  assert.equal(api.isInsideInstallDir(path.join(s.inst, 'data')), false);
});

test('přesun obrázků do složky programu se odmítne a nic se nezkopíruje', () => {
  const s = setup();
  const from = path.join(s.root, 'images');
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, 'a.png'), 'x');
  const target = path.join(s.inst, 'obrazky');
  const api = loadMain(['moveImagesDir'], {
    fs, path, imagesRoot: () => from,
    isInsideInstallDir: s.isInsideInstallDir, INSTALL_DIR_ERROR: s.INSTALL_DIR_ERROR
  });
  assert.throws(() => api.moveImagesDir(target), /složky programu/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(from, 'a.png')), true);
});

test('existující vlastní složka: žádný dialog', () => {
  const s = setup();
  const data = path.join(s.root, 'FuturesJournalPRO-Data');
  fs.mkdirSync(data);
  s.writeDataLocationConfig(data);
  assert.equal(s.checkDataLocationAtStartup(), true);
  assert.deepEqual(s.shown, []);
});

test('chybějící složka: „Pokračovat s výchozí" nechá ukazatel beze změny', () => {
  const s = setup({ answers: [2] });
  const missing = path.join(s.inst, 'FuturesJournalPRO-Data');
  s.writeDataLocationConfig(missing);
  assert.equal(s.checkDataLocationAtStartup(), true);
  assert.equal(s.shown.length, 1);
  assert.equal(s.readDataLocationConfig().customDataDir, missing);
  // Vědomá volba pro tenhle běh – resolveDataDir pak nehlásí chybějící složku.
  assert.equal(s.dataDirState.sessionDefault, true);
});

test('chybějící složka: „Vybrat složku" přijme nadřazenou složku s FuturesJournalPRO-Data', () => {
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-moved-'));
  fs.mkdirSync(path.join(moved, 'FuturesJournalPRO-Data', 'journal-data'), { recursive: true });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-empty-'));
  // Nejdřív složka bez dat (chyba, ptá se znovu), pak ta správná.
  const s = setup({ answers: [1, 0, 1], picks: [empty, moved] });
  s.writeDataLocationConfig(path.join(s.root, 'neni-tu'));
  assert.equal(s.checkDataLocationAtStartup(), true);
  assert.equal(s.readDataLocationConfig().customDataDir, path.join(moved, 'FuturesJournalPRO-Data'));
});

test('chybějící složka: „Ukončit" aplikaci ukončí a nic nezapíše', () => {
  const s = setup({ answers: [3] });
  const missing = path.join(s.root, 'neni-tu');
  s.writeDataLocationConfig(missing);
  assert.equal(s.checkDataLocationAtStartup(), false);
  assert.ok(s.shown.includes('exit'));
  assert.equal(s.readDataLocationConfig().customDataDir, missing);
});
