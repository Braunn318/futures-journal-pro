'use strict';
// Dokup v deníku: od událostí z main procesu po kartu obchodu a formulář.
//
// Výstup, který zavírá kontrakty ze dvou vstupů, přichází jako dvě události
// (tests/capture-scale-in.test.js). Tady se hlídá, co z nich udělá renderer:
// jeden sloučený obchod, jehož body sedí na peníze, nohy se správnými popisky,
// vstupy dopočítané z nohou a pole „Vstup" u cíle ve formuláři.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const { captureHarness } = require('./helpers/capture-harness');
const FJPoints = require('../app/points.js');
const FJTaxonomy = require('../app/taxonomy.js');

const POINT_VALUE = 2;
const SETTINGS = {
  templates: [{ instrument: 'MNQ', pointValue: POINT_VALUE, defaultCommission: 1.9 }],
  breakEvenEnabled: false,
  useConnectorCommission: false,
  autoMergeLegs: true
};
const ENTRY_AVG = (30738.50 + 5 * 30738.75) / 6;
const cents = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 0.0101, `${message || 'částka'}: ${actual} ≠ ${expected}`);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message || 'hodnota'}: ${actual} ≠ ${expected}`);

// Události obchodu z 2026-10-13 – ze skutečného processExecution. Exekuce jsou
// opsané ze záznamu toho, kdo chybu nahlásil (tests/capture-scale-in.test.js).
async function reportedEvents() {
  const h = captureHarness({ instrument: 'MNQ', instrumentFull: 'MNQ 12-26', pointValue: POINT_VALUE, startTime: '2026-10-13T16:09:00.000Z' });
  const step = (id, order, action, name, quantity, price, positionAfter, time) =>
    h.exec({ executionId: id, orderId: order, orderAction: action, orderName: name, quantity, price, positionAfter, time, commission: 0.95 * quantity });
  await step('e1', 'o-entry', 'Buy', 'Entry', 1, 30738.50, 1, '2026-10-13T16:09:41.807Z');
  await step('e2', 'o-entry', 'Buy', 'Entry', 5, 30738.75, 6, '2026-10-13T16:09:41.819Z');
  await step('t1', 'o-tp1', 'Sell', 'Target1', 4, 30752.50, 2, '2026-10-13T16:16:58.444Z');
  await step('e3', 'o-dokup', 'Buy', 'Entry', 1, 30759.50, 3, '2026-10-13T16:19:57.198Z');
  await step('t2', 'o-tp2', 'Sell', 'Stop2', 1, 30763.75, 2, '2026-10-13T16:26:20.462Z');
  await step('t3', 'o-tp3', 'Sell', 'Target2', 2, 30786.50, 0, '2026-10-13T16:30:17.582Z');
  return h.closed().map(e => ({ source: 'ninjatrader', ...e }));
}

const IMPORT_NAMES = [
  'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
  'getDefaultCommissionForInstrument', 'classifyResult', 'signed', 'tradeTotalPoints',
  'tradePointsTotal', 'displayPointsTotal', 'weightedExitFields', 'legFromTrade',
  'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'postExitFields', 'applyPostExitFields', 'postExitApplies', 'POST_EXIT_DERIVED_KEYS', 'combineTradeObjects', 'courseTicksFromEvent', 'mapCapturedTrade',
  'tradeHasSourceEventId', 'appendOrMergeCapturedTrade'
];

// Import přes skutečný appendOrMergeCapturedTrade; deník je objekt v paměti.
async function importReported(settings = SETTINGS) {
  const data = { trades: [], settings: [{ key: 'main', value: settings }] };
  const window = { desktopAPI: { readJournal: async () => ({ ok: true, data }), writeJournal: async () => ({ ok: true }) } };
  const r = loadRenderer(IMPORT_NAMES, { settings, Date, window });
  for (const event of await reportedEvents()) {
    await r.appendOrMergeCapturedTrade('j1', event, ['fjimg://vstup', `fjimg://vystup-${event.sourceExecutionId}`]);
  }
  return { r, data };
}

test('import: dokup a částečné výstupy dají jeden obchod, jehož body sedí na peníze', async () => {
  const { data } = await importReported();
  assert.equal(data.trades.length, 1, 'jeden sloučený obchod');
  const t = data.trades[0];
  assert.equal(t.contracts, 7);
  near(t.pointsTotal, 155, 'celkové body (deník ukázal 148)');
  assert.equal(t.commission, 13.3, 'komise ze šablony: 1,90 × 7');
  // 310,00 − 13,30 = 296,70; čistý výsledek každé nohy se zaokrouhluje na centy
  // zvlášť (mapCapturedTrade), proto tolerance na cent.
  cents(t.pnlRaw, 296.7, 'čistý výsledek (deník ukázal 282,70)');
  cents(t.pointsTotal * POINT_VALUE - t.commission, t.pnlRaw, 'body × hodnota bodu − komise = čistý výsledek');
  near(t.entryPrice, ENTRY_AVG, 'vstupní cena obchodu je první vstup, ne cena dokupu');
  assert.equal(t.exitPrice, 30763.8214, 'vážená výstupní cena jako v exportu deníku');
  assert.equal(t.side, 'long');
});

test('import: nohy téhož výstupu sdílejí popisek a zůstávají oddělené podle vstupu', async () => {
  const { data } = await importReported();
  const legs = data.trades[0].legs;
  assert.deepEqual(Array.from(legs, l => l.label), ['TP1', 'TP2', 'TP3', 'TP3']);
  assert.deepEqual(Array.from(legs, l => l.contracts), [4, 1, 1, 1]);
  const points = [30752.50 - ENTRY_AVG, 30763.75 - ENTRY_AVG, 30786.50 - ENTRY_AVG, 27];
  legs.forEach((l, i) => near(l.points, points[i], `body nohy ${i}`));
  assert.equal(legs[2].exitPrice, legs[3].exitPrice, 'stejná výstupní cena…');
  assert.equal(legs[3].entryPrice, 30759.5, '…ale noha dokoupeného kontraktu má vlastní vstup');
  assert.deepEqual(Array.from(legs, l => FJPoints.legIsScaleIn(l, data.trades[0])), [false, false, false, true]);
  near(Array.from(legs).reduce((a, l) => a + l.pnlRaw, 0), data.trades[0].pnlRaw, 'součet čistých výsledků nohou');
});

test('import: vstupy se počítají z nohou – vstup obchodu a dokup', async () => {
  const { data } = await importReported();
  const t = data.trades[0];
  const entries = FJPoints.entriesOf(t);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].contracts, 6);
  near(entries[0].price, ENTRY_AVG);
  assert.equal(entries[0].time, t.entryTime);
  assert.deepEqual({ price: entries[1].price, contracts: entries[1].contracts, time: entries[1].time }, { price: 30759.5, contracts: 1, time: t.legs[3].entryTime });
  assert.notEqual(entries[1].time, t.entryTime, 'dokup má vlastní čas');
  assert.equal(t.entries, undefined, 'druhý seznam vedle nohou se neukládá');
});

test('import: screenshoty se ve sloučeném obchodu neopakují', async () => {
  const { data } = await importReported();
  assert.deepEqual(Array.from(data.trades[0].images), ['fjimg://vstup', 'fjimg://vystup-t1', 'fjimg://vystup-t2']);
});

test('import bez automatického slučování: každá noha je obchod se svým vstupem', async () => {
  const { data } = await importReported({ ...SETTINGS, autoMergeLegs: false });
  assert.equal(data.trades.length, 4);
  assert.deepEqual(data.trades.map(t => t.entryPrice).slice(2), [ENTRY_AVG, 30759.5]);
  cents(data.trades.reduce((a, t) => a + t.pnlRaw, 0), 296.7);
  assert.deepEqual(data.trades.map(t => FJPoints.entriesOf(t).length), [1, 1, 1, 1], 'samostatný obchod má jeden vstup');
});

// ---- karta obchodu ----

function cardRenderer(globals = {}) {
  return loadRenderer([
    'esc', 'money', 'moneyCzk', 'dualMoney', 'signed', 'sideMeta', 'resultMeta',
    'legPillHTML', 'hypotheticalGroup', 'skippedReasonText', 'tradeTotalPoints', 'tradePointsTotal', 'displayPointsTotal', 'formatLevelRow', 'contextPillsHTML', 'incompleteBadgeHTML', 'levelPillsHTML', 'openTradeLevels', 'tradeLevelsBlockHTML', 'tradeHTML',
    'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'contextFieldShown'
  ], { settings: { ...SETTINGS, usdCzkRate: 23 }, activeJournalId: 'j1', Intl, document: { getElementById: () => null }, ...globals });
}

test('karta: řádek Vstupy, pilulka dokupu a zaokrouhlené body', async () => {
  const { data } = await importReported();
  const html = cardRenderer().tradeHTML({ ...data.trades[0], id: 't1', images: [] });
  assert.match(html, /Vstupy: 6 @ 30738\.7083 · dokup 1 @ 30759\.5 \(\d\d:\d\d\)/);
  assert.match(html, />TP1: \+13\.7917b</);
  assert.match(html, />TP2: \+25\.0417b</, 'aplikace ukázala +18,08');
  assert.match(html, />TP3: \+47\.7917b</, 'aplikace ukázala +37,375');
  assert.match(html, />TP3 · dokup: \+27b</);
  assert.match(html, /TP3 · dokup: vstup \d\d:\d\d @ 30759\.5 → /, 'nápověda pilulky říká, odkud se body počítají');
  assert.doesNotMatch(html, /\d\.\d{5,}b</, 'žádná pilulka typu +18.08333333329938b');
  assert.match(html, /\+155 bodů/);
});

test('karta: skryté pole „Vstupy a dokupy" řádek schová, data zůstávají', async () => {
  const { data } = await importReported();
  const t = { ...data.trades[0], id: 't1', images: [] };
  const hidden = cardRenderer({ contextFieldConfig: FJTaxonomy.normalizeFieldConfig({ entries: { show: false } }) });
  assert.doesNotMatch(hidden.tradeHTML(t), /Vstupy:/);
  assert.equal(FJPoints.entriesOf(t).length, 2);
  assert.equal(FJTaxonomy.fieldWarns(FJTaxonomy.normalizeFieldConfig({ entries: { warn: true } }), 'entries'), false, 'pole se nekontroluje');
});

test('karta: obchod bez dokupu řádek Vstupy nemá a pilulky jsou jako dřív', () => {
  const html = cardRenderer().tradeHTML({
    id: 't2', instrument: 'MNQ', date: '2026-10-13', entryTime: '16:00', entryPrice: 30700, exitTime: '16:10', exitPrice: 30707.5,
    result: 'target', side: 'long', points: 15, pointsTotal: 15, pointsPerContract: 7.5, contracts: 2, commission: 3.8, pnl: 26.2, pnlRaw: 26.2,
    planFollowed: 'ano', images: [],
    legs: [
      { label: 'TP1', exitTime: '16:05', exitPrice: 30705, points: 5, contracts: 1, pnl: 8.1, pnlRaw: 8.1, result: 'target', entryPrice: 30700, entryTime: '16:00' },
      { label: 'TP2', exitTime: '16:10', exitPrice: 30710, points: 10, contracts: 1, pnl: 18.1, pnlRaw: 18.1, result: 'target' }
    ]
  });
  assert.doesNotMatch(html, /Vstupy:/);
  assert.doesNotMatch(html, /dokup/);
  assert.match(html, />TP1: \+5b</);
  assert.match(html, />TP2: \+10b</);
});

// ---- slučování a popisky nohou ----

const LEG_NAMES = ['mergeSamePriceLegs', 'labelLegs'];
const leg = over => ({ result: 'target', exitPrice: 110, exitTime: '16:10', points: 10, contracts: 1, pnl: 18, pnlRaw: 18, commission: 2, sourceEventIds: [], ...over });

test('nohy na stejné výstupní ceně se slučují jen ze stejného vstupu', () => {
  const r = loadRenderer(LEG_NAMES);
  const same = r.mergeSamePriceLegs([leg({ entryPrice: 100 }), leg({ entryPrice: 100 })]);
  assert.equal(same.length, 1);
  assert.equal(same[0].contracts, 2);
  assert.equal(same[0].points, 10);
  const split = r.mergeSamePriceLegs([leg({ entryPrice: 100 }), leg({ entryPrice: 105, points: 5, pnl: 8, pnlRaw: 8 })]);
  assert.equal(split.length, 2, 'dokoupený kontrakt zůstává vlastní nohou');
  assert.deepEqual(Array.from(split, l => l.points), [10, 5]);
});

test('starší nohy bez vstupní ceny: slučují se jako dřív, body váženě', () => {
  const r = loadRenderer(LEG_NAMES);
  const equal = r.mergeSamePriceLegs([leg({}), leg({ contracts: 2 })]);
  assert.equal(equal.length, 1);
  assert.equal(equal[0].points, 10, 'stejné body se nepřepočítávají');
  assert.equal(equal[0].contracts, 3);
  const mixed = r.mergeSamePriceLegs([leg({ points: 10 }), leg({ points: 4, contracts: 2, entryPrice: 106 })]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].points, 6, '(10 × 1 + 4 × 2) / 3 – dřív zůstalo 10 a celkové body neseděly na zisk');
});

test('popisky: úseky téhož výstupu jsou jeden cíl, break even se nečísluje', () => {
  const r = loadRenderer(LEG_NAMES);
  const legs = r.labelLegs([
    leg({ exitExecutionId: 'a' }), leg({ exitExecutionId: 'a', entryPrice: 105 }),
    leg({ result: 'breakeven', exitExecutionId: 'b' }),
    leg({ exitExecutionId: 'c' }), leg({ exitExecutionId: 'c', result: 'stoploss' }),
    leg({})
  ]);
  assert.deepEqual(Array.from(legs, l => l.label), ['TP1', 'TP1', 'BE', 'TP2', 'TP2', 'TP3']);
  // Úsek dokoupených kontraktů zavřený kolem své vstupní ceny je break even,
  // i když původní kontrakty na tomtéž výstupu vydělaly – a číslování neposune.
  const mixed = r.labelLegs([leg({ exitExecutionId: 'a' }), leg({ exitExecutionId: 'b' }), leg({ exitExecutionId: 'b', result: 'breakeven' }), leg({ exitExecutionId: 'c' })]);
  assert.deepEqual(Array.from(mixed, l => l.label), ['TP1', 'TP2', 'BE', 'TP3']);
  assert.deepEqual(Array.from(r.labelLegs([leg({}), leg({}), leg({ result: 'breakeven' }), leg({})]), l => l.label), ['TP1', 'TP2', 'BE', 'TP3'], 'bez výstupní exekuce beze změny');
});

// ---- FJPoints.entriesOf ----

test('entriesOf: obchod bez nohou, nohy bez vlastního vstupu, víc dokupů', () => {
  assert.deepEqual(FJPoints.entriesOf({ entryTime: '16:00', entryPrice: 100, contracts: 3 }), [{ time: '16:00', price: 100, contracts: 3 }]);
  const trade = {
    entryTime: '16:00', entryPrice: 100,
    legs: [
      { contracts: 2 },
      { contracts: 1, entryPrice: 100, entryTime: '16:00' },
      { contracts: 1, entryPrice: 108, entryTime: '16:20' },
      { contracts: 2, entryPrice: 104, entryTime: '16:10' },
      { contracts: 1, entryPrice: 104, entryTime: '16:10' }
    ]
  };
  assert.deepEqual(FJPoints.entriesOf(trade), [
    { time: '16:00', price: 100, contracts: 3 },
    { time: '16:10', price: 104, contracts: 3 },
    { time: '16:20', price: 108, contracts: 1 }
  ]);
  assert.equal(FJPoints.legIsScaleIn({ entryPrice: 100 }, trade), false);
  assert.equal(FJPoints.legIsScaleIn({}, trade), false);
  assert.equal(FJPoints.legIsScaleIn({ entryPrice: 104 }, { entryPrice: '' }), false, 'bez vstupní ceny obchodu se nic netvrdí');
});

// ---- formulář: pole „Vstup" u cíle ----

function legForm({ entryPrice = '100', side = 'long', row }) {
  const nodes = new Map([['entryPrice', { value: entryPrice }], ['side', { value: side }], ['instrument', { value: 'MNQ 12-26' }]]);
  const document = { getElementById: id => nodes.get(id) || null, querySelectorAll: () => [rowEl] };
  const fields = Object.fromEntries(Object.entries({
    '.leg-label': 'TP2', '.leg-entryPrice': '', '.leg-exitTime': '16:30', '.leg-exitPrice': '', '.leg-result': '',
    '.leg-points': '', '.leg-pnl': '', '.leg-commission': '1.9', '.leg-contracts': '1', ...row
  }).map(([k, v]) => [k, { value: String(v), title: '' }]));
  fields['.leg-result-badge'] = { textContent: '', className: '' };
  const rowEl = { dataset: {}, querySelector: cls => fields[cls] };
  const r = loadRenderer(['$', 'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument', 'priceDirectionSign', 'netFromGross',
    'classifyResult', 'resultMeta', 'updateLegBadge', 'recomputeLegRow', 'readLegRows'], { document, settings: SETTINGS });
  return { r, rowEl, fields, value: cls => fields[cls].value };
}

test('formulář: cíl bez vlastního vstupu se počítá od vstupu obchodu', () => {
  const f = legForm({ row: { '.leg-exitPrice': '120' } });
  f.r.recomputeLegRow(f.rowEl);
  assert.equal(Number(f.value('.leg-points')), 20);
  assert.equal(Number(f.value('.leg-pnl')), 38.1, '20 b × 2 USD − 1,90');
});

test('formulář: cíl dokoupených kontraktů se počítá od ceny dokupu', () => {
  const f = legForm({ row: { '.leg-exitPrice': '120', '.leg-entryPrice': '110' } });
  f.r.recomputeLegRow(f.rowEl);
  assert.equal(Number(f.value('.leg-points')), 10, 'dřív by zásah do řádku přepočítal body od vstupu obchodu (20)');
  assert.equal(Number(f.value('.leg-pnl')), 18.1);
  f.rowEl.dataset.entryTime = '16:18';
  f.rowEl.dataset.exitExecutionId = 't3';
  const [row] = f.r.readLegRows();
  assert.deepEqual({ entryPrice: row.entryPrice, entryTime: row.entryTime, exitExecutionId: row.exitExecutionId }, { entryPrice: 110, entryTime: '16:18', exitExecutionId: 't3' });
});

test('formulář: dokup u shortu – znaménko podle vstupu cíle', () => {
  const f = legForm({ entryPrice: '200', side: 'short', row: { '.leg-exitPrice': '180', '.leg-entryPrice': '185' } });
  f.r.recomputeLegRow(f.rowEl);
  assert.equal(Number(f.value('.leg-points')), 5);
  assert.equal(Number(f.value('.leg-pnl')), 8.1);
  assert.equal(f.r.readLegRows()[0].entryPrice, 185);
});

test('formulář: prázdné pole „Vstup" se neukládá jako nula', () => {
  const f = legForm({ row: { '.leg-exitPrice': '120' } });
  assert.equal(f.r.readLegRows()[0].entryPrice, null);
});
