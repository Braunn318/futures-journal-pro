'use strict';
// Zjednodušení formuláře obchodu (zadání z 2026-09-25):
//   1. devět polí „Obchodní plán k tomuto obchodu" z formuláře pryč,
//   2. appka nedopisuje komentář, který uživatel nenapsal,
//   3. tři kolonky s hladinami sbalené do jedné položky „Hladiny".
//
// PROČ TESTOVAT NĚCO TAK MALÉHO: první dvě věci jsou odstranění a odstranění
// se snadno vrátí zpátky (stačí, aby někdo „doplnil chybějící pole"). Třetí
// stojí na tom, že se ve sbalené hlavičce ukáže, co je vybrané – bez toho by
// sbalení data schovalo.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer, inlineScripts, readRepoFile } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }],
  breakEvenEnabled: true,
  breakEvenThreshold: 5,
  useConnectorCommission: false,
  autoMergeLegs: true
};

const HTML = readRepoFile('app/index.html');

function leg(overrides) {
  return {
    id: 'fc-' + Math.random().toString(16).slice(2),
    instrument: 'MES', date: '2026-09-12', entryTime: '16:00', entryPrice: 7700,
    exitTime: '16:05', exitPrice: 7703, result: 'target', side: 'long',
    points: 3, contracts: 1, commission: 1.9, pnl: 13.1, pnlRaw: 13.1,
    positionId: 'pos-fc',
    ...overrides
  };
}

function merger() {
  return loadRenderer([
    'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
    'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'POST_EXIT_DERIVED_KEYS',
    'postExitFields', 'applyPostExitFields', 'getDefaultCommissionForInstrument',
    'classifyResult', 'signed', 'tradeTotalPoints', 'weightedExitFields', 'legFromTrade',
    'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'combineTradeObjects'
  ], { settings: SETTINGS, Date });
}

test('sloučení nedopisuje komentář, který uživatel nenapsal', () => {
  const merged = merger().combineTradeObjects([
    leg({ exitTime: '16:05', exitPrice: 7703 }),
    leg({ exitTime: '16:09', exitPrice: 7705, points: 5 })
  ]);
  assert.equal(merged.comment, '', 'prázdný komentář zůstane prázdný');
  // Dřív se sem doplňovalo „Sloučeno z N cílů stejné pozice (TP1/TP2/BE)." –
  // i u jediného cíle, takže Deník byl plný vět, které nikdo nenapsal.
  assert.doesNotMatch(inlineScripts(HTML), /Sloučeno z \$\{/, 'věta se do kódu nesmí vrátit');
  assert.doesNotMatch(inlineScripts(HTML), /Ručně zadáno s \$\{/, 'ani její protějšek u ručního zadání');
});

test('sloučení pořád spojí komentáře, které uživatel napsal', () => {
  const merged = merger().combineTradeObjects([
    leg({ exitTime: '16:05', exitPrice: 7703, comment: 'první cíl na VWAP' }),
    leg({ exitTime: '16:09', exitPrice: 7705, points: 5, comment: 'druhý až na VAH' })
  ]);
  assert.equal(merged.comment, 'první cíl na VWAP | druhý až na VAH');
});

test('formulář obchodu nemá plánovací pole, ale má setup, psychologii a komentář', () => {
  // Pryč je šest plánovacích polí, která zůstávala prázdná.
  for (const id of ['tradePlanInstrument', 'tradePlanMaxTrades', 'tradePlanLossLimit',
    'tradePlanProfitTarget', 'tradePlanFromTime', 'tradePlanToTime']) {
    assert.ok(!HTML.includes(id), 'pole ' + id + ' se do formuláře nesmí vrátit');
  }
  // Tyhle tři se naopak vypustit NESMÍ – vyplňují se u obchodu běžně a při
  // prvním úklidu formuláře zmizely omylem (2026-09-25).
  for (const id of ['tradePlanSetup', 'tradePlanPsychology', 'tradePlanNote']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'pole ' + id + ' ve formuláři chybí');
  }
  assert.match(HTML, /<label>Komentář k setupu/, 'poslední z nich se jmenuje „Komentář k setupu"');
  // Uložený plán staršího obchodu se zahazovat nesmí – karta obchodu ho dál
  // vypisuje a oba CSV exporty ho dál vyvážejí, včetně šesti zrušených polí.
  assert.match(HTML, /t\.dailyPlan\.instrument/, 'karta obchodu plán dál zobrazuje');
  assert.match(HTML, /'Plán: Instrument'/, 'CSV export plán dál vyváží');
  assert.match(HTML, /\.\.\.existingPlan/, 'zrušená pole se přebírají z původního obchodu');
});

test('hladiny jsou ve formuláři v jedné sbalitelné položce', () => {
  const block = HTML.slice(HTML.indexOf('<details class="field full chip-collapse" id="levelsBlock">'));
  const end = block.indexOf('</details>');
  assert.ok(end > 0, 'sbalitelná položka „Hladiny" ve formuláři chybí');
  const inside = block.slice(0, end);
  for (const id of ['entryLevels', 'srTarget', 'srStopLoss', 'ofConfirm']) {
    assert.ok(inside.includes('id="' + id + '"'), id + ' patří dovnitř položky Hladiny');
  }
  // Trend zůstává mimo – jsou to tři dlaždice, sbalovat je nemá co ušetřit.
  assert.ok(!inside.includes('id="trend"'));
});

// Mřížka dlaždic pro `readChipGrid`: uzel s vybranými klíči.
function chipDom(selection) {
  const node = keys => ({
    querySelectorAll: () => keys.map(key => ({ dataset: { key } }))
  });
  const nodes = {
    entryLevels: node(selection.entryLevels || []),
    srTarget: node(selection.srTarget || []),
    srStopLoss: node(selection.srStopLoss || []),
    ofConfirm: node(selection.ofConfirm || []),
    levelsSummary: { id: 'levelsSummary', textContent: '' }
  };
  return {
    nodes,
    document: { getElementById: id => nodes[id] || null }
  };
}

function summaryOf(selection) {
  const dom = chipDom(selection);
  const r = loadRenderer(['$', 'readChipGrid', 'LEVEL_FIELDS', 'updateLevelsSummary'],
    { document: dom.document, FJTaxonomy });
  r.updateLevelsSummary();
  return dom.nodes.levelsSummary.textContent;
}

test('sbalená položka ukazuje, co je vybrané – sbalení nic neschová', () => {
  // Pořadí je pořadí číselníku, ne pořadí klikání – `readChipGrid` hodnoty
  // očišťuje přes `sanitizeMulti`, která je řadí stabilně.
  const summary = summaryOf({ entryLevels: ['VWAP', 'VAH'], srTarget: ['VAL'] });
  assert.match(summary, /Vstup: VAH \+ VWAP/);
  assert.match(summary, /SR→TG: VAL/);
  assert.doesNotMatch(summary, /SR→SL/, 'nevyplněná kolonka se v hlavičce nepřipomíná');
});

test('sbalená položka u prázdného obchodu řekne, že je prázdná', () => {
  assert.equal(summaryOf({}), '— nevyplněno');
});

test('shrnutí bere popisky z číselníku, ne uložené klíče', () => {
  assert.match(summaryOf({ entryLevels: ['VPOC_DAY'] }), /Vstup: VPOC dne/);
});

test('shrnutí počítá i s order flow, které je ve stejné položce', () => {
  const summary = summaryOf({ entryLevels: ['VWAP'], ofConfirm: ['ABS_BID', 'IMBALANCE'] });
  assert.match(summary, /Vstup: VWAP/);
  assert.match(summary, /OF: Absorpce na bidu \+ Imbalance/);
});
