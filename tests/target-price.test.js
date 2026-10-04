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
  eq(merged.targetLevel1, { type: 'VPOC_1M', price: null });
  const manual = r.mergeContextFields([{ targetLevel1: { type: 'VPOC_1M', price: 7730 } }]);
  eq(manual.targetLevel1, { type: 'VPOC_1M', price: 7730 }, 'ruční cena zůstává');
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
    'postExitDraftFromForm', 'formatTicks', 'renderPostExitHints', 'renderCourseHints', 'syncCourseField',
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
    renderRiskInfo() {}, renderSrDistances() {}, renderTradeSections() {} });
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

// -------------------------------------------- vzdálenost SR od SL / targetu

test('SR: vzdálenost od SL a před targetem v ticích', () => {
  const r = loadRenderer(['srRefDistanceText']);
  assert.equal(r.srRefDistanceText('srStopLoss', 7745, 7746, 0.25), '4 t od SL');
  assert.equal(r.srRefDistanceText('srTarget', 7739, 7737.75, 0.25), '5 t před targetem');
  assert.equal(r.srRefDistanceText('srStopLoss', 7745, null, 0.25), '', 'bez ceny SL nic');
  assert.equal(r.srRefDistanceText('srStopLoss', '', 7746, 0.25), '', 'bez ceny hladiny nic');
});

// --------------------------------------------- hlavičky karet: co kde chybí

test('chybějící pole se rozdělí do karet; cílová hladina 1 podle toho, co chybí', () => {
  // Od 4.7.2 rozhoduje FJTaxonomy.missingContextByCard (typ cíle je v Hladinách).
  const r = { missingBySection: d => FJTaxonomy.missingContextByCard(d) };
  const base = {
    setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'SHORT', entryLevels: ['VPOC_DAY'],
    srTargetNone: true, srStopLossNone: true, ofConfirm: ['ABS_ASK'],
    slPrice: 7746, mfeTicks: 18, maeTicks: 2, postExitFavorableTicks: 1, postExitAdverseTicks: 30
  };
  eq(r.missingBySection({ ...base, targetLevel1: { type: 'VPOC_1M', price: '' } }),
    { sltp: ['Cena targetu'], course: [], setup: [], levels: [], comments: [] });
  eq(r.missingBySection({ ...base, targetLevel1: { type: '', price: 7737.75 } }).levels,
    ['Cílová hladina 1 (typ)']);
  const m = r.missingBySection({ ...base, slPrice: '', maeTicks: '', trend: '', targetLevel1: { type: 'VPOC_1M', price: 7737.75 } });
  eq(m.sltp, ['Cena Stop Lossu']);
  eq(m.course, ['MAE']);
  eq(m.setup, ['Trend']);
});
