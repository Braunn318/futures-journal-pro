'use strict';
// Obchod „naživo bych nevzal" (wouldSkipLive, 4.7.0).
//
// V backtestu se setup vezme i tehdy, když by ho uživatel naživo vynechal –
// replay nic nestojí a výsledek je informace. Ve VÝCHOZÍM STAVU ale takový
// obchod nesmí do equity, P/L, win rate, expectancy ani žádné statistiky
// výkonu (performanceRecords). Do fill rate patří vždy: naplnění limitky je
// mechanika vstupu, ne rozhodnutí. Přepínač „včetně obchodů, které bych naživo
// nevzal" je vrací zpět, aby šlo obě skupiny porovnat.
//
// Stejně jako u setupů bez exekuce nesou testovací „skip" obchody schválně
// výrazný výsledek, takže agregace, která by je nevyloučila, změní výstup.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');

const plain = value => JSON.parse(JSON.stringify(value));

const SETTINGS = {
  startingBalance: 10000, usdCzkRate: 23,
  risk: { maxDailyDrawdown: 300, maxTotalDrawdown: 500, maxSlPerDay: 1, maxTradesPerDay: 3, maxProfitTradesPerDay: 2, profitTargetPerDay: 150 },
  templates: [{ instrument: 'MES', pointValue: 5, tickSize: 0.25 }]
};

function trade(id, date, result, pnlRaw, extra) {
  return {
    id, date, entryTime: '15:30', exitTime: '15:40', instrument: 'MES', side: 'long',
    result, pnl: Math.abs(pnlRaw), pnlRaw, commission: 0, contracts: 1, journalId: 'j1',
    ...extra
  };
}

const LIVE = [
  trade('t1', '2026-09-01', 'target', 200),
  trade('t2', '2026-09-01', 'stoploss', -100),
  trade('t3', '2026-09-02', 'stoploss', -350),
  trade('t4', '2026-09-03', 'target', 120, { fillStatus: 'FILLED', setupCode: 'M2_OF' })
];
const SKIPPED = [
  trade('k1', '2026-09-01', 'stoploss', -900, { wouldSkipLive: true, wouldSkipReason: 'SR_IN_WAY', fillStatus: 'FILLED' }),
  trade('k2', '2026-09-04', 'target', 700, { wouldSkipLive: true, wouldSkipReason: 'TOO_LATE' }),
  trade('k3', '2026-09-02', 'stoploss', -50, { wouldSkipLive: true, wouldSkipReason: 'SR_IN_WAY', fillStatus: 'NO_FILL' })
];
const MIXED = [...LIVE, ...SKIPPED];

function domStub(values = {}) {
  const nodes = new Map();
  const node = id => ({
    id, value: values[id] ?? '', textContent: '', innerHTML: '', className: '', style: {}, options: [],
    classList: { add() {}, remove() {}, contains: () => false }
  });
  return { nodes, $: id => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); } };
}

const BASE = ['isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive',
  'readIncludeSkipLive', 'includeSkipLive', 'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup', 'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude', 'performanceRecords'];

// Načte funkce a nastaví globální přepínač (let v kontextu vm).
function load(names, globals, include = false) {
  const r = loadRenderer([...BASE, ...names], { settings: SETTINGS, ...globals });
  // k3 je zároveň NO_FILL – „přepínač zapnutý“ tu proto znamená všechny
  // přepínače skupin mimo výkon (no fill a vynechané mají vlastní testy).
  const v = include ? 'true' : 'false';
  require('vm').runInContext(`includeSkipLive=${v};includeNoFill=${v};includeSkipped=${v}`, r.__context);
  return r;
}

test('výchozí stav přepínače je vypnuto, i bez localStorage', () => {
  const r = loadRenderer(BASE, {});
  assert.equal(r.includeSkipLive, false);
  assert.equal(r.readIncludeSkipLive(), false);
});

test('performanceRecords: ve výchozím stavu bez „naživo bych nevzal", s přepínačem se všemi', () => {
  const r = load([], {});
  assert.deepEqual(plain(r.performanceRecords(MIXED)), plain(LIVE));
  assert.deepEqual(plain(r.performanceRecords(MIXED, true)), plain(MIXED));
  assert.deepEqual(plain(r.performanceRecords([...MIXED, { id: 's', recordType: 'SETUP_ONLY' }], true)), plain(MIXED),
    'setup bez exekuce nepustí ani přepínač');
});

test('computeOverallStats: P/L, win rate i expectancy bez nich; přepínač je vrátí', () => {
  const off = load(['computeOverallStats'], {});
  assert.deepEqual(plain(off.computeOverallStats(MIXED)), plain(off.computeOverallStats(LIVE)));
  const on = load(['computeOverallStats'], {}, true);
  const all = plain(on.computeOverallStats(MIXED));
  assert.equal(all.totalTrades, MIXED.length);
  assert.equal(all.gainSum + all.lossSum, MIXED.reduce((a, t) => a + t.pnlRaw, 0));
});

test('computeDrawdownByDate a evaluateDayRisk: equity a limity bez nich', () => {
  const r = load(['computeDrawdownByDate', 'evaluateDayRisk'], { trades: LIVE, dualMoneyText: v => String(v) });
  assert.deepEqual(plain(r.computeDrawdownByDate(MIXED)), plain(r.computeDrawdownByDate(LIVE)));
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-04']) {
    assert.deepEqual(plain(r.evaluateDayRisk(date, r.computeDrawdownByDate(MIXED), MIXED)),
      plain(r.evaluateDayRisk(date, r.computeDrawdownByDate(LIVE), LIVE)), date);
  }
  assert.notDeepEqual(plain(r.computeDrawdownByDate(MIXED, true)), plain(r.computeDrawdownByDate(LIVE)),
    'přepínač je do equity vrací');
});

test('renderDashboard: výkon bez nich, fill rate s nimi, skupina evidovaná zvlášť', () => {
  function run(rows, include) {
    const seen = {};
    const r = load(['computeOverallStats', 'computeDrawdownByDate', 'evaluateDayRisk',
      'computeSetupStats', 'PERFORMANCE_GROUPS', 'computeGroupStats', 'computeSkipLiveStats', 'renderDashboard'], {
      trades: rows, setupRecords: [], $: domStub().$,
      renderKpiStrip: (total, balance, stats) => { seen.kpi = plain({ total, balance, stats }); },
      renderOverallStatsList() {}, renderTopInstruments: list => { seen.top = plain(list); },
      renderTradeStatsTable() {}, renderPeriodStats: list => { seen.period = plain(list); },
      renderGauges() {}, drawHistogram() {}, drawEquityRows: list => { seen.equity = plain(list); }, drawWeeklyCurve() {},
      renderSetupStats: stats => { seen.setup = plain(stats); },
      renderSkipLiveStats: stats => { seen.skip = plain(stats); },
      renderGroupStats() {},
      dualMoneyText: v => String(v)
    }, include);
    r.renderDashboard(rows, []);
    return seen;
  }
  const clean = run(LIVE, false);
  const mixed = run(MIXED, false);
  assert.deepEqual(mixed.kpi, clean.kpi, 'KPI a equity bez nich');
  assert.deepEqual(mixed.top, clean.top);
  assert.deepEqual(mixed.period, clean.period);
  assert.deepEqual(mixed.equity, clean.equity);
  // Fill rate: k1 FILLED, k2 bez stavu = naplněný, k3 NO_FILL – všechny se počítají.
  assert.equal(mixed.setup.filled, clean.setup.filled + 2);
  assert.equal(mixed.setup.noFill, clean.setup.noFill + 1);
  // Evidence zvlášť, nezávisle na přepínači.
  assert.equal(mixed.skip.count, 3);
  assert.equal(mixed.skip.pnl, -250);
  assert.deepEqual(mixed.skip.byReason.map(r => [r.key, r.count]), [['SR_IN_WAY', 2], ['TOO_LATE', 1]]);
  const withToggle = run(MIXED, true);
  assert.equal(withToggle.kpi.stats.totalTrades, MIXED.length, 'přepínač je vrátí do výkonu');
  assert.equal(withToggle.skip.count, 3);
});

test('computeSkipLiveStats: srovnání expectancy bez nich / s nimi', () => {
  const r = load(['computeOverallStats', 'PERFORMANCE_GROUPS', 'computeGroupStats', 'computeSkipLiveStats'], {});
  const s = plain(r.computeSkipLiveStats(MIXED));
  const liveNet = LIVE.reduce((a, t) => a + t.pnlRaw, 0);
  const allNet = MIXED.reduce((a, t) => a + t.pnlRaw, 0);
  assert.equal(s.expectancyWithout, liveNet / LIVE.length);
  // „S nimi“ přepíná jen tuhle skupinu: k3 je zároveň NO_FILL a zůstává mimo,
  // dokud je vypnutý přepínač no fill.
  const withSkip = [...LIVE, SKIPPED[0], SKIPPED[1]];
  assert.equal(s.expectancyWith, withSkip.reduce((a, t) => a + t.pnlRaw, 0) / withSkip.length);
  assert.equal(s.winRate, 1 / 3);
  assert.equal(plain(r.computeSkipLiveStats(LIVE)).count, 0);
  const all = load(['computeOverallStats', 'PERFORMANCE_GROUPS', 'computeGroupStats', 'computeSkipLiveStats'], {}, true);
  assert.equal(plain(all.computeSkipLiveStats(MIXED)).expectancyWith, allNet / MIXED.length, 's no fill zapnutým i k3');
});

test('kalendář: den s obchodem „naživo bych nevzal" má P/L jen z živých obchodů', () => {
  function run(rows, include) {
    const dom = domStub();
    const r = load(['computeDrawdownByDate', 'evaluateDayRisk', 'getCalendarRows', 'renderCalendar', 'renderCalendarMonthSummary', 'computeOverallStats'], {
      trades: rows, calendarAllTrades: null, calendarDate: new Date(2026, 8, 1),
      $: dom.$, dualMoney: v => String(v), dualMoneyText: v => String(v), money: v => String(v),
      esc: v => String(v), Intl
    }, include);
    r.renderCalendar();
    return dom.nodes.get('calendarGrid').innerHTML;
  }
  assert.equal(run(MIXED, false), run(LIVE, false));
  assert.notEqual(run(MIXED, true), run(LIVE, false));
});

test('reporty a přehled účtu: bez nich; přepínač je vrátí', () => {
  function report(rows, include) {
    const dom = domStub();
    const r = load(['reportSigned', 'groupSummary', 'generateReportView'], {
      $: dom.$, journalProfiles: [{ id: 'j1', name: 'Backtest' }], dualMoney: v => String(v), esc: v => String(v),
      drawReportChart() {}, reportRows: [], collectReportRows: async () => rows, tradeHTML: () => '', money: v => String(v)
    }, include);
    r.generateReportView(rows);
    return dom.nodes.get('reportCount').textContent;
  }
  assert.equal(Number(report(MIXED, false)), LIVE.length);
  assert.equal(Number(report(MIXED, true)), MIXED.length);

  const dom = domStub({ accountRangeMode: 'all' });
  const r = load(['filteredOverviewTrades', 'filteredOverviewRecords'], { $: dom.$, overviewAllTrades: MIXED });
  assert.deepEqual(plain(r.filteredOverviewTrades()), plain(LIVE));
  assert.equal(r.filteredOverviewRecords().length, MIXED.length, 'fill rate a evidence dostanou všechny');
});

test('podíl instrumentů: bez nich', () => {
  const r = load(['groupInstrumentPortfolio'], {});
  assert.deepEqual(plain(r.groupInstrumentPortfolio(MIXED)), plain(r.groupInstrumentPortfolio(LIVE)));
});

test('Deník: P/L dne bez nich, obchody se ale v seznamu ukazují; filtr na skupinu', () => {
  const r = load(['dayKpis'], {});
  const day = MIXED.filter(t => t.date === '2026-09-01');
  assert.deepEqual(plain(r.dayKpis(day)), plain(r.dayKpis(day.filter(t => !t.wouldSkipLive))));
  assert.equal(r.dayKpis(day, true).pnl, 200 - 100 - 900);

  function list(filter) {
    const groups = [];
    const lr = load(['renderTrades', 'activeJournalMode', 'renderDataCheckCount'], { journalProfiles: [], activeJournalId: '',
      trades: MIXED, setupRecords: [], $: domStub({ filterSkipLive: filter }).$, db: { data: { dayNotes: {} } },
      extraEmptyDays: new Set(),
      dayGroupHTML: (date, dayTrades) => { groups.push(...dayTrades.map(t => t.id)); return ''; }
    });
    lr.renderTrades();
    return groups.sort();
  }
  assert.deepEqual(list(''), MIXED.map(t => t.id).sort(), 'výchozí filtr ukazuje všechny');
  assert.deepEqual(list('only'), ['k1', 'k2', 'k3']);
  assert.deepEqual(list('exclude'), ['t1', 't2', 't3', 't4']);
});

test('sloučení: příznak i důvod se neztratí a planFollowed zůstává samostatný', () => {
  const r = loadRenderer([
    'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument', 'getDefaultCommissionForInstrument',
    'classifyResult', 'signed', 'tradeTotalPoints', 'tradePointsTotal', 'displayPointsTotal', 'weightedExitFields',
    'legFromTrade', 'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'getTickSizeForInstrument',
    'BUILTIN_TICK_SIZES', 'postExitFields', 'applyPostExitFields', 'postExitApplies', 'POST_EXIT_DERIVED_KEYS', 'combineTradeObjects'
  ], { settings: SETTINGS, Date });
  const base = { instrument: 'MES', date: '2026-09-12', entryTime: '16:00', entryPrice: 7700, side: 'long', contracts: 1, commission: 0, positionId: 'p' };
  const tp1 = { ...base, id: 'a', exitTime: '16:05', exitPrice: 7703, result: 'target', points: 3, pnl: 15, pnlRaw: 15, planFollowed: 'ano' };
  const tp2 = { ...base, id: 'b', exitTime: '16:09', exitPrice: 7705, result: 'target', points: 5, pnl: 25, pnlRaw: 25, planFollowed: 'ano',
    wouldSkipLive: true, wouldSkipReason: 'LIQUIDITY_SWEPT' };
  const merged = r.combineTradeObjects([tp1, tp2]);
  assert.equal(merged.wouldSkipLive, true);
  assert.equal(merged.wouldSkipReason, 'LIQUIDITY_SWEPT');
  assert.equal(merged.planFollowed, 'ano', 'naživo bych nevzal ≠ nedodržený plán');

  const live = r.combineTradeObjects([tp1, { ...tp1, id: 'c', exitTime: '16:09', exitPrice: 7705 }]);
  assert.equal(live.wouldSkipLive, undefined, 'živý obchod příznak nedostane');
  assert.equal(live.wouldSkipReason, undefined);
});

test('CSV exporty nesou příznak a klíč důvodu, sloupce se neposunou', () => {
  const r = loadRenderer(['signed', 'tradePointsTotal', 'displayPointsTotal', 'sideMeta', 'reportSigned',
    'srCsvHeader', 'srCsvCells', 'tradeCsvHeader', 'tradeCsvRow', 'reportCsvHeader', 'reportCsvRow'], { settings: SETTINGS });
  const t = { ...SKIPPED[0], journalName: 'Backtest', fillStatus: 'FILLED' };
  for (const [header, row, label] of [
    [r.tradeCsvHeader(), r.tradeCsvRow(t, null), 'deník'],
    [r.reportCsvHeader(), r.reportCsvRow(t, null), 'reporty']
  ]) {
    assert.equal(header.length, row.length, label);
    const rec = Object.fromEntries(header.map((name, i) => [name, row[i]]));
    assert.equal(rec['Naživo bych nevzal'], 'ano', label);
    assert.equal(rec['Důvod (naživo)'], 'SR_IN_WAY', label);
    assert.equal(rec['Stav naplnění'], 'FILLED', label);
    assert.equal(rec['Komise'], 0, label + ': sloupce za novými se neposunuly');
  }
  const liveRow = r.tradeCsvRow(LIVE[0], null);
  const h = r.tradeCsvHeader();
  assert.equal(liveRow[h.indexOf('Naživo bych nevzal')], 'ne');
  assert.equal(liveRow[h.indexOf('Důvod (naživo)')], '');
});
