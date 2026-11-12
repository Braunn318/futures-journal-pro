'use strict';
// Data trhu k obchodu – J1 (docs: Claude files/ZADANI_DENIK_SNAPSHOT_TRHU.md).
//
// Hlavní vypínač a přepínače (Nastavení → Data trhu), archiv LTA levelů bez
// mazání, export archivu do ai-export/lta-levels a původ hladin na obchodu
// (ltaMeta) – verze levelů vzniklá až po vstupu se nedoplní potichu.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FJLta = require('../app/lta-levels.js');
const FJTaxonomy = require('../app/taxonomy.js');
const FJMarket = require('../app/market-data.js');
const { createMarketStore } = require('../app/market-data-store.js');
const { createLtaStore, localDate } = require('../app/lta-store.js');
const { loadRenderer } = require('./helpers/extract');

const plain = v => JSON.parse(JSON.stringify(v));
const xmlLevel = (price, caption) => `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfLevel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Level Instrument="ES 12-26" Price="${price}" LevelId="X" xsi:type="Chart"><Caption Text="${caption}" /><ZoneRangeLower>0</ZoneRangeLower><ZoneRangeUpper>0</ZoneRangeUpper></Level>
</ArrayOfLevel>`;

function tempStore({ t0 = Date.parse('2026-11-02T09:00:00'), settings, exportDir } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-market-'));
  const docs = path.join(base, 'docs');
  const lta = path.join(docs, ...FJLta.DEFAULT_SUBDIR);
  fs.mkdirSync(path.join(lta, 'System'), { recursive: true });
  fs.mkdirSync(path.join(lta, 'Local'), { recursive: true });
  const user = path.join(base, 'user');
  if (settings !== undefined) {
    fs.mkdirSync(path.join(user, 'lta-levels'), { recursive: true });
    fs.writeFileSync(path.join(user, 'lta-levels', 'settings.json'), JSON.stringify(settings));
  }
  const clock = { t: t0 };
  const exp = { dir: exportDir === undefined ? null : exportDir };
  const store = createLtaStore({ userDataDir: user, documentsDir: docs, now: () => clock.t, exportDir: () => exp.dir });
  const write = (rel, text, mtime) => {
    const file = path.join(lta, rel);
    fs.writeFileSync(file, text);
    if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  };
  return { base, user, lta, store, clock, exp, write, cleanup: () => { store.stop(); fs.rmSync(base, { recursive: true, force: true }); } };
}

// ------------------------------------------------------- nastavení

test('nastavení: výchozí vypnuto, hlavní vypínač zapne doporučenou sadu 1–7, ne CSV', () => {
  const s = FJMarket.cleanMarketSettings({});
  assert.equal(s.enabled, false);
  for (const f of FJMarket.FEATURES) assert.equal(s.features[f.key], false, f.key);
  assert.equal(FJMarket.isOn(s, 'ltaExport'), false);
  const on = FJMarket.setEnabled(s, true);
  assert.equal(on.enabled, true);
  assert.deepEqual(FJMarket.FEATURES.filter(f => on.features[f.key]).map(f => f.key), FJMarket.FEATURES.filter(f => f.recommended).map(f => f.key));
  assert.equal(on.features.csvColumns, false, 'přepínač 8 (CSV) není v doporučené sadě');
  assert.equal(FJMarket.FEATURES.length, 8);
  // Ruční vypnutí jedné funkce vydrží vypnutí a znovuzapnutí hlavního vypínače.
  const custom = FJMarket.setFeature(on, 'ltaWarnings', false);
  const again = FJMarket.setEnabled(FJMarket.setEnabled(custom, false), true);
  assert.equal(again.features.ltaWarnings, false);
  assert.equal(again.features.ltaExport, true);
});

test('nastavení: isOn respektuje hlavní vypínač i předpoklad, zešedlý přepínač má důvod', () => {
  let s = FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true);
  assert.equal(FJMarket.isOn(s, 'ltaExport'), true);
  assert.equal(FJMarket.blockedReason(s, 'ltaExport'), null);
  s = FJMarket.setFeature(s, 'snapshot', false);
  assert.equal(FJMarket.isOn(s, 'signalBar'), false, 'signální svíčka bez snímku nejde');
  assert.match(FJMarket.blockedReason(s, 'signalBar'), /snímek/i);
  const off = FJMarket.setEnabled(s, false);
  assert.equal(FJMarket.isOn(off, 'ltaExport'), false);
  assert.match(FJMarket.blockedReason(off, 'ltaExport'), /hlavní vypínač/i);
  assert.deepEqual(plain(FJMarket.cleanMarketSettings({ enabled: 'ano', features: { nesmysl: true, ltaExport: 1 } })).features.nesmysl, undefined);
  assert.equal(FJMarket.isOn(null, 'ltaExport'), false);
});

test('nastavení: store ukládá do <userData>/market-data/settings.json', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-market-s-'));
  try {
    const st = createMarketStore({ userDataDir: base });
    assert.equal(st.getSettings().enabled, false);
    const next = st.setSettings({ enabled: true });
    assert.equal(next.features.ltaExport, true, 'zapnutí přes store = doporučená sada');
    assert.equal(createMarketStore({ userDataDir: base }).getSettings().features.ltaWarnings, true);
    assert.ok(fs.existsSync(path.join(base, 'market-data', 'settings.json')));
    st.setSettings({ features: { ltaWarnings: false } });
    assert.equal(st.getSettings().features.ltaWarnings, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ------------------------------------------------- J1.1 retence

test('retence: nová instalace nemaže archiv', async () => {
  const h = tempStore();
  try {
    assert.equal(FJLta.DEFAULT_SETTINGS.retentionDays, 0);
    assert.equal(h.store.getSettings().retentionDays, 0);
    fs.mkdirSync(h.store.root, { recursive: true });
    fs.writeFileSync(path.join(h.store.root, '2020-01-01.json'), '{"versions":[]}');
    assert.equal(h.store.prune(), 0);
    assert.ok(fs.existsSync(path.join(h.store.root, '2020-01-01.json')));
  } finally { h.cleanup(); }
});

test('retence: stará instalace s 90 se převede na „bez mazání" se zálohou, jen jednou', () => {
  const h = tempStore({ settings: { retentionDays: 90, nearestCount: 4 } });
  try {
    const s = h.store.getSettings();
    assert.equal(s.retentionDays, 0);
    assert.equal(s.nearestCount, 4, 'ostatní nastavení zůstane');
    const backup = path.join(h.user, 'lta-levels', 'settings.pred-retenci.json');
    assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).retentionDays, 90, 'záloha před zápisem');
    // Uživatel si pak mazání zapne ručně – další čtení to nevrátí.
    h.store.setSettings({ retentionDays: 90 });
    h.store.stop();
    assert.equal(h.store.getSettings().retentionDays, 90);
  } finally { h.cleanup(); }
});

test('retence: soubor bez retentionDays (stará výchozí 90) se převede, ruční hodnota zůstane', () => {
  const a = tempStore({ settings: { nearestCount: 2 } });
  const b = tempStore({ settings: { retentionDays: 30 } });
  try {
    assert.equal(a.store.getSettings().retentionDays, 0);
    assert.equal(b.store.getSettings().retentionDays, 30);
    assert.equal(b.store.getSettings().retentionDays, 30);
  } finally { a.cleanup(); b.cleanup(); }
});

// ------------------------------------------- J1.2 export archivu

test('export archivu: zapíše dny, podruhé nic, po nové verzi jen ten den; bez exportDir nic', async () => {
  const h = tempStore();
  try {
    h.write('System/SETT_NT8.xml', xmlLevel('7754.25', '30 SETT'));
    await h.store.snapshot();
    fs.writeFileSync(path.join(h.store.root, '2026-10-30.json'), JSON.stringify({ versions: [{ from: '2026-10-30T08:00:00.000Z', signature: 'x', levels: [] }] }));
    assert.deepEqual(h.store.exportArchive(), { written: 0, same: 0, off: true }, 'vypnutý export nic nezapíše');
    const out = path.join(h.base, 'ai-export', 'lta-levels');
    h.exp.dir = out;
    assert.deepEqual(plain(h.store.exportArchive()), { written: 2, same: 0 });
    const day = JSON.parse(fs.readFileSync(path.join(out, '2026-11-02.json'), 'utf8'));
    assert.equal(day.day, '2026-11-02');
    assert.equal(day.versions.length, 1);
    assert.equal(day.versions[0].levels[0].instrument, 'ES 12-26');
    assert.ok(day.versions[0].from && day.versions[0].signature);
    assert.deepEqual(plain(h.store.exportArchive()), { written: 0, same: 2 }, 'beze změny se nepřepisuje');
    h.clock.t += 5 * 60000;
    h.write('System/SETT_NT8.xml', xmlLevel('7760.00', '30 SETT'), h.clock.t + 1000);
    const snap = await h.store.snapshot();
    assert.equal(snap.written, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, '2026-11-02.json'), 'utf8')).versions.length, 2, 'nová verze se exportuje hned');
    assert.deepEqual(plain(h.store.exportArchive()), { written: 0, same: 2 });
    // Vypnutí exportu nic nemaže.
    h.exp.dir = null;
    h.store.exportArchive();
    assert.ok(fs.existsSync(path.join(out, '2026-10-30.json')));
  } finally { h.cleanup(); }
});

// ---------------------------------------- J1.3 verze po vstupu

test('levelsFor: verze vzniklá po vstupu → versionAfterEntry, verze před vstupem ne', async () => {
  const h = tempStore();
  try {
    h.write('System/SETT_NT8.xml', xmlLevel('7754.25', '30 SETT'));
    await h.store.snapshot(); // první verze dne v 9:00
    const before = await h.store.levelsFor({ root: 'ES', entryISO: new Date(Date.parse('2026-11-02T08:30:00')).toISOString() });
    assert.equal(before.source, 'archive');
    assert.equal(before.versionAfterEntry, true, 'deník běžel až po vstupu');
    const after = await h.store.levelsFor({ root: 'ES', entryISO: new Date(Date.parse('2026-11-02T09:30:00')).toISOString() });
    assert.equal(after.versionAfterEntry, false);
    const none = await h.store.levelsFor({ root: 'ES', entryISO: '2026-10-01T15:00:00.000Z' });
    assert.equal(none.source, 'none');
    assert.equal(none.versionAfterEntry, false);
  } finally { h.cleanup(); }
});

test('levelsFor: živé soubory změněné po vstupu → versionAfterEntry', async () => {
  const h = tempStore();
  try {
    h.store.setSettings({ archive: false });
    h.store.stop();
    h.write('System/SETT_NT8.xml', xmlLevel('7754.25', '30 SETT'), Date.parse('2026-11-02T08:50:00'));
    const early = await h.store.levelsFor({ root: 'ES', entryISO: new Date(Date.parse('2026-11-02T08:40:00')).toISOString() });
    assert.equal(early.source, 'live');
    assert.equal(early.versionAfterEntry, true);
    const late = await h.store.levelsFor({ root: 'ES', entryISO: new Date(Date.parse('2026-11-02T08:55:00')).toISOString() });
    assert.equal(late.versionAfterEntry, false);
  } finally { h.cleanup(); }
});

// ---------------------------------------- J1.4 dny bez archivu

test('status: pracovní dny bez archivu mezi prvním dnem a dneškem', async () => {
  const h = tempStore({ t0: Date.parse('2026-11-10T12:00:00') });
  try {
    fs.mkdirSync(h.store.root, { recursive: true });
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-09']) fs.writeFileSync(path.join(h.store.root, d + '.json'), '{"versions":[]}');
    const st = await h.store.status();
    assert.deepEqual(st.archive.missingWeekdays, ['2026-11-06', '2026-11-04'], 'nejnovější první, bez víkendu a bez dneška');
    assert.equal(st.archive.missingCount, 2);
  } finally { h.cleanup(); }
});

// ------------------------------ renderer: import z konektoru a ltaMeta

const CAPTURE_NAMES = ['ltaRowsFor', 'ltaHoldBack', 'ltaApplyToCapturedTrade'];
function captureRenderer(res, market) {
  return loadRenderer(CAPTURE_NAMES, {
    FJLta, FJMarket,
    normalizeInstrumentCode: i => String(i || '').trim().toUpperCase().split(/\s+/)[0],
    ltaSettings: async () => FJLta.cleanSettings({ nearestCount: 2 }),
    marketSettings: async () => market,
    window: { desktopAPI: { ltaLevelsFor: async () => res } }
  });
}
const LATE = { ok: true, levels: [{ name: 'SETT', price: 7754.25 }, { name: 'ID LOW', price: 7700 }], source: 'archive', day: '2026-11-02', versionFrom: '2026-11-02T08:00:00.000Z', versionAfterEntry: true };
const OK = { ...LATE, versionAfterEntry: false };
const trade = () => ({ instrument: 'ES', entryPrice: 7750, date: '2026-11-02', entryTime: '08:30' });
const EVENT = { instrumentFull: 'ES 12-26', entryTime: '2026-11-02T07:30:00.000Z' };

test('import: hlavní vypínač vypnutý (výchozí) = doplní jako dřív a žádné ltaMeta', async () => {
  const r = captureRenderer(LATE, FJMarket.cleanMarketSettings({}));
  const t = trade();
  await r.ltaApplyToCapturedTrade(t, EVENT, {});
  assert.equal(FJTaxonomy.nearLevelsOf(t).length, 2);
  assert.equal('ltaMeta' in t, false);
});

test('import: verze po vstupu se s upozorněním nedoplní, ltaMeta to zaznamená', async () => {
  const on = FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true);
  const r = captureRenderer(LATE, on);
  const t = trade();
  await r.ltaApplyToCapturedTrade(t, EVENT, {});
  assert.equal(FJTaxonomy.nearLevelsOf(t).length, 0, 'nic potichu');
  assert.deepEqual(plain(t.ltaMeta), { source: 'archive', day: '2026-11-02', versionFrom: '2026-11-02T08:00:00.000Z', versionAfterEntry: true, offered: 2 });
  // Bez přepínače 2 se doplní, ltaMeta zůstává (hlavní vypínač zapnutý).
  const r2 = captureRenderer(LATE, FJMarket.setFeature(on, 'ltaWarnings', false));
  const t2 = trade();
  await r2.ltaApplyToCapturedTrade(t2, EVENT, {});
  assert.equal(FJTaxonomy.nearLevelsOf(t2).length, 2);
  assert.equal(t2.ltaMeta.versionAfterEntry, true);
  // Verze před vstupem se doplní normálně.
  const r3 = captureRenderer(OK, on);
  const t3 = trade();
  await r3.ltaApplyToCapturedTrade(t3, EVENT, {});
  assert.equal(FJTaxonomy.nearLevelsOf(t3).length, 2);
  assert.equal(t3.ltaMeta.versionAfterEntry, false);
});

test('import: den bez archivu → ltaMeta source none, obchod se importuje beze změny', async () => {
  const on = FJMarket.setEnabled(FJMarket.cleanMarketSettings({}), true);
  const r = captureRenderer({ ok: true, levels: [], source: 'none', day: '2026-10-01', versionFrom: null }, on);
  const t = trade();
  const before = plain(t);
  assert.equal(await r.ltaApplyToCapturedTrade(t, EVENT, {}), null);
  const { ltaMeta, ...rest } = t;
  assert.deepEqual(plain(rest), before);
  assert.deepEqual(plain(ltaMeta), { source: 'none', day: '2026-10-01', versionFrom: null, versionAfterEntry: false, offered: 0 });
  assert.equal(r.ltaHoldBack(ltaMeta), true);
  assert.equal(r.ltaHoldBack(null), false);
});

test('sloučení: ltaMeta první nohy zůstane', () => {
  const r = loadRenderer(
    ['normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument', 'getDefaultCommissionForInstrument',
      'classifyResult', 'signed', 'tradeTotalPoints', 'weightedExitFields', 'legFromTrade',
      'mergeSamePriceLegs', 'labelLegs', 'mergeContextFields', 'getTickSizeForInstrument', 'BUILTIN_TICK_SIZES', 'postExitFields', 'applyPostExitFields', 'postExitApplies', 'POST_EXIT_DERIVED_KEYS', 'combineTradeObjects'],
    { settings: { templates: [{ instrument: 'MES', pointValue: 5, commission: 1.9 }] } }
  );
  const base = { instrument: 'MES', date: '2026-09-12', entryTime: '16:00', entryPrice: 7700, side: 'long', positionId: 'p1', contracts: 1, commission: 1.9 };
  const meta = { source: 'archive', day: '2026-09-12', versionFrom: '2026-09-12T13:00:00.000Z', versionAfterEntry: false, offered: 4 };
  const a = { ...base, id: 'a', exitTime: '16:05', exitPrice: 7703, points: 3, pnl: 13.1, result: 'target', ltaMeta: meta };
  const b = { ...base, id: 'b', exitTime: '16:09', exitPrice: 7705, points: 5, pnl: 23.1, result: 'target' };
  assert.deepEqual(plain(r.combineTradeObjects([a, b]).ltaMeta), meta);
  assert.equal('ltaMeta' in r.combineTradeObjects([b, { ...a, ltaMeta: undefined }]), false);
});

test('localDate je místní datum', () => { assert.equal(localDate(Date.parse('2026-11-02T09:00:00')), '2026-11-02'); });
