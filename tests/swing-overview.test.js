'use strict';
// Swing obchody v Přehledu účtu a Kalendáři (docs/ZADANI_SWING_CFD.md §5) + okamžitý P/L
// otevřených pozic z cTraderu. Statistiky po uzavřených obchodech (den posledního výstupu),
// P/L podle dne (equity, P/L za období, kalendář) po nohách výstupu.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const FJSwing = require('../app/swing.js');
const { loadRenderer, loadFromSource, readRepoFile } = require('./helpers/extract');

const plain = v => JSON.parse(JSON.stringify(v));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const EURUSD = { symbol: 'EURUSD', pipSize: 0.0001 };
const o = { journalId: 'js', journalName: 'Swing' };
const CLOSED = { id: 'c1', kind: 'SWING', symbol: 'EURUSD', direction: 'long', openedAt: '2026-11-02T09:15', entryPrice: 1.1, volume: 1, slInitial: 1.095, swingSetup: 'M2 daily',
  exits: [{ closedAt: '2026-11-03T14:00', price: 1.105, volume: 0.5, pnl: 250, swap: -1, commission: -3.5 },
          { closedAt: '2026-11-04T08:30', price: 1.0996, volume: 0.5, pnl: -20, swap: -2, commission: -3.5 }] };
const LOSS = { id: 'c2', kind: 'SWING', symbol: 'USDJPY', direction: 'short', openedAt: '2026-11-04T10:00', entryPrice: 150, volume: 0.2, slInitial: 150.5,
  exits: [{ closedAt: '2026-11-05T16:00', price: 150.5, volume: 0.2, pnl: -66, swap: -0.4, commission: -1.2 }] };
const OPEN_PARTIAL = { id: 'o1', kind: 'SWING', symbol: 'GBPUSD', direction: 'long', openedAt: '2026-11-04T11:00', entryPrice: 1.3, volume: 0.2, slInitial: 1.295,
  exits: [{ closedAt: '2026-11-05T09:00', price: 1.305, volume: 0.1, pnl: 50, swap: 0, commission: -0.7 }] };
const NO_PNL = { ...CLOSED, id: 'c3', exits: [{ closedAt: '2026-11-03T14:00', price: 1.105, volume: 1 }] };
const SETUP = { id: 's1', kind: 'SWING', recordType: 'SETUP_ONLY', fillStatus: 'NO_FILL', symbol: 'USDJPY', direction: 'short', openedAt: '2026-11-04T07:00' };

test('1: uzavřený obchod se 2 nohami → 1 záznam (den posledního výstupu) + 2 řádky nohou ve 2 dnech', () => {
  const r = FJSwing.swingTradeRecord(CLOSED, EURUSD, o);
  assert.equal(r.kind, undefined, 'bez kind – jinak by ho tradeRecords vyřadil');
  assert.equal(r.sourceKind, 'SWING');
  assert.equal(r.date, '2026-11-04');
  assert.equal(r.entryTime, '09:15');
  assert.equal(r.exitTime, '', 'délka vícedenního obchodu se nepočítá z hodin');
  assert.equal(r.instrument, 'EURUSD');
  assert.equal(r.side, 'long');
  near(r.pnlRaw, 220);
  assert.equal(r.result, 'target');
  near(r.rMultiple, 0.46, 1e-6);
  assert.equal(r.journalId, 'js');
  assert.deepEqual(r.swingLegRows.map(l => [l.date, l.pnlRaw]), [['2026-11-03', 245.5], ['2026-11-04', -25.5]]);
  near(r.swingLegRows.reduce((a, l) => a + l.pnlRaw, 0), r.pnlRaw);
  assert.equal(FJSwing.swingTradeRecord(LOSS, null, o).result, 'stoploss');
});

test('2: otevřená, neúplná a SETUP_ONLY → do statistik ne; realizovaná noha otevřené pozice do kalendáře ano', () => {
  assert.equal(FJSwing.swingTradeRecord(OPEN_PARTIAL, null, o), null);
  assert.equal(FJSwing.swingTradeRecord(NO_PNL, EURUSD, o), null);
  assert.equal(FJSwing.swingTradeRecord(SETUP, null, o), null);
  assert.deepEqual(FJSwing.swingLegRows(OPEN_PARTIAL, o).map(l => [l.date, l.pnlRaw]), [['2026-11-05', 49.3]]);
  assert.deepEqual(FJSwing.swingLegRows(NO_PNL, o), [], 'noha bez P/L do kalendáře nejde');
  assert.deepEqual(FJSwing.swingLegRows(SETUP, o), []);
});

const STATS_NAMES = ['isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive', 'readIncludeSkipLive', 'includeSkipLive',
  'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup', 'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude', 'performanceRecords',
  'computeOverallStats', 'computePeriodStats'];

test('3: záznamy adaptéru projdou tradeRecords / performanceRecords; win rate a netto po obchodech', () => {
  const r = loadRenderer(STATS_NAMES, { settings: { startingBalance: 10000 } });
  const recs = [FJSwing.swingTradeRecord(CLOSED, EURUSD, o), FJSwing.swingTradeRecord(LOSS, null, o)];
  assert.equal(r.tradeRecords(recs).length, 2);
  assert.equal(r.performanceRecords(recs).length, 2);
  const s = r.computeOverallStats(recs);
  near(s.netPnl, 220 - 67.6);
  assert.equal(s.wins.length, 1);
  assert.equal(s.losses.length, 1);
  near(s.winRate, 0.5);
  assert.equal(s.totalTrades, 2);
});

test('4: P/L podle dne – swing po nohách, futures řádek beze změny', () => {
  const fut = { id: 'f1', date: '2026-11-03', pnl: 40, pnlRaw: 40, result: 'target', instrument: 'MES', side: 'long' };
  const rows = [fut, FJSwing.swingTradeRecord(CLOSED, EURUSD, o)];
  const flat = rows.flatMap(x => x.swingLegRows || [x]);
  assert.equal(flat[0], fut, 'futures záznam beze změny');
  assert.deepEqual(flat.slice(1).map(l => l.date), ['2026-11-03', '2026-11-04']);
  // renderDashboard používá pro equity / týdenní křivku / P/L za období rozložené řádky
  const src = readRepoFile('app/index.html');
  assert.ok(src.includes('const pnlRows=safeRows.flatMap(r=>r.swingLegRows||[r]);'));
  for (const call of ['renderPeriodStats(pnlRows)', 'drawEquityRows(pnlRows)', 'drawWeeklyCurve(pnlRows)']) assert.ok(src.includes(call), call);
});

test('5: readTradesForOverview – futures beze změny, swing navíc; legs pro kalendář', async () => {
  const futures = [{ id: 'f1', date: '2026-11-03', instrument: 'MES', pnlRaw: 40, result: 'target' }];
  const data = { trades: [...futures, CLOSED, OPEN_PARTIAL, SETUP], settings: [{ key: 'main', value: { breakEvenEnabled: false } }] };
  const r = loadRenderer(['readTradesForOverview', 'classifyResult'], {
    FJSwing, settings: { breakEvenEnabled: false }, window: { desktopAPI: { readJournal: async () => ({ ok: true, data }) } }
  });
  const p = { id: 'js', name: 'Swing' };
  const trades = await r.readTradesForOverview(p);
  assert.deepEqual(plain(trades.map(t => t.id)), ['f1', 'swing:c1']);
  assert.equal(trades[0].journalId, 'js');
  const legs = await r.readTradesForOverview(p, { swing: 'legs' });
  assert.deepEqual(plain(legs.map(t => t.id)), ['f1', 'swing:c1:0', 'swing:c1:1', 'swing:o1:0']);
});

test('6: řádek obchodu – swing záznam bez futures tlačítek; detail dne bez entryTime nespadne', () => {
  const src = readRepoFile('app/index.html');
  assert.ok(src.includes("if(t?.sourceKind==='SWING'&&typeof swingOverviewRowHTML==='function')return swingOverviewRowHTML(t);"));
  assert.ok(src.includes("sort((a,b)=>String(a.entryTime||'').localeCompare(String(b.entryTime||'')))"));
  const ui = loadFromSource(readRepoFile('app/swing-ui.js'), ['swingOverviewRowHTML', 'fmtLocal', 'fmtPrice', 'fmtNum', 'fmtMoney', 'swingCurrency', 'signCls', 'dirPill', 'swingInstruments', 'swingInstrumentOf', 'findSwing', 'swingRows'], {
    FJSwing, esc: s => String(s ?? ''), settings: {}, db: { data: { trades: [CLOSED] } }, activeJournalId: 'js'
  });
  const html = ui.swingOverviewRowHTML(FJSwing.swingTradeRecord(CLOSED, EURUSD, o));
  assert.ok(html.includes('EURUSD'));
  assert.ok(html.includes('data-swing-open="c1"'), 'Upravit otevře swing formulář');
  assert.ok(!/editTrade|deleteTrade|data-move|data-del/.test(html), 'žádná futures tlačítka');
  const leg = ui.swingOverviewRowHTML(FJSwing.swingLegRows(CLOSED, o)[0]);
  assert.ok(leg.includes('noha výstupu'));
});

test('7: okamžitý P/L – pozice z cTraderu ukáže netProfit z poslední synchronizace, ruční „—"', () => {
  const imported = { ...OPEN_PARTIAL, id: 'o2', positionId: 'ctrader-501', symbol: 'AUDCAD', exits: [] };
  const manual = { ...OPEN_PARTIAL, id: 'o3', symbol: 'GBPUSD', exits: [] };
  const rows = {};
  const el = id => (rows[id] = rows[id] || { innerHTML: '', style: {}, querySelectorAll: () => [] });
  const ui = loadFromSource(readRepoFile('app/swing-ui.js'),
    ['swingLiveOf', 'renderSwingPositions', 'swingOpenPositions', 'swingRows', 'swingDerivedOf', 'swingInstruments', 'swingInstrumentOf', 'fmtLocal', 'fmtPrice', 'fmtNum', 'fmtMoney', 'swingCurrency', 'signCls', 'dirPill'], {
      FJSwing, esc: s => String(s ?? ''), settings: { swingCurrency: 'USD' }, db: { data: { trades: [imported, manual] } },
      $: el, wireSwingButtons: () => {},
      swingLivePositions: new Map([['ctrader-501', { currentPrice: 0.97841, netProfit: 6.03, pips: 28.3, at: '2026-11-05T10:00:00.000Z' }]])
    });
  ui.renderSwingPositions();
  const html = rows.swingOpenPositions.innerHTML;
  assert.ok(/6,03/.test(html), 'netto z cTraderu');
  assert.ok(/28,3 pipů/.test(html));
  const manualRow = html.split('<tr>').find(r => r.includes('GBPUSD'));
  assert.ok(manualRow.includes('<td>—</td><td>—</td>'), 'ruční pozice bez P/L');
  assert.ok(/Otevřený P\/L/.test(rows.swingOpenPnl.innerHTML));
  vm.runInContext('void 0', ui.__context);
});
