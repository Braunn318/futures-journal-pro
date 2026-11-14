'use strict';
// Snímek trhu zpětně (4.8.103): obchody bez snímku a úplné snímky bez
// rozvíjející se 30min svíčky (konektor v8) si snímek vyžádají přes „Doplnit
// svíčky a snímky…". Ruční řádek se nepřepíše, smazaný se nevrací, nový typ
// se doplní jen jednou.

const test = require('node:test');
const assert = require('node:assert/strict');
const FJSnapshot = require('../app/market-snapshot.js');
const { loadMain } = require('./helpers/extract');

const ENTRY = '2026-11-12T11:40:30.000Z';
const at = min => new Date(Date.parse('2026-11-12T11:00:00.000Z') + min * 60000).toISOString();
function snap(extra = {}) {
  const bars1m = [];
  for (let i = 16; i <= 40; i++) bars1m.push({ t: at(i), o: 7600, h: 7601, l: 7599, c: 7600.5, v: 100, delta: 1, vpoc: [7600] });
  return { v: 1, executionId: 'E1', instrumentFull: 'MES 12-26', time: ENTRY, valueAreaPct: 70, bars1m, bars30m: [], bar30mCurrent: null,
    day: { vpoc: 7590, vah: 7612, val: 7580, high: null, low: null, vwap: null }, prevDay: null, ticksComplete: true, ticksUntil: ENTRY, ...extra };
}
const trade = (extra = {}) => ({ id: 't1', instrument: 'MES', side: 'long', date: '2026-11-12', entryTime: '12:40', entryPrice: 7600, nearLevels: [], ...extra });

// ------------------------------------------------------------- plán

test('plán: obchod bez snímku → požadavek bf-<id> s časem vstupu z obchodu', () => {
  const toIso = (d, t) => `${d}T${t}:00.000Z`;
  const list = FJSnapshot.planSnapshotBackfill([trade(), trade({ id: 't2', date: '2026-11-13', entryTime: '10:05' })], { toIso });
  assert.deepEqual(list.map(r => [r.type, r.executionId, r.day, r.time, r.root]), [
    ['snapshot', 'bf-t2', '2026-11-13', '2026-11-13T10:05:00.000Z', 'MES'],
    ['snapshot', 'bf-t1', '2026-11-12', '2026-11-12T12:40:00.000Z', 'MES']
  ], 'od nejnovějšího dne');
});

test('plán: swing, setup bez vstupu, obchod bez času / ceny a úplný snímek se nežádají', () => {
  const list = FJSnapshot.planSnapshotBackfill([
    trade({ id: 'sw', kind: 'SWING' }), trade({ id: 'su', recordType: 'SETUP_ONLY' }),
    trade({ id: 'nt', entryTime: '' }), trade({ id: 'np', entryPrice: '' }),
    trade({ id: 'ok', marketSnapshot: snap() })
  ]);
  assert.deepEqual(list, []);
});

test('plán: úplný snímek bez 30min svíčky jen s current30, neúplný ne (řeší ho opakovaný požadavek)', () => {
  const t = trade({ marketSnapshot: snap() });
  assert.deepEqual(FJSnapshot.planSnapshotBackfill([t]), []);
  const r = FJSnapshot.planSnapshotBackfill([t], { current30: true });
  assert.deepEqual(r.map(x => [x.executionId, x.time, x.instrumentFull]), [['E1', ENTRY, 'MES 12-26']]);
  assert.deepEqual(FJSnapshot.planSnapshotBackfill([trade({ marketSnapshot: snap({ bar30mCurrent: { t: at(30), vpoc: [7598.75] } }) })], { current30: true }), []);
  assert.deepEqual(FJSnapshot.planSnapshotBackfill([trade({ marketSnapshot: snap({ ticksComplete: false, ticksUntil: at(20) }) })], { current30: true }), []);
});

// ---------------------------------------------------------- připojení

test('snímek bf-<id> se připojí jen k obchodu bez snímku a jen ke svému', () => {
  const s = snap({ executionId: 'bf-t1' });
  const r = FJSnapshot.applyMarketData(trade(), { snapshot: s });
  assert.equal(r.trade.marketSnapshot.executionId, 'bf-t1');
  assert.ok(r.changed.includes('snapshot'));
  assert.deepEqual(FJSnapshot.applyMarketData(trade({ id: 't9' }), { snapshot: s }).changed, [], 'cizí snímek ne');
});

test('úplný snímek v8 nahradí úplný snímek v9 téhož vstupu (přibude 30min svíčka), ne naopak', () => {
  const v8 = snap(), v9 = snap({ bar30mCurrent: { t: at(30), vpoc: [7598.75] } });
  assert.equal(FJSnapshot.shouldReplaceSnapshot(v8, v9), true);
  assert.equal(FJSnapshot.shouldReplaceSnapshot(v9, v8), false);
  assert.equal(FJSnapshot.shouldReplaceSnapshot(v8, snap()), false);
});

// --------------------------------------------------- nový typ jednou

test('VPOC 30M aktuální se do obchodu s už doplněnou skupinou DAY doplní jednou; smazaný se nevrací; ruční zůstane', () => {
  const opts = { levels: true, n: 3 };
  const manual = { level: 'VWAP', price: 7605 };
  const t = trade({ marketSnapshot: snap(), marketLevelsApplied: ['DAY'], nearLevels: [manual] });
  // Starý snímek bez 30min svíčky: nic nového, značka se nedá.
  const r0 = FJSnapshot.applyMarketData(t, opts);
  assert.deepEqual(r0.changed, []);
  // Přijde v9 snímek → nahradí a doplní jen nový typ.
  const v9 = snap({ bar30mCurrent: { t: at(30), vpoc: [7598.75] } });
  const r1 = FJSnapshot.applyMarketData(t, { ...opts, snapshot: v9 });
  assert.deepEqual(r1.trade.nearLevels, [manual, { level: 'VPOC_30M_CURRENT', price: 7598.75, source: 'snapshot' }]);
  assert.ok(r1.trade.marketLevelsApplied.includes('DAY:VPOC_30M_CURRENT'));
  assert.ok(!r1.trade.nearLevels.some(r => r.level === 'VPOC_DAY'), 'skupina DAY se znovu nedoplňuje');
  // Uživatel řádek smaže → další průchod ho nevrátí.
  const deleted = { ...r1.trade, nearLevels: [manual] };
  assert.deepEqual(FJSnapshot.applyMarketData(deleted, opts).changed, []);
});

test('první doplnění DAY se snímkem v9 dá značku hned (typ se nedoplní podruhé)', () => {
  const t = trade({ marketSnapshot: snap({ bar30mCurrent: { t: at(30), vpoc: [7598.75] } }) });
  const r = FJSnapshot.applyMarketData(t, { levels: true, n: 3 });
  assert.deepEqual(r.trade.marketLevelsApplied, ['DAY', 'DAY:VPOC_30M_CURRENT']);
  assert.equal(r.trade.nearLevels.filter(x => x.level === 'VPOC_30M_CURRENT').length, 1);
  assert.deepEqual(FJSnapshot.applyMarketData(r.trade, { levels: true, n: 3 }).changed, []);
});

// ---------------------------------------------------------- main.js

test('main: Doplnit svíčky a snímky zařadí zpětné snímky (jen se zapnutým snímkem)', () => {
  const queued = [];
  const m = loadMain(['planBackfillSnapshots'], {
    FJSnapshot, marketOn: k => k === 'snapshot' || k === 'snapshotLevels',
    marketSettingsNow: () => ({ levelTypes: {} }), marketPoll: { version: 9 }, CURRENT30_CONNECTOR_VERSION: 9,
    marketQueue: () => ({ enqueue: (item, batch) => { queued.push({ ...item, batch }); return item; } })
  });
  const n = m.planBackfillSnapshots([trade(), trade({ id: 't2', marketSnapshot: snap() })], 'b1');
  assert.equal(n, 2);
  assert.deepEqual(queued.map(q => [q.executionId, q.reason, q.batch]).sort(), [['E1', 'backfill30', 'b1'], ['bf-t1', 'backfill', 'b1']]);
  const off = loadMain(['planBackfillSnapshots'], { FJSnapshot, marketOn: () => false, marketSettingsNow: () => ({}), marketPoll: {}, CURRENT30_CONNECTOR_VERSION: 9, marketQueue: () => ({ enqueue() { throw new Error('nic'); } }) });
  assert.equal(off.planBackfillSnapshots([trade()], 'b1'), 0);
  // Konektor v8: VPOC 30M aktuální nedodá – úplné snímky se nežádají znovu.
  queued.length = 0;
  const v8 = loadMain(['planBackfillSnapshots'], { FJSnapshot, marketOn: () => true, marketSettingsNow: () => ({ levelTypes: {} }), marketPoll: { version: 8 }, CURRENT30_CONNECTOR_VERSION: 9,
    marketQueue: () => ({ enqueue: item => { queued.push(item); return item; } }) });
  assert.equal(v8.planBackfillSnapshots([trade({ marketSnapshot: snap() })], 'b2'), 0);
});
