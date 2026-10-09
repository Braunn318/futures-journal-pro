'use strict';
// Kontext obchodu v2, krok 2 (docs/ZADANI_KONTEXT.md A1, A7 testy 1–4) a režim
// deníku (živý / backtest).
//
// Strana SR řádku je VÝZNAM, ne poloha: zóna chránící SL leží mezi SL a cenou
// trhu, takže může stát i na vstupu nebo nad vstupem do longu. Deník stranu
// nepřepočítává, jen dopočítá znaménkové ticky a příznaky. Blokuje se jen cíl
// nebo SL na špatné straně vstupu – a i to jen u hodnoty zadané ručně, ne
// u dopočtu z výstupu.
//
// Fixtury jsou syntetické a nesou jen ceny (bez P/L a účtu). Odpovídají třem
// obchodům s cílem na ztrátové straně z tabulky A1.2 a obchodu 9. 10. 17:15.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJContext = require('../app/context.js');

const TICK = 0.25;

const trade = overrides => ({
  instrument: 'MES', date: '2026-10-09', entryTime: '17:00', side: 'long', entryPrice: 7800,
  slPrice: 7798, targetLevel1: { type: 'VAH', price: 7804 }, ...overrides
});

// ------------------------------------------------- 1. znaménkové ticky

test('A7/1: ticksFromEntrySigned – kladné k cíli, záporné k SL, u longu i shortu', () => {
  const long = trade();
  assert.equal(FJContext.srRowMetrics('srTarget', { level: 'VAH', price: 7801.5 }, long, TICK).ticksFromEntrySigned, 6);
  assert.equal(FJContext.srRowMetrics('srStopLoss', { level: 'VAL', price: 7799.5 }, long, TICK).ticksFromEntrySigned, -2);

  const short = trade({ side: 'short', slPrice: 7802, targetLevel1: { type: 'VAL', price: 7796 } });
  assert.equal(FJContext.srRowMetrics('srTarget', { level: 'VAL', price: 7798.5 }, short, TICK).ticksFromEntrySigned, 6, 'short: pod vstupem = k cíli');
  assert.equal(FJContext.srRowMetrics('srStopLoss', { level: 'VAH', price: 7800.5 }, short, TICK).ticksFromEntrySigned, -2, 'short: nad vstupem = k SL');
});

test('A7/1: ticksFromStop sedí na cenu SL; bez ceny řádku nic nedopočítává (null, ne 0)', () => {
  const long = trade();
  const m = FJContext.srRowMetrics('srStopLoss', { level: 'VAL', price: 7799.5 }, long, TICK);
  assert.equal(m.ticksFromStop, 6, '7799.5 − 7798 = 1.5 b = 6 t');
  assert.equal(FJContext.srRowMetrics('srTarget', { level: 'VAH', price: 7801 }, long, TICK).ticksFromStop, null, 'u SR proti targetu se od SL neměří');

  const bare = FJContext.srRowMetrics('srStopLoss', { level: 'VAL', price: null, ticksFromEntry: 4 }, long, TICK);
  assert.equal(bare.ticksFromEntrySigned, null, 'bez ceny se znaménko nedopočítává');
  assert.equal(bare.ticksFromStop, null);
  assert.equal(FJContext.srRowMetrics('srStopLoss', { level: 'VAL', price: 7799.5 }, trade({ slPrice: null }), TICK).ticksFromStop, null, 'bez SL null');
  assert.equal(FJContext.srRowMetrics('srTarget', { level: 'VAH', price: 7801 }, long, null).ticksFromEntrySigned, null, 'bez velikosti ticku null');
});

// ------------------------------------------------- 2. blokace cíle / SL

const WRONG_TARGET_FIXTURES = [
  { name: '2. 10. 15:44 short, cíl 779475 (překlep)', t: trade({ side: 'short', entryPrice: 7799.75, slPrice: 7802.25, targetLevel1: { type: 'LVN', price: 779475 } }) },
  { name: '5. 10. 18:18 long ze 7811, cíl 7783', t: trade({ side: 'long', entryPrice: 7811, slPrice: 7809.75, targetLevel1: { type: 'VPOC_1M', price: 7783 } }) },
  { name: '9. 10. 17:01 long, cíl = cena SL', t: trade({ side: 'long', entryPrice: 7847.75, slPrice: 7845.25, targetLevel1: { type: 'CUSTOM_FIX_RRR', price: 7845.25 } }) }
];

for (const { name, t } of WRONG_TARGET_FIXTURES) {
  test('A7/2: cíl na ztrátové straně blokuje – ' + name, () => {
    const issues = FJContext.blockingIssues(t);
    assert.deepEqual(issues.map(i => i.field), ['targetLevel1Price']);
    assert.equal(issues[0].code, 'TARGET_WRONG_SIDE');
  });
}

test('A7/2: SL na ziskové straně blokuje; dopočtený SL / cíl se nekontroluje', () => {
  assert.deepEqual(FJContext.blockingIssues(trade({ slPrice: 7801 })).map(i => i.code), ['SL_WRONG_SIDE']);
  assert.deepEqual(FJContext.blockingIssues(trade({ slPrice: 7800 })).map(i => i.code), ['SL_WRONG_SIDE'], 'SL na vstupu není ztrátová strana');
  // SL odvozený z výstupu nohy (trail do BE+) leží legitimně v zisku – není to vstup.
  assert.deepEqual(FJContext.blockingIssues(trade({ slPrice: 7801, slDerived: true })), []);
  assert.deepEqual(FJContext.blockingIssues(trade({ targetLevel1: { type: 'VAH', price: 7790 }, targetLevel1PriceDerived: true })), []);
  assert.deepEqual(FJContext.blockingIssues(trade()), [], 'správný obchod nic nehlásí');
  assert.deepEqual(FJContext.blockingIssues(trade({ side: '' , targetLevel1: { type: 'VAH', price: 7790 } })), [], 'bez směru se nekontroluje');
  assert.deepEqual(FJContext.blockingIssues(trade({ entryPrice: '', slPrice: 7801 })), [], 'bez vstupu se nekontroluje');
});

test('A7/2: chybná hodnota se neuloží, dokud ji Adam vědomě nepotvrdí', async () => {
  const { confirmBlockingIssues } = loadRenderer(['confirmBlockingIssues', 'markBlockingIssues'], { FJContext, $: () => null });
  const bad = WRONG_TARGET_FIXTURES[1].t;
  const asked = [];
  assert.equal(await confirmBlockingIssues(bad, async msg => { asked.push(msg); return false; }), false, '„Opravit" = neukládat');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /7783/);
  assert.equal(await confirmBlockingIssues(bad, async () => true), true, '„Uložit i tak" = uložit');
  let called = false;
  assert.equal(await confirmBlockingIssues(trade(), async () => { called = true; return false; }), true, 'bez chyby se neptá');
  assert.equal(called, false);
});

// ------------------------------------------------- 3. zóna chránící SL na / nad vstupem

test('A7/3: fixtura 9. 10. 17:15 – zóna u SL na vstupu i „nad" vstupem se uloží bez varování', () => {
  const t = trade({
    side: 'short', entryPrice: 7847.25, slPrice: 7849.25, targetLevel1: { type: 'CUSTOM_FIX_RRR', price: 7843.25 },
    srStopLoss: [{ level: 'M2_EDGE', price: 7847.75, ticksFromEntry: 2 }, { level: 'CUSTOM_GAMMA', price: 7847, ticksFromEntry: 1 }]
  });
  assert.deepEqual(FJContext.blockingIssues(t), []);
  for (const row of t.srStopLoss) {
    const m = FJContext.srRowMetrics('srStopLoss', row, t, TICK);
    assert.equal(m.beyondStop, false, row.level);
    assert.deepEqual(FJContext.srRowNotes('srStopLoss', row, t, TICK), [], row.level + ': žádné varování');
  }
  assert.equal(FJContext.srRowMetrics('srStopLoss', t.srStopLoss[1], t, TICK).ticksFromEntrySigned, 1, 'GAMMA leží 1 t směrem k cíli – platné');

  const long = trade({ srStopLoss: [{ level: 'VAH', price: 7800 }, { level: 'LTA_LEVEL', price: 7800.5 }] });
  for (const row of long.srStopLoss) {
    assert.deepEqual(FJContext.srRowNotes('srStopLoss', row, long, TICK), [], 'long: zóna na vstupu (0 t) i 2 t nad vstupem');
    assert.equal(FJContext.srRowMetrics('srStopLoss', row, long, TICK).beyondStop, false);
  }
  assert.deepEqual(FJContext.dataCheckIssues(long, 'BACKTEST'), []);
});

test('A7/3: zóna za SL dostane beyondStop (jen informace, neblokuje)', () => {
  const t = trade({ srStopLoss: [{ level: 'VAL', price: 7797 }] });
  assert.equal(FJContext.srRowMetrics('srStopLoss', t.srStopLoss[0], t, TICK).beyondStop, true);
  assert.deepEqual(FJContext.blockingIssues(t), []);
});

// ------------------------------------------------- 4. SR proti targetu za vstupem

test('A7/4: SR proti targetu na ztrátové straně → behindEntry, uloží se', () => {
  const t = trade({ srTarget: [{ level: 'VWAP', price: 7799 }] });
  const m = FJContext.srRowMetrics('srTarget', t.srTarget[0], t, TICK);
  assert.equal(m.behindEntry, true);
  assert.equal(m.ticksFromEntrySigned, -4);
  assert.deepEqual(FJContext.blockingIssues(t), []);
  assert.equal(FJContext.srRowNotes('srTarget', t.srTarget[0], t, TICK).length, 1, 'jemné upozornění');
  assert.equal(FJContext.srRowMetrics('srTarget', { level: 'VWAP', price: 7802 }, t, TICK).behindEntry, false);
  assert.equal(FJContext.srRowMetrics('srTarget', { level: 'VWAP', price: 7806 }, t, TICK).beyondTarget, true, 'za cílem 7804');
  assert.equal(FJContext.srRowMetrics('srTarget', { level: 'VWAP', price: 7803 }, t, TICK).beyondTarget, false);
});

// ------------------------------------------------- režim deníku

test('režim: deník bez příznaku je živý, s příznakem backtest', () => {
  assert.equal(FJContext.journalMode({ id: 'a', name: 'Phidias' }), 'LIVE');
  assert.equal(FJContext.journalMode({ id: 'a', backtest: false }), 'LIVE');
  assert.equal(FJContext.journalMode({ id: 'a', backtest: true }), 'BACKTEST');
  assert.equal(FJContext.journalMode(null), 'LIVE');
  assert.equal(FJContext.skipLiveAllowed('BACKTEST'), true);
  assert.equal(FJContext.skipLiveAllowed('LIVE'), false);
});

test('režim: backtest nenabízí „vědomě vynechán", záznam, který ho má, ho neztratí', () => {
  const all = ['FILLED', 'NO_FILL', 'MISSED', 'SKIPPED'];
  assert.deepEqual(FJContext.allowedFillStatus('LIVE', all), all);
  assert.deepEqual(FJContext.allowedFillStatus('BACKTEST', all), ['FILLED', 'NO_FILL', 'MISSED']);
  assert.deepEqual(FJContext.allowedFillStatus('BACKTEST', all, 'SKIPPED'), all);
});

test('režim: Kontrola dat – „naživo bych nevzal" v živém deníku, „vědomě vynechán" v backtestu', () => {
  const skipLive = trade({ wouldSkipLive: true });
  const skipped = trade({ fillStatus: 'SKIPPED' });
  assert.deepEqual(FJContext.dataCheckIssues(skipLive, 'LIVE').map(i => i.code), ['SKIP_LIVE_IN_LIVE']);
  assert.deepEqual(FJContext.dataCheckIssues(skipLive, 'BACKTEST'), []);
  assert.deepEqual(FJContext.dataCheckIssues(skipped, 'BACKTEST').map(i => i.code), ['SKIPPED_IN_BACKTEST']);
  assert.deepEqual(FJContext.dataCheckIssues(skipped, 'LIVE'), []);
  assert.deepEqual(FJContext.dataCheckIssues(WRONG_TARGET_FIXTURES[0].t, 'LIVE').map(i => i.code), ['TARGET_WRONG_SIDE']);
});

test('Kontrola dat: filtr v Deníku ukáže jen záznamy ke kontrole, podle režimu deníku', () => {
  const BASE = ['isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive', 'readIncludeSkipLive', 'includeSkipLive',
    'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup', 'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude',
    'performanceRecords', 'renderTrades', 'activeJournalMode', 'renderDataCheckCount'];
  const rows = [
    { id: 'ok', ...trade(), result: 'target', pnlRaw: 10 },
    { id: 'bad', ...WRONG_TARGET_FIXTURES[1].t, result: 'stoploss', pnlRaw: -5 },
    { id: 'skipLive', ...trade(), wouldSkipLive: true, result: 'target', pnlRaw: 10 },
    { id: 'skipped', ...trade(), fillStatus: 'SKIPPED', result: 'target', pnlRaw: 10 }
  ];
  const setup = { id: 'setupBad', recordType: 'SETUP_ONLY', date: '2026-10-09', entryTime: '18:00', side: 'long', plannedEntryPrice: 7800, slPrice: 7802, fillStatus: 'NO_FILL' };
  const shown = (backtest, filter) => {
    const ids = [];
    const nodes = new Map();
    const $ = id => { if (!nodes.has(id)) nodes.set(id, { id, value: { filterDataCheck: filter }[id] ?? '', innerHTML: '' }); return nodes.get(id); };
    const r = loadRenderer(BASE, {
      settings: {}, trades: rows, setupRecords: [setup], $, db: { data: { dayNotes: {} } }, extraEmptyDays: new Set(),
      journalProfiles: [{ id: 'j', name: 'J', backtest }], activeJournalId: 'j',
      dayGroupHTML: (date, dayTrades, daySetups) => { ids.push(...dayTrades.map(t => t.id), ...daySetups.map(s => s.id)); return ''; }
    });
    r.renderTrades();
    return ids.sort();
  };
  assert.deepEqual(shown(false, ''), ['bad', 'ok', 'setupBad', 'skipLive', 'skipped'], 'bez filtru vše');
  assert.deepEqual(shown(false, 'only'), ['bad', 'setupBad', 'skipLive'], 'živý deník: cíl / SL na špatné straně + naživo bych nevzal');
  assert.deepEqual(shown(true, 'only'), ['bad', 'setupBad', 'skipped'], 'backtest: cíl / SL na špatné straně + vědomě vynechán');
});

test('režim: uložení obchodu v živém deníku nezmění „naživo bych nevzal", dokud ho uživatel výslovně neodebere', () => {
  const { applySkipLiveFromForm, skipLiveFieldShown } = loadRenderer(['applySkipLiveFromForm', 'skipLiveFieldShown'], { FJContext });
  const kept = { wouldSkipLive: true, wouldSkipReason: 'CONTEXT' };
  applySkipLiveFromForm(kept, 'LIVE', 'ne', '', false);
  assert.deepEqual(kept, { wouldSkipLive: true, wouldSkipReason: 'CONTEXT' }, 'skryté pole hodnotu nesmaže');
  applySkipLiveFromForm(kept, 'LIVE', 'ano', '', true);
  assert.deepEqual(kept, { wouldSkipLive: true, wouldSkipReason: 'CONTEXT' }, 'ponechané „Ne" hodnotu ani důvod nezmění');
  applySkipLiveFromForm(kept, 'LIVE', 'ne', '', true);
  assert.deepEqual(kept, {}, 'viditelné pole přepnuté na „Ano" příznak i důvod odebere');
  const none = {};
  applySkipLiveFromForm(none, 'LIVE', 'ano', 'CONTEXT', true);
  assert.deepEqual(none, {}, 'v živém deníku se nová hodnota nezapíše');
  // Pole se v živém deníku ukáže jen u obchodu, který příznak už má.
  assert.equal(skipLiveFieldShown('LIVE', false), false);
  assert.equal(skipLiveFieldShown('LIVE', true), true);
  assert.equal(skipLiveFieldShown('BACKTEST', false), true);
  const bt = {};
  applySkipLiveFromForm(bt, 'BACKTEST', 'ano', 'CONTEXT');
  assert.deepEqual(bt, { wouldSkipLive: true, wouldSkipReason: 'CONTEXT' });
  applySkipLiveFromForm(bt, 'BACKTEST', 'ne', '');
  assert.deepEqual(bt, {}, 'v backtestu jde hodnotu vypnout jako dřív');
});

test('hromadné odebrání „naživo bych nevzal" (4.8.2): jen v živém deníku, jen příznak a důvod', () => {
  const ok = { id: 'ok', ...trade(), result: 'target' };
  const flagged = { id: 'f', ...trade(), wouldSkipLive: true, wouldSkipReason: 'CONTEXT', planFollowed: 'ne', result: 'target', pnlRaw: 10 };
  const setup = { id: 's', recordType: 'SETUP_ONLY', wouldSkipLive: true, fillStatus: 'NO_FILL' };
  const bad = { id: 'bad', ...WRONG_TARGET_FIXTURES[1].t };
  const rows = [ok, flagged, setup, bad];
  const live = FJContext.clearSkipLiveInLive(rows, 'LIVE');
  assert.equal(live.count, 2);
  assert.equal(live.records[0], ok, 'nedotčený záznam je týž objekt');
  assert.equal(live.records[3], bad);
  const { wouldSkipLive, wouldSkipReason, ...rest } = flagged;
  assert.deepEqual(live.records[1], rest, 'jen příznak a důvod, nic jiného');
  assert.deepEqual(live.records[2], { id: 's', recordType: 'SETUP_ONLY', fillStatus: 'NO_FILL' });
  assert.equal(flagged.wouldSkipLive, true, 'vstup se nemění');
  assert.deepEqual(live.records.flatMap(r => FJContext.dataCheckIssues(r, 'LIVE').map(i => i.code)), ['TARGET_WRONG_SIDE'], 'ostatní kontroly zůstanou');
  const bt = FJContext.clearSkipLiveInLive(rows, 'BACKTEST');
  assert.equal(bt.count, 0);
  assert.equal(bt.records, rows, 'v backtestu se nic nemění');
  assert.deepEqual(FJContext.clearSkipLiveInLive(null, 'LIVE'), { records: [], count: 0 });
});

test('tlačítko „Odebrat naživo bych nevzal": jen živý deník, filtr Kontrola dat a něco k odebrání', () => {
  const run = (mode, filter, rows) => {
    const nodes = new Map();
    const opt = { textContent: '' };
    const $ = id => {
      if (!nodes.has(id)) nodes.set(id, { id, value: id === 'filterDataCheck' ? filter : '', style: {}, textContent: '', querySelector: () => opt });
      return nodes.get(id);
    };
    const r = loadRenderer(['isSetupRecord', 'tradeRecords', 'isSkipLive', 'renderDataCheckCount'], { FJContext, $, trades: rows, setupRecords: [] });
    r.renderDataCheckCount(mode);
    return { display: nodes.get('clearSkipLiveBtn').style.display, text: nodes.get('clearSkipLiveBtn').textContent };
  };
  const rows = [{ id: 'a', wouldSkipLive: true }, { id: 'b' }, { id: 'c', wouldSkipLive: true }];
  assert.deepEqual(run('LIVE', 'only', rows), { display: '', text: 'Odebrat „naživo bych nevzal“ (2)' });
  assert.equal(run('LIVE', '', rows).display, 'none', 'mimo filtr Kontrola dat schované');
  assert.equal(run('BACKTEST', 'only', rows).display, 'none', 'v backtestu příznak platí');
  assert.equal(run('LIVE', 'only', [{ id: 'b' }]).display, 'none', 'nic k odebrání');
});
