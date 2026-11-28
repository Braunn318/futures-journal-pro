'use strict';
// Číselníky (4.8.106): vypnutí celé skupiny, vlastní číselníky a swing
// číselníky (ZADANI_SWING_CFD §6, krok 6).
//
// Co se hlídá:
//  - skupina jde vypnout / zapnout per deník; bez ruční volby platí výchozí
//    podle typu deníku (futures skupiny ve futures, swing ve swingu, vlastní vždy),
//  - vlastní skupina se chová jako každý číselník (volby, skrytí, smazání),
//  - hodnoty u obchodu (`customContext`) se nikdy tiše nezahazují,
//  - kopie / export / import číselníků přenese vypnutí i vlastní skupiny,
//  - swing číselníky mají výchozí volby shodné s dřívější nabídkou v kódu.

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../app/taxonomy.js');
const S = require('../app/swing.js');

const SW = 'CFD_SWING', FUT = 'FUTURES_INTRADAY';

test('výchozí zapnutí podle typu deníku', () => {
  assert.equal(T.isGroupEnabled('OF_CONFIRM', {}, FUT), true);
  assert.equal(T.isGroupEnabled('OF_CONFIRM', {}, SW), false);
  assert.equal(T.isGroupEnabled('SWING_SETUP', {}, SW), true);
  assert.equal(T.isGroupEnabled('SWING_SETUP', {}, FUT), false);
  // neznámý typ = futures (starší profil bez typu)
  assert.equal(T.isGroupEnabled('OF_CONFIRM', {}, undefined), true);
  assert.equal(T.isGroupEnabled('NEEXISTUJE', {}, FUT), false);
});

test('ruční volba vyhrává oběma směry', () => {
  assert.equal(T.isGroupEnabled('OF_CONFIRM', { OF_CONFIRM: { enabled: false } }, FUT), false);
  assert.equal(T.isGroupEnabled('OF_CONFIRM', { OF_CONFIRM: { enabled: true } }, SW), true);
  assert.equal(T.isGroupEnabled('SWING_WEEKLY', { SWING_WEEKLY: { enabled: true } }, FUT), true);
  assert.equal(T.groupEnabledByDefault('OF_CONFIRM', { OF_CONFIRM: { enabled: true } }, SW), false);
});

const cfgUser = () => ({
  [T.USER_GROUPS_KEY]: [{ name: 'U_POTVRZENI', label: 'Moje potvrzení', cardinality: 'multi' },
    { name: 'U_NALADA', label: 'Nálada', cardinality: 'single' }],
  U_POTVRZENI: { custom: { CUSTOM_A: 'Svíce', CUSTOM_B: 'Objem', CUSTOM_C: 'Gap' }, hidden: ['CUSTOM_C'] },
  U_NALADA: { custom: { CUSTOM_KLID: 'Klid' } }
});

test('vlastní skupina: zapnutá v obou typech, do vypnutí', () => {
  const c = cfgUser();
  assert.equal(T.isGroupEnabled('U_POTVRZENI', c, SW), true);
  assert.equal(T.isGroupEnabled('U_POTVRZENI', c, FUT), true);
  c.U_POTVRZENI.enabled = false;
  assert.equal(T.isGroupEnabled('U_POTVRZENI', c, SW), false);
  const removed = cfgUser();
  removed[T.USER_GROUPS_KEY][0].removed = true;
  assert.equal(T.isGroupEnabled('U_POTVRZENI', removed, SW), false);
  assert.deepEqual(T.userGroups(removed).map(g => g.name), ['U_NALADA']);
  assert.deepEqual(T.userGroups(removed, { includeRemoved: true }).map(g => g.name), ['U_POTVRZENI', 'U_NALADA']);
});

test('vlastní skupina: volby, popisky, skrytí, smazání jako u vestavěných', () => {
  const c = cfgUser();
  assert.deepEqual(T.allKeys('U_POTVRZENI', c), ['CUSTOM_A', 'CUSTOM_B', 'CUSTOM_C']);
  assert.equal(T.labelOf('U_POTVRZENI', 'CUSTOM_B', c), 'Objem');
  assert.deepEqual(T.visibleOptions('U_POTVRZENI', [], c).map(o => o.key), ['CUSTOM_A', 'CUSTOM_B']);
  assert.deepEqual(T.visibleOptions('U_POTVRZENI', ['CUSTOM_C'], c).map(o => o.key), ['CUSTOM_A', 'CUSTOM_B', 'CUSTOM_C']);
  c.U_POTVRZENI.removed = ['CUSTOM_A'];
  assert.deepEqual(T.allKeys('U_POTVRZENI', c), ['CUSTOM_B', 'CUSTOM_C']);
  assert.equal(T.groupDef('U_NALADA', c).cardinality, 'single');
});

test('jméno nové skupiny: slug, unikátní i proti smazaným a vestavěným', () => {
  const c = cfgUser();
  assert.equal(T.userGroupName('Moje potvrzení', c), 'U_MOJE_POTVRZENI');
  assert.equal(T.userGroupName('Potvrzení', c), 'U_POTVRZENI_2');
  assert.equal(T.userGroupName('', c), 'U_CISELNIK');
  assert.match(T.userGroupName('Žluťoučký kůň', c), T.USER_GROUP_RE);
});

test('sanitizeConfig: zachová enabled a vlastní skupiny, zahodí nevalidní', () => {
  const raw = {
    ...cfgUser(),
    OF_CONFIRM: { enabled: false },
    SWING_SETUP: { enabled: 'ano' },
    [T.USER_GROUPS_KEY]: [
      ...cfgUser()[T.USER_GROUPS_KEY],
      { name: 'U_POTVRZENI', label: 'duplicita', cardinality: 'single' },
      { name: 'OF_CONFIRM', label: 'kolize s vestavěnou' },
      { name: 'u_mala', label: 'špatné jméno' },
      { name: 'U_BEZ_POPISKU', label: '  ' },
      { name: 'U_DIVNA', label: 'Divná', cardinality: 'cokoli', removed: true }
    ]
  };
  const clean = T.sanitizeConfig(raw);
  assert.deepEqual(clean.OF_CONFIRM, { enabled: false });
  assert.equal(clean.SWING_SETUP, undefined);
  assert.deepEqual(clean[T.USER_GROUPS_KEY], [
    { name: 'U_POTVRZENI', label: 'Moje potvrzení', cardinality: 'multi' },
    { name: 'U_NALADA', label: 'Nálada', cardinality: 'single' },
    { name: 'U_DIVNA', label: 'Divná', cardinality: 'single', removed: true }
  ]);
  assert.deepEqual(clean.U_POTVRZENI.custom, { CUSTOM_A: 'Svíce', CUSTOM_B: 'Objem', CUSTOM_C: 'Gap' });
  assert.deepEqual(clean.U_POTVRZENI.hidden, ['CUSTOM_C']);
});

test('export → import číselníků je beze ztrát a popis to zmíní', () => {
  const cfg = { ...cfgUser(), OF_CONFIRM: { enabled: false }, SWING_SETUP: { custom: { CUSTOM_X: 'Můj setup' } } };
  const back = T.configFromImport(JSON.parse(JSON.stringify(T.exportPayload(cfg))));
  assert.deepEqual(back, T.sanitizeConfig(cfg));
  const lines = T.describeConfig(cfg);
  assert.ok(lines.some(l => l.includes('Moje potvrzení')));
  assert.ok(lines.some(l => l.startsWith('Order flow potvrzení') && l.includes('vypnuto')));
});

test('sanitizeCustomContext: single / multi, neznámé se nezahazuje', () => {
  const c = cfgUser();
  assert.deepEqual(T.sanitizeCustomContext({
    U_POTVRZENI: ['CUSTOM_C', 'CUSTOM_A', 'CUSTOM_A', 'STARY'],
    U_NALADA: ['CUSTOM_KLID', 'JINY'],
    U_SMAZANA: 'X',
    U_PRAZDNA: [],
    spatne: 'Y'
  }, c), {
    U_POTVRZENI: ['CUSTOM_A', 'CUSTOM_C', 'STARY'],
    U_NALADA: 'CUSTOM_KLID',
    U_SMAZANA: 'X'
  });
  assert.deepEqual(T.sanitizeCustomContext(null, c), {});
  assert.deepEqual(T.sanitizeCustomContext(['x'], c), {});
});

test('mergeCustomContext: multi sjednocení, single první neprázdná', () => {
  assert.deepEqual(T.mergeCustomContext({ U_A: ['X'], U_B: '' }, { U_A: ['Y', 'X'], U_B: 'K', U_C: 'Z' }),
    { U_A: ['X', 'Y'], U_B: 'K', U_C: 'Z' });
  assert.deepEqual(T.mergeCustomContext({ U_B: 'P' }, { U_B: 'K' }), { U_B: 'P' });
  assert.deepEqual(T.mergeCustomContext(undefined, undefined), {});
});

test('popisky pro export a čitelná hodnota', () => {
  const c = cfgUser();
  const labels = T.customContextLabels(c);
  assert.equal(labels.U_POTVRZENI.label, 'Moje potvrzení');
  assert.equal(labels.U_POTVRZENI.options.CUSTOM_B, 'Objem');
  assert.equal(T.customContextText({ customContext: { U_POTVRZENI: ['CUSTOM_A', 'CUSTOM_B'] } }, 'U_POTVRZENI', c), 'Svíce, Objem');
  assert.equal(T.customContextText({}, 'U_POTVRZENI', c), '');
});

test('swing číselníky = dřívější nabídka v kódu (nic se neztratí)', () => {
  assert.deepEqual(Object.values(T.SWING_SETUP), S.SWING_SETUP_SUGGESTIONS);
  assert.deepEqual(Object.values(T.SWING_ENTRY_TF), S.SWING_CONTEXT_SUGGESTIONS.entryTf);
  assert.deepEqual(Object.values(T.SWING_HTF_TREND), S.SWING_CONTEXT_SUGGESTIONS.htfTrend);
  assert.deepEqual(Object.values(T.SWING_WEEKLY), S.SWING_CONTEXT_SUGGESTIONS.weeklyCheck);
  assert.deepEqual(Object.values(T.SWING_LEVEL_TYPE), S.SWING_CONTEXT_SUGGESTIONS.levelType);
  for (const name of ['SWING_SETUP', 'SWING_ENTRY_TF', 'SWING_HTF_TREND', 'SWING_WEEKLY', 'SWING_LEVEL_TYPE']) {
    assert.equal(T.GROUP_BY_NAME[name].scope, 'swing');
    assert.equal(T.GROUP_BY_NAME[name].storesLabel, true);
  }
  // stávající skupiny jsou futures
  assert.ok(T.GROUPS.filter(g => !g.name.startsWith('SWING_')).every(g => g.scope === 'futures'));
});
