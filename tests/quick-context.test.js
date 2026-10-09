'use strict';
// Rychlý kontextový formulář (BACKTEST_MODE_SPEC §6.2, ZADANI_KONTEXT A8 krok 4).
//
// Dvě věci, na kterých formulář stojí a které jdou otestovat bez DOM:
//  - dávka: které obchody a v jakém pořadí se nabídnou,
//  - zápis: mění se JEN kontextová pole, která uživatel změnil. Neupravený
//    obchod musí zůstat bajt po bajtu stejný – jinak by rychlé proklikání
//    dávky přepisovalo historická data (hlavní pravidlo zadání).

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');

const plain = v => JSON.parse(JSON.stringify(v));
const r = () => loadRenderer(['SR_ENUMS', 'isSetupRecord', 'tradeRecords', 'quickBatch', 'QC_GROUPS', 'quickDraftFrom', 'quickContextApply'], {});

const complete = {
  setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'SHORT', trendHtf: 'DOWN', grade: 'A',
  entryLevels: ['VPOC_DAY'], srTargetNone: true, srStopLossNone: true, ofConfirm: ['ABS_ASK'],
  targetLevel1: { type: 'VPOC_1M', price: 7737.75 }, slPrice: 7746, mfeTicks: 18, maeTicks: 2,
  postExitFavorableTicks: 1, postExitAdverseTicks: 30
};
const trades = [
  { id: 'c', date: '2026-10-09', entryTime: '17:00', ...complete },
  { id: 'a', date: '2026-10-09', entryTime: '15:31' },
  { id: 'setup', date: '2026-10-09', entryTime: '15:00', recordType: 'SETUP_ONLY' },
  { id: 'b', date: '2026-10-08', entryTime: '16:00' },
  { id: 'd', date: '2026-10-10', entryTime: '15:40' }
];

test('dávka: jen nevyplněné obchody, chronologicky, bez setupů bez vstupu', () => {
  assert.deepEqual(plain(r().quickBatch(trades).map(t => t.id)), ['b', 'a', 'd']);
});

test('dávka od konkrétního obchodu: ten vždy, dál jen nevyplněné', () => {
  assert.deepEqual(plain(r().quickBatch(trades, 'c').map(t => t.id)), ['c', 'd']);
  assert.deepEqual(plain(r().quickBatch(trades, 'neni').map(t => t.id)), []);
});

const stored = {
  id: 't1', instrument: 'MES', date: '2026-10-09', entryTime: '17:00', side: 'long', entryPrice: 7800,
  exitPrice: 7804, result: 'target', pnl: 18.1, pnlRaw: 18.1, commission: 1.9, contracts: 1,
  setupCode: 'M2_OF', fillStatus: 'FILLED', trend: '', entryLevels: ['VAH'], ofConfirm: [],
  srTarget: [{ level: 'VWAP', price: 7802, ticksFromEntry: 8 }], srStopLoss: [],
  targetLevel1: { type: 'VAH', price: 7804 }, slPrice: 7798, slDerived: false, mfeTicks: 16, mfeTicksSource: 'nt8'
};

test('zápis: neupravený obchod zůstane přesně stejný', () => {
  const q = r();
  const out = q.quickContextApply(stored, q.quickDraftFrom(stored), '2026-10-10T08:00:00.000Z', 0.25);
  assert.deepEqual(plain(out), plain(stored));
});

test('zápis: změní se jen to, co uživatel změnil; P/L, ceny ani komise se nedotkne', () => {
  const q = r();
  const d = q.quickDraftFrom(stored);
  d.trendHtf = 'UP';
  d.grade = 'B';
  d.entryLevels = ['VAH', 'VPOC_30M'];
  d.entryLevelTests = { VPOC_30M: 'UNTESTED' };
  d.srStopLoss.push({ level: 'VAL', price: 7799, ticksFromEntry: null, testState: 'TESTED' });
  const out = plain(q.quickContextApply(stored, d, '2026-10-10T08:00:00.000Z', 0.25));
  const changed = Object.keys({ ...out, ...stored }).filter(k => JSON.stringify(out[k]) !== JSON.stringify(stored[k])).sort();
  assert.deepEqual(changed, ['confluenceCount', 'entryLevelTests', 'entryLevels', 'grade', 'gradeSetAt', 'srStopLoss', 'trendHtf']);
  assert.equal(out.gradeSetAt, '2026-10-10T08:00:00.000Z');
  assert.deepEqual(out.srStopLoss, [{ level: 'VAL', price: 7799, ticksFromEntry: 4, testState: 'TESTED' }], 'ticky z ceny jako v plném formuláři');
  assert.equal(out.confluenceCount, 2);
});

test('zápis: „žádná hladina" jen bez řádků; přepsané MFE ruší zdroj z konektoru', () => {
  const q = r();
  const d = q.quickDraftFrom(stored);
  d.srStopLossNone = true;
  d.srTargetNone = true;
  d.mfeTicks = '20'; d.touched.mfeTicks = true;
  d.slPrice = '7797'; d.touched.slPrice = true;
  const out = plain(q.quickContextApply(stored, d, 'x', 0.25));
  assert.equal(out.srStopLossNone, true);
  assert.equal(out.srTargetNone, undefined, 'SR→TG má řádek, „žádná" neplatí');
  assert.equal(out.mfeTicks, 20);
  assert.equal(out.mfeTicksSource, undefined);
  assert.equal(out.slPrice, 7797);
  assert.equal(out.slDerived, false);
});

test('zápis: starý obchod bez kontextových klíčů nedostane prázdné hodnoty navíc', () => {
  const q = r();
  const old = { id: 'o1', instrument: 'MES', date: '2026-08-10', entryTime: '17:24', side: 'long', entryPrice: 7700, exitPrice: 7697.5, result: 'stoploss', pnlRaw: -43.2 };
  assert.deepEqual(plain(q.quickContextApply(old, q.quickDraftFrom(old), 'x', 0.25)), plain(old));
});
