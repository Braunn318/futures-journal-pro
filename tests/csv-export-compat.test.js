'use strict';
// Kontext obchodu v2, krok 6 (docs/ZADANI_KONTEXT.md A6, A9, A7 test 14):
// export stávajících obchodů před a po se liší JEN přidanými sloupci.
//
// „Před" = exportní funkce z commitu 2ff9d8e (4.8.0, poslední verze před
// kontextem v2), vyříznuté ze zdrojáku v gitu. „Po" = pracovní strom.
// Každá původní hlavička i buňka musí být identická a na stejném indexu;
// nové sloupce smí být jen za koncem původního řádku.
//
// Ověřuje se na syntetických obchodech (vždy) a na živých denících z
// ai-export (když jsou na disku – reálná data se do repozitáře nekopírují,
// chybějící vstup je hlasitý skip).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { REPO_ROOT, inlineScripts, loadFromSource, readRepoFile } = require('./helpers/extract');
const paths = require('./helpers/paths');
const FJPoints = require('../app/points.js');

const BASE = '2ff9d8e';
const SETTINGS = { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }] };
const OLD_NAMES = ['signed', 'tradePointsTotal', 'displayPointsTotal', 'sideMeta', 'reportSigned',
  'srCsvCounts', 'srCsvHeader', 'srCsvCells', 'tradeCsvHeader', 'tradeCsvRow', 'reportCsvHeader', 'reportCsvRow', 'firstTradeIdPerDate'];
const NEW_NAMES = [...OLD_NAMES, 'CONTEXT_CSV_MANUAL', 'CONTEXT_CSV_DERIVED', 'CONTEXT_CSV_DAY', 'csvBool', 'emptyDayNoteCells', 'contextCsvHeader', 'contextCsvCells', 'journalCsvTable', 'reportCsvTable'];
const plain = v => JSON.parse(JSON.stringify(v));

function oldSource() {
  try {
    return inlineScripts(execFileSync('git', ['show', BASE + ':app/index.html'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}
const OLD_SRC = oldSource();
const load = (src, names) => loadFromSource(src, names, { settings: SETTINGS, activeJournalId: 'j1', journalProfiles: [] });

// Export Deníku tak, jak ho dělal 4.8.0: denní poznámky jen u prvního obchodu dne.
function oldJournalTable(r, trades, dayNotes) {
  const counts = r.srCsvCounts(trades);
  const first = r.firstTradeIdPerDate(trades);
  return [r.tradeCsvHeader(counts), ...trades.map(t => r.tradeCsvRow(t, t.date && first[t.date] === t.id ? (dayNotes[t.date] || {}) : null, counts))];
}
function oldReportTable(r, rows, dayNotes) {
  const counts = r.srCsvCounts(rows);
  const first = {};
  for (const t of rows) { const k = t.journalId + '|' + t.date; if (!first[k] || String(t.entryTime || '').localeCompare(String(first[k].entryTime || '')) < 0) first[k] = t; }
  return [r.reportCsvHeader(counts), ...rows.map(t => r.reportCsvRow(t, first[t.journalId + '|' + t.date] === t ? (dayNotes[t.journalId + '|' + t.date] || {}) : null, counts))];
}

function assertOnlyAppended(before, after, label) {
  assert.equal(after.length, before.length, label + ': počet řádků');
  const width = before[0].length;
  assert.ok(after[0].length > width, label + ': přibyly sloupce');
  for (let i = 0; i < before.length; i++) {
    assert.deepEqual(plain(after[i].slice(0, width)).map(String), plain(before[i]).map(String), `${label}: řádek ${i} – původní buňky`);
  }
}

const TRADES = [
  { id: 'a', instrument: 'MES', date: '2026-10-09', entryTime: '15:31', exitTime: '15:40', side: 'long', entryPrice: 7800, exitPrice: 7804,
    result: 'target', pnl: 18.1, pnlRaw: 18.1, commission: 1.9, contracts: 1, points: 4, slPrice: 7798, setupCode: 'M2_OF', fillStatus: 'FILLED',
    entryLevels: ['VAH'], targetLevel1: { type: 'VAH', price: 7804 },
    srTarget: [{ level: 'VWAP', price: 7801, ticksFromEntry: 4 }], srStopLoss: [{ level: 'VAL', price: 7799, ticksFromEntry: 4 }, { level: 'VPOC_DAY', price: 7800.5, ticksFromEntry: 2 }] },
  { id: 'b', instrument: 'MES', date: '2026-10-09', entryTime: '16:10', exitTime: '16:12', side: 'short', entryPrice: 7810, exitPrice: 7812,
    result: 'stoploss', pnl: 11.9, pnlRaw: -11.9, commission: 1.9, contracts: 1, points: 2, slPrice: 7812, srTargetNone: true,
    targetLevel1: { type: 'MANUAL_EXIT', price: 7802 }, wouldSkipLive: true },
  { id: 'c', instrument: 'MES', date: '2026-10-10', entryTime: '09:15', side: 'long', entryPrice: 7790, exitPrice: 7790, result: 'breakeven', pnl: 1.9, pnlRaw: -1.9 }
];
const DAY_NOTES = { '2026-10-09': { comment: 'den', preview: '', notes: 'pozn', images: [] } };

test('A7/14: export Deníku – syntetické obchody: původní buňky identické, nové jen za koncem', { skip: OLD_SRC ? false : 'git show ' + BASE + ' nejde (chybí git?) – test nelze ověřit' }, () => {
  const before = oldJournalTable(load(OLD_SRC, OLD_NAMES), TRADES, DAY_NOTES);
  const NEW = load(inlineScripts(readRepoFile('app/index.html')), NEW_NAMES);
  const after = NEW.journalCsvTable(TRADES, d => DAY_NOTES[d] || null, { tickSizeOf: i => FJPoints.tickSizeFor(i, SETTINGS.templates), config: {} });
  assertOnlyAppended(before, after, 'deník');
});

test('A7/14: export Reportů – syntetické obchody ze dvou deníků', { skip: OLD_SRC ? false : 'git show nejde' }, () => {
  const rows = TRADES.map((t, i) => ({ ...t, journalId: i ? 'j2' : 'j1', journalName: i ? 'B' : 'A' }));
  const notes = { 'j1|2026-10-09': DAY_NOTES['2026-10-09'] };
  const before = oldReportTable(load(OLD_SRC, OLD_NAMES), rows, notes);
  const NEW = load(inlineScripts(readRepoFile('app/index.html')), NEW_NAMES);
  const after = NEW.reportCsvTable(rows, rows, k => notes[k] || null, { j1: { mode: 'LIVE' }, j2: { mode: 'BACKTEST' } });
  assertOnlyAppended(before, after, 'reporty');
});

test('A6: nové sloupce – ruční pole, SR řádky, dopočty s „(dopočet)“, kontext dne na každém řádku', () => {
  const NEW = load(inlineScripts(readRepoFile('app/index.html')), NEW_NAMES);
  const rich = TRADES.map(t => ({ ...t }));
  Object.assign(rich[0], { trendHtf: 'UP', absLocation: 'EXTREME', entryTestNo: '1', liquiditySwept: 'YES', pathProfile: 'LVN', grade: 'A',
    gradeSetAt: '2026-10-09T13:00:00.000Z', entryLevelTests: { VAH: 'UNTESTED' } });
  rich[0].srTarget = [{ level: 'VWAP', price: 7801, ticksFromEntry: 4, testState: 'TESTED' }];
  const notes = { '2026-10-09': { ...DAY_NOTES['2026-10-09'], dayContext: { openVsValue: 'GAP_UP', dayTypeExpected: 'TREND_UP', dayTypeActual: 'P', valueMigration: 'HIGHER', newsEvent: 'CPI' } } };
  const table = NEW.journalCsvTable(rich, d => notes[d] || null, { tickSizeOf: () => 0.25, config: {}, mode: 'LIVE' });
  const h = table[0];
  const rec = row => Object.fromEntries(h.map((name, i) => [name, row[i]]));
  const a = rec(table[1]), b = rec(table[2]), c = rec(table[3]);
  // ruční pole (A4) a netest/test
  assert.equal(a['Trend 30m'], 'UP');
  assert.equal(a['Absorpce – kde'], 'EXTREME');
  assert.equal(a['Kolikátý test vstupu'], '1');
  assert.equal(a['Vybraná likvidita'], 'YES');
  assert.equal(a['Profil cesty k cíli'], 'LVN');
  assert.equal(a['Známka'], 'A');
  assert.equal(a['Známka zadána'], '2026-10-09T13:00:00.000Z');
  assert.equal(a['Známka změněna dodatečně'], 'ne');
  assert.equal(a['Známka doplněná zpětně (dopočet)'], 'ne', 'zadána 15:00 Berlín, výstup 15:40');
  assert.equal(a['Hladina vstupu – netest/test'], 'VAH:UNTESTED');
  // SR řádky: test, znaménkové ticky, vzdálenost od SL, příznaky
  assert.equal(a['SR→TG 1 test'], 'TESTED');
  assert.equal(a['SR→TG 1 ticky ± (dopočet)'], 4);
  assert.equal(a['SR→TG 1 za cílem (dopočet)'], 'ne');
  assert.equal(a['SR→TG 1 na ztrátové straně (dopočet)'], 'ne');
  assert.equal(a['SR→SL 1 ticky ± (dopočet)'], -4);
  assert.equal(a['SR→SL 1 ticky od SL (dopočet)'], 4);
  assert.equal(a['SR→SL 2 ticky ± (dopočet)'], 2, 'zóna nad vstupem do longu');
  assert.equal(a['SR→SL 2 za SL (dopočet)'], 'ne');
  // dopočty A3
  assert.equal(a['Ticky k cíli (dopočet)'], 16);
  assert.equal(a['Cíl na hladině (dopočet)'], 'ano');
  assert.equal(a['Cesta k cíli (dopočet)'], 'BLOCKED');
  assert.equal(a['První překážka – ticky (dopočet)'], 4);
  assert.equal(a['Volná cesta R (dopočet)'], 0.5);
  assert.equal(a['SL za zónou – ticky (dopočet)'], 4);
  assert.equal(a['Zón chránících SL (dopočet)'], 2);
  assert.equal(a['Obchod dne č. (dopočet)'], 1);
  assert.equal(a['Předchozí výsledek dne (dopočet)'], 'FIRST');
  assert.equal(a['Seance (dopočet)'], 'US_OPEN');
  assert.equal(b['Obchod dne č. (dopočet)'], 2);
  assert.equal(b['Předchozí výsledek dne (dopočet)'], 'target');
  assert.equal(b['P/L dne před obchodem (dopočet)'], 18.1);
  assert.equal(b['Cesta k cíli (dopočet)'], 'FREE');
  assert.equal(b['Cíl na hladině (dopočet)'], 'ne', 'ruční výstup není hladina');
  assert.equal(c['Seance (dopočet)'], 'EU_MORNING');
  // chybějící vstup = prázdná buňka, nikdy 0
  assert.equal(c['Ticky k cíli (dopočet)'], '');
  assert.equal(c['Cesta k cíli (dopočet)'], 'UNKNOWN');
  assert.equal(c['Známka'], '');
  // kontext dne na KAŽDÉM řádku dne (původní „Den: Komentář" dál jen u prvního)
  for (const r of [a, b]) {
    assert.equal(r['Den: Open vůči value'], 'GAP_UP');
    assert.equal(r['Den: Typ dne skutečný'], 'P');
    assert.equal(r['Den: Zprávy'], 'CPI');
  }
  assert.equal(a['Den: Komentář'], 'den');
  assert.equal(b['Den: Komentář'], '');
  assert.equal(c['Den: Open vůči value'], '');
  // každá dopočtená hlavička nese „(dopočet)", ruční ne
  for (const name of h) if (/ticky ±|za cílem|za SL|ticky od SL|Seance|Cesta k cíli|Obchod dne/.test(name)) assert.match(name, /\(dopočet\)$/, name);
  assert.doesNotMatch(h.join('|'), /Trend 30m \(dopočet\)|Známka \(dopočet\)/);
});

const LIVE = paths.journalSources();
test('A7/14: export Deníku – živé deníky z ai-export: původní buňky identické', { skip: !OLD_SRC ? 'git show nejde' : (LIVE.length ? false : 'ai-export nenalezen (' + paths.dataRoots().join(', ') + ')') }, () => {
  const OLD = load(OLD_SRC, OLD_NAMES);
  const NEW = load(inlineScripts(readRepoFile('app/index.html')), NEW_NAMES);
  let checked = 0;
  for (const file of LIVE) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const trades = (data.trades || []).filter(t => t.recordType !== 'SETUP_ONLY');
    if (!trades.length) continue;
    const notes = data.dayNotes || {};
    const before = oldJournalTable(OLD, trades, notes);
    const after = NEW.journalCsvTable(trades, d => notes[d] || null, { tickSizeOf: i => FJPoints.tickSizeFor(i, []), config: data.taxonomy || {} });
    assertOnlyAppended(before, after, path.basename(file));
    checked += trades.length;
  }
  assert.ok(checked > 0, 'aspoň jeden obchod ověřen');
});
