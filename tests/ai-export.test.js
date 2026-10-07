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
  const api = loadMain(['safeJournalId', 'aiExportPath', 'stripImages', 'stripDayNote', 'writeAiExportMirror'], {
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
