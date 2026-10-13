'use strict';
// Odlehčená kopie deníku v ai-export/ (4.7.4).
//
// Kromě obchodů a denních poznámek nese i úpravu číselníků deníku
// (settings.taxonomy) – bez ní by nástroj, který export čte (Backtest Lab),
// neznal vlastní volby CUSTOM_… a hlásil je jako neznámé klíče.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadMain } = require('./helpers/extract');

function mirror() {
  const ai = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-ai-export-'));
  const errors = [];
  const api = loadMain(['safeJournalId', 'aiExportPath', 'stripImages', 'stripDayNote', 'aiExportModeOf', 'aiDerivedFields', 'writeAiExportMirror'], {
    fs, path,
    aiExportRoot: () => ai,
    logError: (where, error) => errors.push(where + ': ' + error.message)
  });
  const write = (id, data) => {
    api.writeAiExportMirror(id, data);
    return JSON.parse(fs.readFileSync(path.join(ai, id + '.json'), 'utf8'));
  };
  return { write, errors };
}

test('export nese taxonomii deníku, obrázky ne', () => {
  const m = mirror();
  const taxonomy = {
    ENTRY_LEVEL: { custom: { CUSTOM_LVN_DAY: 'LVN Day' }, hidden: ['VWAP_DEV'] },
    TARGET_LEVEL: { custom: { CUSTOM_FIX_RRR: 'Fix RRR' }, labels: { VAH: 'Horní hrana VA' } }
  };
  const out = m.write('j1', {
    trades: [{ id: 't1', images: ['a', 'b'], targetLevel1: { type: 'CUSTOM_FIX_RRR', price: '7700' } }],
    settings: [{ key: 'main', value: { taxonomy, theme: { mode: 'dark' } } }],
    dayNotes: { '2026-10-07': { notes: 'x', images: ['c'] } }
  });
  assert.deepEqual(out.taxonomy, taxonomy);
  assert.equal(out.theme, undefined, 'ostatní nastavení do exportu nepatří');
  assert.equal(out.trades[0].images, undefined);
  assert.equal(out.trades[0].imageCount, 2);
  assert.equal(out.dayNotes['2026-10-07'].imageCount, 1);
  assert.deepEqual(m.errors, []);
});

test('deník bez nastavení → prázdná taxonomie', () => {
  const m = mirror();
  assert.deepEqual(m.write('j2', { trades: [] }).taxonomy, {});
  assert.deepEqual(m.write('j3', { trades: [], settings: [{ key: 'main', value: {} }] }).taxonomy, {});
  assert.deepEqual(m.errors, []);
});

// Kontext v2 (ZADANI_KONTEXT A6): AI export nese ke každému obchodu dopočty
// (A3) v samostatném objektu `derived` – uložené hodnoty obchodu zůstávají,
// jak jsou. Režim deníku (gradeRetro) se bere z manifestu index.json.
function mirrorWithManifest(manifest) {
  const ai = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-ai-export-'));
  if (manifest) fs.writeFileSync(path.join(ai, 'index.json'), JSON.stringify(manifest));
  const errors = [];
  const api = loadMain(['safeJournalId', 'aiExportPath', 'stripImages', 'stripDayNote', 'aiExportModeOf', 'aiDerivedFields', 'writeAiExportMirror'], {
    fs, path, aiExportRoot: () => ai, logError: (where, error) => errors.push(where + ': ' + error.message)
  });
  return { errors, write: (id, data) => { api.writeAiExportMirror(id, data); return JSON.parse(fs.readFileSync(path.join(ai, id + '.json'), 'utf8')); } };
}

const CTX_TRADE = {
  id: 't1', instrument: 'MES', date: '2026-10-09', entryTime: '15:31', exitTime: '15:40', side: 'long', entryPrice: 7800, exitPrice: 7804,
  result: 'target', pnlRaw: 18.1, slPrice: 7798, targetLevel1: { type: 'CUSTOM_FIX_RRR', price: 7804 },
  nearLevels: [{ level: 'VWAP', price: 7801, testState: 'UNTESTED' }, { level: 'VAL', price: 7799 }],
  grade: 'A', gradeSetAt: '2026-10-09T14:00:00.000Z', trendHtf: 'UP'
};

test('A6: AI export nese dopočty v `derived`, ruční pole i kontext dne beze změny', () => {
  const m = mirrorWithManifest({ journals: [{ id: 'j1', name: 'A', mode: 'LIVE' }] });
  const out = m.write('j1', {
    trades: [CTX_TRADE],
    settings: [{ key: 'main', value: { taxonomy: { TARGET_LEVEL: { custom: { CUSTOM_FIX_RRR: 'Fix RRR' } } }, templates: [] } }],
    dayNotes: { '2026-10-09': { comment: '', images: [], dayContext: { openVsValue: 'GAP_UP' } } }
  });
  const t = out.trades[0];
  assert.equal(t.trendHtf, 'UP');
  assert.deepEqual(t.nearLevels, CTX_TRADE.nearLevels, 'uložené řádky beze změny (typ, cena, testState)');
  assert.equal(t.derived.nearestAheadTicks, 4);
  assert.equal(t.derived.stopBehindTicks, 4);
  assert.equal(t.derived.targetOnLevel, false, 'Fix RRR není hladina (výchozí nastavení slovníku)');
  assert.equal(t.derived.tradeNoInDay, 1);
  assert.equal(t.derived.session, 'US_OPEN');
  assert.equal(t.derived.gradeRetro, false, 'živý deník: známka zadaná 20 minut po výstupu je ve výchozí lhůtě 30 minut');
  assert.deepEqual(t.derived.nearLevels, [
    { fromEntry: 4, fromStop: 12, toTarget: 12, position: 'ENTRY_TO_TARGET' },
    { fromEntry: -4, fromStop: 4, toTarget: 20, position: 'STOP_TO_ENTRY' }
  ], 'geometrie řádků ve stejném pořadí jako nearLevels');
  assert.deepEqual(out.dayNotes['2026-10-09'].dayContext, { openVsValue: 'GAP_UP' });
  assert.deepEqual(m.errors, []);
});

test('A6: AI export – backtest deník z manifestu: gradeRetro nejde ověřit (null)', () => {
  const m = mirrorWithManifest({ journals: [{ id: 'j1', name: 'B', mode: 'BACKTEST' }] });
  assert.equal(m.write('j1', { trades: [CTX_TRADE] }).trades[0].derived.gradeRetro, null);
  // Bez manifestu je deník živý (výchozí režim). Lhůta „doplněno zpětně" se
  // bere z nastavení deníku – export počítá stejně jako aplikace.
  const noManifest = mirrorWithManifest(null);
  const withGrace = minutes => noManifest.write('j1', { trades: [CTX_TRADE], settings: [{ key: 'main', value: { gradeRetroGraceMinutes: minutes } }] }).trades[0].derived.gradeRetro;
  assert.equal(noManifest.write('j1', { trades: [CTX_TRADE] }).trades[0].derived.gradeRetro, false, 'výchozí lhůta 30 minut');
  assert.equal(withGrace(10), true, 'lhůta 10 minut z nastavení deníku: 20 minut po výstupu je zpětně');
  assert.equal(withGrace(60), false);
  assert.deepEqual(m.errors, []);
});

// Deník, který od aktualizace ještě nebyl otevřen, má na disku číselníky se
// dvěma kolonkami SR. Export nese obchody v novém tvaru – číselníky musí také.
test('kontext v3: číselníky neotevřeného deníku jdou do exportu v novém tvaru', () => {
  const m = mirror();
  const out = m.write('j4', {
    trades: [{ id: 't1', srTarget: [{ level: 'VAH', price: 7700, ticksFromEntry: 4 }], srStopLoss: [] }],
    settings: [{ key: 'main', value: { taxonomy: { ENTRY_LEVEL: { custom: { CUSTOM_X: 'X' } }, SR_TARGET: { hidden: ['VWAP'] }, SR_SL: { hidden: ['VWAP', 'VAH'] } } } }]
  });
  assert.deepEqual(out.taxonomy, { ENTRY_LEVEL: { custom: { CUSTOM_X: 'X' } }, NEAR_LEVEL: { hidden: ['VWAP'] } });
  assert.deepEqual(out.trades[0].nearLevels, [{ level: 'VAH', price: 7700 }]);
  assert.deepEqual(m.errors, []);
});

// Dokup: vstupy pozice jdou do `derived.entries`, dopočítané z nohou. Obchod
// s jedním vstupem pole nemá.
test('AI export: obchod s dokupem nese vstupy v derived.entries', () => {
  const m = mirror();
  const base = { instrument: 'MNQ', side: 'long', date: '2026-10-13', entryTime: '18:09', entryPrice: 30738.75, exitTime: '18:30', exitPrice: 30786.5, contracts: 2 };
  const out = m.write('j1', { trades: [
    { ...base, id: 'a', legs: [
      { label: 'TP1', contracts: 1, exitPrice: 30786.5, points: 47.75, entryPrice: 30738.75, entryTime: '18:09' },
      { label: 'TP1', contracts: 1, exitPrice: 30786.5, points: 27, entryPrice: 30759.5, entryTime: '18:18' }
    ] },
    { ...base, id: 'b' }
  ] });
  assert.deepEqual(out.trades[0].derived.entries, [{ time: '18:09', price: 30738.75, contracts: 1 }, { time: '18:18', price: 30759.5, contracts: 1 }]);
  assert.equal(out.trades[0].legs[1].entryPrice, 30759.5, 'noha nese vlastní vstup');
  assert.equal('entries' in out.trades[1].derived, false);
  assert.deepEqual(m.errors, []);
});
