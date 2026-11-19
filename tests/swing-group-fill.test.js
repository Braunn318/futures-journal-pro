'use strict';
// Naplnění skupiny limitek a přenos do obchodu (docs/ZADANI_SWING_SLUCOVANI_PRIKAZU.md §4),
// testy 5–9 zadání. Tvar dat MCP podle discovery (get_pending_orders, get_positions,
// get_order_history); čísla vymyšlená.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('../app/order-groups.js');
const FJSwing = require('../app/swing.js');

const plain = v => JSON.parse(JSON.stringify(v));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const lotSizeOf = () => 100000;
const dec = () => 5;
let n = 0;
const T0 = '2026-11-17T08:00:00.000Z';      // limitky poprvé viděné
const T1 = '2026-11-17T10:00:00.000Z';      // limitky zmizely, pozice otevřené
const T2 = '2026-11-18T16:00:00.000Z';      // TP1 zavřený (úterý)
const T3 = '2026-11-21T15:00:00.000Z';      // TP2 zavřený (pátek)
const gopts = (nowIso, extra = {}) => ({ account: '1234567', decimalsOf: dec, nowIso, lotSizeOf, nowLocal: FJSwing.berlinNowLocal(Date.parse(nowIso)), idGen: () => 'og_' + (++n), ...extra });

const order = (id, tp, o = {}) => ({ id: 'ct_' + id, source: 'CTRADER', externalId: String(id), symbol: 'USDCHF', direction: 'short', orderType: 'LIMIT', price: 0.8125, sl: 0.8165, tp, volume: 0.075, volumeInUnits: 7500, placedAt: null, ...o });
const pos = (id, tp, o = {}) => ({ id, symbolName: 'USDCHF', tradeSide: 'Sell', volumeInUnits: 7500, volumeInLots: 0.075, lotSize: 100000, entryPrice: 0.8125, stopLossPrice: 0.8165, takeProfitPrice: tp, openTime: '2026-11-17T09:12:00.000Z', ...o });
const hist = (id, close, closeTime, o = {}) => ({ positionId: id, symbolName: 'USDCHF', side: 'Sell', volume: 7500, entryPrice: 0.8125, closePrice: close, grossProfit: 69.6, netProfit: 68.9, swap: -0.2, commission: -0.5, openTime: '2026-11-17T09:12:00.000Z', closeTime, ...o });

const CONTEXT = {
  swingSetup: 'M2 daily', entryReason: 'odraz od VA hrany 4h', entryTf: '4h', htfTrend: 'dolů', weeklyCheck: 'OK',
  entryLevelType: 'VA hrana', grade: 'A', riskAmount: 240, images: ['fjimg://store/daily.webp', 'fjimg://store/h4.webp', 'fjimg://store/m15.webp'],
  comment: 'čekám na test', targetLevels: { ct_1: 'VPOC 4h', ct_2: 'Gap' }
};

// Jedna synchronizace jako v aplikaci: skupiny → naplnění → obchody skupin → planMcpSync.
function sync(state, live, data, nowIso) {
  const st = G.syncStage(state.groups, state.trades, live, data, gopts(nowIso));
  const p = FJSwing.planMcpSync(st.trades, data, { lotSizeOf, nowIso, nowLocal: FJSwing.berlinNowLocal(Date.parse(nowIso)) });
  return { groups: st.groups, trades: p.trades, pairs: p.pairs, stage: st };
}
function start() {
  let state = { groups: [], trades: [] };
  state = sync(state, [order(1, 0.8050), order(2, 0.7990)], { positions: [], history: [] }, T0);
  state.groups[0] = G.applyGroupContext(state.groups[0], CONTEXT, T0);
  return state;
}

test('5: obě limitky naplněné → 1 obchod, 2 výstupy, targetsPlanned = oba TP, oba positionId', () => {
  let s = start();
  s = sync(s, [], { positions: [pos(601, 0.8050), pos(602, 0.7990)], history: [] }, T1);
  assert.equal(s.trades.length, 1, 'jeden obchod za skupinu');
  let t = s.trades[0];
  assert.deepEqual(plain(t.ctraderPositionIds).sort(), ['ctrader-601', 'ctrader-602']);
  assert.equal(t.orderGroupId, s.groups[0].id);
  assert.equal(s.groups[0].tradeId, t.id);
  near(t.volume, 0.15);
  near(t.entryPrice, 0.8125);
  assert.equal(t.slInitial, 0.8165);
  assert.deepEqual(plain(t.targetsPlanned), [{ price: 0.805, levelType: 'VPOC 4h' }, { price: 0.799, levelType: 'Gap' }]);
  assert.equal(FJSwing.status(t), 'OPEN');
  // úterý TP1, pátek TP2 = 2 nohy jednoho obchodu
  s = sync(s, [], { positions: [pos(602, 0.7990)], history: [hist(601, 0.805, '2026-11-18T15:30:00.000Z')] }, T2);
  s = sync(s, [], { positions: [], history: [hist(601, 0.805, '2026-11-18T15:30:00.000Z'), hist(602, 0.799, '2026-11-21T14:00:00.000Z', { grossProfit: 117, netProfit: 116.3 })] }, T3);
  assert.equal(s.trades.length, 1);
  t = s.trades[0];
  assert.equal(t.exits.length, 2);
  near(t.volume, 0.15, 1e-9);
  assert.equal(FJSwing.status(t), 'CLOSED');
  near(FJSwing.swingDerived(t, { pipSize: 0.0001 }).pnlNetTotal, 68.9 + 116.3, 1e-6);
  // idempotence celé synchronizace
  const again = sync(s, [], { positions: [], history: [hist(601, 0.805, '2026-11-18T15:30:00.000Z'), hist(602, 0.799, '2026-11-21T14:00:00.000Z', { grossProfit: 117, netProfit: 116.3 })] }, T3);
  assert.deepEqual(plain(again.trades), plain(s.trades));
  assert.deepEqual(plain(again.groups), plain(s.groups));
});

test('6: kontext včetně screenshotů se přenese do obchodu, žádné pole formuláře nezmizí', () => {
  let s = start();
  s = sync(s, [], { positions: [pos(601, 0.8050), pos(602, 0.7990)], history: [] }, T1);
  const t = s.trades[0];
  for (const k of G.CONTEXT_FIELDS) assert.deepEqual(plain(t[k]), plain(CONTEXT[k]), k);
  assert.equal(t.contextFilledAt, s.groups[0].contextFilledAt);
  // formulář: každé kontextové pole swing formuláře je v CONTEXT_FIELDS (jinak by se při přenosu ztratilo)
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'swing-ui.js'), 'utf8');
  const m = /const SW_CONTEXT_INPUTS=(\[[^\n]*\]);/.exec(src);
  assert.ok(m, 'SW_CONTEXT_INPUTS ve swing-ui.js');
  const formKeys = JSON.parse(m[1].replace(/'/g, '"')).map(x => x[1]);
  for (const k of [...formKeys, 'grade', 'images', 'riskAmount']) assert.ok(G.CONTEXT_FIELDS.includes(k), 'pole formuláře ' + k);
  // ruční „Naplněno" i „Nenaplněno" nesou totéž
  for (const filled of [true, false]) {
    const d = G.draftFromGroup(s.groups[0], filled, '2026-11-17T10:00');
    for (const k of G.CONTEXT_FIELDS) assert.deepEqual(plain(d[k]), plain(CONTEXT[k]), (filled ? 'Naplněno ' : 'Nenaplněno ') + k);
    assert.deepEqual(plain(d.targetsPlanned), [{ price: 0.805, levelType: 'VPOC 4h' }, { price: 0.799, levelType: 'Gap' }]);
    assert.equal(d.orderGroupId, s.groups[0].id);
    assert.equal(d.contextFilledAt, s.groups[0].contextFilledAt);
  }
});

test('7: naplněná jen jedna limitka → obchod s 1 pozicí, druhá zůstává čekající ve skupině; zrušení = poznámka, ne SETUP_ONLY', () => {
  let s = start();
  s = sync(s, [order(2, 0.7990)], { positions: [pos(601, 0.8050)], history: [] }, T1);
  assert.equal(s.trades.length, 1);
  const t = s.trades[0];
  assert.deepEqual(plain(t.ctraderPositionIds), ['ctrader-601']);
  near(t.volume, 0.075);
  const g = s.groups[0];
  assert.equal(g.members.find(m => m.orderId === 'ct_2').state, 'PENDING');
  assert.equal(G.groupView(g).status, 'PARTIAL');
  // druhá limitka zrušena (zmizí bez pozice)
  s = sync(s, [], { positions: [pos(601, 0.8050)], history: [] }, T2);
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades.filter(x => x.recordType === 'SETUP_ONLY').length, 0);
  assert.deepEqual(plain(s.trades[0].cancelledOrders), [{ orderId: 'ct_2', label: 'TP2', tp: 0.799, volume: 0.075 }]);
  near(s.trades[0].volume, 0.075);
  assert.equal(G.groupView(s.groups[0]).status, 'FILLED');
});

test('7b: zbylá limitka se naplní později → pozice se přidá do téhož obchodu', () => {
  let s = start();
  s = sync(s, [order(2, 0.7990)], { positions: [pos(601, 0.8050)], history: [] }, T1);
  s = sync(s, [], { positions: [pos(601, 0.8050), pos(602, 0.7990, { openTime: '2026-11-18T07:00:00.000Z' })], history: [] }, T2);
  assert.equal(s.trades.length, 1);
  assert.deepEqual(plain(s.trades[0].ctraderPositionIds), ['ctrader-601', 'ctrader-602']);
  near(s.trades[0].volume, 0.15);
  assert.equal(s.trades[0].cancelledOrders, undefined);
  assert.equal(s.trades[0].openedAt, '2026-11-17T10:12', 'otevření = první naplnění');
});

test('8: Nenaplněno u skupiny → přesně 1 SETUP_ONLY za celou skupinu', () => {
  const s = start();
  const d = G.draftFromGroup(s.groups[0], false, '2026-11-17T10:00');
  assert.equal(d.recordType, 'SETUP_ONLY');
  assert.equal(d.fillStatus, 'NO_FILL');
  near(d.volume, 0.15);
  const saved = { ...d, id: 'sw_setup1' };
  const groups = G.recordGroupDecision(s.groups, s.groups[0].id, saved);
  assert.equal(groups[0].resolution, 'NO_FILL');
  assert.equal(groups[0].tradeId, 'sw_setup1');
  const trades = [...s.trades, saved];
  assert.equal(trades.filter(t => t.recordType === 'SETUP_ONLY').length, 1);
  // vyřešená skupina už nepáruje pozice (pozdější pozice = samostatný obchod)
  const st = G.syncStage(groups, trades, [], { positions: [pos(601, 0.805)], history: [] }, gopts(T1));
  assert.equal(st.trades.filter(t => (t.ctraderPositionIds || []).length).length, 0);
});

test('8b: Naplněno u skupiny → jeden obchod; pozice z cTraderu se pak doplní do něj (ruční hodnoty vyhrávají)', () => {
  let s = start();
  const d = G.draftFromGroup(s.groups[0], true, '2026-11-17T10:15');
  near(d.volume, 0.15);
  assert.equal(d.recordType, undefined);
  const manual = { ...d, id: 'sw_manual1', entryPrice: 0.8126 };
  s = { groups: G.recordGroupDecision(s.groups, s.groups[0].id, manual), trades: [manual] };
  s = sync(s, [], { positions: [pos(601, 0.8050), pos(602, 0.7990)], history: [] }, T1);
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades[0].id, 'sw_manual1');
  assert.deepEqual(plain(s.trades[0].ctraderPositionIds), ['ctrader-601', 'ctrader-602']);
  assert.equal(s.trades[0].entryPrice, 0.8126, 'ručně zadaný vstup se nepřepíše');
  assert.deepEqual(s.pairs, [], 'žádná otázka na spárování');
});

test('9: žádná pozice nesmí být ve dvou obchodech', () => {
  // a) pozice, která už má vlastní obchod, se ke skupině nepřipojí
  let s = start();
  const own = FJSwing.planMcpSync([], { positions: [pos(601, 0.805)], history: [] }, { lotSizeOf, nowIso: T1 }).trades;
  s = sync({ groups: s.groups, trades: own }, [], { positions: [pos(601, 0.805), pos(602, 0.799)], history: [] }, T1);
  const ids = s.trades.flatMap(t => [t.positionId, ...(t.ctraderPositionIds || [])].filter(Boolean));
  assert.equal(new Set(ids.filter((x, i) => ids.indexOf(x) === i)).size, new Set(ids).size);
  for (const pid of new Set(ids)) assert.equal(s.trades.filter(t => t.positionId === pid || (t.ctraderPositionIds || []).includes(pid)).length, 1, pid);
  // b) dvě skupiny, na které pozice pasuje stejně → nejednoznačné, nepáruje se
  n = 100;
  let s2 = { groups: [], trades: [] };
  s2 = sync(s2, [order(11, 0.805), order(21, 0.805, { price: 0.8120, sl: 0.8160 })], { positions: [], history: [] }, T0);
  assert.equal(s2.groups.length, 2);
  s2 = sync(s2, [], { positions: [pos(701, 0.805, { entryPrice: 0.8126, stopLossPrice: 0.8165 })], history: [] }, T1);
  assert.ok(s2.groups.every(g => !g.tradeId), 'žádná skupina si pozici nevzala');
  assert.equal(s2.trades.length, 1, 'pozice = samostatný obchod jako dřív');
  assert.equal(s2.trades[0].orderGroupId, undefined);
  // c) pozice otevřená dřív, než limitku deník viděl, se nepáruje
  let s3 = start();
  s3 = sync(s3, [], { positions: [pos(801, 0.805, { openTime: '2026-11-16T09:00:00.000Z' })], history: [] }, T1);
  assert.ok(!s3.groups[0].tradeId);
  // d) jiný objem / horší cena než limit se nepáruje
  for (const o of [{ volumeInUnits: 8000, volumeInLots: 0.08 }, { entryPrice: 0.8120 }]) {
    let s4 = start();
    s4 = sync(s4, [], { positions: [pos(901, 0.805, o)], history: [] }, T1);
    assert.ok(!s4.groups[0].tradeId, JSON.stringify(o));
  }
});

test('9b: cBot událost pozice, která je v obchodu skupiny, nezaloží druhý obchod', () => {
  let s = start();
  s = sync(s, [], { positions: [pos(601, 0.8050), pos(602, 0.7990)], history: [] }, T1);
  const t = s.trades[0];
  assert.equal(FJSwing.findTradeByPosition(s.trades, 'ctrader-602'), t);
  assert.equal(FJSwing.findTradeByPosition(s.trades, 'ctrader-601'), t);
  assert.equal(FJSwing.findTradeByPosition(s.trades, 'ctrader-999'), null);
});

test('screenshoty kontextu skupiny se počítají jako odkaz (přejmenování u obchodu je nesmaže)', () => {
  const { loadMain } = require('./helpers/extract');
  const main = loadMain(['journalImageOwners'], { imageBaseFor: () => 'x' });
  const owners = main.journalImageOwners({ trades: [{ id: 't1', images: ['fjimg://store/a.webp'] }], orderGroups: [{ id: 'og1', context: { images: ['fjimg://store/b.webp'] } }] });
  const og = owners.find(o => o.key === 'orderGroup:og1');
  assert.ok(og, 'skupina je mezi vlastníky obrázků');
  assert.equal(og.base, null, 'skupina obrázky nepřejmenovává');
  assert.deepEqual(plain(og.record.context.images), ['fjimg://store/b.webp']);
});
