'use strict';
// Cena targetu (= cena cílové hladiny 1 / 2), plánované R a vzdálenost SR
// hladin od SL / před targetem (4.7.1).
//
// Cena targetu se chová jako cena SL: u obchodu na targetu je to výstupní cena
// (u víc cílů TP1 → target 1, TP2 → target 2), u obchodu na SL se zadává ručně.
// Ověřuje se i chování u NinjaTraderu, který umí jednu uzávěrku nahlásit jako
// dva cíle na stejné ceně – to musí být JEDEN target, ne target 1 a 2 se
// stejnou cenou.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJPoints = require('../app/points.js');
const FJTaxonomy = require('../app/taxonomy.js');

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }],
  breakEvenEnabled: true, breakEvenThreshold: 5, useConnectorCommission: false, autoMergeLegs: true
};

// Hodnoty z VM kontextu mají vlastní Array/Object – porovnávají se přes JSON.
const eq = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const merging = () => loadRenderer([
  'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
  'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'POST_EXIT_DERIVED_KEYS',
  'postExitFields', 'applyPostExitFields', 'postExitApplies', 'getDefaultCommissionForInstrument',
  'classifyResult', 'signed', 'tradeTotalPoints', 'tradePointsTotal', 'displayPointsTotal',
  'weightedExitFields', 'legFromTrade', 'mergeSamePriceLegs', 'labelLegs',
  'mergeContextFields', 'combineTradeObjects', 'deriveTargetPrices', 'deriveStopLossPrice'
], { settings: SETTINGS, Date });

// MES short 7742,25; každá exekuce z NinjaTraderu je samostatný obchod na 1 kontrakt.
function exec(overrides) {
  return {
    id: 'nt-' + Math.random().toString(16).slice(2),
    instrument: 'MES', date: '2026-09-30', entryTime: '16:14', entryPrice: 7742.25, side: 'short',
    exitTime: '16:15', exitPrice: 7737.75, result: 'target', points: 4.5, contracts: 1,
    commission: 1.9, pnl: 20.6, pnlRaw: 20.6, positionId: 'pos-1', fillStatus: 'FILLED',
    ...overrides
  };
}

// ------------------------------------------------------------ deriveTargetPrices

test('bez nohou: target → výstupní cena, SL / BE → nic', () => {
  const r = merging();
  eq(r.deriveTargetPrices(exec()), [7737.75]);
  eq(r.deriveTargetPrices(exec({ result: 'stoploss', exitPrice: 7746 })), []);
  eq(r.deriveTargetPrices(exec({ result: 'breakeven', exitPrice: 7742.25 })), []);
});

test('nohy: TP1 → target 1, TP2 → target 2, stejná cena jen jednou, BE a SL se ignorují', () => {
  const r = merging();
  const legs = list => ({ legs: list });
  eq(r.deriveTargetPrices(legs([
    { exitPrice: 7737.75, result: 'target' }, { exitPrice: 7733, result: 'target' }])), [7737.75, 7733]);
  eq(r.deriveTargetPrices(legs([
    { exitPrice: 7737.75, result: 'target' }, { exitPrice: 7737.75, result: 'target' }])), [7737.75]);
  eq(r.deriveTargetPrices(legs([
    { exitPrice: 7742.25, result: 'breakeven' }, { exitPrice: 7746, result: 'stoploss' }, { exitPrice: 7737.75, result: 'target' }])), [7737.75]);
});

// ------------------------------------------------------ NinjaTrader: sloučení

test('NT8: jeden target → target 1 = výstup, nic dalšího', () => {
  const r = merging();
  const t = exec();
  eq(r.deriveTargetPrices(t), [7737.75]);
  assert.equal(r.deriveStopLossPrice(t), null);
});

test('NT8: dva targety zavřené na stejné ceně = jedna noha a jeden target', () => {
  const r = merging();
  const merged = r.combineTradeObjects([exec({ exitTime: '16:15' }), exec({ exitTime: '16:15' })]);
  assert.equal(merged.legs.length, 1, 'stejná cena a výsledek se sloučí do jedné nohy');
  assert.equal(merged.legs[0].contracts, 2);
  eq(r.deriveTargetPrices(merged), [7737.75], 'žádný duplicitní target 2');
  // S jedinou nohou se MFE dál odvozuje z výstupu (18 t) – víc nohou by odvození zablokovalo.
  assert.equal(merged.mfeTicks, 18);
  assert.equal(merged.mfeTicksDerived, true);
});

test('NT8: TP1 a TP2 na různých cenách → target 1 a 2', () => {
  const r = merging();
  const merged = r.combineTradeObjects([
    exec({ exitTime: '16:15', exitPrice: 7737.75 }),
    exec({ exitTime: '16:20', exitPrice: 7733, points: 9.25, pnl: 44.35, pnlRaw: 44.35 })
  ]);
  assert.equal(merged.legs.length, 2);
  eq(r.deriveTargetPrices(merged), [7737.75, 7733]);
});

test('NT8: TP + SL noha → target z TP nohy, SL z SL nohy', () => {
  const r = merging();
  const merged = r.combineTradeObjects([
    exec({ exitTime: '16:15', exitPrice: 7737.75 }),
    exec({ exitTime: '16:18', exitPrice: 7746, result: 'stoploss', points: 3.75, pnl: -20.65, pnlRaw: -20.65 })
  ]);
  eq(r.deriveTargetPrices(merged), [7737.75]);
  assert.equal(r.deriveStopLossPrice(merged), 7746);
});

test('sloučení: odvozená cena targetu z nohy se nepřebírá, typ ano', () => {
  const r = merging();
  const merged = r.mergeContextFields([
    { targetLevel1: { type: 'VPOC_1M', price: 7737.75 }, targetLevel1PriceDerived: true },
    { targetLevel1: { type: 'VPOC_1M', price: 7733 }, targetLevel1PriceDerived: true }
  ]);
  eq(merged.targetLevel1, { type: 'VPOC_1M', types: ['VPOC_1M'], price: null });
  const manual = r.mergeContextFields([{ targetLevel1: { type: 'VPOC_1M', price: 7730 } }]);
  eq(manual.targetLevel1, { type: 'VPOC_1M', types: ['VPOC_1M'], price: 7730 }, 'ruční cena zůstává');
});

// ---------------------------------------------------------------- plánované R

test('plánované R = nejvzdálenější target ÷ riziko', () => {
  const t = { side: 'short', entryPrice: 7742.25, slPrice: 7746 };
  assert.equal(FJPoints.plannedRMultipleOf(t, [7737.75]), 1.2);
  assert.equal(FJPoints.plannedRMultipleOf(t, [7737.75, 7733]), 2.47, 'u víc cílů ten nejdál');
  assert.equal(FJPoints.plannedRMultipleOf(t, [7750]), null, 'target na špatné straně vstupu nic nedá');
  assert.equal(FJPoints.plannedRMultipleOf({ ...t, slPrice: null }, [7737.75]), null, 'bez SL nic');
  assert.equal(FJPoints.plannedRMultipleOf({ ...t, side: '' }, [7737.75]), null, 'bez směru nic');
  assert.equal(FJPoints.plannedRMultipleOf(t, ['', null]), null);
});

test('plánované R u víc cílů jde do posledního targetu (TP3+ z nohou), ne jen do TP2', () => {
  const r = loadRenderer(['deriveTargetPrices', 'extraTargetPrices', 'plannedTargetPrices', 'plannedRFor', 'riskFields'], { settings: SETTINGS });
  const t = {
    side: 'short', entryPrice: 7742.25, slPrice: 7746,
    targetLevel1: { price: 7737.75 }, targetLevel2: { price: 7733 },
    legs: [
      { exitPrice: 7737.75, result: 'target', contracts: 1 },
      { exitPrice: 7733, result: 'target', contracts: 1 },
      { exitPrice: 7728.5, result: 'target', contracts: 1 }
    ],
    plannedRMultiple: 2.47
  };
  eq(r.plannedTargetPrices(t), [7737.75, 7733, 7728.5]);
  assert.equal(r.riskFields(t).plannedRMultiple, 3.67, 'TP3 ÷ riziko');
  assert.equal(r.plannedRFor(t), 3.67, 'starší uložená hodnota (do TP2) se při čtení přepočítá');
  // Ruční target 2 dál platí – TP3 z nohou se jen přidává.
  eq(r.plannedTargetPrices({ ...t, targetLevel2: { price: 7720 } }), [7737.75, 7720, 7728.5]);
  // Bez SL se nedá spočítat – zůstává uložená hodnota.
  assert.equal(r.plannedRFor({ ...t, slPrice: null }), 2.47);
});

// -------------------------------------------------- formulář: cena targetu

function targetForm(values, datasets, legs) {
  const nodes = new Map();
  const node = id => ({
    id, value: values[id] ?? '', textContent: '', innerHTML: '', style: {},
    dataset: { ...(datasets?.[id] || {}) }, focus() {}, select() {}
  });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); } };
  const names = [
    '$', 'esc', 'normalizeInstrumentCode', 'findTemplate', 'getTickSizeForInstrument',
    'BUILTIN_TICK_SIZES', 'deriveStopLossPrice', 'deriveTargetPrices', 'postExitTicksWarning', 'postExitApplies',
    'postExitDraftFromForm', 'formatTicks', 'renderPostExitHints', 'renderCourseHints', 'missedByApplies', 'syncCourseField',
    'sourceLabel', 'editCourseManually', 'useDerivedCourse'
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
    document.querySelector = sel => (sel === '#extraLegsList .leg-row' && legs.length ? {} : null);
    names.push('readLegRows', 'classifyResult');
  }
  const r = loadRenderer(names, { document, settings: SETTINGS,
    renderRiskInfo() {}, renderLevelDistances() {}, renderTradeSections() {} });
  r.renderPostExitHints();
  return { r, get: id => document.getElementById(id) };
}
const TP_FORM = { fillStatus: 'FILLED', instrument: 'MES', side: 'short', result: 'target', entryPrice: '7742.25', exitPrice: '7737.75' };
const shown = n => n.style.display !== 'none';

test('formulář target: cena targetu read-only dopočet z výstupu, SL ruční', () => {
  const f = targetForm(TP_FORM);
  assert.ok(!shown(f.get('targetLevel1Price')));
  assert.equal(f.get('targetLevel1PriceViewValue').textContent, '7737.75');
  assert.equal(f.get('targetLevel1Price').dataset.derived, '1');
  assert.ok(shown(f.get('slPrice')), 'SL se u targetu dopisuje ručně');
  assert.equal(f.get('targetLevel2PriceField').style.display, 'none', 'target 2 jen u víc cílů');
  assert.equal(f.r.postExitDraftFromForm().targetLevel1.price, 7737.75);
});

test('formulář stoploss: cena targetu je prázdné pole k ručnímu vyplnění', () => {
  const f = targetForm({ ...TP_FORM, result: 'stoploss', exitPrice: '7746' });
  assert.ok(shown(f.get('targetLevel1Price')));
  assert.equal(f.get('targetLevel1Price').value, '');
  assert.equal(f.get('slPriceViewValue').textContent, '7746');
});

test('formulář: „upravit ručně" u targetu, návrat k dopočtu, změna výsledku', () => {
  const f = targetForm(TP_FORM);
  f.r.editCourseManually('targetLevel1Price');
  const el = f.get('targetLevel1Price');
  el.value = '7736';
  f.r.renderPostExitHints();
  assert.equal(el.value, '7736');
  assert.equal(f.get('targetLevel1PriceRevert').textContent, 'použít dopočet z výstupní ceny (7737.75)');
  assert.equal(f.r.postExitDraftFromForm().targetLevel1.price, '7736');
  f.r.useDerivedCourse('targetLevel1Price');
  assert.equal(el.dataset.derived, '1');
  // Výsledek se změní na SL → odvozená cena targetu zmizí, stará v poli nezůstane.
  f.get('result').value = 'stoploss';
  f.get('exitPrice').value = '7746';
  f.r.renderPostExitHints();
  assert.equal(el.value, '');
  assert.ok(shown(el));
});

test('formulář s druhým cílem: TP2 → target 2; stejná cena → target 2 zůstane prázdný', () => {
  const two = targetForm(TP_FORM, null, [{ exitPrice: '7733', pnl: '44' }]);
  assert.equal(two.get('targetLevel2PriceViewValue').textContent, '7733');
  assert.equal(two.get('targetLevel2PriceField').style.display, '');
  const same = targetForm(TP_FORM, null, [{ exitPrice: '7737.75', pnl: '20' }]);
  assert.equal(same.get('targetLevel1PriceViewValue').textContent, '7737.75');
  assert.equal(same.get('targetLevel2Price').value, '', 'dva cíle na stejné ceně = jeden target');
  assert.ok(shown(same.get('targetLevel2Price')));
});

// ------------------------------------------------ cíle 3+ (TP3, TP4 …)

test('TP3: počet cílů z nohou i z uložených targetLevelN, nejméně 2', () => {
  const r = loadRenderer(['targetCountOf', 'deriveTargetPrices'], { settings: SETTINGS });
  assert.equal(r.targetCountOf(null), 2);
  assert.equal(r.targetCountOf(exec()), 2, 'jeden target → pořád pole 1 a 2');
  assert.equal(r.targetCountOf({ legs: [
    { exitPrice: 7737.75, result: 'target' }, { exitPrice: 7733, result: 'target' }, { exitPrice: 7728.5, result: 'target' }] }), 3);
  assert.equal(r.targetCountOf({ targetLevel4: { types: ['VAH'], price: null } }), 4, 'uložený cíl 4 bez nohou');
  assert.equal(FJTaxonomy.targetLevelNumbers({ targetLevel3: { price: 1 }, targetLevel3PriceDerived: true }).join(), '1,2,3');
});

test('TP3: plánované R bere ruční cenu targetu 3 před cenou nohy', () => {
  const r = loadRenderer(['plannedTargetPrices', 'riskFields'], { settings: SETTINGS });
  const t = {
    side: 'short', entryPrice: 7742.25, slPrice: 7746,
    targetLevel1: { price: 7737.75 }, targetLevel2: { price: 7733 }, targetLevel3: { types: ['VAL'], price: 7725 },
    legs: [{ exitPrice: 7737.75, result: 'target' }, { exitPrice: 7733, result: 'target' }, { exitPrice: 7728.5, result: 'target' }]
  };
  eq(r.plannedTargetPrices(t), [7737.75, 7733, 7725]);
  eq(r.plannedTargetPrices({ ...t, targetLevel3: { types: ['VAL'], price: null } }), [7737.75, 7733, 7728.5], 'bez ceny → noha');
});

test('formulář se třemi cíli: TP3 → Cena targetu 3 (dopočet), jde přepsat ručně', () => {
  const f = targetForm(TP_FORM, null, [{ exitPrice: '7733', pnl: '44' }, { exitPrice: '7728.5', pnl: '60' }]);
  assert.equal(f.get('targetLevel3PriceViewValue').textContent, '7728.5');
  assert.equal(f.get('targetLevel3Price').dataset.derived, '1');
  assert.equal(f.r.postExitDraftFromForm().targetLevel3.price, 7728.5);
  f.r.editCourseManually('targetLevel3Price');
  f.get('targetLevel3Price').value = '7725';
  f.r.renderPostExitHints();
  assert.equal(f.r.postExitDraftFromForm().targetLevel3.price, '7725', 'ruční hodnota má přednost');
  assert.equal(f.get('targetLevel3PriceRevert').textContent, 'použít dopočet z výstupní ceny (7728.5)');
});

test('sloučení: typy cíle 3 se sjednotí, odvozená cena nohy se nepřebírá', () => {
  const r = merging();
  const merged = r.mergeContextFields([
    { targetLevel3: { types: ['VAH'], price: 7728.5 }, targetLevel3PriceDerived: true },
    { targetLevel3: { types: ['LVN'], price: 7728.5 }, targetLevel3PriceDerived: true }
  ]);
  eq(merged.targetLevel3, { type: 'VAH', types: ['VAH', 'LVN'], price: null });
  assert.equal(r.mergeContextFields([{ targetLevel1: { type: 'VAH', price: 1 } }]).targetLevel3, undefined);
});

test('CSV: cíle 3+ jako koncové sloupce, jen když je některý obchod má', () => {
  const r = loadRenderer(['extraTargetCsvCount', 'extraTargetCsvHeader', 'extraTargetCsvCells'], { settings: SETTINGS });
  assert.equal(r.extraTargetCsvCount([exec()]), 0);
  assert.equal(r.extraTargetCsvCount([]), 0);
  const t3 = { targetLevel3: { type: 'VAH', types: ['VAH', 'LVN'], price: 7728.5 } };
  assert.equal(r.extraTargetCsvCount([exec(), t3]), 1);
  eq(r.extraTargetCsvHeader(1), ['Cíl 3 typ', 'Cíl 3 cena']);
  eq(r.extraTargetCsvCells(t3, 1), ['VAH|LVN', 7728.5]);
  eq(r.extraTargetCsvCells(exec(), 1), ['', '']);
});

// ------------------------------- vzdálenosti hladiny od vstupu, SL a cíle

test('hladina v blízkosti: vzdálenosti od vstupu, od SL a do cíle v ticích', () => {
  const FJContext = require('../app/context.js');
  const trade = { side: 'short', entryPrice: 7742.25, slPrice: 7746, targetLevel1: { price: 7737.75 } };
  const text = (price, t = trade) => FJContext.levelDistanceText(FJContext.levelGeometry({ price }, t, 0.25));
  assert.equal(text(7745), '−11 t od vstupu · 4 t od SL · 29 t do cíle');
  assert.equal(text(7739), '+13 t od vstupu · 28 t od SL · 5 t do cíle');
  assert.equal(text(7742.25), '0 t od vstupu · 15 t od SL · 18 t do cíle');
  assert.equal(text(7745, { ...trade, slPrice: null }), '−11 t od vstupu · 29 t do cíle', 'bez ceny SL jen to, co spočítat jde');
  assert.equal(text(''), '', 'bez ceny hladiny nic');
});

// --------------------------------------------- hlavičky karet: co kde chybí

test('chybějící pole se rozdělí do karet; cílová hladina 1 podle toho, co chybí', () => {
  // Rozhoduje FJTaxonomy.missingContextByCard: typ cíle je v Hladinách, cena
  // v SL / TP (tam se plánovaný cíl ručně přepisuje).
  const r = { missingBySection: d => FJTaxonomy.missingContextByCard(d) };
  const base = {
    setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'SHORT', trendHtf: 'DOWN', grade: 'B', entryLevels: ['VPOC_DAY'],
    srTargetNone: true, srStopLossNone: true, ofConfirm: ['ABS_ASK'],
    slPrice: 7746, mfeTicks: 18, maeTicks: 2, postExitFavorableTicks: 1, postExitAdverseTicks: 30
  };
  eq(r.missingBySection({ ...base, targetLevel1: { type: 'VPOC_1M', price: '' } }),
    { sltp: ['Cena targetu'], course: [], setup: [], levels: [], psych: [], comments: [], after: [] });
  eq(r.missingBySection({ ...base, targetLevel1: { type: '', price: 7737.75 } }).levels,
    ['Cílová hladina 1 (typ)']);
  const m = r.missingBySection({ ...base, slPrice: '', maeTicks: '', trend: '', targetLevel1: { type: 'VPOC_1M', price: 7737.75 } });
  eq(m.sltp, ['Cena Stop Lossu']);
  eq(m.course, ['MAE']);
  eq(m.setup, ['Trend 1m']);
});
