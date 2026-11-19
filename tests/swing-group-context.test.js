'use strict';
// Kontext před vstupem na skupině limitek (docs/ZADANI_SWING_SLUCOVANI_PRIKAZU.md §3):
// contextFilledAt = kdy byl kontext poprvé vyplněn, úprava po naplnění se označí
// (contextEditedAfterFill) – stejně jako gradeEdited u futures.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../app/order-groups.js');

const T0 = '2026-11-19T10:00:00.000Z', T1 = '2026-11-19T11:00:00.000Z', T2 = '2026-11-20T09:00:00.000Z';
const order = (id, tp) => ({ id, source: 'CTRADER', symbol: 'CHFJPY', direction: 'long', orderType: 'LIMIT', price: 193.5, sl: 192.8, tp, volume: 0.05 });
const base = () => G.planOrderGroups([], [order('ct_1', 194.2), order('ct_2', 195)], { nowIso: T0, account: '1', idGen: () => 'og1' }).groups[0];
const CTX = { swingSetup: 'M2 daily', entryReason: 'odraz od VA hrany', entryTf: '4h', htfTrend: 'nahoru', weeklyCheck: 'OK', entryLevelType: 'VA hrana', grade: 'A', riskAmount: 250, images: ['fjimg://store/d1.webp', 'fjimg://store/h4.webp'], comment: 'čekám na test', targetLevels: { ct_1: 'VPOC 4h', ct_2: 'Gap' } };

test('první vyplnění uloží contextFilledAt, další úprava před naplněním ho nemění a neoznačí', () => {
  const g1 = G.applyGroupContext(base(), CTX, T1);
  assert.equal(g1.contextFilledAt, T1);
  assert.equal(g1.context.entryReason, 'odraz od VA hrany');
  assert.deepEqual(g1.context.targetLevels, { ct_1: 'VPOC 4h', ct_2: 'Gap' });
  assert.ok(!g1.contextEditedAfterFill);
  const g2 = G.applyGroupContext(g1, { ...CTX, comment: 'upraveno' }, T2);
  assert.equal(g2.contextFilledAt, T1, 'čas prvního vyplnění zůstává');
  assert.equal(g2.contextUpdatedAt, T2);
  assert.ok(!g2.contextEditedAfterFill);
  assert.equal(G.groupView(g2).contextFilled, true);
});

test('prázdný kontext = „kontext chybí“, contextFilledAt se nenastaví', () => {
  const g = G.applyGroupContext(base(), { swingSetup: '', images: [], comment: '  ' }, T1);
  assert.equal(g.contextFilledAt, null);
  assert.equal(G.groupView(g).contextFilled, false);
});

test('úprava kontextu skupiny po naplnění → contextEditedAfterFill', () => {
  const g = G.applyGroupContext(base(), CTX, T1);
  g.members[0].state = 'FILLED';
  const same = G.applyGroupContext(g, CTX, T2);
  assert.ok(!same.contextEditedAfterFill, 'uložení beze změny se nepočítá');
  const edited = G.applyGroupContext(g, { ...CTX, grade: 'B' }, T2);
  assert.equal(edited.contextEditedAfterFill, true);
});

test('obchod se zděděným kontextem: změna kontextového pole → contextEditedAfterFill, jiná pole ne', () => {
  const before = { id: 's1', kind: 'SWING', contextFilledAt: T1, ...CTX, exits: [] };
  assert.equal(G.markContextEdit(before, { ...before, exits: [{ price: 1 }] }).contextEditedAfterFill, undefined);
  assert.equal(G.markContextEdit(before, { ...before, images: ['fjimg://store/d1.webp'] }).contextEditedAfterFill, true);
  assert.equal(G.markContextEdit(before, { ...before, entryTf: '1h' }).contextEditedAfterFill, true);
  // obchod bez kontextu ze skupiny se neoznačuje
  const plain = { id: 's2', kind: 'SWING', swingSetup: 'x' };
  assert.equal(G.markContextEdit(plain, { ...plain, swingSetup: 'y' }).contextEditedAfterFill, undefined);
  // jednou označený zůstane označený
  assert.equal(G.markContextEdit({ ...before, contextEditedAfterFill: true }, { ...before, contextEditedAfterFill: true }).contextEditedAfterFill, true);
});
