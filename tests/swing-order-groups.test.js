'use strict';
// Plánovaný obchod = skupina limitek (docs/ZADANI_SWING_SLUCOVANI_PRIKAZU.md §2).
// Testy 1–4 zadání: automatické seskupení, konzervativní neslučování, ruční
// rozdělení přežije synchronizaci, ruční sloučení s upozorněním / zákazem.

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../app/order-groups.js');

const NOW = '2026-11-19T10:00:00.000Z';
const dec = sym => (/JPY$/.test(sym) ? 3 : sym === 'XAUUSD' ? 2 : 5);
let seq = 0;
const opts = (extra = {}) => ({ sources: ['MANUAL', 'CTRADER'], account: '1234567', decimalsOf: dec, nowIso: NOW, idGen: () => 'og_t' + (++seq), ...extra });
const ct = (id, o) => ({ id: 'ct_' + id, source: 'CTRADER', externalId: String(id), symbol: 'USDCHF', direction: 'short', orderType: 'LIMIT', price: 0.8125, sl: 0.8165, tp: 0.8050, volume: 0.075, volumeInUnits: 7500, placedAt: null, expiresAt: null, note: '', ...o });

test('1: dvě limitky se stejnou cenou a SL, jiné TP → 1 skupina, objem = součet', () => {
  const r = G.planOrderGroups([], [ct(1, { tp: 0.8050 }), ct(2, { tp: 0.7990 })], opts());
  assert.equal(r.groups.length, 1);
  const g = r.groups[0];
  assert.equal(g.members.length, 2);
  const v = G.groupView(g);
  assert.equal(v.totalVolume, 0.15);
  assert.deepEqual(v.volumes, [0.075, 0.075]);
  assert.deepEqual(v.tps, [0.8050, 0.7990], 'TP od nejbližšího k ceně vstupu');
  assert.equal(v.count, 2);
  assert.equal(g.account, '1234567');
  // idempotentní: druhý běh nic nezmění
  const r2 = G.planOrderGroups(r.groups, [ct(1, { tp: 0.8050 }), ct(2, { tp: 0.7990 })], opts());
  assert.equal(r2.changed, false);
  assert.equal(r2.groups.length, 1);
});

test('1b: cena se porovná po zaokrouhlení na priceDecimals symbolu; „bez SL“ = shoda', () => {
  const r = G.planOrderGroups([], [ct(1, { price: 0.812500001, sl: null }), ct(2, { price: 0.8125, sl: null, tp: 0.79 })], opts());
  assert.equal(r.groups.length, 1);
});

test('2: rozdílná cena NEBO SL (nebo typ, směr, symbol, účet) → 2 skupiny', () => {
  for (const diff of [{ price: 0.8126 }, { sl: 0.8166 }, { sl: null }, { orderType: 'STOP' }, { direction: 'long' }, { symbol: 'EURCHF' }]) {
    const r = G.planOrderGroups([], [ct(1), ct(2, { tp: 0.79, ...diff })], opts());
    assert.equal(r.groups.length, 2, JSON.stringify(diff));
  }
  // ruční limitka (bez účtu) se se stejnou cTrader limitkou nesloučí
  const manual = { ...ct(9), id: 'po_x', source: 'MANUAL', externalId: null };
  assert.equal(G.planOrderGroups([], [ct(1), manual], opts()).groups.length, 2);
});

test('3: ruční rozdělení přežije další synchronizaci (žádné opětovné sloučení)', () => {
  const live = [ct(1, { tp: 0.8050 }), ct(2, { tp: 0.7990 })];
  const g1 = G.planOrderGroups([], live, opts()).groups;
  const split = G.splitGroup(g1, g1[0].id, opts());
  assert.equal(split.groups.length, 2);
  assert.ok(split.groups.every(g => g.groupManual === true));
  // synchronizace (i s nově přidanou třetí limitkou se stejným klíčem)
  const again = G.planOrderGroups(split.groups, [...live, ct(3, { tp: 0.7950 })], opts());
  const withOld = again.groups.filter(g => g.members.some(m => m.orderId === 'ct_1' || m.orderId === 'ct_2'));
  assert.equal(withOld.length, 2, 'ručně rozdělené zůstanou zvlášť');
  assert.ok(withOld.every(g => g.members.length === 1));
  const third = again.groups.find(g => g.members.some(m => m.orderId === 'ct_3'));
  assert.equal(third.members.length, 1, 'nová limitka se do ručně rozdělené skupiny nepřidá');
  // a ještě jednou – stabilní
  const third2 = G.planOrderGroups(again.groups, [...live, ct(3, { tp: 0.7950 })], opts());
  assert.equal(third2.changed, false);
  assert.equal(third2.groups.length, 3);
});

test('3b: rozdělení nechá kontext u skupiny s nejbližším TP', () => {
  const g = G.planOrderGroups([], [ct(1, { tp: 0.7990 }), ct(2, { tp: 0.8050 })], opts()).groups;
  g[0].context = { swingSetup: 'M2 daily', images: ['fjimg://store/a.webp'] };
  g[0].contextFilledAt = NOW;
  const s = G.splitGroup(g, g[0].id, opts()).groups;
  const near = s.find(x => x.members[0].orderId === 'ct_2');
  const far = s.find(x => x.members[0].orderId === 'ct_1');
  assert.equal(near.context.swingSetup, 'M2 daily');
  assert.equal(near.contextFilledAt, NOW);
  assert.ok(!far.context || !far.context.swingSetup);
});

test('4: ruční sloučení – rozdílný SL / cena = upozornění, rozdílný symbol / směr / účet = nejde', () => {
  const a = G.planOrderGroups([], [ct(1)], opts()).groups[0];
  const b = G.planOrderGroups([], [ct(2, { sl: 0.8170, tp: 0.79 })], opts()).groups[0];
  const chk = G.canMerge([a, b]);
  assert.equal(chk.ok, true);
  assert.ok(chk.warn.includes('sl'));
  const m = G.mergeGroups([a, b], [a.id, b.id], opts());
  assert.equal(m.groups.length, 1);
  assert.equal(m.groups[0].members.length, 2);
  assert.equal(m.groups[0].groupManual, true);

  const c = G.planOrderGroups([], [ct(3, { price: 0.8130 })], opts()).groups[0];
  assert.ok(G.canMerge([a, c]).warn.includes('price'));

  for (const diff of [{ symbol: 'EURCHF' }, { direction: 'long' }]) {
    const x = G.planOrderGroups([], [ct(4, diff)], opts()).groups[0];
    const r = G.canMerge([a, x]);
    assert.equal(r.ok, false, JSON.stringify(diff));
    assert.throws(() => G.mergeGroups([a, x], [a.id, x.id], opts()));
  }
  const other = G.planOrderGroups([], [ct(5)], opts({ account: '999' })).groups[0];
  assert.equal(G.canMerge([a, other]).ok, false);
  assert.equal(G.canMerge([a, other]).block, 'account');
});

test('4b: sloučení dvou skupin s vyplněným kontextem nejde (kontext by se ztratil)', () => {
  const a = G.planOrderGroups([], [ct(1)], opts()).groups[0];
  const b = G.planOrderGroups([], [ct(2, { sl: 0.8170 })], opts()).groups[0];
  a.context = { comment: 'a' }; a.contextFilledAt = NOW;
  b.context = { comment: 'b' }; b.contextFilledAt = NOW;
  assert.equal(G.canMerge([a, b]).block, 'context');
  // s jedním kontextem jde a kontext zůstane
  delete b.context; delete b.contextFilledAt;
  const m = G.mergeGroups([a, b], [b.id, a.id], opts());
  assert.equal(m.groups[0].context.comment, 'a');
});

test('synchronizace nepřepíše kontext ani ruční seskupení; změna TP se promítne do snímku', () => {
  const g = G.planOrderGroups([], [ct(1), ct(2, { tp: 0.79 })], opts()).groups;
  g[0].context = { comment: 'před vstupem', images: ['fjimg://store/x.webp'] };
  g[0].contextFilledAt = NOW;
  const r = G.planOrderGroups(g, [ct(1, { tp: 0.8040 }), ct(2, { tp: 0.79 })], opts());
  assert.equal(r.changed, true);
  assert.equal(r.groups[0].members.find(m => m.orderId === 'ct_1').tp, 0.8040);
  assert.deepEqual(r.groups[0].context, { comment: 'před vstupem', images: ['fjimg://store/x.webp'] });
});

test('zmizelá limitka: ruční i cTrader → GONE; zdroj, který teď není k dispozici, se nemění', () => {
  const manual = { ...ct(9), id: 'po_x', source: 'MANUAL', externalId: null };
  const g = G.planOrderGroups([], [ct(1), manual], opts()).groups;
  // cTrader neodpovídá → jen ruční zdroj
  const r = G.planOrderGroups(g, [], opts({ sources: ['MANUAL'] }));
  const byOrder = id => r.groups.flatMap(x => x.members).find(m => m.orderId === id);
  assert.equal(byOrder('ct_1').state, 'PENDING');
  assert.equal(byOrder('po_x').state, 'GONE');
  assert.equal(byOrder('po_x').goneAt, NOW);
});

test('migrace: každý dosavadní ruční příkaz se zařadí do skupiny podle §2.1, idempotentně', () => {
  const data = { pendingOrders: [
    { id: 'po_1', source: 'MANUAL', symbol: 'EURJPY', direction: 'long', orderType: 'LIMIT', price: 176.95, sl: 176.57, tp: 177.6, volume: 0.1, placedAt: '2026-11-18T09:00' },
    { id: 'po_2', source: 'MANUAL', symbol: 'EURJPY', direction: 'long', orderType: 'LIMIT', price: 176.95, sl: 176.57, tp: 178.2, volume: 0.1, placedAt: '2026-11-18T09:01' },
    { id: 'po_3', source: 'MANUAL', symbol: 'XAUUSD', direction: 'short', orderType: 'LIMIT', price: 4093.26, sl: 4172.46, tp: 3980.95, volume: 0.02, placedAt: '2026-11-18T09:05' }
  ] };
  const m = G.migratePendingOrders(data, opts());
  assert.equal(m.orderGroups.length, 2);
  assert.equal(m.orderGroupsVersion, G.ORDER_GROUPS_VERSION);
  assert.equal(m.orderGroups.find(g => g.symbol === 'EURJPY').members.length, 2);
  assert.equal(m.orderGroups.every(g => g.account === null), true, 'ruční limitky nemají účet');
  const again = G.migratePendingOrders({ ...data, ...m }, opts());
  assert.equal(again.skipped, true);
});

test('pohled na skupinu: rozpad objemu, zdroj, kontext vyplněn / chybí', () => {
  const g = G.planOrderGroups([], [ct(1, { volume: 0.1 }), ct(2, { tp: 0.79, volume: 0.05 })], opts()).groups[0];
  const v = G.groupView(g);
  assert.equal(v.totalVolume, 0.15);
  assert.deepEqual(v.volumes, [0.1, 0.05]);
  assert.deepEqual(v.sources, ['CTRADER']);
  assert.equal(v.contextFilled, false);
  assert.equal(v.status, 'PENDING');
  g.context = { swingSetup: 'Gap jako SR' }; g.contextFilledAt = NOW;
  assert.equal(G.groupView(g).contextFilled, true);
});

test('orderGroups a orderGroupsVersion přežijí readJournal() a zápis (whitelist main.js)', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { loadMain } = require('./helpers/extract');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-order-groups-'));
  try {
    const main = loadMain(['safeJournalId', 'journalPath', 'readJournal', 'writeJournalFile'], {
      fs, path, dataRoot: () => root, defaultJournalData: () => ({ trades: [], settings: [] }),
      deflateJournalImages: () => 0, remapRenamedImages: () => 0,
      backupJournalFile: () => { throw new Error('záloha se tu dělat nemá'); }, logInfo: () => {}
    });
    const groups = G.planOrderGroups([], [ct(1), ct(2, { tp: 0.79 })], opts()).groups;
    main.writeJournalFile('j1', { trades: [], settings: [], orderGroups: groups, orderGroupsVersion: 1 });
    const r = main.readJournal('j1');
    assert.deepEqual(JSON.parse(JSON.stringify(r.orderGroups)), JSON.parse(JSON.stringify(groups)));
    assert.equal(r.orderGroupsVersion, 1);
    main.writeJournalFile('j2', { trades: [], settings: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(main.readJournal('j2').orderGroups)), []);
    assert.equal(main.readJournal('j2').orderGroupsVersion, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
