'use strict';
// Psychika 1–8 (4.8.7): obchod (před vstupem / v průběhu / po výstupu) a den
// (před seancí / v průběhu / po seanci).
//
// Co se hlídá:
//  - škála je číselník deníku (přejmenovat, skrýt, přeřadit), ale pevná –
//    vlastní hodnota nejde přidat ani přes import,
//  - nic se ve výchozím stavu nehlásí (starší obchody nezčervenají); každé
//    pole jde hlídat zvlášť, u dne zvlášť i místo upozornění (den / obchody),
//  - sloučení nohou, Rychlý kontext a uložení dne hodnotu neztratí,
//  - export CSV nese všech šest hodnot (sloupce až na konci),
//  - „Nahrát zálohu JSON" obnoví i denní poznámky (do 4.8.6 je zahodila).

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

const plain = v => JSON.parse(JSON.stringify(v));
const fields = over => FJTaxonomy.normalizeFieldConfig(over);
const missing = (trade, fieldCfg, opts, cardCfg = {}) => FJTaxonomy.missingForCards(trade, cardCfg, undefined, fieldCfg, opts);

const COMPLETE = {
  instrument: 'MES', date: '2026-10-16', entryTime: '15:30',
  setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'SHORT', entryLevels: ['VPOC_DAY'],
  nearLevels: [{ level: 'VPOC_30M', price: 7730, testState: 'TESTED' }], ofConfirm: ['ABS_ASK'],
  targetLevel1: { type: 'VPOC_1M', price: 7737.75 }, slPrice: 7746, mfeTicks: 18, maeTicks: 2,
  postExitFavorableTicks: 1, postExitAdverseTicks: 30, trendHtf: 'DOWN', grade: 'A'
};

// ------------------------------------------------------------ číselník

test('škála PSYCH: klíče 1–8, krajní hodnoty s popisem, v Číselnících jako pevná skupina', () => {
  assert.deepEqual(FJTaxonomy.allKeys('PSYCH'), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(FJTaxonomy.labelOf('PSYCH', '1'), '1 – nejhorší');
  assert.equal(FJTaxonomy.labelOf('PSYCH', '8'), '8 – nejlepší');
  assert.equal(FJTaxonomy.GROUP_BY_NAME.PSYCH.fixed, true);
  assert.equal(FJTaxonomy.sanitizeSingle('PSYCH', '9'), '', 'mimo škálu se zahodí');
  for (const key of ['psychBefore', 'psychDuring', 'psychAfter']) {
    const f = FJTaxonomy.TRADE_CONTEXT_FIELDS.find(x => x.key === key);
    assert.equal(f?.cardinality, 'single', key + ' se slučuje jako single-select');
    assert.equal(f.enumName, 'PSYCH', key);
  }
});

test('škála PSYCH: popisek jde přejmenovat a hodnotu skrýt, vlastní hodnota se zahodí i z importu', () => {
  const cfg = FJTaxonomy.sanitizeConfig({ PSYCH: { labels: { '1': 'hrozné' }, hidden: ['2'], custom: { CUSTOM_DEVET: '9' } } });
  assert.deepEqual(plain(cfg), { PSYCH: { labels: { '1': 'hrozné' }, hidden: ['2'] } });
  assert.equal(FJTaxonomy.labelOf('PSYCH', '1', cfg), 'hrozné');
  assert.deepEqual(FJTaxonomy.visibleOptions('PSYCH', [], cfg).map(o => o.key), ['1', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(FJTaxonomy.visibleOptions('PSYCH', ['2'], cfg).map(o => o.key).includes('2'), true, 'skrytá hodnota uložená u obchodu se nabídne dál');
});

// ------------------------------------------------------------ upozornění

test('výchozí stav: psychika se nehlásí – starší obchody nezčervenají', () => {
  assert.deepEqual(missing(COMPLETE, fields({})), []);
  assert.deepEqual(plain(FJTaxonomy.missingDayPsych({}, fields({}))), [], 'pole dne bez upozornění – den nic nehlásí, a tak ani jeho obchody');
});

test('psychika obchodu: každé pole se hlásí zvlášť, v kartě Psychika; skryté pole ani karta bez upozornění nehlásí', () => {
  const on = fields({ psychBefore: { warn: true }, psychAfter: { warn: true } });
  assert.deepEqual(missing(COMPLETE, on), ['Psychika – před vstupem', 'Psychika – po výstupu']);
  assert.deepEqual(missing({ ...COMPLETE, psychBefore: '5' }, on), ['Psychika – po výstupu']);
  assert.deepEqual(missing({ ...COMPLETE, psychBefore: '9' }, on), ['Psychika – před vstupem', 'Psychika – po výstupu'], 'hodnota mimo škálu není vyplněná');
  assert.deepEqual(missing(COMPLETE, fields({ psychBefore: { warn: true, show: false } })), [], 'skryté pole neupozorňuje');
  const cards = FJTaxonomy.normalizeCardConfig({ psych: { warn: false } });
  assert.deepEqual(missing(COMPLETE, on, undefined, cards), [], 'karta bez upozornění');
  assert.deepEqual(plain(FJTaxonomy.missingContextByCard(COMPLETE, undefined, on).psych), ['Psychika – před vstupem', 'Psychika – po výstupu']);
  assert.deepEqual(missing({ recordType: 'SETUP_ONLY' }, on), [], 'setup bez vstupu se neposuzuje');
});

test('psychika dne: hlídaná pole, místo upozornění na dni / u obchodů jde vypnout zvlášť', () => {
  const day = fields({ psychDayBefore: { warn: true }, psychDayAfter: { warn: true } });
  assert.deepEqual(plain(FJTaxonomy.missingDayPsych({}, day)), ['before', 'after']);
  assert.deepEqual(plain(FJTaxonomy.missingDayPsych({ before: '4' }, day)), ['after']);
  assert.deepEqual(plain(FJTaxonomy.missingDayPsych({ before: '4', after: '7' }, day)), []);
  assert.deepEqual(plain(FJTaxonomy.missingDayPsych({}, fields({ psychDayBefore: { warn: true, show: false } }))), [], 'skryté pole dne se nehlídá');
  // U obchodu: volající ví, že dni chybí (dayPsychMissing); hlásí se jen se
  // zapnutým „upozornění u obchodů dne".
  assert.deepEqual(missing(COMPLETE, day, { dayPsychMissing: true }), ['Psychika dne']);
  assert.deepEqual(missing(COMPLETE, fields({ psychDayWarnTrades: { warn: false } }), { dayPsychMissing: true }), []);
  // Řádky „kde upozorňovat" nejdou skrýt, jen vypnout.
  assert.equal(FJTaxonomy.fieldShown(fields({ psychDayWarnDay: { show: false } }), 'psychDayWarnDay'), true);
  assert.equal(FJTaxonomy.fieldWarns(fields({ psychDayWarnDay: { show: false } }), 'psychDayWarnDay'), true);
  assert.equal(FJTaxonomy.fieldWarns(fields({ psychDayWarnDay: { warn: false } }), 'psychDayWarnDay'), false);
});

test('psychika dne: uloží se jen známé části s hodnotou ze škály', () => {
  assert.deepEqual(plain(FJTaxonomy.sanitizeDayPsych({ before: '3', during: '', after: '9', jine: '1' })), { before: '3' });
  assert.equal(FJTaxonomy.sanitizeDayPsych({}), null);
  assert.equal(FJTaxonomy.sanitizeDayPsych(null), null);
});

// ------------------------------------------------------------ renderer

function rendererJournal(initial) {
  const r = loadRenderer(['SCHEMA_VERSION', 'ensureActiveJournalData', 'commitJournal', 'emptyDayNote', 'getDayNote', 'saveDayNote', 'saveDayContext', 'saveDayPsych', 'dayNoteIsEmpty'], {
    db: { data: initial, close() {} },
    activeJournalId: 'j1',
    window: { desktopAPI: { writeJournal: async () => ({ ok: true }) } }
  });
  return { ...r, data: () => vm.runInContext('db.data', r.__context) };
}

test('den: psychika se doplňuje po částech, den jen s psychikou se nesmaže, prázdná se neukládá', async () => {
  const j = rendererJournal({ trades: [], settings: [], dayNotes: {} });
  await j.saveDayPsych('2026-10-16', { before: '6' });
  await j.saveDayPsych('2026-10-16', { after: '3' });
  assert.deepEqual(plain(j.data().dayNotes['2026-10-16']), { comment: '', preview: '', notes: '', images: [], psych: { before: '6', after: '3' } });
  await j.saveDayNote('2026-10-16', { comment: '' });
  assert.deepEqual(plain(j.data().dayNotes['2026-10-16'].psych), { before: '6', after: '3' }, 'poznámka s psychikou není prázdná');
  await j.saveDayContext('2026-10-16', { openVsValue: '' });
  assert.ok(j.data().dayNotes['2026-10-16'], 'uložení kontextu dne psychiku nesmaže');
  await j.saveDayPsych('2026-10-16', { before: '', after: '' });
  assert.equal(j.data().dayNotes['2026-10-16'], undefined, 'den bez obsahu se smaže');
});

const MERGE_NAMES = [
  'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
  'getDefaultCommissionForInstrument', 'classifyResult', 'signed', 'tradeTotalPoints',
  'tradePointsTotal', 'displayPointsTotal', 'weightedExitFields', 'legFromTrade',
  'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'postExitFields', 'applyPostExitFields', 'postExitApplies', 'POST_EXIT_DERIVED_KEYS', 'combineTradeObjects'
];
const SETTINGS = { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }], breakEvenEnabled: true, breakEvenThreshold: 5 };
const leg = over => ({
  id: 'c-' + Math.random().toString(16).slice(2), instrument: 'MES', date: '2026-10-16', entryTime: '16:00', entryPrice: 7700,
  exitTime: '16:05', exitPrice: 7703, result: 'target', side: 'long', points: 3, contracts: 1, commission: 1.9, pnl: 13.1, pnlRaw: 13.1, positionId: 'p', ...over
});

test('sloučení nohou: psychika se neztratí (první vyplněná hodnota)', () => {
  const r = loadRenderer(MERGE_NAMES, { settings: SETTINGS, Date });
  const m = plain(r.combineTradeObjects([
    leg({ psychBefore: '6' }),
    leg({ exitTime: '16:20', exitPrice: 7706, points: 6, pnl: 28.1, pnlRaw: 28.1, psychDuring: '4', psychAfter: '7' })
  ]));
  assert.deepEqual([m.psychBefore, m.psychDuring, m.psychAfter], ['6', '4', '7']);
});

test('Rychlý kontext: psychika obchodu se mění jen na přání a jde vymazat', () => {
  const q = loadRenderer(['QC_GROUPS', 'quickGroups', 'contextFieldShown', 'quickDraftFrom', 'quickContextApply'], {});
  const stored = { ...COMPLETE, id: 't1', psychBefore: '5' };
  const untouched = q.quickContextApply(stored, q.quickDraftFrom(stored), 'x');
  assert.equal(JSON.stringify(untouched), JSON.stringify(stored), 'neupravený obchod zůstane stejný');
  const d = q.quickDraftFrom(stored);
  d.psychBefore = '';
  d.psychAfter = '8';
  const out = plain(q.quickContextApply(stored, d, 'x'));
  assert.equal('psychBefore' in out, false);
  assert.equal(out.psychAfter, '8');
  const hidden = loadRenderer(['QC_GROUPS', 'quickGroups', 'contextFieldShown'], { tradeCardShown: key => key !== 'psych' });
  assert.deepEqual(plain(hidden.quickGroups().map(g => g.key)).filter(k => k.startsWith('psych')), [], 'skrytá karta Psychika se v Rychlém kontextu nenabízí');
});

test('export CSV: tři sloupce obchodu a tři sloupce dne na konci, hodnota = číslo škály', () => {
  const r = loadRenderer(['signed', 'tradePointsTotal', 'displayPointsTotal', 'sideMeta', 'levelCsvCount', 'levelCsvHeader', 'levelCsvCells',
    'tradeCsvHeader', 'tradeCsvRow', 'firstTradeIdPerDate', 'CONTEXT_CSV_MANUAL', 'CONTEXT_CSV_DERIVED', 'CONTEXT_CSV_DAY', 'CONTEXT_CSV_PSYCH', 'CONTEXT_CSV_DAY_PSYCH', 'CONTEXT_CSV_SKIPPED',
    'csvBool', 'emptyDayNoteCells', 'contextCsvHeader', 'contextCsvCells', 'journalCsvTable'],
  { settings: SETTINGS, activeJournalId: 'j1', journalProfiles: [] });
  const trades = [
    { ...COMPLETE, id: 'a', side: 'short', result: 'target', pnl: 10, pnlRaw: 10, points: 2, contracts: 1, psychBefore: '6', psychAfter: '2' },
    { ...COMPLETE, id: 'b', entryTime: '16:30', side: 'short', result: 'stoploss', pnl: 5, pnlRaw: -5, points: 1, contracts: 1 }
  ];
  const notes = { '2026-10-16': { comment: '', psych: { before: '7', during: '5' } } };
  const table = r.journalCsvTable(trades, d => notes[d] || null, { tickSizeOf: () => 0.25, config: {}, mode: 'LIVE' });
  const h = table[0];
  // Za psychikou jsou od 4.8.95 už jen dva sloupce důvodu vynechání.
  assert.deepEqual(plain(h.slice(-2)), ['Důvod vynechání', 'Důvod vynechání – text']);
  assert.deepEqual(plain(h.slice(-8, -2)), ['Psychika – před vstupem', 'Psychika – v průběhu', 'Psychika – po výstupu',
    'Den: Psychika – před seancí', 'Den: Psychika – v průběhu', 'Den: Psychika – po seanci']);
  const rec = row => Object.fromEntries(h.map((name, i) => [name, row[i]]));
  const a = rec(table[1]), b = rec(table[2]);
  assert.deepEqual([a['Psychika – před vstupem'], a['Psychika – v průběhu'], a['Psychika – po výstupu']], ['6', '', '2']);
  assert.deepEqual([b['Den: Psychika – před seancí'], b['Den: Psychika – v průběhu'], b['Den: Psychika – po seanci']], ['7', '5', ''], 'psychika dne na každém řádku dne');
});

test('Nahrát zálohu JSON: denní poznámky se obnoví (obrázky přes úložiště), starší záloha bez nich nic nemění', async () => {
  const stored = [];
  const r = loadRenderer(['restorableDayNotes'], { storeScreenshot: async img => { stored.push(img); return 'fjimg://store/' + 'a'.repeat(64) + '.png'; } });
  const out = plain(await r.restorableDayNotes({
    '2026-10-16': { comment: 'x', psych: { before: '6' }, dayContext: { openVsValue: 'IN_VA' }, images: ['data:image/png;base64,AA=='] },
    'neplatne-datum': { comment: 'y' }
  }));
  assert.deepEqual(Object.keys(out), ['2026-10-16']);
  assert.deepEqual(out['2026-10-16'].psych, { before: '6' });
  assert.deepEqual(out['2026-10-16'].dayContext, { openVsValue: 'IN_VA' });
  assert.equal(out['2026-10-16'].images.length, 1);
  assert.equal(stored.length, 1);
  assert.equal(await r.restorableDayNotes(undefined), null, 'záloha bez dayNotes: poznámky zůstanou');
});
