'use strict';
// Chování ceny PO VÝSTUPU (zadání z 2026-09-25).
//
// Dvě ručně zadaná čísla v ticích – o kolik cena po výstupu pokračovala ve
// směru obchodu a o kolik šla proti – plus dopočty, které z nich dělají to,
// co jde analyzovat: jak daleko pozice došla OD VSTUPU na obě strany.
//
// PROČ NA TOM ZÁLEŽÍ: z těchhle dvou čísel se počítá SL sweep i mřížka
// SL × TP. Když se ztratí při sloučení víc cílů nebo se tiše nahradí nulou,
// analýza vyjde, jen bude špatně – a to se pozná až po měsících sbírání dat.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer, loadMain } = require('./helpers/extract');
const FJPoints = require('../app/points.js');
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
  'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'POST_EXIT_DERIVED_KEYS',
  'postExitFields', 'applyPostExitFields', 'postExitTicksWarning',
  'getDefaultCommissionForInstrument', 'classifyResult', 'signed', 'tradeTotalPoints',
  'tradePointsTotal', 'displayPointsTotal', 'weightedExitFields', 'legFromTrade',
  'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'combineTradeObjects',
  'sideMeta', 'reportSigned', 'postExitApplies',
  'tradeCsvHeader', 'tradeCsvRow', 'reportCsvHeader', 'reportCsvRow'
];

function renderer(settings = SETTINGS) {
  return loadRenderer(NAMES, { settings, Date });
}

// Zadání z 2026-09-25: MES (tick 0,25), long 7700 → 7706, SL 7697, 2 kontrakty.
function specTrade(overrides) {
  return {
    id: 'pe-' + Math.random().toString(16).slice(2),
    instrument: 'MES', date: '2026-09-12', entryTime: '16:00', entryPrice: 7700,
    exitTime: '16:05', exitPrice: 7706, result: 'target', side: 'long',
    points: 6, contracts: 2, commission: 3.8, pnl: 56.2, pnlRaw: 56.2,
    positionId: 'pos-pe', fillStatus: 'FILLED',
    slPrice: 7697, postExitFavorableTicks: 8, postExitAdverseTicks: 30,
    postExitAdverseFirst: false,
    ...overrides
  };
}

test('dopočty ze zadání: slTicks, maxTicks, maxAdverseTicks, touchedEntry', () => {
  const d = FJPoints.postExitTickFields(specTrade(), 0.25);
  assert.equal(d.slTicks, 12, 'rozdíl vstupu a SL je 3 body, tedy 12 ticků');
  assert.equal(d.maxTicks, 32, 'výstup 24 ticků ve směru + 8 ticků pokračování');
  assert.equal(d.maxAdverseTicks, 6, 'protipohyb 30 ticků minus 24 ticků zpátky na vstup');
  assert.equal(d.touchedEntry, true, '30 >= 24, cena se po výstupu vrátila až na vstup');
  // Zadání u tohoto příkladu původně čekalo `touchedSl: true`, ale jeho vlastní
  // pravidlo ("touchedSl = postExitAdverseTicks >= (výstup − vstup) + slTicks")
  // dává při 30 >= 24 + 12 = 36 hodnotu false: cena došla 6 ticků pod vstup a SL
  // ležel 12 ticků pod ním. Autor zadání očekávanou hodnotu 2026-09-25 opravil
  // a potvrdil pravidlo – platí tedy ono.
  assert.equal(d.touchedSl, false, '30 ticků nestačí na 24 zpět na vstup + 12 na SL');
});

test('short je zrcadlo longu – směr nese pole, ne znaménko', () => {
  const short = FJPoints.postExitTickFields({
    side: 'short', entryPrice: 7700, exitPrice: 7694, slPrice: 7703, result: 'target',
    postExitFavorableTicks: 8, postExitAdverseTicks: 30
  }, 0.25);
  const long = FJPoints.postExitTickFields(specTrade(), 0.25);
  assert.deepEqual(short, long, 'stejně vzdálený short musí vyjít stejně jako long');
});

test('protipohyb, který se nevrátil na vstup, nedělá zápornou hodnotu ani vymyšlenou nulu', () => {
  // Bez MAE nevíme, co se dělo uvnitř obchodu. Nula by tvrdila „cena šla proti
  // pozici nula ticků" – to je jiná informace než „nevím", proto null.
  const d = FJPoints.postExitTickFields(specTrade({ postExitAdverseTicks: 4 }), 0.25);
  assert.equal(d.maxAdverseTicks, null, 'cena se po výstupu nevrátila na vstup, ale MAE chybí');
  assert.equal(d.touchedEntry, false);
  assert.equal(d.touchedSl, null, 'bez maxAdverseTicks se nedá říct, jestli došla na SL');
  // S naměřeným MAE je nula skutečná hodnota.
  assert.equal(FJPoints.postExitTickFields(specTrade({ postExitAdverseTicks: 4, maeTicks: 0 }), 0.25).maxAdverseTicks, 0);
});

test('MAE z NT8 má přednost, když je větší než protipohyb po výstupu', () => {
  const d = FJPoints.postExitTickFields(specTrade({ maeTicks: 9 }), 0.25);
  assert.equal(d.maxAdverseTicks, 9, 'uvnitř obchodu to bylo proti pozici dál než po výstupu');
});

test('bez ceny SL se maxAdverseTicks nepočítá a NIKDY se nedosazuje nula', () => {
  const d = FJPoints.postExitTickFields(specTrade({
    slPrice: undefined, result: 'stoploss', postExitAdverseTicks: undefined, postExitFavorableTicks: undefined
  }), 0.25);
  assert.equal(d.slTicks, null, 'prázdná cena SL znamená prázdné riziko, ne nulové');
  assert.equal(d.maxAdverseTicks, null);
  assert.equal(d.touchedSl, null);
});

test('stopnutý obchod: proti pozici došel nejméně na SL, pokračování je širší SL', () => {
  const stopped = {
    side: 'long', entryPrice: 7700, exitPrice: 7697, slPrice: 7697, result: 'stoploss',
    postExitFavorableTicks: 20, postExitAdverseTicks: 4
  };
  const d = FJPoints.postExitTickFields(stopped, 0.25);
  assert.equal(d.slTicks, 12);
  assert.equal(d.maxAdverseTicks, 16, '12 ticků na SL + 4 ticky po výstupu');
  assert.equal(d.maxTicks, 8, 'minus 12 ticků výstupu + 20 ticků pokračování: o 8 ticků širší SL by vyšel');
  // Oba příznaky jsou u stopnutého obchodu DEGENEROVANÉ: výstup JE cena SL,
  // takže by podle definice vyšly vždycky true, ať cena po výstupu udělala
  // cokoli. Jako filtr v analýze by jen oddělily stopnuté obchody od ostatních,
  // proto se nepočítají a analýza u nich pracuje s `maxAdverseTicks`.
  assert.equal(d.touchedEntry, null, 'u stopnutého obchodu se příznak nepočítá');
  assert.equal(d.touchedSl, null, 'u stopnutého obchodu se příznak nepočítá');
});

test('bez směru obchodu se dopočty nehádají', () => {
  const d = FJPoints.postExitTickFields(specTrade({ side: '' }), 0.25);
  assert.equal(d.slTicks, 12, 'riziko jde spočítat i bez směru');
  assert.equal(d.maxTicks, null);
  assert.equal(d.maxAdverseTicks, null);
  assert.equal(d.touchedEntry, null);
});

test('bez velikosti ticku nevznikne žádný dopočet', () => {
  const d = FJPoints.postExitTickFields(specTrade(), null);
  assert.deepEqual(d, { slTicks: null, exitTicks: null, maxTicks: null, maxFavorableTicks: null, maxAdverseTicks: null, touchedEntry: null, touchedSl: null });
});

test('u sloučeného obchodu se měří od ceny POSLEDNÍ nohy, ne od váženého průměru', () => {
  // Vážený průměr výstupů je 7703, poslední noha vystoupila na 7706.
  const merged = {
    side: 'long', entryPrice: 7700, exitPrice: 7703, lastLegExitPrice: 7706,
    slPrice: 7697, result: 'target', postExitFavorableTicks: 8
  };
  assert.equal(FJPoints.postExitTickFields(merged, 0.25).maxTicks, 32);
});

test('velikost ticku: šablona přebije vestavěnou tabulku, neznámý instrument zůstane prázdný', () => {
  const r = renderer({ ...SETTINGS, templates: [{ instrument: 'FDXS', tickSize: 1 }] });
  assert.equal(r.getTickSizeForInstrument('MES 09-26'), 0.25, 'vestavěná tabulka, i s kontraktním měsícem');
  assert.equal(r.getTickSizeForInstrument('FDXS'), 1, 'ze šablony instrumentu');
  assert.equal(r.getTickSizeForInstrument('NEZNAMY'), null, 'tick se nehádá');

  const unknown = r.postExitFields(specTrade({ instrument: 'NEZNAMY' }));
  for (const key of r.POST_EXIT_DERIVED_KEYS) assert.equal(unknown[key], undefined);
});

test('dopočty se na obchod ZAPISUJÍ a při smazání vstupu zase mizí', () => {
  const r = renderer();
  const t = r.applyPostExitFields(specTrade());
  assert.equal(t.maxTicks, 32, 'pole se ukládá, ne jen zobrazuje');
  assert.equal(t.slTicks, 12);

  delete t.slPrice;
  r.applyPostExitFields(t);
  assert.ok(!('slTicks' in t), 'po smazání ceny SL nesmí zůstat viset stará hodnota');
});

test('měkká validace: záporné číslo varuje, ale uloží se kladně', () => {
  const r = renderer();
  assert.equal(r.postExitTicksWarning(''), '', 'prázdné pole není chyba – všechno je nepovinné');
  assert.equal(r.postExitTicksWarning(8), '');
  assert.equal(r.postExitTicksWarning(-8), 'Zadávej kladně, směr určuje pole.');
  assert.equal(r.postExitTicksWarning('nesmysl'), 'Zadej číslo v ticích.');
  // Do výpočtu jde záporná hodnota v absolutní hodnotě – směr nese název pole.
  assert.equal(FJPoints.postExitTickFields(specTrade({ postExitFavorableTicks: -8 }), 0.25).maxTicks, 32);
});

test('sloučení víc cílů nesmí nová pole zahodit', () => {
  const r = renderer();
  const tp1 = specTrade({
    exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1,
    postExitFavorableTicks: 99, postExitAdverseTicks: 99, postExitAdverseFirst: true
  });
  const tp2 = specTrade({
    exitTime: '16:09', exitPrice: 7706, points: 6, contracts: 1,
    postExitFavorableTicks: 8, postExitAdverseTicks: 30, postExitAdverseFirst: false
  });

  const merged = r.combineTradeObjects([tp1, tp2]);

  // Hodnoty se berou z nohy s NEJPOZDĚJŠÍM časem výstupu – měří se, co cena
  // udělala po skutečném konci pozice, ne po částečném výstupu uprostřed.
  assert.equal(merged.postExitFavorableTicks, 8);
  assert.equal(merged.postExitAdverseTicks, 30);
  assert.equal(merged.postExitAdverseFirst, false);
  assert.equal(merged.slPrice, 7697, 'cena SL se u sloučeného obchodu nesmí ztratit');
  // Dopočty se po sloučení počítají znovu z hodnot sloučeného obchodu.
  assert.equal(merged.slTicks, 12);
  assert.equal(merged.maxTicks, 32, 'od ceny poslední nohy (7706), ne od váženého průměru');
  assert.equal(merged.maxAdverseTicks, 6);
  assert.equal(merged.touchedEntry, true);
  assert.equal(merged.touchedSl, false);
});

test('sloučení: vyplněná noha se neztratí, i když ta nejpozdější vyplněná není', () => {
  const r = renderer();
  const tp1 = specTrade({ exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1 });
  const tp2 = specTrade({
    exitTime: '16:09', exitPrice: 7706, points: 6, contracts: 1,
    postExitFavorableTicks: undefined, postExitAdverseTicks: undefined, postExitAdverseFirst: undefined
  });

  const merged = r.combineTradeObjects([tp1, tp2]);
  assert.equal(merged.postExitFavorableTicks, 8);
  assert.equal(merged.postExitAdverseTicks, 30);
});

test('sloučení: nevyplněná pole nevzniknou jako prázdné hodnoty', () => {
  const r = renderer();
  const blank = { postExitFavorableTicks: undefined, postExitAdverseTicks: undefined, postExitAdverseFirst: undefined };
  const merged = r.combineTradeObjects([
    specTrade({ exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, ...blank }),
    specTrade({ exitTime: '16:09', exitPrice: 7706, points: 6, contracts: 1, ...blank })
  ]);
  assert.equal(merged.postExitFavorableTicks, undefined);
  assert.equal(merged.postExitAdverseTicks, undefined);
  assert.equal(merged.postExitAdverseFirst, undefined);
  assert.equal(merged.maxTicks, undefined, 'bez zadaných ticků není co dopočítat');
  assert.equal(merged.slTicks, 12, 'riziko se počítá z ceny SL, ta zadané ticky nepotřebuje');
});

test('u nenaplněného setupu se hodnoty neukládají', () => {
  const r = renderer();
  // Ukládání čte formulář, takže se tu testuje aspoň rozhodovací pravidlo,
  // podle kterého se hodnoty do obchodu vůbec dostanou.
  assert.equal(r.postExitApplies('FILLED'), true);
  assert.equal(r.postExitApplies(''), true, 'ručně zadaný obchod stav naplnění běžně nemá');
  assert.equal(r.postExitApplies(undefined), true);
  for (const status of ['NO_FILL', 'MISSED', 'SKIPPED']) {
    assert.equal(r.postExitApplies(status), false, status + ' nemá výstup, od kterého by se měřilo');
  }
});

test('nová pole jsou v popisu kontextu, takže je sloučení bere jako celek', () => {
  const byKey = Object.fromEntries(FJTaxonomy.TRADE_CONTEXT_FIELDS.map(f => [f.key, f]));
  assert.equal(byKey.postExitFavorableTicks.cardinality, 'number');
  assert.equal(byKey.postExitAdverseTicks.cardinality, 'number');
  assert.equal(byKey.postExitAdverseFirst.cardinality, 'bool');
  for (const key of ['postExitFavorableTicks', 'postExitAdverseTicks', 'postExitAdverseFirst']) {
    assert.equal(byKey[key].merge, 'lastExit', key + ' se bere z nohy s nejpozdějším výstupem');
  }
});

test('oba CSV exporty mají nová pole včetně dopočtených', () => {
  const r = renderer();
  const trade = r.applyPostExitFields(specTrade({ journalName: 'Hlavní', journalId: 'j1' }));

  for (const [header, row, label] of [
    [r.tradeCsvHeader(), r.tradeCsvRow(trade, null), 'export deníku'],
    [r.reportCsvHeader(), r.reportCsvRow(trade, null), 'export reportů']
  ]) {
    assert.equal(header.length, row.length, label + ': hlavička a řádek se rozešly o sloupec');
    const rec = Object.fromEntries(header.map((name, i) => [name, row[i]]));
    assert.equal(rec['Pokračování po výstupu (ticky)'], 8, label);
    assert.equal(rec['Protipohyb po výstupu (ticky)'], 30, label);
    assert.equal(rec['Protipohyb dřív'], 'ne', label);
    assert.equal(rec['SL (ticky)'], 12, label);
    assert.equal(rec['Max ve směru (ticky)'], 32, label);
    assert.equal(rec['Max proti (ticky)'], 6, label);
    assert.equal(rec['Zpět na vstup'], 'ano', label);
    assert.equal(rec['Až na SL'], 'ne', label);
    // Sloupce, které tu byly předtím, musí sedět dál – nové se vkládaly
    // doprostřed řádku, takže posun by se projevil právě tady.
    assert.equal(rec['Cena SL'], 7697, label);
    assert.equal(rec['Stav naplnění'], 'FILLED', label);
    assert.equal(rec['Komise'], 3.8, label);
  }
});

test('AI export si nová pole nese s sebou', () => {
  // `stripImages` je jediné síto mezi deníkem a AI exportem. Nemá bílou listinu
  // polí (roztahuje zbytek obchodu), takže tenhle test hlídá, aby ji někdo
  // nezavedl – nová pole by z exportu zmizela a nikdo by si toho nevšiml.
  const main = loadMain(['stripImages']);
  const r = renderer();
  const exported = main.stripImages(r.applyPostExitFields(specTrade({ images: ['fjimg://a'] })));
  assert.equal(exported.postExitFavorableTicks, 8);
  assert.equal(exported.postExitAdverseTicks, 30);
  assert.equal(exported.postExitAdverseFirst, false);
  assert.equal(exported.slTicks, 12);
  assert.equal(exported.maxTicks, 32);
  assert.equal(exported.maxAdverseTicks, 6);
  assert.equal(exported.touchedEntry, true);
  assert.equal(exported.touchedSl, false);
  assert.equal(exported.imageCount, 1, 'obrázky se pořád nahrazují počtem');
});

// Nejmenší DOM, na kterém formulářová obsluha projde: každý dotaz na prvek
// vrátí uzel, který si pamatuje zapsanou hodnotu. Test tím hlídá i to, že se
// id polí v HTML a ve skriptu nerozešla – překlep v id by jinak vyšel najevo
// až v aplikaci, kde by se dopočty prostě nezobrazily.
function formStub(values) {
  const nodes = new Map();
  const node = id => ({ id, value: values[id] ?? '', textContent: '', innerHTML: '', style: {} });
  return {
    nodes,
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, node(id));
        return nodes.get(id);
      }
    }
  };
}

function postExitForm(values) {
  const dom = formStub(values);
  const r = loadRenderer([
    '$', 'esc', 'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument',
    'BUILTIN_TICK_SIZES', 'deriveStopLossPrice', 'postExitTicksWarning', 'postExitApplies',
    'postExitDraftFromForm', 'formatTicks', 'renderPostExitHints'
  ], { document: dom.document, settings: SETTINGS });
  r.renderPostExitHints();
  return dom.nodes;
}

test('formulář: blok se skrývá jen u výslovně nenaplněného setupu', () => {
  const filled = postExitForm({ fillStatus: 'FILLED', instrument: 'MES' });
  assert.equal(filled.get('postExitBlock').style.display, '', 'naplněný obchod pole vidí');

  // Ručně zadaný obchod má stav naplnění běžně prázdný. Kdyby se před ním pole
  // schovala, uživatel by se k nim nedostal, aniž by tušil proč.
  const blank = postExitForm({ fillStatus: '', instrument: 'MES' });
  assert.equal(blank.get('postExitBlock').style.display, '', 'nevyplněný stav se bere jako naplněný');

  for (const status of ['NO_FILL', 'MISSED', 'SKIPPED']) {
    const notFilled = postExitForm({ fillStatus: status, instrument: 'MES' });
    assert.equal(notFilled.get('postExitBlock').style.display, 'none', status + ': není co měřit');
  }
});

test('formulář: dopočty i varování se ukazují u polí', () => {
  const nodes = postExitForm({
    fillStatus: 'FILLED', instrument: 'MES', side: 'long', result: 'target',
    entryPrice: '7700', exitPrice: '7706', slPrice: '7697',
    postExitFavorableTicks: '8', postExitAdverseTicks: '30'
  });
  const hint = nodes.get('postExitDerivedHint').innerHTML;
  assert.match(hint, /SL: 12 t/);
  assert.match(hint, /max ve směru: 32 t/);
  assert.match(hint, /max proti: 6 t/);
  assert.match(hint, /zpět na vstup: ano/);
  assert.match(hint, /až na SL: ne/);
  assert.equal(nodes.get('postExitFavorableHint').textContent, '', 'kladná hodnota nevaruje');

  const warned = postExitForm({
    fillStatus: 'FILLED', instrument: 'MES', side: 'long', entryPrice: '7700',
    exitPrice: '7706', postExitFavorableTicks: '-8'
  });
  assert.equal(warned.get('postExitFavorableHint').textContent, 'Zadávej kladně, směr určuje pole.');
});

test('formulář: u neznámého instrumentu místo dopočtů řekne proč', () => {
  const nodes = postExitForm({ fillStatus: 'FILLED', instrument: 'FDXS', side: 'long' });
  assert.match(nodes.get('postExitDerivedHint').innerHTML, /Velikost ticku/);
});

test('CSV: nevyplněné pole zůstane prázdné, nevypíše se nula', () => {
  const r = renderer();
  const bare = r.applyPostExitFields(specTrade({
    postExitFavorableTicks: undefined, postExitAdverseTicks: undefined,
    postExitAdverseFirst: undefined, slPrice: undefined, result: 'target'
  }));
  const header = r.tradeCsvHeader();
  const row = r.tradeCsvRow(bare, null);
  const rec = Object.fromEntries(header.map((name, i) => [name, row[i]]));
  for (const col of ['Pokračování po výstupu (ticky)', 'Protipohyb po výstupu (ticky)', 'Protipohyb dřív',
    'SL (ticky)', 'Max ve směru (ticky)', 'Max proti (ticky)', 'Zpět na vstup', 'Až na SL']) {
    assert.equal(rec[col], '', col + ' má zůstat prázdný');
  }
});
