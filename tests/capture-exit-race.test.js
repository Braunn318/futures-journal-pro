'use strict';
// Snímek pozic z NinjaTraderu, který předběhne exekuci.
//
// Konektor posílá exekuci a snímek pozic jako dvě nezávislé zprávy. Při
// výstupu občas dorazí plochý snímek DŘÍV než výstupní exekuce. Snímek pozici
// smazal, výstup neměl co uzavřít, zapsal se jako otevření opačné pozice
// a obchod se do deníku nedostal (2026-09-22 a 2026-10-12). Zrcadlo chyby
// se vstupem ze 4.5.1.
//
// Sekvence jsou opsané ze skutečného záznamu trade-capture/events.json.

const test = require('node:test');
const assert = require('node:assert/strict');

const { captureHarness: harness } = require('./helpers/capture-harness');

// Skutečné exekuce z 2026-10-12 (obchod, který se neimportoval).
const ENTRY = { executionId: '688138080560_1', time: '2026-10-12T14:28:20.2840000Z', orderAction: 'Sell', orderName: 'Entry', quantity: 2, price: 7854.25, positionAfter: -2, marketPosition: 'Short', commission: 1.02 };
const EXIT = { executionId: '688138080581_1', time: '2026-10-12T14:35:46.7800000Z', orderAction: 'BuyToCover', orderName: 'Stop1', quantity: 2, price: 7856.75, positionAfter: 0, marketPosition: 'Long', commission: 1.02, excursionMaxPrice: 7856.75, excursionMinPrice: 7853.25 };

function assertTheTrade(h) {
  assert.equal(h.closed().length, 1, 'přesně jeden uzavřený obchod');
  const t = h.closed()[0];
  assert.equal(t.side, 'short');
  assert.equal(t.quantity, 2);
  assert.equal(t.entryPrice, 7854.25);
  assert.equal(t.exitPrice, 7856.75);
  assert.equal(t.entryTime, ENTRY.time);
  assert.equal(t.exitTime, EXIT.time);
  assert.equal(t.grossPnl, -25);
  assert.equal(t.commission, 2.04, 'vstupní i výstupní komise');
  assert.equal(t.pnl, -27.04);
  assert.equal(t.strategy, 'Entry', 'název vstupního příkazu, ne Stop1');
  assert.equal(t.positionId, h.opened()[0].positionId, 'ID pozice ze vstupu – na něm stojí slučování cílů');
  assert.deepEqual(Array.from(t.screenshotPaths), ['entry.png', 'exit.png']);
  assert.equal(t.mfeTicks, 4);
  assert.equal(t.maeTicks, 10);
  assert.equal(h.opened().length, 1, 'žádná falešná opačná pozice');
  assert.equal(h.open().length, 0, 'nic nezůstalo otevřené');
}

test('2026-10-12: plochý snímek dorazí před výstupní exekucí – obchod se přesto uzavře', async () => {
  const h = harness();
  await h.exec(ENTRY);
  h.holding(2, 'Short', 7854.25);
  h.clock.t += 7 * 60 * 1000 + 26000;
  h.flat();                       // snímek předběhl exekuci
  assert.equal(h.open().length, 0, 'odložená pozice se neukazuje jako otevřená');
  h.clock.t += 120;
  await h.exec(EXIT);
  h.flat();                       // snímek, který konektor posílá po exekuci
  assertTheTrade(h);
  assert.equal(Object.keys(h.state.positions).length, 0);
  assert.equal(h.info.length, 1, 'stopa v protokolu');
  assert.match(h.info[0], /vzata zpět/);
});

test('stejný obchod ve správném pořadí (exekuce první) dává totéž', async () => {
  const h = harness();
  await h.exec(ENTRY);
  h.holding(2, 'Short', 7854.25);
  await h.exec(EXIT);
  h.flat();
  assertTheTrade(h);
  assert.equal(h.info.length, 0, 'běžný průběh se do protokolu nepíše');
});

// 2026-09-22: totéž u long pozice.
test('2026-09-22: long pozice, plochý snímek před výstupem', async () => {
  const h = harness();
  await h.exec({ executionId: 'a', time: '2026-09-22T15:28:23.3270000Z', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7831.75, positionAfter: 2, commission: 1.02 });
  h.flat();
  await h.exec({ executionId: 'b', time: '2026-09-22T15:28:57.8570000Z', orderAction: 'Sell', orderName: 'Stop1', quantity: 2, price: 7829.5, positionAfter: 0, commission: 1.02 });
  h.flat();
  assert.equal(h.closed().length, 1);
  assert.equal(h.closed()[0].side, 'long');
  assert.equal(h.closed()[0].grossPnl, -22.5);
  assert.equal(h.opened().length, 1);
});

test('dva cíle: snímek s nižším počtem předběhne TP1 – oba cíle se uzavřou pod jedním ID', async () => {
  const h = harness();
  await h.exec({ executionId: 'e', time: '2026-10-12T15:00:00.000Z', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7800, positionAfter: 2, commission: 1.02 });
  h.holding(2, 'Long', 7800);
  h.clock.t += 60000;
  h.holding(1, 'Long', 7800);     // snímek po TP1 dorazil dřív než exekuce TP1
  await h.exec({ executionId: 't1', time: '2026-10-12T15:01:00.000Z', orderAction: 'Sell', orderName: 'Target1', quantity: 1, price: 7804, positionAfter: 1, commission: 0.51 });
  assert.equal(h.open().length, 1, 'po TP1 zůstává 1 kontrakt');
  assert.equal(h.open()[0].qty, 1);
  assert.equal(h.open()[0].qtySnapshotAt, undefined, 'stopa po snímku platí jen pro první exekuci po něm');
  h.holding(1, 'Long', 7800);
  h.clock.t += 60000;
  await h.exec({ executionId: 't2', time: '2026-10-12T15:02:00.000Z', orderAction: 'Sell', orderName: 'Target2', quantity: 1, price: 7808, positionAfter: 0, commission: 0.51 });
  h.flat();
  const legs = h.closed();
  assert.equal(legs.length, 2, 'TP1 i TP2');
  assert.deepEqual(legs.map(l => l.quantity), [1, 1]);
  assert.deepEqual(legs.map(l => l.grossPnl), [20, 40]);
  assert.equal(legs[0].positionId, legs[1].positionId);
  assert.deepEqual(legs.map(l => l.commission), [1.02, 1.02], 'vstupní komise rozdělená mezi cíle');
  assert.equal(h.opened().length, 1);
  assert.equal(h.open().length, 0);
});

test('tři kontrakty, dva cíle naráz: snímek ukáže rovnou 1 a předběhne obě exekuce', async () => {
  const h = harness();
  await h.exec({ executionId: 'e', orderAction: 'Buy', orderName: 'Entry', quantity: 3, price: 7800, positionAfter: 3, commission: 1.53 });
  h.holding(3, 'Long', 7800);
  h.holding(1, 'Long', 7800);
  await h.exec({ executionId: 't1', orderAction: 'Sell', orderName: 'Target1', quantity: 1, price: 7804, positionAfter: 2, commission: 0.51 });
  await h.exec({ executionId: 't2', orderAction: 'Sell', orderName: 'Target2', quantity: 1, price: 7806, positionAfter: 1, commission: 0.51 });
  assert.deepEqual(h.closed().map(l => l.grossPnl), [20, 30]);
  assert.equal(h.open().length, 1);
  assert.equal(h.open()[0].qty, 1, 'zbývá třetí kontrakt');
  assert.equal(h.opened().length, 1);
});

// Změna počtu ve snímku je stopa jen krátce – starý snímek nesmí přepsat
// stav, který mezitím určily exekuce.
test('snímek, který změnil počet dávno, už počet nevrací', async () => {
  const h = harness();
  await h.exec({ executionId: 'e', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7800, positionAfter: 2, commission: 1.02 });
  h.holding(1, 'Long', 7800);
  h.clock.t += h.main.SNAPSHOT_RACE_WINDOW_MS + 1000;
  await h.exec({ executionId: 't', orderAction: 'Sell', orderName: 'Target1', quantity: 1, price: 7804, positionAfter: 1, commission: 0.51 });
  assert.equal(h.closed().length, 1);
  assert.equal(Object.keys(h.state.positions).length, 0, 'jako dřív: snímek platil, exekuce pozici dovřela');
  assert.equal(h.info.length, 0);
});

// Počet se vrací jen ve stejném směru. Údaj, podle kterého by long pozice byla
// před exekucí short (nebo plochá), k téhle pozici nepatří.
test('po snímku se počet nevrací do opačného směru ani na nulu', async () => {
  for (const positionAfter of [0, 1]) {
    const h = harness();
    await h.exec({ executionId: 'e', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7800, positionAfter: 2, commission: 1.02 });
    h.holding(1, 'Long', 7800);
    await h.exec({ executionId: 'x', orderAction: 'Buy', orderName: 'Entry', quantity: 1, price: 7802, positionAfter, commission: 0.51 });
    assert.equal(h.closed().length, 0, `positionAfter ${positionAfter}`);
    assert.equal(h.open()[0].qty, 2, 'běžné přikoupení k tomu, co je ve stavu');
    assert.equal(h.info.length, 0);
  }
});

test('dva cíle ve správném pořadí: beze změny', async () => {
  const h = harness();
  await h.exec({ executionId: 'e', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7800, positionAfter: 2, commission: 1.02 });
  await h.exec({ executionId: 't1', orderAction: 'Sell', orderName: 'Target1', quantity: 1, price: 7804, positionAfter: 1, commission: 0.51 });
  h.holding(1, 'Long', 7800);
  await h.exec({ executionId: 't2', orderAction: 'Sell', orderName: 'Target2', quantity: 1, price: 7808, positionAfter: 0, commission: 0.51 });
  h.flat();
  assert.deepEqual(h.closed().map(l => l.grossPnl), [20, 40]);
  assert.equal(h.open().length, 0);
  assert.equal(h.info.length, 0);
});

// Dvě výstupní exekuce můžou dorazit i v opačném pořadí mezi sebou. Žádný
// snímek mezi nimi nebyl, takže se počet kontraktů nesmí „vracet".
test('dva cíle doručené v opačném pořadí bez snímku: nic se neopravuje, nic nezůstane viset', async () => {
  const h = harness();
  await h.exec({ executionId: 'e', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7800, positionAfter: 2, commission: 1.02 });
  await h.exec({ executionId: 't2', orderAction: 'Sell', orderName: 'Target2', quantity: 1, price: 7808, positionAfter: 0, commission: 0.51 });
  await h.exec({ executionId: 't1', orderAction: 'Sell', orderName: 'Target1', quantity: 1, price: 7804, positionAfter: 1, commission: 0.51 });
  assert.equal(h.closed().length, 2);
  assert.equal(Object.keys(h.state.positions).length, 0);
  assert.equal(h.info.length, 0);
});

test('přikoupení, které snímek předběhl, se nezapočítá dvakrát', async () => {
  const h = harness();
  await h.exec({ executionId: 'e1', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7800, positionAfter: 2, commission: 1.02 });
  h.holding(2, 'Long', 7800);
  h.holding(4, 'Long', 7801);     // snímek po přikoupení dorazil dřív
  await h.exec({ executionId: 'e2', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7802, positionAfter: 4, commission: 1.02 });
  assert.equal(h.open()[0].qty, 4, 'ne 6');
  assert.equal(h.open()[0].entryCommission, 2.04);
});

test('nový vstup po odložené pozici otevře novou pozici a starou zahodí', async () => {
  const h = harness();
  await h.exec(ENTRY);
  h.flat();                       // výstupní exekuce nikdy nedorazila
  h.clock.t += 30000;
  await h.exec({ executionId: 'n', orderAction: 'Sell', orderName: 'Entry', quantity: 2, price: 7850, positionAfter: -2, commission: 1.02 });
  assert.equal(h.closed().length, 0);
  assert.equal(h.opened().length, 2);
  assert.equal(h.open().length, 1);
  assert.equal(h.open()[0].avgPrice, 7850, 'vstupní cena nové pozice, ne staré');
  assert.notEqual(h.open()[0].positionId, h.opened()[0].positionId);
  assert.equal(h.open()[0].missingSince, undefined);
});

test('odložená pozice: hned není vidět, po uplynutí lhůty zmizí úplně', async () => {
  const h = harness();
  await h.exec(ENTRY);
  h.flat();
  assert.equal(h.open().length, 0);
  assert.equal(Object.keys(h.state.positions).length, 1, 'čeká na svou exekuci');
  h.clock.t += h.main.POSITION_MISSING_GRACE_MS - 1000;
  h.flat();
  assert.equal(Object.keys(h.state.positions).length, 1);
  h.clock.t += 2000;
  h.flat();
  assert.equal(Object.keys(h.state.positions).length, 0);
});

test('exekuce, která přijde až po lhůtě, si odloženou pozici už nevezme', async () => {
  const h = harness();
  await h.exec(ENTRY);
  h.flat();
  h.clock.t += h.main.POSITION_MISSING_GRACE_MS + 1000;
  await h.exec(EXIT);
  assert.equal(h.closed().length, 0);
  assert.equal(h.opened().length, 1, 'ani falešná opačná pozice');
  assert.equal(Object.keys(h.state.positions).length, 0);
  assert.match(h.info.at(-1), /bez známé otevřené pozice/);
});

test('pozice, která se ve snímku vrátí (výpadek NinjaTraderu), pokračuje beze změny', async () => {
  const h = harness();
  await h.exec(ENTRY);
  h.flat();
  h.clock.t += 5000;
  h.holding(2, 'Short', 7854.25);
  assert.equal(h.open().length, 1);
  assert.equal(h.open()[0].missingSince, undefined);
  assert.equal(h.open()[0].entryCommission, 1.02, 'údaje ze vstupu zůstaly');
  await h.exec(EXIT);
  assertTheTrade(h);
});

test('odložená pozice, na jejímž místě snímek ukáže jinou, se nahradí', async () => {
  const h = harness();
  await h.exec(ENTRY);
  h.flat();
  h.holding(1, 'Long', 7860);
  assert.equal(h.open().length, 1);
  assert.equal(h.open()[0].qty, 1);
  assert.equal(h.open()[0].fromSnapshot, true, 'nová pozice ze snímku, ne stará short');
  assert.equal(h.open()[0].entryCommission, 0);
});

test('výstup, ke kterému aplikace žádnou pozici nezná, neotevře opačnou pozici', async () => {
  const h = harness();
  await h.exec(EXIT);
  assert.equal(h.events.length, 0);
  assert.equal(Object.keys(h.state.positions).length, 0);
  assert.equal(h.info.length, 1);
  assert.match(h.info[0], /BuyToCover 2 @ 7856\.75/);
});

test('snímek jiného účtu cizí pozici neodloží', async () => {
  const h = harness();
  await h.exec(ENTRY);
  h.main.processPositionSnapshot({ type: 'position_snapshot', account: 'Sim101', positions: [] });
  assert.equal(h.open().length, 1);
  assert.equal(h.open()[0].missingSince, undefined);
});

// Testovací sekvence v aplikaci a starší zdroje positionAfter neposílají.
test('bez positionAfter se chová jako dřív', async () => {
  const strip = ({ positionAfter, ...rest }) => rest;
  const normal = harness();
  await normal.exec(strip(ENTRY));
  await normal.exec(strip(EXIT));
  assert.equal(normal.closed().length, 1);
  assert.equal(normal.closed()[0].pnl, -27.04);

  const raced = harness();
  await raced.exec(strip(ENTRY));
  raced.flat();
  await raced.exec(strip(EXIT));
  assert.equal(raced.closed().length, 0, 'bez údaje z NinjaTraderu se nic nehádá');
  assert.equal(raced.opened().length, 2);
});

// Dva cíle naráz: NinjaTrader pošle snímek po každé změně pozice, takže před
// oběma exekucemi může dorazit snímek s 1 kontraktem I plochý snímek. Odložená
// pozice pak má počet, který nesedí s tím, co hlásí exekuce – přesto je to ona.
test('dva cíle naráz: snímek s 1 kontraktem i plochý snímek předběhnou obě exekuce', async () => {
  const h = harness();
  await h.exec({ executionId: 'e', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7800, positionAfter: 2, commission: 1.02 });
  h.holding(2, 'Long', 7800);
  h.clock.t += 60000;
  h.holding(1, 'Long', 7800);
  h.flat();
  assert.equal(h.open().length, 0, 'odložená pozice se neukazuje jako otevřená');
  await h.exec({ executionId: 't1', orderAction: 'Sell', orderName: 'Target1', quantity: 1, price: 7804, positionAfter: 1, commission: 0.51 });
  await h.exec({ executionId: 't2', orderAction: 'Sell', orderName: 'Target2', quantity: 1, price: 7808, positionAfter: 0, commission: 0.51 });
  h.flat();
  const legs = h.closed();
  assert.equal(legs.length, 2, 'TP1 i TP2');
  assert.deepEqual(legs.map(l => l.grossPnl), [20, 40]);
  assert.equal(legs[0].positionId, legs[1].positionId);
  assert.equal(h.opened().length, 1, 'žádná falešná opačná pozice');
  assert.equal(Object.keys(h.state.positions).length, 0);
});

test('odložená pozice s jiným počtem a bez čerstvé stopy po snímku se exekuci nepřizná', async () => {
  const h = harness();
  await h.exec({ executionId: 'e', orderAction: 'Buy', orderName: 'Entry', quantity: 2, price: 7800, positionAfter: 2, commission: 1.02 });
  h.holding(1, 'Long', 7800);
  h.clock.t += h.main.SNAPSHOT_RACE_WINDOW_MS + 1000;
  h.flat();
  await h.exec({ executionId: 't1', orderAction: 'Sell', orderName: 'Target1', quantity: 2, price: 7804, positionAfter: 0, commission: 1.02 });
  assert.equal(h.closed().length, 0, 'počet změnil snímek dávno – nejde o tutéž změnu');
  assert.equal(h.opened().length, 1);
});

// Snímek po přikoupení nese průměrnou cenu VČETNĚ přikoupení. Když předběhne
// exekuci, nesmí se do průměru započítat podruhé.
test('přikoupení, které snímek předběhl: průměrná vstupní cena se nepočítá dvakrát', async () => {
  const h = harness();
  await h.exec({ executionId: 'e1', orderAction: 'Buy', orderName: 'Entry', quantity: 1, price: 7800, positionAfter: 1, commission: 0.51 });
  h.holding(1, 'Long', 7800);
  h.holding(2, 'Long', 7805);     // snímek po přikoupení dorazil dřív
  await h.exec({ executionId: 'e2', orderAction: 'Buy', orderName: 'Entry', quantity: 1, price: 7810, positionAfter: 2, commission: 0.51 });
  assert.equal(h.open()[0].qty, 2);
  assert.equal(h.open()[0].avgPrice, 7805, 'ne 7807,5');
  assert.equal(h.open()[0].avgPriceBeforeSnapshot, undefined, 'stopa po snímku platí jen pro první exekuci po něm');
  await h.exec({ executionId: 'x', orderAction: 'Sell', orderName: 'Target1', quantity: 2, price: 7810, positionAfter: 0, commission: 1.02 });
  // Výstup zavírá kontrakty ze dvou vstupů, proto dvě nohy (FIFO); dřív jedna
  // noha od průměru 7805. Součet je stejný.
  assert.deepEqual(h.closed().map(l => l.entryPrice), [7800, 7810]);
  assert.deepEqual(h.closed().map(l => l.grossPnl), [50, 0]);
});
