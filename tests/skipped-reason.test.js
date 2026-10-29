'use strict';
// Důvod vynechání (4.8.95): u stavu „vědomě vynechán“ výběr z číselníku
// SKIP_REASON (sdílený s „naživo bych nevzal“) + text – u setupu bez vstupu
// i u celého obchodu. U jiného stavu se nedrží.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');

const plain = value => JSON.parse(JSON.stringify(value));

test('applySkippedReason: jen u SKIPPED, jinak se pole odeberou', () => {
  const r = loadRenderer(['applySkippedReason']);
  assert.deepEqual(plain(r.applySkippedReason({}, 'SKIPPED', 'CONTEXT', '  zprávy  ')), { skippedReason: 'CONTEXT', skippedReasonNote: 'zprávy' });
  assert.deepEqual(plain(r.applySkippedReason({}, 'SKIPPED', 'NEEXISTUJE', '')), {}, 'neznámý klíč se zahodí');
  assert.deepEqual(plain(r.applySkippedReason({ skippedReason: 'CONTEXT', skippedReasonNote: 'x' }, 'NO_FILL', 'CONTEXT', 'x')), {});
  assert.deepEqual(plain(r.applySkippedReason({ skippedReason: 'CONTEXT', skippedReasonNote: 'x' }, 'FILLED', '', '')), {});
  assert.deepEqual(plain(r.applySkippedReason({ skippedReasonNote: 'drží' }, 'SKIPPED', 'OTHER')), { skippedReasonNote: 'drží', skippedReason: 'OTHER' },
    'bez textu (záznam setupu) se text nemění');
});

test('tradeDraftFromSetup: vynechaný setup předá důvod do pole, ne do komentáře', () => {
  const r = loadRenderer(['applySkippedReason', 'tradeDraftFromSetup']);
  const setup = { id: 's1', recordType: 'SETUP_ONLY', date: '2026-10-20', fillStatus: 'SKIPPED', skippedReason: 'TOO_LATE', reason: 'cena odjela', note: 'TOp' };
  const d = plain(r.tradeDraftFromSetup(setup));
  assert.equal(d.skippedReason, 'TOO_LATE');
  assert.equal(d.skippedReasonNote, 'cena odjela');
  assert.equal(d.comment, 'TOp');
  const nf = plain(r.tradeDraftFromSetup({ ...setup, fillStatus: 'NO_FILL' }));
  assert.equal(nf.skippedReason, undefined);
  assert.equal(nf.skippedReasonNote, undefined);
  assert.equal(nf.comment, 'cena odjela — TOp', 'nenaplněný setup jako dřív');
});

test('skippedReasonText: popisek z číselníku + text, jen u SKIPPED', () => {
  const r = loadRenderer(['skippedReasonText']);
  assert.equal(r.skippedReasonText({ fillStatus: 'SKIPPED', skippedReason: 'SR_IN_WAY', skippedReasonNote: 'VAH' }), 'SR zóna / hladina v cestě — VAH');
  assert.equal(r.skippedReasonText({ fillStatus: 'SKIPPED', skippedReasonNote: 'jen text' }), 'jen text');
  assert.equal(r.skippedReasonText({ fillStatus: 'NO_FILL', skippedReason: 'SR_IN_WAY' }), '');
});

test('computeGroupStats: vědomě vynechané mají rozpad podle setupu i podle důvodu', () => {
  const r = loadRenderer(['isSetupRecord', 'tradeRecords', 'signed', 'INCLUDE_SKIP_LIVE_KEY', 'isSkipLive',
    'readIncludeSkipLive', 'includeSkipLive', 'INCLUDE_NO_FILL_KEY', 'INCLUDE_SKIPPED_KEY', 'hypotheticalGroup',
    'readIncludeFlag', 'includeNoFill', 'includeSkipped', 'currentInclude', 'performanceRecords', 'computeOverallStats',
    'PERFORMANCE_GROUPS', 'computeGroupStats'], { settings: {} });
  const t = (id, reason, result, pnlRaw) => ({ id, date: '2026-10-20', fillStatus: 'SKIPPED', setupCode: 'M2_OF', skippedReason: reason, result, pnl: Math.abs(pnlRaw), pnlRaw, contracts: 1 });
  const s = plain(r.computeGroupStats([t('a', 'CONTEXT', 'target', 50), t('b', 'CONTEXT', 'stoploss', -20), t('c', '', 'target', 30)], 'skipped'));
  assert.equal(s.count, 3);
  assert.deepEqual(s.byReason.map(x => [x.key, x.count]), [['M2_OF', 3]]);
  assert.deepEqual(s.byReason2.map(x => [x.key, x.count, x.wins, x.losses]), [['CONTEXT', 2, 1, 1], ['', 1, 1, 0]]);
  const nf = plain(r.computeGroupStats([{ id: 'n', fillStatus: 'NO_FILL', result: 'target', pnl: 1, pnlRaw: 1 }], 'noFill'));
  assert.equal(nf.byReason2, undefined, 'no fill druhý rozpad nemá');
});

test('export CSV: důvod vynechání ve dvou sloupcích na konci, jen u SKIPPED', () => {
  const r = loadRenderer(['CONTEXT_CSV_MANUAL', 'CONTEXT_CSV_DERIVED', 'CONTEXT_CSV_DAY', 'CONTEXT_CSV_PSYCH', 'CONTEXT_CSV_DAY_PSYCH', 'CONTEXT_CSV_SKIPPED',
    'csvBool', 'contextCsvHeader', 'contextCsvCells']);
  const h = r.contextCsvHeader();
  assert.deepEqual(plain(h.slice(-2)), ['Důvod vynechání', 'Důvod vynechání – text']);
  const row = r.contextCsvCells({ fillStatus: 'SKIPPED', skippedReason: 'CONTEXT', skippedReasonNote: 'zprávy' }, {});
  assert.deepEqual(plain(row.slice(-2)), ['CONTEXT', 'zprávy']);
  const other = r.contextCsvCells({ fillStatus: 'FILLED', skippedReason: 'CONTEXT' }, {});
  assert.deepEqual(plain(other.slice(-2)), ['', '']);
});
