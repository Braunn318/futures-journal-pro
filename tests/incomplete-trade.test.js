'use strict';
// Štítek „Neúplné" na kartě obchodu a volba „žádná hladina v blízkosti"
// (4.7.1; od kontextu v3 jeden seznam hladin místo dvou kolonek SR).
//
// PROČ NA TOM ZÁLEŽÍ: díra v kontextu se dřív poznala až v analýze, kde
// obchod bez hladin nebo MFE/MAE tiše vypadl ze vzorku. Štítek ji ukáže hned
// v deníku. Aby šel odstranit i u obchodu, kde opravdu žádná hladina
// v blízkosti nebyla, musí jít „nic tam nebylo" odlišit od „nevyplněno".

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

// Úplně okontextovaný obchod: nic nechybí.
const complete = (extra = {}) => ({
  id: 't1', instrument: 'MES', side: 'short', result: 'target',
  setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'SHORT',
  entryLevels: ['VPOC_DAY'],
  nearLevels: [{ level: 'VPOC_30M', price: 7730 }, { level: 'LIQUIDITY', price: 7745 }],
  ofConfirm: ['ABS_ASK'],
  targetLevel1: { type: 'VPOC_1M', price: 7737.75 },
  slPrice: 7746, mfeTicks: 18, maeTicks: 2,
  postExitFavorableTicks: 1, postExitAdverseTicks: 30,
  // Kontext v2 (A4): trend 30m a známka patří k úplnému kontextu.
  trendHtf: 'DOWN', grade: 'A',
  ...extra
});

test('úplný obchod nemá nic chybějícího', () => {
  assert.deepEqual(FJTaxonomy.missingContextKeys(complete()), []);
});

test('prázdný obchod: chybí všechno, v pořadí formuláře', () => {
  assert.deepEqual(FJTaxonomy.missingContextKeys({ instrument: 'MES' }), [
    'setupCode', 'fillStatus', 'trend', 'entryLevels', 'nearLevels', 'ofConfirm',
    'trendHtf', 'grade', 'targetLevel1', 'slPrice', 'mfeTicks', 'maeTicks', 'postExitFavorableTicks', 'postExitAdverseTicks'
  ]);
});

test('hladiny v blízkosti: prázdný seznam chybí, „žádná hladina v blízkosti" je vyplněná hodnota', () => {
  const empty = complete({ nearLevels: [] });
  assert.deepEqual(FJTaxonomy.missingContextKeys(empty), ['nearLevels']);
  assert.deepEqual(FJTaxonomy.missingContextKeys({ ...empty, nearLevelsNone: true }), []);
  assert.deepEqual(FJTaxonomy.missingContextKeys(complete({ nearLevels: [{ level: 'PREKLEP', price: 1 }] })), ['nearLevels'], 'neznámý typ hladiny není vyplněná hladina');
});

test('cílová hladina 1 potřebuje typ i cenu', () => {
  assert.deepEqual(FJTaxonomy.missingContextKeys(complete({ targetLevel1: { type: 'VPOC_1M', price: null } })), ['targetLevel1']);
  assert.deepEqual(FJTaxonomy.missingContextKeys(complete({ targetLevel1: { type: '', price: 7737 } })), ['targetLevel1']);
});

test('nula je vyplněná hodnota, prázdné chybí; odvozené hodnoty se počítají', () => {
  // postExitFavorableTicks = 0 znamená „dál už nic nebylo" – platné měření.
  assert.deepEqual(FJTaxonomy.missingContextKeys(complete({ postExitFavorableTicks: 0, maeTicks: 0 })), []);
  assert.deepEqual(FJTaxonomy.missingContextKeys(complete({ postExitAdverseTicks: '' })), ['postExitAdverseTicks']);
  assert.deepEqual(FJTaxonomy.missingContextKeys(complete({ slDerived: true, mfeTicksDerived: true })), []);
});

test('nenaplněný setup: průběh a výstup se nekontrolují, kontext ano', () => {
  for (const fillStatus of ['NO_FILL', 'MISSED', 'SKIPPED']) {
    const t = complete({ fillStatus, slPrice: null, mfeTicks: null, maeTicks: null,
      postExitFavorableTicks: null, postExitAdverseTicks: null, trend: '' });
    assert.deepEqual(FJTaxonomy.missingContextKeys(t), ['trend'], fillStatus);
  }
});

test('záznam setupu bez vstupu se neposuzuje', () => {
  assert.deepEqual(FJTaxonomy.missingContextKeys({ recordType: 'SETUP_ONLY' }), []);
});

test('neznámý klíč číselníku se nepočítá jako vyplněný', () => {
  assert.deepEqual(FJTaxonomy.missingContextKeys(complete({ trend: 'BOKEM', ofConfirm: ['NECO'] })), ['trend', 'ofConfirm']);
});

// ------------------------------------------------------------ štítek na kartě

// Od 4.7.2 místo jednoho přepínače nastavení karet (Nastavení → Přizpůsobení):
// true = výchozí (vše s upozorněním), false = upozornění vypnuté u všech karet.
const allCards = warn => Object.fromEntries(FJTaxonomy.TRADE_CARDS.map(c => [c.key, { show: true, warn }]));
const badge = mark => loadRenderer(['esc', 'incompleteBadgeHTML'], mark === undefined ? {} : { tradeCardConfig: allCards(mark) });

test('štítek: počet a tooltip s popisky chybějících polí', () => {
  const html = badge(true).incompleteBadgeHTML(complete({ trend: '', nearLevels: [] }));
  assert.match(html, /Neúplné · 2/);
  assert.match(html, /title="Chybí: Trend 1m, Hladiny v blízkosti"/);
});

test('štítek: úplný obchod ho nemá, vypnutý přepínač ho schová', () => {
  assert.equal(badge(true).incompleteBadgeHTML(complete()), '');
  assert.equal(badge(false).incompleteBadgeHTML({ instrument: 'MES' }), '');
  assert.match(badge(undefined).incompleteBadgeHTML({ instrument: 'MES' }), /Neúplné/, 'bez nastavení = zapnuto');
});

// ------------------------------------------- „žádná hladina" ve formuláři

// Minimální DOM formuláře pro hladiny v blízkosti: řádky hladin, zaškrtávátko
// „žádná", tlačítko „Přidat hladinu" a hlavička sbalené položky.
function srDom({ nearLevels = [], nearLevelsNone = false } = {}) {
  const row = r => ({
    dataset: {},
    querySelector: sel => ({ '.sr-level': { value: r.level }, '.sr-price': { value: r.price ?? '' }, '.sr-test': { value: r.testState ?? '' } })[sel]
  });
  const host = rows => ({ rows: rows.map(row), querySelector(sel) { return sel === '.sr-row' ? this.rows[0] || null : null; }, querySelectorAll(sel) { return sel === '.sr-row' ? this.rows : []; } });
  const label = () => ({ title: '', classList: { state: {}, toggle(c, on) { this.state[c] = on; } } });
  const box = checked => { const l = label(); return { checked, disabled: false, closest: () => l, label: l }; };
  const nodes = {
    nearLevels: host(nearLevels), nearLevelsNone: box(nearLevelsNone), nearLevelsAdd: { disabled: false },
    levelsSummary: { textContent: '' },
    entryLevels: { querySelectorAll: () => [] }, ofConfirm: { querySelectorAll: () => [] }
  };
  return { nodes, document: { getElementById: id => nodes[id] || null } };
}
const srForm = state => {
  const dom = srDom(state);
  const r = loadRenderer(['$', 'NEAR_LEVELS_ID', 'rowFromElement', 'readLevelRows', 'readChipGrid', 'contextFieldShown', 'formatLevelRow', 'LEVEL_FIELDS',
    'syncNearNoneControls', 'readNearNone', 'updateLevelsSummary'], { document: dom.document });
  r.updateLevelsSummary();
  return { r, n: dom.nodes };
};

test('„žádná" zaškrtnutá: uloží se, přidávání hladin se zneaktivní, shrnutí ji ukáže', () => {
  const f = srForm({ nearLevelsNone: true });
  assert.equal(f.r.readNearNone(), true);
  assert.equal(f.n.nearLevelsAdd.disabled, true);
  assert.match(f.n.levelsSummary.textContent, /Hladiny: žádná/);
  assert.equal(srForm({}).n.nearLevelsAdd.disabled, false, 'bez zaškrtnutí jde hladinu přidat');
});

test('„žádná" se zadanými řádky neplatí a nejde zaškrtnout – řádky se nemažou', () => {
  const f = srForm({ nearLevels: [{ level: 'VPOC_30M', price: 7730 }], nearLevelsNone: true });
  assert.equal(f.n.nearLevelsNone.checked, false, 'zaškrtnutí se zruší');
  assert.equal(f.n.nearLevelsNone.disabled, true);
  assert.equal(f.n.nearLevelsNone.label.classList.state['is-disabled'], true);
  assert.equal(f.r.readNearNone(), false);
  assert.equal(f.r.readLevelRows().length, 1, 'hladina zůstala');
});

// ------------------------------------------------------------ sloučení cílů

const merge = list => loadRenderer(['mergeContextFields']).mergeContextFields(list);

test('sloučení: „žádná" platí, jen když ji mají všechny nohy a nikde není hladina', () => {
  assert.equal(merge([{ nearLevelsNone: true }, { nearLevelsNone: true }]).nearLevelsNone, true);
  assert.equal(merge([{ nearLevelsNone: true }, {}]).nearLevelsNone, undefined, 'jedna noha nevyplněná');
  const withRow = merge([{ nearLevelsNone: true }, { nearLevels: [{ level: 'VPOC_30M', price: 7730 }] }]);
  assert.equal(withRow.nearLevelsNone, undefined, 'hladina z jiné nohy má přednost');
  assert.equal(withRow.nearLevels.length, 1);
});
