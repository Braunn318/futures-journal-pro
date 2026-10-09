'use strict';
// Kontext obchodu v2, krok 3 (docs/ZADANI_KONTEXT.md A3, A7 testy 5–8):
// dopočtená pole. Počítají se při čtení z toho, co v obchodu už je, nic se do
// obchodu nezapisuje a chybějící vstup je null, nikdy 0.
//
// Fixtury jsou syntetické (MES, tick 0.25), long ze 7800 se SL 7798 (8 t)
// a cílem 7804 (16 t), pokud test neříká jinak.

const test = require('node:test');
const assert = require('node:assert/strict');

const FJContext = require('../app/context.js');

const TICK = 0.25;

const trade = overrides => ({
  id: 'x', instrument: 'MES', date: '2026-10-09', entryTime: '17:00', side: 'long', entryPrice: 7800,
  slPrice: 7798, targetLevel1: { type: 'VAH', price: 7804 }, ...overrides
});
const tg = (price, level = 'VWAP') => ({ level, price, ticksFromEntry: null });

// ------------------------------------------------- základ: ticky k cíli a k SL

test('A3: targetTicks a slTicks z cen; bez vstupu, cíle, SL nebo ticku null (ne 0)', () => {
  assert.equal(FJContext.targetTicks(trade(), TICK), 16);
  assert.equal(FJContext.slTicks(trade(), TICK), 8);
  assert.equal(FJContext.targetTicks(trade({ targetLevel1: { type: 'VAH', price: null } }), TICK), null);
  assert.equal(FJContext.targetTicks(trade({ entryPrice: '' }), TICK), null);
  assert.equal(FJContext.slTicks(trade({ slPrice: null }), TICK), null);
  assert.equal(FJContext.slTicks(trade(), null), null);
});

// ------------------------------------------------- 5. první překážka

test('A7/5: firstObstacleTicks bere nejbližší řádek v cestě k cíli', () => {
  const t = trade({ srTarget: [tg(7803), tg(7801.5)] });
  assert.equal(FJContext.pathMetrics(t, TICK).firstObstacleTicks, 6, '7801.5 je 6 t od vstupu, blíž než 7803 (12 t)');
});

test('A7/5: firstObstacleTicks ignoruje řádek za cílem, na ztrátové straně a do 1 t od cíle', () => {
  const t = trade({ srTarget: [tg(7805), tg(7799), tg(7803.75), tg(7803)] });
  // 7805 za cílem (beyondTarget), 7799 pod vstupem longu (behindEntry),
  // 7803.75 je 15 t = do 1 t od cíle 16 t. Zbývá 7803 = 12 t.
  assert.equal(FJContext.pathMetrics(t, TICK).firstObstacleTicks, 12);
  const onlyIgnored = trade({ srTarget: [tg(7805), tg(7799), tg(7803.75)] });
  assert.equal(FJContext.pathMetrics(onlyIgnored, TICK).firstObstacleTicks, null);
});

test('A7/5: short – znaménko i strany se otáčejí', () => {
  const t = trade({ side: 'short', slPrice: 7802, targetLevel1: { type: 'VAL', price: 7796 }, srTarget: [tg(7801), tg(7797.5), tg(7795)] });
  // 7801 nad vstupem shortu = ztrátová strana; 7795 za cílem; 7797.5 = 10 t.
  assert.equal(FJContext.pathMetrics(t, TICK).firstObstacleTicks, 10);
});

// ------------------------------------------------- 6. stav cesty

test('A7/6: pathState FREE jen u výslovného „žádná hladina“', () => {
  const m = FJContext.pathMetrics(trade({ srTargetNone: true }), TICK);
  assert.equal(m.pathState, 'FREE');
  assert.equal(m.firstObstacleTicks, null);
  assert.equal(m.freePathR, 2, 'volná cesta = celý cíl: 16 t / 8 t');
});

test('A7/6: pathState BLOCKED, když je v cestě hladina; freePathR do překážky', () => {
  const m = FJContext.pathMetrics(trade({ srTarget: [tg(7801)] }), TICK);
  assert.equal(m.pathState, 'BLOCKED');
  assert.equal(m.freePathR, 0.5, '4 t / 8 t');
});

test('A7/6: pathState TARGET_IS_LEVEL, když jediná hladina leží do 1 t od cíle', () => {
  assert.equal(FJContext.pathMetrics(trade({ srTarget: [tg(7804)] }), TICK).pathState, 'TARGET_IS_LEVEL');
  assert.equal(FJContext.pathMetrics(trade({ srTarget: [tg(7803.75)] }), TICK).pathState, 'TARGET_IS_LEVEL');
});

test('A7/6: UNKNOWN nikdy není FREE – nevyplněno, chybí cíl, řádek bez ceny', () => {
  const cases = {
    'bez řádků a bez „žádná“': trade({ srTarget: [] }),
    'pole vůbec není': trade(),
    'bez ceny cíle': trade({ srTarget: [tg(7801)], targetLevel1: { type: 'VAH', price: null } }),
    'řádek jen s ticky (bez ceny)': trade({ srTarget: [{ level: 'VWAP', price: null, ticksFromEntry: 4 }] }),
    'bez směru': trade({ side: '', srTarget: [tg(7801)] })
  };
  for (const [name, t] of Object.entries(cases)) {
    const m = FJContext.pathMetrics(t, TICK);
    assert.equal(m.pathState, 'UNKNOWN', name);
    assert.equal(m.freePathR, null, name + ': u neznámé cesty se volná cesta nepočítá');
  }
});

test('A7/6: řádky jen za cílem / na ztrátové straně = cesta volná (vyplněno, nic v ní)', () => {
  assert.equal(FJContext.pathMetrics(trade({ srTarget: [tg(7806), tg(7799)] }), TICK).pathState, 'FREE');
});

// ------------------------------------------------- 7. zóny chránící SL

const sl = (price, level = 'VAL') => ({ level, price, ticksFromEntry: null });

test('A7/7: slBufferTicks od nejbližší zóny k SL, včetně zóny nad vstupem do longu', () => {
  const t = trade({ srStopLoss: [sl(7799), sl(7800.5)] });
  // 7799 je 4 t nad SL, 7800.5 (nad vstupem longu) 10 t. Nejbližší = 4 t.
  const m = FJContext.slZoneMetrics(t, TICK);
  assert.equal(m.slBufferTicks, 4);
  assert.equal(m.slZoneCount, 2, 'zóna nad vstupem se počítá stejně');
  assert.deepEqual(FJContext.slZoneMetrics(trade({ srStopLoss: [sl(7800.5)] }), TICK), { slBufferTicks: 10, slZoneCount: 1 });
});

test('A7/7: zóna za SL (beyondStop) se do bufferu ani počtu nepočítá', () => {
  const m = FJContext.slZoneMetrics(trade({ srStopLoss: [sl(7797), sl(7799.5)] }), TICK);
  assert.deepEqual(m, { slBufferTicks: 6, slZoneCount: 1 });
  assert.deepEqual(FJContext.slZoneMetrics(trade({ srStopLoss: [sl(7797)] }), TICK), { slBufferTicks: null, slZoneCount: 0 });
});

test('A7/7: bez zón null, výslovně „žádná“ = 0 zón; bez SL nebo bez ceny zóny null', () => {
  assert.deepEqual(FJContext.slZoneMetrics(trade(), TICK), { slBufferTicks: null, slZoneCount: null });
  assert.deepEqual(FJContext.slZoneMetrics(trade({ srStopLossNone: true }), TICK), { slBufferTicks: null, slZoneCount: 0 });
  assert.deepEqual(FJContext.slZoneMetrics(trade({ slPrice: null, srStopLoss: [sl(7799)] }), TICK), { slBufferTicks: null, slZoneCount: null });
  assert.deepEqual(FJContext.slZoneMetrics(trade({ srStopLoss: [{ level: 'VAL', price: null, ticksFromEntry: 3 }] }), TICK), { slBufferTicks: null, slZoneCount: null });
});

// ------------------------------------------------- 8. pořadí v rámci dne

const day = [
  { id: 'a', date: '2026-10-09', entryTime: '15:31', result: 'target', pnlRaw: 10, fillStatus: 'FILLED' },
  { id: 'b', date: '2026-10-09', entryTime: '16:00', result: 'stoploss', pnlRaw: -5 },
  { id: 'c', date: '2026-10-09', entryTime: '17:00', result: 'target', pnlRaw: 8, wouldSkipLive: true },
  { id: 'setup', date: '2026-10-09', entryTime: '16:30', recordType: 'SETUP_ONLY', fillStatus: 'NO_FILL' },
  { id: 'nofill', date: '2026-10-09', entryTime: '16:40', fillStatus: 'NO_FILL', result: 'target', pnlRaw: 20 },
  { id: 'other', date: '2026-10-10', entryTime: '15:00', result: 'stoploss', pnlRaw: -3 }
];

test('A7/8: tradeNoInDay, prevResultInDay, dayPnlBefore podle času vstupu v rámci dne', () => {
  const m = FJContext.dayOrder(day);
  assert.deepEqual(m.get('a'), { tradeNoInDay: 1, prevResultInDay: 'FIRST', dayPnlBefore: 0 });
  assert.deepEqual(m.get('b'), { tradeNoInDay: 2, prevResultInDay: 'target', dayPnlBefore: 10 });
  assert.deepEqual(m.get('c'), { tradeNoInDay: 3, prevResultInDay: 'stoploss', dayPnlBefore: 5 }, '„naživo bych nevzal“ se počítá');
  assert.deepEqual(m.get('other'), { tradeNoInDay: 1, prevResultInDay: 'FIRST', dayPnlBefore: 0 }, 'jiný den začíná znovu');
  assert.equal(m.get('setup'), undefined, 'setup bez vstupu do pořadí nepatří');
  assert.equal(m.get('nofill'), undefined, 'nenaplněný hypotetický obchod do pořadí nepatří');
});

test('A7/8: po smazání prostředního obchodu se pořadí přepočítá samo', () => {
  const m = FJContext.dayOrder(day.filter(t => t.id !== 'b'));
  assert.deepEqual(m.get('c'), { tradeNoInDay: 2, prevResultInDay: 'target', dayPnlBefore: 10 });
});

test('A7/8: P/L bez pnlRaw se bere se znaménkem podle výsledku (jako signed())', () => {
  const m = FJContext.dayOrder([
    { id: 'a', date: '2026-10-09', entryTime: '15:00', result: 'stoploss', pnl: 7 },
    { id: 'b', date: '2026-10-09', entryTime: '15:10', result: 'breakeven', pnl: 2 },
    { id: 'c', date: '2026-10-09', entryTime: '15:20', result: 'target', pnl: 4 }
  ]);
  assert.equal(m.get('c').dayPnlBefore, -7);
});

// ------------------------------------------------- seance

test('A3: session – US seance v newyorském čase, evropská v berlínském', () => {
  const s = (date, time) => FJContext.sessionOf(date, time);
  assert.equal(s('2026-10-07', '09:00'), 'EU_MORNING');
  assert.equal(s('2026-10-07', '15:29'), 'EVENING_OTHER');
  assert.equal(s('2026-10-07', '15:30'), 'US_OPEN');
  assert.equal(s('2026-10-07', '17:00'), 'US_MID');
  assert.equal(s('2026-10-07', '19:30'), 'US_CLOSE');
  assert.equal(s('2026-10-07', '22:00'), 'EVENING_OTHER');
  assert.equal(s('2026-10-07', '15:44:12'), 'US_OPEN', 'čas i se sekundami');
  // Týdny, kdy USA a Evropa nemají letní čas souběžně: US open je ve 14:30 Berlína.
  assert.equal(s('2026-03-10', '14:30'), 'US_OPEN');
  assert.equal(s('2026-03-10', '13:00'), 'EU_MORNING');
  assert.equal(s('2026-10-28', '14:30'), 'US_OPEN');
  assert.equal(s('2026-10-28', '16:30'), 'US_MID');
});

test('A3: session bez data nebo času null', () => {
  assert.equal(FJContext.sessionOf('', '15:30'), null);
  assert.equal(FJContext.sessionOf('2026-10-07', ''), null);
});

// ------------------------------------------------- společný vstup

test('A3: derivedFields skládá vše a do obchodu nic nezapíše', () => {
  const t = trade({ srTarget: [tg(7801)], srStopLoss: [sl(7799)] });
  const before = JSON.stringify(t);
  const order = FJContext.dayOrder([t]);
  const d = FJContext.derivedFields(t, { tickSize: TICK, dayOrder: order });
  assert.equal(JSON.stringify(t), before, 'obchod se nezměnil');
  assert.equal(d.targetTicks, 16);
  assert.equal(d.pathState, 'BLOCKED');
  assert.equal(d.firstObstacleTicks, 4);
  assert.equal(d.slBufferTicks, 4);
  assert.equal(d.tradeNoInDay, 1);
  assert.equal(d.session, 'US_MID');
  assert.deepEqual(d.srTarget, [{ ticksFromEntrySigned: 4, ticksFromStop: null, beyondStop: null, beyondTarget: false, behindEntry: false }]);
  assert.deepEqual(d.srStopLoss, [{ ticksFromEntrySigned: -4, ticksFromStop: 4, beyondStop: false, beyondTarget: null, behindEntry: null }]);
  const bare = FJContext.derivedFields({ id: 'y' }, {});
  for (const key of ['targetTicks', 'slTicks', 'firstObstacleTicks', 'freePathR', 'slBufferTicks', 'slZoneCount', 'tradeNoInDay', 'prevResultInDay', 'dayPnlBefore', 'session']) {
    assert.equal(bare[key], null, key + ' bez vstupu null');
  }
  assert.equal(bare.pathState, 'UNKNOWN');
});

// ------------------------------------------------- cíl na hladině

test('A3: targetOnLevel podle vlastnosti „je to hladina“ položky slovníku cílů', () => {
  const cfg = { TARGET_LEVEL: { custom: { CUSTOM_FIX_RRR: 'Fix RRR' } } };
  const on = type => FJContext.targetOnLevel(trade({ targetLevel1: { type, price: 7804 } }), cfg);
  assert.equal(on('VAH'), true);
  assert.equal(on('MANUAL_EXIT'), false);
  assert.equal(on('TRAIL_M2'), false);
  assert.equal(on('CUSTOM_FIX_RRR'), false, 'výchozí „ne“ schválené pro Fix RRR');
  assert.equal(on('NEEXISTUJE'), null, 'klíč, který ve slovníku není, nejde posoudit');
  assert.equal(FJContext.targetOnLevel(trade({ targetLevel1: { type: '', price: 7804 } }), cfg), null);
  assert.equal(FJContext.targetOnLevel(trade({ targetLevel1PriceDerived: true }), cfg), false, 'cena dopočtená z výstupu není zadaná hladina');
  const flipped = { TARGET_LEVEL: { custom: { CUSTOM_FIX_RRR: 'Fix RRR' }, isLevel: { CUSTOM_FIX_RRR: true, VAH: false } } };
  assert.equal(FJContext.targetOnLevel(trade({ targetLevel1: { type: 'CUSTOM_FIX_RRR', price: 7804 } }), flipped), true, 'uživatel to přepne v nastavení');
  assert.equal(FJContext.targetOnLevel(trade(), flipped), false);
});
