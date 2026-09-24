'use strict';
// Pět kontextových polí, která blokují start sběru dat (spec §1.1, bod 3):
// setupCode, entryLevels, ofConfirm, fillStatus, slPrice.
//
// Bez nich je zapsaný obchod k analýze nepoužitelný a zpětně se to nedoplní –
// za měsíc už Adam nebude vědět, na jaké hladině ten vstup ležel.
//
// Nejdůležitější test v tomhle souboru je ten na `combineTradeObjects`: ta
// funkce je bílá listina polí a už jednou tiše sežrala `side`. A protože se
// slučují právě víc-cílové obchody, přišel by kontext hlavně u nich.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }],
  breakEvenEnabled: true,
  breakEvenThreshold: 5,
  useConnectorCommission: false,
  autoMergeLegs: true
};

const NAMES = [
  'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
  'getDefaultCommissionForInstrument', 'classifyResult', 'signed', 'tradeTotalPoints',
  'tradePointsTotal', 'displayPointsTotal', 'weightedExitFields', 'legFromTrade',
  'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'combineTradeObjects',
  'mapCapturedTrade'
];

function renderer() {
  return loadRenderer(NAMES, { settings: SETTINGS, Date });
}

function contextTrade(overrides) {
  return {
    id: 'c-' + Math.random().toString(16).slice(2),
    instrument: 'MES', date: '2026-09-12', entryTime: '16:00', entryPrice: 7700,
    exitTime: '16:05', exitPrice: 7703, result: 'target', side: 'long',
    points: 3, contracts: 1, commission: 1.9, pnl: 13.1, pnlRaw: 13.1,
    positionId: 'pos-ctx',
    ...overrides
  };
}

test('číselníky obsahují klíče ze Strategy.md a popisky jsou jen zobrazení', () => {
  assert.equal(FJTaxonomy.SETUP.M2_OF, 'M2 + Order Flow');
  assert.equal(FJTaxonomy.labelOf('SETUP', 'AVE'), 'AVE Pattern');
  // Neznámý klíč se nevymýšlí – vrátí se, jak přišel, ať je v UI vidět, že
  // něco nesedí, místo tichého prázdna.
  assert.equal(FJTaxonomy.labelOf('SETUP', 'NEEXISTUJE'), 'NEEXISTUJE');
  assert.ok(FJTaxonomy.isValidKey('FILL_STATUS', 'NO_FILL'));
  assert.ok(!FJTaxonomy.isValidKey('FILL_STATUS', 'MAYBE'));
});

test('neznámé hodnoty se do dat nedostanou', () => {
  assert.deepEqual(FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', ['VWAP', 'PREKLEP', 'VAH']), ['VAH', 'VWAP']);
  assert.deepEqual(FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', ['VWAP', 'VWAP']), ['VWAP'], 'bez duplicit');
  assert.equal(FJTaxonomy.sanitizeSingle('SETUP', 'AVE'), 'AVE');
  assert.equal(FJTaxonomy.sanitizeSingle('SETUP', 'NEEXISTUJE'), '');
  assert.equal(FJTaxonomy.sanitizeSingle('SETUP', undefined), '');
});

test('konfluence se dopočítává a NONE se nepočítá', () => {
  assert.equal(FJTaxonomy.confluenceCount(['VWAP', 'VAH', 'VPOC_DAY']), 3);
  assert.equal(FJTaxonomy.confluenceCount(['NONE']), 0, 'výslovné „žádná hladina" není konfluence');
  assert.equal(FJTaxonomy.confluenceCount(['VWAP', 'NONE']), 1);
  assert.equal(FJTaxonomy.confluenceCount([]), 0);
  assert.equal(FJTaxonomy.confluenceCount(undefined), 0);
});

test('sloučení víc cílů nesmí kontext zahodit', () => {
  const r = renderer();
  const tp1 = contextTrade({
    exitTime: '16:05', exitPrice: 7703, points: 3,
    setupCode: 'M2_OF', entryLevels: ['VWAP', 'VPOC_DAY'], ofConfirm: ['ABS_BID'],
    fillStatus: 'FILLED', slPrice: 7697, rMultiple: 1
  });
  const tp2 = contextTrade({
    exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1,
    // Druhá noha má vyplněné jen order flow – sjednocení ho musí přidat.
    ofConfirm: ['IMBALANCE']
  });

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.equal(merged.setupCode, 'M2_OF', 'single-select bere první neprázdný');
  assert.deepEqual([...merged.entryLevels], ['VPOC_DAY', 'VWAP'], 'multi-select se sjednocuje');
  assert.deepEqual([...merged.ofConfirm], ['ABS_BID', 'IMBALANCE'], 'sjednocení přes nohy');
  assert.equal(merged.fillStatus, 'FILLED');
  assert.equal(merged.slPrice, 7697, 'cena SL se u sloučeného obchodu nesmí ztratit');
  assert.equal(merged.confluenceCount, 2, 'dopočítává se z výsledných hladin');
});

test('sloučení: prázdný kontext nevytvoří prázdná pole', () => {
  const r = renderer();
  const merged = r.combineTradeObjects([
    contextTrade({ exitTime: '16:05', exitPrice: 7703 }),
    contextTrade({ exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1 })
  ]);
  assert.equal(merged.setupCode, undefined, 'nevyplněné pole se nezavádí jako prázdná hodnota');
  assert.equal(merged.entryLevels, undefined);
  assert.equal(merged.confluenceCount, undefined);
});

test('sloučení: neznámá hodnota v kontextu se při merge odfiltruje', () => {
  const r = renderer();
  const merged = r.combineTradeObjects([
    contextTrade({ exitTime: '16:05', exitPrice: 7703, entryLevels: ['VWAP', 'SMYSLUPROSTE'] }),
    contextTrade({ exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1 })
  ]);
  assert.deepEqual([...merged.entryLevels], ['VWAP']);
});

test('sloučení nezahodí ani ostatní pole obchodu (regrese na side)', () => {
  const r = renderer();
  const merged = r.combineTradeObjects([
    contextTrade({ exitTime: '16:05', exitPrice: 7703, side: 'short', externalAccount: 'Playback101' }),
    contextTrade({ exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1, side: 'short' })
  ]);
  assert.equal(merged.side, 'short');
  assert.equal(merged.externalAccount, 'Playback101');
});

test('import z konektoru označí obchod jako naplněný', () => {
  const r = renderer();
  const trade = r.mapCapturedTrade({
    id: 'ev1', type: 'trade_closed', account: 'Playback101', instrument: 'MES',
    side: 'long', entryTime: '2026-09-12T16:00:00.000Z', exitTime: '2026-09-12T16:05:00.000Z',
    entryPrice: 7700, exitPrice: 7703, quantity: 2, points: 3,
    grossPnl: 30, commission: 7.6, pnl: 22.4, result: 'target', pointValue: 5
  }, [], SETTINGS);

  assert.equal(trade.fillStatus, 'FILLED', 'obchod z reálné exekuce je naplněný');
  // Ostatní kontextová pole se z dat nehádají – doplňuje je Adam.
  assert.equal(trade.setupCode, undefined);
  assert.equal(trade.entryLevels, undefined);
});

test('popis polí drží kardinalitu, na které stojí pravidla slučování', () => {
  const byKey = Object.fromEntries(FJTaxonomy.TRADE_CONTEXT_FIELDS.map(f => [f.key, f]));
  assert.equal(byKey.setupCode.cardinality, 'single');
  assert.equal(byKey.trend.cardinality, 'single');
  assert.equal(byKey.entryLevels.cardinality, 'multi');
  assert.equal(byKey.srTarget.cardinality, 'multi');
  assert.equal(byKey.srStopLoss.cardinality, 'multi');
  assert.equal(byKey.ofConfirm.cardinality, 'multi');
  assert.equal(byKey.fillStatus.cardinality, 'single');
  assert.equal(byKey.slPrice.cardinality, 'number');
  // Každé pole s číselníkem musí mít použitelný seznam voleb. U odvozené
  // skupiny (SR kolonky) vlastní enum neexistuje – volby se berou ze zdrojové
  // skupiny, takže se kontroluje přes vocabularyOf.
  for (const field of FJTaxonomy.TRADE_CONTEXT_FIELDS) {
    if (!field.enumName) continue;
    assert.ok(FJTaxonomy.GROUP_BY_NAME[field.enumName],
      `pole ${field.key} ukazuje na neexistující skupinu ${field.enumName}`);
    assert.ok(FJTaxonomy.allKeys(field.enumName).length,
      `skupina ${field.enumName} nemá žádné volby`);
  }
});

test('Trend má tři stavy a je single-select', () => {
  assert.deepEqual(Object.keys(FJTaxonomy.TREND), ['LONG', 'SHORT', 'RANGE']);
  assert.equal(FJTaxonomy.labelOf('TREND', 'RANGE'), 'Range');
  assert.equal(FJTaxonomy.sanitizeSingle('TREND', 'LONG'), 'LONG');
  assert.equal(FJTaxonomy.sanitizeSingle('TREND', 'BOKEM'), '', 'neznámý stav se zahodí');
});

test('SR kolonky sdílejí seznam hladin se vstupem', () => {
  // Hladina je hladina, ať je to místo vstupu nebo překážka před targetem.
  // Díky sdílení se nová hladina přidává jen jednou.
  assert.deepEqual(FJTaxonomy.allKeys('SR_TARGET'), FJTaxonomy.allKeys('ENTRY_LEVEL'));
  assert.deepEqual(FJTaxonomy.allKeys('SR_SL'), FJTaxonomy.allKeys('ENTRY_LEVEL'));
  assert.equal(FJTaxonomy.vocabularyOf('SR_TARGET'), 'ENTRY_LEVEL');
  assert.equal(FJTaxonomy.vocabularyOf('ENTRY_LEVEL'), 'ENTRY_LEVEL', 'zdrojová skupina je sama sobě zdrojem');
});

test('nové kontextové kolonky přežijí sloučení víc cílů', () => {
  const r = renderer();
  const tp1 = contextTrade({ exitTime: '16:05', exitPrice: 7703, trend: 'LONG', srTarget: ['VAH'], srStopLoss: ['VWAP'] });
  const tp2 = contextTrade({ exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1, srTarget: ['LIQUIDITY'] });

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.equal(merged.trend, 'LONG', 'single-select bere první neprázdný');
  assert.deepEqual([...merged.srTarget], ['LIQUIDITY', 'VAH'], 'multi-select se sjednocuje');
  assert.deepEqual([...merged.srStopLoss], ['VWAP']);
});
