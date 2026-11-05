'use strict';
// Synchronizace swing deníku z lokálního MCP serveru cTrader Desktop (bez cBota) –
// docs/ZADANI_CTRADER_MCP.md §4. Tvar dat podle discovery (get_positions, get_order_history,
// get_balance, get_accounts_list); čísla vymyšlená.
const test = require('node:test');
const assert = require('node:assert/strict');
const FJSwing = require('../app/swing.js');

const plain = v => JSON.parse(JSON.stringify(v));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const lotSizeOf = sym => (/JPY|USD|CAD|AUD|NZD|EUR|GBP|CHF/.test(sym) && sym.length === 6 ? 100000 : null);
const OPEN_POS = { id: 501, symbolName: 'AUDCAD', tradeSide: 'Buy', volumeInUnits: 3000, volumeInLots: 0.03, lotSize: 100000, entryPrice: 0.9756,
  stopLossPrice: 0.9750, takeProfitPrice: 0.9860, openTime: '2026-11-03T18:05:26.524Z', swap: 0.1, commission: -0.08 };
const PART_POS = { id: 502, symbolName: 'USDJPY', tradeSide: 'Buy', volumeInUnits: 4000, volumeInLots: 0.04, lotSize: 100000, entryPrice: 158.0,
  stopLossPrice: 157.5, takeProfitPrice: 160, openTime: '2026-11-04T01:30:00.000Z' };
const HIST = [
  // uzavřená pozice ve dvou nohách
  { positionId: 401, symbolName: 'EURAUD', side: 'Buy', volume: 4000, entryPrice: 1.58, closePrice: 1.59, grossProfit: 26, netProfit: 25.3, swap: -0.3, commission: -0.22, openTime: '2026-10-28T11:17:15.382Z', closeTime: '2026-10-30T09:00:00.000Z' },
  { positionId: 401, symbolName: 'EURAUD', side: 'Buy', volume: 3000, entryPrice: 1.58, closePrice: 1.594, grossProfit: 27, netProfit: 26.2, swap: -0.4, commission: -0.2, openTime: '2026-10-28T11:17:15.382Z', closeTime: '2026-11-02T06:53:14.412Z' },
  // částečně zavřená, dál otevřená pozice 502
  { positionId: 502, symbolName: 'USDJPY', side: 'Buy', volume: 3000, entryPrice: 158.0, closePrice: 158.6, grossProfit: 11.4, netProfit: 11.2, swap: 0, commission: -0.12, openTime: '2026-11-04T01:30:00.000Z', closeTime: '2026-11-04T12:00:00.000Z' }
];
const DATA = { positions: [OPEN_POS, PART_POS], history: HIST };
const opts = extra => ({ lotSizeOf, nowLocal: '2026-11-05T10:00', nowIso: '2026-11-05T09:00:00.000Z', ...extra });

test('MCP: otevřené pozice i historie se zapíšou – uzavřená po částech, otevřená, částečně uzavřená', () => {
  const p = FJSwing.planMcpSync([], DATA, opts());
  assert.equal(p.created, 3);
  const by = pid => p.trades.find(t => t.positionId === pid);
  const closed = by('ctrader-401');
  assert.equal(closed.exits.length, 2);
  near(closed.volume, 0.07);
  assert.equal(FJSwing.status(closed), 'CLOSED');
  assert.equal(closed.openedAt, '2026-10-28T12:17');
  // netto nohy = netProfit z cTraderu (rozdíl jde do komise)
  near(FJSwing.legPnlNet(closed.exits[0]), 25.3);
  near(FJSwing.legPnlNet(closed.exits[1]), 26.2);
  assert.equal(closed.exits[0].pnl, 26);
  assert.equal(closed.exits[0].swap, -0.3);
  near(closed.exits[0].commission, -0.4);
  const open = by('ctrader-501');
  assert.equal(FJSwing.status(open), 'OPEN');
  near(open.volume, 0.03);
  assert.equal(open.slInitial, 0.975);
  assert.deepEqual(plain(open.targetsPlanned), [{ price: 0.986, levelType: '' }]);
  const part = by('ctrader-502');
  near(part.volume, 0.07, 1e-9);
  assert.equal(part.exits.length, 1);
  assert.equal(FJSwing.status(part), 'OPEN');
  near(FJSwing.swingDerived(part, null).remainingVolume, 0.04);
});

test('MCP: druhá synchronizace nic nezmění (idempotence)', () => {
  const first = FJSwing.planMcpSync([], DATA, opts());
  const second = FJSwing.planMcpSync(first.trades, DATA, opts({ nowIso: '2026-11-05T09:05:00.000Z', nowLocal: '2026-11-05T10:05' }));
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.deepEqual(plain(second.trades), plain(first.trades));
});

test('MCP: pozice se zavře – noha přibude, objem zůstane celkový, stav CLOSED', () => {
  const first = FJSwing.planMcpSync([], DATA, opts());
  const later = { positions: [OPEN_POS], history: [...HIST, { positionId: 502, symbolName: 'USDJPY', side: 'Buy', volume: 4000, entryPrice: 158.0, closePrice: 158.9, grossProfit: 22.6, netProfit: 22.3, swap: -0.1, commission: -0.2, openTime: '2026-11-04T01:30:00.000Z', closeTime: '2026-11-05T08:00:00.000Z' }] };
  const p = FJSwing.planMcpSync(first.trades, later, opts());
  const t = p.trades.find(x => x.positionId === 'ctrader-502');
  assert.equal(t.exits.length, 2);
  near(t.volume, 0.07);
  assert.equal(FJSwing.status(t), 'CLOSED');
  assert.equal(p.updated, 1);
});

test('MCP: SL změněný mezi synchronizacemi → jeden posun s timeApprox, slInitial zůstane', () => {
  const first = FJSwing.planMcpSync([], DATA, opts());
  const moved = { positions: [{ ...OPEN_POS, stopLossPrice: 0.9756 }, PART_POS], history: HIST };
  const p = FJSwing.planMcpSync(first.trades, moved, opts({ nowLocal: '2026-11-05T12:00' }));
  const t = p.trades.find(x => x.positionId === 'ctrader-501');
  assert.equal(t.slInitial, 0.975);
  assert.deepEqual(plain(t.slMoves), [{ at: '2026-11-05T12:00', price: 0.9756, reason: null, timeApprox: true }]);
});

test('MCP: ruční hodnoty přežijí synchronizaci', () => {
  const first = FJSwing.planMcpSync([], DATA, opts());
  const edited = first.trades.map(t => t.positionId === 'ctrader-501'
    ? FJSwing.dropEditedImportedFields(t, { ...t, slInitial: 0.9745, entryPrice: 0.9757, swingSetup: 'M2 daily', comment: 'ručně' }) : t);
  const p = FJSwing.planMcpSync(edited, DATA, opts());
  const t = p.trades.find(x => x.positionId === 'ctrader-501');
  assert.equal(t.slInitial, 0.9745);
  assert.equal(t.entryPrice, 0.9757);
  assert.equal(t.swingSetup, 'M2 daily');
  assert.equal(t.comment, 'ručně');
});

test('MCP: noha, kterou už zapsal cBot, se nepřidá podruhé', () => {
  const cbot = { id: 'sw_x', kind: 'SWING', source: 'CTRADER', positionId: 'ctrader-401', symbol: 'EURAUD', direction: 'long', openedAt: '2026-10-28T12:17', entryPrice: 1.58,
    volume: 0.04, volumeFromLegs: true, importedFields: ['symbol', 'direction', 'openedAt', 'entryPrice', 'volume'],
    exits: [{ closedAt: '2026-10-30T10:00', price: 1.59, volume: 0.04, pnl: 26, swap: -0.3, commission: -0.4, externalId: '800001', source: 'CTRADER' }] };
  const p = FJSwing.planMcpSync([cbot], { positions: [], history: HIST.filter(h => h.positionId === 401) }, opts());
  const t = p.trades.find(x => x.positionId === 'ctrader-401');
  assert.equal(t.exits.length, 2, 'první noha z cBota + druhá z MCP');
  near(t.volume, 0.07);
});

test('MCP: ručně zadaný obchod → kandidát na spárování, bez rozhodnutí se nic nezapíše; rozhodnutí se použije', () => {
  const manual = { id: 'm1', kind: 'SWING', source: 'MANUAL', symbol: 'AUDCAD', direction: 'long', openedAt: '2026-11-03T19:06', entryPrice: 0.9756, volume: 0.03, exits: [], swingSetup: 'Gap jako SR' };
  const p = FJSwing.planMcpSync([manual], { positions: [OPEN_POS], history: [] }, opts());
  assert.equal(p.created, 0);
  assert.deepEqual(p.pairs.map(x => [x.positionId, x.candidateId]), [['ctrader-501', 'm1']]);
  assert.equal(p.trades.length, 1);
  const yes = FJSwing.planMcpSync([manual], { positions: [OPEN_POS], history: [] }, opts({ decisions: new Map([['ctrader-501', 'm1']]) }));
  assert.equal(yes.trades.length, 1);
  assert.equal(yes.trades[0].id, 'm1');
  assert.equal(yes.trades[0].positionId, 'ctrader-501');
  assert.equal(yes.trades[0].swingSetup, 'Gap jako SR');
  assert.equal(yes.trades[0].slInitial, 0.975);
  const no = FJSwing.planMcpSync([manual], { positions: [OPEN_POS], history: [] }, opts({ decisions: new Map([['ctrader-501', 'NEW']]) }));
  assert.equal(no.trades.length, 2);
});

test('MCP: neznámá velikost lotu → noha se nepřidá, symbol se nahlásí', () => {
  const ger = { positionId: 777, symbolName: 'GER40', side: 'Sell', volume: 2, entryPrice: 24000, closePrice: 23900, grossProfit: 200, netProfit: 199, swap: 0, commission: -1, openTime: '2026-11-01T08:00:00.000Z', closeTime: '2026-11-02T08:00:00.000Z' };
  const p = FJSwing.planMcpSync([], { positions: [], history: [ger] }, opts());
  assert.ok(p.missingLot.has('GER40'));
  assert.equal(p.trades.some(x => x.positionId === 'ctrader-777'), false, 'prázdný obchod se nezaloží');
  assert.equal(p.created, 0);
});

test('MCP: importovat od data – starší pozice se přeskočí, už importované se aktualizují dál', () => {
  const p = FJSwing.planMcpSync([], DATA, opts({ importFrom: '2026-11-01' }));
  assert.equal(p.trades.some(t => t.positionId === 'ctrader-401'), false);
  assert.equal(p.skippedOld, 1);
  assert.equal(p.created, 2);
});

test('aktivní účet v cTraderu musí být ten vybraný v deníku', () => {
  const accounts = [
    { id: 1, login: 111, brokerTitle: 'Spotware', currency: 'EUR', balance: 1000, isLive: false },
    { id: 2, login: 222, brokerTitle: 'Broker X', currency: 'USD', balance: 9765.8, isLive: true }
  ];
  const balance = { brokerName: 'Broker X', depositAsset: 'USD', balance: 9765.8 };
  assert.deepEqual(FJSwing.mcpActiveAccountCheck({ login: '222' }, balance, accounts), { ok: true });
  assert.equal(FJSwing.mcpActiveAccountCheck({ login: '111' }, balance, accounts).reason, 'OTHER_ACTIVE');
  assert.equal(FJSwing.mcpActiveAccountCheck(null, balance, accounts).reason, 'NO_ACCOUNT');
  const twins = [...accounts, { id: 3, login: 333, brokerTitle: 'Broker X', currency: 'USD', balance: 9765.8 }];
  assert.equal(FJSwing.mcpActiveAccountCheck({ login: '222' }, balance, twins).reason, 'AMBIGUOUS');
});
