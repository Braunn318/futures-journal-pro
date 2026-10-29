'use strict';
// Přehled účtu (4.8.94): „Další filtry" (směr, výsledek, setup, MFE, MAE)
// a Expectancy / čistý P/L včetně break-even obchodů.
//
// Expectancy = čistý P/L všech započtených obchodů / jejich počet. Do 4.8.93 se
// P/L break-even obchodů (např. poplatky −4,20) nepočítal do čitatele, ale obchod
// ano do jmenovatele – a KPI „Čistý P/L" se tak lišilo od řádku „Celkem".

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');

const plain = value => JSON.parse(JSON.stringify(value));

const BASE = ['isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive',
  'readIncludeSkipLive', 'includeSkipLive', 'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup',
  'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude', 'performanceRecords', 'computeOverallStats'];

function trade(id, result, pnlRaw, extra) {
  return {
    id, date: '2026-10-01', entryTime: '15:30', exitTime: '15:40', instrument: 'MES', side: 'long',
    result, pnl: Math.abs(pnlRaw), pnlRaw, contracts: 1, journalId: 'j1', ...extra
  };
}

test('computeOverallStats: expectancy a čistý P/L zahrnují break-even s poplatkem', () => {
  const r = loadRenderer(BASE, { settings: {} });
  const rows = [trade('a', 'target', 100), trade('b', 'stoploss', -50), trade('c', 'breakeven', -4.2)];
  const s = plain(r.computeOverallStats(rows));
  assert.equal(s.gainSum, 100);
  assert.equal(s.lossSum, -50);
  assert.ok(Math.abs(s.netPnl - 45.8) < 1e-9);
  assert.ok(Math.abs(s.beSum - -4.2) < 1e-9);
  assert.ok(Math.abs(s.expectancy - 45.8 / 3) < 1e-9);
  assert.equal(s.totalTrades, 3);
});

test('computeOverallStats: bez obchodů je expectancy 0', () => {
  const r = loadRenderer(BASE, { settings: {} });
  assert.equal(r.computeOverallStats([]).expectancy, 0);
});

const FILTER_NAMES = ['overviewNum', 'overviewRangeMatch', 'overviewFilterMatch', 'activeMoreFilterCount'];
const EMPTY = { mode: 'all', day: '', from: '', to: '', journal: '', instrument: '', side: '', result: '', setup: '',
  mfeMin: null, mfeMax: null, maeMin: null, maeMax: null };

const ROWS = [
  trade('t1', 'target', 100, { mfeTicks: 12, maeTicks: 0, setupCode: 'M2_OF' }),
  trade('t2', 'stoploss', -50, { side: 'short', mfeTicks: 0, maeTicks: 8 }),
  trade('t3', 'breakeven', -4, { side: '', setupCode: 'M2_OF' }),
  trade('t4', 'target', 80, { mfeTicks: '', maeTicks: '3', setupCode: 'OTHER' })
];

function ids(r, f) { return ROWS.filter(t => r.overviewFilterMatch(t, { ...EMPTY, ...f })).map(t => t.id); }

test('filtr bez hodnot propustí vše', () => {
  const r = loadRenderer(FILTER_NAMES, {});
  assert.deepEqual(ids(r, {}), ['t1', 't2', 't3', 't4']);
  assert.equal(r.activeMoreFilterCount(EMPTY), 0);
});

test('MFE / MAE: 0 je platná hodnota, prázdná při aktivním filtru vypadne', () => {
  const r = loadRenderer(FILTER_NAMES, {});
  assert.deepEqual(ids(r, { mfeMin: 0, mfeMax: 5 }), ['t2']);
  assert.deepEqual(ids(r, { mfeMin: 10 }), ['t1']);
  assert.deepEqual(ids(r, { maeMax: 3 }), ['t1', 't4'], 'řetězec "3" se čte jako číslo');
  assert.deepEqual(ids(r, { maeMin: 1, maeMax: 10 }), ['t2', 't4']);
  assert.equal(r.activeMoreFilterCount({ ...EMPTY, mfeMin: 0 }), 1, 'nula je aktivní filtr');
});

test('směr, výsledek a setup', () => {
  const r = loadRenderer(FILTER_NAMES, {});
  assert.deepEqual(ids(r, { side: 'short' }), ['t2']);
  assert.deepEqual(ids(r, { side: 'none' }), ['t3']);
  assert.deepEqual(ids(r, { result: 'target' }), ['t1', 't4']);
  assert.deepEqual(ids(r, { setup: 'M2_OF' }), ['t1', 't3']);
  assert.deepEqual(ids(r, { setup: '__none' }), ['t2']);
  assert.deepEqual(ids(r, { setup: 'M2_OF', result: 'target', mfeMin: 1 }), ['t1']);
  assert.equal(r.activeMoreFilterCount({ ...EMPTY, side: 'long', setup: 'X', maeMax: 4 }), 3);
});

test('stávající filtry (deník, instrument, datum) dál platí', () => {
  const r = loadRenderer(FILTER_NAMES, {});
  const rows = [trade('x', 'target', 1, { date: '2026-10-01' }), trade('y', 'target', 1, { date: '2026-10-05', journalId: 'j2', instrument: 'MNQ' })];
  const pick = f => rows.filter(t => r.overviewFilterMatch(t, { ...EMPTY, ...f })).map(t => t.id);
  assert.deepEqual(pick({ journal: 'j2' }), ['y']);
  assert.deepEqual(pick({ instrument: 'MES' }), ['x']);
  assert.deepEqual(pick({ mode: 'day', day: '2026-10-05' }), ['y']);
  assert.deepEqual(pick({ mode: 'interval', from: '2026-10-02', to: '' }), ['y']);
});
