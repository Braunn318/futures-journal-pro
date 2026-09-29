'use strict';
// Průběh obchodu DO VÝSTUPU (mfeTicks / maeTicks), doba sledování, typ cílové
// hladiny a měkké validace (zadání z 2026-09-26).
//
// Stávající `postExitFavorableTicks` / `postExitAdverseTicks` se měří od
// výstupní ceny a zůstávají. MFE/MAE jsou jejich protějšky od VSTUPNÍ ceny za
// dobu trvání obchodu. Dopočty (`exitTicks`, `maxFavorableTicks`,
// `maxAdverseTicks`, `touchedSl`) se ukládají na obchod.
//
// PROČ NA TOM ZÁLEŽÍ: `maxAdverseTicks` = 0 u ziskového obchodu dřív vznikalo
// jako artefakt chybějícího MAE. V analýze pak tvrdilo „cena nešla proti
// pozici ani o tick", což nikdo neměřil.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadRenderer, loadMain } = require('./helpers/extract');
const FJPoints = require('../app/points.js');
const FJTaxonomy = require('../app/taxonomy.js');

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }],
  breakEvenEnabled: true, breakEvenThreshold: 5, useConnectorCommission: false, autoMergeLegs: true
};

const NAMES = [
  'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
  'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'POST_EXIT_DERIVED_KEYS',
  'postExitFields', 'applyPostExitFields', 'getDefaultCommissionForInstrument',
  'classifyResult', 'signed', 'tradeTotalPoints', 'tradePointsTotal', 'displayPointsTotal',
  'weightedExitFields', 'legFromTrade', 'mergeSamePriceLegs', 'labelLegs',
  'mergeContextFields', 'combineTradeObjects', 'sideMeta', 'reportSigned',
  'srCsvHeader', 'srCsvCells', 'tradeCsvHeader', 'tradeCsvRow', 'reportCsvHeader', 'reportCsvRow'
];

const renderer = () => loadRenderer(NAMES, { settings: SETTINGS, Date });
const plain = value => JSON.parse(JSON.stringify(value));

// MES (tick 0,25), long 7700 → 7706 (24 ticků), SL 7697 (12 ticků).
function course(overrides) {
  return {
    id: 'tc-' + Math.random().toString(16).slice(2),
    instrument: 'MES', date: '2026-09-12', entryTime: '16:00', entryPrice: 7700,
    exitTime: '16:05', exitPrice: 7706, result: 'target', side: 'long',
    points: 6, contracts: 2, commission: 3.8, pnl: 56.2, pnlRaw: 56.2,
    positionId: 'pos-tc', fillStatus: 'FILLED', slPrice: 7697,
    ...overrides
  };
}

// --------------------------------------------------------------- dopočty

test('exitTicks je znaménkový posun výstupu proti vstupu', () => {
  assert.equal(FJPoints.postExitTickFields(course(), 0.25).exitTicks, 24);
  assert.equal(FJPoints.postExitTickFields(course({ side: 'short' }), 0.25).exitTicks, -24, 'short: výstup nad vstupem je proti směru');
  assert.equal(FJPoints.postExitTickFields(course({ side: '' }), 0.25).exitTicks, null, 'bez směru se nehádá');
});

test('maxFavorableTicks = max(mfe, exitTicks + postExitFavorable)', () => {
  const both = FJPoints.postExitTickFields(course({ mfeTicks: 30, postExitFavorableTicks: 8 }), 0.25);
  assert.equal(both.maxFavorableTicks, 32, 'pokračování po výstupu (24 + 8) přebije MFE 30');
  const mfeWins = FJPoints.postExitTickFields(course({ mfeTicks: 40, postExitFavorableTicks: 8 }), 0.25);
  assert.equal(mfeWins.maxFavorableTicks, 40, 'uvnitř obchodu to došlo dál než po výstupu');
});

test('maxAdverseTicks = max(mae, postExitAdverse − exitTicks)', () => {
  const postExit = FJPoints.postExitTickFields(course({ maeTicks: 6, postExitAdverseTicks: 30 }), 0.25);
  assert.equal(postExit.maxAdverseTicks, 6, '30 − 24 = 6, stejně jako MAE');
  const mae = FJPoints.postExitTickFields(course({ maeTicks: 14, postExitAdverseTicks: 30 }), 0.25);
  assert.equal(mae.maxAdverseTicks, 14);
  assert.equal(mae.touchedSl, true, '14 >= 12 ticků na SL');
  const noSl = FJPoints.postExitTickFields(course({ maeTicks: 11 }), 0.25);
  assert.equal(noSl.touchedSl, false, '11 < 12');
});

test('když chybí jeden vstup, počítá se z toho, co je', () => {
  assert.equal(FJPoints.postExitTickFields(course({ mfeTicks: 20 }), 0.25).maxFavorableTicks, 20);
  assert.equal(FJPoints.postExitTickFields(course({ postExitFavorableTicks: 8 }), 0.25).maxFavorableTicks, 32);
  assert.equal(FJPoints.postExitTickFields(course({ maeTicks: 5 }), 0.25).maxAdverseTicks, 5);
});

test('když chybí všechny vstupy, výsledek je null – NIKDY 0', () => {
  const d = FJPoints.postExitTickFields(course(), 0.25);
  assert.equal(d.maxFavorableTicks, null);
  assert.equal(d.maxAdverseTicks, null);
  assert.equal(d.touchedSl, null);
  // Naměřená nula je jiná informace než prázdno.
  const measured = FJPoints.postExitTickFields(course({ maeTicks: 0, mfeTicks: 0 }), 0.25);
  assert.equal(measured.maxAdverseTicks, 0);
  assert.equal(measured.maxFavorableTicks, 0);
});

test('stopnutý obchod: stávající hodnoty zůstávají, touchedSl se nepočítá', () => {
  const stopped = {
    side: 'long', entryPrice: 7700, exitPrice: 7697, slPrice: 7697, result: 'stoploss',
    postExitFavorableTicks: 20, postExitAdverseTicks: 4
  };
  const d = FJPoints.postExitTickFields(stopped, 0.25);
  assert.equal(d.exitTicks, -12);
  assert.equal(d.maxAdverseTicks, 16, 'beze změny: 12 ticků na SL + 4 po výstupu');
  assert.equal(d.maxFavorableTicks, 8, '−12 + 20');
  assert.equal(d.touchedSl, null, 'degenerovaný příznak – u stopnutého obchodu vždy true');
  assert.equal(d.touchedEntry, null);
  // Bez jakéhokoli měření je u stopnutého obchodu jistý aspoň SL.
  const bare = { ...stopped, postExitAdverseTicks: undefined, postExitFavorableTicks: undefined };
  assert.equal(FJPoints.postExitTickFields(bare, 0.25).maxAdverseTicks, 12);
});

// ------------------------------------------------------------- validace

test('slTicks > 40 je podezřelé, přesně 40 ne', () => {
  assert.equal(FJPoints.slTicksSuspicious(1607), true, 'živá data 2026-08-04 17:53: slPrice 7338');
  assert.equal(FJPoints.slTicksSuspicious(41), true);
  assert.equal(FJPoints.slTicksSuspicious(40), false);
  assert.equal(FJPoints.slTicksSuspicious(null), false);
});

test('neúplný kontext: naplněný obchod bez MFE nebo MAE', () => {
  assert.equal(FJPoints.contextIncomplete(course()), true);
  assert.equal(FJPoints.contextIncomplete(course({ mfeTicks: 5 })), true, 'chybí MAE');
  assert.equal(FJPoints.contextIncomplete(course({ maeTicks: 5 })), true, 'chybí MFE');
  assert.equal(FJPoints.contextIncomplete(course({ mfeTicks: 5, maeTicks: 0 })), false, 'nula je vyplněná hodnota');
  assert.equal(FJPoints.contextIncomplete(course({ fillStatus: 'MISSED' })), false, 'nenaplněný setup se neposuzuje');
});

// -------------------------------------------------------------- číselník

test('typ cílové hladiny má výchozí hodnoty ze zadání', () => {
  assert.deepEqual(FJTaxonomy.allKeys('TARGET_LEVEL'), [
    'LIQUIDITY', 'VPOC_DAY', 'VPOC_30M', 'VPOC_1M', 'VAH', 'VAL', 'VWAP', 'LVN',
    'GAP_EDGE', 'LTA_LEVEL', 'TRAIL_M2', 'MANUAL_EXIT'
  ]);
  assert.equal(FJTaxonomy.labelOf('TARGET_LEVEL', 'VPOC_30M'), 'Netestovaný VPOC 30min svíce');
  assert.equal(FJTaxonomy.labelOf('TARGET_LEVEL', 'TRAIL_M2'), 'Trail podle 1min M2');
  assert.equal(FJTaxonomy.labelOf('TARGET_LEVEL', 'MANUAL_EXIT'), 'Ruční výstup bez hladiny');
  assert.equal(FJTaxonomy.vocabularyOf('TARGET_LEVEL'), 'TARGET_LEVEL', 'vlastní číselník, ne sdílený s hladinou vstupu');
});

test('typ cílové hladiny jde přejmenovat, skrýt a doplnit vlastní volbou', () => {
  try {
    FJTaxonomy.applyConfig({ TARGET_LEVEL: {
      labels: { VAH: 'Horní hrana VA' }, hidden: ['LVN'], custom: { CUSTOM_ONH: 'ONH' }
    } });
    assert.equal(FJTaxonomy.labelOf('TARGET_LEVEL', 'VAH'), 'Horní hrana VA');
    assert.equal(FJTaxonomy.labelOf('ENTRY_LEVEL', 'VAH'), 'VAH', 'číselník vstupu se nedotkne');
    assert.equal(FJTaxonomy.isHidden('TARGET_LEVEL', 'LVN'), true);
    assert.ok(FJTaxonomy.allKeys('TARGET_LEVEL').includes('LVN'), 'skrytá volba zůstává platná');
    assert.ok(FJTaxonomy.visibleOptions('TARGET_LEVEL').every(o => o.key !== 'LVN'));
    assert.ok(FJTaxonomy.visibleOptions('TARGET_LEVEL', ['LVN']).some(o => o.key === 'LVN'), 'obchod, který ji má, o ni nepřijde');
    assert.equal(FJTaxonomy.labelOf('TARGET_LEVEL', 'CUSTOM_ONH'), 'ONH');
    const clean = FJTaxonomy.sanitizeConfig(FJTaxonomy.getConfig());
    assert.equal(clean.TARGET_LEVEL.labels.VAH, 'Horní hrana VA', 'přežije export/import číselníků');
  } finally {
    FJTaxonomy.applyConfig({});
  }
});

test('sanitizeTargetLevel: typ + cena, neznámý typ se zahodí, prázdné je null', () => {
  assert.deepEqual(FJTaxonomy.sanitizeTargetLevel({ type: 'VWAP', price: '7712.5' }), { type: 'VWAP', price: 7712.5 });
  assert.deepEqual(FJTaxonomy.sanitizeTargetLevel({ type: 'VWAP', price: '' }), { type: 'VWAP', price: null });
  assert.deepEqual(FJTaxonomy.sanitizeTargetLevel({ type: 'NENI', price: 7700 }), { type: '', price: 7700 });
  assert.equal(FJTaxonomy.sanitizeTargetLevel({ type: '', price: '' }), null);
  assert.equal(FJTaxonomy.sanitizeTargetLevel(undefined), null);
});

// -------------------------------------------------------------- sloučení

test('sloučení: MFE/MAE je maximum přes nohy, prázdná noha se nepočítá', () => {
  const r = renderer();
  const tp1 = course({ exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, mfeTicks: 14, maeTicks: 2 });
  const tp2 = course({ exitTime: '16:09', exitPrice: 7706, points: 6, contracts: 1, mfeTicks: 30, maeTicks: 5 });
  const merged = r.combineTradeObjects([tp1, tp2]);
  assert.equal(merged.mfeTicks, 30);
  assert.equal(merged.maeTicks, 5);
  assert.equal(merged.maxFavorableTicks, 30, 'dopočet se po sloučení počítá znovu');
  assert.equal(merged.maxAdverseTicks, 5);

  const partial = r.combineTradeObjects([
    course({ exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, mfeTicks: 14 }),
    course({ exitTime: '16:09', exitPrice: 7706, points: 6, contracts: 1 })
  ]);
  assert.equal(partial.mfeTicks, 14);
  assert.equal(partial.maeTicks, undefined, 'prázdná pole se nezměnila na nulu');
});

test('sloučení: cílové hladiny a doba sledování nezmizí', () => {
  const r = renderer();
  const tp1 = course({
    exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1,
    targetLevel1: { type: 'VWAP', price: 7703 }, observedMinutes: 5
  });
  const tp2 = course({
    exitTime: '16:09', exitPrice: 7706, points: 6, contracts: 1,
    targetLevel2: { type: 'LIQUIDITY', price: 7706 }, observedMinutes: 30
  });
  const merged = r.combineTradeObjects([tp1, tp2]);
  assert.deepEqual(plain(merged.targetLevel1), { type: 'VWAP', price: 7703 });
  assert.deepEqual(plain(merged.targetLevel2), { type: 'LIQUIDITY', price: 7706 });
  assert.equal(merged.observedMinutes, 30, 'z nohy s nejpozdějším výstupem');
});

test('nová pole jsou v popisu kontextu (bílá listina slučování)', () => {
  const byKey = Object.fromEntries(FJTaxonomy.TRADE_CONTEXT_FIELDS.map(f => [f.key, f]));
  assert.equal(byKey.mfeTicks.merge, 'max');
  assert.equal(byKey.maeTicks.merge, 'max');
  assert.equal(byKey.observedMinutes.merge, 'lastExit');
  assert.equal(byKey.targetLevel1.enumName, 'TARGET_LEVEL');
  assert.equal(byKey.targetLevel2.enumName, 'TARGET_LEVEL');
});

// --------------------------------------------------------------- exporty

test('oba CSV exporty a AI export mají nová pole', () => {
  const r = renderer();
  const trade = r.applyPostExitFields(course({
    journalName: 'Hlavní', mfeTicks: 30, maeTicks: 6, observedMinutes: 20,
    postExitFavorableTicks: 8, postExitAdverseTicks: 30,
    targetLevel1: { type: 'VWAP', price: 7703 }, targetLevel2: { type: 'LIQUIDITY', price: 7710 },
    images: ['fjimg://a']
  }));
  for (const [header, row, label] of [
    [r.tradeCsvHeader(), r.tradeCsvRow(trade, null), 'export deníku'],
    [r.reportCsvHeader(), r.reportCsvRow(trade, null), 'export reportů']
  ]) {
    assert.equal(header.length, row.length, label + ': hlavička a řádek se rozešly');
    const rec = Object.fromEntries(header.map((name, i) => [name, row[i]]));
    assert.equal(rec['MFE (ticky)'], 30, label);
    assert.equal(rec['MAE (ticky)'], 6, label);
    assert.equal(rec['Sledováno po výstupu (min)'], 20, label);
    assert.equal(rec['Výstup (ticky)'], 24, label);
    assert.equal(rec['Max ve směru celkem (ticky)'], 32, label);
    assert.equal(rec['Max proti (ticky)'], 6, label);
    assert.equal(rec['Cíl 1 typ'], 'VWAP', label);
    assert.equal(rec['Cíl 1 cena'], 7703, label);
    assert.equal(rec['Cíl 2 typ'], 'LIQUIDITY', label);
    assert.equal(rec['Cíl 2 cena'], 7710, label);
    assert.equal(rec['Neúplný kontext'], 'ne', label);
    assert.equal(rec['Stav naplnění'], 'FILLED', label + ': sloupce za novými se nesmí posunout');
  }
  const bare = r.applyPostExitFields(course({ result: 'breakeven' }));
  const rec = Object.fromEntries(r.tradeCsvHeader().map((n, i) => [n, r.tradeCsvRow(bare, null)[i]]));
  assert.equal(rec['MFE (ticky)'], '');
  assert.equal(rec['Max proti (ticky)'], '');
  assert.equal(rec['Cíl 1 typ'], '');
  assert.equal(rec['Neúplný kontext'], 'ano');

  const exported = loadMain(['stripImages']).stripImages(trade);
  for (const key of ['mfeTicks', 'maeTicks', 'observedMinutes', 'exitTicks', 'maxFavorableTicks', 'maxAdverseTicks', 'targetLevel1', 'targetLevel2']) {
    assert.notEqual(exported[key], undefined, 'AI export: chybí ' + key);
  }
  assert.equal(exported.imageCount, 1);
});

// ---------------------------------------------------------------- migrace

test('migrace: nulové maxAdverseTicks bez MAE se vyčistí, stopnuté zůstanou', async () => {
  const writes = [];
  let backups = 0;
  const trades = [
    // artefakt: ziskový obchod, maxAdverseTicks 0, MAE nikdy nebylo
    course({ id: 'win', postExitAdverseTicks: 4, postExitFavorableTicks: 8, slTicks: 12, maxTicks: 32, maxAdverseTicks: 0, touchedEntry: false, touchedSl: false }),
    // stopnutý obchod: stávající hodnoty se nesmí změnit
    { id: 'sl', instrument: 'MES', side: 'long', entryPrice: 7700, exitPrice: 7697, slPrice: 7697, result: 'stoploss',
      fillStatus: 'FILLED', postExitAdverseTicks: 4, postExitFavorableTicks: 20, slTicks: 12, maxTicks: 8, maxAdverseTicks: 16 }
  ];
  const r = loadRenderer([
    'SCHEMA_VERSION', 'ensureActiveJournalData', 'commitJournal', 'getAll',
    'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES',
    'POST_EXIT_DERIVED_KEYS', 'postExitFields', 'TICK_FIELDS_VERSION', 'runTickFieldsMigration'
  ], {
    db: { data: { trades, settings: [], dayNotes: {} }, close() {} },
    activeJournalId: 'j1', settings: SETTINGS,
    window: { desktopAPI: {
      writeJournal: async (id, data) => { writes.push(plain(data)); return { ok: true }; },
      backupJournal: async () => { backups++; return { ok: true }; }
    } }
  });

  const result = await r.runTickFieldsMigration();
  const data = plain(vm.runInContext('db.data', r.__context));
  const byId = Object.fromEntries(data.trades.map(t => [t.id, t]));

  assert.equal(result.changed, 2, 'oba obchody dostanou nová uložená pole');
  assert.equal(backups, 1, 'záloha proběhla před zápisem');
  assert.equal(byId.win.maxAdverseTicks, undefined, 'artefakt nuly je pryč (null)');
  assert.equal(byId.win.touchedSl, undefined);
  assert.equal(byId.win.exitTicks, 24, 'doplněno nové uložené pole');
  assert.equal(byId.win.maxFavorableTicks, 32);
  assert.equal(byId.sl.maxAdverseTicks, 16, 'stopnutý obchod beze změny');
  assert.equal(byId.sl.maxTicks, 8);
  assert.equal(byId.sl.slTicks, 12);
  assert.equal(byId.sl.exitTicks, -12);
  assert.equal(byId.sl.maxFavorableTicks, 8);
  assert.equal(byId.sl.touchedSl, undefined, 'degenerovaný příznak se u stopnutého nedopočítává');
  assert.equal(data.tickFieldsVersion, 1);

  // Podruhé už se nedělá nic.
  assert.equal((await r.runTickFieldsMigration()).skipped, true);
  assert.equal(backups, 1);
});

// ------------------------------------------------- odvozené MFE / MAE

test('target: mfeTicks = exitTicks, stoploss: maeTicks = |exitTicks|, jinak nic', () => {
  assert.deepEqual(plain(FJPoints.deriveCourseTicks(course(), 0.25)), { mfeTicks: 24 });
  const stopped = course({ result: 'stoploss', exitPrice: 7697 });
  assert.deepEqual(plain(FJPoints.deriveCourseTicks(stopped, 0.25)), { maeTicks: 12 });
  assert.deepEqual(plain(FJPoints.deriveCourseTicks(course({ result: 'breakeven' }), 0.25)), {});
  assert.deepEqual(plain(FJPoints.deriveCourseTicks(course({ result: 'manual' }), 0.25)), {});
});

test('ruční uzavření mezi cílem a SL se nepředvyplňuje, když jde rozlišit', () => {
  // Cíl ležel na 7712, ale obchod se zavřel ručně na 7706.
  const early = course({ targetLevel1: { type: 'VWAP', price: 7712 } });
  assert.deepEqual(plain(FJPoints.deriveCourseTicks(early, 0.25)), {});
  // Výstup odpovídá ceně cílové hladiny (i té druhé).
  const hit = course({ targetLevel1: { type: 'VWAP', price: 7703 }, targetLevel2: { type: 'VAH', price: 7706 } });
  assert.deepEqual(plain(FJPoints.deriveCourseTicks(hit, 0.25)), { mfeTicks: 24 });
  // Stop zavřený ručně dřív, než cena došla na SL 7697.
  const manualStop = course({ result: 'stoploss', exitPrice: 7699 });
  assert.deepEqual(plain(FJPoints.deriveCourseTicks(manualStop, 0.25)), {});
  // Sloučený obchod se neodvozuje.
  const multi = course({ legs: [{ exitPrice: 7703 }, { exitPrice: 7706 }] });
  assert.deepEqual(plain(FJPoints.deriveCourseTicks(multi, 0.25)), {});
});

test('applyPostExitFields: odvozená hodnota má příznak, ruční ji nikdy nepřepíše', () => {
  const r = renderer();
  const derived = r.applyPostExitFields(course());
  assert.equal(derived.mfeTicks, 24);
  assert.equal(derived.mfeTicksDerived, true);
  assert.equal(derived.maeTicks, undefined, 'MAE u targetu se neodvozuje');

  const manual = r.applyPostExitFields(course({ mfeTicks: 40 }));
  assert.equal(manual.mfeTicks, 40, 'ruční hodnota má přednost');
  assert.equal(manual.mfeTicksDerived, undefined);
  // Opakovaný přepočet ji taky nechá být.
  assert.equal(r.applyPostExitFields(manual).mfeTicks, 40);

  // Odvozená hodnota se obnoví, když se výstup změní, a zmizí, když už cíli neodpovídá.
  derived.exitPrice = 7708;
  assert.equal(r.applyPostExitFields(derived).mfeTicks, 32);
  derived.targetLevel1 = { type: 'VWAP', price: 7720 };
  const gone = r.applyPostExitFields(derived);
  assert.equal(gone.mfeTicks, undefined);
  assert.equal(gone.mfeTicksDerived, undefined);

  // Nenaplněný setup se nepředvyplňuje.
  assert.equal(r.applyPostExitFields(course({ fillStatus: 'MISSED' })).mfeTicks, undefined);
});

test('sloučení: příznak odvození jde s nohou, která dodala maximum', () => {
  const r = renderer();
  const tp1 = course({ exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, mfeTicks: 12, mfeTicksDerived: true });
  const tp2 = course({ exitTime: '16:09', exitPrice: 7706, points: 6, contracts: 1, mfeTicks: 30 });
  const merged = r.combineTradeObjects([tp1, tp2]);
  assert.equal(merged.mfeTicks, 30);
  assert.equal(merged.mfeTicksDerived, undefined, 'maximum je ruční hodnota');
  const both = r.combineTradeObjects([
    course({ exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, mfeTicks: 12, mfeTicksDerived: true }),
    course({ exitTime: '16:09', exitPrice: 7706, points: 6, contracts: 1, mfeTicks: 24, mfeTicksDerived: true })
  ]);
  assert.equal(both.mfeTicksDerived, true);
});

test('štítek „neúplný kontext": jen v backtestovém deníku, ne u nenaplněných', () => {
  const ctx = journal => loadRenderer(['esc', 'contextPillsHTML'], { journalProfiles: journal, activeJournalId: 'j1' });
  const trade = course();
  assert.match(ctx([{ id: 'j1', name: 'B', backtest: true }]).contextPillsHTML(trade), /neúplný kontext/);
  assert.ok(!ctx([{ id: 'j1', name: 'Živý' }]).contextPillsHTML(trade).includes('neúplný kontext'), 'živý deník štítek nemá');
  for (const status of ['NO_FILL', 'MISSED', 'SKIPPED']) {
    assert.ok(!ctx([{ id: 'j1', name: 'B', backtest: true }]).contextPillsHTML(course({ fillStatus: status })).includes('neúplný kontext'), status);
  }
});

// ------------------------------------------- formulář: dopočet jako read-only
//
// MFE u targetu a MAE u stoplossu nejsou naměřené – jsou to aritmetika z výstupní
// ceny. Formulář je proto neukazuje v editovatelném poli (vypadalo by to jako
// měření), ale jako šedý text „dopočítáno z výstupní ceny" s odkazem „upravit
// ručně". V každém obchodě se tak ručně vyplňuje právě jedno z těch dvou čísel.

// `legs` = další cíle ve formuláři (řádky #extraLegsList) jako [{exitPrice, pnl}].
function courseForm(values, datasets, legs) {
  const nodes = new Map();
  const node = id => ({
    id, value: values[id] ?? '', textContent: '', innerHTML: '', style: {},
    dataset: { ...(datasets?.[id] || {}) }, focus() {}, select() {}
  });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); } };
  const names = [
    '$', 'esc', 'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument',
    'BUILTIN_TICK_SIZES', 'deriveStopLossPrice', 'postExitTicksWarning', 'postExitApplies',
    'postExitDraftFromForm', 'formatTicks', 'renderPostExitHints', 'syncCourseField',
    'editCourseManually', 'useDerivedCourse'
  ];
  if (legs) {
    const field = value => ({ value: String(value ?? '') });
    document.querySelectorAll = sel => (sel === '#extraLegsList .leg-row' ? legs.map(l => ({
      querySelector: cls => ({
        '.leg-label': field(''), '.leg-exitTime': field(''), '.leg-exitPrice': field(l.exitPrice),
        '.leg-result': field(''), '.leg-points': field(''), '.leg-contracts': field(1),
        '.leg-commission': field(0), '.leg-pnl': field(l.pnl)
      })[cls]
    })) : []);
    names.push('readLegRows', 'classifyResult');
  }
  const r = loadRenderer(names, { document, settings: SETTINGS });
  r.renderPostExitHints();
  return { r, get: id => document.getElementById(id) };
}
const TARGET_FORM = {
  fillStatus: 'FILLED', instrument: 'MES', side: 'long', result: 'target',
  entryPrice: '7700', exitPrice: '7706', slPrice: '7697'
};
const STOP_FORM = { ...TARGET_FORM, result: 'stoploss', exitPrice: '7697' };
const shown = n => n.style.display !== 'none';

test('formulář target: MFE read-only dopočet, MAE editovatelné pole', () => {
  const f = courseForm(TARGET_FORM);
  assert.ok(!shown(f.get('mfeTicks')), 'pole MFE je skryté');
  assert.ok(shown(f.get('mfeTicksView')), 'místo něj read-only text');
  assert.equal(f.get('mfeTicksViewValue').textContent, '24');
  assert.equal(f.get('mfeTicks').value, 24, 'hodnota zůstává ve skrytém poli pro uložení');
  assert.equal(f.get('mfeTicks').dataset.derived, '1', 'uloží se s příznakem Derived');
  assert.ok(shown(f.get('maeTicks')), 'MAE se vyplňuje ručně');
  assert.ok(!shown(f.get('maeTicksView')));
});

test('formulář stoploss: MAE read-only dopočet, MFE editovatelné pole', () => {
  const f = courseForm(STOP_FORM);
  assert.ok(!shown(f.get('maeTicks')));
  assert.equal(f.get('maeTicksViewValue').textContent, '12');
  assert.ok(shown(f.get('mfeTicks')));
  assert.ok(!shown(f.get('mfeTicksView')));
});

test('formulář breakeven / ruční: obě pole editovatelná', () => {
  for (const result of ['breakeven', 'manual', '']) {
    const f = courseForm({ ...TARGET_FORM, result });
    assert.ok(shown(f.get('mfeTicks')) && shown(f.get('maeTicks')), result || 'prázdný výsledek');
    assert.ok(!shown(f.get('mfeTicksView')) && !shown(f.get('maeTicksView')));
  }
});

test('„upravit ručně": dopočet se přesune do pole a dál je to ruční hodnota', () => {
  const f = courseForm(TARGET_FORM);
  f.r.editCourseManually('mfeTicks');
  const el = f.get('mfeTicks');
  assert.ok(shown(el), 'pole je vidět');
  assert.ok(!shown(f.get('mfeTicksView')));
  assert.equal(String(el.value), '24', 'výchozí hodnota = dopočet');
  assert.equal(el.dataset.derived, '', 'bez příznaku Derived');
  assert.equal(el.dataset.manual, '1');

  // Ručně uzavřený obchod: cena došla dál, než kde byl výstup.
  el.value = '31';
  f.r.renderPostExitHints();
  assert.equal(el.value, '31', 'přepočet ruční hodnotu nepřepíše');
  assert.match(f.get('mfeTicksRevert').textContent, /24 t/, 'nabídne návrat k dopočtu');

  // Smazání při psaní nepřepne pole zpátky na read-only.
  el.value = '';
  f.r.renderPostExitHints();
  assert.ok(shown(el), 'prázdné ruční pole zůstává polem');

  f.r.useDerivedCourse('mfeTicks');
  assert.ok(!shown(el), 'návrat k dopočtu');
  assert.equal(f.get('mfeTicks').dataset.derived, '1');
});

test('uložená ruční hodnota se otevře jako pole, i když jde dopočítat', () => {
  const f = courseForm({ ...TARGET_FORM, mfeTicks: '31' }, { mfeTicks: { manual: '1' } });
  assert.ok(shown(f.get('mfeTicks')));
  assert.equal(f.get('mfeTicks').value, '31');
});

// ------------------------------------------------ MFE / MAE z NinjaTraderu
//
// NinjaTrader vede u každé vstupní exekuce Execution.MaxPrice / MinPrice (extrém
// ceny, dokud je pozice otevřená) – ověřeno v NinjaTrader.sqlite i u čistě
// ručních obchodů bez ATM. Konektor je posílá s výstupem, main.js z nich dělá
// ticky od průměrné vstupní ceny a deník je ukládá s příznakem Source 'nt8'.

test('excursionTicks: long / short od průměrné vstupní ceny, výstup se započítá', () => {
  const { excursionTicks } = loadMain(['excursionTicks']);
  // Reálná exekuce z NinjaTrader.sqlite: MES long 7776 → target 7782, max 7782.5, min 7776.
  assert.deepEqual(plain(excursionTicks({ tickSize: 0.25, excursionMaxPrice: 7782.5, excursionMinPrice: 7776 }, 'long', 7776, 7782)),
    { mfeTicks: 26, maeTicks: 0 }, 'MFE 26 t, ne 24 – cena došla o 2 ticky dál než výstup');
  // Short 7785 → stop 7788.25, max 7788.25, min 7784.5.
  assert.deepEqual(plain(excursionTicks({ tickSize: 0.25, excursionMaxPrice: 7788.25, excursionMinPrice: 7784.5 }, 'short', 7785, 7788.25)),
    { mfeTicks: 2, maeTicks: 13 });
  // NT poslední tick ještě nezapsal: výstupní cena extrém rozšíří.
  assert.equal(excursionTicks({ tickSize: 0.25, excursionMaxPrice: 7777, excursionMinPrice: 7776 }, 'long', 7776, 7775).maeTicks, 4);
});

test('excursionTicks: bez extrémů nebo ticku nic – prázdno, ne nula', () => {
  const { excursionTicks } = loadMain(['excursionTicks']);
  assert.deepEqual(plain(excursionTicks({ tickSize: 0.25 }, 'long', 7776, 7782)), {}, 'NT pohyb nesledoval (sentinel se neposílá)');
  assert.deepEqual(plain(excursionTicks({ excursionMaxPrice: 7782.5, excursionMinPrice: 7776 }, 'long', 7776, 7782)), {}, 'bez ticku');
  assert.deepEqual(plain(excursionTicks({ tickSize: 0.25, excursionMaxPrice: 7782.5, excursionMinPrice: 7776 }, '', 7776, 7782)), {}, 'bez směru');
});

// Pozice ze snímku bez ceny má avgPrice 0 (normalizeSnapshotPosition) – „MFE"
// by pak byla celá cena instrumentu v ticích, uložená jako měření z NT.
test('excursionTicks: nesmyslné vstupy nedají nic, ne obří čísla', () => {
  const { excursionTicks } = loadMain(['excursionTicks']);
  const ext = { tickSize: 0.25, excursionMaxPrice: 7782.5, excursionMinPrice: 7776 };
  assert.deepEqual(plain(excursionTicks(ext, 'long', 0, 7782)), {}, 'vstupní cena 0 = neznámá');
  assert.deepEqual(plain(excursionTicks({ tickSize: 0.25, excursionMaxPrice: 1e300, excursionMinPrice: 7776 }, 'long', 7776, 7782)), {}, 'sentinel NT');
  assert.deepEqual(plain(excursionTicks({ tickSize: 1, excursionMaxPrice: 1.7e308, excursionMinPrice: -1.7e308 }, 'long', 7776, 7782)), {}, 'přetečení');
});

test('import: MFE/MAE z NinjaTraderu dostanou příznak nt8, chybějící se nezakládají', () => {
  const r = loadRenderer(['courseTicksFromEvent'], {});
  assert.deepEqual(plain(r.courseTicksFromEvent({ source: 'ninjatrader', mfeTicks: 26, maeTicks: 0 })),
    { mfeTicks: 26, mfeTicksSource: 'nt8', maeTicks: 0, maeTicksSource: 'nt8' }, 'naměřená nula je platná hodnota');
  assert.deepEqual(plain(r.courseTicksFromEvent({ source: 'ninjatrader' })), {});
});

// EVENT_SCHEMA popisuje mfeTicks/maeTicks obecně pro trade_closed, takže je
// může poslat i TradingView relay nebo jiný zdroj. „Naměřeno v NinjaTraderu"
// smí u hodnoty stát jen tehdy, když opravdu přišla z NT.
test('import: MFE/MAE z jiného zdroje nejsou „z NinjaTraderu"', () => {
  const r = loadRenderer(['courseTicksFromEvent'], {});
  assert.deepEqual(plain(r.courseTicksFromEvent({ source: 'tradingview', mfeTicks: 12 })), { mfeTicks: 12, mfeTicksSource: 'tradingview' });
  assert.equal(r.courseTicksFromEvent({ mfeTicks: 12 }).mfeTicksSource, 'external', 'bez uvedeného zdroje');
});

test('sloučení: ruční > NinjaTrader > dopočet, import ruční hodnotu nepřepíše', () => {
  const r = renderer();
  const merged = list => plain(r.mergeContextFields(list));
  const manual = course({ mfeTicks: 20 });
  const nt8 = course({ mfeTicks: 30, mfeTicksSource: 'nt8' });
  const derived = course({ mfeTicks: 40, mfeTicksDerived: true });
  const a = merged([manual, nt8, derived]);
  assert.equal(a.mfeTicks, 20, 'ruční hodnota vyhrává, i když je menší');
  assert.equal(a.mfeTicksSource, undefined);
  const b = merged([derived, nt8]);
  assert.equal(b.mfeTicks, 30, 'měření z NT8 má přednost před aritmetikou');
  assert.equal(b.mfeTicksSource, 'nt8');
  assert.equal(b.mfeTicksDerived, undefined);
  const c = merged([nt8, course({ mfeTicks: 35, mfeTicksSource: 'nt8' })]);
  assert.equal(c.mfeTicks, 35, 'uvnitř jedné vrstvy maximum přes nohy');
  const other = merged([derived, course({ mfeTicks: 28, mfeTicksSource: 'tradingview' })]);
  assert.equal(other.mfeTicks, 28, 'měření jiným konektorem má taky přednost před aritmetikou');
  assert.equal(other.mfeTicksSource, 'tradingview', 'a původ se nepřepíše na nt8');
});

test('applyPostExitFields: hodnotu z NinjaTraderu dopočet nepřepíše', () => {
  const r = renderer();
  const t = r.applyPostExitFields(course({ mfeTicks: 26, mfeTicksSource: 'nt8' }));
  assert.equal(t.mfeTicks, 26);
  assert.equal(t.mfeTicksDerived, undefined);
  assert.equal(t.mfeTicksSource, 'nt8');
});

test('formulář: hodnota z NinjaTraderu je editovatelné pole s poznámkou o původu', () => {
  const f = courseForm({ ...TARGET_FORM, mfeTicks: '26' }, { mfeTicks: { manual: '1', source: 'nt8' } });
  assert.ok(shown(f.get('mfeTicks')), 'měření se nezobrazuje jako dopočet');
  assert.equal(f.get('mfeTicksSourceNote').textContent, 'naměřeno v NinjaTraderu');
  f.r.useDerivedCourse('mfeTicks');
  assert.equal(f.get('mfeTicks').dataset.source, '', 'návrat k dopočtu původ zahodí');
});

// Měření má před aritmetikou přednost. NT8 MFE 26 t u targetu s výstupem na
// 24 t by jinak pod sebou mělo odkaz „použít dopočet (24 t)" – skoro u každého
// obchodu a s jediným kliknutím k horšímu číslu.
test('formulář: k hodnotě naměřené konektorem se návrat na dopočet nenabízí', () => {
  const f = courseForm({ ...TARGET_FORM, mfeTicks: '26' }, { mfeTicks: { manual: '1', source: 'nt8' } });
  assert.ok(!shown(f.get('mfeTicksRevert')), 'bez odkazu zpět na dopočet');
  assert.equal(f.get('mfeTicksRevert').textContent, '');

  const tv = courseForm({ ...TARGET_FORM, mfeTicks: '26' }, { mfeTicks: { manual: '1', source: 'tradingview' } });
  assert.equal(tv.get('mfeTicksSourceNote').textContent, 'naměřeno konektorem (tradingview)');

  // Přepsaná hodnota už měření není – odkaz se nabídne jako u každé ruční.
  const edited = courseForm({ ...TARGET_FORM, mfeTicks: '30' }, { mfeTicks: { manual: '1' } });
  assert.match(edited.get('mfeTicksRevert').textContent, /24 t/);
});

// ------------------------------------------- formulář: obchod s víc cíli
//
// Formulář má výstupní cenu a výsledek jen PRVNÍHO cíle. Dřív se z nich MFE/MAE
// přepočítávaly i u obchodu s víc cíli: uložená odvozená hodnota ze sloučení
// (třeba 22 t z TP2) se nahradila 10 t z TP1 a uložením se z ní stala RUČNÍ
// hodnota. S BE jako prvním cílem se smazala úplně.

test('formulář s víc cíli: odvozená hodnota ze sloučení se ukáže, nepřepočítá', () => {
  const tp2 = [{ exitPrice: '7711.5', pnl: '55' }];
  const f = courseForm({ ...TARGET_FORM, mfeTicks: '46' }, { mfeTicks: { derived: '1', mergedDerived: '46' } }, tp2);
  assert.ok(!shown(f.get('mfeTicks')), 'read-only jako každý dopočet');
  assert.equal(f.get('mfeTicksViewValue').textContent, '46', 'ne 24 z prvního cíle');
  assert.equal(String(f.get('mfeTicks').value), '46', 'do uložení jde uložená hodnota');
  assert.equal(f.get('mfeTicks').dataset.derived, '1', 'a s příznakem Derived');
  assert.match(f.get('mfeTicksViewNote').textContent, /ze sloučených cílů/);
});

test('formulář s víc cíli: BE jako první cíl hodnotu ze sloučení nesmaže', () => {
  const be = { ...TARGET_FORM, result: 'breakeven', exitPrice: '7700' };
  const f = courseForm({ ...be, mfeTicks: '46' }, { mfeTicks: { derived: '1', mergedDerived: '46' } }, [{ exitPrice: '7711.5', pnl: '55' }]);
  assert.equal(String(f.get('mfeTicks').value), '46');
  assert.equal(f.get('mfeTicks').dataset.derived, '1');
});

test('formulář s víc cíli: bez hodnoty ze sloučení se z prvního cíle nic neodvozuje', () => {
  const f = courseForm(TARGET_FORM, {}, [{ exitPrice: '7711.5', pnl: '55' }]);
  assert.ok(shown(f.get('mfeTicks')) && shown(f.get('maeTicks')), 'obě pole editovatelná');
  assert.equal(f.get('mfeTicks').value, '', 'žádných 24 t z prvního cíle');
  assert.equal(f.get('mfeTicks').dataset.derived, '');
});

// ------------------------------------------------ import do deníku
//
// Import zapisuje do deníku podle mapování účtů, ne nutně do aktivního, a běží
// i před přihlášením. Obchod se proto počítá s nastavením CÍLOVÉHO deníku –
// i když se sloučí s předchozí nohou (combineTradeObjects).

function importer(journal, activeSettings) {
  let stored = journal;
  const window = {
    desktopAPI: {
      readJournal: async () => ({ ok: true, data: JSON.parse(JSON.stringify(stored)) }),
      writeJournal: async (_id, data) => { stored = data; return { ok: true }; }
    }
  };
  const r = loadRenderer([...NAMES, 'courseTicksFromEvent', 'mapCapturedTrade', 'tradeHasSourceEventId', 'appendOrMergeCapturedTrade'],
    { settings: activeSettings, Date, window });
  return { r, trades: () => stored.trades };
}
const FDXS_JOURNAL = () => ({
  trades: [],
  settings: [{ key: 'main', value: { templates: [{ instrument: 'FDXS', pointValue: 1, tickSize: 1 }], breakEvenEnabled: false, autoMergeLegs: true } }]
});
function fdxsExit(id, exitPrice, extra) {
  const pts = exitPrice - 24000;
  return {
    id, type: 'trade_closed', source: 'ninjatrader', account: 'A', instrument: 'FDXS', side: 'long',
    entryTime: '2026-09-26T08:00:00Z', exitTime: '2026-09-26T08:0' + id.slice(-1) + ':00Z',
    entryPrice: 24000, exitPrice, quantity: 1, contracts: 1, points: Math.abs(pts),
    grossPnl: pts, commission: 0, pnl: pts, positionId: 'p1', ...extra
  };
}

test('import: sloučený obchod dostane dopočty s tickem cílového deníku', async () => {
  // Aktivní deník (a před přihlášením i prázdné `settings`) FDXS nezná.
  const imp = importer(FDXS_JOURNAL(), { templates: [] });
  await imp.r.appendOrMergeCapturedTrade('j2', fdxsExit('e1', 24010));
  assert.equal(imp.trades()[0].exitTicks, 10, 'jediný výstup');
  await imp.r.appendOrMergeCapturedTrade('j2', fdxsExit('e2', 24020));
  assert.equal(imp.trades().length, 1, 'sloučeno do jednoho obchodu');
  assert.equal(imp.trades()[0].legs.length, 2);
  assert.equal(imp.trades()[0].exitTicks, 20, 'sloučení dopočty nesmazalo');
});

// Výsledek importu je jen znaménko P/L a SL ani cílové hladiny import nezná.
// Odvození by každé ruční ztrátové uzávěrce dalo „MAE" = ztráta na výstupu.
test('import: MFE/MAE se z výstupu neodvozují, naměřené z NT zůstanou', async () => {
  const imp = importer(FDXS_JOURNAL(), { templates: [] });
  await imp.r.appendOrMergeCapturedTrade('j2', { ...fdxsExit('e1', 23997), positionId: 'loss' });
  await imp.r.appendOrMergeCapturedTrade('j2', { ...fdxsExit('e2', 24010), positionId: 'win' });
  for (const t of imp.trades()) {
    assert.equal(t.mfeTicks, undefined, t.positionId);
    assert.equal(t.maeTicks, undefined, t.positionId);
    assert.equal(t.maeTicksDerived, undefined);
  }
  await imp.r.appendOrMergeCapturedTrade('j2', { ...fdxsExit('e3', 23997, { mfeTicks: 4, maeTicks: 9 }), positionId: 'measured' });
  const measured = imp.trades().find(t => t.positionId === 'measured');
  assert.equal(measured.maeTicks, 9);
  assert.equal(measured.maeTicksSource, 'nt8');
  assert.equal(measured.maxAdverseTicks, 9, 'dopočty z naměřených hodnot hned při importu');
});

// Nalezeno při ověření na Market Replay (2026-09-26): importovaný obchod
// s jediným výstupem neměl exitTicks / maxFavorableTicks / maxAdverseTicks,
// dopočty dostával až po ručním uložení formuláře. Import je teď počítá hned,
// s velikostí ticku ze šablon CÍLOVÉHO deníku.
test('import: dopočty z NT8 hodnot hned, tick ze šablon cílového deníku', () => {
  const r = renderer();
  // Reálný obchod z replaye: ES long 7754.25 → stop 7752, NT8 MFE 13 / MAE 9.
  const es = r.applyPostExitFields({
    instrument: 'ES', side: 'long', result: 'stoploss', fillStatus: 'FILLED',
    entryPrice: 7754.25, exitPrice: 7752, mfeTicks: 13, mfeTicksSource: 'nt8', maeTicks: 9, maeTicksSource: 'nt8'
  }, { templates: [] });
  assert.equal(es.exitTicks, -9);
  assert.equal(es.maxFavorableTicks, 13);
  assert.equal(es.maxAdverseTicks, 9);
  assert.equal(es.mfeTicksSource, 'nt8');

  const fdxs = { instrument: 'FDXS', side: 'long', result: 'target', fillStatus: 'FILLED', entryPrice: 24000, exitPrice: 24010 };
  assert.equal(r.applyPostExitFields({ ...fdxs }).exitTicks, undefined, 'globální nastavení tick pro FDXS nezná');
  assert.equal(r.applyPostExitFields({ ...fdxs }, { templates: [{ instrument: 'FDXS', tickSize: 1 }] }).exitTicks, 10,
    'šablona cílového deníku ho zná');
});
