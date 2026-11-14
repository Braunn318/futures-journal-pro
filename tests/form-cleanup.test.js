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
const FJTradeMap = require('../app/trade-map.js');

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
    'postExitFields', 'applyPostExitFields', 'postExitApplies', 'getDefaultCommissionForInstrument',
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

// Od 4.7.1 je formulář rozdělený do sbalitelných karet (SL / TP, Pohyb ceny,
// Setup, Komentáře); základ obchodu zůstává vždy vidět.
const sectionOf = card => {
  const start = HTML.indexOf(`<details class="trade-section" data-card="${card}">`);
  assert.ok(start > 0, `karta ${card} ve formuláři chybí`);
  return HTML.slice(start, HTML.indexOf('</details>', start));
};

test('formulář: pole jsou ve správných kartách', () => {
  const expected = {
    // Cena targetu patří k ceně SL: tady se plánovaný cíl ručně přepisuje
    // (obchod zavřený ručně mimo plán). Přesun do Hladin byl chyba (13. 10.).
    sltp: ['slPrice', 'targetLevel1Price', 'targetLevel2Price'],
    course: ['mfeTicks', 'maeTicks', 'observedMinutes', 'postExitFavorableTicks', 'postExitAdverseTicks', 'postExitAdverseFirst'],
    // Kontext v3 (A5): kolikátý test vstupu patří k setupu.
    setup: ['setupCode', 'fillStatus', 'missedByTicks', 'trend', 'trendHtf', 'grade', 'entryTestNo', 'planFollowed', 'wouldSkipLive'],
    // Od 4.7.2 samostatná karta Hladiny (jde skrýt a hlídat zvlášť). Od 4.8.5
    // jeden seznam „Hladiny v blízkosti"; z cíle je tu jen typ.
    levels: ['entryLevels', 'nearLevels', 'nearLevelsNone', 'ofConfirm', 'absLocation', 'targetLevel1Types',
      'targetLevel2Types', 'contextDerived', 'levelsSummary'],
    comments: ['tradePlanSetup', 'tradePlanPsychology', 'tradePlanNote', 'comment', 'screenshots']
  };
  for (const [card, ids] of Object.entries(expected)) {
    const inside = sectionOf(card);
    for (const id of ids) assert.ok(inside.includes(`id="${id}"`), `${id} patří do karty ${card}`);
  }
  for (const id of ['targetLevel1Price', 'targetLevel2Price']) {
    assert.ok(!sectionOf('levels').includes(`id="${id}"`), id + ' nesmí být v kartě Hladiny');
  }
  // Základ (ceny, zisk, další cíle) se nesbaluje.
  const firstCard = HTML.indexOf('<details class="trade-section"');
  for (const id of ['entryPrice', 'exitPrice', 'pnl', 'contracts', 'extraLegsList']) {
    assert.ok(HTML.indexOf(`id="${id}"`) < firstCard, `${id} je v základu nad kartami`);
  }
  assert.ok(!HTML.includes('id="strategy"'), 'pole Strategie z formuláře zmizelo');
});

// Mřížka dlaždic pro `readChipGrid`: uzel s vybranými klíči.
// Hladiny v blízkosti jsou řádky (typ + cena + test / netest) pro
// `readLevelRows`; v zadání testu stačí klíč, nebo celý řádek.
function chipDom(selection) {
  const node = keys => ({
    querySelectorAll: () => keys.map(key => ({ dataset: { key } }))
  });
  const srNode = rows => ({
    querySelector: () => null,
    querySelectorAll: () => rows.map(r => (typeof r === 'string' ? { level: r } : r)).map(r => ({
      dataset: {},
      querySelector: sel => ({
        '.sr-level': { value: r.level },
        '.sr-price': { value: r.price ?? '' },
        '.sr-test': { value: r.testState ?? '' }
      })[sel]
    }))
  });
  const nodes = {
    entryLevels: node(selection.entryLevels || []),
    nearLevels: srNode(selection.nearLevels || []),
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
  const r = loadRenderer(['$', 'readChipGrid', 'NEAR_LEVELS_ID', 'rowFromElement', 'readLevelRows', 'contextFieldShown', 'formatLevelRow', 'LEVEL_FIELDS',
    'syncNearNoneControls', 'readNearNone', 'updateLevelsSummary'],
    { document: dom.document, FJTaxonomy });
  r.updateLevelsSummary();
  return dom.nodes.levelsSummary.textContent;
}

test('sbalená položka ukazuje, co je vybrané – sbalení nic neschová', () => {
  // Pořadí je pořadí číselníku, ne pořadí klikání – `readChipGrid` hodnoty
  // očišťuje přes `sanitizeMulti`, která je řadí stabilně.
  const summary = summaryOf({ entryLevels: ['VWAP', 'VAH'], nearLevels: ['VAL'] });
  assert.match(summary, /Vstup: VAH \+ VWAP/);
  assert.match(summary, /Hladiny: VAL/);
  assert.doesNotMatch(summary, /OF:/, 'nevyplněná kolonka se v hlavičce nepřipomíná');
});

test('shrnutí u hladiny v blízkosti ukáže cenu a test / netest', () => {
  const summary = summaryOf({
    nearLevels: [{ level: 'VAH', price: 7712.5, testState: 'UNTESTED' }, { level: 'VWAP' }]
  });
  assert.match(summary, /Hladiny: VAH @ 7712\.5 \(netest\), VWAP/);
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

// --- Sbalené hladiny na kartě obchodu (zadání z 2026-09-25, druhé kolo) -----
//
// V Deníku byly hladiny rozepsané jako sloupec pilulek u každé karty, takže
// den se třemi obchody byl zase dlouhý. Sbalují se stejně jako ve formuláři:
// Setup, Trend a stav naplnění zůstávají vidět, hladiny a order flow jdou pod
// rozklikávací položku.

// `view` = Nastavení → Hladiny → Zobrazení (FJ_levelsView); bez něj výchozí
// stav, tedy souhrnný řádek vypnutý.
function pills(view) {
  return loadRenderer(['esc', 'formatLevelRow', 'contextPillsHTML', 'levelPillsHTML', 'targetTypesLabel', 'openTradeLevels', 'tradeLevelsBlockHTML',
    'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'contextFieldShown', 'levelsSummaryOn'],
    { FJTaxonomy, FJTradeMap, settings: { templates: [] }, levelsView: FJTradeMap.normalizeLevelsView(view) });
}

function contextTrade(overrides) {
  return {
    id: 'card-1', setupCode: 'M2_OF', trend: 'LONG', fillStatus: 'FILLED',
    entryLevels: ['VPOC_IB'], nearLevels: [{ level: 'VPOC_1M', price: 7712.5 }, { level: 'VWAP', price: 7698 }],
    ofConfirm: ['CLOSE_VS_VPOC_OK'],
    ...overrides
  };
}

test('na kartě zůstává vidět Setup a Trend, hladiny se sbalují', () => {
  const r = pills();
  const visible = r.contextPillsHTML(contextTrade());
  assert.match(visible, /M2 \+ Order Flow/, 'Setup zůstává vidět');
  assert.match(visible, /Long/, 'Trend zůstává vidět');
  for (const hidden of ['VPOC IB', 'Hladiny:', 'OF:']) {
    assert.ok(!visible.includes(hidden), hidden + ' patří do sbalené části');
  }
  // Stav naplnění se pořád ukazuje jen tehdy, když obchod naplněný NENÍ.
  assert.ok(!r.contextPillsHTML(contextTrade()).includes('naplněno'));
  assert.match(r.contextPillsHTML(contextTrade({ fillStatus: 'NO_FILL' })), /limitka se nenaplnila/);
});

// Mapa obchodu (4.8.103, ZADANI_DENIK_MAPA_OBCHODU §3): plný výpis hladin
// v blízkosti je jen v detailu obchodu (karta Hladiny). Na kartě obchodu nic,
// nebo jeden souhrnný řádek – ve výchozím stavu vypnutý.
test('sbalená část nese hladinu vstupu a order flow; hladiny v blízkosti se tu nevypisují', () => {
  const { html, count } = pills().levelPillsHTML(contextTrade());
  assert.equal(count, 2, 'hladina vstupu a order flow');
  assert.match(html, /VPOC IB/, 'popisky z číselníku, ne uložené klíče');
  assert.doesNotMatch(html, /Hladiny:/, 'výpis hladin mimo detail obchodu neexistuje');
  assert.doesNotMatch(html, /VPOC 1M|7712\.5/);
  assert.match(html, /OF: Uzavření vůči VPOC v pořádku/);
  assert.doesNotMatch(html, /SR→/, 'dvě kolonky SR už nejsou');
});

const geoTrade = () => contextTrade({
  instrument: 'MES', side: 'long', entryPrice: 7700, slPrice: 7696, targetLevel1: { type: 'VAH', price: 7720 },
  nearLevels: [{ level: 'VAH', price: 7712.5, testState: 'UNTESTED' }, { level: 'VAL', price: 7699 }]
});

test('karta obchodu: řádek dopočtů bez hladin, souhrnný řádek jen zapnutý – bez štítku role', () => {
  const off = pills().levelPillsHTML(geoTrade()).html;
  assert.doesNotMatch(off, /Hladiny:|Nejbližší hladina|SL 12 t za|mezi SL a vstupem/, 've výchozím stavu o hladinách nic');
  const on = pills({ summaryLine: true }).levelPillsHTML(geoTrade());
  assert.match(on.html, /Hladiny: 1 mezi SL a vstupem · 1 před cílem</);
  assert.doesNotMatch(on.html, /7712\.5|VAL @|od vstupu/, 'jen počty, žádný výpis (cíl má vlastní pilulku)');
  assert.equal(on.count, 4, 'hladina vstupu, souhrnný řádek, cíl 1 a OF');
  assert.equal(pills().levelPillsHTML(geoTrade()).count, 3, 'bez souhrnného řádku o jednu méně');
  assert.doesNotMatch(on.html, /v cestě|chrání|překážk/i, 'deník hladinám nepřisuzuje roli');
});

test('souhrnný řádek přečte i starý tvar (dva seznamy SR) – stejným převodem jako migrace', () => {
  const old = contextTrade({ srTarget: [{ level: 'VAH', price: 7712.5, ticksFromEntry: 10 }], srStopLoss: ['VWAP'] });
  delete old.nearLevels;
  assert.doesNotMatch(pills().levelPillsHTML(old).html, /Hladiny:/);
  // Bez vstupu a směru nejde polohu určit – neříká se „0".
  assert.match(pills({ summaryLine: true }).levelPillsHTML(old).html, /Hladiny: 0 mezi SL a vstupem · 0 před cílem · 2 bez polohy/);
  assert.match(pills({ summaryLine: true }).levelPillsHTML({ ...contextTrade(), nearLevels: [], nearLevelsNone: true }).html, /Hladiny: žádná v blízkosti/);
});

test('obchod bez hladin sbalitelnou položku nedostane', () => {
  const r = pills();
  const bare = { id: 'card-2', setupCode: 'M2_OF' };
  assert.equal(r.levelPillsHTML(bare).count, 0);
  assert.equal(r.tradeLevelsBlockHTML(bare), '', 'prázdná rozklikávací položka by jen mátla');
});

test('rozbalený stav se pamatuje podle id obchodu, ne v DOM', () => {
  // Seznam obchodů se překresluje celý (renderTrades), takže atribut `open`
  // na živém prvku by se ztratil při každém uložení obchodu nebo změně filtru.
  const r = pills();
  const closed = r.tradeLevelsBlockHTML(contextTrade());
  assert.match(closed, /data-levels="card-1"/);
  assert.match(closed, /ontoggle="rememberTradeLevels\('card-1',this\.open\)"/);
  assert.ok(!/<details[^>]* open/.test(closed), 've výchozím stavu sbaleno');

  r.openTradeLevels.add('card-1');
  assert.match(r.tradeLevelsBlockHTML(contextTrade()), /<details[^>]* open/, 'zapamatovaný obchod se vykreslí rozbalený');
});

test('hlavička sbalené položky říká, kolik pilulek skrývá', () => {
  assert.match(pills().tradeLevelsBlockHTML(contextTrade()), /Hladiny <span class="sub">\(2\)<\/span>/);
});

test('tlačítko dne nesmí zavřít celý den', () => {
  // Hlavička dne má vlastní onclick na rozbalení poznámek; bez zastavení
  // bubliny by tlačítko dělalo obojí a pozná se to až proklikem.
  const src = inlineScripts(HTML);
  assert.match(src, /class="btn day-levels-btn" onclick="event\.stopPropagation\(\);toggleDayLevels/);
  assert.match(src, /Sbalit hladiny/);
  assert.match(src, /Rozbalit hladiny/);
  // Tlačítko se vykresluje jen tam, kde je co rozbalovat.
  assert.match(src, /const withLevels=dayTrades\.filter\(t=>levelPillsHTML\(t,\{countOnly:true\}\)\.count\)/);
});

test('hlavička sbalené položky vypadá jako ovládací prvek, ne jako popisek', () => {
  // Původní verze byla šedý text velikosti popisku a uživatel ji ve formuláři
  // nenašel. Test drží to, co ji odlišuje: barva, tučnost a vlastní šipka.
  const css = HTML.slice(HTML.indexOf('.chip-collapse>summary{'), HTML.indexOf('.card-levels{'));
  assert.match(css, /color:var\(--blue\)/);
  assert.match(css, /font-weight:800/);
  assert.match(css, /\.chip-collapse\[open\]>summary \.chev\{transform:rotate\(90deg\)\}/, 'šipka se otáčí při rozbalení');
  assert.match(css, /::-webkit-details-marker\{display:none\}/, 'nativní značka se vypíná, ať nejsou šipky dvě');
  assert.ok(HTML.includes('<summary><svg class="chev"'), 'vlastní šipka je i v hlavičce ve formuláři');
});
