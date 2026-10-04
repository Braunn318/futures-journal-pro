'use strict';
// Hypotetický obchod (4.7.3): nenaplněný (NO_FILL, MISSED) nebo vědomě
// vynechaný (SKIPPED) setup vyplněný jako celý obchod – „co by to udělalo“.
//
// Ve výchozím stavu nesmí do P/L, equity, win rate, risk managementu ani
// jiné výkonové statistiky (performanceRecords) – stejně jako „naživo bych
// nevzal“. Každá skupina má vlastní přepínač: „včetně no fill obchodů“
// (NO_FILL + MISSED) a „včetně vědomě vynechaných“ (SKIPPED). Hypotetické
// obchody nesou schválně výrazný výsledek, takže agregace, která by je
// nevyloučila, změní výstup.

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
    entryPrice: 7700, exitPrice: 7710,
    result, pnl: Math.abs(pnlRaw), pnlRaw, commission: 0, contracts: 1, journalId: 'j1',
    ...extra
  };
}

const LIVE = [
  trade('t1', '2026-10-01', 'target', 200),
  trade('t2', '2026-10-01', 'stoploss', -100, { fillStatus: 'FILLED' }),
  trade('t3', '2026-10-02', 'target', 120)
];
const NO_FILL = [
  trade('n1', '2026-10-01', 'target', 800, { fillStatus: 'NO_FILL' }),
  trade('n2', '2026-10-03', 'stoploss', -400, { fillStatus: 'MISSED' })
];
const SKIPPED = [
  trade('s1', '2026-10-01', 'stoploss', -900, { fillStatus: 'SKIPPED', setupCode: 'M2_OF' })
];
const MIXED = [...LIVE, ...NO_FILL, ...SKIPPED];
const ids = rows => rows.map(t => t.id).sort();

const BASE = ['isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive',
  'readIncludeSkipLive', 'includeSkipLive', 'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup',
  'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude', 'performanceRecords'];

function load(names, globals = {}, flags = {}) {
  const r = loadRenderer([...BASE, ...names], { settings: SETTINGS, ...globals });
  const f = { skipLive: false, noFill: false, skipped: false, ...flags };
  require('vm').runInContext(
    `includeSkipLive=${f.skipLive};includeNoFill=${f.noFill};includeSkipped=${f.skipped}`, r.__context);
  return r;
}

test('hypotheticalGroup: NO_FILL a MISSED = no fill, SKIPPED = vynechané, jinak nic', () => {
  const r = load([]);
  assert.equal(r.hypotheticalGroup({ fillStatus: 'NO_FILL' }), 'noFill');
  assert.equal(r.hypotheticalGroup({ fillStatus: 'MISSED' }), 'noFill');
  assert.equal(r.hypotheticalGroup({ fillStatus: 'SKIPPED' }), 'skipped');
  assert.equal(r.hypotheticalGroup({ fillStatus: 'FILLED' }), null);
  assert.equal(r.hypotheticalGroup({}), null, 'prázdný stav = naplněno');
});

test('přepínače jsou ve výchozím stavu vypnuté, i bez localStorage', () => {
  const r = loadRenderer(BASE, {});
  assert.deepEqual(plain(r.currentInclude()), { skipLive: false, noFill: false, skipped: false });
});

test('performanceRecords: výchozí stav bez hypotetických, každý přepínač vrátí jen svou skupinu', () => {
  const r = load([]);
  assert.deepEqual(ids(r.performanceRecords(MIXED)), ids(LIVE));
  assert.deepEqual(ids(r.performanceRecords(MIXED, { noFill: true })), ids([...LIVE, ...NO_FILL]));
  assert.deepEqual(ids(r.performanceRecords(MIXED, { skipped: true })), ids([...LIVE, ...SKIPPED]));
  assert.deepEqual(ids(r.performanceRecords(MIXED, true)), ids(MIXED), 'true = všechny skupiny');
  assert.deepEqual(ids(r.performanceRecords(MIXED, false)), ids(LIVE), 'false = žádná');
  const noFillOn = load([], {}, { noFill: true });
  assert.deepEqual(ids(noFillOn.performanceRecords(MIXED)), ids([...LIVE, ...NO_FILL]), 'globální přepínač');
});

test('obchod „naživo bych nevzal“ a zároveň no fill potřebuje oba přepínače', () => {
  const both = trade('x', '2026-10-01', 'target', 50, { fillStatus: 'NO_FILL', wouldSkipLive: true });
  const r = load([]);
  assert.equal(r.performanceRecords([both], { skipLive: true }).length, 0);
  assert.equal(r.performanceRecords([both], { noFill: true }).length, 0);
  assert.equal(r.performanceRecords([both], { skipLive: true, noFill: true }).length, 1);
});

test('computeOverallStats, dayKpis, drawdown a risk management respektují přepínače', () => {
  const r = load(['computeOverallStats', 'dayKpis', 'computeDrawdownByDate', 'evaluateDayRisk'],
    { trades: LIVE, dualMoneyText: v => String(v) });
  assert.deepEqual(plain(r.computeOverallStats(MIXED)), plain(r.computeOverallStats(LIVE)));
  assert.deepEqual(plain(r.computeDrawdownByDate(MIXED)), plain(r.computeDrawdownByDate(LIVE)));
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    assert.deepEqual(plain(r.evaluateDayRisk(date, r.computeDrawdownByDate(MIXED), MIXED)),
      plain(r.evaluateDayRisk(date, r.computeDrawdownByDate(LIVE), LIVE)), date);
  }
  const day = MIXED.filter(t => t.date === '2026-10-01');
  assert.equal(r.dayKpis(day).pnl, 100, 'P/L dne jen ze živých');
  assert.equal(r.dayKpis(day, { noFill: true }).pnl, 900);
  assert.equal(r.dayKpis(day, { skipped: true }).pnl, -800);

  const on = load(['computeOverallStats'], {}, { noFill: true, skipped: true });
  const all = plain(on.computeOverallStats(MIXED));
  assert.equal(all.totalTrades, MIXED.length);
  assert.equal(all.gainSum + all.lossSum, MIXED.reduce((a, t) => a + t.pnlRaw, 0));
});

test('computeGroupStats: skupiny evidované zvlášť, srovnání bez nich / s nimi', () => {
  const r = load(['computeOverallStats', 'PERFORMANCE_GROUPS', 'computeGroupStats']);
  const nf = plain(r.computeGroupStats(MIXED, 'noFill'));
  assert.equal(nf.count, 2);
  assert.equal(nf.pnl, 400);
  assert.equal(nf.winRate, 0.5);
  assert.deepEqual(nf.byReason.map(x => [x.key, x.count]).sort(), [['MISSED', 1], ['NO_FILL', 1]]);
  const liveNet = LIVE.reduce((a, t) => a + t.pnlRaw, 0);
  assert.equal(nf.expectancyWithout, liveNet / LIVE.length);
  const withNf = [...LIVE, ...NO_FILL];
  assert.equal(nf.expectancyWith, withNf.reduce((a, t) => a + t.pnlRaw, 0) / withNf.length);

  const sk = plain(r.computeGroupStats(MIXED, 'skipped'));
  assert.equal(sk.count, 1);
  assert.equal(sk.pnl, -900);
  assert.deepEqual(sk.byReason.map(x => x.key), ['M2_OF'], 'vynechané podle setupu');
  assert.equal(plain(r.computeGroupStats(LIVE, 'noFill')).count, 0);
});

test('fill rate počítá hypotetické obchody podle stavu (beze změny)', () => {
  const r = load(['computeSetupStats']);
  const s = plain(r.computeSetupStats(MIXED));
  assert.equal(s.filled, 3);
  assert.equal(s.noFill, 1);
  assert.equal(s.missed, 1);
  assert.equal(s.skipped, 1);
});

test('Deník: filtr stavu naplnění včetně setupů bez vstupu', () => {
  const setup = { id: 'su', recordType: 'SETUP_ONLY', date: '2026-10-04', fillStatus: 'NO_FILL' };
  function list(fill) {
    const seen = [];
    const lr = load(['renderTrades'], {
      trades: MIXED, setupRecords: [setup], db: { data: { dayNotes: {} } }, extraEmptyDays: new Set(),
      $: (() => {
        const vals = { filterFill: fill };
        const nodes = new Map();
        return id => { if (!nodes.has(id)) nodes.set(id, { id, value: vals[id] ?? '', innerHTML: '' }); return nodes.get(id); };
      })(),
      dayGroupHTML: (date, dayTrades, daySetups) => { seen.push(...dayTrades.map(t => t.id), ...daySetups.map(s => s.id)); return ''; }
    });
    lr.renderTrades();
    return seen.sort();
  }
  assert.deepEqual(list(''), ids([...MIXED, setup]), 'výchozí filtr ukazuje vše');
  assert.deepEqual(list('filled'), ids(LIVE));
  assert.deepEqual(list('noFill'), ids([...NO_FILL, setup]));
  assert.deepEqual(list('skipped'), ids(SKIPPED));
});

test('tradeDraftFromSetup: formulář dostane, co setup zná', () => {
  const r = load(['tradeDraftFromSetup']);
  const setup = {
    id: 'su1', recordType: 'SETUP_ONLY', date: '2026-10-03', entryTime: '16:43', instrument: 'ES', side: 'long',
    setupCode: 'M2_OF', entryLevels: ['VPOC_1M'], ofConfirm: [], fillStatus: 'NO_FILL',
    plannedEntryPrice: 7788.75, slPrice: 7787.75, targetLevel1: { type: 'VWAP', price: 7792.75 },
    missedByTicks: 3, maxFavorableTicks: 29, reason: 'Bez PB', note: 'TOp'
  };
  const d = plain(r.tradeDraftFromSetup(setup));
  assert.equal(d.id, 'su1', 'stejné id – obchod setup nahradí');
  assert.equal(d.entryPrice, 7788.75);
  assert.equal(d.slPrice, 7787.75);
  assert.deepEqual(d.targetLevel1, { type: 'VWAP', price: 7792.75 });
  assert.equal(d.fillStatus, 'NO_FILL');
  assert.equal(d.setupCode, 'M2_OF');
  assert.equal(d.comment, 'Bez PB — TOp');
  assert.equal(d.contracts, 1);
  assert.equal(d.exitPrice, '', 'výstup doplní uživatel');
  assert.equal(d.recordType, undefined);
  assert.equal(r.tradeDraftFromSetup({ ...setup, fillStatus: 'SKIPPED' }).fillStatus, 'SKIPPED');
});

test('convertSetupRecordFields: uložený obchod už není SETUP_ONLY, max. pohyb se přejmenuje', () => {
  const r = load(['convertSetupRecordFields']);
  const existing = { id: 'su1', recordType: 'SETUP_ONLY', plannedEntryPrice: 7788.75, reason: 'Bez PB', note: 'TOp',
    maxFavorableTicks: 29, missedByTicks: 3, maxLevel: 'VAH' };
  const obj = plain(r.convertSetupRecordFields({ ...existing, comment: 'Bez PB — TOp' }, existing));
  assert.equal(obj.recordType, undefined);
  assert.equal(obj.plannedEntryPrice, undefined);
  assert.equal(obj.reason, undefined);
  assert.equal(obj.note, undefined);
  assert.equal(obj.maxFavorableTicks, undefined);
  assert.equal(obj.setupMaxFavorableTicks, 29);
  assert.equal(obj.missedByTicks, 3);
  assert.equal(obj.maxLevel, 'VAH');
  const plainTrade = { id: 't', maxFavorableTicks: 12 };
  assert.deepEqual(plain(r.convertSetupRecordFields({ ...plainTrade }, plainTrade)), plainTrade, 'běžný obchod beze změny');
});

test('postExitApplies: nenaplněný setup s hypotetickým výstupem se měří', () => {
  const r = load(['postExitApplies']);
  assert.equal(r.postExitApplies('NO_FILL'), false);
  assert.equal(r.postExitApplies('NO_FILL', ''), false);
  assert.equal(r.postExitApplies('SKIPPED', '7790'), true);
  assert.equal(r.postExitApplies('MISSED', 7790), true);
  assert.equal(r.postExitApplies('', ''), true);
});

test('štítek „Neúplné“: hypotetický obchod s výstupem se kontroluje celý', () => {
  const FJTaxonomy = require('../app/taxonomy.js');
  const base = { fillStatus: 'NO_FILL', setupCode: 'M2_OF', trend: 'LONG' };
  assert.ok(!FJTaxonomy.missingContextKeys(base).includes('mfeTicks'), 'bez výstupu se průběh nekontroluje');
  assert.ok(FJTaxonomy.missingContextKeys({ ...base, exitPrice: 7790 }).includes('mfeTicks'));
});
