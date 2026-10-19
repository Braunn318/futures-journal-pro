'use strict';
// Složka dat zmizí za běhu (odpojený disk, spadlá síťová jednotka), 4.8.93.
//
// Proč to existuje: resolveDataDir při chybějící nastavené složce tiše přešel
// na výchozí userData. Obchody uložené mezitím pak po návratu disku nebyly
// vidět a konektor si v userData založil nové nastavení s NOVÝM API klíčem
// (2026-10-16 – tři dny se nic neimportovalo). Teď: zápis selže nahlas,
// zprávy konektoru se drží v záloze a po návratu se přehrají v pořadí.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMain } = require('./helpers/extract');

const NAMES = ['dataLocationConfigPath', 'readDataLocationConfig', 'writeDataLocationConfig', 'dataDirState', 'dataDirMissingError',
  'configuredDataDir', 'resolveDataDir', 'dataDirAvailable', 'logPath', 'settingsPath', 'readSettings', 'dataRoot', 'safeJournalId', 'journalPath',
  'writeJournalFile', 'imagesDirSetting', 'imagesRoot', 'captureSpoolDir', 'captureSpoolPath', 'captureSpool', 'spoolCapturePayload',
  'captureSpoolFiles', 'captureSpoolBusy', 'replayCaptureSpool', 'sendDataDirState', 'checkDataDirBack', 'findDataDirIn'];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-missing-'));
  const userData = path.join(root, 'userData');
  const custom = path.join(root, 'E', 'FuturesJournalPRO-Data');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(custom, 'journal-data'), { recursive: true });
  const logs = [];
  const processed = [];
  const api = loadMain(NAMES, {
    fs, path, process, setImmediate, mainWindow: null,
    app: { getPath: () => userData },
    logInfo: (c, m) => logs.push(`${c}: ${m}`),
    logError: (c, e) => logs.push(`${c}: ${e?.message || e}`),
    // Zpracování zprávy zapisuje do složky dat – bez ní hodí FJ_DATA_DIR_MISSING jako skutečný kód.
    processIncomingPayload: async (payload, source) => {
      const dir = api.resolveDataDir();
      fs.mkdirSync(path.join(dir, 'trade-capture'), { recursive: true });
      fs.appendFileSync(path.join(dir, 'trade-capture', 'events.jsonl'), JSON.stringify({ source, seq: payload.seq }) + '\n');
      processed.push(payload.seq);
      return { id: String(payload.seq) };
    }
  });
  api.writeDataLocationConfig(custom);
  const unplug = () => fs.renameSync(path.join(root, 'E'), path.join(root, 'E-odpojeno'));
  const plugIn = () => fs.renameSync(path.join(root, 'E-odpojeno'), path.join(root, 'E'));
  return { root, userData, custom, logs, processed, unplug, plugIn, ...api };
}

test('chybějící nastavená složka: žádný přechod na userData, zápis deníku selže a nic nevznikne', () => {
  const s = setup();
  assert.equal(s.resolveDataDir(), s.custom);
  s.unplug();
  assert.throws(() => s.resolveDataDir(), e => e.code === 'FJ_DATA_DIR_MISSING' && e.message.includes(s.custom));
  assert.throws(() => s.writeJournalFile('j1', { trades: [{ id: 't1' }] }), e => e.code === 'FJ_DATA_DIR_MISSING');
  assert.equal(fs.existsSync(path.join(s.userData, 'journal-data')), false);
  // Ani znovu vytvořená prázdná složka na místě odpojeného disku.
  assert.equal(fs.existsSync(s.custom), false);
  assert.equal(s.dataDirAvailable(), false);
});

test('oznámení o zmizení přijde jednou, ne při každém volání', () => {
  const s = setup();
  const seen = [];
  s.dataDirState.onMissing = dir => seen.push(dir);
  s.unplug();
  for (let i = 0; i < 5; i++) s.dataDirAvailable();
  assert.deepEqual(seen, [s.custom]);
});

test('protokol jde i bez složky dat – do userData, jen pro diagnostiku', () => {
  const s = setup();
  assert.equal(s.logPath(), path.join(s.custom, 'futures-journal-error.log'));
  s.unplug();
  assert.equal(s.logPath(), path.join(s.userData, 'futures-journal-error.log'));
});

test('„Pokračovat s výchozí" při startu: tenhle běh vědomě jede z userData', () => {
  const s = setup();
  s.unplug();
  s.dataDirState.sessionDefault = true;
  assert.equal(s.resolveDataDir(), s.userData);
  // I když se disk mezitím vrátí – běh zůstává u jedné složky.
  s.plugIn();
  assert.equal(s.resolveDataDir(), s.userData);
});

test('složka obrázků se při chybějící složce dat nezapamatuje špatně', () => {
  const s = setup();
  const own = path.join(s.root, 'obrazky');
  fs.writeFileSync(path.join(s.custom, 'backup-settings.json'), JSON.stringify({ imagesDir: own }));
  s.unplug();
  assert.throws(() => s.imagesRoot(), e => e.code === 'FJ_DATA_DIR_MISSING');
  assert.equal(s.imagesDirSetting.loaded, false);
  s.plugIn();
  assert.equal(s.imagesRoot(), own);
});

test('zprávy konektoru: při chybějící složce do zálohy, po návratu přehrané v pořadí do složky dat', async () => {
  const s = setup();
  s.unplug();
  s.dataDirAvailable();
  for (const seq of [1, 2, 3]) s.spoolCapturePayload({ type: 'execution', seq }, 'ninjatrader');
  assert.equal(s.captureSpoolBusy(), true);
  // Dokud složka chybí, nic se nepřehraje.
  assert.deepEqual({ ...(await s.replayCaptureSpool()) }, { ok: true, count: 0, failed: 0 });
  assert.deepEqual(s.processed, []);
  const spooled = fs.readFileSync(s.captureSpoolPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(spooled.every(e => e.source === 'ninjatrader' && e.payload.receivedAt));
  s.plugIn();
  assert.equal(s.checkDataDirBack(), true);
  // checkDataDirBack přehrávání spustí; počkat na doběhnutí.
  for (let i = 0; i < 50 && s.captureSpoolBusy(); i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(s.processed, [1, 2, 3]);
  assert.equal(s.captureSpoolBusy(), false);
  assert.deepEqual(s.captureSpoolFiles(), []);
  const written = fs.readFileSync(path.join(s.custom, 'trade-capture', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).seq);
  assert.deepEqual(written, [1, 2, 3]);
  assert.equal(fs.existsSync(path.join(s.userData, 'trade-capture')), false);
  assert.equal(s.dataDirState.missing, null);
});

test('složka zmizí během přehrávání: nezpracované zprávy zůstanou na příště', async () => {
  const s = setup();
  for (const seq of [1, 2, 3, 4]) s.spoolCapturePayload({ seq }, 'ninjatrader');
  const real = s.__context.processIncomingPayload;
  s.__context.processIncomingPayload = async (payload, source) => {
    if (payload.seq === 3) s.unplug();
    return real(payload, source);
  };
  const r = await s.replayCaptureSpool();
  assert.equal(r.ok, false);
  assert.deepEqual(s.processed, [1, 2]);
  s.plugIn();
  s.__context.processIncomingPayload = real;
  const again = await s.replayCaptureSpool();
  assert.equal(again.count, 2);
  assert.deepEqual(s.processed, [1, 2, 3, 4]);
  assert.deepEqual(s.captureSpoolFiles(), []);
});

test('zpráva, kterou nejde zpracovat, se neztratí – zůstane v failed-*', async () => {
  const s = setup();
  s.spoolCapturePayload({ seq: 1 }, 'ninjatrader');
  s.spoolCapturePayload({ seq: 2, bad: true }, 'ninjatrader');
  const real = s.__context.processIncomingPayload;
  s.__context.processIncomingPayload = async (payload, source) => { if (payload.bad) throw new Error('neplatná zpráva'); return real(payload, source); };
  const r = await s.replayCaptureSpool();
  assert.deepEqual([r.count, r.failed], [1, 1]);
  const failed = fs.readdirSync(s.captureSpoolDir()).filter(n => n.startsWith('failed-'));
  assert.equal(failed.length, 1);
  assert.match(fs.readFileSync(path.join(s.captureSpoolDir(), failed[0]), 'utf8'), /"bad":true/);
  assert.equal(s.captureSpoolBusy(), false);
});

test('výběr přesunuté složky: přijme složku s journal-data i nadřazenou s FuturesJournalPRO-Data', () => {
  const s = setup();
  assert.equal(s.findDataDirIn(s.custom), s.custom);
  assert.equal(s.findDataDirIn(path.join(s.root, 'E')), s.custom);
  assert.equal(s.findDataDirIn(s.root), null);
});

test('bez nastavené vlastní složky se nic nemění (výchozí userData)', () => {
  const s = setup();
  fs.rmSync(s.dataLocationConfigPath());
  assert.equal(s.resolveDataDir(), s.userData);
  assert.equal(s.dataDirAvailable(), true);
});
