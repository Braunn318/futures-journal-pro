'use strict';
// Data trhu – J4: AI export a CSV (ZADANI_DENIK_SNAPSHOT_TRHU.md §J4).
//
// AI export nese marketSnapshot, signalBarOffset, ltaMeta a zdroj řádků
// hladin; dopočty signální svíčky jsou v `derived`. CSV dostane jen tři nové
// sloupce a jen s přepínačem 8 – ostatní sloupce stávajících obchodů beze změny.

const test = require('node:test');
const assert = require('node:assert/strict');

const FJSnapshot = require('../app/market-snapshot.js');
const FJTaxonomy = require('../app/taxonomy.js');
const FJPoints = require('../app/points.js');
const FJMarket = require('../app/market-data.js');
const { loadMain, loadRenderer } = require('./helpers/extract');

const plain = v => JSON.parse(JSON.stringify(v));
const ENTRY = '2026-11-12T11:40:30.000Z';
const at = min => new Date(Date.parse('2026-11-12T11:00:00.000Z') + min * 60000).toISOString();
function snapshot() {
  const bars1m = [];
  for (let i = 1; i <= 25; i++) bars1m.push([at(i + 15), 7600, 7602, 7598, i === 25 ? 7599 : 7601, 100, 3, [7600]]);
  return FJSnapshot.normalizeSnapshotPayload({ executionId: 'E1', time: ENTRY, bars1m, bars30m: [], day: { profile: [[7600, 1]] } }, 70).snapshot;
}

// ------------------------------------------------------------ AI export

test('AI export: derived nese dopočty signální svíčky podle uloženého výběru; bez snímku nic', () => {
  const { aiMarketDerived } = loadMain(['aiMarketDerived'], { FJSnapshot });
  const t = { side: 'long', ofConfirm: ['CLOSE_VS_VPOC_OK'], marketSnapshot: snapshot() };
  assert.deepEqual(plain(aiMarketDerived(t)), {
    snapshotCoverage: { ticksUntil: at(40), gapMinutes: 0, complete: true, gap: null },
    signalBar: { offset: -1, time: at(40), closeVsVpoc: 'BELOW', volumeVsMedian20: 1, delta: 3, vpoc: [7600], vpocTagMismatch: true }
  });
  // Svíčka v čase vstupu ve snímku chybí (ticky skončily dřív) → null, ne starší svíčka.
  const late = { ...t, marketSnapshot: { ...t.marketSnapshot, time: '2026-11-12T11:59:05.000Z' } };
  assert.equal(aiMarketDerived(late).signalBar, null);
  assert.equal(aiMarketDerived(late).snapshotCoverage.gapMinutes, 19);
  assert.equal(aiMarketDerived({ ...t, signalBarOffset: -2 }).signalBar.closeVsVpoc, 'ABOVE');
  assert.equal(aiMarketDerived({ ...t, signalBarOffset: -2 }).signalBar.vpocTagMismatch, false);
  assert.deepEqual(plain(aiMarketDerived({ side: 'long' })), {});
});

test('AI export: obchod nese snímek, výběr svíčky, původ hladin a zdroj řádků (taxonomie beze změny tvaru)', () => {
  const t = {
    id: 'a', marketSnapshot: snapshot(), signalBarOffset: -3, ltaMeta: { source: 'archive', day: '2026-11-12', versionFrom: null, versionAfterEntry: false, offered: 2 },
    nearLevels: [{ level: 'VAH', price: 7600, source: 'snapshot', testState: 'TESTED', testStateAuto: true }, { level: 'LTA_X', price: 7590, source: 'lta' }]
  };
  const out = FJTaxonomy.tradeToV3(t);
  assert.equal(out.signalBarOffset, -3);
  assert.equal(out.marketSnapshot.bars1m.length, 25);
  assert.equal(out.ltaMeta.source, 'archive');
  assert.deepEqual(plain(FJTaxonomy.nearLevelsOf(out).map(r => r.source)), ['snapshot', 'lta']);
});

// ------------------------------------------------------------------ CSV

const CSV_NAMES = ['signed', 'tradePointsTotal', 'displayPointsTotal', 'sideMeta', 'reportSigned', 'levelCsvCount', 'levelCsvHeader', 'levelCsvCells',
  'tradeCsvHeader', 'tradeCsvRow', 'reportCsvHeader', 'reportCsvRow', 'deriveTargetPrices', 'extraTargetPrices', 'plannedTargetPrices', 'plannedRFor', 'firstTradeIdPerDate',
  'CONTEXT_CSV_MANUAL', 'CONTEXT_CSV_DERIVED', 'CONTEXT_CSV_DAY', 'CONTEXT_CSV_PSYCH', 'CONTEXT_CSV_DAY_PSYCH', 'CONTEXT_CSV_SKIPPED', 'csvBool', 'emptyDayNoteCells',
  'contextCsvHeader', 'contextCsvCells', 'targetCountOf', 'extraTargetCsvCount', 'extraTargetCsvHeader', 'extraTargetCsvCells',
  'marketCsvHeader', 'marketCsvCells', 'journalCsvTable', 'reportCsvTable'];
const SETTINGS = { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }] };

function csv() {
  return loadRenderer(CSV_NAMES, { settings: SETTINGS, FJSnapshot, FJPoints });
}
const rows = () => [
  { id: 'a', instrument: 'MES', date: '2026-11-12', entryTime: '12:40', entryPrice: 7600, side: 'long', result: 'target', pnl: 10, contracts: 1,
    marketSnapshot: snapshot(), nearLevels: [{ level: 'VAH', price: 7605, source: 'snapshot' }, { level: 'VAL', price: 7590 }] },
  { id: 'b', instrument: 'MES', date: '2026-11-12', entryTime: '13:00', entryPrice: 7610, side: 'short', result: 'stoploss', pnl: -5, contracts: 1 }
];

test('CSV: bez přepínače 8 beze změny, s ním tři nové sloupce na konci a ostatní buňky identické', () => {
  const r = csv();
  const before = plain(r.journalCsvTable(rows(), () => null, {}));
  const after = plain(r.journalCsvTable(rows(), () => null, { marketCsv: true }));
  const width = before[0].length;
  assert.deepEqual(after.map(row => row.slice(0, width)), before, 'stávající sloupce a buňky beze změny');
  assert.deepEqual(after[0].slice(width), ['Signální svíčka vůči VPOC', 'Objem signální svíčky ×', 'Hladina 1: zdroj', 'Hladina 2: zdroj']);
  assert.deepEqual(after[1].slice(width), ['BELOW', 1, 'snapshot', '']);
  assert.deepEqual(after[2].slice(width), ['', '', '', ''], 'obchod bez snímku má prázdné buňky');
  const rep = plain(r.reportCsvTable(rows(), rows(), () => null, {}, { marketCsv: true }));
  const repBefore = plain(r.reportCsvTable(rows(), rows(), () => null, {}));
  assert.deepEqual(rep.map(row => row.slice(0, repBefore[0].length)), repBefore);
  assert.equal(rep[0].length, repBefore[0].length + 4);
});

test('nastavení: přepínač 8 (nové sloupce v CSV) je hotový a není v doporučené sadě', () => {
  const f = FJMarket.FEATURES.find(x => x.key === 'csvColumns');
  assert.equal(f.ready, true);
  assert.equal(f.recommended, false);
});
