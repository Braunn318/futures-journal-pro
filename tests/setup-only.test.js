'use strict';
// Záznam setupu bez exekuce (recordType 'SETUP_ONLY').
//
// KRITICKÉ: takový záznam nesmí NIKDY do equity, P/L, drawdownu ani počítadel
// risk managementu. Vstupuje jen do četnosti setupů a fill rate. Test níže
// prochází všech osm agregací a u každé porovnává výstup nad samými obchody
// s výstupem nad obchody + setupy. Setupy v testu schválně nesou nebezpečná
// pole (result 'stoploss', velký pnl), takže i jediná agregace, která by je
// nevyloučila, změní výsledek a test selže.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');

const plain = value => JSON.parse(JSON.stringify(value));

const SETTINGS = {
  startingBalance: 10000, usdCzkRate: 23,
  risk: { maxDailyDrawdown: 300, maxTotalDrawdown: 500, maxSlPerDay: 1, maxTradesPerDay: 3, maxProfitTradesPerDay: 2, profitTargetPerDay: 150 },
  templates: []
};

function trade(id, date, result, pnlRaw, extra) {
  return {
    id, date, entryTime: '15:30', exitTime: '15:40', instrument: 'MES', side: 'long',
    result, pnl: Math.abs(pnlRaw), pnlRaw, commission: 0, contracts: 1, journalId: 'j1',
    ...extra
  };
}

const TRADES = [
  trade('t1', '2026-09-01', 'target', 200),
  trade('t2', '2026-09-01', 'stoploss', -100),
  trade('t3', '2026-09-02', 'stoploss', -350),
  trade('t4', '2026-09-03', 'target', 120, { fillStatus: 'FILLED', setupCode: 'M2_OF' })
];

// Nebezpečné setupy: kdyby se propašovaly, změní P/L, počty S/L i počet obchodů.
function setup(id, date, fillStatus, extra) {
  return {
    id, recordType: 'SETUP_ONLY', date, entryTime: '16:00', instrument: 'MES', side: 'long',
    setupCode: 'M2_OF', fillStatus, plannedEntryPrice: 7700, slPrice: 7697,
    result: 'stoploss', pnl: 9999, pnlRaw: -9999, points: 50, contracts: 5, journalId: 'j1',
    ...extra
  };
}

const SETUPS = [
  setup('s1', '2026-09-01', 'NO_FILL'),
  setup('s2', '2026-09-02', 'SKIPPED'),
  setup('s3', '2026-09-04', 'NO_FILL'),
  setup('s4', '2026-09-01', 'NO_FILL', { setupCode: 'M2_PA' })
];
const MIXED = [...TRADES, ...SETUPS];

// Uzel, který si pamatuje zapsané hodnoty; neznámé id vznikne na požádání.
function domStub(values = {}) {
  const nodes = new Map();
  const node = id => ({
    id, value: values[id] ?? '', textContent: '', innerHTML: '', className: '', style: {}, options: [],
    classList: { add() {}, remove() {}, contains: () => false }
  });
  return {
    nodes,
    $: id => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); }
  };
}

const BASE_NAMES = ['isSetupRecord', 'tradeRecords', 'signed'];

// ------------------------------------------------------------ 1. drawdown

test('computeDrawdownByDate: setup bez exekuce nemění drawdown', () => {
  const r = loadRenderer([...BASE_NAMES, 'computeDrawdownByDate'], { settings: SETTINGS, trades: TRADES });
  assert.deepEqual(plain(r.computeDrawdownByDate(MIXED)), plain(r.computeDrawdownByDate(TRADES)));
  assert.ok(Object.keys(r.computeDrawdownByDate(MIXED)).every(d => d !== '2026-09-04'), 'den jen se setupem nevzniká');
});

// ------------------------------------------------------- 2. risk management

test('evaluateDayRisk: setupy se nepočítají do limitů ani počítadel', () => {
  const r = loadRenderer([...BASE_NAMES, 'computeDrawdownByDate', 'evaluateDayRisk'],
    { settings: SETTINGS, trades: TRADES, dualMoneyText: v => String(v), money: v => String(v) });
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) {
    const withSetups = r.evaluateDayRisk(date, r.computeDrawdownByDate(MIXED), MIXED);
    const without = r.evaluateDayRisk(date, r.computeDrawdownByDate(TRADES), TRADES);
    assert.deepEqual(plain(withSetups), plain(without), date);
  }
  const dayOnlySetup = r.evaluateDayRisk('2026-09-04', {}, MIXED);
  assert.deepEqual(plain(dayOnlySetup), { violations: [], achievements: [] }, 'den jen se setupem není obchodní den');
});

// ------------------------------------------------------------ 3. statistiky

test('computeOverallStats: setupy nejsou v počtech, win rate ani P/L', () => {
  const r = loadRenderer([...BASE_NAMES, 'computeOverallStats'], { settings: SETTINGS });
  assert.deepEqual(plain(r.computeOverallStats(MIXED)), plain(r.computeOverallStats(TRADES)));
  assert.equal(r.computeOverallStats(MIXED).totalTrades, TRADES.length);
});

// ------------------------------------------------------------ 4. dashboard

test('renderDashboard: equity, KPI i statistiky vycházejí jen z obchodů', () => {
  function run(rows, setups) {
    const dom = domStub();
    const seen = { kpi: null, list: null, drawn: null, setupStats: null };
    const r = loadRenderer([...BASE_NAMES, 'computeOverallStats', 'computeDrawdownByDate', 'evaluateDayRisk',
      'computeSetupStats', 'renderDashboard'], {
      settings: SETTINGS, trades: rows, setupRecords: setups, $: dom.$,
      renderKpiStrip: (total, balance, stats) => { seen.kpi = plain({ total, balance, stats }); },
      renderOverallStatsList: stats => { seen.list = plain(stats); },
      renderTopInstruments: list => { seen.top = plain(list); },
      renderTradeStatsTable() {}, renderPeriodStats: list => { seen.period = plain(list); },
      renderGauges() {}, drawHistogram() {}, drawEquityRows() {}, drawWeeklyCurve() {},
      renderSetupStats: stats => { seen.setupStats = plain(stats); },
      dualMoneyText: v => String(v)
    });
    r.renderDashboard(rows, setups);
    return seen;
  }
  const clean = run(TRADES, []);
  const leaked = run(MIXED, SETUPS);      // setupy i mezi „obchody"
  const separate = run(TRADES, SETUPS);   // setupy tam, kam patří
  for (const seen of [leaked, separate]) {
    assert.deepEqual(seen.kpi, clean.kpi, 'KPI, equity a statistiky se nesmí změnit');
    assert.deepEqual(seen.list, clean.list);
    assert.deepEqual(seen.top, clean.top);
    assert.deepEqual(seen.period, clean.period);
  }
  // Setupy naopak do četnosti a fill rate vstupují.
  assert.equal(separate.setupStats.noFill, 3);
  assert.equal(separate.setupStats.skipped, 1);
});

// ---------------------------------------------------------- 5. seznam obchodů

test('renderTrades: setupy nejdou do počítaných čísel dne, jen se ukazují zvlášť', () => {
  function run(rows, setups) {
    const dom = domStub();
    const groups = [];
    const r = loadRenderer([...BASE_NAMES, 'renderTrades'], {
      settings: SETTINGS, trades: rows, setupRecords: setups, $: dom.$, db: { data: { dayNotes: {} } },
      extraEmptyDays: new Set(),
      dayGroupHTML: (date, dayTrades, daySetups) => { groups.push(plain({ date, dayTrades, daySetups })); return ''; }
    });
    r.renderTrades();
    return groups;
  }
  const clean = run(TRADES, []);
  for (const groups of [run(MIXED, SETUPS), run(TRADES, SETUPS)]) {
    for (const g of groups) {
      assert.ok(g.dayTrades.every(t => t.recordType !== 'SETUP_ONLY'), g.date + ': setup mezi obchody dne');
      const cleanDay = clean.find(c => c.date === g.date);
      assert.deepEqual(g.dayTrades, cleanDay ? cleanDay.dayTrades : [], g.date);
    }
    assert.equal(groups.flatMap(g => g.daySetups).length, SETUPS.length, 'všechny setupy se v seznamu ukážou');
  }
});

// ------------------------------------------------------------- 6. kalendář

test('renderCalendar: den se setupem nemá P/L ani počet obchodů', () => {
  function run(rows) {
    const dom = domStub();
    const r = loadRenderer([...BASE_NAMES, 'computeDrawdownByDate', 'evaluateDayRisk', 'getCalendarRows', 'renderCalendar'], {
      settings: SETTINGS, trades: rows, calendarAllTrades: null, calendarDate: new Date(2026, 8, 1),
      $: dom.$, dualMoney: v => String(v), dualMoneyText: v => String(v), money: v => String(v),
      esc: v => String(v), Intl
    });
    r.renderCalendar();
    return dom.nodes.get('calendarGrid').innerHTML;
  }
  const clean = run(TRADES);
  assert.equal(run(MIXED), clean);
  assert.ok(clean.length > 0);
});

// ------------------------------------------------------- 7. přehled účtu

test('filteredOverviewTrades: vrací jen obchody', () => {
  const dom = domStub({ accountRangeMode: 'all' });
  const r = loadRenderer([...BASE_NAMES, 'filteredOverviewTrades', 'filteredOverviewRecords'], {
    $: dom.$, overviewAllTrades: MIXED
  });
  assert.deepEqual(plain(r.filteredOverviewTrades()), plain(TRADES));
  assert.equal(r.filteredOverviewRecords().length, MIXED.length, 'záznamy včetně setupů jsou jen pro fill rate');
});

// ------------------------------------------------------------- 8. reporty

test('generateReportView: report bere jen obchody', () => {
  function run(rows) {
    const dom = domStub();
    const r = loadRenderer([...BASE_NAMES, 'reportSigned', 'groupSummary', 'generateReportView'], {
      settings: SETTINGS, $: dom.$, journalProfiles: [{ id: 'j1', name: 'Hlavní' }],
      dualMoney: v => String(v), esc: v => String(v), drawReportChart() {}, reportRows: [],
      collectReportRows: async () => rows, resultMeta: () => ({ text: '', cls: '' }), sideMeta: () => ({ text: '' }),
      money: v => String(v), showDay() {}, tradeHTML: () => ''
    });
    r.generateReportView(rows);
    return {
      count: dom.nodes.get('reportCount').textContent,
      pnl: dom.nodes.get('reportPnl').innerHTML,
      winrate: dom.nodes.get('reportWinrate').textContent,
      pf: dom.nodes.get('reportPf').textContent,
      avg: dom.nodes.get('reportAvg').innerHTML,
      instruments: dom.nodes.get('reportInstrumentRows').innerHTML
    };
  }
  const clean = run(TRADES);
  assert.equal(Number(clean.count), TRADES.length);
  assert.deepEqual(run(MIXED), clean);
});

// ------------------------------------------------------------- fill rate

test('fill rate = FILLED / (FILLED + NO_FILL), SKIPPED se nepočítá a vykazuje se zvlášť', () => {
  const r = loadRenderer(['isSetupRecord', 'computeSetupStats']);
  const records = [
    { id: 'a', setupCode: 'M2_OF', fillStatus: 'FILLED' },
    { id: 'b', setupCode: 'M2_OF' },                               // obchod bez stavu = naplněný
    { id: 'c', recordType: 'SETUP_ONLY', setupCode: 'M2_OF', fillStatus: 'NO_FILL' },
    { id: 'd', recordType: 'SETUP_ONLY', setupCode: 'M2_PA', fillStatus: 'SKIPPED' },
    { id: 'e', recordType: 'SETUP_ONLY', setupCode: 'M2_PA', fillStatus: 'SKIPPED' },
    { id: 'f', setupCode: 'M2_PA', fillStatus: 'MISSED' }
  ];
  const s = plain(r.computeSetupStats(records));
  assert.equal(s.filled, 2);
  assert.equal(s.noFill, 1);
  assert.equal(s.skipped, 2, 'vynechané zvlášť');
  assert.equal(s.missed, 1);
  assert.equal(Math.round(s.fillRate * 1000) / 1000, 0.667, '2 / (2 + 1); SKIPPED ani MISSED ve jmenovateli nejsou');
  assert.equal(s.bySetup.find(x => x.key === 'M2_OF').count, 3, 'četnost setupů');
  assert.equal(s.bySetup.find(x => x.key === 'M2_PA').skipped, 2);
  // Bez záznamů nedává fill rate smysl, ne 100 %.
  assert.equal(r.computeSetupStats([]).fillRate, null);
});

// ---------------------------------------------------- migrace, štítek, pole

test('migrace a štítek „neúplný kontext" setup bez exekuce přeskočí', () => {
  const FJPoints = require('../app/points.js');
  assert.equal(FJPoints.contextIncomplete(SETUPS[0]), false);
  const r = loadRenderer(['migrateTradePointsFields']);
  assert.equal(r.migrateTradePointsFields(SETUPS[0]), null, 'setup se neoznačuje jako legacy body');
});
