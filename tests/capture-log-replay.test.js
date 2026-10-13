'use strict';
// Přehrání skutečného záznamu exekucí (trade-capture/events.json) přes
// processExecution: u každé pozice musí součet hrubých výsledků nohou sedět na
// peněžní tok jejích exekucí, tedy na to, co ukáže broker.
//
// Záznam leží MIMO repozitář (reálné obchody, repozitář je veřejný) – bere se
// záznam živé aplikace a Troubleshooting/events.json, nebo soubory z proměnné
// FJ_EVENTS (viz tests/helpers/paths.js). Bez záznamu se test hlasitě přeskočí.
//
// Co se počítá: pozice od plochého stavu do plochého, jejíž exekuce se sečtou
// na nulu. Neúplné pozice (aplikace neběžela, exekuce v záznamu chybí) se
// přeskakují a vypíší se počtem. Snímky pozic v záznamu nejsou, takže se
// nepřehrávají – výsledek na nich nezávisí (tests/capture-scale-in.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { captureHarness } = require('./helpers/capture-harness');
const { captureLogSources, DEV_ROOT } = require('./helpers/paths');

const signedQty = e => (/buy/i.test(String(e.orderAction)) ? 1 : -1) * Math.abs(Number(e.quantity) || 0);

async function replay(file) {
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const executions = all.filter(e => e.type === 'execution' && e.source === 'ninjatrader');
  // Hrubý výsledek nohy je v měně účtu (× kurz výstupní exekuce); porovnává se
  // v měně instrumentu, ať do toho nevstupuje kurz.
  const rateOf = new Map(executions.map(e => [String(e.executionId), Number(e.rate) || 1]));
  const h = captureHarness();
  const open = {};
  const positions = [];
  for (const e of executions) {
    const key = `${e.account}|${e.instrumentFull}`;
    const delta = signedQty(e);
    let p = open[key];
    if (!p) {
      p = open[key] = { key, start: e.time, cash: 0, qty: 0, from: h.events.length, fromFlat: Number(e.positionAfter) === delta };
      // Začátek z plochého stavu: zbytek po neúplné pozici by v aplikaci
      // odklidil snímek pozic, který v záznamu není.
      if (p.fromFlat) delete h.state.positions[key];
    }
    p.cash -= delta * Number(e.price) * (Number(e.pointValue) || 1);
    p.qty += delta;
    await h.exec(e);
    if (Number(e.positionAfter) === 0) { p.to = h.events.length; positions.push(p); delete open[key]; }
  }
  const complete = positions.filter(p => p.fromFlat && p.qty === 0);
  const mismatches = [];
  for (const p of complete) {
    const [account, instrumentFull] = p.key.split('|');
    const legs = h.events.slice(p.from, p.to).filter(t => t.type === 'trade_closed' && t.account === account && t.instrumentFull === instrumentFull);
    const gross = legs.reduce((a, t) => a + t.grossPnl / (rateOf.get(String(t.sourceExecutionId)) || 1), 0);
    if (Math.abs(gross - p.cash) > 0.005) mismatches.push(`${p.start} ${instrumentFull}: nohy ${gross.toFixed(2)}, exekuce ${p.cash.toFixed(2)}`);
  }
  return { executions: executions.length, complete: complete.length, incomplete: positions.length - complete.length + Object.keys(open).length, mismatches };
}

test('skutečný záznam exekucí: každá pozice sedí na peněžní tok', async t => {
  const sources = captureLogSources();
  if (!sources.length) {
    t.skip(`žádný záznam exekucí – hledáno v datové složce aplikace (trade-capture/events.json) a v ${DEV_ROOT}\\Troubleshooting\\events.json; jinou cestu dá FJ_EVENTS`);
    return;
  }
  for (const file of sources) {
    const r = await replay(file);
    t.diagnostic(`${file}: ${r.executions} exekucí, ${r.complete} úplných pozic, ${r.incomplete} neúplných`);
    assert.ok(r.complete > 0, `${file}: v záznamu není žádná úplná pozice`);
    assert.deepEqual(r.mismatches, [], `${file}: pozice, které nesedí na peněžní tok`);
  }
});
