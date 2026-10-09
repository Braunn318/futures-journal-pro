'use strict';
// Kontext obchodu v2, krok 4 (docs/ZADANI_KONTEXT.md A2, A4; A7 testy 9, 10,
// 12, 15): nová ruční pole, netest/test u hladin, známka A/B/C s ochranou
// proti dodatečnému hodnocení.
//
// Hlavní pravidlo zadání: uložené obchody se neupravují. Nová pole jsou
// nepovinná, prázdné = „nevyplněno", nic se nedoplňuje odhadem.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');
const FJContext = require('../app/context.js');

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }],
  breakEvenEnabled: true, breakEvenThreshold: 5, useConnectorCommission: false, autoMergeLegs: true
};
const NAMES = [
  'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
  'getDefaultCommissionForInstrument', 'classifyResult', 'signed', 'tradeTotalPoints',
  'tradePointsTotal', 'displayPointsTotal', 'weightedExitFields', 'legFromTrade',
  'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'postExitFields', 'applyPostExitFields', 'postExitApplies', 'POST_EXIT_DERIVED_KEYS', 'combineTradeObjects',
  'courseTicksFromEvent', 'mapCapturedTrade'
];
const plain = v => JSON.parse(JSON.stringify(v));

function leg(overrides) {
  return {
    id: 'c-' + Math.random().toString(16).slice(2),
    instrument: 'MES', date: '2026-10-09', entryTime: '16:00', entryPrice: 7700,
    exitTime: '16:05', exitPrice: 7703, result: 'target', side: 'long',
    points: 3, contracts: 1, commission: 1.9, pnl: 13.1, pnlRaw: 13.1, positionId: 'pos-v2',
    ...overrides
  };
}

// ------------------------------------------------- slovník A4

test('A4: nová ruční pole jsou single-select číselníky s klíči ze zadání', () => {
  const expected = {
    trendHtf: ['TREND_HTF', ['UP', 'DOWN', 'RANGE']],
    absLocation: ['ABS_LOCATION', ['EXTREME', 'MIDDLE', 'NONE']],
    entryTestNo: ['ENTRY_TEST_NO', ['1', '2', '3+']],
    liquiditySwept: ['LIQUIDITY_SWEPT', ['YES', 'NO']],
    pathProfile: ['PATH_PROFILE', ['LVN', 'HVN', 'MIXED', 'UNKNOWN']],
    grade: ['GRADE', ['A', 'B', 'C']]
  };
  const byKey = Object.fromEntries(FJTaxonomy.TRADE_CONTEXT_FIELDS.map(f => [f.key, f]));
  for (const [key, [group, keys]] of Object.entries(expected)) {
    assert.equal(byKey[key]?.cardinality, 'single', key);
    assert.equal(byKey[key].enumName, group, key);
    assert.deepEqual(FJTaxonomy.allKeys(group), keys, group);
    assert.equal(FJTaxonomy.sanitizeSingle(group, 'PREKLEP'), '', group + ': překlep se zahodí');
  }
  assert.equal(FJTaxonomy.labelOf('TREND', 'LONG'), 'Long', 'existující trend beze změny');
});

test('A2.2: netest/test na SR řádku přežije očistu, jen když je vyplněný – starý tvar řádku se nemění', () => {
  const rows = FJTaxonomy.sanitizeLevelRows('SR_TARGET', [
    { level: 'VPOC_30M', price: 7801, ticksFromEntry: 4, testState: 'UNTESTED' },
    { level: 'VAH', price: 7803, ticksFromEntry: 12 },
    { level: 'VAL', price: 7799, ticksFromEntry: 4, testState: 'NESMYSL' }
  ]);
  assert.deepEqual(plain(rows), [
    { level: 'VPOC_30M', price: 7801, ticksFromEntry: 4, testState: 'UNTESTED' },
    { level: 'VAH', price: 7803, ticksFromEntry: 12 },
    { level: 'VAL', price: 7799, ticksFromEntry: 4 }
  ]);
});

test('A2.2: netest/test u hladin vstupu – mapa jen pro vybrané hladiny', () => {
  assert.deepEqual(plain(FJTaxonomy.sanitizeLevelTests(['VPOC_30M', 'VAH'], { VPOC_30M: 'UNTESTED', VAH: 'TESTED', VAL: 'TESTED', VWAP: 'X' })),
    { VPOC_30M: 'UNTESTED', VAH: 'TESTED' });
  assert.equal(FJTaxonomy.sanitizeLevelTests(['VAH'], {}), null, 'nic vyplněno = null, ne prázdný objekt');
});

// ------------------------------------------------- 9. známka – gradeEdited

test('A7/9: gradeEdited se nastaví až při druhé změně, ne při první', () => {
  const t0 = {};
  const first = FJContext.applyGrade({ ...t0 }, t0, 'A', '2026-10-09T14:00:00.000Z');
  assert.equal(first.grade, 'A');
  assert.equal(first.gradeSetAt, '2026-10-09T14:00:00.000Z', 'čas prvního zadání');
  assert.equal(first.gradeEdited, undefined, 'první zadání není dodatečná změna');

  const same = FJContext.applyGrade({ ...first }, first, 'A', '2026-10-09T15:00:00.000Z');
  assert.equal(same.gradeEdited, undefined, 'uložení beze změny známky není změna');
  assert.equal(same.gradeSetAt, '2026-10-09T14:00:00.000Z');

  const second = FJContext.applyGrade({ ...first }, first, 'B', '2026-10-09T16:00:00.000Z');
  assert.equal(second.grade, 'B');
  assert.equal(second.gradeEdited, true);
  assert.equal(second.gradeSetAt, '2026-10-09T14:00:00.000Z', 'čas prvního zadání zůstává');

  const cleared = FJContext.applyGrade({ ...second }, second, '', '2026-10-09T17:00:00.000Z');
  assert.equal(cleared.grade, undefined);
  assert.equal(cleared.gradeEdited, true, 'smazání známky je taky změna');
  assert.equal(FJContext.applyGrade({}, {}, '', 'x').gradeSetAt, undefined, 'bez známky se nic neukládá');
});

// ------------------------------------------------- 15. gradeRetro

test('A7/15: gradeRetro – známka zadaná po čase výstupu (živý deník)', () => {
  // 2026-10-09 17:02 Berlín = 15:02 UTC.
  const t = { date: '2026-10-09', entryTime: '17:01', exitTime: '17:02', grade: 'A' };
  assert.equal(FJContext.gradeRetro({ ...t, gradeSetAt: '2026-10-09T14:59:00.000Z' }, 'LIVE'), false, 'před vstupem');
  assert.equal(FJContext.gradeRetro({ ...t, gradeSetAt: '2026-10-09T15:10:00.000Z' }, 'LIVE'), true, 'po výstupu');
  assert.equal(FJContext.gradeRetro({ ...t, gradeSetAt: '2026-10-11T08:00:00.000Z' }, 'LIVE'), true, 'zpětně o dva dny');
  assert.equal(FJContext.gradeRetro({ date: '2026-10-09', exitTime: '17:02' }, 'LIVE'), null, 'bez známky null');
});

test('A7/15: v backtest deníku gradeRetro nejde ověřit (čas výstupu je čas replaye) → null, nikdy false', () => {
  const t = { date: '2026-03-02', exitTime: '17:02', grade: 'A', gradeSetAt: '2026-10-09T15:10:00.000Z' };
  assert.equal(FJContext.gradeRetro(t, 'BACKTEST'), null);
  assert.equal(FJContext.derivedFields(t, { mode: 'BACKTEST' }).gradeRetro, null);
  assert.equal(FJContext.derivedFields(t, { mode: 'LIVE' }).gradeRetro, true);
});

// ------------------------------------------------- 10. merge nese všechna nová pole

test('A7/10: sloučený obchod nese všechna nová pole', () => {
  const r = loadRenderer(NAMES, { settings: SETTINGS, Date });
  const tp1 = leg({
    exitTime: '16:05', trendHtf: 'UP', absLocation: 'EXTREME', grade: 'A', gradeSetAt: '2026-10-09T14:00:00.000Z',
    entryLevels: ['VPOC_30M'], entryLevelTests: { VPOC_30M: 'UNTESTED' },
    srTarget: [{ level: 'VAH', price: 7704, ticksFromEntry: 16, testState: 'TESTED' }]
  });
  const tp2 = leg({
    exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1,
    entryTestNo: '2', liquiditySwept: 'YES', pathProfile: 'LVN', gradeSetAt: '2026-10-09T13:00:00.000Z', gradeEdited: true,
    entryLevels: ['VAH'], entryLevelTests: { VAH: 'TESTED' },
    srStopLoss: [{ level: 'VAL', price: 7699, ticksFromEntry: 4, testState: 'UNTESTED' }]
  });
  const m = plain(r.combineTradeObjects([tp1, tp2]));
  assert.equal(m.trendHtf, 'UP');
  assert.equal(m.absLocation, 'EXTREME');
  assert.equal(m.entryTestNo, '2');
  assert.equal(m.liquiditySwept, 'YES');
  assert.equal(m.pathProfile, 'LVN');
  assert.equal(m.grade, 'A');
  assert.equal(m.gradeSetAt, '2026-10-09T13:00:00.000Z', 'nejdřívější zadání');
  assert.equal(m.gradeEdited, true, 'změněno u kterékoli nohy');
  assert.deepEqual(m.entryLevelTests, { VPOC_30M: 'UNTESTED', VAH: 'TESTED' });
  assert.equal(m.srTarget[0].testState, 'TESTED');
  assert.equal(m.srStopLoss[0].testState, 'UNTESTED');
});

// ------------------------------------------------- 12. duplicate detection

function importer(journal) {
  let stored = journal;
  const window = {
    desktopAPI: {
      readJournal: async () => ({ ok: true, data: JSON.parse(JSON.stringify(stored)) }),
      writeJournal: async (_id, data) => { stored = data; return { ok: true }; }
    }
  };
  const r = loadRenderer([...NAMES, 'tradeHasSourceEventId', 'appendOrMergeCapturedTrade'], { settings: SETTINGS, Date, window });
  return { r, trades: () => stored.trades };
}
const exitEvent = (id, extra) => ({
  id, type: 'trade_closed', source: 'ninjatrader', account: 'A', instrument: 'MES', side: 'long',
  entryTime: '2026-10-09T14:00:00Z', exitTime: '2026-10-09T14:05:00Z', entryPrice: 7700, exitPrice: 7703,
  quantity: 1, contracts: 1, points: 3, grossPnl: 15, commission: 0, pnl: 15, positionId: 'p-' + id, ...extra
});

test('A7/12: duplicate detection stojí jen na ID události – nová pole do klíče nevstupují', async () => {
  const withContext = { id: 't1', sourceEventId: 'e1', positionId: 'p-e1', instrument: 'MES', date: '2026-10-09', entryTime: '16:00', side: 'long',
    entryPrice: 7700, exitPrice: 7703, result: 'target', grade: 'A', gradeSetAt: '2026-10-09T13:00:00.000Z', trendHtf: 'UP', pathProfile: 'LVN', entryLevelTests: { VAH: 'TESTED' } };
  const imp = importer({ trades: [withContext], settings: [{ key: 'main', value: { ...SETTINGS } }] });
  assert.equal(imp.r.tradeHasSourceEventId(withContext, 'e1'), true);
  assert.equal(await imp.r.appendOrMergeCapturedTrade('j', exitEvent('e1')), false, 'tatáž událost podruhé = duplicita');
  assert.equal(imp.trades().length, 1);
  assert.deepEqual(plain(imp.trades()[0]), plain(withContext), 'existující obchod se nezměnil');
  assert.equal(await imp.r.appendOrMergeCapturedTrade('j', exitEvent('e9')), true, 'jiné ID se stejnými hodnotami = nový obchod');
  assert.equal(imp.trades().length, 2);
});

test('A7/12: doimport druhé nohy téže pozice zachová ruční kontext první nohy', async () => {
  const imp = importer({ trades: [], settings: [{ key: 'main', value: { ...SETTINGS } }] });
  await imp.r.appendOrMergeCapturedTrade('j', exitEvent('e1', { positionId: 'pos' }));
  const stored = imp.trades()[0];
  Object.assign(stored, { grade: 'B', gradeSetAt: '2026-10-09T13:00:00.000Z', trendHtf: 'DOWN', absLocation: 'MIDDLE' });
  await imp.r.appendOrMergeCapturedTrade('j', exitEvent('e2', { positionId: 'pos', exitTime: '2026-10-09T14:07:00Z', exitPrice: 7705, points: 5, pnl: 25, grossPnl: 25 }));
  assert.equal(imp.trades().length, 1);
  const m = imp.trades()[0];
  assert.equal(m.grade, 'B');
  assert.equal(m.trendHtf, 'DOWN');
  assert.equal(m.absLocation, 'MIDDLE');
  assert.equal(m.gradeSetAt, '2026-10-09T13:00:00.000Z');
});

// ------------------------------------------------- úplnost

test('A4: do „Neúplné“ přibývá trend 30m a známka, ostatní nová pole úplnost neblokují', () => {
  const missing = FJTaxonomy.missingContextKeys({ fillStatus: 'FILLED' });
  assert.ok(missing.includes('trendHtf'));
  assert.ok(missing.includes('grade'));
  for (const key of ['absLocation', 'entryTestNo', 'liquiditySwept', 'pathProfile']) assert.ok(!missing.includes(key), key);
  const done = FJTaxonomy.missingContextKeys({ fillStatus: 'FILLED', trendHtf: 'UP', grade: 'C' });
  assert.ok(!done.includes('trendHtf') && !done.includes('grade'));
});
