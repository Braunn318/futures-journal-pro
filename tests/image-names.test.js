'use strict';
// Obrázky mimo aplikaci (4.8.7): čitelná jména podle obchodu, jednorázový
// převod jmen „otisk obsahu“ → „2026-10-16_1428_MES_long_1.webp“, vlastní
// složka obrázků a záloha bez obrázků.
//
// Převod přejmenovává reálné, nenahraditelné screenshoty, proto se hlídá:
//  - každý odkaz v každém deníku míří po převodu na existující soubor se
//    stejným obsahem jako před ním,
//  - před zápisem je záloha každého dotčeného deníku,
//  - nečitelný deník = nic se nemění; druhý běh nic nedělá,
//  - obrázek sdílený dvěma záznamy (i ve dvou denících) zůstane jeden soubor,
//  - starý odkaz (záloha z doby před převodem) se dál najde,
//  - přesun složky nic nepřepíše a při konfliktu nic nesmaže.

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
  'imageBaseFor', 'sameFileContent', 'freeImageName', 'moveImageFile', 'journalImageOwners', 'journalFiles', 'imageUsedElsewhere',
  'assignImageNames', 'remapRenamedImages', 'nameStoredImages',
  'safeJournalId', 'journalPath', 'writeJournalFile',
  'backupIncludesImages', 'listImageFiles', 'imagesLocationInfo', 'moveImagesDir'
];

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-names-'));
  const data = path.join(root, 'journal-data');
  fs.mkdirSync(data, { recursive: true });
  let settings = {};
  const backups = [];
  const api = loadMain(NAMES, {
    fs, path, crypto, Buffer, URL,
    dataRoot: () => data,
    readSettings: () => ({ ...settings }),
    writeSettings: next => { settings = JSON.parse(JSON.stringify(next)); },
    backupJournalFile: (id, reason) => { backups.push([id, reason, fs.readFileSync(path.join(data, `${id}.json`), 'utf8')]); return { ok: true }; },
    logInfo: () => {}, logError: () => {},
    // Pojistku proti složce programu hlídá data-location.test.js.
    isInsideInstallDir: () => false, INSTALL_DIR_ERROR: ''
  });
  const writeJournal = (id, j) => fs.writeFileSync(path.join(data, `${id}.json`), JSON.stringify(j));
  const readJournal = id => JSON.parse(fs.readFileSync(path.join(data, `${id}.json`), 'utf8'));
  return { root, data, api, backups, writeJournal, readJournal, settings: () => settings };
}
const png = seed => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2048, String(seed))]).toString('base64')}`;
const plain = v => JSON.parse(JSON.stringify(v));
const contentOf = (w, ref) => fs.readFileSync(w.api.imageRefPath(ref));

test('základ jména: obchod, setup bez vstupu, den; nebezpečné znaky pryč', () => {
  const { api } = world();
  assert.equal(api.imageBaseFor({ date: '2026-10-16', entryTime: '14:28', instrument: 'MES 12-26', side: 'long' }), '2026-10-16_1428_MES_long');
  assert.equal(api.imageBaseFor({ date: '2026-10-16', entryTime: '9:05', instrument: 'FDXS', side: '' }), '2026-10-16_0905_FDXS_obchod');
  assert.equal(api.imageBaseFor({ date: '2026-10-16', entryTime: '', instrument: '../../x', recordType: 'SETUP_ONLY' }), '2026-10-16_0000_x_setup');
  assert.equal(api.imageBaseFor({ date: '2026-10-16', day: true }), '2026-10-16_den');
  assert.equal(api.imageBaseFor({ date: 'neplatné' }), null);
  for (const name of ['2026-10-16_1428_MES_long_1.webp', 'a.png', 'abc_def-1.jpg']) assert.ok(api.IMAGE_NAME_RE.test(name), name);
  for (const name of ['../x.png', '.x.png', 'a/b.png', 'a\\b.png', 'a..b.png', 'x.png.', 'x']) assert.equal(api.IMAGE_NAME_RE.test(name), false, name);
});

test('převod: čitelná jména ve všech denících, stejný obsah, zálohy, sdílený soubor zůstane jeden', () => {
  const w = world();
  const shared = w.api.storeImageDataUrl(png('shared'));
  const a = w.api.storeImageDataUrl(png('a'));
  const day = w.api.storeImageDataUrl(png('day'));
  const before = { shared: contentOf(w, shared), a: contentOf(w, a), day: contentOf(w, day) };
  w.writeJournal('j1', {
    trades: [{ id: 't1', date: '2026-10-16', entryTime: '14:28', instrument: 'MES', side: 'long', images: [a, shared], legs: [{ images: [a] }] }],
    settings: [], dayNotes: { '2026-10-16': { comment: '', images: [day] } }
  });
  w.writeJournal('j2', { trades: [{ id: 'x', date: '2026-10-17', entryTime: '15:00', instrument: 'NQ', side: 'short', images: [shared] }], settings: [] });
  w.writeJournal('j3', { trades: [{ id: 'bez', instrument: 'ES' }], settings: [] });

  const r = w.api.nameStoredImages();
  assert.deepEqual(plain(r), { ok: true, renamed: 3 });
  const j1 = w.readJournal('j1'), j2 = w.readJournal('j2');
  assert.deepEqual(j1.trades[0].images, ['fjimg://store/2026-10-16_1428_MES_long_1.png', 'fjimg://store/2026-10-16_1428_MES_long_2.png']);
  assert.deepEqual(j1.trades[0].legs[0].images, ['fjimg://store/2026-10-16_1428_MES_long_1.png'], 'odkaz v noze se přepíše taky');
  assert.deepEqual(j1.dayNotes['2026-10-16'].images, ['fjimg://store/2026-10-16_den_1.png']);
  assert.deepEqual(j2.trades[0].images, ['fjimg://store/2026-10-16_1428_MES_long_2.png'], 'sdílený obrázek: jeden soubor, odkaz ve druhém deníku ukazuje na něj');
  assert.ok(contentOf(w, j1.trades[0].images[0]).equals(before.a));
  assert.ok(contentOf(w, j1.trades[0].images[1]).equals(before.shared));
  assert.ok(contentOf(w, j1.dayNotes['2026-10-16'].images[0]).equals(before.day));
  assert.deepEqual(w.backups.map(b => b[0]).sort(), ['j1', 'j2'], 'záloha jen dotčených deníků');
  assert.ok(w.backups.every(b => b[2].includes(path.basename(a)) || b[2].includes(path.basename(shared))), 'záloha je stav PŘED převodem');
  assert.equal(fs.readdirSync(w.api.imagesRoot()).filter(n => w.api.IMAGE_HASH_NAME_RE.test(n)).length, 0, 'staré soubory jsou pryč');
  // Starý odkaz (záloha z doby před převodem) se dál najde.
  assert.ok(w.api.imageToBuffer(a).buffer.equals(before.a));
  const old = { trades: [{ id: 't1', images: [a] }] };
  assert.equal(w.api.remapRenamedImages(old), 1);
  assert.deepEqual(old.trades[0].images, ['fjimg://store/2026-10-16_1428_MES_long_1.png']);
  // Druhý běh nic nedělá.
  assert.deepEqual(plain(w.api.nameStoredImages()), { ok: true, renamed: 0 });
});

test('převod: nečitelný deník = nic se nemění', () => {
  const w = world();
  const a = w.api.storeImageDataUrl(png('a'));
  w.writeJournal('j1', { trades: [{ id: 't1', date: '2026-10-16', entryTime: '14:28', instrument: 'MES', side: 'long', images: [a] }], settings: [] });
  fs.writeFileSync(path.join(w.data, 'j2.json'), '{ rozbitý');
  assert.deepEqual(plain(w.api.nameStoredImages()), { ok: false, renamed: 0 });
  assert.deepEqual(w.readJournal('j1').trades[0].images, [a]);
  assert.ok(fs.existsSync(w.api.imageRefPath(a)));
  assert.equal(w.backups.length, 0);
});

test('uložení obchodu: nový obrázek dostane jméno, po změně času se přejmenuje, sdílený se zkopíruje', () => {
  const w = world();
  const pasted = w.api.storeImageDataUrl(png('p'));
  const rec = { date: '2026-10-16', entryTime: '14:28', instrument: 'MES', side: 'long' };
  const m1 = plain(w.api.assignImageNames([pasted], rec, { journalId: 'j1', key: 't1' }));
  const named = m1[pasted];
  assert.equal(named, 'fjimg://store/2026-10-16_1428_MES_long_1.png');
  assert.equal(fs.existsSync(path.join(w.api.imagesRoot(), path.basename(pasted))), false, 'nikde jinde nepoužitý – přejmenován, ne zkopírován');
  w.writeJournal('j1', { trades: [{ id: 't1', ...rec, images: [named] }], settings: [] });
  // Beze změny se nic neděje.
  assert.deepEqual(plain(w.api.assignImageNames([named], rec, { journalId: 'j1', key: 't1' })), {});
  // Změna času vstupu.
  const moved = plain(w.api.assignImageNames([named], { ...rec, entryTime: '14:35' }, { journalId: 'j1', key: 't1' }));
  assert.equal(moved[named], 'fjimg://store/2026-10-16_1435_MES_long_1.png');
  assert.equal(fs.existsSync(path.join(w.api.imagesRoot(), '2026-10-16_1428_MES_long_1.png')), false);
  assert.ok(w.api.imageToBuffer(named), 'starý odkaz se dál najde (tabulka přejmenování)');
  // Obrázek, na který odkazuje i jiný záznam, se zkopíruje.
  const now = moved[named];
  w.writeJournal('j1', { trades: [{ id: 't1', ...rec, entryTime: '14:35', images: [now] }, { id: 't2', images: [now] }], settings: [] });
  const copy = plain(w.api.assignImageNames([now], { ...rec, entryTime: '15:00' }, { journalId: 'j1', key: 't1' }));
  assert.equal(copy[now], 'fjimg://store/2026-10-16_1500_MES_long_1.png');
  assert.ok(fs.existsSync(w.api.imageRefPath(now)), 'originál zůstal pro t2');
});

test('jiný obrázek se stejným jménem se nepřepíše, stejný obrázek se znovu nekopíruje', () => {
  const w = world();
  const rec = { date: '2026-10-16', entryTime: '14:28', instrument: 'MES', side: 'long' };
  const a = w.api.storeImageDataUrl(png('a'));
  const first = plain(w.api.assignImageNames([a], rec, null))[a];
  const b = w.api.storeImageDataUrl(png('b'));
  const second = plain(w.api.assignImageNames([b], rec, null))[b];
  assert.equal(second, 'fjimg://store/2026-10-16_1428_MES_long_2.png', 'obsazené jméno s jiným obsahem → další číslo');
  const again = w.api.storeImageDataUrl(png('a'));
  assert.equal(plain(w.api.assignImageNames([again], rec, null))[again], first, 'tentýž screenshot (sdílený nohami pozice) = tentýž soubor');
});

test('složka obrázků: přesun i s náhledy, odkazy dál platí; konflikt nic nesmaže', () => {
  const w = world();
  const a = w.api.storeImageDataUrl(png('a'));
  fs.mkdirSync(w.api.thumbsRoot(), { recursive: true });
  fs.writeFileSync(w.api.thumbPath(path.basename(a)), 'thumb');
  const target = path.join(w.root, 'jinde', 'obrazky');
  const r = plain(w.api.moveImagesDir(target));
  assert.equal(r.ok, true);
  assert.equal(w.api.imagesRoot(), path.resolve(target));
  assert.equal(w.settings().imagesDir, path.resolve(target));
  assert.ok(fs.existsSync(path.join(target, path.basename(a))));
  assert.ok(fs.existsSync(path.join(target, '_nahledy', `${path.basename(a)}.thumb.webp`)));
  assert.equal(fs.existsSync(path.join(w.data, 'images', path.basename(a))), false, 'stará kopie smazaná');
  assert.ok(w.api.imageToBuffer(a), 'odkaz v deníku se nemění a platí');
  assert.equal(plain(w.api.imagesLocationInfo()).count, 1, 'náhledy se do počtu nepočítají');

  // Konflikt: v cíli je jiný soubor stejného jména.
  const other = path.join(w.root, 'konflikt');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, path.basename(a)), 'jiný obsah');
  assert.throws(() => w.api.moveImagesDir(other), /stejným jménem/);
  assert.ok(fs.existsSync(path.join(target, path.basename(a))), 'nic se nesmazalo');
  assert.equal(w.api.imagesRoot(), path.resolve(target));
  // Zpět do výchozí.
  assert.equal(plain(w.api.moveImagesDir(path.join(w.data, 'images'))).ok, true);
  assert.equal(w.settings().imagesDir, undefined);
  assert.ok(w.api.imageToBuffer(a));
});

test('záloha: obrázky jen se zapnutým přepínačem (výchozí vypnuto)', () => {
  const w = world();
  assert.equal(w.api.backupIncludesImages(), false);
  const main = loadMain(['backupIncludesImages'], { readSettings: () => ({ backupIncludeImages: true }) });
  assert.equal(main.backupIncludesImages(), true);
});

test('odkaz na náhled vede na plný obrázek (kopírovat / otevřít / uložit)', () => {
  const w = world();
  const a = w.api.storeImageDataUrl(png('a'));
  const thumb = a.replace('fjimg://store/', 'fjimg://thumb/');
  assert.equal(w.api.storeRefOf(thumb), a);
  assert.ok(w.api.imageToBuffer(thumb).buffer.equals(contentOf(w, a)));
});
