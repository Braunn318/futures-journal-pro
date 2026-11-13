'use strict';
// Typ deníku FUTURES_INTRADAY / CFD_SWING (docs/ZADANI_SWING_CFD.md §2, test 10 z §11)
// a oddělení swingu od futures agregací (test 9). Ruční limitky (pendingOrders) – záložka Pozice/Příkazy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMain, loadRenderer, loadFromSource, readRepoFile } = require('./helpers/extract');
const FJSwing = require('../app/swing.js');
const plain = v => JSON.parse(JSON.stringify(v));

function mainApi(root) {
  return loadMain(['safeJournalId', 'journalPath', 'readJournal', 'writeJournalFile'], {
    fs, path, dataRoot: () => root,
    defaultJournalData: () => ({ trades: [], settings: [] }),
    deflateJournalImages: () => 0, remapRenamedImages: () => 0,
    backupJournalFile: () => { throw new Error('záloha se tu dělat nemá'); },
    logInfo: () => {}
  });
}

test('10: journalType, journalTypeVersion a pendingOrders přežijí readJournal() a zápis', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-journal-type-'));
  try {
    const main = mainApi(root);
    const order = { id: 'po1', symbol: 'EURUSD', direction: 'long', orderType: 'LIMIT', price: 1.1 };
    main.writeJournalFile('j1', { trades: [], settings: [], dayNotes: {}, journalType: 'CFD_SWING', journalTypeVersion: 1, pendingOrders: [order] });
    const first = main.readJournal('j1');
    assert.equal(first.journalType, 'CFD_SWING');
    assert.equal(first.journalTypeVersion, 1);
    assert.deepEqual(plain(first.pendingOrders), [order]);
    main.writeJournalFile('j1', first);
    const again = main.readJournal('j1');
    assert.equal(again.journalType, 'CFD_SWING');
    assert.deepEqual(plain(again.pendingOrders), [order]);
    // starý deník bez značky: žádný typ (migrace ho doplní), prázdné limitky
    main.writeJournalFile('j2', { trades: [], settings: [] });
    const old = main.readJournal('j2');
    assert.equal(old.journalType, undefined);
    assert.equal(old.journalTypeVersion, 0);
    assert.deepEqual(plain(old.pendingOrders), []);
    // nesmyslná hodnota se nečte
    main.writeJournalFile('j3', { trades: [], settings: [], journalType: 'X' });
    assert.equal(main.readJournal('j3').journalType, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Migrace nad deníkem v paměti – stejný vzor jako runContextV3Migration.
function migrationEnv(data, profile) {
  const state = { data: structuredClone(data), backups: [], writes: 0, profilesSaved: 0 };
  const globals = {
    FJSwing,
    db: { data: state.data },
    activeJournalId: 'j1',
    journalProfiles: [profile],
    saveJournalProfiles: () => { state.profilesSaved++; },
    ensureActiveJournalData: async () => state.data,
    commitJournal: async apply => { const next = structuredClone(state.data); apply(next); state.data = next; globals.db.data = next; state.writes++; },
    window: { desktopAPI: { backupJournal: async (id, reason) => { state.backups.push(reason); return { ok: true }; } } }
  };
  const src = readRepoFile('app/swing-ui.js');
  const api = loadFromSource(src, ['activeJournalProfile', 'syncProfileJournalType', 'runJournalTypeMigration', 'activeJournalType', 'isSwingJournalActive'], globals);
  // db se v kontextu mění přes globals.db (stejný objekt) – runJournalTypeMigration čte db.data
  return { api, state, globals, ctx: api.__context };
}

test('10: migrace typu – záloha → zápis → značka; podruhé nic (idempotentní)', async () => {
  const { api, state } = migrationEnv({ trades: [{ id: 't1', instrument: 'MES' }], settings: [] }, { id: 'j1', name: 'MES' });
  // db v kontextu musí ukazovat na aktuální data i po commitu
  const r = await api.runJournalTypeMigration();
  assert.equal(r.migrated, true);
  assert.deepEqual(state.backups, ['pred-typem-deniku']);
  assert.equal(state.data.journalType, 'FUTURES_INTRADAY');
  assert.equal(state.data.journalTypeVersion, 1);
  assert.deepEqual(state.data.trades, [{ id: 't1', instrument: 'MES' }], 'obchody beze změny');
  const writes = state.writes;
  const again = await api.runJournalTypeMigration();
  assert.equal(again.skipped, true);
  assert.equal(state.writes, writes, 'druhé spuštění nic nezapíše');
  assert.equal(state.backups.length, 1);
});

test('10: nový swing deník bez dat – typ z profilu, bez zálohy', async () => {
  const profile = { id: 'j1', name: 'Swing', journalType: 'CFD_SWING' };
  const { api, state } = migrationEnv({ trades: [], settings: [] }, profile);
  await api.runJournalTypeMigration();
  assert.equal(state.data.journalType, 'CFD_SWING');
  assert.deepEqual(state.backups, []);
  assert.equal(api.isSwingJournalActive(), true);
});

test('10: typ uložený v souboru má přednost před profilem a profil se srovná', async () => {
  const profile = { id: 'j1', name: 'X' };
  const { api, state } = migrationEnv({ trades: [], settings: [], journalType: 'CFD_SWING', journalTypeVersion: 1 }, profile);
  await api.runJournalTypeMigration();
  assert.equal(profile.journalType, 'CFD_SWING');
  assert.equal(state.profilesSaved, 1);
});

// ---- test 9: swing obchod se neobjeví v žádné futures agregaci ----
const SETTINGS = { startingBalance: 10000, risk: { maxDailyDrawdown: 100, maxSlPerDay: 2, maxTradesPerDay: 5 }, templates: [] };
const FUT = [
  { id: 'f1', date: '2026-11-03', entryTime: '10:00', instrument: 'MES', side: 'long', pnl: 50, pnlRaw: 50, result: 'target' },
  { id: 'f2', date: '2026-11-03', entryTime: '11:00', instrument: 'MES', side: 'short', pnl: 30, pnlRaw: -30, result: 'stoploss' },
  { id: 'f3', date: '2026-11-04', entryTime: '09:30', instrument: 'MES', side: 'long', pnl: 20, pnlRaw: 20, result: 'target' }
];
const SWING = [
  { id: 's1', kind: 'SWING', date: '2026-11-03', symbol: 'EURUSD', direction: 'long', openedAt: '2026-11-03T10:00', entryPrice: 1.1, volume: 1, slInitial: 1.095,
    exits: [{ closedAt: '2026-11-04T10:00', price: 1.11, volume: 1, pnl: 1000, swap: -2, commission: -7 }], pnl: 999, pnlRaw: 999, result: 'target' },
  { id: 's2', kind: 'SWING', recordType: 'SETUP_ONLY', fillStatus: 'NO_FILL', date: '2026-11-04', symbol: 'USDJPY', direction: 'short' }
];
test('9: tradeRecords, performanceRecords a statistiky futures swing záznamy ignorují', () => {
  const r = loadRenderer(['isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive', 'readIncludeSkipLive', 'includeSkipLive',
    'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup', 'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude', 'performanceRecords',
    'computeOverallStats', 'computeDrawdownByDate', 'evaluateDayRisk', 'setRecords'],
    { settings: SETTINGS, trades: [], setupRecords: [] });
  const mixed = [...FUT, ...SWING];
  assert.equal(r.tradeRecords(mixed).length, 3);
  assert.equal(r.performanceRecords(mixed).length, 3);
  assert.deepEqual(plain(r.computeOverallStats(mixed)), plain(r.computeOverallStats(FUT)));
  assert.deepEqual(plain(r.computeDrawdownByDate(mixed)), plain(r.computeDrawdownByDate(FUT)));
  const dd = r.computeDrawdownByDate(FUT);
  assert.deepEqual(plain(r.evaluateDayRisk('2026-11-03', dd, mixed)), plain(r.evaluateDayRisk('2026-11-03', dd, FUT)));
  r.setRecords(mixed);
  const { vm } = { vm: require('vm') };
  assert.equal(vm.runInContext('trades.length', r.__context), 3);
  assert.equal(vm.runInContext('setupRecords.length', r.__context), 0, 'swing SETUP_ONLY nepatří do futures setupů');
});

test('9: futures CSV deníku – swing záznamy ve vstupu nezmění výstup', () => {
  const NAMES = ['signed', 'tradePointsTotal', 'displayPointsTotal', 'sideMeta', 'reportSigned', 'levelCsvCount', 'levelCsvHeader', 'levelCsvCells',
    'tradeCsvHeader', 'tradeCsvRow', 'deriveTargetPrices', 'extraTargetPrices', 'plannedTargetPrices', 'plannedRFor', 'firstTradeIdPerDate',
    'CONTEXT_CSV_MANUAL', 'CONTEXT_CSV_DERIVED', 'CONTEXT_CSV_DAY', 'CONTEXT_CSV_PSYCH', 'CONTEXT_CSV_DAY_PSYCH', 'CONTEXT_CSV_SKIPPED',
    'csvBool', 'emptyDayNoteCells', 'contextCsvHeader', 'contextCsvCells', 'journalCsvTable', 'targetCountOf', 'tradeRecords', 'isSetupRecord'];
  const r = loadRenderer(NAMES, { settings: SETTINGS, activeJournalId: 'j1', journalProfiles: [] });
  const opts = { tickSizeOf: () => 0.25, config: {}, mode: 'LIVE' };
  // exportCsv dostává modulové `trades` (už bez swingu, viz setRecords) – tady to ověří tradeRecords
  const out = r.journalCsvTable(r.tradeRecords([...FUT, ...SWING]), () => null, opts);
  assert.deepEqual(plain(out), plain(r.journalCsvTable(FUT, () => null, opts)));
});

test('9: čtení deníků pro reporty / přehled / kalendář vynechá swing záznamy', async () => {
  const data = { trades: [...FUT, ...SWING] };
  const r = loadRenderer(['readJournalTrades', 'readTradesForOverview'], { window: { desktopAPI: { readJournal: async () => ({ ok: true, data }) } } });
  const p = { id: 'j1', name: 'J' };
  assert.deepEqual((await r.readJournalTrades(p)).map(t => t.id), ['f1', 'f2', 'f3']);
  assert.deepEqual((await r.readTradesForOverview(p)).map(t => t.id), ['f1', 'f2', 'f3']);
});

test('AI export: swing obchody zatím nejdou ven, hlavička nese journalType', () => {
  const ai = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-ai-swing-'));
  try {
    const FJContext = require('../app/context.js');
    const FJPoints = require('../app/points.js');
    const api = loadMain(['safeJournalId', 'aiExportPath', 'stripImages', 'stripDayNote', 'aiExportModeOf', 'aiDerivedFields', 'aiMarketDerived', 'writeAiExportMirror', 'aiManifestEntry'],
      { fs, path, aiExportRoot: () => ai, logError: (w, e) => { throw e; }, FJContext, FJPoints });
    api.writeAiExportMirror('j1', { journalType: 'CFD_SWING', trades: [...SWING, FUT[0]], settings: [], dayNotes: {} });
    const out = JSON.parse(fs.readFileSync(path.join(ai, 'j1.json'), 'utf8'));
    assert.equal(out.journalType, 'CFD_SWING');
    assert.deepEqual(out.trades.map(t => t.id), ['f1']);
    api.writeAiExportMirror('j2', { trades: [FUT[0]], settings: [], dayNotes: {} });
    assert.equal(JSON.parse(fs.readFileSync(path.join(ai, 'j2.json'), 'utf8')).journalType, undefined, 'futures export beze změny tvaru');
    assert.equal(api.aiManifestEntry({ id: 'a', name: 'A', journalType: 'CFD_SWING' }).journalType, 'CFD_SWING');
    assert.equal(api.aiManifestEntry({ id: 'b', name: 'B' }).journalType, 'FUTURES_INTRADAY');
  } finally {
    fs.rmSync(ai, { recursive: true, force: true });
  }
});

// ---- ruční limitky ----
test('ruční limitka: sanitize, úprava zachová id, mcp řádek stejný tvar', () => {
  const o = FJSwing.sanitizePendingOrder({ symbol: ' eurusd ', direction: 'short', orderType: 'STOP', price: '1.1', sl: '1.12', tp: '', volume: '0.5', placedAt: '2026-11-05T09:00', note: 'x' });
  assert.equal(o.symbol, 'EURUSD');
  assert.equal(o.direction, 'short');
  assert.equal(o.orderType, 'STOP');
  assert.equal(o.price, 1.1);
  assert.equal(o.tp, null);
  assert.equal(o.source, 'MANUAL');
  assert.match(o.id, /^po_/);
  const edited = FJSwing.sanitizePendingOrder({ ...o, price: 1.105 });
  assert.equal(edited.id, o.id);
  assert.equal(FJSwing.sanitizePendingOrder({ symbol: '' }), null);
});

test('Nenaplněno / Naplněno jen předvyplní – nic se neuloží bez potvrzení', () => {
  const o = FJSwing.sanitizePendingOrder({ id: 'po1', symbol: 'EURJPY', direction: 'long', price: 170.5, sl: 170.1, tp: 171.4, volume: 0.2, placedAt: '2026-11-03T08:00' });
  const nofill = FJSwing.draftFromPendingOrder(o, false, '2026-11-05T10:00');
  assert.equal(nofill.recordType, 'SETUP_ONLY');
  assert.equal(nofill.fillStatus, 'NO_FILL');
  assert.equal(nofill.openedAt, '2026-11-03T08:00');
  assert.equal(nofill.id, undefined, 'návrh nemá id = ještě není v deníku');
  const filled = FJSwing.draftFromPendingOrder(o, true, '2026-11-05T10:00');
  assert.equal(filled.recordType, undefined);
  assert.equal(filled.entryPrice, 170.5);
  assert.equal(filled.slInitial, 170.1);
  assert.deepEqual(filled.targetsPlanned, [{ price: 171.4, levelType: '' }]);
  assert.equal(filled.orderPlacedAt, '2026-11-03T08:00');
  assert.equal(filled.orderPrice, 170.5);

  // UI: akce ve swing deníku otevře formulář, ale nezapíše nic
  let writes = 0, opened = null;
  const api = loadFromSource(readRepoFile('app/swing-ui.js'), ['orderToTrade', 'isSwingJournalActive', 'activeJournalType', 'activeJournalProfile'], {
    FJSwing, db: { data: { journalType: 'CFD_SWING' } }, journalProfiles: [], activeJournalId: 'j1',
    commitJournal: async () => { writes++; }, openSwingModal: (draft, opts) => { opened = { draft, opts }; }, showToast: () => {}
  });
  api.orderToTrade(o, false);
  assert.equal(writes, 0);
  assert.equal(opened.draft.recordType, 'SETUP_ONLY');
  assert.equal(opened.opts.fromOrder, 'po1', 'ruční limitka se odebere až s uložením obchodu');
});
