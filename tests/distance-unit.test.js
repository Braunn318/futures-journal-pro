'use strict';
// Přepínač jednotky vzdáleností ticky ↔ body (2026-11-02). Ukládá se vždy
// v tikách; přepínač mění jen zobrazení a zadávání. Body = tiky × velikost
// ticku; bez známé velikosti ticku zůstává hodnota v tikách (nehádá se).

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJPoints = require('../app/points.js');
const FJContext = require('../app/context.js');

const SETTINGS = { templates: [{ instrument: 'FDXS', pointValue: 1, tickSize: 1 }] };

test('fmtDistance: ticky, body s desetinnou čárkou, fallback bez velikosti ticku', () => {
  assert.equal(FJPoints.fmtDistance(17, 0.25, 'ticks'), '17 t');
  assert.equal(FJPoints.fmtDistance(17, 0.25, 'points'), '4,25 b');
  assert.equal(FJPoints.fmtDistance(12, 0.1, 'points'), '1,2 b', 'RTY bez 1,2000000000000002');
  assert.equal(FJPoints.fmtDistance(5, 0.25, 'points', { signed: true }), '+1,25 b');
  assert.equal(FJPoints.fmtDistance(5, null, 'points'), '5 t', 'neznámý tick = ticky');
  assert.equal(FJPoints.fmtDistance(null, 0.25, 'points'), '');
});

test('převod tam a zpět je beze ztráty, přijímá desetinnou čárku', () => {
  for (const [ticks, tick] of [[17, 0.25], [12, 0.1], [3, 1], [101, 0.25], [7, 0.01]]) {
    const pts = FJPoints.ticksToUnit(ticks, tick, 'points');
    assert.equal(FJPoints.unitToTicks(pts, tick, 'points'), ticks);
  }
  assert.equal(FJPoints.unitToTicks('4,25', 0.25, 'points'), 17);
  assert.equal(FJPoints.unitToTicks('17', 0.25, 'ticks'), 17);
  assert.equal(FJPoints.unitToTicks('', 0.25, 'points'), null);
});

// Minimální DOM: pole s dataset, $ podle id.
function form(values) {
  const nodes = {};
  for (const [id, value] of Object.entries(values)) nodes[id] = { id, value, dataset: {} };
  return { nodes, $: id => nodes[id] || null };
}

test('formulář: pole v bodech se uloží v tikách', () => {
  const f = form({ instrument: 'MES 12-26', mfeTicks: '' });
  f.nodes.mfeTicks.dataset.tickInput = '';
  const r = loadRenderer(['tickInputValue', 'setTickInput', 'tickInputTarget', 'tickInputInstrument', 'currentDistanceUnit', 'getTickSizeForInstrument', 'findTemplate'],
    { $: f.$, settings: SETTINGS, distanceUnit: 'points' });
  r.setTickInput('mfeTicks', 17);
  assert.equal(f.nodes.mfeTicks.value, '4.25', 'ukazuje body');
  assert.equal(r.tickInputValue('mfeTicks'), '17', 'čte tiky');
  f.nodes.mfeTicks.value = '6';
  assert.equal(r.tickInputValue('mfeTicks'), '24', '6 b na MES = 24 t');
  f.nodes.mfeTicks.value = 'abc';
  assert.equal(r.tickInputValue('mfeTicks'), 'abc', 'nečíslo projde k validaci');
});

test('formulář: instrument bez velikosti ticku zůstává v tikách i v režimu bodů', () => {
  const f = form({ instrument: 'XYZ', mfeTicks: '' });
  const r = loadRenderer(['tickInputValue', 'setTickInput', 'tickInputTarget', 'tickInputInstrument', 'currentDistanceUnit', 'getTickSizeForInstrument', 'findTemplate'],
    { $: f.$, settings: SETTINGS, distanceUnit: 'points' });
  r.setTickInput('mfeTicks', 17);
  assert.equal(f.nodes.mfeTicks.value, '17');
  assert.equal(r.tickInputValue('mfeTicks'), '17');
});

test('statistika MFE v bodech: převod po obchodech, při neznámém ticku celé v tikách', () => {
  const names = ['computeTickStats', 'summarizeValues', 'statNum', 'medianOf', 'avgOf', 'tickBuckets', 'getTickSizeForInstrument', 'findTemplate'];
  const r = loadRenderer(names, { settings: SETTINGS });
  const rows = [
    { instrument: 'MES', mfeTicks: 20, result: 'target' }, // 5 b
    { instrument: 'FDXS', mfeTicks: 10, result: 'target' }, // tick 1 → 10 b
    { instrument: 'MES', mfeTicks: null }
  ];
  const pts = r.computeTickStats(rows, 'mfeTicks', 'points');
  assert.equal(pts.unit, 'points');
  assert.equal(pts.avg, 7.5);
  assert.equal(pts.missing, 1);
  const ticks = r.computeTickStats(rows, 'mfeTicks', 'ticks');
  assert.equal(ticks.unit, 'ticks');
  assert.equal(ticks.avg, 15);
  const unknown = r.computeTickStats([...rows, { instrument: 'XYZ', mfeTicks: 4 }], 'mfeTicks', 'points');
  assert.equal(unknown.unit, 'ticks');
  assert.equal(unknown.unitFallback, true);
});

test('filtr MFE v bodech porovnává body obchodu; obchod bez ticku nevyhoví', () => {
  const r = loadRenderer(['overviewNum', 'overviewRangeMatch', 'overviewFilterMatch', 'getTickSizeForInstrument', 'findTemplate'], { settings: SETTINGS });
  const EMPTY = { mode: 'all', mfeMin: null, mfeMax: null, maeMin: null, maeMax: null };
  const rows = [
    { id: 'a', instrument: 'MES', mfeTicks: 20 }, // 5 b
    { id: 'b', instrument: 'MES', mfeTicks: 8 }, // 2 b
    { id: 'c', instrument: 'XYZ', mfeTicks: 40 }
  ];
  const pick = f => rows.filter(t => r.overviewFilterMatch(t, { ...EMPTY, ...f })).map(t => t.id);
  assert.deepEqual(pick({ mfeMin: 4, unit: 'points' }), ['a']);
  assert.deepEqual(pick({ mfeMin: 10, unit: 'ticks' }), ['a', 'c']);
});

test('vzdálenosti hladin: výchozí ticky, v bodech přes opts.dist', () => {
  const g = { fromEntry: 5, fromStop: -3, toTarget: 11 };
  assert.equal(FJContext.levelDistanceText(g), '+5 t od vstupu · −3 t od SL · 11 t do cíle');
  const r = loadRenderer(['levelDistOpts', 'currentDistanceUnit'], { distanceUnit: 'points' });
  assert.equal(FJContext.levelDistanceText(g, r.levelDistOpts(0.25)), '+1,25 b od vstupu · −0,75 b od SL · 2,75 b do cíle');
  assert.equal(FJContext.levelDistanceText(g, r.levelDistOpts(null)), '+5 t od vstupu · −3 t od SL · 11 t do cíle');
  const parts = FJContext.derivedSummaryParts({ nearestAheadTicks: 8, nearestAheadR: 0.5 }, r.levelDistOpts(0.25));
  assert.equal(parts[0], 'Nejbližší hladina ve směru: +2 b (0,5 R)');
});
