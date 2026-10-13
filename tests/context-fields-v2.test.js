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
  // Trend 30m se čte stejně jako trend 1m (zpětná vazba 13. 10.): Long / Short /
  // Range. Mění se jen popisky – klíče UP / DOWN / RANGE jsou v uložených
  // obchodech i v exportu a zůstávají.
  assert.deepEqual(FJTaxonomy.allKeys('TREND_HTF').map(k => FJTaxonomy.labelOf('TREND_HTF', k)), ['Long', 'Short', 'Range']);
  assert.deepEqual(FJTaxonomy.allKeys('TREND_HTF').map(k => FJTaxonomy.labelOf('TREND_HTF', k)),
    FJTaxonomy.allKeys('TREND').map(k => FJTaxonomy.labelOf('TREND', k)), 'stejné popisky jako trend 1m');
  assert.equal(FJTaxonomy.sanitizeSingle('TREND_HTF', 'UP'), 'UP', 'uložený klíč zůstává platný');
  // Kontext v3: vybraná likvidita a profil cesty jsou zrušené i jako číselníky.
  for (const gone of ['LIQUIDITY_SWEPT', 'PATH_PROFILE']) assert.equal(FJTaxonomy[gone], undefined, gone);
  for (const gone of ['liquiditySwept', 'pathProfile', 'entryLevelTests']) assert.equal(byKey[gone], undefined, gone);
});

test('A2.2: netest/test na řádku hladiny přežije očistu, jen když je vyplněný', () => {
  const rows = FJTaxonomy.sanitizeNearLevels('NEAR_LEVEL', [
    { level: 'VPOC_30M', price: 7801, testState: 'UNTESTED' },
    { level: 'VAH', price: 7803 },
    { level: 'VAL', price: 7799, testState: 'NESMYSL' }
  ]);
  assert.deepEqual(plain(rows), [
    { level: 'VPOC_30M', price: 7801, testState: 'UNTESTED' },
    { level: 'VAH', price: 7803 },
    { level: 'VAL', price: 7799 }
  ]);
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
// „Doplněno zpětně" = známka zadaná až po LHŮTĚ od uložení obchodu do deníku
// (zpětná vazba 13. 10.). Importovaný obchod v deníku vznikne až výstupem, takže
// známku dřív zadat nejde – pravidlo „po čase výstupu" označilo každý. Uložení
// je createdAt; u pozice s víc cíli pozdější z createdAt a posledního výstupu.
// Lhůta je nastavení deníku (gradeRetroGraceMinutes), výchozí 30 minut.

// 2026-10-09 17:02 Berlín = 15:02 UTC. Import proběhne pár vteřin po výstupu.
const IMPORTED = { date: '2026-10-09', entryTime: '17:01', exitTime: '17:02', grade: 'A', createdAt: Date.parse('2026-10-09T15:02:20.000Z') };
const retro = (extra, mode = 'LIVE', grace) => FJContext.gradeRetro({ ...IMPORTED, ...extra }, mode, grace);

test('A7/15: známka zadaná do 30 minut od uložení obchodu NENÍ doplněná zpětně', () => {
  assert.equal(FJContext.GRADE_RETRO_GRACE_MIN, 30);
  assert.equal(retro({ gradeSetAt: '2026-10-09T15:06:00.000Z' }), false, '4 minuty po importu – dřív to nešlo');
  assert.equal(retro({ gradeSetAt: '2026-10-09T15:32:20.000Z' }), false, 'přesně na konci lhůty');
  assert.equal(retro({ gradeSetAt: '2026-10-09T14:59:00.000Z' }), false, 'před vstupem');
});

test('A7/15: známka zadaná po lhůtě JE doplněná zpětně', () => {
  assert.equal(retro({ gradeSetAt: '2026-10-09T15:32:21.000Z' }), true, 'vteřinu po lhůtě');
  assert.equal(retro({ gradeSetAt: '2026-10-11T08:00:00.000Z' }), true, 'o dva dny později');
});

test('A7/15: lhůta běží od uložení (createdAt), ne od času výstupu', () => {
  // Ručně zapsaný obchod: výstup 17:02, do deníku uložen až 19:00 (17:00 UTC).
  const manual = { createdAt: Date.parse('2026-10-09T17:00:00.000Z') };
  assert.equal(retro({ ...manual, gradeSetAt: '2026-10-09T17:20:00.000Z' }), false, '20 minut po uložení');
  assert.equal(retro({ ...manual, gradeSetAt: '2026-10-09T17:31:00.000Z' }), true, '31 minut po uložení');
});

test('A7/15: pozice s víc cíli – createdAt je první cíl, lhůta běží od posledního výstupu', () => {
  // První cíl importován 15:02 UTC, poslední výstup až 18:10 Berlín (16:10 UTC).
  const merged = { exitTime: '18:10' };
  assert.equal(retro({ ...merged, gradeSetAt: '2026-10-09T16:25:00.000Z' }), false, '15 minut po posledním výstupu');
  assert.equal(retro({ ...merged, gradeSetAt: '2026-10-09T16:45:00.000Z' }), true, '35 minut po posledním výstupu');
});

test('A7/15: lhůta je nastavitelná; 0 = přísně hned po uložení; nesmysl = výchozích 30', () => {
  const at = '2026-10-09T15:12:20.000Z'; // 10 minut po importu
  assert.equal(retro({ gradeSetAt: at }, 'LIVE', 5), true);
  assert.equal(retro({ gradeSetAt: at }, 'LIVE', 15), false);
  assert.equal(retro({ gradeSetAt: at }, 'LIVE', 0), true);
  assert.equal(retro({ gradeSetAt: at }, 'LIVE', '120'), false, 'číslo jako text z pole formuláře');
  for (const bad of [undefined, null, '', 'abc', -5, NaN]) assert.equal(retro({ gradeSetAt: at }, 'LIVE', bad), false, String(bad) + ' → výchozí lhůta');
  assert.equal(FJContext.gradeRetroGrace(45), 45);
  assert.equal(FJContext.gradeRetroGrace(''), 30);
  assert.equal(FJContext.gradeRetroGrace(-1), 30);
});

test('A7/15: obchod bez createdAt (starší data) – lhůta od času výstupu; bez časů nebo známky null', () => {
  const old = { createdAt: undefined };
  assert.equal(retro({ ...old, gradeSetAt: '2026-10-09T15:20:00.000Z' }), false, '18 minut po výstupu');
  assert.equal(retro({ ...old, gradeSetAt: '2026-10-09T15:40:00.000Z' }), true, '38 minut po výstupu');
  assert.equal(FJContext.gradeRetro({ grade: 'A', gradeSetAt: '2026-10-09T15:40:00.000Z' }, 'LIVE'), null, 'bez uložení i výstupu nejde určit');
  assert.equal(FJContext.gradeRetro({ date: '2026-10-09', exitTime: '17:02', createdAt: 1 }, 'LIVE'), null, 'bez známky null');
  assert.equal(retro({ gradeSetAt: 'nesmysl' }), null);
});

test('A7/15: v backtest deníku gradeRetro nejde ověřit → null, nikdy false (beze změny)', () => {
  const t = { ...IMPORTED, date: '2026-03-02', gradeSetAt: '2026-10-11T08:00:00.000Z' };
  assert.equal(FJContext.gradeRetro(t, 'BACKTEST'), null);
  assert.equal(FJContext.gradeRetro({ ...t, gradeSetAt: '2026-10-09T15:06:00.000Z' }, 'BACKTEST'), null);
  assert.equal(FJContext.derivedFields(t, { mode: 'BACKTEST' }).gradeRetro, null);
  assert.equal(FJContext.derivedFields(t, { mode: 'LIVE' }).gradeRetro, true);
});

test('A7/15: derivedFields bere lhůtu z nastavení deníku (gradeRetroGraceMin)', () => {
  const t = { ...IMPORTED, gradeSetAt: '2026-10-09T15:12:20.000Z' };
  assert.equal(FJContext.derivedFields(t, { mode: 'LIVE' }).gradeRetro, false, 'výchozí lhůta 30 minut');
  assert.equal(FJContext.derivedFields(t, { mode: 'LIVE', gradeRetroGraceMin: 5 }).gradeRetro, true);
});

// ------------------------------------------------- 10. merge nese všechna nová pole

test('A7/10: sloučený obchod nese všechna nová pole', () => {
  const r = loadRenderer(NAMES, { settings: SETTINGS, Date });
  const tp1 = leg({
    exitTime: '16:05', trendHtf: 'UP', absLocation: 'EXTREME', grade: 'A', gradeSetAt: '2026-10-09T14:00:00.000Z',
    entryLevels: ['VPOC_30M'],
    nearLevels: [{ level: 'VAH', price: 7704, testState: 'TESTED' }]
  });
  const tp2 = leg({
    exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1,
    entryTestNo: '2', gradeSetAt: '2026-10-09T13:00:00.000Z', gradeEdited: true,
    entryLevels: ['VAH'],
    // Zrušená pole (kontext v3) u nohy ze starší verze se sloučením nepřenášejí.
    liquiditySwept: 'YES', pathProfile: 'LVN', entryLevelTests: { VAH: 'TESTED' },
    nearLevels: [{ level: 'VAL', price: 7699, testState: 'UNTESTED' }]
  });
  const m = plain(r.combineTradeObjects([tp1, tp2]));
  assert.equal(m.trendHtf, 'UP');
  assert.equal(m.absLocation, 'EXTREME');
  assert.equal(m.entryTestNo, '2');
  assert.equal(m.grade, 'A');
  assert.equal(m.gradeSetAt, '2026-10-09T13:00:00.000Z', 'nejdřívější zadání');
  assert.equal(m.gradeEdited, true, 'změněno u kterékoli nohy');
  assert.deepEqual(m.entryLevels, ['VPOC_30M', 'VAH']);
  assert.deepEqual(m.nearLevels, [{ level: 'VAH', price: 7704, testState: 'TESTED' }, { level: 'VAL', price: 7699, testState: 'UNTESTED' }]);
  for (const gone of ['liquiditySwept', 'pathProfile', 'entryLevelTests', 'srTarget', 'srStopLoss']) assert.equal(gone in m, false, gone);
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
    entryPrice: 7700, exitPrice: 7703, result: 'target', grade: 'A', gradeSetAt: '2026-10-09T13:00:00.000Z', trendHtf: 'UP', absLocation: 'EXTREME', nearLevels: [{ level: 'VAH', price: 7704, testState: 'TESTED' }] };
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
  for (const key of ['absLocation', 'entryTestNo']) assert.ok(!missing.includes(key), key);
  const done = FJTaxonomy.missingContextKeys({ fillStatus: 'FILLED', trendHtf: 'UP', grade: 'C' });
  assert.ok(!done.includes('trendHtf') && !done.includes('grade'));
});
