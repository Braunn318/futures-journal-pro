'use strict';
// Kontext obchodu v2, krok 5 (docs/ZADANI_KONTEXT.md A5, A7 test 11):
// kontext dne – jednou za den a deník, uložený v dayNotes[date].dayContext.
//
// Proč dayNotes a ne nová top-level entita: readJournal() v main.js je
// whitelist top-level klíčů a co v něm není, tiše zahodí (u dayNotes samotných
// se to už jednou stalo). dayNotes se čte vcelku, takže kontext dne uvnitř
// přežije bez zásahu do whitelistu – a tenhle test to hlídá.
//
// Druhé místo, kde by se kontext dne ztratil: saveDayNote v rendereru maže
// poznámku, která je „prázdná" – a do 4.8.0 znal jen komentář, náhled,
// poznámky a obrázky. Den, kde je vyplněný jen kontext, by se smazal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { loadRenderer, loadMain } = require('./helpers/extract');
const FJContext = require('../app/context.js');

const plain = v => JSON.parse(JSON.stringify(v));
const CONTEXT = { openVsValue: 'GAP_UP', dayTypeExpected: 'TREND_UP', newsEvent: 'CPI' };

test('A5: číselníky kontextu dne s klíči ze zadání', () => {
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.openVsValue), ['IN_VA', 'ABOVE_VAH', 'BELOW_VAL', 'GAP_UP', 'GAP_DOWN']);
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.dayTypeExpected), ['TREND_UP', 'TREND_DOWN', 'BALANCE_D', 'P', 'b', 'DOUBLE_DIST', 'UNKNOWN']);
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.dayTypeActual), Object.keys(FJContext.DAY_CONTEXT.dayTypeExpected));
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.valueMigration), ['HIGHER', 'LOWER', 'OVERLAP']);
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.newsEvent), ['NONE', 'CPI', 'FOMC', 'NFP', 'OTHER']);
  assert.deepEqual(FJContext.DAY_CONTEXT_MORNING, ['openVsValue', 'dayTypeExpected', 'newsEvent']);
});

test('A5: očista kontextu dne – jen známá pole a hodnoty, prázdné = null', () => {
  assert.deepEqual(FJContext.sanitizeDayContext({ ...CONTEXT, valueMigration: 'SIDEWAYS', foo: 'x' }), CONTEXT);
  assert.equal(FJContext.sanitizeDayContext({}), null);
  assert.equal(FJContext.sanitizeDayContext(null), null);
  assert.equal(FJContext.sanitizeDayContext({ dayTypeActual: 'b' }).dayTypeActual, 'b', 'malé b je platný klíč (b-profil)');
});

test('A7/11: dayContext přežije readJournal() a zápis v main procesu', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-daycontext-'));
  try {
    const main = loadMain(['safeJournalId', 'journalPath', 'readJournal', 'writeJournalFile'], {
      fs, path, dataRoot: () => root,
      defaultJournalData: () => ({ trades: [], settings: [] }),
      deflateJournalImages: () => 0,
      backupJournalFile: () => { throw new Error('záloha se tu dělat nemá'); },
      logInfo: () => {}
    });
    main.writeJournalFile('j1', { trades: [], settings: [], dayNotes: { '2026-10-09': { comment: '', preview: '', notes: '', images: [], dayContext: CONTEXT } } });
    const first = main.readJournal('j1');
    assert.deepEqual(plain(first.dayNotes['2026-10-09'].dayContext), CONTEXT);
    main.writeJournalFile('j1', first);
    assert.deepEqual(plain(main.readJournal('j1').dayNotes['2026-10-09'].dayContext), CONTEXT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function rendererJournal(initial) {
  const r = loadRenderer(['SCHEMA_VERSION', 'ensureActiveJournalData', 'commitJournal', 'emptyDayNote', 'getDayNote', 'saveDayNote', 'saveDayContext'], {
    db: { data: initial, close() {} },
    activeJournalId: 'j1',
    window: { desktopAPI: { writeJournal: async () => ({ ok: true }) } }
  });
  return { ...r, data: () => vm.runInContext('db.data', r.__context) };
}

test('A7/11: den jen s kontextem dne se při uložení nesmaže', async () => {
  const j = rendererJournal({ trades: [], settings: [], dayNotes: {} });
  await j.saveDayContext('2026-10-09', CONTEXT);
  assert.deepEqual(plain(j.data().dayNotes['2026-10-09'].dayContext), CONTEXT);
  // Uložení jiného pole dne (komentář) kontext nesmaže.
  await j.saveDayNote('2026-10-09', { comment: 'x' });
  await j.saveDayNote('2026-10-09', { comment: '' });
  assert.deepEqual(plain(j.data().dayNotes['2026-10-09'].dayContext), CONTEXT, 'poznámka s kontextem není prázdná');
  assert.deepEqual(plain(j.getDayNote('2026-10-09').dayContext), CONTEXT);
});

test('A5: kontext dne se doplňuje po polích – večerní pole nepřepíše ranní', async () => {
  const j = rendererJournal({ trades: [], settings: [], dayNotes: { '2026-10-09': { comment: 'ráno', images: [] } } });
  await j.saveDayContext('2026-10-09', { openVsValue: 'IN_VA' });
  await j.saveDayContext('2026-10-09', { dayTypeActual: 'P', valueMigration: 'HIGHER' });
  assert.deepEqual(plain(j.data().dayNotes['2026-10-09']), { comment: 'ráno', images: [], dayContext: { openVsValue: 'IN_VA', dayTypeActual: 'P', valueMigration: 'HIGHER' } });
  await j.saveDayContext('2026-10-09', { openVsValue: '' });
  assert.equal(j.data().dayNotes['2026-10-09'].dayContext.openVsValue, undefined, 'prázdná volba pole smaže');
  await j.saveDayContext('2026-10-09', { dayTypeActual: '', valueMigration: '' });
  assert.equal(j.data().dayNotes['2026-10-09'].dayContext, undefined, 'prázdný kontext se neukládá');
  assert.equal(j.data().dayNotes['2026-10-09'].comment, 'ráno');
});
