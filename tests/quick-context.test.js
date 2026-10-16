'use strict';
// Rychlý kontextový formulář (BACKTEST_MODE_SPEC §6.2, ZADANI_KONTEXT A8 krok 4).
//
// Dvě věci, na kterých formulář stojí a které jdou otestovat bez DOM:
//  - dávka: které obchody a v jakém pořadí se nabídnou,
//  - zápis: mění se JEN kontextová pole, která uživatel změnil. Neupravený
//    obchod musí zůstat bajt po bajtu stejný – jinak by rychlé proklikání
//    dávky přepisovalo historická data (hlavní pravidlo zadání).

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

const plain = v => JSON.parse(JSON.stringify(v));
const r = () => loadRenderer(['contextFieldShown', 'isSetupRecord', 'tradeRecords', 'quickMissingKeys', 'quickBatch', 'QC_GROUPS', 'quickGroups', 'quickDraftFrom', 'quickContextApply'], {});

const complete = {
  setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'SHORT', trendHtf: 'DOWN', grade: 'A',
  entryLevels: ['VPOC_DAY'], nearLevels: [], nearLevelsNone: true, ofConfirm: ['ABS_ASK'],
  targetLevel1: { type: 'VPOC_1M', price: 7737.75 }, slPrice: 7746, mfeTicks: 18, maeTicks: 2,
  postExitFavorableTicks: 1, postExitAdverseTicks: 30
};
const trades = [
  { id: 'c', date: '2026-10-09', entryTime: '17:00', ...complete },
  { id: 'a', date: '2026-10-09', entryTime: '15:31' },
  { id: 'setup', date: '2026-10-09', entryTime: '15:00', recordType: 'SETUP_ONLY' },
  { id: 'b', date: '2026-10-08', entryTime: '16:00' },
  { id: 'd', date: '2026-10-10', entryTime: '15:40' }
];

test('dávka: jen nevyplněné obchody, chronologicky, bez setupů bez vstupu', () => {
  assert.deepEqual(plain(r().quickBatch(trades).map(t => t.id)), ['b', 'a', 'd']);
});

test('dávka od konkrétního obchodu: ten vždy, dál jen nevyplněné', () => {
  assert.deepEqual(plain(r().quickBatch(trades, 'c').map(t => t.id)), ['c', 'd']);
  assert.deepEqual(plain(r().quickBatch(trades, 'neni').map(t => t.id)), []);
});

const stored = {
  id: 't1', instrument: 'MES', date: '2026-10-09', entryTime: '17:00', side: 'long', entryPrice: 7800,
  exitPrice: 7804, result: 'target', pnl: 18.1, pnlRaw: 18.1, commission: 1.9, contracts: 1,
  setupCode: 'M2_OF', fillStatus: 'FILLED', trend: '', entryLevels: ['VAH'], ofConfirm: [],
  nearLevels: [{ level: 'VWAP', price: 7802 }],
  targetLevel1: { type: 'VAH', price: 7804 }, slPrice: 7798, slDerived: false, mfeTicks: 16, mfeTicksSource: 'nt8'
};

test('zápis: neupravený obchod zůstane přesně stejný', () => {
  const q = r();
  const out = q.quickContextApply(stored, q.quickDraftFrom(stored), '2026-10-10T08:00:00.000Z');
  assert.deepEqual(plain(out), plain(stored));
});

test('zápis: změní se jen to, co uživatel změnil; P/L, ceny ani komise se nedotkne', () => {
  const q = r();
  const d = q.quickDraftFrom(stored);
  d.trendHtf = 'UP';
  d.grade = 'B';
  d.entryLevels = ['VAH', 'VPOC_30M'];
  d.nearLevels.push({ level: 'VAL', price: 7799, testState: 'TESTED' });
  const out = plain(q.quickContextApply(stored, d, '2026-10-10T08:00:00.000Z'));
  const changed = Object.keys({ ...out, ...stored }).filter(k => JSON.stringify(out[k]) !== JSON.stringify(stored[k])).sort();
  assert.deepEqual(changed, ['confluenceCount', 'entryLevels', 'grade', 'gradeSetAt', 'nearLevels', 'trendHtf']);
  assert.equal(out.gradeSetAt, '2026-10-10T08:00:00.000Z');
  assert.deepEqual(out.nearLevels, [{ level: 'VWAP', price: 7802 }, { level: 'VAL', price: 7799, testState: 'TESTED' }],
    'jen typ, cena a test / netest – vzdálenosti se neukládají');
  assert.equal(out.confluenceCount, 2);
});

test('zápis: „žádná hladina" jen bez řádků; přepsané MFE ruší zdroj z konektoru', () => {
  const q = r();
  const d = q.quickDraftFrom(stored);
  d.nearLevelsNone = true;
  d.mfeTicks = '20'; d.touched.mfeTicks = true;
  d.slPrice = '7797'; d.touched.slPrice = true;
  const out = plain(q.quickContextApply(stored, d, 'x'));
  assert.equal(out.nearLevelsNone, undefined, 'obchod má řádek hladiny, „žádná" neplatí');
  const cleared = q.quickDraftFrom(stored);
  cleared.nearLevels = [];
  cleared.nearLevelsNone = true;
  const none = plain(q.quickContextApply(stored, cleared, 'x'));
  assert.equal(none.nearLevelsNone, true);
  assert.deepEqual(none.nearLevels, []);
  assert.equal(out.mfeTicks, 20);
  assert.equal(out.mfeTicksSource, undefined);
  assert.equal(out.slPrice, 7797);
  assert.equal(out.slDerived, false);
});

test('zápis: starý obchod bez kontextových klíčů nedostane prázdné hodnoty navíc', () => {
  const q = r();
  const old = { id: 'o1', instrument: 'MES', date: '2026-08-10', entryTime: '17:24', side: 'long', entryPrice: 7700, exitPrice: 7697.5, result: 'stoploss', pnlRaw: -43.2 };
  assert.deepEqual(plain(q.quickContextApply(old, q.quickDraftFrom(old), 'x')), plain(old));
});

test('zápis: obchod ve starém tvaru (dva seznamy SR) zůstane bez zásahu stejný; úprava hladin ho převede', () => {
  const q = r();
  const old = { ...stored, nearLevels: undefined, srTarget: [{ level: 'VWAP', price: 7802, ticksFromEntry: 8 }], srStopLoss: [], srStopLossNone: true };
  delete old.nearLevels;
  assert.deepEqual(plain(q.quickContextApply(old, q.quickDraftFrom(old), 'x')), plain(old), 'neupravený obchod bajt po bajtu stejný');
  const d = q.quickDraftFrom(old);
  d.nearLevels.push({ level: 'VAL', price: 7799 });
  const out = plain(q.quickContextApply(old, d, 'x'));
  assert.deepEqual(out.nearLevels, [{ level: 'VWAP', price: 7802 }, { level: 'VAL', price: 7799 }]);
  for (const key of ['srTarget', 'srStopLoss', 'srTargetNone', 'srStopLossNone']) assert.equal(key in out, false, key + ' po úpravě v obchodu nezůstává');
});

test('skupiny rychlého formuláře: jeden seznam hladin, zrušená pole nejsou', () => {
  const keys = plain(r().quickGroups().map(g => g.key));
  assert.deepEqual(keys, ['setupCode', 'fillStatus', 'trend', 'trendHtf', 'grade', 'entryTestNo', 'entryLevels', 'nearLevels', 'ofConfirm', 'absLocation', 'targetLevel1Type',
    'psychBefore', 'psychDuring', 'psychAfter']);
});

// Obchod, kterému chybí jen něco, co rychlý formulář nenabízí (cena cíle –
// tady se volí jen typ –, ticky po výstupu), by z dávky nikdy nezmizel.
test('dávka: nabízí se jen obchody, kterým chybí něco, co tu jde doplnit', () => {
  const q = r();
  assert.deepEqual(plain(q.quickMissingKeys({ ...complete, targetLevel1: { type: 'VPOC_1M', price: null } })), [], 'cena cíle se doplňuje v plném formuláři');
  assert.deepEqual(plain(q.quickMissingKeys({ ...complete, postExitFavorableTicks: undefined, postExitAdverseTicks: undefined })), [], 'ticky po výstupu také');
  assert.deepEqual(plain(q.quickMissingKeys({ ...complete, targetLevel1: { type: '', price: 7737.75 } })), ['targetLevel1'], 'typ cíle tu doplnit jde');
  assert.deepEqual(plain(q.quickMissingKeys({ ...complete, slPrice: undefined, trend: '' })), ['trend', 'slPrice']);
  const rows = [{ id: 'p', date: '2026-10-09', entryTime: '15:31', ...complete, targetLevel1: { type: 'VPOC_1M', price: null } }, { id: 'a', date: '2026-10-09', entryTime: '16:00' }];
  assert.deepEqual(plain(q.quickBatch(rows).map(t => t.id)), ['a']);
});

// Dávka a štítek „Neúplné" berou stejný výběr (FJTaxonomy.missingWarnItems):
// rozhodují karty i pole a jejich „Upozorňovat na nevyplněné".
const rWith = globals => loadRenderer(['contextFieldShown', 'isSetupRecord', 'tradeRecords', 'quickMissingKeys', 'quickBatch', 'QC_GROUPS'], globals);
const badge = (t, globals) => plain(FJTaxonomy.missingForCards(t, globals.tradeCardConfig || {}, undefined, globals.contextFieldConfig,
  { dayContextMissing: !!globals.dayContextMissingFor?.(t) }));

test('dávka podle upozornění: zobrazené pole bez upozornění obchod v dávce nedrží', () => {
  const globals = { contextFieldConfig: FJTaxonomy.normalizeFieldConfig({ trendHtf: { show: true, warn: false } }) };
  const t = { id: 'x', date: '2026-10-09', ...complete, trendHtf: '' };
  assert.deepEqual(plain(rWith(globals).quickMissingKeys(t)), []);
  assert.deepEqual(badge(t, globals), [], 'štítek obchod taky bere jako úplný');
});

test('dávka podle upozornění: absorpce, test / netest a vypnutá karta', () => {
  const globals = { contextFieldConfig: FJTaxonomy.normalizeFieldConfig({ absLocation: { warn: true }, levelTestState: { warn: true } }) };
  const q = rWith(globals);
  assert.deepEqual(plain(q.quickMissingKeys({ ...complete })), ['absLocation'], 'absorpce se tu doplnit dá');
  const withRow = { ...complete, absLocation: 'EXTREME', nearLevels: [{ level: 'VAL', price: 7799 }], nearLevelsNone: false };
  assert.deepEqual(plain(q.quickMissingKeys(withRow)), ['levelTestState'], 'test / netest u řádku hladiny');
  const levelsOff = { ...globals, tradeCardConfig: FJTaxonomy.normalizeCardConfig({ levels: { warn: false } }) };
  assert.deepEqual(plain(rWith(levelsOff).quickMissingKeys({ ...complete, ofConfirm: [] })), [], 'karta Hladiny bez upozornění');
  assert.deepEqual(badge({ ...complete, ofConfirm: [] }, levelsOff), []);
});

test('dávka: kontext dne drží obchod jen do vyplnění dne', () => {
  const dayNotes = {};
  const globals = {
    contextFieldConfig: FJTaxonomy.normalizeFieldConfig({ dayContext: { warn: true } }),
    dayContextMissingFor: t => !(dayNotes[t.date] && dayNotes[t.date].openVsValue)
  };
  const q = rWith(globals);
  const rows = [{ id: 'k', date: '2026-10-09', entryTime: '15:31', ...complete }, { id: 'l', date: '2026-10-09', entryTime: '16:00', ...complete }];
  assert.deepEqual(plain(q.quickMissingKeys(rows[0])), ['dayContext']);
  assert.deepEqual(plain(q.quickBatch(rows).map(t => t.id)), ['k', 'l']);
  dayNotes['2026-10-09'] = { openVsValue: 'IN_VA' };
  assert.deepEqual(plain(q.quickBatch(rows).map(t => t.id)), [], 'vyplněný Denní kontext obchody z dávky vyřadí');
  const off = rWith({ ...globals, contextFieldConfig: FJTaxonomy.normalizeFieldConfig({}) });
  delete dayNotes['2026-10-09'];
  assert.deepEqual(plain(off.quickMissingKeys(rows[0])), [], 'bez upozornění na kontext dne se obchod nenabízí');
});

test('zápis: klíč, který číselník deníku nezná, zůstane, dokud na něj uživatel nesáhne', () => {
  const q = r();
  const moved = { ...stored, setupCode: 'CUSTOM_Z_JINEHO_DENIKU', targetLevel1: { type: 'CUSTOM_CIL', price: 7804 } };
  assert.deepEqual(plain(q.quickContextApply(moved, q.quickDraftFrom(moved), 'x')), plain(moved), 'neupravený obchod bajt po bajtu stejný');
  const d = q.quickDraftFrom(moved);
  d.trendHtf = 'UP';
  const out = plain(q.quickContextApply(moved, d, 'x'));
  assert.equal(out.trendHtf, 'UP');
  assert.equal(out.setupCode, 'CUSTOM_Z_JINEHO_DENIKU', 'setup z jiného deníku se doplněním trendu nesmaže');
  assert.deepEqual(out.targetLevel1, { type: 'CUSTOM_CIL', price: 7804 });
  d.setupCode = 'M2_PA';
  assert.equal(q.quickContextApply(moved, d, 'x').setupCode, 'M2_PA', 'výslovná změna se zapíše');
});

test('uložení: druhý Enter během zápisu ani podržená klávesa dávku neposunou', () => {
  const { extractDeclaration, inlineScripts, readRepoFile } = require('./helpers/extract');
  const script = inlineScripts(readRepoFile('app/index.html'));
  const save = extractDeclaration(script, 'saveQuickContext');
  assert.ok(save.indexOf('if(qc.saving)return') >= 0 && save.indexOf('if(qc.saving)return') < save.indexOf('quickTrade()'), 'rozběhnuté uložení další nepustí');
  assert.match(save, /finally\{qc\.saving=false\}/, 'příznak se uvolní i po chybě nebo zrušeném potvrzení');
  assert.match(script, /if\(!e\.repeat\)saveQuickContext\(\)/, 'opakování klávesy neukládá');
});
