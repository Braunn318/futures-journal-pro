'use strict';
// Je obrácené znaménko provize u breakeven obchodů chyba v AKTIVNÍM kódu?
// (spec §1.1 – jediná výjimka, která z auditu historie zůstala v rozsahu)
//
// Dva staré záznamy v deníku mají u breakeven obchodu P/L +3.80 a +4.40, tedy
// provizi jako BONUS místo náklad. Kdyby ta chyba byla živá, zasáhne i budoucí
// backtest obchody – a breakevenů v backtestu bude dost, protože práh Break Even
// je nastavený na ±$5 a MES dělá $5 na bod.
//
// Testuje se celá cesta, kterou nový breakeven obchod projde:
//   1. main.js processExecution   – uzavření pozice na vstupní ceně
//   2. mapCapturedTrade           – sestavení obchodu z události
//   3. combineTradeObjects        – breakeven noha ve sloučeném obchodu
//   4. recalcUnitCommission       – tlačítko „Přepočítat komisi"
// V každém kroku musí být provize náklad: nulový pohyb ceny → čistý výsledek
// je záporný, právě o provizi.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer, loadMain } = require('./helpers/extract');

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }],
  breakEvenEnabled: true,
  breakEvenThreshold: 5,
  useConnectorCommission: false,
  autoMergeLegs: true
};

test('main.js: uzavření pozice na vstupní ceně dá záporný čistý výsledek o výši provize', async () => {
  const events = [];
  const state = { positions: {}, executionIds: [] };

  const main = loadMain(
    ['signedExecutionQuantity', 'positionKey', 'openPositionFromExecution', 'processExecution'],
    {
      // Stuby okolí: stav pozic v paměti, žádné screenshoty, žádný disk.
      readCaptureState: () => state,
      writeCaptureState: () => {},
      takeScreenshots: async () => [],
      appendCaptureEvent: (payload) => { const e = { id: 'ev' + events.length, ...payload }; events.push(e); return e; },
      crypto: { randomUUID: () => 'pos-1' },
      Date
    }
  );

  // 2 kontrakty MES long ve 7700, provize 1.90/kontrakt na každé straně.
  await main.processExecution({
    executionId: 'x1', account: 'Playback101', instrument: 'MES', instrumentFull: 'MES 12-26',
    orderAction: 'Buy', quantity: 2, price: 7700, commission: 3.8, pointValue: 5, rate: 1,
    time: '2026-09-12T16:00:00.000Z', orderName: 'Entry'
  });
  // Výstup na STEJNÉ ceně → nulový hrubý výsledek.
  await main.processExecution({
    executionId: 'x2', account: 'Playback101', instrument: 'MES', instrumentFull: 'MES 12-26',
    orderAction: 'Sell', quantity: 2, price: 7700, commission: 3.8, pointValue: 5, rate: 1,
    time: '2026-09-12T16:05:00.000Z', orderName: 'Close'
  });

  const closed = events.find(e => e.type === 'trade_closed');
  assert.ok(closed, 'musí vzniknout událost trade_closed');
  assert.equal(closed.points, 0, 'nulový pohyb ceny');
  assert.equal(closed.grossPnl, 0, 'hrubý výsledek je nula');
  assert.equal(closed.commission, 7.6, 'provize je vstupní i výstupní strana: 3.80 + 3.80');
  assert.equal(closed.pnl, -7.6, 'čistý výsledek je ZÁPORNÝ o výši provize, ne kladný');
});

test('mapCapturedTrade: breakeven obchod si nechá provizi jako náklad', () => {
  const r = loadRenderer(
    ['normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument', 'getDefaultCommissionForInstrument',
      'classifyResult', 'signed', 'tradeTotalPoints', 'mapCapturedTrade'],
    { settings: SETTINGS, Date }
  );

  const trade = r.mapCapturedTrade({
    id: 'ev1', type: 'trade_closed', account: 'Playback101', instrument: 'MES',
    side: 'long', entryTime: '2026-09-12T16:00:00.000Z', exitTime: '2026-09-12T16:05:00.000Z',
    entryPrice: 7700, exitPrice: 7700, quantity: 2, points: 0,
    grossPnl: 0, commission: 7.6, pnl: -7.6, result: 'stoploss', pointValue: 5
  }, [], SETTINGS);

  // Šablona instrumentu má přednost před provizí od konektoru: 1.90 × 2 kontrakty.
  assert.equal(trade.commission, 3.8);
  assert.equal(trade.pnlRaw, -3.8, 'provize se ODEČÍTÁ od nulového hrubého výsledku');
  assert.equal(trade.result, 'breakeven', 'práh ±$5 z něj dělá breakeven, ale částka zůstává záporná');
  assert.equal(trade.pointsTotal, 0);
  assert.equal(trade.pointsPerContract, 0);
});

test('signed(): breakeven obchod bez pnlRaw nesmí tvrdit, že byl nulový', () => {
  const r = loadRenderer(['signed'], { settings: SETTINGS });
  // Obchod S uloženým pnlRaw – jediný případ, který v praxi vzniká z importu
  // i z formuláře, protože obojí pnlRaw vždy zapisuje.
  assert.equal(r.signed({ result: 'breakeven', pnlRaw: -3.8, pnl: 3.8 }, 'pnl'), -3.8);
  // Obchod BEZ pnlRaw (jen velmi stará data): `signed()` vrátí nulu, takže
  // provize z agregací zmizí. Není to obrácené znaménko, ale ztracený náklad –
  // zdokumentováno testem, ať je zřejmé, na čem se stojí.
  assert.equal(r.signed({ result: 'breakeven', pnl: 3.8 }, 'pnl'), 0);
});

test('combineTradeObjects: breakeven noha nepřiklopí provizi do plusu', () => {
  const r = loadRenderer(
    ['normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument', 'getDefaultCommissionForInstrument',
      'classifyResult', 'signed', 'tradeTotalPoints', 'weightedExitFields', 'legFromTrade',
      'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'combineTradeObjects'],
    { settings: SETTINGS }
  );

  const base = {
    instrument: 'MES', date: '2026-09-12', entryTime: '16:00', entryPrice: 7700, side: 'long', positionId: 'p1'
  };
  // TP1 vybral 3 body na jednom kontraktu, druhý kontrakt vyšel na nulu.
  const tp1 = { ...base, id: 'a', exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, commission: 1.9, pnlRaw: 13.1, pnl: 13.1, result: 'target' };
  const be = { ...base, id: 'b', exitTime: '16:09', exitPrice: 7700, points: 0, contracts: 1, commission: 1.9, pnlRaw: -1.9, pnl: 1.9, result: 'breakeven' };

  const merged = r.combineTradeObjects([tp1, be]);

  assert.equal(merged.commission, 3.8);
  assert.equal(merged.pnlRaw, 11.2, '13.10 + (−1.90) = 11.20; provize se nesčítá do plusu');
  assert.equal(merged.pointsTotal, 3, 'body dá jen TP1 noha');
});

test('recalcUnitCommission: přepočet provize u breakeven obchodu ji nechá jako náklad', () => {
  const r = loadRenderer(['classifyResult', 'signed', 'recalcUnitCommission'], { settings: SETTINGS });

  // Běžný případ: obchod má uložený pnlRaw.
  const recalculated = r.recalcUnitCommission(
    { result: 'breakeven', points: 0, contracts: 2, commission: 3.8, pnlRaw: -3.8, pnl: 3.8 },
    'MES', 1.9
  );
  assert.equal(recalculated.commission, 3.8);
  assert.equal(recalculated.pnlRaw, -3.8, 'hrubý výsledek nula → čistý je −provize');

  // Opakovaný přepočet nesmí hodnotu posouvat.
  const twice = r.recalcUnitCommission(recalculated, 'MES', 1.9);
  assert.equal(twice.pnlRaw, -3.8, 'přepočet je idempotentní');
});
