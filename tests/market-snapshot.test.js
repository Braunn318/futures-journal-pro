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
  s.bars1m = s.bars1m.slice(0, 25 - lastBars.length).concat(lastBars.map((b, i) => ({ t: at(100 + i), o: 7600, h: 7605, l: 7595, v: 100, delta: 0, ...b })));
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
  assert.equal(FJSnapshot.signalBar({ bars1m: s.bars1m.slice(-10) }, -1).volumeVsMedian20, null, 'bez 20 předchozích null');
  assert.equal(FJSnapshot.signalBar({ bars1m: [] }, -1), null);
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
  const m = loadMain(['processMarketSnapshot', 'marketAfterEntry', 'marketTakeForConnector', 'earlyMarketSnapshots', 'takeEarlyMarketSnapshot', 'recentClosedEntries'], {
    FJSnapshot, FJMarketBars,
    readCaptureState: () => state, writeCaptureState: () => {},
    readCaptureEvents: () => events, writeCaptureEvents: () => {},
    logInfo: () => {}, marketQueue: () => queue,
    marketOn: key => FJMarket.isOn(settings.s, key), marketSettingsNow: () => settings.s,
    marketRequestPrevDay: (root, day) => prevCalls.push([root, day]), localDateOf: iso => String(iso).slice(0, 10)
  });
  return { m, state, events, queue, settings, prevCalls };
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

test('main: požadavek na snímek jen se zapnutým snímkem; v5 dostane jen svíčky, v6 i snímky', () => {
  const h = mainHarness(FJMarket.cleanMarketSettings({}));
  h.m.marketAfterEntry({ executionId: 'E1', instrument: 'ES', instrumentFull: 'ES 12-26', time: ENTRY });
  assert.equal(h.queue.progress().total, 0, 'vypnuto = žádný požadavek');
  h.settings.s = FJMarket.setEnabled(h.settings.s, true);
  h.m.marketAfterEntry({ executionId: 'E1', instrument: 'ES', instrumentFull: 'ES 12-26', time: ENTRY });
  h.queue.enqueue({ root: 'ES', day: '2026-11-11' });
  const v5 = h.m.marketTakeForConnector(5);
  assert.deepEqual(v5.map(r => r.type || 'bars'), ['bars']);
  const v6 = h.m.marketTakeForConnector(6);
  assert.equal(v6[0].type, 'snapshot');
  assert.equal(v6[0].executionId, 'E1');
  assert.equal(FJMarketBars.requestsText(v6).split('\t').length, 7);
  h.settings.s = FJMarket.setFeature(h.settings.s, 'marketBars', false);
  assert.deepEqual(h.m.marketTakeForConnector(6), [], 'vypnuté svíčky = nic');
});

// --------------------------------------------------- zdroj konektoru

test('konektor v6: snímek z ticků, tick rule, jen do vstupu, jen čte', () => {
  const src = readRepoFile('CONNECTORS/NinjaTrader8/FuturesJournalCapture.cs');
  assert.match(src, /FJ_CONNECTOR_VERSION:\s*6\b/);
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
