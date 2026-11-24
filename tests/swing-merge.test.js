'use strict';
// Slučování swing obchodů se stejným vstupem i bez skupiny limitek a i u uzavřených obchodů
// (4.8.105): app/swing-merge.js + planMcpSync nad obchodem s víc pozicemi.
const test = require('node:test');
const assert = require('node:assert/strict');
const FJSwing = require('../app/swing.js');
const M = require('../app/swing-merge.js');

const plain = v => JSON.parse(JSON.stringify(v));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const lotSizeOf = () => 100000;
const decimalsOf = sym => (/JPY/.test(sym) ? 3 : 5);
const opts = extra => ({ lotSizeOf, nowLocal: '2026-11-24T10:00', nowIso: '2026-11-24T09:00:00.000Z', ...extra });

// EURJPY z deníku uživatele: dvě pozice 0,13 na 175,000, otevřené 01:54 a 01:55, obě zavřené 10:02
const HIST = [
  { positionId: 701, symbolName: 'EURJPY', side: 'Sell', volume: 13000, entryPrice: 175.0, closePrice: 175.6, grossProfit: -48.82, netProfit: -49.83, swap: 0, commission: -1.01, openTime: '2026-11-19T00:54:10.000Z', closeTime: '2026-11-19T09:02:00.000Z' },
  { positionId: 702, symbolName: 'EURJPY', side: 'Sell', volume: 13000, entryPrice: 175.0, closePrice: 175.6, grossProfit: -48.82, netProfit: -49.83, swap: 0, commission: -1.01, openTime: '2026-11-19T00:55:20.000Z', closeTime: '2026-11-19T09:02:01.000Z' }
];
const synced = () => FJSwing.planMcpSync([], { positions: [], history: HIST }, opts()).trades;

test('EURJPY: dva uzavřené obchody → jeden (objem součtem, vstup, 2 nohy, netto součtem, otevřeno nejdřív)', () => {
  const rows = synced();
  assert.equal(rows.length, 2);
  const clusters = M.planAutoMerge(rows, { windowMin: 5, decimalsOf });
  assert.deepEqual(clusters.map(c => c.length), [2]);
  const r = M.applyAutoMerge(rows, { windowMin: 5, decimalsOf, nowIso: '2026-11-24T09:00:00.000Z' });
  assert.equal(r.merged, 1);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  near(t.volume, 0.26);
  near(t.entryPrice, 175.0);
  assert.equal(t.exits.length, 2);
  assert.deepEqual(t.ctraderPositionIds.sort(), ['ctrader-701', 'ctrader-702']);
  assert.equal(t.openedAt, FJSwing.planMcpSync([], { positions: [], history: [HIST[0]] }, opts()).trades[0].openedAt);
  const d = FJSwing.swingDerived(t, { symbol: 'EURJPY', pipSize: 0.01, priceDecimals: 3 });
  near(d.pnlNetTotal, -99.66, 1e-6);
  assert.equal(d.status, 'CLOSED');
  assert.equal(t.mergedFrom.length, 2);
  assert.equal(t.mergedAuto, true);
});

test('automatika je idempotentní a synchronizace nad sloučeným obchodem nic nezdvojí', () => {
  const once = M.applyAutoMerge(synced(), { windowMin: 5, decimalsOf }).trades;
  const again = M.applyAutoMerge(once, { windowMin: 5, decimalsOf });
  assert.equal(again.changed, false);
  const p = FJSwing.planMcpSync(once, { positions: [], history: HIST }, opts());
  assert.equal(p.created, 0);
  assert.equal(p.trades.length, 1);
  assert.equal(p.trades[0].exits.length, 2);
  near(p.trades[0].volume, 0.26);
});

test('neslučuje: jiná cena, jiný směr, jiný účet, otevření dál než okno', () => {
  const base = synced();
  const mod = (i, f) => base.map((t, k) => (k === i ? { ...t, ...f } : t));
  assert.equal(M.planAutoMerge(mod(1, { entryPrice: 175.01 }), { windowMin: 5, decimalsOf }).length, 0);
  assert.equal(M.planAutoMerge(mod(1, { direction: 'long' }), { windowMin: 5, decimalsOf }).length, 0);
  assert.equal(M.planAutoMerge(mod(0, { ctraderAccountId: '1' }).map((t, k) => (k === 1 ? { ...t, ctraderAccountId: '2' } : t)), { windowMin: 5, decimalsOf }).length, 0);
  assert.equal(M.planAutoMerge(mod(1, { openedAt: '2026-11-19T02:30' }), { windowMin: 5, decimalsOf }).length, 0);
  // ručně zadané obchody (bez pozice) automatika nebere
  assert.equal(M.planAutoMerge(base.map(t => ({ ...t, positionId: undefined, ctraderPositionIds: undefined })), { windowMin: 5, decimalsOf }).length, 0);
});

test('rozdělení vrátí původní obchody a automatika je znovu nespojí; ruční sloučení ano', () => {
  const merged = M.applyAutoMerge(synced(), { windowMin: 5, decimalsOf }).trades;
  const s = M.splitSwingTrade(merged, merged[0].id);
  assert.ok(s.ok);
  assert.equal(s.trades.length, 2);
  for (const t of s.trades) { assert.equal(t.exits.length, 1); near(t.volume, 0.13); assert.equal(t.mergedFrom, undefined); }
  assert.equal(M.applyAutoMerge(s.trades, { windowMin: 5, decimalsOf }).changed, false);
  // synchronizace po rozdělení nevytvoří nic nového ani nepřidá nohy
  const p = FJSwing.planMcpSync(s.trades, { positions: [], history: HIST }, opts());
  assert.equal(p.created, 0);
  assert.equal(p.trades.length, 2);
  const m = M.mergeSwingTrades(s.trades, s.ids);
  assert.ok(m.ok);
  assert.equal(m.trades.length, 1);
  assert.equal(m.trades[0].exits.length, 2);
});

test('ruční sloučení: kontext cíle vyhrává, prázdné se doplní, ruční vstup přežije synchronizaci', () => {
  const rows = synced();
  rows[0] = { ...rows[0], grade: 'B', comment: 'první' };
  rows[1] = { ...rows[1], grade: 'A', entryReason: 'M2 4H', comment: 'druhý' };
  const m = M.mergeSwingTrades(rows, rows.map(t => t.id));
  const t = m.trades[0];
  assert.equal(t.grade, 'B');
  assert.equal(t.entryReason, 'M2 4H');
  assert.equal(t.comment, 'první\ndruhý');
  const edited = [{ ...t, entryPrice: 174.99 }];
  const p = FJSwing.planMcpSync(edited, { positions: [], history: HIST }, opts());
  assert.equal(p.trades[0].entryPrice, 174.99);
});

test('blokace ručního sloučení: symbol, směr, setup', () => {
  const rows = synced();
  assert.equal(M.mergeSwingTrades([rows[0], { ...rows[1], symbol: 'EURUSD' }], rows.map(t => t.id)).block, 'symbol');
  assert.equal(M.mergeSwingTrades([rows[0], { ...rows[1], direction: 'long' }], rows.map(t => t.id)).block, 'direction');
  assert.equal(M.mergeSwingTrades([rows[0], { ...rows[1], recordType: 'SETUP_ONLY' }], rows.map(t => t.id)).block, 'setup');
  assert.equal(M.mergeSwingTrades(rows, [rows[0].id]).block, 'count');
});

test('otevřený sloučený obchod: synchronizace nepřepíše objem jednou pozicí a nezaloží druhý obchod', () => {
  const pos = (id, sec) => ({ id, symbolName: 'EURJPY', tradeSide: 'Sell', volumeInUnits: 13000, volumeInLots: 0.13, lotSize: 100000, entryPrice: 175.0,
    stopLossPrice: 175.8, takeProfitPrice: 173, openTime: `2026-11-19T00:5${sec}:00.000Z` });
  const data = { positions: [pos(801, 4), pos(802, 5)], history: [] };
  const rows = FJSwing.planMcpSync([], data, opts()).trades;
  const merged = M.applyAutoMerge(rows, { windowMin: 5, decimalsOf }).trades;
  assert.equal(merged.length, 1);
  const p = FJSwing.planMcpSync(merged, data, opts());
  assert.equal(p.trades.length, 1);
  near(p.trades[0].volume, 0.26);
  assert.equal(p.created, 0);
  assert.equal(FJSwing.status(p.trades[0]), 'OPEN');
  // jedna pozice se zavře → noha se přidá, objem zůstává 0,26
  const hist = [{ positionId: 802, symbolName: 'EURJPY', side: 'Sell', volume: 13000, entryPrice: 175.0, closePrice: 174, grossProfit: 80, netProfit: 79, swap: 0, commission: -1, openTime: '2026-11-19T00:55:00.000Z', closeTime: '2026-11-20T09:00:00.000Z' }];
  const p2 = FJSwing.planMcpSync(p.trades, { positions: [pos(801, 4)], history: hist }, opts());
  assert.equal(p2.trades.length, 1);
  assert.equal(p2.trades[0].exits.length, 1);
  near(p2.trades[0].volume, 0.26);
  assert.equal(FJSwing.status(p2.trades[0]), 'OPEN');
  assert.ok(plain(p2.trades[0]));
});
