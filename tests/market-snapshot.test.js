'use strict';
// Data trhu – J3: snímek trhu při vstupu (ZADANI_DENIK_SNAPSHOT_TRHU.md §J3).
//
// Konektor NT8 v6 při vstupu pošle market_snapshot; deník z něj ukáže
// signální svíčku, doplní řádky Hladin a test / netest. Ruční hodnoty vždy
// vyhrávají, nic se nepočítá do „Neúplné".

const test = require('node:test');
const assert = require('node:assert/strict');

const FJSnapshot = require('../app/market-snapshot.js');
const FJMarketBars = require('../app/market-bars.js');
const FJMarket = require('../app/market-data.js');
const FJTaxonomy = require('../app/taxonomy.js');
const FJLta = require('../app/lta-levels.js');
const { loadMain, readRepoFile } = require('./helpers/extract');

const plain = v => JSON.parse(JSON.stringify(v));
const ENTRY = '2026-11-12T11:40:30.000Z';
const at = min => new Date(Date.parse('2026-11-12T11:00:00.000Z') + min * 60000).toISOString();

// 30 uzavřených 1min svíček 11:01–11:30 + jedna po vstupu (zahodí se).
function payload(extra = {}) {
  const bars1m = [];
  for (let i = 1; i <= 30; i++) bars1m.push([at(i + 10), 7600, 7602, 7598, 7601, 100 + i, 5, [7600]]);
  bars1m.push([at(41), 7600, 7600, 7600, 7600, 9, 0, [7600]]);
  return {
    source: 'ninjatrader', type: 'market_snapshot', executionId: 'E1', root: 'ES', instrumentFull: 'ES 12-26', tradeDay: '2026-11-12', time: ENTRY,
    tradingHours: 'CME US Index Futures ETH', timeZone: 'W. Europe Standard Time',
    bars1m,
    bars30m: [[at(0), 7590, 7605, 7585, 7600, 5000, [7595], [false]], [at(30), 7600, 7610, 7595, 7608, 4000, [7606, 7604], [true, false]]],
    day: { profile: [[7590, 10], [7595, 50], [7600, 100], [7605, 40], [7610, 5]], high: 7612, low: 7580, vwap: 7601.5 },
    ...extra
  };
}

// ------------------------------------------------------- value area

test('value area: VPOC, 70 %, shoda objemů blíž středu, jedna cena', () => {
  assert.deepEqual(FJSnapshot.valueArea([[7590, 10], [7595, 50], [7600, 100], [7605, 40], [7610, 5]], 70), { vpoc: 7600, vah: 7600, val: 7595 });
  // 205 celkem, 70 % = 143.5: 100 + 50 (dolů, větší) = 150
  assert.deepEqual(FJSnapshot.valueArea([[1, 10], [2, 10], [3, 10], [4, 10], [5, 10]], 70).vpoc, 3, 'shoda objemů → blíž středu');
  assert.deepEqual(FJSnapshot.valueArea([[7600, 5]], 70), { vpoc: 7600, vah: 7600, val: 7600 });
  assert.equal(FJSnapshot.valueArea([], 70), null);
  assert.deepEqual(FJSnapshot.valueArea([[10, 1], [11, 1], [12, 8], [13, 1], [14, 1]], 100), { vpoc: 12, vah: 14, val: 10 });
});

// ------------------------------------------------------- zpráva

test('snímek: 25 posledních uzavřených svíček, 30m s testem VPOC, VA dne z profilu, profil se neukládá', () => {
  const r = FJSnapshot.normalizeSnapshotPayload(payload(), 70);
  assert.equal(r.ok, true);
  const s = r.snapshot;
  assert.equal(s.bars1m.length, 25);
  assert.equal(s.bars1m[24].t, at(40), 'svíčka po vstupu zahozena');
  assert.deepEqual(plain(s.bars1m[0]), { t: at(16), o: 7600, h: 7602, l: 7598, c: 7601, v: 106, delta: 5, vpoc: [7600] });
  assert.deepEqual(plain(s.bars30m[1]), { t: at(30), o: 7600, h: 7610, l: 7595, c: 7608, v: 4000, vpoc: [7606, 7604], vpocTested: [true, false] });
  assert.deepEqual(plain(s.day), { vpoc: 7600, vah: 7600, val: 7595, high: 7612, low: 7580, vwap: 7601.5 });
  assert.equal(s.prevDay, null);
  assert.equal(s.valueAreaPct, 70);
  assert.equal('profile' in s.day, false);
  assert.equal(FJSnapshot.normalizeSnapshotPayload({ ...payload(), error: 'out_of_range' }).ok, false);
});

// ------------------------------------------- signální svíčka (test 6)

function snapWith(lastBars) {
  const s = FJSnapshot.normalizeSnapshotPayload(payload(), 70).snapshot;
  // Poslední svíčka končí v minutě vstupu (11:40) – svíčka −1.
  s.bars1m = s.bars1m.slice(0, 25 - lastBars.length).concat(lastBars.map((b, i) => ({ t: at(40 - (lastBars.length - 1 - i)), o: 7600, h: 7605, l: 7595, v: 100, delta: 0, ...b })));
  return s;
}

test('signální svíčka: ABOVE / AT / BELOW u longu i shortu, AT jen přesná shoda, offset přepočítá', () => {
  const s = snapWith([{ c: 7601, vpoc: [7600] }, { c: 7600, vpoc: [7600] }, { c: 7599.75, vpoc: [7600] }]);
  assert.equal(FJSnapshot.signalBar(s, -1).closeVsVpoc, 'BELOW');
  assert.equal(FJSnapshot.signalBar(s, -2).closeVsVpoc, 'AT');
  assert.equal(FJSnapshot.signalBar(s, -3).closeVsVpoc, 'ABOVE');
  assert.equal(FJSnapshot.signalBar(s).offset, -1, 'výchozí −1');
  assert.equal(FJSnapshot.signalBar(s, -9).offset, -5, 'nejvýš −5');
  // Směr obchodu dopočet nemění – je to poloha zavření vůči VPOC.
  const long = { side: 'long', ofConfirm: ['CLOSE_VS_VPOC_OK'] };
  const short = { side: 'short', ofConfirm: ['CLOSE_VS_VPOC_OK'] };
  assert.equal(FJSnapshot.vpocTagMismatch(long, FJSnapshot.signalBar(s, -1)), true, 'long, štítek ano, zavření pod VPOC');
  assert.equal(FJSnapshot.vpocTagMismatch(long, FJSnapshot.signalBar(s, -3)), false);
  assert.equal(FJSnapshot.vpocTagMismatch(short, FJSnapshot.signalBar(s, -3)), true);
  assert.equal(FJSnapshot.vpocTagMismatch(short, FJSnapshot.signalBar(s, -2)), false, 'AT není nesoulad');
  assert.equal(FJSnapshot.vpocTagMismatch({ side: 'long' }, FJSnapshot.signalBar(s, -1)), false, 'bez štítku nic');
});

test('signální svíčka: víc VPOC – mezi nimi null, objem vůči mediánu 20 předchozích', () => {
  const s = snapWith([{ c: 7601, vpoc: [7600, 7602], v: 300 }]);
  assert.equal(FJSnapshot.signalBar(s, -1).closeVsVpoc, null);
  // předchozích 20 svíček má objem 101–125 bez posledních → medián
  const prev = s.bars1m.slice(4, 24).map(b => b.v).sort((a, b) => a - b);
  const med = (prev[9] + prev[10]) / 2;
  assert.equal(FJSnapshot.signalBar(s, -1).volumeVsMedian20, 300 / med);
  assert.equal(FJSnapshot.signalBar({ ...s, bars1m: s.bars1m.slice(-10) }, -1).volumeVsMedian20, null, 'bez 20 předchozích null');
  assert.equal(FJSnapshot.signalBar({ ...s, bars1m: [] }, -1), null);
});

// ------------------------------- díra v ticích (ticky jen do 16:34, vstup 16:53)

test('signální svíčka podle času: snímek končící 19 min před vstupem nemá −1 (žádná stará svíčka za −1)', () => {
  const p = payload({ time: '2026-11-12T11:59:05.000Z' });
  p.bars1m.pop(); // ticky skončily v 11:40
  const s = FJSnapshot.normalizeSnapshotPayload(p, 70).snapshot;
  assert.equal(s.bars1m[s.bars1m.length - 1].t, at(40), 'poslední svíčka 11:40');
  assert.equal(FJSnapshot.signalBarEnd(s, -1), at(59));
  assert.equal(FJSnapshot.signalBarEnd(s, -5), at(55));
  assert.equal(FJSnapshot.signalBar(s, -1), null);
  assert.equal(FJSnapshot.signalBar(s, -5), null);
  assert.deepEqual(plain(FJSnapshot.snapshotCoverage(s)), { ticksUntil: at(40), gapMinutes: 19, complete: false, gap: null }, 'v6: pokrytí ze svíček');
  const ok = FJSnapshot.normalizeSnapshotPayload(payload(), 70).snapshot;
  assert.equal(FJSnapshot.snapshotCoverage(ok).complete, true);
  assert.equal(FJSnapshot.signalBar(ok, -1).bar.t, at(40));
});

test('konektor v7: svíčky bez tickového pokrytí mají deltu a VPOC null; pokrytí z konektoru', () => {
  const p = payload({ time: '2026-11-12T11:41:05.000Z', ticksComplete: false, ticksUntil: at(34) + '', ticksGap: [at(34), at(38)] });
  p.bars1m.pop(); // minuta 11:41 ještě neskončila
  p.bars1m = p.bars1m.map(b => (Date.parse(b[0]) > Date.parse(at(34)) ? [b[0], b[1], b[2], b[3], b[4], b[5], null, null] : b));
  const s = FJSnapshot.normalizeSnapshotPayload(p, 70).snapshot;
  const last = s.bars1m[s.bars1m.length - 1];
  assert.equal(last.delta, null, 'nezměřeno, ne nula');
  assert.equal(last.vpoc, null);
  assert.equal(s.ticksComplete, false);
  assert.deepEqual(plain(s.ticksGap), [at(34), at(38)]);
  const cov = FJSnapshot.snapshotCoverage(s);
  assert.equal(cov.complete, false);
  assert.equal(cov.ticksUntil, at(34));
  // −1 = 11:41 (vstup 11:41:05) z minutové historie, bez VPOC → zavření neznámé; −2 = 11:40
  p.bars1m.push([at(41), 7600, 7601, 7599, 7600, 50, null, null]);
  const s2 = FJSnapshot.normalizeSnapshotPayload(p, 70).snapshot;
  assert.equal(FJSnapshot.signalBar(s2, -1).bar.t, at(41));
  assert.equal(FJSnapshot.signalBar(s2, -1).closeVsVpoc, null);
  assert.equal(FJSnapshot.signalBar(s, -1), null, 'svíčka 11:41 ve snímku chybí');
  assert.equal(FJSnapshot.signalBar(s, -2).closeVsVpoc, null);
  // Díra uprostřed = neúplné, i když ticky sahají až ke vstupu.
  const g = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: true, ticksUntil: ENTRY, ticksGap: [at(20), at(22)] }), 70).snapshot;
  assert.equal(FJSnapshot.snapshotCoverage(g).complete, false);
});

test('opakovaný snímek nahradí uložený jen když je úplnější; jiný vstup nikdy', () => {
  const partial = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: false, ticksUntil: at(34) }), 70).snapshot;
  const later = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: false, ticksUntil: at(38) }), 70).snapshot;
  const full = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: true, ticksUntil: ENTRY }), 70).snapshot;
  assert.equal(FJSnapshot.shouldReplaceSnapshot(null, partial), true);
  assert.equal(FJSnapshot.shouldReplaceSnapshot(partial, later), true, 'ticky dál');
  assert.equal(FJSnapshot.shouldReplaceSnapshot(later, partial), false);
  assert.equal(FJSnapshot.shouldReplaceSnapshot(partial, full), true);
  assert.equal(FJSnapshot.shouldReplaceSnapshot(full, later), false, 'úplný se nepřepisuje');
  assert.equal(FJSnapshot.shouldReplaceSnapshot(partial, { ...full, executionId: 'JINY' }), false);
});

test('průchod: z neúplného snímku se hodnoty dne do Hladin nedají, z úplného ano; výběr svíčky a ruční řádek zůstanou', () => {
  const partial = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: false, ticksUntil: at(34) }), 70).snapshot;
  const full = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: true, ticksUntil: ENTRY }), 70).snapshot;
  const manual = { level: 'VAL', price: 7590, testState: 'UNTESTED' };
  const trade = { id: 't', entryPrice: 7601, marketSnapshot: partial, signalBarOffset: -2, nearLevels: [manual] };
  const opts = { levels: true, types: {}, n: 3 };
  const r1 = FJSnapshot.applyMarketData(trade, opts);
  assert.deepEqual(r1.changed, [], 'neúplný: nic');
  const r2 = FJSnapshot.applyMarketData(trade, { ...opts, snapshot: full });
  assert.ok(r2.changed.includes('snapshot'));
  assert.ok(r2.changed.includes('levels'));
  assert.equal(r2.trade.marketSnapshot.ticksComplete, true);
  assert.equal(r2.trade.signalBarOffset, -2);
  assert.deepEqual(plain(r2.trade.nearLevels[0]), manual);
  assert.ok(r2.trade.nearLevels.some(r => r.source === 'snapshot' && r.level === 'VPOC_DAY'));
  assert.deepEqual(plain(r2.trade.marketLevelsApplied), ['DAY']);
  // Horší snímek (zase neúplný) už úplný nepřepíše.
  assert.deepEqual(FJSnapshot.applyMarketData(r2.trade, { ...opts, snapshot: partial }).changed, []);
});

// --------------------------------------- řádky ze snímku (test 7)

test('řádky ze snímku: ruční řádek má přednost, duplicita jednou, vypnutý typ a skrytá volba ne, N + N', () => {
  const s = FJSnapshot.normalizeSnapshotPayload(payload(), 70).snapshot;
  const cands = FJSnapshot.snapshotLevelCandidates(s, { DAY_VAL: false });
  assert.ok(cands.some(c => c.type === 'VPOC_30M_UNTESTED' && c.price === 7595));
  assert.ok(cands.some(c => c.type === 'VPOC_30M_UNTESTED' && c.price === 7604));
  assert.ok(!cands.some(c => c.price === 7606), 'testovaný VPOC 30m ne');
  assert.ok(!cands.some(c => c.type === 'DAY_VAL'), 'vypnutý typ');
  const manual = [{ level: 'VPOC_DAY', price: 7600, testState: 'TESTED' }];
  const rows = FJSnapshot.snapshotRows(manual, cands, 7601, 2, level => level === 'HOD_LOD');
  assert.ok(!rows.some(r => r.level === 'VPOC_DAY' && r.price === 7600), 'ruční řádek se nepřidá znovu');
  assert.ok(!rows.some(r => r.level === 'HOD_LOD'), 'skrytá volba');
  assert.ok(rows.every(r => r.source === 'snapshot'));
  assert.ok(rows.filter(r => r.price >= 7601).length <= 2 && rows.filter(r => r.price < 7601).length <= 2);
  const dup = FJSnapshot.snapshotRows([], [{ level: 'VAH', price: 7600 }, { level: 'VAH', price: 7600 }], 7590, 3);
  assert.equal(dup.length, 1);
});

// --------------------------------------- test / netest (test 8)

test('test / netest ze svíček: dotek před vstupem = test, po vstupu se nepočítá, ruční vyhrává', () => {
  const bars = [{ t: at(30), h: 7605, l: 7598 }, { t: at(41), h: 7620, l: 7610 }];
  const r = FJSnapshot.autoTestStates([
    { level: 'VAH', price: 7600 },
    { level: 'VAL', price: 7615 },
    { level: 'VPOC_DAY', price: 7600, testState: 'UNTESTED' },
    { level: 'LIQUIDITY', price: null, legacySide: 'TG', ticksFromEntry: 4 }
  ], bars, ENTRY);
  assert.deepEqual(plain(r.rows), [
    { level: 'VAH', price: 7600, testState: 'TESTED', testStateAuto: true },
    { level: 'VAL', price: 7615, testState: 'UNTESTED', testStateAuto: true },
    { level: 'VPOC_DAY', price: 7600, testState: 'UNTESTED' },
    { level: 'LIQUIDITY', price: null, legacySide: 'TG', ticksFromEntry: 4 }
  ]);
  assert.equal(r.changed, 2);
  assert.equal(FJSnapshot.autoTestStates([{ level: 'VAH', price: 7600 }], [{ t: at(41), h: 7620, l: 7590 }], ENTRY).changed, 0, 'bez svíček před vstupem nic');
});

// --------------------------------------------- průchod a předchozí den

test('průchod: předchozí den ze souboru, řádky jen jednou na skupinu, test ze svíček, uloží jen při změně', () => {
  const snap = FJSnapshot.normalizeSnapshotPayload(payload(), 70).snapshot;
  const trade = { id: 't', side: 'long', entryPrice: 7601, date: '2026-11-12', marketSnapshot: snap, nearLevels: [{ level: 'LTA_SETT', price: 7590, source: 'lta' }] };
  const prevFile = { day: '2026-11-11', profile: [[7550, 5], [7560, 50], [7570, 10]], bars: [{ t: 'x', h: 7575, l: 7545 }, { t: 'y', h: 7580, l: 7550 }] };
  const dayFile = { bars: [{ t: at(30), h: 7605, l: 7598 }] };
  const opts = { levels: true, autoTest: true, n: 10, prevFile, prevComplete: true, dayFile };
  const r1 = FJSnapshot.applyMarketData(trade, opts);
  assert.deepEqual(plain(r1.trade.marketSnapshot.prevDay), { day: '2026-11-11', vpoc: 7560, vah: 7560, val: 7560, high: 7580, low: 7545 });
  assert.ok(r1.trade.nearLevels.some(r => r.level === 'VPOC_PREV_DAY' && r.source === 'snapshot'));
  assert.deepEqual(r1.trade.marketLevelsApplied, ['DAY', 'PREV']);
  assert.equal(r1.trade.nearLevels[0].level, 'LTA_SETT', 'LTA řádek zůstal první');
  assert.ok(r1.trade.nearLevels.every(r => r.testState), 'test / netest doplněn');
  assert.equal(trade.nearLevels.length, 1, 'vstup se nemění');
  // Uživatel řádek ze snímku smaže – další průchod ho nevrátí.
  const deleted = { ...r1.trade, nearLevels: r1.trade.nearLevels.filter(r => r.level !== 'VPOC_PREV_DAY') };
  const r2 = FJSnapshot.applyMarketData(deleted, opts);
  assert.equal(r2.changed.length, 0);
  assert.equal(r2.trade, deleted);
  // Neúplný předchozí den se nepoužije, „žádná hladina" se nepřepíše.
  assert.equal(FJSnapshot.applyMarketData({ ...trade, marketSnapshot: snap }, { ...opts, prevComplete: false }).trade.marketSnapshot.prevDay, null);
  const none = FJSnapshot.applyMarketData({ ...trade, nearLevels: [], nearLevelsNone: true }, { levels: true });
  assert.equal(none.trade.nearLevels.length, 0);
  // Obchod bez snímku a bez zapnutých funkcí beze změny (test 10).
  const plainTrade = { id: 'x', entryPrice: 7600 };
  assert.equal(FJSnapshot.applyMarketData(plainTrade, {}).trade, plainTrade);
});

// ----------------------------------------------- taxonomie řádků

test('taxonomie: řádek nese zdroj a příznak dopočtu; starý řádek beze změny', () => {
  const rows = FJTaxonomy.sanitizeNearLevels(null, [
    { level: 'VAH', price: 7600, source: 'snapshot', testState: 'TESTED', testStateAuto: true },
    { level: 'VAL', price: 7590, source: 'lta', testStateAuto: true },
    { level: 'VPOC_DAY', price: 7580, source: 'nesmysl' },
    { level: 'LIQUIDITY', price: null, legacySide: 'TG', ticksFromEntry: 4, source: 'snapshot' }
  ]);
  assert.deepEqual(plain(rows), [
    { level: 'VAH', price: 7600, testState: 'TESTED', source: 'snapshot', testStateAuto: true },
    { level: 'VAL', price: 7590, source: 'lta' },
    { level: 'VPOC_DAY', price: 7580 },
    { level: 'LIQUIDITY', price: null, ticksFromEntry: 4, legacySide: 'TG' }
  ]);
  assert.deepEqual(plain(FJTaxonomy.nearLevelsOf({ nearLevels: [{ level: 'VAH', price: 1, testState: 'UNTESTED' }] })), [{ level: 'VAH', price: 1, testState: 'UNTESTED' }]);
  assert.deepEqual(plain(FJLta.mergeRows([], [{ level: 'LTA_X', price: 5, source: 'lta' }, { level: 'LTA_Y', price: 6 }])), [{ level: 'LTA_X', price: 5, source: 'lta' }, { level: 'LTA_Y', price: 6 }]);
});

// ---------------------------------------- svíčky dne s profilem (J2)

test('svíčky dne: soubor s profilem nahradí stejně dlouhý bez profilu, opačně ne', () => {
  const bars = [{ t: 'a' }, { t: 'b' }];
  assert.equal(FJMarketBars.shouldReplace({ bars }, { bars, profile: [[1, 2]] }), true);
  assert.equal(FJMarketBars.shouldReplace({ bars, profile: [[1, 2]] }, { bars }), false);
  assert.equal(FJMarketBars.shouldReplace({ bars, profile: [[1, 2]] }, { bars, profile: [[1, 3]] }), false);
  const p = {
    root: 'ES', day: '2026-11-11', sessionBegin: '2026-11-10T23:00:00.000Z', sessionEnd: '2026-11-11T22:00:00.000Z',
    bars: [['2026-11-11T09:00:00.000Z', 1, 2, 1, 2, 5]], profile: [[7600, 3], ['x', 1], [7601.25, 0]]
  };
  assert.deepEqual(plain(FJMarketBars.normalizeBarsPayload(p, 'now').data.profile), [[7600, 3], [7601.25, 0]]);
  assert.equal('profile' in FJMarketBars.normalizeBarsPayload({ ...p, profile: undefined }, 'now').data, false);
});

// ------------------------------------------------------ nastavení

test('nastavení: funkce 4–7 hotové, závisí na snímku; N, typy a VA % se čistí', () => {
  for (const k of ['snapshot', 'signalBar', 'snapshotLevels', 'autoTest']) assert.equal(FJMarket.FEATURES.find(f => f.key === k).ready, true, k);
  const s = FJMarket.cleanMarketSettings({ levelsN: 99, valueAreaPct: 5, levelTypes: { DAY_VAH: false, nesmysl: false } });
  assert.equal(s.levelsN, 20);
  assert.equal(s.valueAreaPct, 50);
  assert.deepEqual(plain(s.levelTypes), { DAY_VAH: false });
  const d = FJMarket.cleanMarketSettings({});
  assert.equal(d.levelsN, 3);
  assert.equal(d.valueAreaPct, 70);
  assert.deepEqual(plain(d.levelTypes), {});
  assert.deepEqual(plain(FJMarket.applyPatch(d, { levelsN: 2, levelTypes: { PREV_HIGH: false } })).levelsN, 2);
});

// ------------------------------------------------------------ main

function mainHarness(market) {
  const state = { positions: { k: { entryExecutionId: 'E1', positionId: 'p1' } } };
  const events = [];
  const queue = FJMarketBars.createMarketQueue({ now: () => 0 });
  const settings = { s: market };
  const prevCalls = [];
  const stored = [];
  const sent = [];
  const m = loadMain(['processMarketSnapshot', 'marketAfterEntry', 'marketTakeForConnector', 'earlyMarketSnapshots', 'takeEarlyMarketSnapshot', 'recentClosedEntries', 'SNAPSHOT_CONNECTOR_VERSION', 'marketRefreshSnapshot'], {
    FJSnapshot, FJMarketBars, FJMarketBarsMain: () => FJMarketBars,
    storeSnapshot: (root, day, snap) => { stored.push([root, day, snap.executionId]); return true; },
    mainWindow: { isDestroyed: () => false, webContents: { send: (ch, data) => sent.push([ch, data]) } },
    logError: () => {},
    readCaptureState: () => state, writeCaptureState: () => {},
    readCaptureEvents: () => events, writeCaptureEvents: () => {},
    logInfo: () => {}, marketQueue: () => queue,
    marketOn: key => FJMarket.isOn(settings.s, key), marketSettingsNow: () => settings.s,
    marketRequestPrevDay: (root, day) => prevCalls.push([root, day]), localDateOf: iso => String(iso).slice(0, 10)
  });
  return { m, state, events, queue, settings, prevCalls, stored, sent };
}

test('main: snímek se připojí k otevřené pozici, k neimportovanému obchodu, nebo počká na vstup', () => {
  const on = FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true);
  const h = mainHarness(on);
  assert.equal(h.m.processMarketSnapshot(payload()), true);
  assert.equal(h.state.positions.k.marketSnapshot.day.vpoc, 7600);
  // Datum obchodu jde v klíči tradeDay – „day" nese hodnoty dne (profil…).
  assert.deepEqual(h.prevCalls[0], ['ES', '2026-11-12'], 'požadavek na předchozí den podle data obchodu');
  assert.equal(h.m.processMarketSnapshot(payload({ executionId: 'E9' })), false, 'vstup ještě nepřišel');
  assert.equal(h.m.takeEarlyMarketSnapshot('E9').marketSnapshot.executionId, 'E9');
  assert.deepEqual(plain(h.m.takeEarlyMarketSnapshot('E9')), {});
  h.m.recentClosedEntries.set('E2', 'p2');
  h.events.push({ type: 'trade_closed', positionId: 'p2', imported: false });
  assert.equal(h.m.processMarketSnapshot(payload({ executionId: 'E2' })), true);
  assert.equal(h.events[0].marketSnapshot.executionId, 'E2');
  const off = mainHarness(FJMarket.cleanMarketSettings({}));
  assert.equal(off.m.processMarketSnapshot(payload()), false, 'vypnuto = nic');
  assert.equal('marketSnapshot' in off.state.positions.k, false);
});

test('main: opakovaný snímek – uloží se podle dne pro renderer, u pozice a obchodu nahradí jen neúplný', () => {
  const on = FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true);
  const h = mainHarness(on);
  h.m.processMarketSnapshot(payload({ ticksComplete: false, ticksUntil: at(34) }));
  assert.equal(h.state.positions.k.marketSnapshot.ticksComplete, false);
  h.m.processMarketSnapshot(payload({ ticksComplete: true, ticksUntil: ENTRY }));
  assert.equal(h.state.positions.k.marketSnapshot.ticksComplete, true, 'úplnější nahradí');
  h.m.processMarketSnapshot(payload({ ticksComplete: false, ticksUntil: at(38) }));
  assert.equal(h.state.positions.k.marketSnapshot.ticksComplete, true, 'horší nepřepíše');
  assert.deepEqual(h.stored[0], ['ES', '2026-11-12', 'E1'], 'uloženo podle kořene a dne obchodu');
  assert.deepEqual(plain(h.sent[0]), ['market:saved', { root: 'ES', day: '2026-11-12', snapshot: 'E1' }]);
  // Obchod už importovaný (trade_closed imported) – zůstane jen uložený snímek pro renderer.
  h.m.recentClosedEntries.set('E5', 'p5');
  h.events.push({ type: 'trade_closed', positionId: 'p5', imported: true, marketSnapshot: { executionId: 'E5' } });
  assert.equal(h.m.processMarketSnapshot(payload({ executionId: 'E5' })), true);
  assert.equal(h.events[0].marketSnapshot.time, undefined, 'importovaná událost se nemění');
});

test('main: neúplný snímek se po zavření / doplnění vyžádá znovu, úplný ne', () => {
  const on = FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true);
  const h = mainHarness(on);
  const partial = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: false, ticksUntil: at(34) }), 70).snapshot;
  const full = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: true, ticksUntil: ENTRY }), 70).snapshot;
  assert.equal(h.m.marketRefreshSnapshot(full, 'ES', 'close'), null);
  const it = h.m.marketRefreshSnapshot(partial, 'ES', 'close');
  assert.equal(it.type, 'snapshot');
  assert.equal(it.executionId, 'E1');
  assert.equal(it.time, ENTRY);
  assert.equal(it.root, 'ES');
  const offH = mainHarness(FJMarket.cleanMarketSettings({}));
  assert.equal(offH.m.marketRefreshSnapshot(partial, 'ES', 'close'), null, 'vypnuto = nic');
});

test('main: požadavek na snímek jen se zapnutým snímkem; v5 a v6 dostanou jen svíčky, v7 i snímky', () => {
  const h = mainHarness(FJMarket.cleanMarketSettings({}));
  h.m.marketAfterEntry({ executionId: 'E1', instrument: 'ES', instrumentFull: 'ES 12-26', time: ENTRY });
  assert.equal(h.queue.progress().total, 0, 'vypnuto = žádný požadavek');
  h.settings.s = FJMarket.setEnabled(h.settings.s, true);
  h.m.marketAfterEntry({ executionId: 'E1', instrument: 'ES', instrumentFull: 'ES 12-26', time: ENTRY });
  h.queue.enqueue({ root: 'ES', day: '2026-11-11' });
  const v5 = h.m.marketTakeForConnector(5);
  assert.deepEqual(v5.map(r => r.type || 'bars'), ['bars']);
  assert.deepEqual(plain(h.m.marketTakeForConnector(6)), [], 'v6 (jen historie ticků) snímky nedostane');
  assert.deepEqual(plain(h.m.marketTakeForConnector(7)), [], 'v7 (sledování až s deníkem) snímky nedostane');
  const v7 = h.m.marketTakeForConnector(8);
  assert.equal(v7[0].type, 'snapshot');
  assert.equal(v7[0].executionId, 'E1');
  assert.equal(FJMarketBars.requestsText(v7).split('\t').length, 7);
  h.settings.s = FJMarket.setFeature(h.settings.s, 'marketBars', false);
  assert.deepEqual(plain(h.m.marketTakeForConnector(8)), [], 'vypnuté svíčky = nic');
});

// --------------------------------------------------- zdroj konektoru

test('konektor v7: živé ticky jako graf, svíčky z minutové historie, pokrytí ticky, tick rule, jen do vstupu, jen čte', () => {
  const src = readRepoFile('CONNECTORS/NinjaTrader8/FuturesJournalCapture.cs');
  // v9 (Mapa obchodu): navíc VPOC běžící 30min svíčky (bar30mCurrent).
  assert.match(src, /FJ_CONNECTOR_VERSION:\s*9\b/);
  assert.match(src, /CONNECTOR_VERSION = "9"/);
  assert.match(src, /bar30mCurrent\\":\{\\"start\\":/, 'v9 posílá rozvíjející se 30min svíčku');
  assert.match(src, /cur\.End > entry && curStart <= entry && cur\.Profile\.Count > 0 && covered\(curStart, entry\)/, 'jen když ticky pokrývají úsek do vstupu');
  // v8: živé ticky od spuštění NT8 bez deníku
  assert.match(src, /LoadWatchFile\(\);\s*PollWatchList\(\);/, 'seznam ze souboru před prvním dotazem');
  assert.match(src, /watch\.txt/);
  assert.match(src, /if \(watchEnabled\) EnsureLive\(x\.Instrument\)/, 'instrument obchodu se sleduje hned');
  assert.match(src, /if \(clean\.Length == 0\) \{ if \(System\.IO\.File\.Exists\(file\)\) System\.IO\.File\.Delete\(file\)/, 'vypnutý snímek soubor smaže');
  assert.match(src, /new MarketData\(instrument\)/, 'živé ticky v paměti');
  assert.match(src, /MarketDataType\.Last/);
  assert.match(src, /\/api\/v1\/market\/watch/);
  assert.match(src, /ConnectionStatus\.ConnectionLost/, 'výpadek spojení vynuluje živé ticky');
  assert.match(src, /FetchMinuteList\(instrument, hours, sessionBegin, sessionEnd, entry, minutes\)/, 'svíčky snímku z minutové historie');
  assert.match(src, /\\"ticksComplete\\":/);
  assert.match(src, /\\"ticksUntil\\":/);
  assert.match(src, /\\"ticksGap\\":/);
  assert.match(src, /null,null\]/, 'nezměřená svíčka má deltu a VPOC null');
  assert.match(src, /b\.End <= entry/, 'svíčky po vstupu ne');
  assert.match(src, /\\"market_snapshot\\"/);
  assert.match(src, /BarsPeriodType\.Tick/);
  assert.match(src, /lastDirection/, 'tick rule se směrem přes celou seanci');
  assert.match(src, /t > entry/, 'ticky po vstupu se nepočítají');
  assert.match(src, /no_session_that_day/);
  assert.match(src, /\\"tradeDay\\":/, 'datum obchodu nesmí kolidovat s klíčem day');
  assert.doesNotMatch(src, /\.Submit\(|CreateOrder|\.Cancel\(|\.Change\(|\.Flatten\(/);
});

// --------------------------------------- renderer: průchod při importu

test('import: vypnutá Data trhu = obchod beze změny; zapnutá doplní řádky ze snímku se zdrojem', async () => {
  const { loadRenderer } = require('./helpers/extract');
  const snap = FJSnapshot.normalizeSnapshotPayload(payload(), 70).snapshot;
  const trade = { id: 't', instrument: 'ES', date: '2026-11-12', side: 'long', entryPrice: 7601, marketSnapshot: snap };
  const load = market => loadRenderer(['applyMarketDataToTrade'], {
    FJSnapshot, FJMarket, marketSettings: async () => market, normalizeInstrumentCode: i => String(i).toUpperCase(),
    taxonomyConfig: () => ({}), window: { desktopAPI: { marketDataFor: async () => ({ ok: true, dayFile: null, prevFile: null, prevComplete: false }) } }
  });
  const off = await load(FJMarket.cleanMarketSettings({})).applyMarketDataToTrade(trade);
  assert.equal(off.trade, trade);
  assert.deepEqual(plain(off.changed), []);
  const on = await load(FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true)).applyMarketDataToTrade(trade);
  assert.ok(on.changed.includes('levels'));
  assert.ok(on.trade.nearLevels.length > 0 && on.trade.nearLevels.every(r => r.source === 'snapshot'));
  assert.equal('nearLevels' in trade, false, 'původní obchod se nemění');
});

test('průchod: včerejšek, který přijde později, nepřidá řádky nad limit N', () => {
  const snap = FJSnapshot.normalizeSnapshotPayload(payload(), 70).snapshot;
  const trade = { id: 't', side: 'long', entryPrice: 7601, date: '2026-11-12', marketSnapshot: snap, nearLevels: [] };
  const first = FJSnapshot.applyMarketData(trade, { levels: true, n: 2 }).trade;
  assert.deepEqual(first.marketLevelsApplied, ['DAY']);
  const below = rows => rows.filter(r => r.price < 7601).length;
  assert.equal(below(first.nearLevels), 2);
  // Včerejšek je dál od vstupu než dnešní hladiny → nic se nepřidá.
  const prevFile = { day: '2026-11-11', profile: [[7500, 5]], bars: [{ t: 'x', h: 7510, l: 7490 }] };
  const second = FJSnapshot.applyMarketData(first, { levels: true, n: 2, prevFile, prevComplete: true }).trade;
  assert.deepEqual(second.marketLevelsApplied, ['DAY', 'PREV']);
  assert.equal(below(second.nearLevels), 2, 'pořád N pod vstupem');
});

test('renderer: později uložený úplnější snímek téhož vstupu nahradí neúplný (opakovaný požadavek)', async () => {
  const { loadRenderer } = require('./helpers/extract');
  const partial = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: false, ticksUntil: at(34) }), 70).snapshot;
  const full = FJSnapshot.normalizeSnapshotPayload(payload({ ticksComplete: true, ticksUntil: ENTRY }), 70).snapshot;
  const trade = { id: 't', instrument: 'ES', date: '2026-11-12', side: 'long', entryPrice: 7601, marketSnapshot: partial, signalBarOffset: -3 };
  const asked = [];
  const r = loadRenderer(['applyMarketDataToTrade'], {
    FJSnapshot, FJMarket, marketSettings: async () => FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true), normalizeInstrumentCode: i => String(i).toUpperCase(),
    taxonomyConfig: () => ({}),
    window: { desktopAPI: { marketDataFor: async q => { asked.push(q); return { ok: true, dayFile: null, prevFile: null, prevComplete: false, snapshots: { E1: full } }; } } }
  });
  const out = await r.applyMarketDataToTrade(trade);
  assert.deepEqual(plain(asked[0]), { root: 'ES', day: '2026-11-12' });
  assert.ok(out.changed.includes('snapshot'));
  assert.equal(out.trade.marketSnapshot.ticksComplete, true);
  assert.equal(out.trade.signalBarOffset, -3, 'výběr svíčky zůstal');
  assert.ok(out.trade.nearLevels.some(x => x.level === 'VPOC_DAY'), 'hodnoty dne až z úplného snímku');
});

test('main: seznam pro živé ticky – ruční seznam, jinak pozice a co se obchoduje; vypnutý snímek = nic', () => {
  const settings = { s: FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true) };
  const today = new Date().toISOString().slice(0, 10);
  const m = loadMain(['marketWatchList'], {
    FJMarketBarsMain: () => FJMarketBars,
    marketOn: key => FJMarket.isOn(settings.s, key), marketSettingsNow: () => settings.s,
    readCaptureState: () => ({ positions: { a: { instrument: 'MNQ', instrumentFull: 'MNQ 12-26' } } }),
    marketBarsStore: () => ({ storedIndex: () => ({ ['MES|' + today]: true, 'CL|2020-01-02': true }) }),
    localDateOf: iso => String(iso).slice(0, 10),
    app: { getPath: () => 'C:/nikde' }, fs: { readdirSync: () => { throw new Error('ne'); } }, path: require('path')
  });
  assert.deepEqual(plain(m.marketWatchList()), [{ root: 'MNQ', instrumentFull: 'MNQ 12-26' }, { root: 'MES', instrumentFull: '' }], 'CL bez obchodu za 30 dní ne');
  settings.s = FJMarket.applyPatch(settings.s, { liveTickRoots: 'es, mes;ES' });
  assert.deepEqual(plain(settings.s.liveTickRoots), ['ES', 'MES']);
  assert.deepEqual(plain(m.marketWatchList()).map(w => w.root), ['ES', 'MES'], 'ruční seznam má přednost');
  settings.s = FJMarket.setFeature(settings.s, 'snapshot', false);
  assert.deepEqual(plain(m.marketWatchList()), []);
});
