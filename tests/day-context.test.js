'use strict';
// Kontext obchodu v2, krok 5 (docs/ZADANI_KONTEXT.md A5, A7 test 11):
// kontext dne – jednou za den a deník, uložený v dayNotes[date].dayContext.
//
// Proč dayNotes a ne nová top-level entita: readJournal() v main.js je
// whitelist top-level klíčů a co v něm není, tiše zahodí (u dayNotes samotných
// se to už jednou stalo). dayNotes se čte vcelku, takže kontext dne uvnitř
// přežije bez zásahu do whitelistu – a tenhle test to hlídá.
//
// Druhé místo, kde by se kontext dne ztratil: saveDayNote v rendereru maže
// poznámku, která je „prázdná" – a do 4.8.0 znal jen komentář, náhled,
// poznámky a obrázky. Den, kde je vyplněný jen kontext, by se smazal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { loadRenderer, loadMain } = require('./helpers/extract');
const FJContext = require('../app/context.js');

const plain = v => JSON.parse(JSON.stringify(v));
const CONTEXT = { openVsValue: 'GAP_UP', dayTypeExpected: 'TREND_UP', newsEvent: 'CPI' };

test('A5: číselníky kontextu dne s klíči ze zadání', () => {
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.openVsValue), ['IN_VA', 'ABOVE_VAH', 'BELOW_VAL', 'GAP_UP', 'GAP_DOWN']);
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.dayTypeExpected), ['TREND_UP', 'TREND_DOWN', 'BALANCE_D', 'P', 'b', 'DOUBLE_DIST', 'UNKNOWN']);
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.dayTypeActual), Object.keys(FJContext.DAY_CONTEXT.dayTypeExpected));
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.valueMigration), ['HIGHER', 'LOWER', 'OVERLAP']);
  assert.deepEqual(Object.keys(FJContext.DAY_CONTEXT.newsEvent), ['NONE', 'CPI', 'FOMC', 'NFP', 'OTHER']);
  assert.deepEqual(FJContext.DAY_CONTEXT_MORNING, ['openVsValue', 'dayTypeExpected', 'newsEvent']);
});

test('A5: očista kontextu dne – jen známá pole a hodnoty, prázdné = null', () => {
  assert.deepEqual(FJContext.sanitizeDayContext({ ...CONTEXT, valueMigration: 'SIDEWAYS', foo: 'x' }), CONTEXT);
  assert.equal(FJContext.sanitizeDayContext({}), null);
  assert.equal(FJContext.sanitizeDayContext(null), null);
  assert.equal(FJContext.sanitizeDayContext({ dayTypeActual: 'b' }).dayTypeActual, 'b', 'malé b je platný klíč (b-profil)');
});

test('A7/11: dayContext přežije readJournal() a zápis v main procesu', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-daycontext-'));
  try {
    const main = loadMain(['safeJournalId', 'journalPath', 'readJournal', 'writeJournalFile'], {
      fs, path, dataRoot: () => root,
      defaultJournalData: () => ({ trades: [], settings: [] }),
      deflateJournalImages: () => 0,
      backupJournalFile: () => { throw new Error('záloha se tu dělat nemá'); },
      logInfo: () => {}
    });
    main.writeJournalFile('j1', { trades: [], settings: [], dayNotes: { '2026-10-09': { comment: '', preview: '', notes: '', images: [], dayContext: CONTEXT } } });
    const first = main.readJournal('j1');
    assert.deepEqual(plain(first.dayNotes['2026-10-09'].dayContext), CONTEXT);
    main.writeJournalFile('j1', first);
    assert.deepEqual(plain(main.readJournal('j1').dayNotes['2026-10-09'].dayContext), CONTEXT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function rendererJournal(initial) {
  const r = loadRenderer(['SCHEMA_VERSION', 'ensureActiveJournalData', 'commitJournal', 'emptyDayNote', 'getDayNote', 'saveDayNote', 'saveDayContext'], {
    db: { data: initial, close() {} },
    activeJournalId: 'j1',
    window: { desktopAPI: { writeJournal: async () => ({ ok: true }) } }
  });
  return { ...r, data: () => vm.runInContext('db.data', r.__context) };
}

test('A7/11: den jen s kontextem dne se při uložení nesmaže', async () => {
  const j = rendererJournal({ trades: [], settings: [], dayNotes: {} });
  await j.saveDayContext('2026-10-09', CONTEXT);
  assert.deepEqual(plain(j.data().dayNotes['2026-10-09'].dayContext), CONTEXT);
  // Uložení jiného pole dne (komentář) kontext nesmaže.
  await j.saveDayNote('2026-10-09', { comment: 'x' });
  await j.saveDayNote('2026-10-09', { comment: '' });
  assert.deepEqual(plain(j.data().dayNotes['2026-10-09'].dayContext), CONTEXT, 'poznámka s kontextem není prázdná');
  assert.deepEqual(plain(j.getDayNote('2026-10-09').dayContext), CONTEXT);
});

test('A5: kontext dne se doplňuje po polích – večerní pole nepřepíše ranní', async () => {
  const j = rendererJournal({ trades: [], settings: [], dayNotes: { '2026-10-09': { comment: 'ráno', images: [] } } });
  await j.saveDayContext('2026-10-09', { openVsValue: 'IN_VA' });
  await j.saveDayContext('2026-10-09', { dayTypeActual: 'P', valueMigration: 'HIGHER' });
  assert.deepEqual(plain(j.data().dayNotes['2026-10-09']), { comment: 'ráno', images: [], dayContext: { openVsValue: 'IN_VA', dayTypeActual: 'P', valueMigration: 'HIGHER' } });
  await j.saveDayContext('2026-10-09', { openVsValue: '' });
  assert.equal(j.data().dayNotes['2026-10-09'].dayContext.openVsValue, undefined, 'prázdná volba pole smaže');
  await j.saveDayContext('2026-10-09', { dayTypeActual: '', valueMigration: '' });
  assert.equal(j.data().dayNotes['2026-10-09'].dayContext, undefined, 'prázdný kontext se neukládá');
  assert.equal(j.data().dayNotes['2026-10-09'].comment, 'ráno');
});

// ---------------------------------------------- 4.8.2: kontext dne předem
// Ranní kontext patří PŘED první obchod. Do 4.8.1 šel zadat jen v detailu
// dne v Kalendáři (klikat šlo jen na den s obchody) a v ranním pruhu
// Rychlého kontextu (otevře se jen s obchody) – den bez obchodů neměl kde.

const { readRepoFile } = require('./helpers/extract');

function calendarGrid(trades, dayNotes = {}, scope = '') {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { id, value: id === 'calendarJournal' ? scope : '', textContent: '', innerHTML: '', style: {} }); return nodes.get(id); };
  const r = loadRenderer([
    'isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive', 'readIncludeSkipLive', 'includeSkipLive', 'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup', 'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude', 'performanceRecords',
    'computeDrawdownByDate', 'evaluateDayRisk', 'getCalendarRows', 'computeOverallStats', 'renderCalendar', 'renderCalendarMonthSummary',
    'emptyDayNote', 'getDayNote', 'dayContextSummary'
  ], {
    settings: { startingBalance: 10000, usdCzkRate: 23, risk: {}, templates: [] }, trades, calendarAllTrades: [], calendarDate: new Date(2026, 9, 1),
    db: { data: { dayNotes } }, FJContext, visibleJournalProfiles: () => [],
    $, dualMoney: v => `[${v}]`, dualMoneyText: v => String(v), money: v => String(v), esc: v => String(v), Intl
  });
  r.renderCalendar();
  return nodes.get('calendarGrid').innerHTML;
}

test('4.8.2: v Kalendáři jde kliknout i na den bez obchodů (i budoucí)', () => {
  const grid = calendarGrid([{ id: 'a', date: '2026-10-01', entryTime: '15:30', instrument: 'MES', result: 'target', pnl: 5, pnlRaw: 5, contracts: 1 }]);
  assert.match(grid, /data-date="2026-10-01" onclick="showDay\('2026-10-01'\)"/);
  assert.match(grid, /<div class="day  [^"]*" data-date="2026-10-20" onclick="showDay\('2026-10-20'\)"/, 'prázdný den je klikací');
  assert.doesNotMatch(grid, /week-summary"[^>]*onclick/, 'součet týdne není den');
});

test('4.8.2: den s kontextem dne má v Kalendáři ☀, jen u aktivního deníku', () => {
  const notes = { '2026-10-20': { dayContext: { openVsValue: 'GAP_UP', newsEvent: 'CPI' } } };
  const grid = calendarGrid([], notes);
  const cell = grid.split('data-date="').find(c => c.startsWith('2026-10-20'));
  const summary = FJContext.DAY_CONTEXT.openVsValue.GAP_UP + ' · ' + FJContext.DAY_CONTEXT.newsEvent.CPI;
  assert.ok(cell.includes(`<div class="day-ctx-flag" title="Kontext dne: ${summary}">☀</div>`), cell);
  assert.equal((grid.match(/day-ctx-flag/g) || []).length, 1, 'jen den s kontextem');
  assert.equal((calendarGrid([], notes, 'all').match(/day-ctx-flag/g) || []).length, 0, 'přes všechny deníky ne – kontext patří deníku');
});

test('4.8.2: detail dne bez obchodů ukáže kontext dne a „zatím nemá obchody"', () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', className: '' }); return nodes.get(id); };
  const ctx = { $, window: {}, rendered: [], getCalendarRows: () => [], computeDrawdownByDate: () => ({}), evaluateDayRisk: () => ({ violations: [], achievements: [] }), tradeHTML: () => 'X' };
  const r = loadRenderer([], ctx);
  vm.runInContext('renderDayContextBox=d=>rendered.push(d);' + extractShowDay(), r.__context);
  vm.runInContext('window.showDay("2026-10-20")', r.__context);
  assert.deepEqual(plain(vm.runInContext('rendered', r.__context)), ['2026-10-20']);
  assert.equal(nodes.get('dayTrades').innerHTML, '<div class="sub">Tento den zatím nemá obchody.</div>');
});

function extractShowDay() {
  const html = readRepoFile('app/index.html');
  const start = html.indexOf('window.showDay=date=>{');
  const end = html.indexOf('\n};', start);
  return html.slice(start, end + 3);
}

test('4.8.2: renderer kontextu dne do okna v Deníku – bez omezení Kalendáře', () => {
  const box = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { id, value: id === 'calendarJournal' ? 'all' : '', innerHTML: '' }); return nodes.get(id); };
  const r = loadRenderer(['emptyDayNote', 'getDayNote', 'renderDayContextBox'], {
    $, FJContext, esc: v => String(v), db: { data: { dayNotes: { '2026-10-20': { dayContext: { openVsValue: 'GAP_UP' } } } } }
  });
  r.renderDayContextBox('2026-10-20', box, { onSaved() {} });
  assert.match(box.innerHTML, /Kontext dne 2026-10-20/, 'výběr deníku v Kalendáři okno v Deníku neblokuje');
  assert.match(box.innerHTML, /data-value="GAP_UP" role="button"/);
  assert.match(box.innerHTML, /chip on" data-value="GAP_UP"/, 'uložená volba je vybraná');
  const cal = { innerHTML: '' };
  r.renderDayContextBox('2026-10-20', cal);
  assert.match(cal.innerHTML, /jen u aktivního deníku/, 'Kalendář přes všechny deníky dál neupravuje');
  r.renderDayContextBox('', box, { onSaved() {} });
  assert.match(box.innerHTML, /Vyber datum/);
});

test('4.8.2: tlačítko ☀ Kontext dne ukáže ✓, když má dnešek ranní kontext kompletní', () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { id, textContent: '' }); return nodes.get(id); };
  const today = new Date(2026, 9, 10, 8, 30);
  const run = dayNotes => {
    const r = loadRenderer(['emptyDayNote', 'getDayNote', 'localDateStr', 'morningContextDone', 'renderDayContextBtn'], {
      $, FJContext, db: { data: { dayNotes } }, Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(today); } }
    });
    assert.equal(r.localDateStr(), '2026-10-10', 'místní datum, ne UTC');
    r.renderDayContextBtn();
    return nodes.get('dayContextBtn').textContent;
  };
  assert.equal(run({}), '☀ Kontext dne');
  assert.equal(run({ '2026-10-10': { dayContext: { openVsValue: 'IN_VA', dayTypeExpected: 'P' } } }), '☀ Kontext dne', 'chybí zprávy');
  assert.equal(run({ '2026-10-10': { dayContext: { openVsValue: 'IN_VA', dayTypeExpected: 'P', newsEvent: 'NONE' } } }), '☀ Kontext dne ✓');
});

test('4.8.2: Deník má tlačítko a okno kontextu dne s nativním datem', () => {
  const html = readRepoFile('app/index.html');
  assert.match(html, /<button class="btn" id="dayContextBtn" type="button"[^>]*>☀ Kontext dne<\/button>/);
  assert.match(html, /<div class="modal" id="dayContextModal">[\s\S]*?<input type="date" id="dayContextDate">[\s\S]*?<div id="dayContextModalBox"><\/div>/);
});
