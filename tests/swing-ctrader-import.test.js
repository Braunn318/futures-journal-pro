'use strict';
// Import obchodů z cTraderu (cBot konektor) do swing deníku – docs/ZADANI_CTRADER_MCP.md §4,
// swing model docs/ZADANI_SWING_CFD.md §4. Obchod = pozice (ctrader-<positionId>), uzavření = noha,
// peníze se znaménkem z cTraderu, ruční hodnoty se nepřepisují, párování jen po potvrzení.
const test = require('node:test');
const assert = require('node:assert/strict');
const FJSwing = require('../app/swing.js');
const { loadFromSource, readRepoFile } = require('./helpers/extract');

const plain = v => JSON.parse(JSON.stringify(v));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const LOT = 100000;
const base = { account: '7654321', instrument: 'EURUSD', side: 'long', entryTime: '2026-11-03T08:00:00.000Z', entryPrice: 1.1, positionId: 'ctrader-555', source: 'ctrader' };
const OPEN = { ...base, id: 'e-open', type: 'trade_opened', quantity: 20000 };
const CLOSE1 = { ...base, id: 'e-c1', type: 'trade_closed', exitTime: '2026-11-04T10:30:00.000Z', exitPrice: 1.105, quantity: 10000,
  pnl: 48.5, ctraderNet: 48.5, ctraderSwap: -0.5, ctraderCommission: -1, sourceExecutionId: '9001' };
const CLOSE2 = { ...base, id: 'e-c2', type: 'trade_closed', exitTime: '2026-11-06T15:00:00.000Z', exitPrice: 1.11, quantity: 10000,
  pnl: 96.2, ctraderNet: 96.2, ctraderSwap: -1.8, ctraderCommission: -2, sourceExecutionId: '9002' };

function importAll(events, start = null) {
  let t = start;
  for (const e of events) {
    if (!t) t = FJSwing.swingFromCtraderEvent(e, LOT);
    else if (e.type === 'trade_opened') t = FJSwing.mergeImported(t, FJSwing.swingFromCtraderEvent(e, LOT));
    if (e.type === 'trade_closed') t = FJSwing.applyCtraderClose(t, e, LOT).trade;
  }
  return t;
}

test('1: otevření + 2 částečná uzavření → 1 obchod, 2 nohy; netto nohy = NetProfit z cTraderu', () => {
  const t = importAll([OPEN, CLOSE1, CLOSE2]);
  assert.equal(t.kind, 'SWING');
  assert.equal(t.source, 'CTRADER');
  assert.equal(t.positionId, 'ctrader-555', 'stejný klíč jako cBot');
  assert.equal(t.symbol, 'EURUSD');
  assert.equal(t.direction, 'long');
  assert.equal(t.openedAt, '2026-11-03T09:00', 'UTC → Berlín');
  near(t.volume, 0.2);
  assert.equal(t.exits.length, 2);
  near(t.exits[0].volume, 0.1);
  assert.equal(t.exits[0].closedAt, '2026-11-04T11:30');
  assert.equal(t.exits[0].swap, -0.5);
  assert.equal(t.exits[0].commission, -1);
  near(FJSwing.legPnlNet(t.exits[0]), 48.5);
  near(FJSwing.legPnlNet(t.exits[1]), 96.2);
  const d = FJSwing.swingDerived(t, { pipSize: 0.0001 });
  assert.equal(d.status, 'CLOSED');
  near(d.pnlNetTotal, 144.7);
  near(d.pipsPerUnit, 75, 1e-6);
});

test('2: stejné události dvakrát → beze změny (nohy podle closingDealId)', () => {
  const once = importAll([OPEN, CLOSE1, CLOSE2]);
  const twice = importAll([OPEN, CLOSE1, CLOSE2], once);
  assert.deepEqual(plain(twice), plain(once));
  assert.equal(FJSwing.applyCtraderClose(once, CLOSE1, LOT).changed, false);
});

test('3: uzavření bez otevírací události → obchod z nohy, objem roste s každou nohou', () => {
  const t1 = importAll([CLOSE1]);
  assert.equal(t1.volumeFromLegs, true);
  near(t1.volume, 0.1);
  assert.equal(t1.entryPrice, 1.1);
  assert.equal(t1.openedAt, '2026-11-03T09:00');
  const t2 = importAll([CLOSE2], t1);
  near(t2.volume, 0.2);
  assert.equal(FJSwing.status(t2), 'CLOSED');
});

test('4: ruční slInitial, setup, komentář a upravená cena vstupu přežijí další import', () => {
  const imported = importAll([OPEN]);
  const edited = FJSwing.dropEditedImportedFields(imported, { ...imported, entryPrice: 1.1002, slInitial: 1.095, swingSetup: 'M2 daily', comment: 'ruční' });
  assert.ok(!edited.importedFields.includes('entryPrice'), 'ručně upravené pole už import nepřepíše');
  const again = importAll([OPEN, CLOSE1], edited);
  assert.equal(again.entryPrice, 1.1002);
  assert.equal(again.slInitial, 1.095);
  assert.equal(again.swingSetup, 'M2 daily');
  assert.equal(again.comment, 'ruční');
  assert.equal(again.exits.length, 1);
});

test('5: ručně zadaný obchod + import stejné pozice → kandidát na spárování, bez potvrzení nic', () => {
  const manual = { id: 'm1', kind: 'SWING', source: 'MANUAL', symbol: 'EURUSD', direction: 'long', openedAt: '2026-11-03T09:03', entryPrice: 1.1001, volume: 0.2, exits: [] };
  const draft = FJSwing.swingFromCtraderEvent(OPEN, LOT);
  assert.equal(FJSwing.findPairCandidate([manual], draft).id, 'm1');
  // jiný objem / směr / čas mimo 5 min → žádný kandidát
  assert.equal(FJSwing.findPairCandidate([{ ...manual, volume: 0.3 }], draft), null);
  assert.equal(FJSwing.findPairCandidate([{ ...manual, direction: 'short' }], draft), null);
  assert.equal(FJSwing.findPairCandidate([{ ...manual, openedAt: '2026-11-03T09:10' }], draft), null);
  // už spárovaný obchod není kandidát
  assert.equal(FJSwing.findPairCandidate([{ ...manual, positionId: 'ctrader-1' }], draft), null);
  // spárování: ruční hodnoty zůstanou, doplní se klíč a prázdná pole
  const paired = FJSwing.mergeImported({ ...manual, positionId: draft.positionId }, draft);
  assert.equal(paired.entryPrice, 1.1001);
  assert.equal(paired.openedAt, '2026-11-03T09:03');
  assert.equal(paired.positionId, 'ctrader-555');
  assert.equal(paired.id, 'm1');
});

test('7: neznámá velikost lotu → nic se nevytvoří ani nepřidá', () => {
  assert.equal(FJSwing.swingFromCtraderEvent(OPEN, null), null);
  const t = importAll([OPEN]);
  const r = FJSwing.applyCtraderClose(t, CLOSE1, null);
  assert.equal(r.changed, false);
  assert.equal(r.missingLot, true);
  assert.equal(r.trade, t);
});

test('8: SL z MCP – první synchronizace → slInitial, změna → jeden posun s timeApprox; ruční SL se nepřepíše', () => {
  const t = importAll([OPEN]);
  const first = FJSwing.applyMcpPosition(t, { stopLossPrice: 1.095, takeProfitPrice: 1.12 }, '2026-11-03T10:00');
  assert.equal(first.trade.slInitial, 1.095);
  assert.deepEqual(plain(first.trade.targetsPlanned), [{ price: 1.12, levelType: '' }]);
  const same = FJSwing.applyMcpPosition(first.trade, { stopLossPrice: 1.095, takeProfitPrice: 1.13 }, '2026-11-03T11:00');
  assert.equal(same.changed, false, 'stejný SL ani změněný TP (cíl je už vyplněný) nic nezapíšou');
  const moved = FJSwing.applyMcpPosition(first.trade, { stopLossPrice: 1.1 }, '2026-11-04T08:00');
  assert.deepEqual(plain(moved.trade.slMoves), [{ at: '2026-11-04T08:00', price: 1.1, reason: null, timeApprox: true }]);
  assert.equal(moved.trade.slInitial, 1.095, 'základ R se nemění');
  const again = FJSwing.applyMcpPosition(moved.trade, { stopLossPrice: 1.1 }, '2026-11-04T09:00');
  assert.equal(again.changed, false);
  const manualSl = FJSwing.applyMcpPosition({ ...t, slInitial: 1.094 }, { stopLossPrice: 1.094 }, 'x');
  assert.equal(manualSl.changed, false);
});

test('9: starší událost bez surového swapu a komise → pnl = NetProfit, swap a komise prázdné', () => {
  const legacy = { ...CLOSE1, ctraderNet: undefined, ctraderSwap: undefined, ctraderCommission: undefined, commission: 1.5 };
  delete legacy.ctraderNet; delete legacy.ctraderSwap; delete legacy.ctraderCommission;
  const t = FJSwing.applyCtraderClose(importAll([OPEN]), legacy, LOT).trade;
  assert.equal(t.exits[0].pnl, 48.5);
  assert.equal(t.exits[0].swap, null);
  assert.equal(t.exits[0].commission, null);
  near(FJSwing.legPnlNet(t.exits[0]), 48.5);
});

test('instrumenty: výchozí lotSize (FX 100000, XAUUSD 100), uložený řádek bez lotSize výchozí nepřepíše', () => {
  const list = FJSwing.instrumentsOf({ cfdInstruments: [{ symbol: 'EURUSD', pipSize: 0.0001, priceDecimals: 5 }, { symbol: 'US500', pipSize: 1, lotSize: 1 }] });
  assert.equal(FJSwing.findInstrument('EURUSD', list).lotSize, 100000);
  assert.equal(FJSwing.findInstrument('XAUUSD', list).lotSize, 100);
  assert.equal(FJSwing.findInstrument('US500', list).lotSize, 1);
  assert.equal(FJSwing.findInstrument('GER40', list).lotSize ?? null, null);
});

// ---- tok v rozhraní: importSwingCtraderEvent (app/swing-ui.js) ----
function uiEnv(journal, { confirm = true, mcpLot = null } = {}) {
  const store = { j1: structuredClone(journal) };
  const calls = { confirms: 0, writes: 0 };
  const globals = {
    FJSwing, journalProfiles: [{ id: 'j1', journalType: 'CFD_SWING' }], activeJournalId: 'j0',
    window: { desktopAPI: {
      readJournal: async id => ({ ok: true, data: structuredClone(store[id]) }),
      writeJournal: async (id, data) => { store[id] = structuredClone(data); calls.writes++; return { ok: true }; },
      ctraderSymbolDetails: async () => (mcpLot ? { available: true, details: { lotSize: mcpLot } } : { available: false })
    } },
    localStorage: { getItem: () => JSON.stringify({ enabled: mcpLot != null }), setItem() {} },
    showConfirm: async () => { calls.confirms++; return confirm; },
    capturedImages: async () => [],
    swingPairPending: new Set(), swingPairDecisions: new Map(), swingImportWaiting: new Map(), swingImportChain: Promise.resolve()
  };
  const api = loadFromSource(readRepoFile('app/swing-ui.js'),
    ['MCP_SETTINGS_KEY', 'mcpSettings', 'swingLotSizeFor', 'importSwingCtraderEvent', 'importSwingCtraderEventNow'], globals);
  return { api, store, calls };
}

test('UI: událost cBota do swing deníku → swing obchod, opakování nic nezmění', async () => {
  const { api, store, calls } = uiEnv({ trades: [], settings: [] });
  assert.equal(await api.importSwingCtraderEvent('j1', OPEN), 'done');
  assert.equal(await api.importSwingCtraderEvent('j1', CLOSE1), 'done');
  assert.equal(await api.importSwingCtraderEvent('j1', CLOSE1), 'done');
  const t = store.j1.trades;
  assert.equal(t.length, 1);
  assert.equal(t[0].exits.length, 1);
  assert.equal(calls.confirms, 0);
});

test('UI: ruční obchod + import → potvrzení; Ne = nový obchod, Ano = spárovat (žádný duplikát)', async () => {
  const manual = { id: 'm1', kind: 'SWING', source: 'MANUAL', symbol: 'EURUSD', direction: 'long', openedAt: '2026-11-03T09:02', entryPrice: 1.1001, volume: 0.2, exits: [], swingSetup: 'Gap jako SR' };
  const yes = uiEnv({ trades: [manual], settings: [] }, { confirm: true });
  await yes.api.importSwingCtraderEvent('j1', OPEN);
  await yes.api.importSwingCtraderEvent('j1', CLOSE1);
  assert.equal(yes.store.j1.trades.length, 1);
  assert.equal(yes.store.j1.trades[0].id, 'm1');
  assert.equal(yes.store.j1.trades[0].positionId, 'ctrader-555');
  assert.equal(yes.store.j1.trades[0].entryPrice, 1.1001);
  assert.equal(yes.store.j1.trades[0].exits.length, 1);
  assert.equal(yes.calls.confirms, 1, 'zeptá se jen jednou');
  const no = uiEnv({ trades: [manual], settings: [] }, { confirm: false });
  await no.api.importSwingCtraderEvent('j1', OPEN);
  assert.equal(no.store.j1.trades.length, 2);
});

test('UI: neznámá velikost lotu → čeká, nic se nezapíše; s MCP se doplní do tabulky instrumentů', async () => {
  const ev = { ...OPEN, instrument: 'GER40', positionId: 'ctrader-777' };
  const off = uiEnv({ trades: [], settings: [] });
  assert.equal(await off.api.importSwingCtraderEvent('j1', ev), 'wait');
  assert.equal(off.calls.writes, 0);
  const on = uiEnv({ trades: [], settings: [{ key: 'main', value: {} }] }, { mcpLot: 1 });
  assert.equal(await on.api.importSwingCtraderEvent('j1', { ...ev, quantity: 2 }), 'done');
  assert.equal(on.store.j1.trades[0].volume, 2);
  assert.equal(FJSwing.findInstrument('GER40', FJSwing.instrumentsOf(on.store.j1.settings[0].value)).lotSize, 1);
});

test('6: import – NT8 do swing deníku zůstane ve frontě, cTrader se zpracuje (zdroj v importu)', () => {
  const html = readRepoFile('app/index.html');
  const skips = html.split("isSwingJournalId(journalId)&&e.source!=='ctrader')continue;").length - 1;
  assert.equal(skips, 2, 'importCapturedTrades a attachAfterShots přeskočí jen ne-cTrader zdroje');
  assert.ok(html.includes("importSwingCtraderEvent(journalId,e)"), 'cTrader události do swing deníku jdou přes swing import');
});
