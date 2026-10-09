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
  srTarget: [{ level: 'VWAP', price: 7801, ticksFromEntry: 4, testState: 'UNTESTED' }], srStopLoss: [{ level: 'VAL', price: 7799, ticksFromEntry: 4 }],
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
  assert.deepEqual(t.srTarget, CTX_TRADE.srTarget, 'uložené řádky beze změny (kladné ticky, testState)');
  assert.equal(t.derived.pathState, 'BLOCKED');
  assert.equal(t.derived.firstObstacleTicks, 4);
  assert.equal(t.derived.targetOnLevel, false, 'Fix RRR není hladina (výchozí nastavení slovníku)');
  assert.equal(t.derived.tradeNoInDay, 1);
  assert.equal(t.derived.session, 'US_OPEN');
  assert.equal(t.derived.gradeRetro, true, 'živý deník: známka zadaná po výstupu');
  assert.deepEqual(t.derived.srTarget, [{ ticksFromEntrySigned: 4, ticksFromStop: null, beyondStop: null, beyondTarget: false, behindEntry: false }]);
  assert.equal(t.derived.srStopLoss[0].ticksFromEntrySigned, -4);
  assert.deepEqual(out.dayNotes['2026-10-09'].dayContext, { openVsValue: 'GAP_UP' });
  assert.deepEqual(m.errors, []);
});

test('A6: AI export – backtest deník z manifestu: gradeRetro nejde ověřit (null)', () => {
  const m = mirrorWithManifest({ journals: [{ id: 'j1', name: 'B', mode: 'BACKTEST' }] });
  assert.equal(m.write('j1', { trades: [CTX_TRADE] }).trades[0].derived.gradeRetro, null);
  const noManifest = mirrorWithManifest(null);
  assert.equal(noManifest.write('j1', { trades: [CTX_TRADE] }).trades[0].derived.gradeRetro, true, 'bez manifestu živý (výchozí režim)');
  assert.deepEqual(m.errors, []);
});
