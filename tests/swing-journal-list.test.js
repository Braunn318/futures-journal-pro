'use strict';
// Deník swing deníku ukazuje jen uzavřené obchody; otevřené pozice a limitky jsou v Pozice/Příkazy,
// nenaplněné setupy jen s přepínačem (FJSwing.journalListRows).
const test = require('node:test');
const assert = require('node:assert/strict');
const FJSwing = require('../app/swing.js');

const CLOSED = { id: 'c1', kind: 'SWING', symbol: 'EURUSD', direction: 'long', openedAt: '2026-11-02T09:15', entryPrice: 1.1, volume: 1, swingSetup: 'M2 daily',
  exits: [{ closedAt: '2026-11-03T14:00', price: 1.105, volume: 1, pnl: 500 }] };
const CLOSED2 = { id: 'c2', kind: 'SWING', symbol: 'USDCHF', direction: 'long', openedAt: '2026-11-24T11:48', entryPrice: 0.84, volume: 0.2, comment: 'LVN dole',
  exits: [{ closedAt: '2026-11-24T17:16', price: 0.835, volume: 0.2, pnl: -130 }] };
const OPEN = { id: 'o1', kind: 'SWING', symbol: 'US100.CASH', direction: 'short', openedAt: '2026-11-27T03:39', entryPrice: 26602, volume: 0.14 };
const OPEN_PARTIAL = { id: 'o2', kind: 'SWING', symbol: 'GBPUSD', direction: 'long', openedAt: '2026-11-04T11:00', entryPrice: 1.3, volume: 0.2, orderGroupId: 'g1',
  exits: [{ closedAt: '2026-11-05T09:00', price: 1.305, volume: 0.1, pnl: 50 }] };
const SETUP = { id: 's1', kind: 'SWING', recordType: 'SETUP_ONLY', fillStatus: 'NO_FILL', symbol: 'USDJPY', direction: 'short', openedAt: '2026-11-10T07:00' };
const FUT = { id: 'f1', instrument: 'NQ', date: '2026-11-03' };
const ALL = [OPEN, CLOSED, SETUP, OPEN_PARTIAL, CLOSED2, FUT];
const ids = rows => rows.map(t => t.id);

test('jen uzavřené obchody, od nejnovějšího otevření', () => {
  assert.deepEqual(ids(FJSwing.journalListRows(ALL)), ['c2', 'c1']);
});
test('otevřená i částečně uzavřená pozice (i z limitek) do Deníku nepatří', () => {
  const r = ids(FJSwing.journalListRows(ALL, { showSetups: true }));
  assert.ok(!r.includes('o1') && !r.includes('o2'));
});
test('nenaplněný setup jen s přepínačem', () => {
  assert.deepEqual(ids(FJSwing.journalListRows(ALL, { showSetups: true })), ['c2', 's1', 'c1']);
  assert.ok(!ids(FJSwing.journalListRows(ALL, { showSetups: false })).includes('s1'));
});
test('hledání v symbolu, komentáři a setupu', () => {
  assert.deepEqual(ids(FJSwing.journalListRows(ALL, { query: 'lvn' })), ['c2']);
  assert.deepEqual(ids(FJSwing.journalListRows(ALL, { query: 'm2 DAILY' })), ['c1']);
  assert.deepEqual(ids(FJSwing.journalListRows(ALL, { query: 'us100' })), []);
});
test('futures záznamy a prázdný vstup', () => {
  assert.deepEqual(FJSwing.journalListRows(null), []);
  assert.ok(!ids(FJSwing.journalListRows(ALL)).includes('f1'));
});
