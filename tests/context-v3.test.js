'use strict';
// Kontext obchodu v3 (docs/ZADANI_KONTEXT_V3.md, část A, testy A7 1–9).
//
// Deník o hladinách nic NEPOSUZUJE, jen měří:
//  - jeden seznam „Hladiny v blízkosti" (nearLevels) místo dvojice srTarget /
//    srStopLoss; stranu ani roli uživatel nevolí,
//  - dopočty jsou čistá geometrie v ticích – žádný práh, žádná tolerance,
//  - liquiditySwept, pathProfile a entryLevelTests jsou smazané i z dat.
//
// Převod starého tvaru má JEDNO pravidlo (FJContext.nearLevelsFromLegacy):
// používá ho migrace, čtení deníku, který ještě nebyl otevřen, i exporty.
// Test 10 (CSV diff stávajících obchodů) je v csv-export-compat.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { loadRenderer, loadMain, readRepoFile } = require('./helpers/extract');
const FJContext = require('../app/context.js');
const FJTaxonomy = require('../app/taxonomy.js');

const plain = v => JSON.parse(JSON.stringify(v));
const TICK = 0.25;

// Long ze 7800, SL 7798 (8 t), cíl 7804 (16 t).
const LONG = { id: 'L', instrument: 'MES', side: 'long', entryPrice: 7800, slPrice: 7798, targetLevel1: { type: 'VAH', price: 7804 } };
// Short ze 7810, SL 7812 (8 t), cíl 7802 (32 t).
const SHORT = { id: 'S', instrument: 'MES', side: 'short', entryPrice: 7810, slPrice: 7812, targetLevel1: { type: 'VAL', price: 7802 } };
const geo = (trade, row) => plain(FJContext.levelGeometry(row, trade, TICK));

// ------------------------------------------------------------- A7/1 převod

test('A7/1: převod – řádky z obou seznamů v jednom, duplicita jednou, legacySide jen u řádků bez ceny', () => {
  const out = FJContext.nearLevelsFromLegacy({
    srTarget: [
      { level: 'VWAP', price: 7802, ticksFromEntry: 8, testState: 'TESTED' },
      { level: 'VAH', price: null, ticksFromEntry: 12 },
      { level: 'CUSTOM_GAMMA', price: 7800.5, ticksFromEntry: 2 }
    ],
    srStopLoss: [
      { level: 'CUSTOM_GAMMA', price: 7800.5, ticksFromEntry: 2, testState: 'UNTESTED' },
      { level: 'VAL', price: 7799, ticksFromEntry: 4 },
      { level: 'LIQUIDITY', price: null, ticksFromEntry: null }
    ]
  });
  assert.deepEqual(plain(out.nearLevels), [
    { level: 'VWAP', price: 7802, testState: 'TESTED' },
    { level: 'VAH', price: null, ticksFromEntry: 12, legacySide: 'TG' },
    { level: 'CUSTOM_GAMMA', price: 7800.5, testState: 'UNTESTED' },
    { level: 'VAL', price: 7799 },
    { level: 'LIQUIDITY', price: null, ticksFromEntry: null, legacySide: 'SL' }
  ]);
  assert.equal(out.nearLevelsNone, false);
  for (const row of out.nearLevels) {
    assert.equal('legacySide' in row, row.price == null, row.level + ': legacySide jen bez ceny');
    if (row.price != null) assert.equal('ticksFromEntry' in row, false, row.level + ': řádek s cenou ticky nenese');
  }
});

test('A7/1: převod nevaliduje typ proti číselníku (běží dřív, než se načtou vlastní volby) a starý tvar klíčů přijme', () => {
  const out = FJContext.nearLevelsFromLegacy({ srTarget: ['VAH', 'CUSTOM_MOJE'], srStopLoss: ['VAH'] });
  assert.deepEqual(plain(out.nearLevels), [
    { level: 'VAH', price: null, ticksFromEntry: null, legacySide: 'TG' },
    { level: 'CUSTOM_MOJE', price: null, ticksFromEntry: null, legacySide: 'TG' },
    { level: 'VAH', price: null, ticksFromEntry: null, legacySide: 'SL' }
  ], 'stejný typ bez ceny na dvou stranách zůstává dvakrát – strana je jediné, co o poloze víme');
});

test('A7/1: uložený obchod v novém tvaru – převod do nového tvaru smaže staré klíče', () => {
  const before = { id: 'x', srTarget: [{ level: 'VWAP', price: 7802, ticksFromEntry: 8 }], srStopLoss: [], srStopLossNone: true, comment: 'nechat' };
  const after = FJContext.convertLegacyNear(before);
  assert.deepEqual(plain(after), { id: 'x', comment: 'nechat', nearLevels: [{ level: 'VWAP', price: 7802 }] });
  assert.deepEqual(plain(before.srTarget), [{ level: 'VWAP', price: 7802, ticksFromEntry: 8 }], 'vstup se nemění');
});

// ------------------------------------------------- A7/2 idempotence a značka

test('A7/2: převod je idempotentní – nový tvar se vrací beze změny (stejný objekt)', () => {
  const once = FJContext.convertLegacyNear({ id: 'x', srTarget: [{ level: 'VWAP', price: 7802, ticksFromEntry: 8 }], srStopLossNone: true });
  assert.equal(FJContext.convertLegacyNear(once), once);
  const untouched = { id: 'y', setupCode: 'M2_OF' };
  assert.equal(FJContext.convertLegacyNear(untouched), untouched, 'obchod bez hladin se nedotkne');
  assert.equal(FJContext.stripRemovedV3(untouched), untouched);
});

test('A7/2: čtení přijme starý i nový tvar a dá totéž', () => {
  const old = { srTarget: [{ level: 'VWAP', price: 7802, ticksFromEntry: 8 }], srStopLoss: [{ level: 'VAL', price: null, ticksFromEntry: 6 }] };
  const fresh = FJContext.convertLegacyNear(old);
  assert.deepEqual(plain(FJContext.nearLevelsOf(old)), plain(FJContext.nearLevelsOf(fresh)));
  assert.deepEqual(plain(FJContext.nearLevelsOf(fresh)), [{ level: 'VWAP', price: 7802 }, { level: 'VAL', price: null, ticksFromEntry: 6, legacySide: 'SL' }]);
  assert.deepEqual(plain(FJContext.nearLevelsOf({})), []);
  assert.equal(FJContext.nearLevelsNoneOf({}), false);
});

test('A7/2: značka verze contextVersion přežije readJournal() a zápis', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-context-v3-'));
  try {
    const main = loadMain(['safeJournalId', 'journalPath', 'readJournal', 'writeJournalFile'], {
      fs, path, dataRoot: () => root,
      defaultJournalData: () => ({ trades: [], settings: [] }),
      deflateJournalImages: () => 0, remapRenamedImages: () => 0,
      backupJournalFile: () => { throw new Error('záloha se tu dělat nemá'); },
      logInfo: () => {}
    });
    main.writeJournalFile('j1', { trades: [], settings: [], dayNotes: {}, contextVersion: 3 });
    const first = main.readJournal('j1');
    assert.equal(first.contextVersion, 3);
    main.writeJournalFile('j1', first);
    assert.equal(main.readJournal('j1').contextVersion, 3);
    main.writeJournalFile('j2', { trades: [], settings: [] });
    assert.equal(main.readJournal('j2').contextVersion, 0, 'deník bez značky = ještě nepřevedený');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Migrace nad deníkem v paměti: zapisuje se přes commitJournal, záloha jde přes
// desktopAPI.backupJournal. `log` drží pořadí – záloha musí být PŘED zápisem.
function journalHarness(initial, opts = {}) {
  const log = [];
  const r = loadRenderer(['SCHEMA_VERSION', 'ensureActiveJournalData', 'commitJournal', 'runContextV3Migration'], {
    db: { data: structuredClone(initial), close() {} },
    activeJournalId: 'j1',
    window: { desktopAPI: {
      writeJournal: async () => { log.push('write'); return { ok: true }; },
      backupJournal: async (id, reason) => { log.push('backup:' + reason); return opts.backupFails ? { ok: false, error: 'disk' } : { ok: true, path: 'x' }; }
    } }
  });
  return { run: r.runContextV3Migration, log, data: () => plain(vm.runInContext('db.data', r.__context)) };
}

const OLD_JOURNAL = {
  trades: [
    { id: 'a', side: 'long', entryPrice: 7800, liquiditySwept: 'YES', pathProfile: 'LVN', entryLevels: ['VAH'], entryLevelTests: { VAH: 'UNTESTED' },
      entryTestNo: '1', srTarget: [{ level: 'VWAP', price: 7802, ticksFromEntry: 8 }], srStopLoss: [{ level: 'VAL', price: 7799, ticksFromEntry: 4 }] },
    { id: 'b', srTargetNone: true, srStopLossNone: true, pnlRaw: -11.9 },
    { id: 'c', recordType: 'SETUP_ONLY', liquiditySwept: 'NO', srTarget: [{ level: 'VAH', price: null, ticksFromEntry: null }] },
    { id: 'd', comment: 'bez kontextu' }
  ],
  settings: [{ key: 'main', value: { templates: [], taxonomy: {
    ENTRY_LEVEL: { custom: { CUSTOM_GAMMA: 'Gamma' }, hidden: ['VWAP_DEV'] },
    SR_TARGET: { hidden: ['VWAP_DEV', 'HVN', 'LVN'] }, SR_SL: { hidden: ['VWAP_DEV', 'HVN'] },
    LIQUIDITY_SWEPT: { labels: { YES: 'Jo' } }, PATH_PROFILE: { hidden: ['MIXED'] }
  } } }],
  dayNotes: {}
};

test('A7/2: migrace běží jednou – druhé spuštění nic nezapíše ani nezálohuje', async () => {
  const j = journalHarness(OLD_JOURNAL);
  const first = await j.run();
  assert.equal(first.removed, 2);
  assert.equal(first.converted, 3);
  assert.equal(j.data().contextVersion, 3);
  const snapshot = j.data();
  const writes = j.log.length;
  assert.deepEqual(plain(await j.run()), { skipped: true });
  assert.equal(j.log.length, writes, 'žádná další záloha ani zápis');
  assert.deepEqual(j.data(), snapshot);
});

test('A7/2: deník bez starých polí dostane jen značku, bez zálohy', async () => {
  const j = journalHarness({ trades: [{ id: 'd', comment: 'x' }], settings: [], dayNotes: {} });
  await j.run();
  assert.deepEqual(j.log, ['write']);
  assert.deepEqual(j.data().trades, [{ id: 'd', comment: 'x' }]);
  assert.equal(j.data().contextVersion, 3);
});

// ------------------------------------------------------ A7/3 nearLevelsNone

test('A7/3: nearLevelsNone jen při obou původních příznacích „žádná“', () => {
  const none = t => FJContext.nearLevelsFromLegacy(t).nearLevelsNone;
  assert.equal(none({ srTargetNone: true, srStopLossNone: true }), true);
  assert.equal(none({ srTargetNone: true }), false, 'jen jedna strana = nevyplněno');
  assert.equal(none({ srStopLossNone: true }), false);
  assert.equal(none({}), false);
  assert.equal(none({ srTargetNone: true, srStopLoss: [{ level: 'VAL', price: 7799 }] }), false, 'hladina na druhé straně');
});

test('A7/3: strana jen s řádkem NONE platí jako „žádná“; řádek NONE se do seznamu nepřevádí', () => {
  const both = FJContext.nearLevelsFromLegacy({ srTarget: [{ level: 'NONE', price: null, ticksFromEntry: null }], srStopLossNone: true });
  assert.deepEqual(plain(both), { nearLevels: [], nearLevelsNone: true });
  const one = FJContext.nearLevelsFromLegacy({ srTarget: ['NONE'], srStopLoss: [{ level: 'VAL', price: 7799, ticksFromEntry: 4 }] });
  assert.deepEqual(plain(one), { nearLevels: [{ level: 'VAL', price: 7799 }], nearLevelsNone: false });
  assert.equal(FJContext.nearLevelsFromLegacy({ srTarget: ['NONE'] }).nearLevelsNone, false, 'druhá strana nevyplněná');
});

test('A7/3: v novém tvaru platí „žádná“ jen bez řádků', () => {
  assert.equal(FJContext.nearLevelsNoneOf({ nearLevels: [], nearLevelsNone: true }), true);
  assert.equal(FJContext.nearLevelsNoneOf({ nearLevels: [{ level: 'VAL', price: 7799 }], nearLevelsNone: true }), false);
});

// --------------------------------------------------------- A7/4 geometrie

test('A7/4: long – fromEntry / fromStop / toTarget / position čistě podle ceny', () => {
  assert.deepEqual(geo(LONG, { level: 'VAL', price: 7799 }), { fromEntry: -4, fromStop: 4, toTarget: 20, position: 'STOP_TO_ENTRY' });
  assert.deepEqual(geo(LONG, { level: 'VPOC_DAY', price: 7800.5 }), { fromEntry: 2, fromStop: 10, toTarget: 14, position: 'ENTRY_TO_TARGET' },
    'hladina 2 t nad vstupem do longu: mezi vstupem a cílem, od SL kladně');
  assert.deepEqual(geo(LONG, { level: 'VWAP', price: 7800 }), { fromEntry: 0, fromStop: 8, toTarget: 16, position: 'AT_ENTRY' });
  assert.deepEqual(geo(LONG, { level: 'LIQUIDITY', price: 7797.5 }), { fromEntry: -10, fromStop: -2, toTarget: 26, position: 'BEYOND_STOP' });
  assert.deepEqual(geo(LONG, { level: 'HVN', price: 7805 }), { fromEntry: 20, fromStop: 28, toTarget: -4, position: 'BEYOND_TARGET' });
});

test('A7/4: short – znaménka se otáčejí se směrem obchodu', () => {
  assert.deepEqual(geo(SHORT, { level: 'VAH', price: 7811 }), { fromEntry: -4, fromStop: 4, toTarget: 36, position: 'STOP_TO_ENTRY' });
  assert.deepEqual(geo(SHORT, { level: 'VWAP', price: 7809.5 }), { fromEntry: 2, fromStop: 10, toTarget: 30, position: 'ENTRY_TO_TARGET' });
  assert.deepEqual(geo(SHORT, { level: 'VWAP', price: 7810 }), { fromEntry: 0, fromStop: 8, toTarget: 32, position: 'AT_ENTRY' });
  assert.deepEqual(geo(SHORT, { level: 'LIQUIDITY', price: 7813 }), { fromEntry: -12, fromStop: -4, toTarget: 44, position: 'BEYOND_STOP' });
  assert.deepEqual(geo(SHORT, { level: 'LIQUIDITY', price: 7801 }), { fromEntry: 36, fromStop: 44, toTarget: -4, position: 'BEYOND_TARGET' });
});

test('A7/4: řádek bez ceny – poloha z ±ticksFromEntry podle legacySide', () => {
  assert.deepEqual(geo(LONG, { level: 'VAH', price: null, ticksFromEntry: 6, legacySide: 'TG' }), { fromEntry: 6, fromStop: 14, toTarget: 10, position: 'ENTRY_TO_TARGET' });
  assert.deepEqual(geo(LONG, { level: 'VAL', price: null, ticksFromEntry: 6, legacySide: 'SL' }), { fromEntry: -6, fromStop: 2, toTarget: 22, position: 'STOP_TO_ENTRY' });
  assert.deepEqual(geo(SHORT, { level: 'VAL', price: null, ticksFromEntry: 6, legacySide: 'SL' }), { fromEntry: -6, fromStop: 2, toTarget: 38, position: 'STOP_TO_ENTRY' });
  assert.deepEqual(geo(LONG, { level: 'VAL', price: null, ticksFromEntry: null, legacySide: 'SL' }), { fromEntry: null, fromStop: null, toTarget: null, position: null },
    'bez ceny i bez ticků se nic nedopočítá – strana sama polohu nedá');
});

test('A7/4: chybějící vstup = null, nikdy 0', () => {
  const row = { level: 'VAL', price: 7799 };
  const empty = { fromEntry: null, fromStop: null, toTarget: null, position: null };
  assert.deepEqual(geo({ ...LONG, side: '' }, row), empty, 'bez směru');
  assert.deepEqual(geo({ ...LONG, entryPrice: '' }, row), empty, 'bez vstupu');
  assert.deepEqual(plain(FJContext.levelGeometry(row, LONG, null)), empty, 'bez velikosti ticku');
  assert.deepEqual(geo({ ...LONG, slPrice: null }, row), { fromEntry: -4, fromStop: null, toTarget: 20, position: null }, 'bez SL nejde říct, jestli je za ním');
  assert.deepEqual(geo({ ...LONG, targetLevel1: null }, { level: 'VPOC_DAY', price: 7800.5 }), { fromEntry: 2, fromStop: 10, toTarget: null, position: null }, 'bez cíle nejde říct, jestli je před ním');
  assert.deepEqual(geo({ ...LONG, slPrice: null, targetLevel1: null }, { level: 'VWAP', price: 7800 }), { fromEntry: 0, fromStop: null, toTarget: null, position: 'AT_ENTRY' });
});

// ------------------------------------------------- A7/5 dopočty na obchodu

const derived = (trade, extra = {}) => FJContext.derivedFields({ ...trade, ...extra }, { tickSize: TICK });

test('A7/5: stopBehindTicks bere i hladinu nad vstupem do longu', () => {
  assert.equal(derived(LONG, { nearLevels: [{ level: 'VPOC_DAY', price: 7800.5 }] }).stopBehindTicks, 10, 'jediná hladina je 2 t nad vstupem');
  assert.equal(derived(LONG, { nearLevels: [{ level: 'VPOC_DAY', price: 7800.5 }, { level: 'VAL', price: 7799 }] }).stopBehindTicks, 4, 'nejbližší k SL');
  assert.equal(derived(SHORT, { nearLevels: [{ level: 'VWAP', price: 7809.5 }] }).stopBehindTicks, 10);
  assert.equal(derived(LONG, { nearLevels: [{ level: 'LIQUIDITY', price: 7797.5 }, { level: 'HVN', price: 7805 }] }).stopBehindTicks, null, 'za SL ani za cílem se nepočítá');
  assert.equal(derived(LONG, { nearLevels: [{ level: 'VAL', price: 7798 }] }).stopBehindTicks, null, 'hladina přesně na SL: SL za ní není');
});

test('A7/5: nearestAheadTicks / R – nejbližší hladina ve směru obchodu před cílem', () => {
  const d = derived(LONG, { nearLevels: [{ level: 'HVN', price: 7803 }, { level: 'VPOC_DAY', price: 7800.5 }, { level: 'VAL', price: 7799 }, { level: 'LVN', price: 7805 }] });
  assert.equal(d.nearestAheadTicks, 2);
  assert.equal(d.nearestAheadR, 0.25, '2 t / riziko 8 t');
  assert.equal(d.levelsStopToEntry, 1);
  assert.equal(d.levelsEntryToTarget, 2);
  assert.equal(derived(LONG, { nearLevels: [{ level: 'VAL', price: 7799 }] }).nearestAheadTicks, null, 've směru obchodu nic');
  assert.equal(derived(LONG, { nearLevels: [{ level: 'VWAP', price: 7800 }] }).nearestAheadTicks, null, 'hladina na vstupu není „ve směru“');
  assert.equal(derived({ ...LONG, slPrice: null }, { nearLevels: [{ level: 'HVN', price: 7803 }] }).nearestAheadR, null, 'bez SL není R');
});

test('A7/5: počty hladin – nevyplněno null, výslovně žádná 0, neznámá poloha null', () => {
  const none = derived(LONG, { nearLevels: [], nearLevelsNone: true });
  assert.equal(none.levelsStopToEntry, 0);
  assert.equal(none.levelsEntryToTarget, 0);
  assert.equal(none.nearestAheadTicks, null);
  const unfilled = derived(LONG, {});
  assert.equal(unfilled.levelsStopToEntry, null);
  assert.equal(unfilled.levelsEntryToTarget, null);
  const unknown = derived(LONG, { nearLevels: [{ level: 'HVN', price: 7803 }, { level: 'VAL', price: null, ticksFromEntry: null, legacySide: 'SL' }] });
  assert.equal(unknown.levelsEntryToTarget, null, 'jeden řádek bez polohy – počet nejde tvrdit');
  assert.equal(unknown.nearestAheadTicks, 12, 'vzdálenosti se berou z řádků, které polohu mají');
});

test('A7/5: derivedFields nese geometrii řádků, staré dopočty jsou pryč a do obchodu se nic nezapíše', () => {
  const trade = { ...LONG, date: '2026-10-09', entryTime: '15:31', nearLevels: [{ level: 'VAL', price: 7799 }] };
  const frozen = plain(trade);
  const d = plain(FJContext.derivedFields(trade, { tickSize: TICK }));
  assert.deepEqual(d.nearLevels, [{ fromEntry: -4, fromStop: 4, toTarget: 20, position: 'STOP_TO_ENTRY' }]);
  for (const gone of ['firstObstacleTicks', 'freePathR', 'slBufferTicks', 'slZoneCount', 'pathState', 'srTarget', 'srStopLoss']) {
    assert.equal(gone in d, false, gone + ' už v dopočtech není');
  }
  assert.equal(d.targetTicks, 16);
  assert.equal(d.slTicks, 8);
  assert.equal(d.session, 'US_OPEN');
  assert.deepEqual(plain(trade), frozen);
  // Starý tvar (deník, který ještě nebyl otevřen) dá stejné dopočty.
  const old = { ...LONG, srStopLoss: [{ level: 'VAL', price: 7799, ticksFromEntry: 4 }] };
  assert.deepEqual(plain(FJContext.derivedFields(old, { tickSize: TICK })).nearLevels, d.nearLevels);
});

// ----------------------------------------------------------- A7/6 bez prahů

test('A7/6: hladina 1 t před cílem je ENTRY_TO_TARGET, ne „cíl na hladině“ – žádná tolerance', () => {
  assert.deepEqual(geo(LONG, { level: 'VAH', price: 7803.75 }), { fromEntry: 15, fromStop: 23, toTarget: 1, position: 'ENTRY_TO_TARGET' });
  assert.equal(geo(LONG, { level: 'VAH', price: 7804 }).position, 'ENTRY_TO_TARGET', 'přesně na ceně cíle patří ještě do úseku');
  assert.equal(geo(LONG, { level: 'VAH', price: 7804.25 }).position, 'BEYOND_TARGET', '1 t za cílem');
  assert.equal(geo(LONG, { level: 'VAL', price: 7798 }).position, 'STOP_TO_ENTRY', 'přesně na SL');
  assert.equal(geo(LONG, { level: 'VAL', price: 7797.75 }).position, 'BEYOND_STOP', '1 t za SL');
  assert.equal(geo(LONG, { level: 'VAL', price: 7799.75 }).position, 'STOP_TO_ENTRY', '1 t pod vstupem není „na vstupu“');
  const d = derived(LONG, { nearLevels: [{ level: 'VAH', price: 7803.75 }] });
  assert.equal(d.nearestAheadTicks, 15, 'hladina 1 t před cílem se počítá jako každá jiná');
  assert.equal(d.levelsEntryToTarget, 1);
});

test('A7/6: v kódu dopočtů není žádný pojmenovaný práh ani stav cesty', () => {
  const src = readRepoFile('app/context.js');
  for (const word of ['pathState', 'TARGET_IS_LEVEL', 'firstObstacleTicks', 'freePathR', 'slBufferTicks', 'slZoneCount', 'beyondStop', 'beyondTarget', 'behindEntry', 'srRowNotes']) {
    assert.equal(src.includes(word), false, 'app/context.js stále obsahuje ' + word);
  }
  assert.equal(FJContext.pathMetrics, undefined);
  assert.equal(FJContext.slZoneMetrics, undefined);
});

// ------------------------------------------------------ A7/7 smazaná pole

test('A7/7: smazaná pole zmizí ze všech záznamů (i ze setupu bez vstupu), záloha je před zápisem', async () => {
  const j = journalHarness(OLD_JOURNAL);
  await j.run();
  assert.deepEqual(j.log, ['backup:pred-odebranim-poli-v3', 'write', 'backup:pred-sloucenim-sr-hladin', 'write']);
  const data = j.data();
  const text = JSON.stringify(data.trades);
  for (const key of ['liquiditySwept', 'pathProfile', 'entryLevelTests', 'srTarget', 'srStopLoss', 'srTargetNone', 'srStopLossNone']) {
    assert.equal(text.includes('"' + key + '"'), false, key + ' v datech zůstalo');
  }
  const byId = Object.fromEntries(data.trades.map(t => [t.id, t]));
  assert.deepEqual(byId.a.nearLevels, [{ level: 'VWAP', price: 7802 }, { level: 'VAL', price: 7799 }]);
  assert.equal(byId.a.entryTestNo, '1', 'kolikátý test vstupu zůstává');
  assert.deepEqual(byId.a.entryLevels, ['VAH']);
  assert.deepEqual(byId.b, { id: 'b', pnlRaw: -11.9, nearLevels: [], nearLevelsNone: true });
  assert.deepEqual(byId.c.nearLevels, [{ level: 'VAH', price: null, ticksFromEntry: null, legacySide: 'TG' }]);
  assert.deepEqual(byId.d, { id: 'd', comment: 'bez kontextu' }, 'obchod bez kontextu beze změny');
});

test('A7/7: číselníky – dvě kolonky SR se sloučí do „Hladiny v blízkosti“, smazané skupiny zmizí', async () => {
  const j = journalHarness(OLD_JOURNAL);
  await j.run();
  const taxonomy = j.data().settings[0].value.taxonomy;
  assert.deepEqual(Object.keys(taxonomy).sort(), ['ENTRY_LEVEL', 'NEAR_LEVEL']);
  assert.deepEqual(taxonomy.NEAR_LEVEL.hidden, ['VWAP_DEV', 'HVN'], 'skryté jen to, co bylo skryté v obou kolonkách');
  assert.deepEqual(taxonomy.ENTRY_LEVEL, OLD_JOURNAL.settings[0].value.taxonomy.ENTRY_LEVEL, 'slovník hladin beze změny');
  assert.equal(FJTaxonomy.GROUP_BY_NAME.NEAR_LEVEL.optionsFrom, 'ENTRY_LEVEL');
  for (const gone of ['SR_TARGET', 'SR_SL', 'LIQUIDITY_SWEPT', 'PATH_PROFILE']) assert.equal(FJTaxonomy.GROUP_BY_NAME[gone], undefined, gone);
});

test('A7/7: když se záloha nepovede, nic se nezapíše', async () => {
  const j = journalHarness(OLD_JOURNAL, { backupFails: true });
  await assert.rejects(() => j.run(), /disk/);
  assert.deepEqual(j.log, ['backup:pred-odebranim-poli-v3']);
  assert.deepEqual(j.data().trades, OLD_JOURNAL.trades);
  assert.equal(j.data().contextVersion, undefined);
});

test('A7/7: smazaná pole nejsou ve slovníku polí, ve formuláři ani v exportu CSV', () => {
  const keys = FJTaxonomy.TRADE_CONTEXT_FIELDS.map(f => f.key);
  for (const gone of ['liquiditySwept', 'pathProfile', 'entryLevelTests', 'srTarget', 'srStopLoss', 'srTargetNone', 'srStopLossNone']) {
    assert.equal(keys.includes(gone), false, gone);
  }
  assert.ok(keys.includes('nearLevels') && keys.includes('nearLevelsNone'));
  const html = readRepoFile('app/index.html');
  for (const id of ['id="liquiditySwept"', 'id="pathProfile"', 'id="entryLevelTests"', 'id="srTarget"', 'id="srStopLoss"']) {
    assert.equal(html.includes(id), false, 'formulář stále obsahuje ' + id);
  }
  assert.ok(html.includes('id="nearLevels"') && html.includes('id="nearLevelsNone"'));

  const r = loadRenderer(['signed', 'tradePointsTotal', 'displayPointsTotal', 'sideMeta', 'reportSigned', 'levelCsvCount', 'levelCsvHeader', 'levelCsvCells',
    'tradeCsvHeader', 'tradeCsvRow', 'reportCsvHeader', 'reportCsvRow', 'firstTradeIdPerDate', 'CONTEXT_CSV_MANUAL', 'CONTEXT_CSV_DERIVED', 'CONTEXT_CSV_DAY', 'CONTEXT_CSV_PSYCH', 'CONTEXT_CSV_DAY_PSYCH', 'CONTEXT_CSV_SKIPPED',
    'csvBool', 'emptyDayNoteCells', 'contextCsvHeader', 'contextCsvCells', 'journalCsvTable', 'reportCsvTable'],
  { settings: { templates: [] }, activeJournalId: 'j1', journalProfiles: [] });
  const trade = { ...LONG, date: '2026-10-09', entryTime: '15:31', result: 'target', pnlRaw: 18.1,
    liquiditySwept: 'YES', pathProfile: 'LVN', entryLevelTests: { VAH: 'UNTESTED' },
    nearLevels: [{ level: 'VAL', price: 7799, testState: 'UNTESTED' }, { level: 'VPOC_DAY', price: 7800.5 }] };
  const empty = { ...SHORT, date: '2026-10-09', entryTime: '16:10', result: 'stoploss', pnlRaw: -11.9, nearLevels: [], nearLevelsNone: true };
  for (const [label, table] of [
    ['deník', r.journalCsvTable([trade, empty], () => null, { tickSizeOf: () => TICK, config: {} })],
    ['reporty', r.reportCsvTable([trade, empty].map(t => ({ ...t, journalId: 'j1', journalName: 'A' })), null, () => null, { j1: { templates: [{ instrument: 'MES', tickSize: TICK }] } })]
  ]) {
    const header = table[0];
    for (const row of table) assert.equal(row.length, header.length, label + ': hlavička a řádek se rozešly');
    assert.equal(header.some(h => /SR→|likvidita|Profil cesty|netest\/test|Cesta k cíli|Volná cesta|První překážka|SL za zónou|Zón chránících/i.test(h)), false, label + ': ' + header.join(' | '));
    const rec = row => Object.fromEntries(header.map((name, i) => [name, row[i]]));
    const a = rec(table[1]), b = rec(table[2]);
    assert.equal(a['Hladina 1 typ'], 'VAL', label);
    assert.equal(a['Hladina 1 cena'], 7799, label);
    assert.equal(a['Hladina 1 test'], 'UNTESTED', label);
    assert.equal(a['Hladina 1 od vstupu (dopočet)'], -4, label);
    assert.equal(a['Hladina 1 od SL (dopočet)'], 4, label);
    assert.equal(a['Hladina 1 do cíle (dopočet)'], 20, label);
    assert.equal(a['Hladina 1 poloha (dopočet)'], 'STOP_TO_ENTRY', label);
    assert.equal(a['Hladina 2 typ'], 'VPOC_DAY', label);
    assert.equal(a['Hladina 2 poloha (dopočet)'], 'ENTRY_TO_TARGET', label);
    assert.equal(a['Hladina 2 test'], '', label);
    assert.equal(b['Hladina 1 typ'], '', label);
    assert.equal(b['Hladina 1 od vstupu (dopočet)'], '', label + ': prázdná buňka, ne 0');
    assert.equal(a['Žádná hladina v blízkosti'], '', label);
    assert.equal(b['Žádná hladina v blízkosti'], 'ano', label);
    assert.equal(a['SL za hladinou – ticky (dopočet)'], 4, label);
    assert.equal(a['Nejbližší hladina ve směru – ticky (dopočet)'], 2, label);
    assert.equal(a['Nejbližší hladina ve směru – R (dopočet)'], 0.25, label);
    assert.equal(a['Hladin mezi SL a vstupem (dopočet)'], 1, label);
    assert.equal(a['Hladin před cílem (dopočet)'], 1, label);
    assert.equal(b['Hladin před cílem (dopočet)'], 0, label + ': výslovně žádná = 0');
    assert.equal(a['Order flow'], '', label + ': sloupec za blokem hladin se neposunul');
    assert.equal(a['Trend'], '', label + ': hlavička sloupce „Trend“ se nemění');
  }
});

test('A7/7: AI export – obchod bez smazaných polí, v novém tvaru i u deníku, který ještě nebyl otevřen', () => {
  const ai = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-ai-export-v3-'));
  try {
    const errors = [];
    const api = loadMain(['safeJournalId', 'aiExportPath', 'stripImages', 'stripDayNote', 'aiExportModeOf', 'aiDerivedFields', 'writeAiExportMirror'], {
      fs, path, aiExportRoot: () => ai, logError: (where, error) => errors.push(where + ': ' + error.message)
    });
    const old = { ...LONG, date: '2026-10-09', entryTime: '15:31', liquiditySwept: 'YES', pathProfile: 'LVN', entryLevelTests: { VAH: 'TESTED' },
      srTarget: [{ level: 'VPOC_DAY', price: 7800.5, ticksFromEntry: 2 }], srStopLoss: [{ level: 'VAL', price: 7799, ticksFromEntry: 4, testState: 'UNTESTED' }] };
    api.writeAiExportMirror('j1', { trades: [old, { id: 'n', nearLevels: [], nearLevelsNone: true }], settings: [{ key: 'main', value: { templates: [] } }] });
    const out = JSON.parse(fs.readFileSync(path.join(ai, 'j1.json'), 'utf8'));
    const t = out.trades[0];
    for (const gone of ['liquiditySwept', 'pathProfile', 'entryLevelTests', 'srTarget', 'srStopLoss', 'srTargetNone', 'srStopLossNone']) assert.equal(gone in t, false, gone);
    assert.deepEqual(t.nearLevels, [{ level: 'VPOC_DAY', price: 7800.5 }, { level: 'VAL', price: 7799, testState: 'UNTESTED' }]);
    assert.deepEqual(t.derived.nearLevels, [
      { fromEntry: 2, fromStop: 10, toTarget: 14, position: 'ENTRY_TO_TARGET' },
      { fromEntry: -4, fromStop: 4, toTarget: 20, position: 'STOP_TO_ENTRY' }
    ]);
    assert.equal(t.derived.stopBehindTicks, 4);
    assert.equal(t.derived.nearestAheadTicks, 2);
    assert.equal('pathState' in t.derived, false);
    assert.equal(out.trades[1].nearLevelsNone, true);
    assert.deepEqual(errors, []);
  } finally {
    fs.rmSync(ai, { recursive: true, force: true });
  }
});

// ------------------------------------------------- A7/8 skrytá pole (A4)

const completeTrade = (extra = {}) => ({
  id: 't1', instrument: 'MES', side: 'short', result: 'target',
  setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'SHORT', entryLevels: ['VPOC_DAY'],
  nearLevels: [{ level: 'VPOC_30M', price: 7730, testState: 'TESTED' }], ofConfirm: ['ABS_ASK'],
  targetLevel1: { type: 'VPOC_1M', price: 7737.75 }, slPrice: 7746, mfeTicks: 18, maeTicks: 2,
  postExitFavorableTicks: 1, postExitAdverseTicks: 30, trendHtf: 'DOWN', grade: 'A', entryTestNo: '1', absLocation: 'EXTREME',
  ...extra
});
const fields = over => FJTaxonomy.normalizeFieldConfig(over);
const missing = (trade, fieldCfg, opts) => FJTaxonomy.missingForCards(trade, {}, undefined, fieldCfg, opts);

test('A4: pole kontextu – vše zobrazené; upozornění ve výchozím stavu jen u trendu 30m a známky', () => {
  assert.deepEqual(FJTaxonomy.CONTEXT_FIELDS.map(f => f.key), ['trendHtf', 'grade', 'entryTestNo', 'absLocation', 'levelTestState', 'dayContext', 'derivedRow', 'entries',
    'psychBefore', 'psychDuring', 'psychAfter', 'psychDayBefore', 'psychDayDuring', 'psychDayAfter', 'psychDayWarnDay', 'psychDayWarnTrades']);
  const cfg = fields(undefined);
  for (const f of FJTaxonomy.CONTEXT_FIELDS) assert.equal(cfg[f.key].show, true, f.key);
  // Dva řádky psychiky dne jen říkají, KDE se upozorňuje; pole psychiky
  // samotná upozornění ve výchozím stavu nemají, takže se nic nehlásí.
  assert.deepEqual(FJTaxonomy.CONTEXT_FIELDS.filter(f => FJTaxonomy.fieldWarns(cfg, f.key)).map(f => f.key), ['trendHtf', 'grade', 'psychDayWarnDay', 'psychDayWarnTrades']);
  assert.equal(FJTaxonomy.fieldWarns(fields({ derivedRow: { warn: true } }), 'derivedRow'), false, 'řádek dopočtů se nekontroluje nikdy');
});

test('A7/8: skryté pole se nepočítá do „Neúplné“', () => {
  const t = completeTrade({ trendHtf: '', grade: '' });
  assert.deepEqual(missing(t, fields({})), ['Trend 30m', 'Známka']);
  assert.deepEqual(missing(t, fields({ trendHtf: { show: false } })), ['Známka']);
  assert.deepEqual(missing(t, fields({ trendHtf: { show: false }, grade: { warn: false } })), []);
  assert.deepEqual(missing(t, undefined), ['Trend 30m', 'Známka'], 'bez nastavení = výchozí');
});

test('A7/8: volitelná pole se hlásí jen se zapnutým upozorněním', () => {
  const t = completeTrade({ entryTestNo: '', absLocation: '', nearLevels: [{ level: 'VPOC_30M', price: 7730 }] });
  assert.deepEqual(missing(t, fields({})), [], 'výchozí: vypnuto, starší obchody nezčervenají');
  const on = fields({ entryTestNo: { warn: true }, absLocation: { warn: true }, levelTestState: { warn: true }, dayContext: { warn: true } });
  assert.deepEqual(missing(t, on), ['Kolikátý test vstupu', 'Absorpce – kde', 'Test / netest u hladin']);
  assert.deepEqual(missing(t, on, { dayContextMissing: true }), ['Kolikátý test vstupu', 'Absorpce – kde', 'Test / netest u hladin', 'Kontext dne']);
  assert.deepEqual(missing(completeTrade(), on, { dayContextMissing: false }), []);
  assert.deepEqual(missing(t, fields({ entryTestNo: { warn: true, show: false } })), [], 'skryté pole neupozorňuje, i když má upozornění zapnuté');
  assert.deepEqual(missing({ recordType: 'SETUP_ONLY' }, on, { dayContextMissing: true }), [], 'setup bez vstupu se neposuzuje');
});

test('A7/8: formulář – skryté pole jen zmizí (display), jeho prvky s hodnotami zůstávají', () => {
  const nodes = ['trendHtf', 'grade', 'entryTestNo', 'absLocation', 'levelTestState', 'dayContext', 'derivedRow']
    .map(key => ({ dataset: { ctxField: key }, style: { display: 'x' }, value: 'hodnota-' + key }));
  const document = { querySelectorAll: () => nodes };
  const r = loadRenderer(['contextFieldShown', 'applyContextFieldVisibility'], {
    document, contextFieldConfig: fields({ grade: { show: false }, levelTestState: { show: false } })
  });
  r.applyContextFieldVisibility();
  assert.deepEqual(nodes.map(n => n.style.display), ['', 'none', '', '', 'none', '', '']);
  assert.deepEqual(nodes.map(n => n.value), nodes.map(n => 'hodnota-' + n.dataset.ctxField), 'hodnoty se nemažou');
});

test('A7/8: data skrytého pole přežijí uložení obchodu (rychlý formulář)', () => {
  const hidden = fields({ grade: { show: false }, trendHtf: { show: false }, entryTestNo: { show: false }, absLocation: { show: false }, levelTestState: { show: false } });
  const q = loadRenderer(['QC_GROUPS', 'quickGroups', 'contextFieldShown', 'quickDraftFrom', 'quickContextApply'], { contextFieldConfig: hidden });
  assert.deepEqual(plain(q.quickGroups().map(g => g.key)).filter(k => ['grade', 'trendHtf', 'entryTestNo', 'absLocation'].includes(k)), [], 'skrytá pole se v rychlém formuláři nenabízejí');
  const stored = completeTrade({ gradeSetAt: '2026-10-09T13:00:00.000Z' });
  const d = q.quickDraftFrom(stored);
  d.setupCode = 'M2_PA';
  d.nearLevels.push({ level: 'VAL', price: 7741 });
  const out = plain(q.quickContextApply(stored, d, '2026-10-10T08:00:00.000Z'));
  assert.equal(out.setupCode, 'M2_PA');
  assert.equal(out.grade, 'A');
  assert.equal(out.gradeSetAt, '2026-10-09T13:00:00.000Z');
  assert.equal(out.gradeEdited, undefined, 'skrytá známka se nezměnila');
  assert.equal(out.trendHtf, 'DOWN');
  assert.equal(out.entryTestNo, '1');
  assert.equal(out.absLocation, 'EXTREME');
  assert.deepEqual(out.nearLevels, [{ level: 'VPOC_30M', price: 7730, testState: 'TESTED' }, { level: 'VAL', price: 7741 }], 'test/netest stávajícího řádku zůstal');
});

// --------------------------------------------------------- A7/9 sloučení

test('A7/9: sloučený obchod nese nearLevels všech nohou (i ze starého tvaru), duplicita jednou', () => {
  const merge = list => plain(loadRenderer(['mergeContextFields']).mergeContextFields(list));
  const merged = merge([
    { nearLevels: [{ level: 'VAH', price: 7712.5 }, { level: 'VWAP', price: 7698, testState: 'UNTESTED' }], exitTime: '16:05' },
    { nearLevels: [{ level: 'VAH', price: 7712.5, testState: 'TESTED' }, { level: 'LIQUIDITY', price: 7708 }], exitTime: '16:09' },
    { srStopLoss: [{ level: 'VAL', price: null, ticksFromEntry: 12 }], exitTime: '16:12' }
  ]);
  assert.deepEqual(merged.nearLevels, [
    { level: 'VAH', price: 7712.5, testState: 'TESTED' },
    { level: 'VWAP', price: 7698, testState: 'UNTESTED' },
    { level: 'LIQUIDITY', price: 7708 },
    { level: 'VAL', price: null, ticksFromEntry: 12, legacySide: 'SL' }
  ]);
  assert.equal(merged.nearLevelsNone, undefined);
  for (const gone of ['srTarget', 'srStopLoss', 'liquiditySwept', 'pathProfile', 'entryLevelTests']) assert.equal(gone in merged, false, gone);
});

test('A7/9: „žádná hladina v blízkosti“ platí za pozici, jen když ji mají všechny nohy', () => {
  const merge = list => plain(loadRenderer(['mergeContextFields']).mergeContextFields(list));
  assert.equal(merge([{ nearLevels: [], nearLevelsNone: true }, { nearLevelsNone: true }]).nearLevelsNone, true);
  assert.equal(merge([{ nearLevelsNone: true }, {}]).nearLevelsNone, undefined, 'jedna noha nevyplněná');
  const withRow = merge([{ nearLevelsNone: true }, { nearLevels: [{ level: 'VAL', price: 7799 }] }]);
  assert.equal(withRow.nearLevelsNone, undefined, 'hladina z jiné nohy má přednost');
  assert.equal(withRow.nearLevels.length, 1);
  assert.equal(merge([{}, {}]).nearLevels, undefined, 'noha bez hladin nevyrobí prázdné pole');
});

// ------------------------------------------------------ očista řádků (A2)

test('A2: sanitizeNearLevels – uživatel zadává jen typ, cenu a test/netest', () => {
  const rows = FJTaxonomy.sanitizeNearLevels('NEAR_LEVEL', [
    { level: 'VAH', price: '7712.5', ticksFromEntry: 50, legacySide: 'TG', testState: 'TESTED' },
    { level: 'VAH', price: 7712.5 },
    { level: 'VAH', price: 7720 },
    { level: 'PREKLEP', price: 7700 },
    { level: 'NONE', price: null },
    { level: '', price: 7705 },
    { level: 'VWAP', price: 'abc', testState: 'NECO' },
    { level: 'VAL', price: null, ticksFromEntry: -6, legacySide: 'SL' },
    { level: 'HVN', price: null, ticksFromEntry: 6 }
  ]);
  assert.deepEqual(plain(rows), [
    { level: 'VAH', price: 7712.5, testState: 'TESTED' },
    { level: 'VAH', price: 7720 },
    { level: 'VWAP', price: null },
    { level: 'VAL', price: null, ticksFromEntry: 6, legacySide: 'SL' },
    { level: 'HVN', price: null }
  ], 's cenou bez ticků a strany; bez strany ticky nemají znaménko, tak se nenesou; NONE není hladina');
  assert.deepEqual(plain(FJTaxonomy.sanitizeNearLevels(null, [{ level: 'CUSTOM_JINY_DENIK', price: 1 }])), [{ level: 'CUSTOM_JINY_DENIK', price: 1 }], 'bez skupiny se typ neověřuje');
  assert.deepEqual(plain(FJTaxonomy.sanitizeNearLevels('NEAR_LEVEL', [{ level: 'VWAP', price: null }, { level: 'VWAP', price: 7700 }])), [{ level: 'VWAP', price: 7700 }],
    'holý řádek ustoupí řádku téže hladiny s cenou');
});

test('A2: „Neúplné“ – jeden klíč nearLevels; vyplněné jsou řádky nebo „žádná hladina v blízkosti“ (i ve starém tvaru)', () => {
  const base = completeTrade({ nearLevels: [] });
  assert.deepEqual(FJTaxonomy.missingContextKeys(base), ['nearLevels']);
  assert.deepEqual(FJTaxonomy.missingContextKeys({ ...base, nearLevelsNone: true }), []);
  assert.deepEqual(FJTaxonomy.missingContextKeys(completeTrade()), []);
  const old = completeTrade({ nearLevels: undefined, srTargetNone: true, srStopLossNone: true });
  delete old.nearLevels;
  assert.deepEqual(FJTaxonomy.missingContextKeys(old), [], 'nepřevedený deník se posoudí stejně');
  assert.deepEqual(FJTaxonomy.missingContextKeys({ ...old, srStopLossNone: undefined }), ['nearLevels'], 'jen jedna strana „žádná“ = nevyplněno');
  assert.equal(FJTaxonomy.contextFieldLabel('nearLevels'), 'Hladiny v blízkosti');
  assert.equal(FJTaxonomy.contextFieldLabel('trend'), 'Trend 1m');
});
