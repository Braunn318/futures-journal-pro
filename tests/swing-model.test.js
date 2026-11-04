'use strict';
// Swingový CFD deník – datový model a dopočty (docs/ZADANI_SWING_CFD.md §4, testy 1–8 z §11).
// Peníze z brokera, R z cen: R se počítá z pipů na jednotku, nikdy z peněz ani z objemu.
const test = require('node:test');
const assert = require('node:assert/strict');
const FJSwing = require('../app/swing.js');

const EURUSD = { symbol: 'EURUSD', pipSize: 0.0001, priceDecimals: 5 };
const USDJPY = { symbol: 'USDJPY', pipSize: 0.01, priceDecimals: 3 };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function trade(over = {}) {
  return {
    kind: 'SWING', symbol: 'EURUSD', direction: 'long',
    openedAt: '2026-11-03T10:00', entryPrice: 1.1000, volume: 1, slInitial: 1.0950,
    exits: [], slMoves: [], ...over
  };
}

test('1: pnlNet = pnl + swap + commission, se znaménkem, bez abs()', () => {
  assert.equal(FJSwing.legPnlNet({ pnl: 100, swap: 2.5, commission: -7 }), 95.5);
  assert.equal(FJSwing.legPnlNet({ pnl: -50, swap: -1.2, commission: -3.5 }), -54.7);
  // kladná provize (rabat) se přičte, ne odečte
  assert.equal(FJSwing.legPnlNet({ pnl: 10, swap: 0, commission: 1 }), 11);
  // prázdný swap / komise = 0, prázdný pnl = null (neznámý)
  assert.equal(FJSwing.legPnlNet({ pnl: 10 }), 10);
  assert.equal(FJSwing.legPnlNet({ swap: 1, commission: -1 }), null);
  const d = FJSwing.swingDerived(trade({ exits: [
    { closedAt: '2026-11-04T10:00', price: 1.1050, volume: 0.5, pnl: 250, swap: -1, commission: -3.5 },
    { closedAt: '2026-11-05T10:00', price: 1.1100, volume: 0.5, pnl: 500, swap: -2, commission: -3.5 }
  ] }), EURUSD);
  near(d.pnlNetTotal, 740);
  near(d.swapTotal, -3);
  near(d.commissionTotal, -7);
});

test('2: rPrice long i short, EURUSD i JPY pár, vážený průměr přes nohy', () => {
  // long EURUSD: SL 50 pipů, výstup +100 pipů → 2R
  const longEur = FJSwing.swingDerived(trade({ exits: [{ closedAt: '2026-11-04T10:00', price: 1.1100, volume: 1 }] }), EURUSD);
  near(longEur.slPips, 50, 1e-6);
  near(longEur.pipsPerUnit, 100, 1e-6);
  near(longEur.rPrice, 2, 1e-9);
  // short USDJPY: vstup 150.00, SL 150.50 (50 pipů), výstup 149.25 (+75 pipů) → 1.5R
  const shortJpy = FJSwing.swingDerived(trade({
    symbol: 'USDJPY', direction: 'short', entryPrice: 150.00, slInitial: 150.50,
    exits: [{ closedAt: '2026-11-04T10:00', price: 149.25, volume: 1 }]
  }), USDJPY);
  near(shortJpy.slPips, 50, 1e-6);
  near(shortJpy.pipsPerUnit, 75, 1e-6);
  near(shortJpy.rPrice, 1.5, 1e-9);
  // dvě nohy s různým objemem: 0.3 lotu na +50 pipech, 0.7 lotu na +100 → 85 pipů / 50 = 1.7R
  const legs = FJSwing.swingDerived(trade({ exits: [
    { closedAt: '2026-11-04T10:00', price: 1.1050, volume: 0.3 },
    { closedAt: '2026-11-06T10:00', price: 1.1100, volume: 0.7 }
  ] }), EURUSD);
  near(legs.pipsPerUnit, 85, 1e-6);
  near(legs.rPrice, 1.7, 1e-9);
});

test('3: rPrice nezávisí na objemu ani na penězích', () => {
  const mk = (volume, pnl) => FJSwing.swingDerived(trade({ volume, exits: [{ closedAt: '2026-11-04T10:00', price: 1.1100, volume, pnl }] }), EURUSD).rPrice;
  near(mk(0.1, 100), mk(1.0, 9999));
  near(mk(0.1, 100), 2);
});

test('4: posun SL na BE nezmění rPrice (základ je slInitial)', () => {
  const base = { exits: [{ closedAt: '2026-11-05T10:00', price: 1.1100, volume: 1 }] };
  const without = FJSwing.swingDerived(trade(base), EURUSD);
  const withBe = FJSwing.swingDerived(trade({ ...base, slMoves: [{ at: '2026-11-04T09:00', price: 1.1000, reason: 'BE' }] }), EURUSD);
  near(withBe.rPrice, without.rPrice);
  assert.equal(withBe.currentSl, 1.1000);
  assert.equal(withBe.slInitial, 1.0950);
});

test('5: status – částečný výstup OPEN, plný CLOSED; closedAt podle poslední nohy', () => {
  const partial = FJSwing.swingDerived(trade({ exits: [{ closedAt: '2026-11-04T10:00', price: 1.1050, volume: 0.5 }] }), EURUSD);
  assert.equal(partial.status, 'OPEN');
  assert.equal(partial.closedAt, null);
  assert.equal(partial.rPrice, null, 'R z ceny jen u CLOSED');
  near(partial.remainingVolume, 0.5);
  const full = FJSwing.swingDerived(trade({ exits: [
    { closedAt: '2026-11-06T15:00', price: 1.1100, volume: 0.5 },
    { closedAt: '2026-11-04T10:00', price: 1.1050, volume: 0.5 }
  ] }), EURUSD);
  assert.equal(full.status, 'CLOSED');
  assert.equal(full.closedAt, '2026-11-06T15:00');
  assert.equal(FJSwing.swingDerived(trade(), EURUSD).status, 'OPEN');
  // plovoucí čísla: 0.1 + 0.2 lotu = 0.3 → CLOSED
  assert.equal(FJSwing.swingDerived(trade({ volume: 0.3, exits: [
    { closedAt: '2026-11-04T10:00', price: 1.1, volume: 0.1 }, { closedAt: '2026-11-04T11:00', price: 1.1, volume: 0.2 }] }), EURUSD).status, 'CLOSED');
});

test('6: exitsVolumeError – součet nohou nad objem je chyba (uložení se neblokuje)', () => {
  assert.equal(FJSwing.exitsVolumeError(trade({ exits: [{ volume: 0.6 }, { volume: 0.5 }] })), true);
  assert.equal(FJSwing.exitsVolumeError(trade({ exits: [{ volume: 0.5 }, { volume: 0.5 }] })), false);
});

test('7: nightsHeld přes víkend pá → po = 3; holdingDays na 1 desetinné místo', () => {
  const d = FJSwing.swingDerived(trade({ openedAt: '2026-11-06T16:00', exits: [{ closedAt: '2026-11-09T10:00', price: 1.11, volume: 1 }] }), EURUSD);
  assert.equal(d.nightsHeld, 3);
  near(d.holdingHours, 66);
  assert.equal(d.holdingDays, 2.8);
  // stejný den = 0 nocí; přes přechod na zimní čas (25. 10. 2026) se počítají kalendářní půlnoci Berlína
  assert.equal(FJSwing.swingDerived(trade({ openedAt: '2026-11-06T09:00', exits: [{ closedAt: '2026-11-06T18:00', price: 1.11, volume: 1 }] }), EURUSD).nightsHeld, 0);
  assert.equal(FJSwing.swingDerived(trade({ openedAt: '2026-10-24T22:00', exits: [{ closedAt: '2026-10-26T01:00', price: 1.11, volume: 1 }] }), EURUSD).nightsHeld, 2);
  // otevřená pozice počítá do teď
  const open = FJSwing.swingDerived(trade({ openedAt: '2026-11-06T16:00' }), EURUSD, Date.parse('2026-11-07T15:00:00Z'));
  near(open.holdingHours, 24);
});

test('8: slSlippagePips u výstupu na SL přes gap; počítá se z posledního platného SL', () => {
  // long, SL 1.0950, víkendový gap → výstup 1.0930 = −20 pipů za SL
  const gap = FJSwing.swingDerived(trade({ exits: [{ closedAt: '2026-11-09T00:05', price: 1.0930, volume: 1, reason: 'SL' }] }), EURUSD);
  near(gap.slSlippagePips, -20, 1e-6);
  // SL posunutý na BE před výstupem: výstup 1.0995 → −5 pipů proti BE
  const be = FJSwing.swingDerived(trade({
    slMoves: [{ at: '2026-11-04T09:00', price: 1.1000, reason: 'BE' }],
    exits: [{ closedAt: '2026-11-05T10:00', price: 1.0995, volume: 1, reason: 'SL' }]
  }), EURUSD);
  near(be.slSlippagePips, -5, 1e-6);
  // posun SL až PO výstupu se nepočítá
  const late = FJSwing.swingDerived(trade({
    slMoves: [{ at: '2026-11-06T09:00', price: 1.1000, reason: 'BE' }],
    exits: [{ closedAt: '2026-11-05T10:00', price: 1.0945, volume: 1, reason: 'SL' }]
  }), EURUSD);
  near(late.slSlippagePips, -5, 1e-6);
  // bez SL nohy null
  assert.equal(FJSwing.swingDerived(trade({ exits: [{ closedAt: '2026-11-05T10:00', price: 1.11, volume: 1, reason: 'TARGET' }] }), EURUSD).slSlippagePips, null);
});

test('chybějící vstupy → null, nikdy 0', () => {
  const d = FJSwing.swingDerived(trade({ slInitial: null, exits: [{ closedAt: '2026-11-04T10:00', price: 1.11, volume: 1 }] }), EURUSD);
  assert.equal(d.slPips, null);
  assert.equal(d.rPrice, null);
  assert.equal(d.rMoney, null);
  assert.equal(d.pnlNetTotal, null, 'noha bez pnl = neznámé netto');
  const noInstr = FJSwing.swingDerived(trade({ exits: [{ closedAt: '2026-11-04T10:00', price: 1.11, volume: 1 }] }), null);
  assert.equal(noInstr.pipsPerUnit, null);
  assert.equal(noInstr.status, 'CLOSED');
});

test('rMoney = Σ pnlNet / riskAmount, včetně swapu a komise', () => {
  const d = FJSwing.swingDerived(trade({ riskAmount: 100, exits: [{ closedAt: '2026-11-04T10:00', price: 1.11, volume: 1, pnl: 210, swap: -5, commission: -5 }] }), EURUSD);
  near(d.rMoney, 2);
});

test('neúplné: chybí slInitial, setup, nebo pnl u nohy uzavřeného obchodu', () => {
  assert.deepEqual(FJSwing.swingMissing(trade({ swingSetup: 'M2_DAILY' })), []);
  assert.deepEqual(FJSwing.swingMissing(trade({ slInitial: null, swingSetup: 'M2_DAILY' })), ['slInitial']);
  assert.deepEqual(FJSwing.swingMissing(trade()), ['swingSetup']);
  assert.deepEqual(FJSwing.swingMissing(trade({ swingSetup: 'X', exits: [{ closedAt: '2026-11-04T10:00', price: 1.11, volume: 1 }] })), ['exitPnl']);
  // otevřená pozice s částečným výstupem bez pnl je taky neúplná až po uzavření
  assert.deepEqual(FJSwing.swingMissing(trade({ swingSetup: 'X', exits: [{ closedAt: '2026-11-04T10:00', price: 1.11, volume: 0.5 }] })), []);
  // SETUP_ONLY nikdy
  assert.deepEqual(FJSwing.swingMissing(trade({ recordType: 'SETUP_ONLY', slInitial: null })), []);
});

test('instrumenty CFD: výchozí tabulka, uložené hodnoty mají přednost, nic se nemaže', () => {
  const def = FJSwing.instrumentsOf({});
  assert.equal(FJSwing.findInstrument('usdjpy', def).pipSize, 0.01);
  assert.equal(FJSwing.findInstrument('EURUSD', def).pipSize, 0.0001);
  assert.ok(FJSwing.findInstrument('US500', def));
  const custom = FJSwing.instrumentsOf({ cfdInstruments: [{ symbol: 'XAUUSD', pipSize: 1, priceDecimals: 2, assetClass: 'COMMODITY' }, { symbol: 'BTCUSD', pipSize: 0.1, priceDecimals: 3, assetClass: 'OTHER' }] });
  assert.equal(FJSwing.findInstrument('XAUUSD', custom).pipSize, 1);
  assert.ok(FJSwing.findInstrument('BTCUSD', custom));
  assert.equal(custom.length, def.length + 1);
  assert.equal(FJSwing.findInstrument('NEZNAMY', custom), null);
});

test('typ deníku: výchozí FUTURES_INTRADAY, swing jen výslovně', () => {
  assert.equal(FJSwing.journalTypeOf({}), 'FUTURES_INTRADAY');
  assert.equal(FJSwing.journalTypeOf({ journalType: 'CFD_SWING' }), 'CFD_SWING');
  assert.equal(FJSwing.journalTypeOf({ journalType: 'nesmysl' }), 'FUTURES_INTRADAY');
  assert.equal(FJSwing.isSwingRecord({ kind: 'SWING' }), true);
  assert.equal(FJSwing.isSwingRecord({ instrument: 'MES' }), false);
});
