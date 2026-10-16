'use strict';
// Robustnost zálohy (4.8.9): záloha ve dvou částech – obchody (JSON) a obrázky
// (zrcadlo vedle zálohy).
//
// Proč to existuje: po aktualizaci 4.8.8 se ztratily všechny screenshoty (781
// odkazů, 0 souborů). Data ležela ve složce programu, instalátor ji smazal,
// deníky se vrátily ze zálohy, ale ta nesla jen odkazy – obrázky nebyly
// zálohované nikde. Tady se ta ztráta přehrává a hlídají se další cesty, jak
// o data přijít: záloha spuštěná až po ztrátě, nečitelný deník, přerušená
// kopie, přepsání dobré zálohy prázdným deníkem, záloha ve složce programu.
//
// Testují se skutečné funkce z main.js nad skutečným souborovým systémem
// v dočasné složce.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { loadMain } = require('./helpers/extract');

const NAMES = [
  'IMAGE_SCHEME', 'IMAGE_REF_PREFIX', 'IMAGE_NAME_RE', 'IMAGE_HASH_NAME_RE', 'IMAGE_CONTENT_TYPES',
  'imagesDirSetting', 'imagesRoot', 'THUMB_DIR', 'thumbsRoot', 'thumbPath', 'IMAGE_RENAME_FILE', 'readImageRenames', 'writeImageRenames',
  'isImageRef', 'imageRefName', 'imageRefPath', 'storeRefOf', 'imageExtension',
  'dataUrlToBuffer', 'storeImageBuffer', 'storeImageDataUrl', 'imageToBuffer', 'imageToDataUrl', 'mapImageStrings',
  'deflateJournalImages', 'inflateJournalImages',
  'imageBaseFor', 'sameFileContent', 'freeImageName', 'moveImageFile', 'journalImageOwners', 'journalFiles', 'nameStoredImages',
  'safeJournalId', 'journalPath', 'writeJournalFile',
  'installDir', 'isInsideInstallDir', 'INSTALL_DIR_ERROR',
  'backupIncludesImages', 'buildJournalsBackup', 'restoreJournalsBackup',
  'BACKUP_MANIFEST_FILE', 'BACKUP_KEEP_PREVIOUS', 'backupMirrorsImages', 'defaultBackupImagesDir', 'backupImagesDirPath',
  'referencedImageNames', 'readBackupManifest', 'fileSha256', 'copyFileChecked', 'mirrorImagesToBackup',
  'restoreImagesFromMirror', 'imageIntegrityReport', 'countBackupTrades', 'rotatePreviousBackup', 'saveJournalsBackupTo'
];

// Celý „počítač": instalace programu, datová složka, SSD se zálohou.
function world({ fsImpl = fs, root: givenRoot, settings: givenSettings } = {}) {
  const root = givenRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'fj-robust-'));
  const inst = path.join(root, 'Programme', 'Futures Journal PRO');
  const data = path.join(root, 'FuturesJournalPRO-Data', 'journal-data');
  const ssd = path.join(root, 'SSD');
  for (const d of [inst, data, ssd]) fs.mkdirSync(d, { recursive: true });
  const state = { settings: givenSettings || {} };
  const api = loadMain(NAMES, {
    fs: fsImpl, path, crypto, Buffer, URL,
    app: { isPackaged: true, getPath: () => path.join(inst, 'Futures Journal PRO.exe') },
    process: { env: {} },
    dataRoot: () => data,
    readSettings: () => JSON.parse(JSON.stringify(state.settings)),
    writeSettings: next => { state.settings = JSON.parse(JSON.stringify(next)); },
    backupJournalFile: () => ({ ok: true }),
    logInfo: () => {}, logError: () => {},
    // Zjednodušené čtení / zápis deníku: migrace v readJournal hlídají jiné testy.
    readJournal: id => {
      const file = path.join(data, `${id}.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { trades: [], settings: [], dayNotes: {} };
    },
    writeJournal: (id, j) => { fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, `${id}.json`), JSON.stringify(j)); }
  });
  const backupPath = path.join(ssd, 'FuturesJournal_AKTUALNI_ZALOHA.json');
  state.settings.backupPath ||= backupPath;
  const meta = { activeJournalId: 'j1', profiles: [{ id: 'j1', name: 'Phidias' }, { id: 'j2', name: 'Backtest' }] };
  return { root, inst, data, ssd, api, state, backupPath, meta, mirror: `${backupPath.slice(0, -5)}_obrazky` };
}
const png = seed => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4096 + String(seed).length, String(seed))]).toString('base64')}`;
const writeJ = (w, id, j) => fs.writeFileSync(path.join(w.data, `${id}.json`), JSON.stringify(j));
const readJ = (w, id) => JSON.parse(fs.readFileSync(path.join(w.data, `${id}.json`), 'utf8'));

// Dva deníky: obchod se dvěma obrázky, obrázek u cíle, obrázek sdílený oběma
// deníky, den s obrázkem; obrázky s čitelnými jmény (nameStoredImages).
function seed(w) {
  const [a, b, leg, shared, day] = ['a', 'b', 'leg', 'shared', 'day'].map(s => w.api.storeImageDataUrl(png(s)));
  writeJ(w, 'j1', {
    trades: [
      { id: 't1', date: '2026-10-16', entryTime: '14:28', instrument: 'MES', side: 'long', images: [a, shared], legs: [{ images: [leg] }] },
      { id: 't2', date: '2026-10-16', entryTime: '15:02', instrument: 'MES', side: 'short', images: [b] }
    ],
    settings: [], dayNotes: { '2026-10-16': { comment: 'den', images: [day] } }
  });
  writeJ(w, 'j2', { trades: [{ id: 'x1', date: '2026-10-15', entryTime: '09:30', instrument: 'MNQ', side: 'long', images: [shared] }], settings: [], dayNotes: {} });
  w.api.nameStoredImages();
  return snapshot(w);
}
// Obsah každého odkazovaného obrázku: { jméno: sha256 }.
function snapshot(w) {
  const out = {};
  for (const name of Object.keys(w.api.referencedImageNames())) {
    const file = w.api.imageRefPath(w.api.IMAGE_REF_PREFIX + name);
    out[name] = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
  }
  return out;
}
const restoreFromSsd = w => w.api.restoreJournalsBackup(fs.readFileSync(w.backupPath, 'utf8'), w.backupPath);

test('přehrání incidentu: smazaná celá datová složka → obnova vrátí deníky i všechny obrázky bajtově shodné', () => {
  const w = world();
  const before = seed(w);
  assert.equal(Object.keys(before).length, 5);
  const r = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.equal(r.images.total, 5);
  assert.equal(r.images.copied, 5);
  assert.ok(fs.existsSync(path.join(w.mirror, w.api.BACKUP_MANIFEST_FILE)));
  const backup = JSON.parse(fs.readFileSync(w.backupPath, 'utf8'));
  assert.equal(backup.imagesBackup.dir, w.mirror);
  assert.equal(backup.imagesBackup.count, 5);

  // Aktualizace smaže složku programu i s daty uvnitř.
  fs.rmSync(path.dirname(w.data), { recursive: true, force: true });
  w.api.imagesDirSetting.loaded = false;

  const restored = restoreFromSsd(w);
  assert.equal(restored.restoredImages, 5);
  assert.equal(restored.missingImages, 0);
  assert.deepEqual(snapshot(w), before);
  assert.equal(readJ(w, 'j1').trades.length, 2);
  assert.equal(readJ(w, 'j1').dayNotes['2026-10-16'].comment, 'den');
});

test('záloha spuštěná až po ztrátě obrázků nepřijde o jejich zálohu; doplnění pak vrátí vše', () => {
  const w = world();
  const before = seed(w);
  w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  fs.rmSync(w.api.imagesRoot(), { recursive: true, force: true });

  const r = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.equal(r.images.missingInSource, 5);
  assert.equal(r.images.removed, 0);
  assert.equal(r.images.total, 5);
  for (const name of Object.keys(before)) assert.ok(fs.existsSync(path.join(w.mirror, name)), name);

  const report = w.api.imageIntegrityReport();
  assert.deepEqual([report.refs, report.missing, report.recoverable], [5, 5, 5]);
  assert.equal(w.api.restoreImagesFromMirror(w.mirror).restored, 5);
  assert.deepEqual(snapshot(w), before);
  assert.equal(w.api.imageIntegrityReport().missing, 0);
});

test('smazaný obchod: jeho obrázek ze zálohy zmizí, sdílený obrázek zůstane', () => {
  const w = world();
  seed(w);
  w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  const j1 = readJ(w, 'j1');
  const gone = w.api.imageRefName(j1.trades[1].images[0]);
  const shared = w.api.imageRefName(j1.trades[0].images[1]);
  // Smazání t1 (sdílený obrázek dál používá j2) i t2.
  writeJ(w, 'j1', { ...j1, trades: [] });
  const r = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.equal(fs.existsSync(path.join(w.mirror, gone)), false);
  assert.equal(fs.existsSync(path.join(w.mirror, shared)), true);
  assert.equal(r.images.removed, 3);
  assert.equal(r.images.total, 2);
  assert.ok(fs.existsSync(path.join(w.mirror, w.api.BACKUP_MANIFEST_FILE)));
});

test('nečitelný deník: ze zálohy obrázků se nic nesmaže a soubor zálohy se nepřepíše', () => {
  const w = world();
  seed(w);
  w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  const json = fs.readFileSync(w.backupPath, 'utf8');
  const files = fs.readdirSync(w.mirror).sort();
  fs.writeFileSync(path.join(w.data, 'j2.json'), '{ rozbitý');
  assert.throws(() => w.api.saveJournalsBackupTo(w.backupPath, w.meta), /nejde přečíst/);
  assert.equal(fs.readFileSync(w.backupPath, 'utf8'), json);
  assert.deepEqual(fs.readdirSync(w.mirror).sort(), files);
});

test('přerušená kopie obrázku: předchozí záloha beze změny, nic smazáno', () => {
  let calls = 0, armed = false;
  const flaky = { ...fs, copyFileSync: (a, b) => { if (armed && ++calls === 2) throw new Error('disk odpojen'); return fs.copyFileSync(a, b); } };
  const w = world({ fsImpl: flaky });
  seed(w);
  w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  const json = fs.readFileSync(w.backupPath, 'utf8');
  const files = fs.readdirSync(w.mirror).sort();
  // Dva nové obrázky; druhá kopie selže.
  const j1 = readJ(w, 'j1');
  j1.trades[1].images.push(w.api.storeImageDataUrl(png('novy-1')), w.api.storeImageDataUrl(png('novy-2')));
  writeJ(w, 'j1', j1);
  armed = true;
  assert.throws(() => w.api.saveJournalsBackupTo(w.backupPath, w.meta), /disk odpojen/);
  assert.equal(fs.readFileSync(w.backupPath, 'utf8'), json);
  for (const f of files) assert.ok(fs.existsSync(path.join(w.mirror, f)), f);
  assert.equal(fs.readdirSync(w.mirror).some(f => f.endsWith('.tmp')), false);
  // Příští záloha dokončí zbytek.
  armed = false;
  const r = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.equal(r.images.total, 7);
});

test('prázdný deník po ztrátě nepřepíše dobrou zálohu nadobro: předchozí verze zůstávají, max. 3', () => {
  const w = world();
  seed(w);
  w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  const good = fs.readFileSync(w.backupPath, 'utf8');
  // Opakovaná záloha beze změny nic neotáčí.
  assert.equal(w.api.saveJournalsBackupTo(w.backupPath, w.meta).rotated, false);
  writeJ(w, 'j1', { trades: [], settings: [], dayNotes: {} });
  writeJ(w, 'j2', { trades: [], settings: [], dayNotes: {} });
  const r = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.equal(r.rotated, true);
  assert.deepEqual([r.tradesBefore, r.tradesAfter], [3, 0]);
  const prev = n => path.join(w.ssd, `FuturesJournal_AKTUALNI_ZALOHA_predchozi-${n}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(prev(1), 'utf8')).journals, JSON.parse(good).journals);
  for (let i = 0; i < 4; i++) {
    writeJ(w, 'j2', { trades: Array.from({ length: i + 1 }, (_, k) => ({ id: `n${k}` })), settings: [], dayNotes: {} });
    w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  }
  assert.ok(fs.existsSync(prev(3)));
  assert.equal(fs.existsSync(prev(4)), false);
  assert.equal(fs.readdirSync(w.ssd).some(f => f.endsWith('.tmp')), false);
});

test('obnova na čistém počítači s vlastní složkou obrázků', () => {
  const w = world();
  const before = seed(w);
  w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  const fresh = world({ settings: { imagesDir: path.join(os.tmpdir(), `fj-own-images-${Date.now()}`) } });
  fs.copyFileSync(w.backupPath, fresh.backupPath);
  fs.cpSync(w.mirror, fresh.mirror, { recursive: true });
  // Záloha uvádí původní složku; když na novém stroji neexistuje, hledá se vedle souboru.
  fs.rmSync(w.mirror, { recursive: true, force: true });
  const r = restoreFromSsd(fresh);
  assert.equal(r.restoredImages, 5);
  assert.equal(r.missingImages, 0);
  assert.ok(fresh.api.imagesRoot().startsWith(path.join(os.tmpdir(), 'fj-own-images-')));
  assert.deepEqual(snapshot(fresh), before);
});

test('záloha ani záloha obrázků ve složce programu: odmítnuto, nic nezapsáno', () => {
  const w = world();
  seed(w);
  const inside = path.join(w.inst, 'zaloha.json');
  assert.throws(() => w.api.saveJournalsBackupTo(inside, w.meta), /složky programu/);
  assert.equal(fs.existsSync(inside), false);
  w.state.settings.backupImagesDir = path.join(w.inst, 'obrazky');
  assert.throws(() => w.api.saveJournalsBackupTo(w.backupPath, w.meta), /složky programu/);
  assert.equal(fs.existsSync(path.join(w.inst, 'obrazky')), false);
  assert.equal(fs.existsSync(w.backupPath), false);
});

test('opakovaná záloha beze změny nic nekopíruje ani nemaže; změněný obsah se zkopíruje znovu', () => {
  const w = world();
  seed(w);
  w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  const again = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.deepEqual([again.images.copied, again.images.removed, again.images.total], [0, 0, 5]);
  const name = Object.keys(w.api.referencedImageNames())[0];
  const src = w.api.imageRefPath(w.api.IMAGE_REF_PREFIX + name);
  fs.writeFileSync(src, Buffer.alloc(5000, 'z'));
  const changed = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.equal(changed.images.copied, 1);
  assert.ok(fs.readFileSync(path.join(w.mirror, name)).equals(fs.readFileSync(src)));
});

test('vypnutá záloha obrázků: jen JSON, žádná složka', () => {
  const w = world();
  seed(w);
  w.state.settings.backupImagesMirror = false;
  const r = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.equal(r.images, null);
  assert.equal(fs.existsSync(w.mirror), false);
  assert.equal(JSON.parse(fs.readFileSync(w.backupPath, 'utf8')).imagesBackup, null);
});

test('vlastní složka zálohy obrázků má přednost před složkou vedle zálohy', () => {
  const w = world();
  seed(w);
  const own = path.join(w.root, 'Cloud', 'obrazky');
  w.state.settings.backupImagesDir = own;
  const r = w.api.saveJournalsBackupTo(w.backupPath, w.meta);
  assert.equal(r.images.dir, own);
  assert.equal(fs.readdirSync(own).filter(f => !f.startsWith('_')).length, 5);
  assert.equal(fs.existsSync(w.mirror), false);
});
