'use strict';
// Ruční import z NinjaTraderu (4.8.7): export mřížky Executions nebo Trades
// (CSV nebo schránka) → náhled → zápis stejnou cestou jako konektor.
//
// Hlídá se:
//  - parser obou formátů (středník, tab, desetinná čárka, „ $", místní čas),
//  - exekuce se skládají STEJNÝM jádrem jako živý konektor (applyExecution):
//    exekuce ze skutečného záznamu konektoru převedené do tvaru CSV dají
//    stejné obchody jako živá cesta,
//  - výstup bez vstupu v souboru se vynechá, neuzavřená pozice se nahlásí,
//  - ID jsou stabilní: opakovaný import téhož souboru dá stejná ID (a deník
//    ho podle nich nezdvojí), nohy jedné pozice mají stejné positionId,
//  - mřížka Obchody: nohy jedné pozice, komise = hrubý − čistý z NT, MAE/MFE
//    v penězích za celý obchod → ticky jednoho kontraktu.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const N = require('../app/nt8import.js');
const { loadMain } = require('./helpers/extract');
const { captureHarness } = require('./helpers/capture-harness');

const plain = v => JSON.parse(JSON.stringify(v));
const helpers = { pointValueOf: () => 5, tickSizeOf: () => 0.25 };

// ------------------------------------------------------------ parser

test('čísla a časy z mřížky NT8', () => {
  assert.equal(N.parseNumber('7674,50'), 7674.5);
  assert.equal(N.parseNumber('-21,90 $'), -21.9);
  assert.equal(N.parseNumber('1 234,5'), 1234.5);
  assert.equal(N.parseNumber('1,234.50'), 1234.5);
  assert.equal(N.parseNumber('1.234,50'), 1234.5);
  assert.equal(N.parseNumber('(21.90)'), -21.9);
  assert.equal(N.parseNumber('-'), null);
  assert.equal(N.parseNumber(''), null);
  const local = (y, m, d, h, mi, s) => new Date(y, m - 1, d, h, mi, s).toISOString();
  assert.equal(N.parseTime('24082026 17:39:53'), local(2026, 8, 24, 17, 39, 53));
  assert.equal(N.parseTime('24.08.2026 17:39:53'), local(2026, 8, 24, 17, 39, 53));
  assert.equal(N.parseTime('8/24/2026 5:39:53 PM'), local(2026, 8, 24, 17, 39, 53));
  assert.equal(N.parseTime('2026-08-24 17:39'), local(2026, 8, 24, 17, 39, 0));
  assert.equal(N.parseTime('31022026 10:00:00'), null, 'neexistující datum');
  assert.equal(N.parseTime('zítra'), null);
});

const EXEC_CSV = [
  'Instrument;Action;Quantity;Price;Time;ID;E/X;Position;Order ID;Name;Commission;Rate;Account;Connection;',
  'MES 09-26;Buy;1;7731,50;18082026 16:38:33;615959721252;Exit;-;;;0,39 $;1;ACC1;Conn;',
  'MES 09-26;Buy;1;7731,50;18082026 16:38:33;615959721244;Exit;-;;;0,39 $;1;ACC1;Conn;',
  'MES 09-26;Sell;2;7729,50;18082026 16:37:03;615959721210;Entry;-;;;0,78 $;1;ACC1;Conn;',
  'MES 09-26;Sell;2;7793,00;17082026 18:00:37;615959721181;Exit;-;;;0,78 $;1;ACC1;Conn;',
  'MES 09-26;Buy;2;7794,25;17082026 17:53:03;615959721147;Entry;-;;;0,78 $;1;ACC1;Conn;'
].join('\r\n');

test('exekuce: formát podle hlavičky, řazení podle času, vstup před výstupem téže sekundy', () => {
  const t = N.parseTable(EXEC_CSV);
  assert.equal(t.format, 'executions');
  const { payloads, errors } = N.executionPayloads(t.rows, helpers);
  assert.deepEqual(errors, []);
  assert.deepEqual(payloads.map(p => p.executionId), ['615959721147', '615959721181', '615959721210', '615959721244', '615959721252']);
  const first = payloads[0];
  assert.equal(first.instrument, 'MES');
  assert.equal(first.instrumentFull, 'MES 09-26');
  assert.equal(first.account, 'ACC1');
  assert.equal(first.commission, 0.78);
  assert.equal(first.pointValue, 5);
  assert.equal(first.entryExit, 'entry');
  assert.equal('positionAfter' in first, false, 'sloupec Position („-") se nepoužívá');
});

test('kopie z mřížky přes schránku: oddělovač tab, hlavička může být až pod prázdným řádkem', () => {
  const tsv = '\n' + EXEC_CSV.replace(/;/g, '\t');
  const t = N.parseTable(tsv);
  assert.equal(t.format, 'executions');
  assert.equal(t.rows.length, 5);
  assert.equal(N.parseTable('MES 09-26\tBuy\t1').format, null, 'bez hlavičky formát nepoznám');
});

test('exekuce bez ID: ID z hodnot řádku, stejné při každém čtení', () => {
  const csv = EXEC_CSV.replace(/;61595972\d{4};/g, ';;');
  const a = N.executionPayloads(N.parseTable(csv).rows, helpers).payloads.map(p => p.executionId);
  const b = N.executionPayloads(N.parseTable(csv).rows, helpers).payloads.map(p => p.executionId);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, 'shodné řádky se liší pořadím shody');
  assert.ok(a.every(id => id.startsWith('csv:')));
});

// ------------------------------------------------------------ přehrání jádrem

function replayer() {
  let ids = 0;
  return loadMain([
    'POSITION_MISSING_GRACE_MS', 'SNAPSHOT_RACE_WINDOW_MS', 'positionIsMissing', 'signedExecutionQuantity', 'positionKey', 'lotKeyOf',
    'positionLots', 'applyLots', 'takeFromLots', 'LIVE_CAPTURE', 'openPositionFromExecution', 'excursionTicks', 'applyExecution', 'manualImportReplay'
  ], {
    takeScreenshots: async () => { throw new Error('ruční import nesmí dělat screenshoty'); },
    appendCaptureEvent: () => { throw new Error('ruční import nesmí psát do historie událostí'); },
    crypto: { randomUUID: () => 'rnd-' + (++ids) },
    logInfo: () => {}
  });
}

test('přehrání: obchody jako u konektoru, výstup bez vstupu vynechán, nic se neukládá', async () => {
  const { payloads } = N.executionPayloads(N.parseTable(EXEC_CSV).rows, helpers);
  const r = await replayer().manualImportReplay(payloads);
  assert.deepEqual(plain(r.skipped), []);
  assert.deepEqual(plain(r.open), []);
  const c = plain(r.closed);
  assert.equal(c.length, 3, '17. 8. jeden obchod, 18. 8. dvě nohy (dva výstupy po 1 ks)');
  assert.deepEqual([c[0].side, c[0].quantity, c[0].entryPrice, c[0].exitPrice, c[0].grossPnl], ['long', 2, 7794.25, 7793, -12.5]);
  assert.equal(c[0].commission, 1.56, 'vstupní + výstupní komise z NT');
  assert.equal(c[1].positionId, c[2].positionId, 'nohy jedné pozice mají stejné positionId');
  assert.equal(c[1].positionId, 'nt8m:pos:615959721210', 'ID pozice ze vstupní exekuce');
  assert.deepEqual(c.map(e => e.id), ['nt8m:615959721181:1', 'nt8m:615959721244:1', 'nt8m:615959721252:1']);
  // Opakované přehrání = stejná ID (deník je podle nich nezdvojí).
  const again = await replayer().manualImportReplay(payloads);
  assert.deepEqual(plain(again.closed).map(e => [e.id, e.positionId]), c.map(e => [e.id, e.positionId]));

  // Soubor začíná uprostřed pozice (bez vstupu) a končí otevřenou pozicí.
  const cut = payloads.filter(p => p.executionId !== '615959721147' && p.executionId !== '615959721252');
  const partial = await replayer().manualImportReplay(cut);
  assert.deepEqual(plain(partial.skipped).map(s => s.executionId), ['615959721181']);
  assert.deepEqual(plain(partial.open).map(p => [p.side, p.quantity]), [['short', 1]]);
  assert.equal(partial.closed.length, 1);
});

// Stejné jádro jako živý konektor: skutečné exekuce ze záznamu konektoru
// převedené do tvaru exportu CSV (bez positionAfter a bez MAE/MFE – ty export
// nemá) musí dát stejné uzavřené obchody jako živá cesta nad týmiž daty.
test('totožnost s konektorem na skutečném záznamu (bez snímků pozic)', async t => {
  const file = process.env.FJ_EVENTS || require('node:path').join(process.env.APPDATA || '', 'futures-journal-pro', 'trade-capture', 'events.json');
  if (!fs.existsSync(file)) { t.skip('záznam konektoru není k dispozici: ' + file); return; }
  const execs = JSON.parse(fs.readFileSync(file, 'utf8')).filter(e => e.type === 'execution' && e.source === 'ninjatrader');
  if (!execs.length) { t.skip('záznam nemá exekuce'); return; }
  const strip = e => ({ ...e, positionAfter: undefined, excursionMaxPrice: undefined, excursionMinPrice: undefined });
  const live = captureHarness();
  for (const e of execs) await live.main.processExecution(strip(e));
  const liveClosed = live.events.filter(e => e.type === 'trade_closed');
  const r = await replayer().manualImportReplay(execs.map(e => ({ ...strip(e), entryExit: '' })));
  const key = e => [e.account, e.instrumentFull, e.side, e.entryTime, e.exitTime, e.entryPrice, e.exitPrice, e.quantity, Math.round(e.grossPnl * 100), Math.round(e.commission * 100)].join('|');
  assert.deepEqual(plain(r.closed.map(key)), plain(liveClosed.map(key)));
  t.diagnostic(`${execs.length} exekucí → ${r.closed.length} uzavřených nohou, shodně s živou cestou`);
});

// ------------------------------------------------------------ mřížka Obchody

const TRADES_CSV = [
  'Trade number;Instrument;Account;Strategy;Market pos.;Qty;Entry price;Exit price;Entry time;Exit time;Exit name;Entry name;Profit;Cum. net profit;Commission;Clearing Fee;Exchange Fee;IP Fee;NFA Fee;MAE;MFE;ETD;Bars;',
  '1;MES 09-26;ACC1;;Short;1;7784,50;7787,00;10082026 17:23:14;10082026 17:23:42;;;-14,40 $;-14,40 $;0,78 $;0,00 $;0,00 $;0,00 $;0,00 $;12,50 $;12,50 $;26,90 $;0;',
  '2;MES 09-26;ACC1;;Short;2;7784,50;7787,00;10082026 17:23:14;10082026 17:23:42;;;-28,80 $;-43,20 $;1,56 $;0,00 $;0,00 $;0,00 $;0,00 $;25,00 $;25,00 $;53,80 $;0;',
  '3;MES 09-26;ACC1;;Long;1;7694,50;7692,50;21082026 17:13:33;21082026 17:14:18;;;-11,90 $;-55,10 $;0,78 $;0,38 $;0,70 $;0,00 $;0,04 $;10,00 $;10,00 $;21,90 $;0;',
  '4;MES 09-26;ACC1;;Long;1;7694,50;7692,50;21082026 17:13:33;21082026 17:14:18;;;-11,90 $;-67,00 $;0,78 $;0,38 $;0,70 $;0,00 $;0,04 $;10,00 $;10,00 $;21,90 $;0;'
].join('\n');

test('mřížka Obchody: nohy jedné pozice, komise z rozdílu, MAE/MFE na ticky jednoho kontraktu', () => {
  const t = N.parseTable(TRADES_CSV);
  assert.equal(t.format, 'trades');
  const { events, errors } = N.tradeEvents(t.rows, helpers);
  assert.deepEqual(errors, []);
  assert.equal(events.length, 4);
  const [a, b] = events.filter(e => e.side === 'short').sort((x, y) => x.quantity - y.quantity);
  assert.equal(a.positionId, b.positionId, 'stejný účet, instrument, směr a čas vstupu = jedna pozice');
  assert.deepEqual([b.quantity, b.points, b.grossPnl, b.pnl, b.commission], [2, 2.5, -25, -28.8, 3.8]);
  assert.deepEqual([a.maeTicks, b.maeTicks], [10, 10], '12,50 $ za 1 ks i 25,00 $ za 2 ks = 10 ticků');
  const longs = events.filter(e => e.side === 'long');
  assert.notEqual(longs[0].id, longs[1].id, 'dva shodné řádky jsou dvě nohy');
  assert.deepEqual(N.tradeEvents(N.parseTable(TRADES_CSV).rows, helpers).events.map(e => e.id), events.map(e => e.id), 'stabilní ID');
  const noPv = N.tradeEvents(t.rows, { pointValueOf: () => null, tickSizeOf: () => 0.25 }).events[0];
  assert.equal('grossPnl' in noPv, false, 'bez hodnoty bodu se hrubý výsledek nehádá');
  assert.equal('maeTicks' in noPv, false);
  assert.equal(noPv.pnl, -14.4, 'čistý výsledek z NT zůstává');
});

test('vzorky exportů z Claude files (jen čtení, bez nich se přeskočí)', t => {
  const dir = require('node:path').join(__dirname, '..', '..', 'Claude files');
  const files = { 'nt8_exec .csv': 'executions', 'actual .csv': 'trades', 'nt8_trades.csv': 'trades' };
  let seen = 0;
  for (const [name, format] of Object.entries(files)) {
    const file = require('node:path').join(dir, name);
    if (!fs.existsSync(file)) continue;
    seen++;
    const table = N.parseTable(fs.readFileSync(file, 'utf8'));
    assert.equal(table.format, format, name);
    const r = format === 'executions' ? N.executionPayloads(table.rows, helpers) : N.tradeEvents(table.rows, helpers);
    assert.deepEqual(r.errors, [], name + ': všechny řádky čitelné');
  }
  if (!seen) t.skip('vzorky exportů nejsou k dispozici: ' + dir);
});
