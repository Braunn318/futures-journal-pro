'use strict';
// Test 10 zadání docs/ZADANI_SWING_SLUCOVANI_PRIKAZU.md: futures merge beze změny.
// Slučování limitek ve swingu kód futures merge (combineTradeObjects) nesdílí. Pro jistotu
// se výstup combineTradeObjects z pracovní kopie porovná s výstupem stejné funkce z tagu
// v4.8.103 (před dávkou) na obchodech z futures vzorku docs/samples/futures-report_new.csv.
// Vzorek leží mimo veřejný repozitář; bez něj nebo bez gitu se test přeskočí. Nic ze vzorku
// se neukládá.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { loadFromSource, inlineScripts, readRepoFile, REPO_ROOT } = require('./helpers/extract');
const { parseCsvRecords } = require('./helpers/csv');
const { REPORT_CSV, exists } = require('./helpers/paths');

const NAMES = ['normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument', 'getDefaultCommissionForInstrument',
  'classifyResult', 'signed', 'tradeTotalPoints', 'weightedExitFields', 'legFromTrade',
  'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'postExitFields',
  'applyPostExitFields', 'postExitApplies', 'POST_EXIT_DERIVED_KEYS', 'combineTradeObjects'];
const SETTINGS = { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }, { instrument: 'MNQ', pointValue: 2, defaultCommission: 1.9 }], breakEvenEnabled: true, breakEvenThreshold: 5, autoMergeLegs: true };
const BASELINE_TAG = 'v4.8.103';

function baselineHtml() {
  try { return execFileSync('git', ['show', `${BASELINE_TAG}:app/index.html`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}
const num = v => { const n = Number(String(v ?? '').trim().replace(',', '.')); return Number.isFinite(n) ? n : null; };

test('10: futures merge (combineTradeObjects) dává stejný výsledek jako před dávkou', t => {
  const html = baselineHtml();
  if (!html) return t.skip(`tag ${BASELINE_TAG} není k dispozici`);
  if (!exists(REPORT_CSV)) return t.skip('futures vzorek docs/samples/futures-report_new.csv chybí');
  const fixedNow = 1795000000000;
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { super(...(a.length ? a : [fixedNow])); } static now() { return fixedNow; } }
  const globals = { settings: SETTINGS, Date: FixedDate };
  const before = loadFromSource(inlineScripts(html), NAMES, globals);
  const after = loadFromSource(inlineScripts(readRepoFile('app/index.html')), NAMES, globals);
  const { records } = parseCsvRecords(fs.readFileSync(REPORT_CSV, 'utf8'));
  const trades = records.map((r, i) => ({
    id: 'r' + i, instrument: r['Instrument'], date: r['Datum'], entryTime: r['Čas vstupu'], entryPrice: num(r['Cena vstupu']),
    exitTime: r['Čas výstupu'], exitPrice: num(r['Cena výstupu']), side: String(r['Směr']).toLowerCase(), result: r['Výsledek'],
    points: num(r['Body']), pnlRaw: num(r['P/L']), pnl: Math.abs(num(r['P/L']) || 0), contracts: 1, commission: 1.9,
    comment: r['Komentář (viditelný)'] || '', createdAt: fixedNow, positionId: 'p' + i
  })).filter(x => x.instrument && x.date);
  assert.ok(trades.length > 10, 'vzorek má obchody');
  // dvojice / trojice obchodů téhož dne a instrumentu = vstup pro sloučení
  const byDay = new Map();
  for (const x of trades) { const k = x.date + '|' + x.instrument; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(x); }
  let compared = 0;
  for (const list of byDay.values()) {
    for (const size of [1, 2, 3]) {
      if (list.length < size) continue;
      const pick = list.slice(0, size);
      const a = JSON.parse(JSON.stringify(before.combineTradeObjects(pick.map(x => ({ ...x })))));
      const b = JSON.parse(JSON.stringify(after.combineTradeObjects(pick.map(x => ({ ...x })))));
      delete a.id; delete b.id;
      assert.deepEqual(b, a, `sloučení ${pick.map(x => x.date + ' ' + x.entryTime).join(' + ')}`);
      compared++;
    }
  }
  assert.ok(compared > 10, 'porovnáno dost sloučení: ' + compared);
});
