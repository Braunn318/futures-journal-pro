'use strict';
// AKCEPTAČNÍ KRITÉRIUM (spec §1.1, revize 12. 9. 2026):
//
//   Identita `pointsTotal × hodnota bodu − provize == pnlRaw` musí platit pro
//   každý NOVĚ vytvořený obchod.
//
// Historická data se neopravují – ta jen dostanou příznak
// `legacyPointsConvention` a vypadnou ze statistik podle R (viz
// tests/points-identity.test.js). Tenhle soubor hlídá to, co blokuje start
// sběru dat: aby každý obchod, který vznikne ode dneška, měl body jednoznačné.
//
// Adam obchoduje 2 MES kontrakty, takže se to týká doslova každého backtest
// obchodu – bez toho by R vyšlo dvakrát vyšší.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJPoints = require('../app/points.js');

const POINT_VALUE = 5;
const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: POINT_VALUE, defaultCommission: 1.9 }],
  breakEvenEnabled: true,
  breakEvenThreshold: 5,
  useConnectorCommission: false,
  autoMergeLegs: true
};

const NAMES = [
  'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
  'getDefaultCommissionForInstrument', 'classifyResult', 'signed', 'tradeTotalPoints',
  'tradePointsTotal', 'displayPointsTotal', 'weightedExitFields', 'legFromTrade',
  'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'combineTradeObjects', 'mapCapturedTrade',
  'migrateTradePointsFields', 'hasReliablePoints'
];

function renderer() {
  return loadRenderer(NAMES, { settings: SETTINGS, Date });
}

// Ověří obě identity z §9 nad jedním obchodem.
function assertIdentity(trade, label) {
  const commission = Math.abs(Number(trade.commission) || 0);
  const net = Number(trade.pnlRaw);
  const contracts = FJPoints.contractsOf(trade);

  assert.ok(trade.pointsTotal != null, `${label}: nový obchod musí mít pointsTotal`);
  assert.ok(trade.pointsPerContract != null, `${label}: nový obchod musí mít pointsPerContract`);

  const gross = Math.abs(net + commission);
  assert.ok(
    Math.abs(Math.abs(trade.pointsTotal) * POINT_VALUE - gross) <= 0.01,
    `${label}: pointsTotal ${trade.pointsTotal} × ${POINT_VALUE} = ${(trade.pointsTotal * POINT_VALUE).toFixed(2)} nesedí na hrubý výsledek ${gross.toFixed(2)}`
  );
  assert.ok(
    Math.abs(trade.pointsPerContract * contracts - trade.pointsTotal) <= 0.0001,
    `${label}: pointsPerContract × contracts (${trade.pointsPerContract} × ${contracts}) se nerovná pointsTotal ${trade.pointsTotal}`
  );
}

// Událost, jakou posílá NinjaTrader konektor po uzavření pozice.
function closedEvent(overrides) {
  return {
    id: 'ev-' + Math.random().toString(16).slice(2),
    type: 'trade_closed',
    account: 'Playback101',
    instrument: 'MES',
    instrumentFull: 'MES 12-26',
    side: 'long',
    entryTime: '2026-09-12T16:00:00.000Z',
    exitTime: '2026-09-12T16:05:00.000Z',
    entryPrice: 7700,
    exitPrice: 7703,
    quantity: 2,
    points: 3,          // konektor posílá body NA KONTRAKT
    grossPnl: 30,       // 3 body × 5 × 2 kontrakty
    commission: 7.6,
    pnl: 22.4,
    result: 'target',
    pointValue: POINT_VALUE,
    positionId: 'pos-' + Math.random().toString(16).slice(2),
    ...overrides
  };
}

test('import z konektoru: dvoukontraktová pozice má pointsTotal dvojnásobek bodů na kontrakt', () => {
  const r = renderer();
  const trade = r.mapCapturedTrade(closedEvent(), [], SETTINGS);

  assert.equal(trade.contracts, 2);
  assert.equal(trade.pointsPerContract, 3, 'pohyb ceny je 3 body na kontrakt');
  assert.equal(trade.pointsTotal, 6, 'pozice udělala 6 bodů celkem');
  assert.equal(trade.commission, 3.8, 'provize ze šablony: 1.90 × 2');
  assert.equal(trade.pnlRaw, 26.2, '30 hrubého − 3.80 provize');
  assertIdentity(trade, 'import 2 kontrakty');
  assert.equal(r.displayPointsTotal(trade), 6, 'zobrazuje se celkových 6 bodů');
  assert.ok(r.hasReliablePoints(trade), 'nový obchod není legacy');
});

test('import z konektoru: jeden kontrakt – total i na kontrakt jsou totožné', () => {
  const r = renderer();
  const trade = r.mapCapturedTrade(closedEvent({ quantity: 1, grossPnl: 15, commission: 3.8, pnl: 11.2 }), [], SETTINGS);

  assert.equal(trade.pointsPerContract, 3);
  assert.equal(trade.pointsTotal, 3);
  assert.equal(trade.commission, 1.9);
  assertIdentity(trade, 'import 1 kontrakt');
});

test('import z konektoru: ztráta má body kladné a P/L záporné', () => {
  const r = renderer();
  const trade = r.mapCapturedTrade(closedEvent({
    exitPrice: 7696, points: 4, grossPnl: -40, pnl: -47.6, result: 'stoploss'
  }), [], SETTINGS);

  assert.equal(trade.pointsTotal, 8, '4 body na kontrakt × 2 kontrakty');
  assert.equal(trade.pnlRaw, -43.8, '−40 hrubého − 3.80 provize');
  assert.equal(r.displayPointsTotal(trade), -8, 'znaménko nese výsledek obchodu');
  assertIdentity(trade, 'import ztráta');
});

test('sloučení víc cílů: identita platí i po merge, včetně nohy o víc kontraktech', () => {
  const r = renderer();
  // TP1 zavře 2 kontrakty po 3 bodech (30 hrubého), TP2 jeden kontrakt po 5 bodech (25 hrubého).
  const tp1 = r.mapCapturedTrade(closedEvent({ positionId: 'pos-x', quantity: 2, points: 3, grossPnl: 30, exitPrice: 7703 }), [], SETTINGS);
  const tp2 = r.mapCapturedTrade(closedEvent({ positionId: 'pos-x', quantity: 1, points: 5, grossPnl: 25, exitPrice: 7705, exitTime: '2026-09-12T16:09:00.000Z' }), [], SETTINGS);

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.equal(merged.contracts, 3);
  assert.equal(merged.pointsTotal, 11, '3×2 + 5×1 = 11 bodů');
  assert.equal(merged.commission, 5.7, '3.80 + 1.90');
  assert.equal(merged.pnlRaw, 49.3, '26.20 + 23.10');
  assertIdentity(merged, 'sloučený obchod');
});

test('sloučení víc cílů: každá noha po jednom kontraktu', () => {
  const r = renderer();
  const tp1 = r.mapCapturedTrade(closedEvent({ positionId: 'pos-y', quantity: 1, points: 3, grossPnl: 15, exitPrice: 7703 }), [], SETTINGS);
  const tp2 = r.mapCapturedTrade(closedEvent({ positionId: 'pos-y', quantity: 1, points: 5, grossPnl: 25, exitPrice: 7705, exitTime: '2026-09-12T16:09:00.000Z' }), [], SETTINGS);

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.equal(merged.contracts, 2);
  assert.equal(merged.pointsTotal, 8);
  assert.equal(merged.pointsPerContract, 4);
  assertIdentity(merged, 'sloučený obchod, 1 kontrakt na nohu');
});

test('breakeven: nulový pohyb ceny, provize jako náklad, identita platí', () => {
  const r = renderer();
  const trade = r.mapCapturedTrade(closedEvent({
    exitPrice: 7700, points: 0, grossPnl: 0, pnl: -7.6, result: 'stoploss'
  }), [], SETTINGS);

  assert.equal(trade.result, 'breakeven', 'práh ±$5 z toho dělá breakeven');
  assert.equal(trade.pointsTotal, 0);
  assert.equal(trade.pnlRaw, -3.8, 'provize se odečítá, nepřičítá');
  assertIdentity(trade, 'breakeven');
});

test('nový obchod nedostane příznak legacy a starý ho dostane', () => {
  const r = renderer();
  const fresh = r.mapCapturedTrade(closedEvent(), [], SETTINGS);
  assert.equal(r.migrateTradePointsFields(fresh), null, 'nový obchod už jednoznačná pole má, migrace ho nemění');

  const legacy = { instrument: 'MES', date: '2026-08-20', entryTime: '14:57', points: 2.5, contracts: 2, commission: 3.8, pnlRaw: 21.2, pnl: 21.2, result: 'target' };
  // Porovnává se po položkách: objekt vzniká v jiném realmu (node:vm), takže
  // deepStrictEqual by selhal na prototypu, ne na obsahu.
  const patch = r.migrateTradePointsFields(legacy);
  assert.equal(Object.keys(patch).length, 1);
  assert.equal(patch.legacyPointsConvention, true);
  assert.ok(!r.hasReliablePoints({ ...legacy, legacyPointsConvention: true }), 'legacy obchod nepatří do statistik podle R');
  // Zobrazená hodnota u starého obchodu zůstává původní – historie se neopravuje.
  assert.equal(r.displayPointsTotal({ ...legacy, legacyPointsConvention: true }), 2.5);
});
