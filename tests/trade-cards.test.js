'use strict';
// Karty formuláře obchodu: skrytí a „Upozorňovat na nevyplněné" po kartách
// (Nastavení → Přizpůsobení, 4.7.2).
//
// Nahrazuje jeden globální přepínač štítku „Neúplné". Hlídá:
// - kam které kontrolované pole patří (Hladiny jsou od 4.7.2 samostatná karta),
// - výchozí stav = vše zobrazené i s upozorněním,
// - převzetí dosavadní volby (vypnutý přepínač → upozornění vypnutá všude),
// - že štítek i karta obchodu respektují vypnutou kartu / upozornění.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

const complete = (extra = {}) => ({
  id: 't1', instrument: 'MES', side: 'short', result: 'target',
  setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'SHORT',
  entryLevels: ['VPOC_DAY'],
  srTarget: [{ level: 'VPOC_30M', price: 7730, ticksFromEntry: 49 }],
  srStopLoss: [{ level: 'LIQUIDITY', price: 7745, ticksFromEntry: 11 }],
  ofConfirm: ['ABS_ASK'],
  targetLevel1: { type: 'VPOC_1M', price: 7737.75 },
  slPrice: 7746, mfeTicks: 18, maeTicks: 2,
  postExitFavorableTicks: 1, postExitAdverseTicks: 30,
  trendHtf: 'DOWN', grade: 'A',
  ...extra
});
const plain = v => JSON.parse(JSON.stringify(v));
const cfg = (over = {}) => {
  const base = FJTaxonomy.normalizeCardConfig({});
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
  return base;
};

// ---------- rozdělení po kartách ----------

test('karty formuláře: pět karet v pořadí formuláře, Komentáře nic nekontrolují', () => {
  assert.deepEqual(FJTaxonomy.TRADE_CARDS.map(c => c.key), ['sltp', 'course', 'setup', 'levels', 'comments']);
  assert.equal(FJTaxonomy.TRADE_CARDS.find(c => c.key === 'comments').checks, false);
});

test('prázdný obchod: každé pole je ve své kartě', () => {
  assert.deepEqual(plain(FJTaxonomy.missingContextByCard({ instrument: 'MES' })), {
    sltp: ['Cena targetu', 'Cena Stop Lossu'],
    course: ['MFE', 'MAE', 'Ticky po výstupu – ve směru zisku', 'Ticky po výstupu – proti'],
    setup: ['Setup', 'Stav naplnění', 'Trend', 'Trend 30m', 'Známka'],
    levels: ['Hladina vstupu', 'SR proti targetu', 'SR proti S/L', 'Order flow potvrzení', 'Cílová hladina 1 (typ)'],
    comments: []
  });
});

test('cílová hladina 1: typ chybí v Hladinách, cena v SL / TP', () => {
  const noType = FJTaxonomy.missingContextByCard(complete({ targetLevel1: { type: '', price: 7737.75 } }));
  assert.deepEqual(plain(noType.levels), ['Cílová hladina 1 (typ)']);
  assert.deepEqual(plain(noType.sltp), []);
  const noPrice = FJTaxonomy.missingContextByCard(complete({ targetLevel1: { type: 'VPOC_1M', price: '' } }));
  assert.deepEqual(plain(noPrice.sltp), ['Cena targetu']);
  assert.deepEqual(plain(noPrice.levels), []);
});

// ---------- konfigurace ----------

test('výchozí konfigurace: vše zobrazené i s upozorněním', () => {
  for (const raw of [undefined, null, {}, 'nesmysl', { levels: 'x' }]) {
    const c = FJTaxonomy.normalizeCardConfig(raw);
    for (const card of FJTaxonomy.TRADE_CARDS) assert.deepEqual(plain(c[card.key]), { show: true, warn: true }, card.key);
  }
  const c = FJTaxonomy.normalizeCardConfig({ levels: { show: false }, course: { warn: false } });
  assert.deepEqual(plain(c.levels), { show: false, warn: true });
  assert.deepEqual(plain(c.course), { show: true, warn: false });
});

test('skrytá karta neupozorňuje, i když má upozornění zapnuté', () => {
  const c = cfg({ levels: { show: false, warn: true } });
  assert.equal(FJTaxonomy.cardShown(c, 'levels'), false);
  assert.equal(FJTaxonomy.cardWarns(c, 'levels'), false);
  assert.equal(FJTaxonomy.cardWarns(c, 'setup'), true);
});

function storage(initial) {
  const map = new Map(Object.entries(initial));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}
function readConfig(initial) {
  const localStorage = storage(initial);
  const r = loadRenderer(['TRADE_CARDS_KEY', 'MARK_INCOMPLETE_KEY', 'readTradeCardConfig'], { localStorage });
  return { cfg: plain(r.readTradeCardConfig()), stored: localStorage.map.get('FJ_tradeCards') };
}

test('převzetí dosavadní volby: vypnutý štítek → upozornění vypnutá u všech karet', () => {
  const { cfg: c, stored } = readConfig({ FJ_markIncompleteTrades: '0' });
  for (const card of FJTaxonomy.TRADE_CARDS) assert.deepEqual(c[card.key], { show: true, warn: false }, card.key);
  assert.ok(stored, 'převzatá konfigurace se uloží, starý klíč se pak už nečte');
});

test('bez dosavadní volby (nebo zapnuté) je vše zapnuté', () => {
  for (const initial of [{}, { FJ_markIncompleteTrades: '1' }]) {
    const { cfg: c } = readConfig(initial);
    for (const card of FJTaxonomy.TRADE_CARDS) assert.deepEqual(c[card.key], { show: true, warn: true }, card.key);
  }
});

test('uložená konfigurace má přednost před starým klíčem', () => {
  const saved = JSON.stringify({ levels: { show: false, warn: true } });
  const { cfg: c } = readConfig({ FJ_tradeCards: saved, FJ_markIncompleteTrades: '0' });
  assert.deepEqual(c.levels, { show: false, warn: true });
  assert.deepEqual(c.setup, { show: true, warn: true });
});

// ---------- štítek „Neúplné" ----------

const badge = cardConfig => loadRenderer(['esc', 'incompleteBadgeHTML'], { tradeCardConfig: cardConfig }).incompleteBadgeHTML;
const holes = complete({ trend: '', srStopLoss: [], ofConfirm: [], maeTicks: '' });

test('štítek: všechny karty s upozorněním počítají vše', () => {
  assert.match(badge(cfg())(holes), /Neúplné · 4/);
  assert.match(badge(cfg())(holes), /title="Chybí: MAE, Trend, SR proti S\/L, Order flow potvrzení"/);
});

test('štítek: vypnuté upozornění u Hladin odebere SR i order flow', () => {
  const html = badge(cfg({ levels: { warn: false } }))(holes);
  assert.match(html, /Neúplné · 2/);
  assert.doesNotMatch(html, /SR proti|Order flow/);
});

test('štítek: skrytá karta se nepočítá', () => {
  const html = badge(cfg({ course: { show: false } }))(holes);
  assert.match(html, /Neúplné · 3/);
  assert.doesNotMatch(html, /MAE/);
});

test('štítek: bez upozornění u všech karet se neukáže', () => {
  const off = Object.fromEntries(FJTaxonomy.TRADE_CARDS.map(c => [c.key, { show: true, warn: false }]));
  assert.equal(badge(off)({ instrument: 'MES' }), '');
});

// ---------- karta obchodu v Deníku ----------

function pills(shown) {
  return loadRenderer(['esc', 'formatLevelRow', 'contextPillsHTML', 'levelPillsHTML', 'openTradeLevels', 'tradeLevelsBlockHTML',
    'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'srRefDistanceText'],
  { FJTaxonomy, settings: { templates: [] }, tradeCardShown: key => shown[key] !== false });
}

test('karta obchodu: skryté Hladiny schovají blok hladin, skrytý Setup jeho pilulky', () => {
  const t = complete();
  const all = pills({});
  assert.match(all.tradeLevelsBlockHTML(t), /Hladiny/);
  assert.match(all.contextPillsHTML(t), /title="Setup"/);

  const noLevels = pills({ levels: false });
  assert.equal(noLevels.tradeLevelsBlockHTML(t), '');
  assert.match(noLevels.contextPillsHTML(t), /title="Setup"/, 'Setup zůstává');

  const noSetup = pills({ setup: false });
  assert.doesNotMatch(noSetup.contextPillsHTML(t), /title="Setup"|title="Trend"/);
  assert.match(noSetup.tradeLevelsBlockHTML(t), /Hladiny/, 'Hladiny zůstávají');
});

// ---------- formulář ----------

test('formulář: skrytá karta zmizí, ostatní zůstanou vidět', () => {
  const cards = ['sltp', 'course', 'setup', 'levels', 'comments'].map(key => ({ dataset: { card: key }, style: { display: 'x' } }));
  const document = { querySelectorAll: () => cards };
  const r = loadRenderer(['tradeCardShown', 'applyTradeCardVisibility'], {
    document, tradeCardConfig: cfg({ levels: { show: false }, comments: { show: false } })
  });
  r.applyTradeCardVisibility();
  assert.deepEqual(cards.map(c => c.style.display), ['', '', '', 'none', 'none']);
});
