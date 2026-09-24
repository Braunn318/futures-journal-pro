'use strict';
// Smoke testy vykreslování Nastavení → Číselníky.
//
// PROČ EXISTUJÍ: do 4.6.2 se tahle část nespouštěla v žádném testu, a tak se
// do vydaného buildu dostala chyba „Cannot access 'sourceLabel' before
// initialization" – proměnná byla deklarovaná až ZA kódem, který ji používal.
// Aplikace kvůli tomu nešla vůbec otevřít, protože renderTaxonomyEditor běží
// z fillSettings() při načtení deníku a výjimka probublala až do
// startJournalApplication.
//
// Logiku číselníků testují jiné soubory; tady jde o to, že se ty funkce dají
// spustit a vyrobí očekávaný kus HTML. Na chybu tohohle druhu (překlep, TDZ,
// odkaz na neexistující funkci) stačí, když render vůbec proběhne.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

// Nejmenší DOM, na kterém render projde: prvky si pamatují, co do nich kdo
// zapsal, a dotazy na potomky vracejí prázdno (obsluha tlačítek se nevěší).
function makeDom(ids) {
  const nodes = {};
  for (const id of ids) {
    nodes[id] = {
      id, innerHTML: '', textContent: '', value: '', disabled: false,
      querySelectorAll: () => [],
      querySelector: () => null,
      closest: () => null,
      classList: { add() {}, remove() {}, contains: () => false }
    };
  }
  return {
    nodes,
    document: {
      getElementById: id => nodes[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null
    }
  };
}

const SETTINGS = {
  templates: [],
  breakEvenEnabled: false,
  breakEvenThreshold: 0,
  taxonomy: {}
};

function renderEditor(taxonomy) {
  const dom = makeDom(['taxonomyGroups', 'taxonomyCopyTarget', 'taxonomyCopyBtn', 'taxonomyTransferNote']);
  FJTaxonomy.applyConfig(taxonomy || {});
  const r = loadRenderer(
    ['$', 'esc', 'wireTaxonomyEditor', 'renderTaxonomyEditor', 'renderTaxonomyTransfer'],
    {
      document: dom.document,
      settings: { ...SETTINGS, taxonomy: taxonomy || {} },
      journalProfiles: [{ id: 'j1', name: 'Phidias 1' }, { id: 'j2', name: 'Backtest' }],
      activeJournalId: 'j1',
      showToast() {},
      CSS: { escape: v => v }
    }
  );
  return { r, dom };
}

test.afterEach(() => FJTaxonomy.applyConfig({}));

test('editor číselníků se vykreslí a nespadne', () => {
  const { r, dom } = renderEditor();
  r.renderTaxonomyEditor();
  const html = dom.nodes.taxonomyGroups.innerHTML;

  assert.ok(html.length > 100, 'editor vyrobil HTML');
  // Každá skupina má svou sekci.
  for (const group of FJTaxonomy.GROUPS) {
    assert.ok(html.includes(group.label), `chybí sekce ${group.label}`);
  }
  // Ovládání, na kterém stojí požadavky: přejmenovat, skrýt, přeuspořádat,
  // přidat. Mazání tam být nesmí.
  assert.match(html, /class="tax-label"/);
  assert.match(html, /tax-toggle/);
  assert.match(html, /tax-up/);
  assert.match(html, /tax-down/);
  assert.match(html, /tax-add/);
  assert.ok(!/tax-delete|Smazat/.test(html), 'volba se nemaže, jen skrývá');
});

test('odvozená skupina má popisky jen ke čtení a poznámku o sdíleném seznamu', () => {
  const { r, dom } = renderEditor();
  r.renderTaxonomyEditor();
  const html = dom.nodes.taxonomyGroups.innerHTML;

  // Sekce SR proti targetu musí říct, kde se seznam edituje…
  assert.ok(html.includes('Používá stejný seznam voleb jako'), 'chybí poznámka o sdíleném seznamu');
  assert.match(html, /readonly/, 'popisek u odvozené skupiny je jen ke čtení');
  // …a nesmí u ní být pole pro přidání volby (přidává se u zdrojové skupiny).
  const srSection = html.slice(html.indexOf('SR proti targetu'), html.indexOf('SR proti S/L'));
  assert.ok(!srSection.includes('tax-add'), 'odvozená skupina nemá vlastní přidávání');
});

test('skrytá i vlastní volba se v editoru objeví', () => {
  const custom = FJTaxonomy.makeCustomKey('ENTRY_LEVEL', 'Týdenní open');
  const { r, dom } = renderEditor({
    ENTRY_LEVEL: { hidden: ['VWAP'], custom: { [custom]: 'Týdenní open' } }
  });
  r.renderTaxonomyEditor();
  const html = dom.nodes.taxonomyGroups.innerHTML;

  assert.ok(html.includes(custom), 'vlastní volba má v editoru řádek');
  assert.ok(html.includes('Týdenní open'));
  assert.match(html, /hidden-option/, 'skrytá volba je odlišená');
  assert.ok(html.includes('Zobrazit'), 'u skryté volby je tlačítko na vrácení');
});

test('aliasovaná volba je v editoru označená, do čeho je sloučená', () => {
  const { r, dom } = renderEditor();
  r.renderTaxonomyEditor();
  const html = dom.nodes.taxonomyGroups.innerHTML;
  assert.ok(html.includes('MEGA_BID'), 'aliasovaný klíč se pořád zobrazuje');
  assert.ok(html.includes('sloučeno do'), 'a je u něj vidět, kam se počítá');
});

test('přenos číselníků: nabídne ostatní karty a popíše, co se přenáší', () => {
  const { r, dom } = renderEditor({ ENTRY_LEVEL: { labels: { VWAP: 'VWAP (15m)' }, hidden: ['VAH'] } });
  r.renderTaxonomyTransfer();

  assert.ok(dom.nodes.taxonomyCopyTarget.innerHTML.includes('Backtest'), 'nabídne druhou kartu');
  assert.ok(!dom.nodes.taxonomyCopyTarget.innerHTML.includes('Phidias 1'), 'aktivní kartu nenabízí');
  assert.equal(dom.nodes.taxonomyCopyBtn.disabled, false);
  assert.match(dom.nodes.taxonomyTransferNote.innerHTML, /1× přejmenováno/);
  assert.match(dom.nodes.taxonomyTransferNote.innerHTML, /1× skryto/);
});

test('přenos číselníků: bez další karty se kopie nenabízí', () => {
  const dom = makeDom(['taxonomyGroups', 'taxonomyCopyTarget', 'taxonomyCopyBtn', 'taxonomyTransferNote']);
  FJTaxonomy.applyConfig({});
  const r = loadRenderer(['$', 'esc', 'renderTaxonomyTransfer'], {
    document: dom.document,
    settings: { ...SETTINGS },
    journalProfiles: [{ id: 'j1', name: 'Phidias 1' }],
    activeJournalId: 'j1'
  });

  r.renderTaxonomyTransfer();

  assert.equal(dom.nodes.taxonomyCopyBtn.disabled, true);
  assert.equal(dom.nodes.taxonomyCopyTarget.disabled, true);
  assert.match(dom.nodes.taxonomyTransferNote.innerHTML, /výchozí číselníky/, 'a řekne, že není co přenášet');
});

test('dlaždice kontextových polí se vykreslí, včetně single-selectu', () => {
  const dom = makeDom(['trend', 'entryLevels', 'srTarget', 'srStopLoss', 'ofConfirm', 'setupCode', 'fillStatus', 'confluenceHint']);
  FJTaxonomy.applyConfig({});
  const r = loadRenderer(
    ['$', 'esc', 'fillContextSelect', 'renderChipGrid', 'readChipGrid', 'renderSingleChipGrid', 'readSingleChipGrid', 'updateConfluenceHint'],
    { document: dom.document, settings: { ...SETTINGS } }
  );

  r.renderSingleChipGrid('trend', 'TREND', 'LONG');
  r.renderChipGrid('entryLevels', 'ENTRY_LEVEL', ['VWAP']);
  r.renderChipGrid('srTarget', 'SR_TARGET', ['VAH']);
  r.renderChipGrid('srStopLoss', 'SR_SL', []);
  r.fillContextSelect('setupCode', 'SETUP', '— nevyplněno —');

  assert.match(dom.nodes.trend.innerHTML, /data-key="LONG"/);
  assert.match(dom.nodes.trend.innerHTML, /chip on/, 'vybraná hodnota je zvýrazněná');
  assert.ok(!dom.nodes.trend.innerHTML.includes('data-key="VWAP"'), 'trend nabízí jen své tři stavy');
  assert.match(dom.nodes.entryLevels.innerHTML, /data-key="VWAP"/);
  assert.match(dom.nodes.srTarget.innerHTML, /data-key="VAH"/);
  assert.ok(dom.nodes.srStopLoss.innerHTML.includes('data-key="LIQUIDITY"'), 'SR proti S/L nabízí tytéž hladiny');
  assert.match(dom.nodes.setupCode.innerHTML, /nevyplněno/);
  // Aliasovaná hladina se u nového obchodu nenabízí.
  assert.ok(!dom.nodes.entryLevels.innerHTML.includes('data-key="VPOC_CANDLE"'));
});

test('obchod se skrytou hodnotou ji v dlaždicích pořád vidí', () => {
  const dom = makeDom(['entryLevels']);
  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { hidden: ['VWAP'] } });
  const r = loadRenderer(['$', 'esc', 'renderChipGrid'], {
    document: dom.document,
    settings: { ...SETTINGS }
  });

  r.renderChipGrid('entryLevels', 'ENTRY_LEVEL', ['VWAP']);
  assert.match(dom.nodes.entryLevels.innerHTML, /data-key="VWAP"/,
    'skrytá hodnota, kterou obchod má, musí zůstat v nabídce – jinak by ji editace zahodila');

  r.renderChipGrid('entryLevels', 'ENTRY_LEVEL', []);
  assert.ok(!dom.nodes.entryLevels.innerHTML.includes('data-key="VWAP"'),
    'novému obchodu se ale nenabízí');
});
