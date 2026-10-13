'use strict';
// Dokup do otevřené pozice a následné částečné výstupy.
//
// Průměrná vstupní cena pozice měla dva zdroje, které počítají jinak: vlastní
// vážený průměr při dokupu a Position.AveragePrice ze snímku pozic, který ji
// po každé exekuci přepsal. NinjaTrader po částečném výstupu vede průměr
// ZBYTKU (FIFO po plněních), deník průměrnou cenu celé pozice – jakmile se
// čísla rozešla, další výstup se počítal od jiného a část zisku zmizela.
// Netýká se to jen dokupu: stačí vstup naplněný na dvě ceny a výstup po částech.
//
// Hlášeno 2026-10-13 (MNQ long, 7 kontraktů): deník 148 b = 296 USD hrubého,
// NinjaTrader 155 b = 310 USD.
//
// Sekvence jsou opsané ze skutečného záznamu trade-capture/events.json toho,
// kdo chybu nahlásil (ceny, počty, časy, komise; bez názvu účtu). Snímky pozic
// se do záznamu neukládají – jejich průměr je vstupní cena, kterou aplikace
// zapsala u následující nohy, tedy přesně to, co jí snímek podstrčil.

const test = require('node:test');
const assert = require('node:assert/strict');

const { captureHarness } = require('./helpers/capture-harness');

const MNQ = { instrument: 'MNQ', instrumentFull: 'MNQ 12-26', pointValue: 2, startTime: '2026-10-13T16:09:00.000Z' };
const NQ = { instrument: 'NQ', instrumentFull: 'NQ 12-26', pointValue: 20, startTime: '2026-09-28T07:54:00.000Z' };
const harness = () => captureHarness(MNQ);
const FEE = 0.95;   // komise za kontrakt a stranu
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message || 'hodnota'}: ${actual} ≠ ${expected}`);
const sum = (list, key) => list.reduce((a, e) => a + Number(e[key] || 0), 0);

const buy = (executionId, orderId, quantity, price, positionAfter, time) =>
  ({ executionId, orderId, orderAction: 'Buy', orderName: 'Entry', quantity, price, positionAfter, time, commission: FEE * quantity });
const sell = (executionId, orderId, orderName, quantity, price, positionAfter, time) =>
  ({ executionId, orderId, orderAction: 'Sell', orderName, quantity, price, positionAfter, time, commission: FEE * quantity });
// Obecná exekuce pro sekvence ze záznamu (short, jiná komise).
const fill = (executionId, orderId, orderAction, quantity, price, positionAfter, fee = FEE) =>
  ({ executionId, orderId, orderAction, orderName: /^(Buy|SellShort)$/.test(orderAction) ? 'Entry' : 'Exit', quantity, price, positionAfter, commission: fee * quantity });

// Přehraje kroky [exekuce, průměr ze snímku po ní]. Průměr `null` = plochý
// snímek, `undefined` = snímek mezi exekucemi nedorazil.
async function play(h, steps, { snapshots = true } = {}) {
  for (const [exec, avg] of steps) {
    await h.exec(exec);
    h.clock.t += 60000;
    if (!snapshots || avg === undefined) continue;
    if (avg === null) h.flat();
    else h.holding(Math.abs(exec.positionAfter), exec.positionAfter > 0 ? 'Long' : 'Short', avg);
  }
}

// ---- hlášený obchod, 2026-10-13 ----

const ENTRY_AVG = (30738.50 + 5 * 30738.75) / 6;
const REPORTED = [
  [buy('e1', 'o-entry', 1, 30738.50, 1, '2026-10-13T16:09:41.807Z')],
  [buy('e2', 'o-entry', 5, 30738.75, 6, '2026-10-13T16:09:41.819Z'), ENTRY_AVG],
  [sell('t1', 'o-tp1', 'Target1', 4, 30752.50, 2, '2026-10-13T16:16:58.444Z'), 30738.75],
  [buy('e3', 'o-dokup', 1, 30759.50, 3, '2026-10-13T16:19:57.198Z'), (2 * 30738.75 + 30759.50) / 3],
  [sell('t2', 'o-tp2', 'Stop2', 1, 30763.75, 2, '2026-10-13T16:26:20.462Z'), (30738.75 + 30759.50) / 2],
  [sell('t3', 'o-tp3', 'Target2', 2, 30786.50, 0, '2026-10-13T16:30:17.582Z'), null]
];
// Σ výstupů − Σ vstupů, tedy to, co ukáže broker.
const CASH_POINTS = (4 * 30752.50 + 30763.75 + 2 * 30786.50) - (30738.50 + 5 * 30738.75 + 30759.50);

test('2026-10-13: dokup a částečné výstupy – hrubý výsledek sedí na peněžní tok', async () => {
  const h = harness();
  await play(h, REPORTED);
  const legs = h.closed();
  near(CASH_POINTS, 155, 'kontrola zadání');
  near(sum(legs, 'grossPnl'), 310, 'hrubý výsledek (aplikace zaznamenala 296)');
  near(sum(legs, 'commission'), 14 * FEE, 'komise = součet komisí všech exekucí');
  near(sum(legs, 'pnl'), 310 - 14 * FEE, 'čistý výsledek');
  assert.equal(sum(legs, 'quantity'), 7);
  assert.equal(new Set(legs.map(l => l.positionId)).size, 1, 'jedna pozice – jedno ID pro sloučení cílů');
  assert.equal(h.opened().length, 1, 'dokup není nová pozice');
  assert.equal(h.open().length, 0);
});

test('výstup se dělí podle vstupu: poslední cíl zavírá původní kontrakt i ten dokoupený', async () => {
  const h = harness();
  await play(h, REPORTED);
  const legs = h.closed();
  assert.deepEqual(legs.map(l => l.quantity), [4, 1, 1, 1]);
  assert.deepEqual(legs.map(l => l.sourceExecutionId), ['t1', 't2', 't3', 't3'], 'oba úseky posledního cíle nesou tutéž výstupní exekuci');
  const expected = [
    [ENTRY_AVG, 30752.50],   // TP1: +13,79
    [ENTRY_AVG, 30763.75],   // TP2: +25,04 (aplikace zaznamenala +18,08 od průměru 30745,67)
    [ENTRY_AVG, 30786.50],   // TP3, původní kontrakt: +47,79 (zaznamenáno +37,375 od 30749,125)
    [30759.50, 30786.50]     // TP3, dokoupený kontrakt: +27,00
  ];
  legs.forEach((leg, i) => {
    near(leg.entryPrice, expected[i][0], `vstupní cena nohy ${i}`);
    assert.equal(leg.exitPrice, expected[i][1]);
    near(leg.points, expected[i][1] - expected[i][0], `body nohy ${i}`);
    near(leg.grossPnl, (expected[i][1] - expected[i][0]) * leg.quantity * 2, `hrubý výsledek nohy ${i}`);
  });
  assert.equal(legs[2].entryTime, '2026-10-13T16:09:41.807Z', 'původní kontrakt: čas vstupu');
  assert.equal(legs[3].entryTime, '2026-10-13T16:19:57.198Z', 'dokoupený kontrakt: čas dokupu');
  near(legs[3].commission, 2 * FEE, 'dokoupený kontrakt nese svou vstupní komisi a podíl výstupní');
});

// Výsledek nesmí záviset na tom, co o průměrné ceně říká snímek – ani na tom,
// jestli vůbec dorazil.
test('snímky pozic výsledek nemění', async () => {
  const withSnapshots = harness();
  await play(withSnapshots, REPORTED);
  const without = harness();
  await play(without, REPORTED, { snapshots: false });
  const pick = h => h.closed().map(l => [l.quantity, l.entryPrice, l.exitPrice, l.grossPnl, l.commission]);
  assert.deepEqual(pick(withSnapshots), pick(without));
});

// ---- další pozice z téhož záznamu ----

// 2026-09-28, NQ long 3 kontrakty, ŽÁDNÝ dokup: vstup se naplnil na dvě ceny
// a mezi dvěma plněními prvního cíle dorazil snímek s průměrem zbytku.
// Aplikace zaznamenala 191,67 + 190,00 + 500,00 = 881,67; broker 885,00.
// V záznamu je takových pozic 29 ze 122.
test('2026-09-28: vstup na dvě ceny a výstup po částech, bez dokupu', async () => {
  const h = captureHarness(NQ);
  await play(h, [
    [fill('e1', 'o-entry', 'Buy', 1, 30602.25, 1, 2.88)],
    [fill('e2', 'o-entry', 'Buy', 2, 30602.50, 3, 2.88), (30602.25 + 2 * 30602.50) / 3],
    [fill('t1a', 'o-tp1', 'Sell', 1, 30612.00, 2, 2.88), 30602.50],
    [fill('t1b', 'o-tp1', 'Sell', 1, 30612.00, 1, 2.88), 30602.50],
    [fill('t2', 'o-tp2', 'Sell', 1, 30627.50, 0, 2.88), null]
  ]);
  const legs = h.closed();
  assert.equal(legs.length, 3);
  near(sum(legs, 'grossPnl'), 885, 'hrubý výsledek (aplikace zaznamenala 881,67)');
  legs.forEach((l, i) => near(l.entryPrice, (30602.25 + 2 * 30602.50) / 3, `noha ${i}: jeden vstup, jedna vstupní cena`));
  near(sum(legs, 'commission'), 6 * 2.88);
});

// 2026-09-28, NQ short: vstup 3 (na dvě ceny), TP1 dva kontrakty, dokup níž,
// zbytek zavřený dvěma plněními na stejné ceně. Zaznamenáno 926,67 + 1275,00
// + 815,00 = 3016,67; broker 3480,00.
test('2026-09-28: short s dokupem', async () => {
  const h = captureHarness(NQ);
  const entry = (2 * 30538.75 + 30538.50) / 3;
  await play(h, [
    [fill('e1', 'o-entry', 'SellShort', 2, 30538.75, -2, 2.88)],
    [fill('e2', 'o-entry', 'SellShort', 1, 30538.50, -3, 2.88), entry],
    [fill('t1', 'o-tp1', 'BuyToCover', 2, 30515.50, -1, 2.88), 30538.50],
    [fill('e3', 'o-dokup', 'SellShort', 1, 30492.50, -2, 2.88), (30538.50 + 30492.50) / 2],
    [fill('t2a', 'o-tp2a', 'BuyToCover', 1, 30451.75, -1, 2.88), 30492.50],
    [fill('t2b', 'o-tp2b', 'BuyToCover', 1, 30451.75, 0, 2.88), null]
  ]);
  const legs = h.closed();
  near(sum(legs, 'grossPnl'), 3480, 'hrubý výsledek (aplikace zaznamenala 3016,67)');
  assert.deepEqual(legs.map(l => l.quantity), [2, 1, 1]);
  near(legs[1].entryPrice, entry, 'třetí původní kontrakt');
  assert.equal(legs[2].entryPrice, 30492.50, 'dokoupený kontrakt');
  assert.equal(legs.every(l => l.side === 'short'), true);
});

// 2026-10-06, MNQ short: dva dokupy za sebou, každý jiným příkazem. Zaznamenáno
// 62,00 + 47,50 − 0,25 − 12,50 = 96,75; broker 136,50.
test('2026-10-06: dva dokupy za sebou', async () => {
  const h = harness();
  await play(h, [
    [fill('e1', 'o-entry', 'SellShort', 3, 31560.25, -3), 31560.25],
    [fill('t1', 'o-tp1', 'BuyToCover', 2, 31544.75, -1), 31560.25],
    [fill('e2', 'o-dokup1', 'SellShort', 1, 31545.75, -2), (31560.25 + 31545.75) / 2],
    [fill('e3', 'o-dokup2', 'SellShort', 1, 31533.50, -3), (31560.25 + 31545.75 + 31533.50) / 3],
    [fill('t2', 'o-tp2', 'BuyToCover', 1, 31522.75, -2), (31545.75 + 31533.50) / 2],
    [fill('x1', 'o-stop1', 'BuyToCover', 1, 31539.75, -1), 31533.50],
    [fill('x2', 'o-stop2', 'BuyToCover', 1, 31539.75, 0), null]
  ]);
  const legs = h.closed();
  near(sum(legs, 'grossPnl'), 136.5, 'hrubý výsledek (aplikace zaznamenala 96,75)');
  assert.deepEqual(legs.map(l => [l.entryPrice, l.exitPrice, l.grossPnl]), [
    [31560.25, 31544.75, 62], [31560.25, 31522.75, 75], [31545.75, 31539.75, 12], [31533.50, 31539.75, -12.5]
  ], 'vstupy se zavírají v pořadí, v jakém vznikly');
});

// ---- chování lotů ----

test('po dokupu a výstupu ukazuje otevřená pozice průměr zbytku', async () => {
  const h = harness();
  await h.exec(buy('e1', 'o1', 2, 100, 2));
  await h.exec(buy('e2', 'o2', 1, 110, 3));
  near(h.open()[0].avgPrice, (2 * 100 + 110) / 3);
  await h.exec(sell('x1', 'x1', 'Target1', 1, 120, 2));
  assert.equal(h.open()[0].avgPrice, 105, 'zbývá 1 @ 100 a 1 @ 110');
  near(h.open()[0].entryCommission, 2 * FEE);
  await h.exec(sell('x2', 'x2', 'Target2', 1, 120, 1));
  assert.equal(h.open()[0].avgPrice, 110, 'zbývá jen dokoupený kontrakt');
});

test('dílčí plnění jednoho vstupního příkazu je jeden vstup, ne dokup', async () => {
  const h = harness();
  await h.exec(buy('e1', 'o-entry', 2, 100, 2));
  await h.exec(buy('e2', 'o-entry', 2, 101, 4));
  await h.exec(sell('x', 'o-exit', 'Target1', 4, 110, 0));
  assert.equal(h.closed().length, 1, 'jedna noha');
  assert.equal(h.closed()[0].entryPrice, 100.5);
  assert.equal(h.closed()[0].quantity, 4);
  assert.equal(h.closed()[0].grossPnl, 9.5 * 4 * 2);
});

test('dokup na stejné ceně jako vstup zůstává jednou nohou', async () => {
  const h = harness();
  await h.exec(buy('e1', 'o1', 1, 100, 1));
  await h.exec(buy('e2', 'o2', 1, 100, 2));
  await h.exec(sell('x', 'x', 'Target1', 2, 104, 0));
  assert.equal(h.closed().length, 1);
  assert.equal(h.closed()[0].quantity, 2);
  near(h.closed()[0].commission, 4 * FEE);
});

test('otočka pozice po dokupu: zavřou se oba vstupy a zbytek otevře opačnou pozici', async () => {
  const h = harness();
  await h.exec(buy('e1', 'o1', 1, 100, 1));
  await h.exec(buy('e2', 'o2', 1, 110, 2));
  await h.exec(sell('x', 'x', 'Reverse', 3, 120, -1));
  assert.deepEqual(h.closed().map(l => [l.entryPrice, l.quantity, l.grossPnl]), [[100, 1, 40], [110, 1, 20]]);
  assert.equal(h.open().length, 1);
  assert.equal(h.open()[0].qty, -1);
  assert.equal(h.open()[0].avgPrice, 120);
  assert.notEqual(h.open()[0].positionId, h.closed()[0].positionId, 'nová pozice, nové ID');
  near(sum(h.closed(), 'commission') + h.open()[0].entryCommission, 5 * FEE, 'komise se neztratila ani nezdvojila');
});

// MFE / MAE se měří od vstupní ceny pozice – i u nohy dokoupených kontraktů.
// Sloučený obchod bere maximum přes nohy, takže měření od ceny dokupu by
// u něj ukázalo větší MAE, než jaké pozice od svého vstupu zažila.
test('MFE / MAE všech noh se měří od prvního vstupu', async () => {
  const h = harness();
  await h.exec(buy('e1', 'o1', 1, 100, 1));
  await h.exec(buy('e2', 'o2', 1, 110, 2));
  await h.exec({ ...sell('x', 'x', 'Target1', 2, 120, 0), excursionMaxPrice: 120, excursionMinPrice: 98 });
  assert.deepEqual(h.closed().map(l => [l.entryPrice, l.mfeTicks, l.maeTicks]), [[100, 80, 8], [110, 80, 8]]);
});

// ---- Náhradní větev: pozice, o jejíchž vstupech aplikace neví ----

// Aplikace běžela až od půlky pozice: zná jen průměr ze snímku (tady 1 @ 101
// a 2 @ 107, tedy 105). Po prvním výstupu NinjaTrader průměr zbytku posune na
// 107, ale počítat se dál musí od 105 – jinak by se zisk prvního výstupu
// (ve skutečnosti +9 b, ne +5 b) ztratil. Součet 15 b sedí na skutečnost.
test('pozice známá jen ze snímku: průměr ze snímku platí pro celou pozici', async () => {
  const h = harness();
  h.holding(3, 'Long', 105);
  h.clock.t += 60000;
  await h.exec(sell('x1', 'x1', 'Target1', 1, 110, 2));
  h.holding(2, 'Long', 107);
  await h.exec(sell('x2', 'x2', 'Target2', 2, 110, 0));
  assert.deepEqual(h.closed().map(l => [l.entryPrice, l.quantity, l.grossPnl]), [[105, 1, 10], [105, 2, 20]]);
  near(sum(h.closed(), 'grossPnl'), ((3 * 110) - (101 + 2 * 107)) * 2);
});

test('stav ze starší verze (pozice bez lotů): beze změny, dokup pak jede po lotech', async () => {
  const h = harness();
  h.state.positions[h.key] = { qty: 2, avgPrice: 100, currentPrice: 100, openedAt: '2026-10-13T15:00:00.000Z', pointValue: 2, rate: 1, entryCommission: 2 * FEE, maxQuantity: 2, side: 'long', entryImages: [], account: h.account, instrument: 'MNQ', instrumentFull: 'MNQ 12-26', strategy: 'Entry', positionId: 'old', fromSnapshot: false, executionsApplied: true };
  await h.exec(buy('e2', 'o2', 1, 109, 3));
  near(h.open()[0].avgPrice, 103);
  await h.exec(sell('x1', 'x1', 'Target1', 2, 110, 1));
  await h.exec(sell('x2', 'x2', 'Target2', 1, 110, 0));
  assert.deepEqual(h.closed().map(l => [l.entryPrice, l.quantity, l.grossPnl]), [[100, 2, 40], [109, 1, 2]]);
  assert.equal(h.closed()[0].entryTime, '2026-10-13T15:00:00.000Z');
  assert.equal(h.closed().every(l => l.positionId === 'old'), true);
});

test('loty, které nesedí na počet kontraktů ze snímku, se nepoužijí', async () => {
  const h = harness();
  await h.exec(buy('e1', 'o1', 1, 100, 1));
  await h.exec(buy('e2', 'o2', 1, 110, 2));
  h.holding(2, 'Long', 105);
  h.clock.t += h.main.SNAPSHOT_RACE_WINDOW_MS + 60000;
  h.holding(4, 'Long', 108);       // dvě přikoupení, jejichž exekuce nedorazily
  h.clock.t += h.main.SNAPSHOT_RACE_WINDOW_MS + 60000;
  await h.exec(sell('x', 'x', 'Target1', 4, 112, 0));
  assert.deepEqual(h.closed().map(l => [l.entryPrice, l.quantity, l.grossPnl]), [[108, 4, 32]]);
});

// ---- Vlastnost: součet přes nohy = peněžní tok ----
// Náhodné vstupy, dokupy, částečné výstupy i otočky; snímek po exekuci nese
// správný počet, ale NESMYSLNOU průměrnou cenu. Výsledek na ní nesmí záviset.
test('náhodné sekvence: Σ hrubý výsledek = Σ výstupů − Σ vstupů, Σ komise = Σ komisí exekucí', async () => {
  let seed = 20261013;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  let scaleIns = 0, reversals = 0, splits = 0;
  for (let run = 0; run < 200; run++) {
    const h = harness();
    let pos = 0, cash = 0, fees = 0, order = 0;
    const steps = int(3, 14);
    for (let i = 0; i <= steps; i++) {
      const last = i === steps;
      if (last && pos === 0) break;
      const delta = last ? -pos : (rnd() < 0.5 ? 1 : -1) * int(1, 3);
      const price = 30000 + int(0, 400) * 0.25;
      if (pos !== 0 && Math.sign(delta) === Math.sign(pos)) scaleIns++;
      if (pos !== 0 && Math.sign(delta) !== Math.sign(pos) && Math.abs(delta) > Math.abs(pos)) reversals++;
      const before = h.closed().length;
      const qty = Math.abs(delta);
      // Občas druhé plnění téhož příkazu.
      if (!(rnd() < 0.25 && order > 0)) order++;
      pos += delta;
      cash -= delta * price;
      fees += FEE * qty;
      await h.exec({ executionId: `r${run}-${i}`, orderId: `o${run}-${order}`, orderAction: delta > 0 ? 'Buy' : 'Sell', orderName: 'X', quantity: qty, price, positionAfter: pos, commission: FEE * qty });
      if (h.closed().length - before > 1) splits++;
      if (rnd() < 0.7) { if (pos) h.holding(Math.abs(pos), pos > 0 ? 'Long' : 'Short', 30000 + rnd() * 100); else h.flat(); }
      h.clock.t += int(1, 120) * 1000;
    }
    const legs = h.closed();
    near(sum(legs, 'grossPnl'), cash * 2, `běh ${run}: hrubý výsledek`);
    near(sum(legs, 'commission'), fees, `běh ${run}: komise`);
    near(sum(legs, 'pnl'), cash * 2 - fees, `běh ${run}: čistý výsledek`);
    assert.equal(h.open().length, 0, `běh ${run}: nic nezůstalo otevřené`);
  }
  assert.ok(scaleIns > 100 && reversals > 50 && splits > 50, `sekvence musí pokrýt dokupy (${scaleIns}), otočky (${reversals}) i dělené výstupy (${splits})`);
});
