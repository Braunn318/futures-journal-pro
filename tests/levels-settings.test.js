'use strict';
// Nastavení → Přizpůsobení → Hladiny (docs/ZADANI_DENIK_MAPA_OBCHODU.md §3,
// testy 7 a 8): karta „LTA levely" a přepínače hladin ze snímku jsou jedna
// karta. Úložiště se nemění (lta-levels/settings.json, market-data/
// settings.json), takže staré volby se ukážou se stejnými hodnotami. Vše
// vypnuto = karta Hladiny jako před dávkou a hladiny se mimo detail obchodu
// nevypisují.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer, readRepoFile, inlineScripts } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');
const FJMarket = require('../app/market-data.js');
const FJSnapshot = require('../app/market-snapshot.js');
const FJTradeMap = require('../app/trade-map.js');

const HTML = readRepoFile('app/index.html');
const SRC = inlineScripts(HTML);

function el(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {},
    _cls: new Set(),
    classList: { toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, _s: new Set() },
    querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, appendChild() {}, contains: () => false
  };
}
function dom(ids) {
  const nodes = Object.fromEntries(ids.map(id => [id, el(id)]));
  return { nodes, document: { getElementById: id => nodes[id] || null, querySelectorAll: () => [], activeElement: null } };
}

// ------------------------------------------------------------- 7. převod

test('7 karta Hladiny: jedna karta, staré volby LTA i snímku pod stejnými ID', () => {
  const start = HTML.indexOf('<details class="card settings-card" data-card="levels" id="ltaSettingsCard">');
  assert.ok(start > 0, 'karta Hladiny v Přizpůsobení');
  const card = HTML.slice(start, HTML.indexOf('</details>', start));
  assert.match(card, /<h3>Hladiny<\/h3>/);
  for (const sub of ['Zobrazení', 'Z LTA souborů', 'Ze snímku trhu']) assert.ok(card.includes(`<h4 class="settings-sub">${sub}</h4>`), sub);
  // LTA: všechna dosavadní pole beze změny ID (renderLtaSettings je plní dál).
  for (const id of ['ltaEnabled', 'ltaAutoInForm', 'ltaVwapRow', 'ltaArchive', 'ltaNearestCount', 'ltaRetentionDays', 'ltaFiles', 'ltaExcludePatterns'])
    assert.ok(card.includes(`id="${id}"`), id);
  // Snímek: N a typy jsou teď tady (a jen tady).
  for (const id of ['levelsSnapshotOn', 'marketLevelsN', 'marketLevelTypes']) assert.ok(card.includes(`id="${id}"`), id);
  assert.equal(HTML.split('id="marketLevelsN"').length, 2, 'N ze snímku jen jednou');
  assert.equal(HTML.split('id="marketLevelTypes"').length, 2);
  for (const id of ['levelsViewMap', 'levelsViewBars', 'levelsViewSummary']) assert.ok(card.includes(`id="${id}"`), id);
  assert.ok(!HTML.includes('data-card="ltaLevels"'), 'stará karta už není');
});

test('7 oddíl Ze snímku trhu ukáže uložené N, vypnuté typy a zapnutí stejně jako dřív', async () => {
  const d = dom(['levelsSnapshotSection', 'levelsSnapshotOn', 'levelsSnapshotOnLabel', 'levelsSnapshotWhy', 'marketLevelsN', 'marketLevelTypes']);
  const saved = FJMarket.cleanMarketSettings({ enabled: true, configured: true, features: { snapshot: true, snapshotLevels: true }, levelsN: 5, levelTypes: { DAY_VAH: false } });
  const r = loadRenderer(['$', 'esc', 'renderLevelsSnapshotSection'], {
    document: d.document, window: {}, FJMarket, FJSnapshot, marketSettings: async () => saved
  });
  await r.renderLevelsSnapshotSection(saved);
  assert.equal(d.nodes.marketLevelsN.value, 5);
  assert.equal(d.nodes.levelsSnapshotOn.checked, true);
  assert.equal(d.nodes.levelsSnapshotOn.disabled, false);
  const html = d.nodes.marketLevelTypes.innerHTML;
  assert.match(html, /data-key="DAY_VAH">/, 'vypnutý typ zůstal vypnutý');
  assert.match(html, /data-key="DAY_VPOC" checked>/);
  assert.match(html, /data-key="VPOC_30M_CURRENT" checked> VPOC 30M aktuální/, 'nový typ je zapnutý (ukládají se jen vypnuté)');
  assert.match(html, /konektor NT8 verze 9/);
  // Bez Dat trhu zešedne s důvodem; uložená hodnota se nemění.
  const off = FJMarket.cleanMarketSettings({ ...saved, enabled: false });
  await r.renderLevelsSnapshotSection(off);
  assert.equal(d.nodes.levelsSnapshotOn.disabled, true);
  assert.match(d.nodes.levelsSnapshotWhy.innerHTML, /Zapni Data trhu/);
  assert.equal(off.levelsN, 5);
});

test('7 rozbalená karta „LTA levely" zůstane rozbalená jako „Hladiny"', () => {
  const { migrateOpenSettingsCards } = loadRenderer(['migrateOpenSettingsCards']);
  assert.deepEqual([...migrateOpenSettingsCards(['theme', 'ltaLevels', 'marketData'])], ['theme', 'levels', 'marketData']);
  assert.deepEqual([...migrateOpenSettingsCards(['ltaLevels', 'levels'])], ['levels']);
  assert.deepEqual([...migrateOpenSettingsCards(null)], []);
});

test('7 Data trhu: doplňování řádků ze snímku se zapíná v kartě Hladiny, ne dvakrát', () => {
  assert.match(SRC, /const LEVELS_CARD_FEATURES=\['snapshotLevels'\];/);
  assert.match(SRC, /FJMarket\.FEATURES\.filter\(f=>f\.ready&&!LEVELS_CARD_FEATURES\.includes\(f\.key\)\)/);
  assert.match(SRC, /saveMarketSettings\(\{features:\{snapshotLevels:\$\('levelsSnapshotOn'\)\.checked\}\}\)/, 'stejný klíč, stejné úložiště');
});

// ------------------------------------------------------- 8. vše vypnuto

test('8 mapa vypnutá: graf se nekreslí, seznam je rozbalený bez hlavičky, svíčky v kartě Setup', () => {
  const d = dom(['tradeMapBox', 'nearLevelsList', 'nearLevels', 'signalBarField', 'signalBarInfo', 'tradeMapSignal', 'signalBarPreview', 'contextDerived']);
  const calls = [];
  const r = loadRenderer(['$', 'levelsMapOn', 'renderTradeMap', 'applyLevelsView', 'setLevelListOpen', 'sortLevelList'], {
    document: d.document, levelsView: FJTradeMap.normalizeLevelsView({ map: false }),
    renderSignalBar: () => calls.push('signalBar'), renderContextDerived: () => calls.push('derived'),
    applyLevelFilter: () => calls.push('filter'), NEAR_LEVELS_ID: 'nearLevels'
  });
  d.nodes.tradeMapBox.style.display = '';
  r.applyLevelsView(true);
  assert.equal(d.nodes.tradeMapBox.style.display, 'none', 'žádný graf');
  assert.equal(d.nodes.nearLevelsList.classList.contains('sr-list-plain'), true, 'bez hlavičky „Seznam hladin"');
  assert.equal(d.nodes.nearLevelsList.classList.contains('open'), true, 'seznam rozbalený jako dřív');
  assert.equal(d.nodes.nearLevels.classList.contains('map-on'), false, 'řádky bez sloupce zdroje');
  assert.deepEqual(calls.filter(c => c !== 'filter'), ['signalBar', 'derived']);
});

test('8 mapa vypnutá: náhled svíček a dopočty v kartě Setup / Hladiny jako před dávkou', () => {
  // renderSignalBar s vypnutou mapou kreslí do #signalBarPreview a #signalBarInfo,
  // renderContextDerived nechá části o hladinách (omitLevels jen se zapnutou mapou).
  assert.match(SRC, /const infoEl=mapOn\?\$\('tradeMapSignal'\):\$\('signalBarInfo'\);/);
  assert.match(SRC, /if\(!mapOn\)\{\n  \$\('signalBarPreview'\)\.innerHTML=/);
  assert.match(SRC, /omitLevels:typeof levelsMapOn==='function'&&levelsMapOn\(\)\}\);/);
  const { derivedSummaryParts } = require('../app/context.js');
  const d = { nearLevels: [{ position: 'STOP_TO_ENTRY', fromStop: 3 }], nearestAheadTicks: 5, levelsStopToEntry: 1, levelsEntryToTarget: 0, stopBehindTicks: 3, tradeNoInDay: 2 };
  assert.deepEqual(derivedSummaryParts(d, { levelName: () => 'VAL' }), ['Nejbližší hladina ve směru: +5 t', 'SL 3 t za VAL', 'mezi SL a vstupem 1, před cílem 0', '2. obchod dne']);
  assert.deepEqual(derivedSummaryParts(d, { omitLevels: true }), ['2. obchod dne']);
});

test('8 výchozí zobrazení: mapa zapnutá, souhrnný řádek mimo detail vypnutý', () => {
  assert.deepEqual(FJTradeMap.normalizeLevelsView(undefined), { map: true, bars: 5, summaryLine: false });
  const { levelsSummaryOn } = loadRenderer(['levelsSummaryOn'], { levelsView: FJTradeMap.normalizeLevelsView(undefined) });
  assert.equal(levelsSummaryOn(), false);
});
