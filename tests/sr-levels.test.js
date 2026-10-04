'use strict';
// SR hladiny jako řádky { level, price, ticksFromEntry } (4.7.0).
//
// ticksFromEntry je VŽDY KLADNÁ vzdálenost od vstupu; stranu nese pole
// (srTarget ve směru obchodu, srStopLoss proti) a směr obchodu. Když chybí
// velikost ticku, vstupní cena, nebo (u ceny z ticků) směr, přepočet se
// vypíná – nikdy se nedosazuje nula ani odhad.
//
// Nejdůležitější je test sloučení: combineTradeObjects je bílá listina polí,
// takže co v ní chybí, sloučením dvou cílů zmizí.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer, loadMain } = require('./helpers/extract');
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
  'sideMeta', 'reportSigned', 'srCsvCounts', 'srCsvHeader', 'srCsvCells',
  'tradeCsvHeader', 'tradeCsvRow', 'reportCsvHeader', 'reportCsvRow', 'srLevelsMigrationPatch'
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

// ---------------------------------------------------------------- matematika

test('cena → ticky: vždy kladná vzdálenost od vstupu', () => {
  assert.equal(FJPoints.srTicksFromPrice(7702.5, 7700, 0.25), 10);
  assert.equal(FJPoints.srTicksFromPrice(7697.5, 7700, 0.25), 10, 'pod vstupem je vzdálenost taky kladná');
  assert.equal(FJPoints.srTicksFromPrice(2051.2, 2050, 0.1), 12, 'RTY tick 0,1 bez desetinného šumu');
});

test('ticky → cena: stranu určuje pole a směr obchodu', () => {
  assert.equal(FJPoints.srPriceFromTicks('srTarget', 'long', 8, 7700, 0.25), 7702, 'long: SR→TG nad vstupem');
  assert.equal(FJPoints.srPriceFromTicks('srTarget', 'short', 8, 7700, 0.25), 7698, 'short: SR→TG pod vstupem');
  assert.equal(FJPoints.srPriceFromTicks('srStopLoss', 'long', 4, 7700, 0.25), 7699, 'long: SR→SL pod vstupem');
  assert.equal(FJPoints.srPriceFromTicks('srStopLoss', 'short', 4, 7700, 0.25), 7701, 'short: SR→SL nad vstupem');
  assert.equal(FJPoints.srPriceFromTicks('srTarget', 'long', -8, 7700, 0.25), 7702, 'znaménko se ignoruje, stranu nese pole');
  assert.equal(FJPoints.srPriceFromTicks('srTarget', 'long', 3, 7700.25, 0.25), 7701, 'bez 7701.000000000001');
});

test('chybí tick, vstup nebo směr → přepočet vypnutý, nikdy 0 ani odhad', () => {
  assert.equal(FJPoints.srTicksFromPrice(7702.5, 7700, null), null);
  assert.equal(FJPoints.srTicksFromPrice(7702.5, 7700, 0), null);
  assert.equal(FJPoints.srTicksFromPrice(7702.5, '', 0.25), null);
  assert.equal(FJPoints.srTicksFromPrice('', 7700, 0.25), null);
  assert.equal(FJPoints.srPriceFromTicks('srTarget', 'long', 8, 7700, undefined), null);
  assert.equal(FJPoints.srPriceFromTicks('srTarget', 'long', 8, null, 0.25), null);
  assert.equal(FJPoints.srPriceFromTicks('srTarget', '', 8, 7700, 0.25), null, 'bez směru nejde určit stranu');
  assert.equal(FJPoints.srPriceFromTicks('srTarget', 'long', '', 7700, 0.25), null);
  assert.equal(FJPoints.srLinkEnabled(7700, null), false);
  assert.equal(FJPoints.srLinkEnabled('', 0.25), false);
  assert.equal(FJPoints.srLinkEnabled(7700, 0.25), true);
});

test('cena na špatné straně vstupu dá měkké varování', () => {
  assert.equal(FJPoints.srWrongSide('srTarget', 'long', 7698, 7700), true);
  assert.equal(FJPoints.srWrongSide('srTarget', 'long', 7702, 7700), false);
  assert.equal(FJPoints.srWrongSide('srStopLoss', 'short', 7698, 7700), true);
  assert.equal(FJPoints.srWrongSide('srStopLoss', 'short', 7702, 7700), false);
  assert.equal(FJPoints.srWrongSide('srTarget', '', 7698, 7700), false, 'bez směru se nesoudí');
});

// ------------------------------------------------------------------ tvar dat

test('sanitizeLevelRows: starý tvar (klíče) se převede na řádky', () => {
  assert.deepEqual(FJTaxonomy.sanitizeLevelRows('SR_TARGET', ['VAH', 'VWAP']), [
    { level: 'VAH', price: null, ticksFromEntry: null },
    { level: 'VWAP', price: null, ticksFromEntry: null }
  ]);
});

test('sanitizeLevelRows: neznámý typ a prázdný řádek pryč, čísla očištěná, stejný typ smí víckrát', () => {
  const rows = FJTaxonomy.sanitizeLevelRows('SR_TARGET', [
    { level: 'VAH', price: '7712.5', ticksFromEntry: '-10' },
    { level: 'VAH', price: 7720, ticksFromEntry: 40 },
    { level: 'PREKLEP', price: 7700 },
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
  const rows = FJTaxonomy.sanitizeLevelRows('SR_SL', [
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

test('sanitizeLevelRows bez skupiny neověřuje typ (export z víc deníků)', () => {
  assert.deepEqual(FJTaxonomy.sanitizeLevelRows(null, ['CUSTOM_JINY_DENIK']), [
    { level: 'CUSTOM_JINY_DENIK', price: null, ticksFromEntry: null }
  ]);
});

// ------------------------------------------------------------------ sloučení

test('combineTradeObjects: SR řádky dvou cílů nezmizí, sloučený obchod má jejich sjednocení', () => {
  const r = renderer();
  const tp1 = leg({
    exitTime: '16:05', exitPrice: 7703,
    srTarget: [{ level: 'VAH', price: 7712.5, ticksFromEntry: 50 }],
    srStopLoss: [{ level: 'VWAP', price: 7698, ticksFromEntry: 8 }]
  });
  const tp2 = leg({
    exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1,
    srTarget: [{ level: 'VAH', price: 7712.5, ticksFromEntry: 50 }, { level: 'LIQUIDITY', price: 7708, ticksFromEntry: 32 }],
    srStopLoss: [{ level: 'VAL', price: null, ticksFromEntry: 12 }]
  });

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.deepEqual(plain(merged.srTarget), [
    { level: 'VAH', price: 7712.5, ticksFromEntry: 50 },
    { level: 'LIQUIDITY', price: 7708, ticksFromEntry: 32 }
  ], 'sjednocení bez duplicity');
  assert.deepEqual(plain(merged.srStopLoss), [
    { level: 'VWAP', price: 7698, ticksFromEntry: 8 },
    { level: 'VAL', price: null, ticksFromEntry: 12 }
  ]);
});

test('combineTradeObjects: cíl bez SR hladin nevyrobí prázdné pole', () => {
  const merged = renderer().combineTradeObjects([leg({}), leg({ exitTime: '16:09', exitPrice: 7705 })]);
  assert.equal(merged.srTarget, undefined);
  assert.equal(merged.srStopLoss, undefined);
});

// ---------------------------------------------------------------- migrace

test('migrace převede jen tvar a nic nezahodí (ani vlastní klíč jiného číselníku)', () => {
  const r = renderer();
  const patch = r.srLevelsMigrationPatch({ id: 'x', srTarget: ['VAH', 'CUSTOM_MOJE', 'VAH'], srStopLoss: [] });
  assert.deepEqual(plain(patch), { srTarget: [
    { level: 'VAH', price: null, ticksFromEntry: null },
    { level: 'CUSTOM_MOJE', price: null, ticksFromEntry: null }
  ] });
  assert.equal(r.srLevelsMigrationPatch({ id: 'y', srTarget: [{ level: 'VAH', price: 1, ticksFromEntry: 2 }] }), null, 'nový tvar se nechá být');
  assert.equal(r.srLevelsMigrationPatch({ id: 'z', recordType: 'SETUP_ONLY', srTarget: ['VAH'] }), null);
});

// ---------------------------------------------------------------- exporty

test('CSV: SR hladiny jako bloky sloupců hladina / cena / ticky, hlavička a řádek se nerozejdou', () => {
  const r = renderer();
  const rich = leg({
    journalName: 'Backtest',
    srTarget: [{ level: 'VAH', price: 7712.5, ticksFromEntry: 50 }, { level: 'LIQUIDITY', price: null, ticksFromEntry: 32 }],
    srStopLoss: [{ level: 'VWAP', price: 7698, ticksFromEntry: 8 }]
  });
  const bare = leg({ journalName: 'Backtest', srTarget: ['VAL'] });
  const counts = r.srCsvCounts([rich, bare]);
  assert.deepEqual(plain(counts), { tg: 2, sl: 1 });

  for (const [header, rows, label] of [
    [r.tradeCsvHeader(counts), [r.tradeCsvRow(rich, null, counts), r.tradeCsvRow(bare, null, counts)], 'deník'],
    [r.reportCsvHeader(counts), [r.reportCsvRow(rich, null, counts), r.reportCsvRow(bare, null, counts)], 'reporty']
  ]) {
    for (const row of rows) assert.equal(header.length, row.length, label + ': hlavička a řádek se rozešly');
    const rec = row => Object.fromEntries(header.map((name, i) => [name, row[i]]));
    const a = rec(rows[0]), b = rec(rows[1]);
    assert.equal(a['SR→TG 1 hladina'], 'VAH', label);
    assert.equal(a['SR→TG 1 cena'], 7712.5, label);
    assert.equal(a['SR→TG 1 ticky'], 50, label);
    assert.equal(a['SR→TG 2 hladina'], 'LIQUIDITY', label);
    assert.equal(a['SR→TG 2 cena'], '', label + ': chybějící cena je prázdná, ne 0');
    assert.equal(a['SR→SL 1 ticky'], 8, label);
    assert.equal(b['SR→TG 1 hladina'], 'VAL', label + ': starý tvar se exportuje taky');
    assert.equal(b['SR→TG 2 hladina'], '', label);
    assert.ok(!header.includes('SR proti targetu'), label + ': text spojený přes | už v exportu není');
    assert.equal(a['Order flow'], '', label + ': sloupec za bloky se neposunul');
  }
});

test('CSV bez SR hladin má jeden prázdný blok, ne nulový počet sloupců', () => {
  const r = renderer();
  const counts = r.srCsvCounts([leg({})]);
  assert.deepEqual(plain(counts), { tg: 1, sl: 1 });
  assert.equal(r.tradeCsvHeader(counts).length, r.tradeCsvHeader().length);
});

test('AI export nese SR hladiny jako strukturovaná data (objekty), ne text', () => {
  const trade = leg({ srTarget: [{ level: 'VAH', price: 7712.5, ticksFromEntry: 50 }], images: ['fjimg://a'] });
  const exported = JSON.parse(JSON.stringify(loadMain(['stripImages']).stripImages(trade)));
  assert.deepEqual(exported.srTarget, [{ level: 'VAH', price: 7712.5, ticksFromEntry: 50 }]);
});
