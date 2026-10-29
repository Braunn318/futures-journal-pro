'use strict';
// Přehled účtu (4.8.95): šipky ◀ ▶ po měsících, řada „Pohyb ceny a délka
// obchodů“ (MFE, MAE, délka) a volba zobrazených sekcí.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');

const plain = value => JSON.parse(JSON.stringify(value));
const STATS = ['statNum', 'medianOf', 'avgOf', 'summarizeValues', 'tickBuckets', 'computeTickStats',
  'clockMinutes', 'tradeDurationMinutes', 'DURATION_BUCKETS', 'computeDurationStats', 'fmtDuration'];

test('shiftMonthRange: celé měsíce, přelom roku, únor i přestupný rok', () => {
  const r = loadRenderer(['isoDateParts', 'shiftMonthRange']);
  assert.deepEqual(plain(r.shiftMonthRange('2026-10-15', -1)), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(plain(r.shiftMonthRange('2026-10-01', 1)), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(plain(r.shiftMonthRange('2026-12-31', 1)), { from: '2027-01-01', to: '2027-01-31' });
  assert.deepEqual(plain(r.shiftMonthRange('2026-01-10', -1)), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(plain(r.shiftMonthRange('2026-03-05', -1)), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(plain(r.shiftMonthRange('2028-03-05', -1)), { from: '2028-02-01', to: '2028-02-29' });
  // Bez výchozího data (kompletní portfolio) se počítá od aktuálního měsíce.
  assert.deepEqual(plain(r.shiftMonthRange('', -1, new Date(2026, 9, 29))), { from: '2026-09-01', to: '2026-09-30' });
});

test('monthRangeLabel: popisek jen pro přesně jeden kalendářní měsíc', () => {
  const r = loadRenderer(['CS_MONTHS', 'isoDateParts', 'shiftMonthRange', 'monthRangeLabel']);
  assert.equal(r.monthRangeLabel('2026-10-01', '2026-10-31'), 'říjen 2026');
  assert.equal(r.monthRangeLabel('2026-09-01', '2026-09-30'), 'září 2026');
  assert.equal(r.monthRangeLabel('2026-10-01', '2026-10-30'), '');
  assert.equal(r.monthRangeLabel('2026-10-02', '2026-10-31'), '');
  assert.equal(r.monthRangeLabel('', ''), '');
});

test('tradeDurationMinutes: vstup → výstup, přes půlnoc, chybějící čas', () => {
  const r = loadRenderer(STATS);
  assert.equal(r.tradeDurationMinutes({ entryTime: '15:30', exitTime: '15:42' }), 12);
  assert.equal(r.tradeDurationMinutes({ entryTime: '15:30', exitTime: '15:30' }), 0, '0 min je platná délka');
  assert.equal(r.tradeDurationMinutes({ entryTime: '23:50', exitTime: '00:10' }), 20, 'přes půlnoc');
  assert.equal(r.tradeDurationMinutes({ entryTime: '15:30:00', exitTime: '15:31:30' }), 1.5);
  assert.equal(r.tradeDurationMinutes({ entryTime: '15:30', exitTime: '' }), null);
  assert.equal(r.tradeDurationMinutes({ entryTime: 'x', exitTime: '15:31' }), null);
});

test('computeTickStats: 0 se počítá, prázdné se vynechá, medián, ziskové / ztrátové', () => {
  const r = loadRenderer(STATS);
  const rows = [
    { result: 'target', mfeTicks: 20 }, { result: 'target', mfeTicks: 40 },
    { result: 'stoploss', mfeTicks: 0 }, { result: 'stoploss', mfeTicks: '' },
    { result: 'breakeven', mfeTicks: 10 }, { result: 'target' }
  ];
  const s = plain(r.computeTickStats(rows, 'mfeTicks'));
  assert.equal(s.count, 4);
  assert.equal(s.missing, 2);
  assert.equal(s.avg, 17.5);
  assert.equal(s.median, 15, 'sudý počet = průměr dvou prostředních');
  assert.equal(s.min, 0);
  assert.equal(s.max, 40);
  assert.equal(s.avgWin, 30);
  assert.equal(s.avgLoss, 0);
  assert.equal(s.buckets.length, 5);
  assert.equal(s.buckets.reduce((a, b) => a + b.count, 0), 4, 'každá hodnota v jednom rozsahu');
  assert.equal(s.buckets[4].count, 1, 'maximum patří do posledního rozsahu');
  assert.equal(r.medianOf([3, 1, 2]), 2, 'lichý počet');
  const empty = plain(r.computeTickStats([{ result: 'target' }], 'maeTicks'));
  assert.equal(empty.count, 0);
  assert.equal(empty.avg, null);
  assert.deepEqual(empty.buckets, []);
});

test('computeDurationStats a fmtDuration', () => {
  const r = loadRenderer(STATS);
  const rows = [
    { result: 'target', entryTime: '15:30', exitTime: '15:33' },
    { result: 'stoploss', entryTime: '15:30', exitTime: '16:00' },
    { result: 'target', entryTime: '10:00', exitTime: '12:30' },
    { result: 'target', entryTime: '10:00' }
  ];
  const s = plain(r.computeDurationStats(rows));
  assert.equal(s.count, 3);
  assert.equal(s.missing, 1);
  assert.equal(s.median, 30);
  assert.deepEqual(s.buckets.map(b => b.count), [1, 0, 0, 1, 1, 0]);
  assert.equal(r.fmtDuration(0), '0 min');
  assert.equal(r.fmtDuration(45), '45 min');
  assert.equal(r.fmtDuration(85), '1 h 25 min');
  assert.equal(r.fmtDuration(120), '2 h');
  assert.equal(r.fmtDuration(null), '—');
});

test('readOverviewSectionConfig: výchozí vše zobrazené, uložené false se drží', () => {
  const store = {};
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const r = loadRenderer(['OVERVIEW_SECTIONS', 'OVERVIEW_SECTIONS_KEY', 'readOverviewSectionConfig'], { localStorage });
  const def = plain(r.readOverviewSectionConfig());
  assert.ok(Object.values(def).every(v => v === true));
  for (const k of ['kpi', 'overall', 'mfe', 'mae', 'duration', 'setups', 'skipLive', 'noFill', 'skipped', 'equity', 'tradeList']) assert.ok(k in def, k);
  store.FJ_overviewSections = JSON.stringify({ setups: false, noFill: false, neznamy: false });
  const cfg = plain(r.readOverviewSectionConfig());
  assert.equal(cfg.setups, false);
  assert.equal(cfg.noFill, false);
  assert.equal(cfg.mfe, true);
  assert.ok(!('neznamy' in cfg), 'neznámý klíč se ignoruje');
  store.FJ_overviewSections = '{rozbité';
  assert.ok(Object.values(plain(r.readOverviewSectionConfig())).every(v => v === true), 'poškozená hodnota = výchozí');
});
