'use strict';
// Syntetické testy vážení bodů počtem kontraktů.
//
// Proč syntetické: ve živém deníku má KAŽDÁ noha každého merged obchodu přesně
// 1 kontrakt, takže násobení počtem kontraktů v `tradeTotalPoints()` nikdy nic
// nezmění a reálná data tuhle cestu netestují vůbec. Noha o 2+ kontraktech
// přitom vznikne hned, jak se dvoukontraktová pozice uzavře jedním fillem –
// a právě tam se obě konvence `points` rozejdou.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }],
  breakEvenEnabled: false,
  breakEvenThreshold: 0,
  autoMergeLegs: true
};

const NAMES = [
  'BUILTIN_POINT_VALUES',
  'normalizeInstrumentCode',
  'findTemplate',
  'getPointValueForInstrument',
  'getDefaultCommissionForInstrument',
  'classifyResult',
  'signed',
  'displayPoints',
  'tradeTotalPoints',
  'legFromTrade',
  'mergeSamePriceLegs',
  'labelLegs',
  'combineTradeObjects'
];

function renderer() {
  return loadRenderer(NAMES, { settings: SETTINGS });
}

function mesTrade(overrides) {
  return {
    id: 'test-' + Math.random().toString(16).slice(2),
    instrument: 'MES',
    date: '2026-09-01',
    entryTime: '16:00',
    entryPrice: 7700,
    exitTime: '16:05',
    exitPrice: 7703,
    result: 'target',
    side: 'long',
    points: 3,
    contracts: 1,
    commission: 1.9,
    pnl: 13.1,
    pnlRaw: 13.1,
    ...overrides
  };
}

test('tradeTotalPoints váží nohu počtem kontraktů', () => {
  const r = renderer();
  // Jedna noha, 2 kontrakty po 3 bodech → 6 bodů celkem.
  assert.equal(r.tradeTotalPoints({ points: 3, contracts: 2 }), 6);
  // Dvě nohy: 3 body × 2 kontrakty + 5 bodů × 1 kontrakt = 11.
  assert.equal(r.tradeTotalPoints({ legs: [{ points: 3, contracts: 2 }, { points: 5, contracts: 1 }] }), 11);
  // Noha bez počtu kontraktů se počítá jako jeden – dokumentované chování
  // (`Number(l.contracts)||1`), ne překlep.
  assert.equal(r.tradeTotalPoints({ legs: [{ points: 4 }] }), 4);
});

test('combineTradeObjects sčítá body vážené počtem kontraktů, ne jen per-contract hodnoty', () => {
  const r = renderer();
  // TP1 zavře 2 kontrakty po 3 bodech, TP2 jeden kontrakt po 5 bodech.
  // Skutečný bodový výsledek pozice je 3×2 + 5×1 = 11 bodů.
  const tp1 = mesTrade({ exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 2, commission: 3.8, pnlRaw: 26.2, pnl: 26.2, positionId: 'pos-1' });
  const tp2 = mesTrade({ exitTime: '16:09', exitPrice: 7705, points: 5, contracts: 1, commission: 1.9, pnlRaw: 23.1, pnl: 23.1, positionId: 'pos-1' });

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.equal(merged.contracts, 3, 'počet kontraktů se sečte přes nohy');
  assert.equal(
    merged.points,
    11,
    `sloučený obchod má mít 11 bodů (3×2 + 5×1), má ${merged.points} – nohy se sčítají bez vážení počtem kontraktů`
  );
  // Až bude oprava hotová, tohle je pole, na které se napojí hlavní zobrazované
  // číslo (Body v CSV, karta obchodu) – viz spec §2.1 KOREKCE.
  assert.equal(r.tradeTotalPoints(merged), 11, 'tradeTotalPoints nad sloučeným obchodem dá správný total');
});

test('combineTradeObjects nemění merged obchod s jedním kontraktem na nohu', () => {
  const r = renderer();
  // Takhle vypadá VŠECH 34 merged obchodů v živém deníku: každá noha 1 kontrakt.
  // Po opravě §3.1 se u nich hodnota nesmí změnit – to je podmínka ze §2.1.
  const tp1 = mesTrade({ exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, commission: 1.9, pnlRaw: 13.1, pnl: 13.1, positionId: 'pos-2' });
  const tp2 = mesTrade({ exitTime: '16:09', exitPrice: 7705, points: 5, contracts: 1, commission: 1.9, pnlRaw: 23.1, pnl: 23.1, positionId: 'pos-2' });

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.equal(merged.contracts, 2);
  assert.equal(merged.points, 8, 'součet 3 + 5 je zároveň total i dnešní hodnota – tady se nic měnit nemá');
  assert.equal(r.tradeTotalPoints(merged), 8);
});
