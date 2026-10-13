'use strict';
// Starý zápis SR hladin: dva seznamy srTarget / srStopLoss s řádky
// { level, price, ticksFromEntry } (4.7.0–4.8.4).
//
// Od kontextu v3 je v obchodu jeden seznam „Hladiny v blízkosti" (nearLevels)
// a starý tvar se už jen ČTE: z deníku, který od aktualizace ještě nebyl
// otevřen, a ze zálohy nahrané ze starší verze. Tenhle soubor hlídá právě to
// čtení a navazující převod; nový tvar a geometrii hlídá context-v3.test.js.
//
// Nejdůležitější je test sloučení: combineTradeObjects je bílá listina polí,
// takže co v ní chybí, sloučením dvou cílů zmizí.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJPoints = require('../app/points.js');
const FJTaxonomy = require('../app/taxonomy.js');

const plain = value => JSON.parse(JSON.stringify(value));

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, tickSize: 0.25, defaultCommission: 1.9 }],
  breakEvenEnabled: true, breakEvenThreshold: 5, useConnectorCommission: false, autoMergeLegs: true
};

const NAMES = [
  'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
  'getDefaultCommissionForInstrument', 'classifyResult', 'signed', 'tradeTotalPoints',
  'tradePointsTotal', 'displayPointsTotal', 'weightedExitFields', 'legFromTrade',
  'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES',
  'postExitFields', 'applyPostExitFields', 'postExitApplies', 'POST_EXIT_DERIVED_KEYS', 'combineTradeObjects',
  'srLevelsMigrationPatch'
];
const renderer = () => loadRenderer(NAMES, { settings: SETTINGS, Date });

function leg(overrides) {
  return {
    id: 'l-' + Math.random().toString(16).slice(2),
    instrument: 'MES', date: '2026-09-12', entryTime: '16:00', entryPrice: 7700,
    exitTime: '16:05', exitPrice: 7703, result: 'target', side: 'long',
    points: 3, contracts: 1, commission: 1.9, pnl: 13.1, pnlRaw: 13.1, positionId: 'pos-sr',
    ...overrides
  };
}

// ------------------------------------------------------- zrušený přepočet

test('přepočet cena ↔ ticky je pryč – vzdálenost hladiny se už nezadává ani neukládá', () => {
  for (const gone of ['srTicksFromPrice', 'srPriceFromTicks', 'srWrongSide', 'srLinkEnabled']) {
    assert.equal(FJPoints[gone], undefined, gone);
  }
});

// ------------------------------------------------------------ čtení starého tvaru

test('sanitizeLevelRows: nejstarší tvar (pole klíčů) se přečte jako řádky', () => {
  assert.deepEqual(FJTaxonomy.sanitizeLevelRows(null, ['VAH', 'VWAP']), [
    { level: 'VAH', price: null, ticksFromEntry: null },
    { level: 'VWAP', price: null, ticksFromEntry: null }
  ]);
});

test('sanitizeLevelRows: prázdný řádek pryč, čísla očištěná, stejný typ smí víckrát', () => {
  const rows = FJTaxonomy.sanitizeLevelRows(null, [
    { level: 'VAH', price: '7712.5', ticksFromEntry: '-10' },
    { level: 'VAH', price: 7720, ticksFromEntry: 40 },
    { level: '', price: 7705 },
    { level: 'VWAP', price: 'abc', ticksFromEntry: '' }
  ]);
  assert.deepEqual(rows, [
    { level: 'VAH', price: 7712.5, ticksFromEntry: 10 },
    { level: 'VAH', price: 7720, ticksFromEntry: 40 },
    { level: 'VWAP', price: null, ticksFromEntry: null }
  ]);
});

test('sanitizeLevelRows: identické řádky se sloučí, holý řádek ustoupí podrobnějšímu', () => {
  const rows = FJTaxonomy.sanitizeLevelRows(null, [
    'VWAP',
    { level: 'VWAP', price: 7698, ticksFromEntry: 8 },
    { level: 'VWAP', price: 7698, ticksFromEntry: 8 },
    'VAL'
  ]);
  assert.deepEqual(rows, [
    { level: 'VWAP', price: 7698, ticksFromEntry: 8 },
    { level: 'VAL', price: null, ticksFromEntry: null }
  ]);
});

test('starý tvar → nový: vlastní klíč jiného deníku se neztratí, ticky řádku s cenou se nenesou', () => {
  const out = FJTaxonomy.convertLegacyNear({
    id: 'x', srTarget: [{ level: 'CUSTOM_JINY_DENIK', price: 7712.5, ticksFromEntry: 50 }], srStopLoss: [{ level: 'VAL', price: null, ticksFromEntry: 12 }]
  });
  assert.deepEqual(plain(out), { id: 'x', nearLevels: [
    { level: 'CUSTOM_JINY_DENIK', price: 7712.5 },
    { level: 'VAL', price: null, ticksFromEntry: 12, legacySide: 'SL' }
  ] });
});

// ------------------------------------------------------------------ sloučení

test('combineTradeObjects: hladiny dvou cílů nezmizí, sloučený obchod má jejich sjednocení v novém tvaru', () => {
  const r = renderer();
  const tp1 = leg({
    exitTime: '16:05', exitPrice: 7703,
    nearLevels: [{ level: 'VAH', price: 7712.5 }, { level: 'VWAP', price: 7698 }]
  });
  // Druhá noha ještě ve starém tvaru (doimport do deníku, který nebyl převeden).
  const tp2 = leg({
    exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1,
    srTarget: [{ level: 'VAH', price: 7712.5, ticksFromEntry: 50 }, { level: 'LIQUIDITY', price: 7708, ticksFromEntry: 32 }],
    srStopLoss: [{ level: 'VAL', price: null, ticksFromEntry: 12 }]
  });

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.deepEqual(plain(merged.nearLevels), [
    { level: 'VAH', price: 7712.5 },
    { level: 'VWAP', price: 7698 },
    { level: 'LIQUIDITY', price: 7708 },
    { level: 'VAL', price: null, ticksFromEntry: 12, legacySide: 'SL' }
  ], 'sjednocení bez duplicity');
  assert.equal(merged.srTarget, undefined, 'starý tvar se do sloučeného obchodu nezapisuje');
  assert.equal(merged.srStopLoss, undefined);
});

test('combineTradeObjects: cíl bez hladin nevyrobí prázdné pole', () => {
  const merged = renderer().combineTradeObjects([leg({}), leg({ exitTime: '16:09', exitPrice: 7705 })]);
  assert.equal(merged.nearLevels, undefined);
  assert.equal(merged.nearLevelsNone, undefined);
});

// ---------------------------------------------------------------- migrace 4.7.0

test('převod 4.7.0 (klíče → řádky) mění jen tvar a nic nezahodí (ani vlastní klíč jiného číselníku)', () => {
  const r = renderer();
  const patch = r.srLevelsMigrationPatch({ id: 'x', srTarget: ['VAH', 'CUSTOM_MOJE', 'VAH'], srStopLoss: [] });
  assert.deepEqual(plain(patch), { srTarget: [
    { level: 'VAH', price: null, ticksFromEntry: null },
    { level: 'CUSTOM_MOJE', price: null, ticksFromEntry: null }
  ] });
  assert.equal(r.srLevelsMigrationPatch({ id: 'y', srTarget: [{ level: 'VAH', price: 1, ticksFromEntry: 2 }] }), null, 'řádky se nechají být');
  assert.equal(r.srLevelsMigrationPatch({ id: 'z', recordType: 'SETUP_ONLY', srTarget: ['VAH'] }), null);
  assert.equal(r.srLevelsMigrationPatch({ id: 'n', nearLevels: [{ level: 'VAH', price: 1 }] }), null, 'obchod v novém tvaru se netýká');
});
