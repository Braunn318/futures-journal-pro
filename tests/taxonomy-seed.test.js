'use strict';
// Kontext obchodu v2, krok 4 (docs/ZADANI_KONTEXT.md A2.1, A7 test 13):
// rozšíření slovníku hladin.
//
// Hlavní pravidlo: slovníky jsou uživatelské. Nic se nepřejmenovává, neslučuje
// ani nemaže. Nové výchozí položky jsou výchozí klíče v kódu; „smazání"
// uživatelem = skrytí uložené v nastavení, takže se po restartu nevrátí.
// PDH_PDL / ONH_ONL zůstávají skryté i u cílů.
//
// Uživatelské úpravy jsou opsané z živých deníků (Phidias 1, Backtest_1) –
// jen klíče a popisky číselníku, žádná data obchodů.

const test = require('node:test');
const assert = require('node:assert/strict');

const FJTaxonomy = require('../app/taxonomy.js');

const PHIDIAS = {
  ENTRY_LEVEL: { hidden: ['VWAP_DEV', 'PDH_PDL', 'ONH_ONL'], visible: [], custom: { CUSTOM_LVN_DAY: 'LVN Day', CUSTOM_0_VE_FP: '0 ve FP', CUSTOM_FIX_RRR: 'Fix RRR', CUSTOM_GAMMA: 'Gamma', CUSTOM_VPOC_M: 'VPOC M', CUSTOM_VAH_WEEKLY: 'VAH Weekly', CUSTOM_VAL_WEEKLY: 'VAL Weekly' } },
  SR_TARGET: { hidden: ['IB_EDGE', 'PDH_PDL', 'ONH_ONL', 'CUSTOM_FIX_RRR'], visible: [] },
  SR_SL: { hidden: ['LIQUIDITY', 'VPOC_IB', 'ONH_ONL', 'PDH_PDL'], visible: [] },
  TARGET_LEVEL: { custom: { CUSTOM_0_VE_FP: '0 ve FP', CUSTOM_FIX_RRR: 'Fix RRR' } }
};
const roundTrip = cfg => FJTaxonomy.sanitizeConfig(JSON.parse(JSON.stringify(cfg)));
const visible = (group, cfg) => FJTaxonomy.visibleOptions(group, [], cfg).map(o => o.key);

const NEW_LEVELS = ['VPOC_DAY', 'VPOC_PREV_DAY', 'VPOC_30M', 'VPOC_1M', 'VPOC_IB', 'VAH', 'VAL', 'VAH_PREV', 'VAL_PREV',
  'VWAP', 'VWAP_DEV1', 'VWAP_DEV2', 'HVN', 'LVN', 'LIQUIDITY', 'HOD_LOD', 'PDH_PDL', 'ONH_ONL', 'M2_EDGE', 'IB_EDGE', 'GAP_EDGE', 'LTA_LEVEL'];

test('A2.1: všechny klíče ze zadání jsou v obou slovnících, existující zůstaly', () => {
  for (const key of NEW_LEVELS) {
    assert.ok(FJTaxonomy.isValidKey('ENTRY_LEVEL', key), 'ENTRY_LEVEL ' + key);
    assert.ok(FJTaxonomy.isValidKey('TARGET_LEVEL', key), 'TARGET_LEVEL ' + key);
  }
  for (const key of ['VWAP_DEV', 'VPOC_CANDLE', 'NONE']) assert.ok(FJTaxonomy.isValidKey('ENTRY_LEVEL', key), 'zůstává ' + key);
  for (const key of ['TRAIL_M2', 'MANUAL_EXIT']) assert.ok(FJTaxonomy.isValidKey('TARGET_LEVEL', key), 'zůstává ' + key);
  assert.ok(!FJTaxonomy.isValidKey('TARGET_LEVEL', 'FIX_RRR'), 'FIX_RRR se nepřidává (uživatel má CUSTOM_FIX_RRR)');
  assert.equal(FJTaxonomy.labelOf('ENTRY_LEVEL', 'VWAP_DEV'), 'VWAP odchylka', 'popisek existujícího klíče beze změny');
});

test('A7/13: uživatelské položky Phidias 1 zůstanou beze změny – počet, klíče, popisky', () => {
  // Kontext v3: dvě kolonky SR se při převodu deníku stanou jednou („Hladiny
  // v blízkosti"); slovník hladin a cílů se tím nemění.
  const migrated = FJTaxonomy.migrateConfigV3(PHIDIAS);
  assert.deepEqual(Object.keys(migrated).sort(), ['ENTRY_LEVEL', 'NEAR_LEVEL', 'TARGET_LEVEL']);
  assert.deepEqual(migrated.NEAR_LEVEL.hidden, ['PDH_PDL', 'ONH_ONL'], 'skryté jen to, co bylo skryté u obou kolonek SR');
  assert.equal(FJTaxonomy.migrateConfigV3(migrated), migrated, 'převod číselníků je idempotentní');
  const after = roundTrip(migrated);
  assert.deepEqual(after.NEAR_LEVEL.hidden, ['PDH_PDL', 'ONH_ONL'], 'nastavení nové kolonky přežije uložení');
  for (const group of ['ENTRY_LEVEL', 'TARGET_LEVEL']) {
    const custom = PHIDIAS[group].custom || {};
    assert.deepEqual(after[group]?.custom || {}, custom, group + ': vlastní volby');
    for (const [key, label] of Object.entries(custom)) assert.equal(FJTaxonomy.labelOf(group, key, after), label);
    assert.deepEqual(after[group]?.hidden || [], PHIDIAS[group].hidden || [], group + ': skryté');
  }
});

test('A7/13: smazaná (skrytá) výchozí položka se po restartu nevrátí', () => {
  let cfg = roundTrip(FJTaxonomy.migrateConfigV3(PHIDIAS));
  assert.ok(visible('ENTRY_LEVEL', cfg).includes('HVN'), 'nová výchozí položka je nabídnutá');
  cfg.ENTRY_LEVEL.hidden = [...cfg.ENTRY_LEVEL.hidden, 'HVN'];
  // „restart" = uložení do nastavení deníku a nové načtení
  const restarted = roundTrip(cfg);
  FJTaxonomy.applyConfig(restarted);
  try {
    assert.ok(!visible('ENTRY_LEVEL').includes('HVN'), 'skrytá zůstává skrytá');
    assert.ok(FJTaxonomy.isValidKey('ENTRY_LEVEL', 'HVN'), 'klíč zůstává platný pro obchody, které ho mají');
  } finally { FJTaxonomy.applyConfig({}); }
});

test('A2.1: PDH_PDL a ONH_ONL zůstávají skryté i ve slovníku cílů; Zobrazit funguje', () => {
  assert.ok(!visible('TARGET_LEVEL', {}).includes('PDH_PDL'));
  assert.ok(!visible('TARGET_LEVEL', {}).includes('ONH_ONL'));
  assert.ok(visible('TARGET_LEVEL', {}).includes('HVN'));
  const shown = roundTrip({ TARGET_LEVEL: { visible: ['PDH_PDL'] } });
  assert.ok(visible('TARGET_LEVEL', shown).includes('PDH_PDL'), 'uživatel si je může zobrazit');
  assert.ok(!visible('ENTRY_LEVEL', roundTrip(PHIDIAS)).includes('PDH_PDL'), 'u vstupu skryté podle uživatele');
});

test('A2.1: „je to hladina“ přežije uložení; výchozí ne u ručního výstupu, trailu a Fix RRR', () => {
  assert.equal(FJTaxonomy.isLevelKey('VAH', {}), true);
  assert.equal(FJTaxonomy.isLevelKey('MANUAL_EXIT', {}), false);
  assert.equal(FJTaxonomy.isLevelKey('TRAIL_M2', {}), false);
  assert.equal(FJTaxonomy.isLevelKey('CUSTOM_FIX_RRR', PHIDIAS), false);
  const cfg = roundTrip({ ...PHIDIAS, TARGET_LEVEL: { ...PHIDIAS.TARGET_LEVEL, isLevel: { CUSTOM_FIX_RRR: true, VAH: false, NEEXISTUJE: true, VAL: 'ano' } } });
  assert.deepEqual(cfg.TARGET_LEVEL.isLevel, { CUSTOM_FIX_RRR: true, VAH: false }, 'jen známé klíče a jen true/false');
  assert.equal(FJTaxonomy.isLevelKey('CUSTOM_FIX_RRR', cfg), true);
  assert.equal(FJTaxonomy.isLevelKey('VAH', cfg), false);
});

// High / Low dne (HOD_LOD): výchozí položka ze zadání v2, kterou uživatel
// nepoužívá a jejíž zkratka mu nic neříkala (zpětná vazba 13. 10.). Dostala
// srozumitelný popisek a je ve výchozím stavu skrytá – všude, kde se hladiny
// nabízejí. Klíč zůstává platný a zapnout ji jde tlačítkem „Zobrazit".
test('High / Low dne: srozumitelný popisek, výchozí skrytá u vstupu, hladin v blízkosti i cílů', () => {
  for (const group of ['ENTRY_LEVEL', 'NEAR_LEVEL', 'TARGET_LEVEL']) {
    assert.equal(FJTaxonomy.labelOf(group, 'HOD_LOD', {}), 'High / Low dne', group);
    assert.ok(FJTaxonomy.isValidKey(group, 'HOD_LOD', {}), group + ': klíč zůstává platný');
    assert.ok(!visible(group, {}).includes('HOD_LOD'), group + ': ve výchozím stavu se nenabízí');
    assert.ok(visible(group, {}).includes('VAH'), group + ': ostatní hladiny se nabízejí dál');
    assert.ok(FJTaxonomy.visibleOptions(group, ['HOD_LOD'], {}).some(o => o.key === 'HOD_LOD'), group + ': obchod, který ji má, o ni editací nepřijde');
  }
  // S nastavením deníku (Phidias 1 po převodu na kontext v3) platí totéž.
  const cfg = roundTrip(FJTaxonomy.migrateConfigV3(PHIDIAS));
  for (const group of ['ENTRY_LEVEL', 'NEAR_LEVEL', 'TARGET_LEVEL']) assert.ok(!visible(group, cfg).includes('HOD_LOD'), group + ' s nastavením deníku');
});

test('High / Low dne: uživatel si ji zapne (Zobrazit) – v kolonce, kde ji chce', () => {
  const shown = { ENTRY_LEVEL: { visible: ['HOD_LOD'] } };
  assert.ok(visible('ENTRY_LEVEL', shown).includes('HOD_LOD'));
  assert.ok(visible('NEAR_LEVEL', shown).includes('HOD_LOD'), 'kolonka bez vlastního nastavení dědí ze vstupu');
  assert.ok(!visible('TARGET_LEVEL', shown).includes('HOD_LOD'), 'cíle mají vlastní slovník');
  const nearOnly = { NEAR_LEVEL: { hidden: [], visible: ['HOD_LOD'] } };
  assert.ok(visible('NEAR_LEVEL', nearOnly).includes('HOD_LOD'));
  assert.ok(!visible('ENTRY_LEVEL', nearOnly).includes('HOD_LOD'));
});
