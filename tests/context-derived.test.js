'use strict';
// Kontext obchodu v2, krok 3 (docs/ZADANI_KONTEXT.md A3, A7 test 8):
// dopočtená pole. Počítají se při čtení z toho, co v obchodu už je, nic se do
// obchodu nezapisuje a chybějící vstup je null, nikdy 0.
//
// Dopočty z hladin (cesta k cíli, zóny u SL) revize v3 nahradila čistou
// geometrií bez prahů – ty hlídá tests/context-v3.test.js. Tady zůstávají
// dopočty, které se nezměnily: ticky k cíli a k SL, pořadí v dni, seance,
// cíl na hladině.
//
// Fixtury jsou syntetické (MES, tick 0.25), long ze 7800 se SL 7798 (8 t)
// a cílem 7804 (16 t), pokud test neříká jinak.

const test = require('node:test');
const assert = require('node:assert/strict');

const FJContext = require('../app/context.js');

const TICK = 0.25;

const trade = overrides => ({
  id: 'x', instrument: 'MES', date: '2026-10-09', entryTime: '17:00', side: 'long', entryPrice: 7800,
  slPrice: 7798, targetLevel1: { type: 'VAH', price: 7804 }, ...overrides
});

// ------------------------------------------------- základ: ticky k cíli a k SL

test('A3: targetTicks a slTicks z cen; bez vstupu, cíle, SL nebo ticku null (ne 0)', () => {
  assert.equal(FJContext.targetTicks(trade(), TICK), 16);
  assert.equal(FJContext.slTicks(trade(), TICK), 8);
  assert.equal(FJContext.targetTicks(trade({ targetLevel1: { type: 'VAH', price: null } }), TICK), null);
  assert.equal(FJContext.targetTicks(trade({ entryPrice: '' }), TICK), null);
  assert.equal(FJContext.slTicks(trade({ slPrice: null }), TICK), null);
  assert.equal(FJContext.slTicks(trade(), null), null);
});

// ------------------------------------------------- 8. pořadí v rámci dne

const day = [
  { id: 'a', date: '2026-10-09', entryTime: '15:31', result: 'target', pnlRaw: 10, fillStatus: 'FILLED' },
  { id: 'b', date: '2026-10-09', entryTime: '16:00', result: 'stoploss', pnlRaw: -5 },
  { id: 'c', date: '2026-10-09', entryTime: '17:00', result: 'target', pnlRaw: 8, wouldSkipLive: true },
  { id: 'setup', date: '2026-10-09', entryTime: '16:30', recordType: 'SETUP_ONLY', fillStatus: 'NO_FILL' },
  { id: 'nofill', date: '2026-10-09', entryTime: '16:40', fillStatus: 'NO_FILL', result: 'target', pnlRaw: 20 },
  { id: 'other', date: '2026-10-10', entryTime: '15:00', result: 'stoploss', pnlRaw: -3 }
];

test('A7/8: tradeNoInDay, prevResultInDay, dayPnlBefore podle času vstupu v rámci dne', () => {
  const m = FJContext.dayOrder(day);
  assert.deepEqual(m.get('a'), { tradeNoInDay: 1, prevResultInDay: 'FIRST', dayPnlBefore: 0 });
  assert.deepEqual(m.get('b'), { tradeNoInDay: 2, prevResultInDay: 'target', dayPnlBefore: 10 });
  assert.deepEqual(m.get('c'), { tradeNoInDay: 3, prevResultInDay: 'stoploss', dayPnlBefore: 5 }, '„naživo bych nevzal“ se počítá');
  assert.deepEqual(m.get('other'), { tradeNoInDay: 1, prevResultInDay: 'FIRST', dayPnlBefore: 0 }, 'jiný den začíná znovu');
  assert.equal(m.get('setup'), undefined, 'setup bez vstupu do pořadí nepatří');
  assert.equal(m.get('nofill'), undefined, 'nenaplněný hypotetický obchod do pořadí nepatří');
});

test('A7/8: po smazání prostředního obchodu se pořadí přepočítá samo', () => {
  const m = FJContext.dayOrder(day.filter(t => t.id !== 'b'));
  assert.deepEqual(m.get('c'), { tradeNoInDay: 2, prevResultInDay: 'target', dayPnlBefore: 10 });
});

test('A7/8: P/L bez pnlRaw se bere se znaménkem podle výsledku (jako signed())', () => {
  const m = FJContext.dayOrder([
    { id: 'a', date: '2026-10-09', entryTime: '15:00', result: 'stoploss', pnl: 7 },
    { id: 'b', date: '2026-10-09', entryTime: '15:10', result: 'breakeven', pnl: 2 },
    { id: 'c', date: '2026-10-09', entryTime: '15:20', result: 'target', pnl: 4 }
  ]);
  assert.equal(m.get('c').dayPnlBefore, -7);
});

// ------------------------------------------------- seance

test('A3: session – US seance v newyorském čase, evropská v berlínském', () => {
  const s = (date, time) => FJContext.sessionOf(date, time);
  assert.equal(s('2026-10-07', '09:00'), 'EU_MORNING');
  assert.equal(s('2026-10-07', '15:29'), 'EVENING_OTHER');
  assert.equal(s('2026-10-07', '15:30'), 'US_OPEN');
  assert.equal(s('2026-10-07', '17:00'), 'US_MID');
  assert.equal(s('2026-10-07', '19:30'), 'US_CLOSE');
  assert.equal(s('2026-10-07', '22:00'), 'EVENING_OTHER');
  assert.equal(s('2026-10-07', '15:44:12'), 'US_OPEN', 'čas i se sekundami');
  // Týdny, kdy USA a Evropa nemají letní čas souběžně: US open je ve 14:30 Berlína.
  assert.equal(s('2026-03-10', '14:30'), 'US_OPEN');
  assert.equal(s('2026-03-10', '13:00'), 'EU_MORNING');
  assert.equal(s('2026-10-28', '14:30'), 'US_OPEN');
  assert.equal(s('2026-10-28', '16:30'), 'US_MID');
});

test('A3: session bez data nebo času null', () => {
  assert.equal(FJContext.sessionOf('', '15:30'), null);
  assert.equal(FJContext.sessionOf('2026-10-07', ''), null);
});

// ------------------------------------------------- společný vstup

test('A3: derivedFields skládá vše a do obchodu nic nezapíše', () => {
  const t = trade({ nearLevels: [{ level: 'VWAP', price: 7801 }, { level: 'VAL', price: 7799 }] });
  const before = JSON.stringify(t);
  const order = FJContext.dayOrder([t]);
  const d = FJContext.derivedFields(t, { tickSize: TICK, dayOrder: order });
  assert.equal(JSON.stringify(t), before, 'obchod se nezměnil');
  assert.equal(d.targetTicks, 16);
  assert.equal(d.nearestAheadTicks, 4);
  assert.equal(d.nearestAheadR, 0.5);
  assert.equal(d.stopBehindTicks, 4);
  assert.equal(d.tradeNoInDay, 1);
  assert.equal(d.session, 'US_MID');
  assert.deepEqual(d.nearLevels, [
    { fromEntry: 4, fromStop: 12, toTarget: 12, position: 'ENTRY_TO_TARGET' },
    { fromEntry: -4, fromStop: 4, toTarget: 20, position: 'STOP_TO_ENTRY' }
  ]);
  const bare = FJContext.derivedFields({ id: 'y' }, {});
  for (const key of ['targetTicks', 'slTicks', 'nearestAheadTicks', 'nearestAheadR', 'stopBehindTicks', 'levelsStopToEntry', 'levelsEntryToTarget',
    'tradeNoInDay', 'prevResultInDay', 'dayPnlBefore', 'session']) {
    assert.equal(bare[key], null, key + ' bez vstupu null');
  }
  assert.deepEqual(bare.nearLevels, []);
});

// ------------------------------------------------- cíl na hladině

test('A3: targetOnLevel podle vlastnosti „je to hladina“ položky slovníku cílů', () => {
  const cfg = { TARGET_LEVEL: { custom: { CUSTOM_FIX_RRR: 'Fix RRR' } } };
  const on = type => FJContext.targetOnLevel(trade({ targetLevel1: { type, price: 7804 } }), cfg);
  assert.equal(on('VAH'), true);
  assert.equal(on('MANUAL_EXIT'), false);
  assert.equal(on('TRAIL_M2'), false);
  assert.equal(on('CUSTOM_FIX_RRR'), false, 'výchozí „ne“ schválené pro Fix RRR');
  assert.equal(on('NEEXISTUJE'), null, 'klíč, který ve slovníku není, nejde posoudit');
  assert.equal(FJContext.targetOnLevel(trade({ targetLevel1: { type: '', price: 7804 } }), cfg), null);
  assert.equal(FJContext.targetOnLevel(trade({ targetLevel1PriceDerived: true }), cfg), false, 'cena dopočtená z výstupu není zadaná hladina');
  const flipped = { TARGET_LEVEL: { custom: { CUSTOM_FIX_RRR: 'Fix RRR' }, isLevel: { CUSTOM_FIX_RRR: true, VAH: false } } };
  assert.equal(FJContext.targetOnLevel(trade({ targetLevel1: { type: 'CUSTOM_FIX_RRR', price: 7804 } }), flipped), true, 'uživatel to přepne v nastavení');
  assert.equal(FJContext.targetOnLevel(trade(), flipped), false);
});
