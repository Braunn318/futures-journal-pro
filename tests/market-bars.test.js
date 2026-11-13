'use strict';
// Data trhu – J2: minutové svíčky celé seance dne obchodu z konektoru NT8.
// (Claude files/ZADANI_DENIK_SNAPSHOT_TRHU.md §J2, docs/SNAPSHOT_DISCOVERY.md)
//
// Konektor v5 si požadavky vyzvedává (GET /api/v1/market/requests) a svíčky
// posílá zprávou market_bars. Ukládá se <userData>/market/<ROOT>/<den>.json,
// přepis jen když přibyly svíčky, kopie do ai-export/market.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FJMarketBars = require('../app/market-bars.js');
const FJMarket = require('../app/market-data.js');
const { createMarketBarsStore } = require('../app/market-bars-store.js');
const { loadMain, readRepoFile } = require('./helpers/extract');

const plain = v => JSON.parse(JSON.stringify(v));
const BEGIN = '2026-11-10T23:00:00.000Z'; // 00:00 SEČ
const END = '2026-11-11T22:00:00.000Z';   // 23:00 SEČ
const minute = n => new Date(Date.parse(BEGIN) + n * 60000).toISOString();
const bar = (n, c = 7600) => [minute(n), c, c + 1, c - 1, c + 0.25, 10 + n];
function payload(count, extra = {}) {
  return {
    source: 'ninjatrader', type: 'market_bars', requestId: 'r1', root: 'mes', instrumentFull: 'MES 12-26', day: '2026-11-11',
    tradingHours: 'CME US Index Futures ETH', timeZone: 'W. Europe Standard Time', sessionBegin: BEGIN, sessionEnd: END,
    bars: Array.from({ length: count }, (_, i) => bar(i + 1)), ...extra
  };
}

// ------------------------------------------------------- validace

test('validace: tvar souboru bez dopočtů, kořen velkými, řazení a duplicity', () => {
  const p = payload(3);
  p.bars = [p.bars[2], p.bars[0], p.bars[1], p.bars[0]];
  const r = FJMarketBars.normalizeBarsPayload(p, '2026-11-11T12:00:00.000Z');
  assert.equal(r.ok, true);
  assert.equal(r.data.root, 'MES');
  assert.equal(r.data.day, '2026-11-11');
  assert.equal(r.data.tradingHours, 'CME US Index Futures ETH');
  assert.equal(r.data.timeZone, 'W. Europe Standard Time');
  assert.equal(r.data.receivedAt, '2026-11-11T12:00:00.000Z');
  assert.deepEqual(r.data.bars.map(b => b.t), [minute(1), minute(2), minute(3)]);
  assert.deepEqual(plain(r.data.bars[0]), { t: minute(1), o: 7600, h: 7601, l: 7599, c: 7600.25, v: 11 });
  assert.deepEqual(Object.keys(r.data).sort(), ['bars', 'day', 'instrumentFull', 'receivedAt', 'root', 'sessionBegin', 'sessionEnd', 'source', 'timeZone', 'tradingHours', 'v'].sort());
});

test('validace: svíčky mimo seanci se zahodí, odpověď z jiného dne (Playback) = chyba', () => {
  const p = payload(2);
  p.bars.push([new Date(Date.parse(END) + 60000).toISOString(), 1, 1, 1, 1, 1]);
  p.bars.push([BEGIN, 1, 1, 1, 1, 1]); // konec svíčky = začátek seance → patří předchozí
  const r = FJMarketBars.normalizeBarsPayload(p, END);
  assert.equal(r.ok, true);
  assert.equal(r.data.bars.length, 2);
  assert.equal(r.dropped, 2);
  const other = payload(0);
  other.bars = [['2026-11-09T10:00:00.000Z', 1, 2, 0.5, 1, 5]];
  assert.deepEqual(plain(FJMarketBars.normalizeBarsPayload(other, END)), { ok: false, error: 'out_of_range' });
  assert.equal(FJMarketBars.normalizeBarsPayload(payload(0), END).error, 'empty');
  assert.equal(FJMarketBars.normalizeBarsPayload({ ...payload(1), error: 'instrument_not_found' }, END).error, 'instrument_not_found');
  assert.equal(FJMarketBars.normalizeBarsPayload({ ...payload(1), day: '11.11.2026' }, END).ok, false);
  const bad = payload(2);
  bad.bars[0] = [minute(1), 'x', 1, 1, 1, 1];
  assert.equal(FJMarketBars.normalizeBarsPayload(bad, END).data.bars.length, 1, 'nečíselná svíčka se zahodí');
});

test('úplnost dne: poslední svíčka u konce seance', () => {
  assert.equal(FJMarketBars.isComplete(FJMarketBars.normalizeBarsPayload(payload(1380), END).data), true);
  assert.equal(FJMarketBars.isComplete(FJMarketBars.normalizeBarsPayload(payload(700), END).data), false);
  assert.equal(FJMarketBars.isComplete(null), false);
});

// ------------------------------------------------------ uložení

function tempStore(exportOn = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-bars-'));
  const exp = { dir: exportOn ? path.join(base, 'ai-export', 'market') : null };
  const store = createMarketBarsStore({ userDataDir: path.join(base, 'user'), exportDir: () => exp.dir, now: () => Date.parse('2026-11-11T12:00:00.000Z') });
  return { base, exp, store, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('svíčky dne: opakované přijetí nepřepíše delší soubor kratším ani stejně dlouhým', () => {
  const h = tempStore();
  try {
    assert.equal(h.store.save(payload(700)).written, true);
    const file = path.join(h.base, 'user', 'market', 'MES', '2026-11-11.json');
    const mirror = path.join(h.base, 'ai-export', 'market', 'MES', '2026-11-11.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bars.length, 700);
    assert.equal(JSON.parse(fs.readFileSync(mirror, 'utf8')).bars.length, 700);
    const shorter = h.store.save(payload(300));
    assert.equal(shorter.written, false);
    assert.equal(shorter.reason, 'not_longer');
    assert.equal(h.store.save(payload(700)).written, false, 'stejně dlouhý se nepřepisuje');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bars.length, 700);
    assert.equal(h.store.save(payload(1380)).written, true);
    assert.equal(JSON.parse(fs.readFileSync(mirror, 'utf8')).bars.length, 1380);
    assert.equal(h.store.read('mes', '2026-11-11').bars.length, 1380);
    const st = h.store.status();
    assert.equal(st.days, 1);
    assert.deepEqual(st.roots, ['MES']);
    assert.ok(st.bytes > 0);
    assert.deepEqual(plain(h.store.storedIndex()), { 'MES|2026-11-11': true });
    assert.ok(!fs.readdirSync(path.dirname(file)).some(n => n.endsWith('.tmp')));
  } finally { h.cleanup(); }
});

test('svíčky dne: chyba nic nezapíše; bez exportu jen userData; exportAll dorovná kopii', () => {
  const h = tempStore(false);
  try {
    assert.equal(h.store.save({ ...payload(5), error: 'out_of_range' }).ok, false);
    assert.equal(h.store.status().days, 0);
    assert.equal(h.store.save(payload(5)).written, true);
    assert.ok(!fs.existsSync(path.join(h.base, 'ai-export')));
    h.exp.dir = path.join(h.base, 'ai-export', 'market');
    assert.deepEqual(plain(h.store.exportAll()), { written: 1, same: 0 });
    assert.deepEqual(plain(h.store.exportAll()), { written: 0, same: 1 });
  } finally { h.cleanup(); }
});

// ------------------------------------------------------- fronta

test('fronta: dedupe kořen+den, take/done, timeout → znovu, pak chyba', () => {
  const clock = { t: 0 };
  const q = FJMarketBars.createMarketQueue({ now: () => clock.t, timeoutMs: 1000, maxTries: 2 });
  const a = q.enqueue({ root: 'MES', day: '2026-11-11', time: '2026-11-11T09:00:00.000Z', instrumentFull: 'MES 12-26' });
  const b = q.enqueue({ root: 'mes', day: '2026-11-11' });
  assert.equal(a.id, b.id, 'stejný kořen a den jen jednou');
  q.enqueue({ root: 'ES', day: '2026-11-10' });
  const first = q.take(1);
  assert.equal(first.length, 1);
  assert.equal(first[0].root, 'MES');
  assert.equal(q.take(5).length, 1, 'rozdaný požadavek se nerozdá znovu');
  assert.deepEqual(q.take(5), []);
  q.done(first[0].id, true);
  clock.t += 1500; // ES vypršel
  const again = q.take(1);
  assert.equal(again[0].root, 'ES');
  clock.t += 1500;
  assert.deepEqual(q.take(1), [], 'druhý timeout = chyba');
  const p = q.progress();
  assert.equal(p.done, 1);
  assert.equal(p.failed, 1);
  assert.equal(q.enqueue({ root: 'MES', day: '2026-11-11' }).state, 'pending', 'hotový den jde požádat znovu');
});

test('fronta: dávka zpětného doplnění, průběh a přerušení', () => {
  const q = FJMarketBars.createMarketQueue({ now: () => 0 });
  for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) q.enqueue({ root: 'MES', day: d }, 'b1');
  const t = q.take(1)[0];
  q.done(t.id, false, 'out_of_range');
  assert.deepEqual(plain(q.progress('b1')), { total: 3, done: 0, failed: 1, pending: 2, inflight: 0, cancelled: 0, errors: { out_of_range: 1 } });
  assert.equal(q.cancelBatch('b1'), 2);
  assert.deepEqual(q.take(5), []);
  assert.equal(q.progress('b1').cancelled, 2);
  assert.equal(FJMarketBars.requestsText([{ id: 'x1', root: 'MES', instrumentFull: '', day: '2026-11-11', time: '2026-11-11T11:00:00.000Z' }]),
    'x1\tMES\t\t2026-11-11\t2026-11-11T11:00:00.000Z\tbars\t\n', 'konektor v5 čte prvních 5 sloupců, v6 i typ a exekuci');
  assert.equal(FJMarketBars.requestsText([]), '');
});

// ------------------------------------------- plán zpětného doplnění

test('plán: dny s obchody + dny archivu levelů, bez swingů, úplných dnů a budoucnosti', () => {
  const trades = [
    { instrument: 'MES', date: '2026-11-03' },
    { instrument: 'MES 12-26', date: '2026-11-04' },
    { instrument: 'es', date: '2026-11-04' },
    { kind: 'SWING', instrument: 'EURUSD', date: '2026-11-04' },
    { instrument: 'MES', date: '2026-11-20' },
    { instrument: '', date: '2026-11-05' }
  ];
  const plan = FJMarketBars.planBackfill({
    trades, archiveDays: ['2026-11-05', '2026-11-04'], stored: { 'MES|2026-11-04': true, 'ES|2026-11-05': false }, today: '2026-11-11'
  });
  assert.deepEqual(plan.map(p => p.root + '|' + p.day), ['ES|2026-11-05', 'MES|2026-11-05', 'ES|2026-11-04', 'MES|2026-11-03']);
  const noon = new Date(2026, 10, 5, 12).toISOString();
  assert.equal(plan[0].time, noon, 'čas uvnitř seance = poledne místního dne');
});

// ---------------------- hlavní vypínač vypnutý = konektor beze změny

test('upozornění na konektor: s vypnutými Daty trhu stačí v4, se svíčkami je potřeba v5', async () => {
  const { ninjaConnectorStatus } = loadMain(['ninjaConnectorTargetPath', 'findNinjaConnectorCopies', 'ninjaConnectorVersion', 'ninjaConnectorApiKey', 'ninjaConnectorStatus'], { path });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-nt-'));
  try {
    const dir = path.join(base, 'NinjaTrader 8', 'bin', 'Custom', 'AddOns');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'FuturesJournalCapture.cs'), '// FJ_CONNECTOR_VERSION: 4\npublic class FuturesJournalCapture : AddOnBase {}');
    const off = await ninjaConnectorStatus({ documentsDir: base, currentVersion: 5, requiredVersion: 4, fsApi: fs });
    assert.equal(off.outdated, false);
    assert.equal(off.currentVersion, 5);
    const on = await ninjaConnectorStatus({ documentsDir: base, currentVersion: 5, requiredVersion: 5, fsApi: fs });
    assert.equal(on.outdated, true);
    const legacy = await ninjaConnectorStatus({ documentsDir: base, currentVersion: 5, fsApi: fs });
    assert.equal(legacy.outdated, true, 'bez requiredVersion jako dřív');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('po uzavření obchodu: požadavek na svíčky jen se zapnutými svíčkami', () => {
  const queue = FJMarketBars.createMarketQueue({ now: () => 0 });
  const settings = { s: FJMarket.cleanMarketSettings({}) };
  const { marketAfterTradeClosed } = loadMain(['marketAfterTradeClosed'], {
    FJMarketBars, marketQueue: () => queue, marketOn: key => FJMarket.isOn(settings.s, key),
    localDateOf: iso => iso.slice(0, 10), marketRefreshSnapshot: () => null
  });
  const closed = { type: 'trade_closed', instrument: 'MES', instrumentFull: 'MES 12-26', entryTime: '2026-11-11T09:00:00.000Z' };
  marketAfterTradeClosed(closed);
  assert.equal(queue.progress().total, 0, 'výchozí stav: konektor se na data neptá');
  settings.s = FJMarket.setEnabled(settings.s, true);
  marketAfterTradeClosed({ type: 'execution' });
  marketAfterTradeClosed(closed);
  const [req] = queue.take(1);
  assert.deepEqual(plain({ root: req.root, instrumentFull: req.instrumentFull, day: req.day, time: req.time }),
    { root: 'MES', instrumentFull: 'MES 12-26', day: '2026-11-11', time: '2026-11-11T09:00:00.000Z' });
});

// ------------------------------------------------- zdroj konektoru

test('konektor v5: vyzvedává požadavky a posílá market_bars, jen čte', () => {
  const src = readRepoFile('CONNECTORS/NinjaTrader8/FuturesJournalCapture.cs');
  assert.ok(Number(/FJ_CONNECTOR_VERSION:\s*(\d+)/.exec(src)[1]) >= 5, 'svíčky dne umí konektor od verze 5');
  assert.match(src, /\/api\/v1\/market\/requests/);
  assert.match(src, /\\"market_bars\\"/);
  assert.match(src, /out_of_range/, 'svíčky mimo seanci (Playback) se nepošlou jako data');
  assert.doesNotMatch(src, /\.Submit\(|CreateOrder|\.Cancel\(|\.Change\(|\.Flatten\(/);
  assert.match(src, /SEND_ENTRY_VWAP/, 'VWAP zůstává');
});

test('main.js: market_bars jde mimo events.json a spool', () => {
  const src = readRepoFile('main.js');
  const post = src.indexOf("url.pathname === '/api/v1/events'");
  const market = src.indexOf("payload.type === 'market_bars'", post);
  const spool = src.indexOf('spoolCapturePayload(payload, source)', post);
  assert.ok(market > post && market < spool, 'market_bars se zpracuje před spoolem / appendCaptureEvent');
  assert.match(src, /url\.pathname === '\/api\/v1\/market\/requests' && req\.method === 'GET'/);
});
