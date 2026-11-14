'use strict';
// VWAP v Hladinách na tick (4.8.103-test.3): VWAP v čase vstupu z konektoru
// NT8 je průměr – jako hladina se zaokrouhlí na nejbližší tick instrumentu.
// Stávající řádky doplněné strojem (source 'lta') převede jednorázová migrace
// se zálohou; ruční řádek se nikdy nemění.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FJLta = require('../app/lta-levels.js');
const FJTaxonomy = require('../app/taxonomy.js');
const { loadMain, loadRenderer } = require('./helpers/extract');
const plain = v => JSON.parse(JSON.stringify(v));

test('roundToTick: nejbližší tick, bez float chyb; bez ticku beze změny', () => {
  assert.equal(FJLta.roundToTick(7595.547151, 0.25), 7595.5);
  assert.equal(FJLta.roundToTick(7595.63, 0.25), 7595.75);
  assert.equal(FJLta.roundToTick(7595.625, 0.25), 7595.75, 'přesně v půlce nahoru');
  assert.equal(FJLta.roundToTick(2051.2345, 0.1), 2051.2);
  assert.equal(FJLta.roundToTick(44123.6, 1), 44124);
  assert.equal(FJLta.roundToTick(7595.547151, null), 7595.547151);
  assert.equal(FJLta.roundToTick(null, 0.25), null);
});

test('snapVwapRows: jen VWAP doplněný strojem a mimo tick', () => {
  const rows = [
    { level: 'VWAP', price: 7595.547151, source: 'lta' },
    { level: 'VWAP', price: 7595.3, testState: 'TESTED' },             // ruční – nechat
    { level: 'LTA_ID_VAL', price: 7599.1, source: 'lta' },             // jiná LTA hladina – nechat
    { level: 'LTA_VWAP', price: 7601.111, source: 'lta', testState: 'UNTESTED' },
    { level: 'VWAP', price: 7590.25, source: 'lta' }                   // na ticku – nechat
  ];
  const r = FJLta.snapVwapRows(rows, { tickSize: 0.25, vwapKeys: ['VWAP', 'LTA_VWAP'] });
  assert.equal(r.changed, 2);
  assert.deepEqual(plain(r.rows), [
    { level: 'VWAP', price: 7595.5, source: 'lta' },
    rows[1], rows[2],
    { level: 'LTA_VWAP', price: 7601, source: 'lta', testState: 'UNTESTED' },
    rows[4]
  ]);
  assert.equal(FJLta.snapVwapRows(rows, { tickSize: null, vwapKeys: ['VWAP'] }).changed, 0, 'bez ticku nic');
  assert.equal(r.rows[1], rows[1], 'ruční řádek je tentýž objekt');
});

test('ltaRowsFor: VWAP z konektoru přijde na tick instrumentu', async () => {
  const r = loadRenderer(['ltaRowsFor', 'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES'], {
    FJLta, settings: { templates: [] },
    window: { desktopAPI: { ltaLevelsFor: async () => ({ levels: [], source: 'live', day: '2026-11-13' }) } }
  });
  const out = await r.ltaRowsFor({ instrument: 'MES', entryISO: '2026-11-13T15:39:00.000Z', entryPrice: 7600, vwap: 7595.547151, config: {}, s: FJLta.cleanSettings({}) });
  const vwap = out.rows.find(x => FJTaxonomy.labelOf('NEAR_LEVEL', x.level, out.config) === 'VWAP');
  assert.ok(vwap, 'řádek VWAP');
  assert.equal(vwap.price, 7595.5);
});

// --------------------------------------------------------------- převod

function migrationEnv(data) {
  const state = { data: structuredClone(data), backups: [], writes: 0, toasts: [] };
  const globals = {
    FJLta, settings: { templates: [] },
    ensureActiveJournalData: async () => state.data,
    commitJournal: async apply => { const next = structuredClone(state.data); apply(next); state.data = next; state.writes++; },
    taxonomyConfig: () => ({}), activeJournalId: 'j1',
    window: { desktopAPI: { backupJournal: async (id, reason) => { state.backups.push(reason); return { ok: true }; } } }
  };
  const api = loadRenderer(['runVwapTickMigration', 'VWAP_TICK_VERSION', 'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES'], globals);
  return { api, state };
}

test('převod: záloha → zaokrouhlení VWAP řádků → značka; podruhé nic; ruční a swing beze změny', async () => {
  const manual = { level: 'VWAP', price: 7595.3 };
  const { api, state } = migrationEnv({ trades: [
    { id: 't1', instrument: 'MES', nearLevels: [{ level: 'VWAP', price: 7595.547151, source: 'lta' }, manual] },
    { id: 't2', instrument: 'MES', nearLevels: [{ level: 'VAH', price: 7610 }] },
    { id: 's1', kind: 'SWING', instrument: 'EURUSD', nearLevels: [{ level: 'VWAP', price: 1.123456, source: 'lta' }] }
  ], settings: [] });
  const r = await api.runVwapTickMigration();
  assert.equal(r.changed, 1);
  assert.deepEqual(state.backups, ['pred-vwap-na-tick']);
  assert.deepEqual(plain(state.data.trades[0].nearLevels), [{ level: 'VWAP', price: 7595.5, source: 'lta' }, manual]);
  assert.equal(state.data.trades[2].nearLevels[0].price, 1.123456, 'swing beze změny');
  assert.equal(state.data.vwapTickVersion, api.VWAP_TICK_VERSION);
  const writes = state.writes;
  assert.equal((await api.runVwapTickMigration()).skipped, true);
  assert.equal(state.writes, writes);
});

test('převod: nic k zaokrouhlení → bez zálohy, jen značka', async () => {
  const { api, state } = migrationEnv({ trades: [{ id: 't1', instrument: 'MES', nearLevels: [{ level: 'VWAP', price: 7595.5, source: 'lta' }] }], settings: [] });
  const r = await api.runVwapTickMigration();
  assert.equal(r.changed, 0);
  assert.deepEqual(state.backups, []);
  assert.equal(state.data.vwapTickVersion, api.VWAP_TICK_VERSION);
});

test('vwapTickVersion přežije readJournal() a zápis (whitelist)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-vwap-tick-'));
  try {
    const main = loadMain(['safeJournalId', 'journalPath', 'readJournal', 'writeJournalFile'], {
      fs, path, dataRoot: () => root, defaultJournalData: () => ({ trades: [], settings: [] }),
      deflateJournalImages: () => 0, remapRenamedImages: () => 0, backupJournalFile: () => { throw new Error('ne'); }, logInfo: () => {}
    });
    main.writeJournalFile('j1', { trades: [], settings: [], vwapTickVersion: 1 });
    assert.equal(main.readJournal('j1').vwapTickVersion, 1);
    main.writeJournalFile('j2', { trades: [], settings: [] });
    assert.equal(main.readJournal('j2').vwapTickVersion, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
