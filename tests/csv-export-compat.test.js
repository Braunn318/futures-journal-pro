'use strict';
// Export CSV před a po kontextu v3 (docs/ZADANI_KONTEXT_V3.md A6, A7 test 10):
// mimo NAHRAZENÉ a SMAZANÉ sloupce musí být export stávajících obchodů
// identický – stejné sloupce ve stejném pořadí se stejnými buňkami.
//
// „Před" = exportní funkce i doménové moduly z commitu 1eaef56 (4.8.4,
// poslední verze se dvěma seznamy SR), vyříznuté z gitu, nad obchody
// v PŮVODNÍM tvaru. „Po" = pracovní strom nad týmiž obchody převedenými
// produkční funkcí (totéž, co udělá migrace deníku).
//
//   nahrazeno   bloky „SR→TG n …" a „SR→SL n …" → blok „Hladina n …"
//   smazáno     vybraná likvidita, profil cesty, netest/test vstupní hladiny,
//               dopočty s prahem (první překážka, cesta k cíli, volná cesta R,
//               SL za zónou, počet zón)
//   přepočítáno „Známka doplněná zpětně" – až po lhůtě od uložení obchodu
//               (zpětná vazba 13. 10.); smí se změnit jen z „ano" na „ne"
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
const FJTaxonomy = require('../app/taxonomy.js');

const BASE = '1eaef56';
const SETTINGS = { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }] };
const OLD_NAMES = ['signed', 'tradePointsTotal', 'displayPointsTotal', 'sideMeta', 'reportSigned',
  'srCsvCounts', 'srCsvHeader', 'srCsvCells', 'tradeCsvHeader', 'tradeCsvRow', 'reportCsvHeader', 'reportCsvRow', 'firstTradeIdPerDate',
  'CONTEXT_CSV_MANUAL', 'CONTEXT_CSV_DERIVED', 'CONTEXT_CSV_DAY', 'csvBool', 'emptyDayNoteCells', 'contextCsvHeader', 'contextCsvCells', 'journalCsvTable', 'reportCsvTable'];
const NEW_NAMES = OLD_NAMES.map(n => ({ srCsvCounts: 'levelCsvCount', srCsvHeader: 'levelCsvHeader', srCsvCells: 'levelCsvCells' })[n] || n);
const plain = v => JSON.parse(JSON.stringify(v));

const REPLACED = /^SR→(TG|SL) \d+ /;
const REMOVED = new Set(['Vybraná likvidita', 'Profil cesty k cíli', 'Hladina vstupu – netest/test',
  'První překážka – ticky (dopočet)', 'Cesta k cíli (dopočet)', 'Volná cesta R (dopočet)', 'SL za zónou – ticky (dopočet)', 'Zón chránících SL (dopočet)']);
// Sloupec zůstává na svém místě, ale jeho hodnota se ZÁMĚRNĚ přepočítává jinak:
// „doplněno zpětně" platí až po lhůtě od uložení obchodu (výchozí 30 minut),
// ne hned po čase výstupu. Pravidlo se tím jen uvolnilo – „ano" se smí změnit
// na „ne", nikdy naopak.
const RELAXED = new Set(['Známka doplněná zpětně (dopočet)']);

function gitShow(file) {
  return execFileSync('git', ['show', BASE + ':' + file], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
}

// Starý kód musí běžet se STARÝMI moduly (FJContext tehdy počítal cestu k cíli
// a zóny u SL) – jinak by „před" nebylo to, co aplikace opravdu exportovala.
function oldWorld() {
  try {
    const load = (file, requireMap) => {
      const mod = { exports: {} };
      new Function('module', 'exports', 'require', gitShow(file))(mod, mod.exports, name => {
        if (!(name in requireMap)) throw new Error('nečekaný require ' + name);
        return requireMap[name];
      });
      return mod.exports;
    };
    const points = load('app/points.js', {});
    const taxonomy = load('app/taxonomy.js', {});
    const context = load('app/context.js', { './points.js': points, './taxonomy.js': taxonomy });
    const renderer = loadFromSource(inlineScripts(gitShow('app/index.html')), OLD_NAMES,
      { settings: SETTINGS, activeJournalId: 'j1', journalProfiles: [], FJPoints: points, FJTaxonomy: taxonomy, FJContext: context });
    return { renderer, points };
  } catch {
    return null;
  }
}
const OLD = oldWorld();
const SKIP_OLD = OLD ? false : 'git show ' + BASE + ' nejde (chybí git nebo historie?) – porovnání nelze ověřit';
const newRenderer = () => loadFromSource(inlineScripts(readRepoFile('app/index.html')), NEW_NAMES, { settings: SETTINGS, activeJournalId: 'j1', journalProfiles: [] });
// Převod obchodu stejný, jaký dělá migrace deníku (runContextV3Migration).
const migrate = t => FJTaxonomy.convertLegacyNear(FJTaxonomy.stripRemovedV3(t));

// Buňka tak, jak ji export zapíše do souboru (prázdná hodnota = prázdný text).
const cell = v => String(v ?? '');

// Každý sloupec „před", který není nahrazený ani smazaný, musí být v „po":
// ve stejném pořadí a se stejnými buňkami. Vrací počet porovnaných buněk.
function assertKeptColumnsIdentical(before, after, label) {
  assert.equal(after.length, before.length, label + ': počet řádků');
  const kept = before[0].map((name, index) => ({ name, index })).filter(c => !REPLACED.test(c.name) && !REMOVED.has(c.name));
  assert.ok(kept.length > 60, label + ': porovnává se většina sloupců (' + kept.length + ')');
  const positions = kept.map(c => {
    const at = after[0].indexOf(c.name);
    assert.ok(at >= 0, `${label}: sloupec „${c.name}“ z exportu zmizel`);
    assert.equal(after[0].lastIndexOf(c.name), at, `${label}: sloupec „${c.name}“ je v exportu dvakrát`);
    return at;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `${label}: sloupec „${kept[i].name}“ je v exportu před sloupcem „${kept[i - 1].name}“ – pořadí se změnilo`);
  }
  let cells = 0;
  for (let row = 1; row < before.length; row++) {
    kept.forEach((c, i) => {
      const was = cell(before[row][c.index]), now = cell(after[row][positions[i]]);
      if (RELAXED.has(c.name)) {
        assert.ok(now === was || (was === 'ano' && now === 'ne'), `${label}: řádek ${row}, sloupec „${c.name}“: ${was || 'prázdné'} → ${now || 'prázdné'}`);
        return;
      }
      assert.equal(now, was, `${label}: řádek ${row}, sloupec „${c.name}“`);
      cells++;
    });
  }
  for (const name of after[0]) assert.ok(!REPLACED.test(name) && !REMOVED.has(name), `${label}: sloupec „${name}“ měl zmizet`);
  return cells;
}

const TRADES = [
  { id: 'a', instrument: 'MES', date: '2026-10-09', entryTime: '15:31', exitTime: '15:40', side: 'long', entryPrice: 7800, exitPrice: 7804,
    result: 'target', pnl: 18.1, pnlRaw: 18.1, commission: 1.9, contracts: 1, points: 4, slPrice: 7798, setupCode: 'M2_OF', fillStatus: 'FILLED', trend: 'LONG',
    entryLevels: ['VAH'], entryLevelTests: { VAH: 'UNTESTED' }, targetLevel1: { type: 'VAH', price: 7804 }, trendHtf: 'UP', absLocation: 'EXTREME', entryTestNo: '1',
    liquiditySwept: 'YES', pathProfile: 'LVN', grade: 'A', gradeSetAt: '2026-10-09T13:00:00.000Z', ofConfirm: ['ABS_BID'],
    srTarget: [{ level: 'VWAP', price: 7801, ticksFromEntry: 4, testState: 'TESTED' }],
    srStopLoss: [{ level: 'VAL', price: 7799, ticksFromEntry: 4 }, { level: 'VPOC_DAY', price: 7800.5, ticksFromEntry: 2 }] },
  { id: 'b', instrument: 'MES', date: '2026-10-09', entryTime: '16:10', exitTime: '16:12', side: 'short', entryPrice: 7810, exitPrice: 7812,
    result: 'stoploss', pnl: 11.9, pnlRaw: -11.9, commission: 1.9, contracts: 1, points: 2, slPrice: 7812, srTargetNone: true, srStopLossNone: true,
    targetLevel1: { type: 'MANUAL_EXIT', price: 7802 }, wouldSkipLive: true },
  { id: 'c', instrument: 'MES', date: '2026-10-10', entryTime: '09:15', side: 'long', entryPrice: 7790, exitPrice: 7790, result: 'breakeven', pnl: 1.9, pnlRaw: -1.9,
    srTarget: [{ level: 'VAH', price: null, ticksFromEntry: null }] }
];
const DAY_NOTES = { '2026-10-09': { comment: 'den', preview: '', notes: 'pozn', images: [], dayContext: { openVsValue: 'GAP_UP', dayTypeActual: 'P', newsEvent: 'CPI' } } };

test('A7/10: export Deníku – syntetické obchody: mimo nahrazené / smazané sloupce identický', { skip: SKIP_OLD }, t => {
  const opts = { tickSizeOf: i => OLD.points.tickSizeFor(i, SETTINGS.templates), config: {}, mode: 'LIVE' };
  const before = OLD.renderer.journalCsvTable(TRADES, d => DAY_NOTES[d] || null, opts);
  const NEW = newRenderer();
  const now = { ...opts, tickSizeOf: i => FJPoints.tickSizeFor(i, SETTINGS.templates) };
  const after = NEW.journalCsvTable(TRADES.map(migrate), d => DAY_NOTES[d] || null, now);
  t.diagnostic('porovnáno buněk: ' + assertKeptColumnsIdentical(before, after, 'deník'));
  // Deník, který ještě nebyl otevřen (starý tvar na disku), dá týž export.
  assert.deepEqual(plain(NEW.journalCsvTable(TRADES, d => DAY_NOTES[d] || null, now)), plain(after), 'starý tvar se čte stejným převodem');
});

test('A7/10: export Reportů – syntetické obchody ze dvou deníků', { skip: SKIP_OLD }, t => {
  const rows = TRADES.map((trade, i) => ({ ...trade, journalId: i ? 'j2' : 'j1', journalName: i ? 'B' : 'A' }));
  const notes = { 'j1|2026-10-09': DAY_NOTES['2026-10-09'] };
  const journals = { j1: { mode: 'LIVE' }, j2: { mode: 'BACKTEST' } };
  const before = OLD.renderer.reportCsvTable(rows, rows, k => notes[k] || null, journals);
  const migrated = rows.map(migrate);
  const after = newRenderer().reportCsvTable(migrated, migrated, k => notes[k] || null, journals);
  t.diagnostic('porovnáno buněk: ' + assertKeptColumnsIdentical(before, after, 'reporty'));
});

test('A6: sloupce kontextu – ruční pole, blok hladin místo SR, dopočty s „(dopočet)“, kontext dne na každém řádku', () => {
  const table = newRenderer().journalCsvTable(TRADES.map(migrate), d => DAY_NOTES[d] || null, { tickSizeOf: () => 0.25, config: {}, mode: 'LIVE' });
  const h = table[0];
  const rec = row => Object.fromEntries(h.map((name, i) => [name, row[i]]));
  const a = rec(table[1]), b = rec(table[2]), c = rec(table[3]);
  // ruční pole
  assert.equal(a['Trend'], 'LONG', 'sloupec trendu 1m se dál jmenuje „Trend“');
  assert.equal(a['Trend 30m'], 'UP');
  assert.equal(a['Absorpce – kde'], 'EXTREME');
  assert.equal(a['Kolikátý test vstupu'], '1');
  assert.equal(a['Známka'], 'A');
  assert.equal(a['Známka zadána'], '2026-10-09T13:00:00.000Z');
  assert.equal(a['Známka změněna dodatečně'], 'ne');
  assert.equal(a['Známka doplněná zpětně (dopočet)'], 'ne', 'zadána 15:00 Berlín, výstup 15:40');
  // blok hladin: řádky obou původních seznamů za sebou
  assert.deepEqual([a['Hladina 1 typ'], a['Hladina 1 cena'], a['Hladina 1 test']], ['VWAP', 7801, 'TESTED']);
  assert.deepEqual([a['Hladina 1 od vstupu (dopočet)'], a['Hladina 1 od SL (dopočet)'], a['Hladina 1 do cíle (dopočet)'], a['Hladina 1 poloha (dopočet)']], [4, 12, 12, 'ENTRY_TO_TARGET']);
  assert.deepEqual([a['Hladina 2 typ'], a['Hladina 2 od vstupu (dopočet)'], a['Hladina 2 poloha (dopočet)']], ['VAL', -4, 'STOP_TO_ENTRY']);
  assert.deepEqual([a['Hladina 3 typ'], a['Hladina 3 od vstupu (dopočet)'], a['Hladina 3 od SL (dopočet)'], a['Hladina 3 poloha (dopočet)']], ['VPOC_DAY', 2, 10, 'ENTRY_TO_TARGET'],
    'hladina nad vstupem do longu');
  assert.equal(b['Žádná hladina v blízkosti'], 'ano', 'obě původní strany „žádná“');
  assert.deepEqual([c['Hladina 1 typ'], c['Hladina 1 cena'], c['Hladina 1 od vstupu (dopočet)'], c['Hladina 1 poloha (dopočet)']], ['VAH', '', '', ''], 'řádek bez ceny: prázdné buňky, nikdy 0');
  // dopočty na obchodu
  assert.equal(a['Ticky k cíli (dopočet)'], 16);
  assert.equal(a['Cíl na hladině (dopočet)'], 'ano');
  assert.equal(a['Nejbližší hladina ve směru – ticky (dopočet)'], 2);
  assert.equal(a['SL za hladinou – ticky (dopočet)'], 4);
  assert.equal(a['Hladin mezi SL a vstupem (dopočet)'], 1);
  assert.equal(a['Hladin před cílem (dopočet)'], 2);
  assert.equal(a['Obchod dne č. (dopočet)'], 1);
  assert.equal(a['Předchozí výsledek dne (dopočet)'], 'FIRST');
  assert.equal(a['Seance (dopočet)'], 'US_OPEN');
  assert.equal(b['Obchod dne č. (dopočet)'], 2);
  assert.equal(b['Předchozí výsledek dne (dopočet)'], 'target');
  assert.equal(b['P/L dne před obchodem (dopočet)'], 18.1);
  assert.equal(b['Cíl na hladině (dopočet)'], 'ne', 'ruční výstup není hladina');
  assert.equal(b['Hladin před cílem (dopočet)'], 0);
  assert.equal(c['Seance (dopočet)'], 'EU_MORNING');
  // chybějící vstup = prázdná buňka, nikdy 0
  assert.equal(c['Ticky k cíli (dopočet)'], '');
  assert.equal(c['Hladin před cílem (dopočet)'], '', 'řádek bez polohy – počet nejde tvrdit');
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
  for (const name of h) if (/od vstupu|od SL|do cíle|poloha|Seance|Nejbližší hladina|Obchod dne/.test(name)) assert.match(name, /\(dopočet\)$/, name);
  assert.doesNotMatch(h.join('|'), /Trend 30m \(dopočet\)|Známka \(dopočet\)|typ \(dopočet\)|cena \(dopočet\)/);
});

const LIVE = paths.journalSources();
test('A7/10: export Deníku – živé deníky z ai-export: mimo nahrazené / smazané sloupce identický',
  { skip: SKIP_OLD || (LIVE.length ? false : 'ai-export nenalezen (' + paths.dataRoots().join(', ') + ')') }, t => {
    const NEW = newRenderer();
    let cells = 0, tradesChecked = 0;
    for (const file of LIVE) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      // `derived` přidává až export – v deníku na obchodu není.
      const trades = (data.trades || []).filter(tr => tr.recordType !== 'SETUP_ONLY').map(({ derived, ...tr }) => tr);
      if (!trades.length) continue;
      const notes = data.dayNotes || {};
      const opts = { config: data.taxonomy || {}, mode: 'LIVE' };
      const before = OLD.renderer.journalCsvTable(trades, d => notes[d] || null, { ...opts, tickSizeOf: i => OLD.points.tickSizeFor(i, []) });
      const after = NEW.journalCsvTable(trades.map(migrate), d => notes[d] || null, { ...opts, config: FJTaxonomy.migrateConfigV3(opts.config), tickSizeOf: i => FJPoints.tickSizeFor(i, []) });
      cells += assertKeptColumnsIdentical(before, after, path.basename(file));
      tradesChecked += trades.length;
    }
    assert.ok(tradesChecked > 0, 'aspoň jeden obchod ověřen');
    t.diagnostic(`živé deníky: ${tradesChecked} obchodů, ${cells} buněk identických`);
  });
