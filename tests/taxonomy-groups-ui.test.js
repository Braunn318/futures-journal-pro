'use strict';
// Číselníky v rendereru (4.8.106): přepínač „Používat" v editoru, výchozí
// vypnutí intraday číselníků ve swing deníku, vlastní číselníky ve štítcích
// a v CSV (sloupce na konci jen když nějaký vlastní číselník je).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

function makeDom(ids) {
  const nodes = {};
  for (const id of ids) {
    nodes[id] = { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {},
      querySelectorAll: () => [], querySelector: () => null, closest: () => null,
      classList: { add() {}, remove() {}, contains: () => false } };
  }
  return { nodes, document: { getElementById: id => nodes[id] || null, querySelectorAll: () => [], querySelector: () => null } };
}

const USER = {
  [FJTaxonomy.USER_GROUPS_KEY]: [{ name: 'U_POTVRZENI', label: 'Moje potvrzení', cardinality: 'multi' }],
  U_POTVRZENI: { custom: { CUSTOM_SVICE: 'Svíce', CUSTOM_OBJEM: 'Objem' } }
};

function editor(taxonomy, journalType) {
  const dom = makeDom(['taxonomyGroups', 'taxonomyCopyTarget', 'taxonomyCopyBtn', 'taxonomyTransferNote', 'userGroupsList', 'taxHideDisabled']);
  FJTaxonomy.applyConfig(taxonomy || {});
  const r = loadRenderer(['$', 'esc', 'taxOpenGroups', 'wireTaxonomyEditor', 'renderTaxonomyEditor', 'renderUserGroupsCard', 'taxonomyConfig', 'saveTaxonomyConfig'], {
    document: dom.document,
    settings: { taxonomy: taxonomy || {} },
    activeJournalType: () => journalType || 'FUTURES_INTRADAY',
    localStorage: { getItem: () => null, setItem() {} },
    trades: [],
    showToast() {},
    CSS: { escape: v => v }
  });
  return { r, dom };
}

test.afterEach(() => FJTaxonomy.applyConfig({}));

const sectionOf = (html, name) => {
  const start = html.indexOf(`data-group="${name}"`);
  return html.slice(start, html.indexOf('</summary>', start));
};

test('editor: každá skupina má přepínač Používat; futures deník = intraday zapnuté, swing vypnuté', () => {
  let { r, dom } = editor({}, 'FUTURES_INTRADAY');
  r.renderTaxonomyEditor();
  let html = dom.nodes.taxonomyGroups.innerHTML;
  assert.match(sectionOf(html, 'OF_CONFIRM'), /class="tax-enabled" data-group="OF_CONFIRM" checked/);
  assert.doesNotMatch(sectionOf(html, 'SWING_SETUP'), /data-group="SWING_SETUP" checked/);

  ({ r, dom } = editor({}, 'CFD_SWING'));
  r.renderTaxonomyEditor();
  html = dom.nodes.taxonomyGroups.innerHTML;
  assert.doesNotMatch(sectionOf(html, 'OF_CONFIRM'), /data-group="OF_CONFIRM" checked/);
  assert.match(html, /class="tax-group tax-off"[^>]*data-group="OF_CONFIRM"/);
  assert.match(sectionOf(html, 'SWING_SETUP'), /data-group="SWING_SETUP" checked/);
  // ruční zapnutí vyhrává nad výchozím stavem typu deníku
  ({ r, dom } = editor({ OF_CONFIRM: { enabled: true } }, 'CFD_SWING'));
  r.renderTaxonomyEditor();
  assert.match(sectionOf(dom.nodes.taxonomyGroups.innerHTML, 'OF_CONFIRM'), /data-group="OF_CONFIRM" checked/);
});

test('editor: vlastní číselník má sekci s volbami a přidáním, karta ho vypíše', () => {
  const { r, dom } = editor(USER, 'CFD_SWING');
  r.renderTaxonomyEditor();
  const html = dom.nodes.taxonomyGroups.innerHTML;
  assert.ok(html.includes('Moje potvrzení'));
  assert.match(html, /data-group="U_POTVRZENI" data-key="CUSTOM_SVICE"/);
  assert.match(html, /tax-add" data-group="U_POTVRZENI"/);
  r.renderUserGroupsCard();
  assert.match(dom.nodes.userGroupsList.innerHTML, /data-ugroup="U_POTVRZENI"/);
  assert.match(dom.nodes.userGroupsList.innerHTML, /víc voleb · 2 voleb/);
});

test('štítky karty obchodu: vlastní číselník s popisky voleb', () => {
  FJTaxonomy.applyConfig(USER);
  const r = loadRenderer(['esc', 'customContextPills'], {});
  const html = r.customContextPills({ customContext: { U_POTVRZENI: ['CUSTOM_OBJEM', 'CUSTOM_SVICE'] } }).join(' ');
  assert.match(html, /Moje potvrzení: Svíce, Objem/);
  assert.equal(r.customContextPills({}).length, 0);
});

test('CSV: bez vlastních číselníků žádný sloupec navíc, s nimi sloupec na konci', () => {
  const r0 = loadRenderer(['customCsvGroups', 'customCsvHeader', 'customCsvCells'], {});
  const plain = v => JSON.parse(JSON.stringify(v));
  const r = { customCsvGroups: c => plain(r0.customCsvGroups(c)), customCsvHeader: g => plain(r0.customCsvHeader(g)), customCsvCells: (...a) => plain(r0.customCsvCells(...a)) };
  assert.deepEqual(r.customCsvGroups([{}, undefined]), []);
  const groups = r.customCsvGroups([USER, { [FJTaxonomy.USER_GROUPS_KEY]: [{ name: 'U_POTVRZENI', label: 'jiný popisek', cardinality: 'single' }] }]);
  assert.deepEqual(r.customCsvHeader(groups), ['Vlastní: Moje potvrzení']);
  assert.deepEqual(r.customCsvCells({ customContext: { U_POTVRZENI: ['CUSTOM_SVICE'] } }, groups, USER), ['Svíce']);
  assert.deepEqual(r.customCsvCells({}, groups, USER), ['']);
});

test('sloučení nohou: vlastní kontext se sjednotí', () => {
  FJTaxonomy.applyConfig(USER);
  const r = loadRenderer(['mergeContextFields'], {});
  const out = r.mergeContextFields([
    { date: '2026-11-02', exitTime: '10:00', customContext: { U_POTVRZENI: ['CUSTOM_SVICE'] } },
    { date: '2026-11-02', exitTime: '10:05', customContext: { U_POTVRZENI: ['CUSTOM_OBJEM'] } }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(out.customContext)), { U_POTVRZENI: ['CUSTOM_SVICE', 'CUSTOM_OBJEM'] });
});
