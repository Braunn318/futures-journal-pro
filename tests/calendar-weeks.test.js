'use strict';
// Kalendář po celých týdnech + výsledek měsíce (4.7.2).
//
// PROČ: mřížka dřív kreslila jen dny zobrazeného měsíce a dny sousedních
// měsíců v prvním a posledním řádku nechávala prázdné. Součet „Týden“ pak
// v řádku přes hranici měsíce vynechal část týdne – v říjnu 2026 chyběly
// obchody z 29. a 30. 9. v týdnu 28. 9. – 4. 10.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');

const SETTINGS = { startingBalance: 10000, usdCzkRate: 23, risk: {}, templates: [] };

function trade(id, date, result, pnlRaw) {
  return { id, date, entryTime: '15:30', instrument: 'MES', side: 'long', result, pnl: Math.abs(pnlRaw), pnlRaw, contracts: 1 };
}

// Září / říjen 2026: 1. 10. je čtvrtek, 31. 10. sobota, 1. 11. neděle.
const TRADES = [
  trade('s1', '2026-09-29', 'target', 100),
  trade('s2', '2026-09-30', 'stoploss', -40),
  trade('o1', '2026-10-01', 'target', 50),
  trade('o2', '2026-10-02', 'stoploss', -20),
  trade('o3', '2026-10-02', 'target', 30),
  trade('o4', '2026-10-15', 'stoploss', -10),
  trade('n1', '2026-11-01', 'target', 70),
  trade('n2', '2026-11-02', 'target', 999)
];

function domStub() {
  const nodes = new Map();
  const node = id => ({ id, value: '', textContent: '', innerHTML: '', className: '', style: {}, options: [] });
  return { nodes, $: id => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); } };
}

function render(calendarDate, rows = TRADES) {
  const dom = domStub();
  const r = loadRenderer([
    'isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive', 'readIncludeSkipLive', 'includeSkipLive', 'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup', 'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude', 'performanceRecords',
    'computeDrawdownByDate', 'evaluateDayRisk', 'getCalendarRows', 'computeOverallStats', 'renderCalendar', 'renderCalendarMonthSummary'
  ], {
    settings: SETTINGS, trades: rows, calendarAllTrades: null, calendarDate,
    $: dom.$, dualMoney: v => `[${v}]`, dualMoneyText: v => String(v), money: v => String(v),
    esc: v => String(v), Intl
  });
  r.renderCalendar();
  const grid = dom.nodes.get('calendarGrid').innerHTML;
  const cells = [...grid.matchAll(/<div class="day ([^"]*)" data-date="([\d-]+)"/g)].map(m => ({ cls: m[1], date: m[2] }));
  const weeks = [...grid.matchAll(/week-summary"><div class="num">Týden<\/div><div class="pnl [a-z]+">\[(-?[\d.]+)\]<\/div><div class="count">(\d+) obchodů/g)]
    .map(m => ({ pnl: Number(m[1]), count: Number(m[2]) }));
  return { grid, cells, weeks, summary: dom.nodes.get('calendarMonthSummary').innerHTML };
}

test('mřížka jde po celých týdnech od pondělí do neděle, i přes hranici měsíce', () => {
  const { cells, weeks } = render(new Date(2026, 9, 1));
  assert.equal(cells[0].date, '2026-09-28', 'začíná pondělím před 1. 10.');
  assert.equal(cells[cells.length - 1].date, '2026-11-01', 'končí nedělí po 31. 10.');
  assert.equal(cells.length, 35);
  assert.equal(weeks.length, 5);
});

test('dny sousedních měsíců jsou ztlumené, ale nesou svá data', () => {
  const { cells, grid } = render(new Date(2026, 9, 1));
  const byDate = Object.fromEntries(cells.map(c => [c.date, c.cls]));
  assert.match(byDate['2026-09-29'], /\bout-month\b/);
  assert.match(byDate['2026-09-29'], /\bhas\b/, 'den ze září má obchod a jde rozkliknout');
  assert.match(byDate['2026-11-01'], /\bout-month\b/);
  assert.doesNotMatch(byDate['2026-10-01'], /out-month/);
  assert.match(grid, /showDay\('2026-09-30'\)/);
});

test('týden přes hranici měsíce sčítá všech 7 dní', () => {
  const { weeks } = render(new Date(2026, 9, 1));
  // 29. 9. +100, 30. 9. −40, 1. 10. +50, 2. 10. −20 +30
  assert.deepEqual(weeks[0], { pnl: 120, count: 5 });
  // poslední týden 26. 10. – 1. 11.: jen 1. 11. +70 (2. 11. už do něj nepatří)
  assert.deepEqual(weeks[4], { pnl: 70, count: 1 });
});

test('stejný týden má stejný součet v obou měsících', () => {
  const sep = render(new Date(2026, 8, 1)).weeks;
  const oct = render(new Date(2026, 9, 1)).weeks;
  assert.deepEqual(sep[sep.length - 1], oct[0]);
});

test('měsíc začínající v pondělí nemá na začátku dny předchozího měsíce', () => {
  const { cells } = render(new Date(2026, 5, 1));
  assert.equal(cells[0].date, '2026-06-01');
  assert.equal(cells[cells.length - 1].date, '2026-07-05');
});

test('výsledek měsíce počítá jen dny kalendářního měsíce', () => {
  const { summary } = render(new Date(2026, 9, 1));
  // říjen: +50 −20 +30 −10 = 50, 4 obchody, 2 výhry / 2 prohry, PF 80/30
  assert.match(summary, /Výsledek měsíce – říjen 2026/);
  assert.match(summary, /P\/L měsíce<\/div><div class="kpi-value pos">\[50\]/);
  assert.match(summary, /Obchody<\/div><div class="kpi-value">4</);
  assert.match(summary, /Win rate<\/div><div class="kpi-value">50 %/);
  assert.match(summary, /Profit factor<\/div><div class="kpi-value">2\.67</);
  // obchodní dny: 1. 10. +50, 2. 10. +10, 15. 10. −10
  assert.match(summary, /Obchodní dny<\/div><div class="kpi-value">3 .*2 ↑.*1 ↓/);
});

test('prázdný měsíc má nulový výsledek a nespadne', () => {
  const { summary } = render(new Date(2026, 0, 1));
  assert.match(summary, /P\/L měsíce<\/div><div class="kpi-value ">\[0\]/);
  assert.match(summary, /Obchody<\/div><div class="kpi-value">0</);
});
