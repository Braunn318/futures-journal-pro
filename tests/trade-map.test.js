'use strict';
// Mapa obchodu (docs/ZADANI_DENIK_MAPA_OBCHODU.md §5): model grafu, řádek
// slovy, souhrnný počet, žebříček seznamu a nastavení zobrazení.
// Deník jen měří – pásma jsou poloha mezi cenami, vzdálenosti z levelGeometry.

const test = require('node:test');
const assert = require('node:assert/strict');

const FJTradeMap = require('../app/trade-map.js');
const FJContext = require('../app/context.js');
const FJSnapshot = require('../app/market-snapshot.js');

const TICK = 0.25;
const NAMES = { VPOC_30M_CURRENT: 'VPOC 30M aktuální', LTA_LUDVIK: 'LUDVIK', VWAP: 'VWAP', LTA_GAMMA_L2: 'Gamma L2', VPOC_DAY: 'VPOC dne', VAH: 'VAH', VAL: 'VAL' };
const labelOf = k => NAMES[k] || k;
const plain = v => JSON.parse(JSON.stringify(v));

// Long 7600, SL 7595, cíl 1 7605, cíl 2 7610.
function longTrade(extra = {}) {
  return {
    instrument: 'ES', side: 'long', entryPrice: 7600, slPrice: 7595,
    targetLevel1: { types: [], price: 7605 }, targetLevel2: { types: [], price: 7610 },
    nearLevels: [
      { level: 'VPOC_30M_CURRENT', price: 7598.75, source: 'snapshot' },   // −5 t, mezi SL a vstupem
      { level: 'LTA_LUDVIK', price: 7597.5, source: 'lta', testState: 'UNTESTED' }, // −10 t
      { level: 'VWAP', price: 7602.5 },                                      // +10 t, ruční
      { level: 'LTA_GAMMA_L2', price: 7607.5, source: 'lta' },               // +30 t, mezi cílem 1 a 2
      { level: 'VAH', price: 7620, source: 'snapshot' },                     // nad posledním cílem, mimo rozsah
      { level: 'VAL', price: 7580, source: 'snapshot' }                      // pod SL, mimo rozsah
    ],
    ...extra
  };
}
// Zrcadlový short: vstup 7600, SL 7605, cíle 7595 / 7590.
function shortTrade(extra = {}) {
  return {
    instrument: 'ES', side: 'short', entryPrice: 7600, slPrice: 7605,
    targetLevel1: { types: [], price: 7595 }, targetLevel2: { types: [], price: 7590 },
    nearLevels: [
      { level: 'VPOC_30M_CURRENT', price: 7601.25, source: 'snapshot' },
      { level: 'VWAP', price: 7597.5 },
      { level: 'VAL', price: 7570, source: 'snapshot' }
    ],
    ...extra
  };
}

// ---------------------------------------------------------------- 1. model

test('1 long: čáry, pásma a vzdálenosti shodné s levelGeometry', () => {
  const t = longTrade();
  const m = FJTradeMap.tradeMapModel(t, { tickSize: TICK, labelOf });
  assert.deepEqual(m.lines.filter(l => l.kind !== 'level').map(l => [l.kind, l.price]), [['entry', 7600], ['sl', 7595], ['target', 7605], ['target', 7610]]);
  const levels = m.lines.filter(l => l.kind === 'level');
  assert.equal(levels.length, 6);
  levels.forEach(l => assert.deepEqual(l.geometry, FJContext.levelGeometry(t.nearLevels[l.rowIndex], t, TICK)));
  assert.deepEqual(levels.map(l => l.source), ['snapshot', 'lta', 'manual', 'lta', 'snapshot', 'snapshot']);
  assert.deepEqual(m.bands, [{ kind: 'risk', from: 7595, to: 7600 }, { kind: 'reward', from: 7600, to: 7610 }]);
  assert.deepEqual(m.lastTarget, { n: 2, price: 7610 });
  assert.deepEqual(levels.map(l => l.zone), ['STOP_TO_ENTRY', 'STOP_TO_ENTRY', 'ENTRY_TO_TARGET', 'ENTRY_TO_TARGET', 'BEYOND_TARGET', 'BEYOND_STOP']);
  // Popisky shora dolů = pořadí cen.
  const prices = m.labels.map(l => l.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
});

test('1 short: pásma v opačném směru, poslední cíl = nejníž', () => {
  const t = shortTrade();
  const m = FJTradeMap.tradeMapModel(t, { tickSize: TICK, labelOf });
  assert.deepEqual(m.bands, [{ kind: 'risk', from: 7605, to: 7600 }, { kind: 'reward', from: 7600, to: 7590 }]);
  assert.deepEqual(m.lastTarget, { n: 2, price: 7590 });
  const levels = m.lines.filter(l => l.kind === 'level');
  levels.forEach(l => assert.deepEqual(l.geometry, FJContext.levelGeometry(t.nearLevels[l.rowIndex], t, TICK)));
  assert.deepEqual(levels.map(l => l.zone), ['STOP_TO_ENTRY', 'ENTRY_TO_TARGET', 'BEYOND_TARGET']);
  assert.equal(levels[0].geometry.fromEntry, -5);
  assert.equal(levels[1].geometry.fromEntry, 10);
});

// ------------------------------------------------------- 2. rozsah a „další“

test('2 hladiny mimo výchozí rozsah se počítají v ↑ / ↓ další, celý rozsah je vrátí', () => {
  const t = longTrade();
  const m = FJTradeMap.tradeMapModel(t, { tickSize: TICK, labelOf });
  assert.ok(m.range.min < 7595 && m.range.max > 7610, 'kousek za SL a za posledním cílem');
  assert.ok(m.range.max < 7620 && m.range.min > 7580);
  assert.equal(m.hiddenAbove, 1);
  assert.equal(m.hiddenBelow, 1);
  assert.equal(m.lines.find(l => l.price === 7620).visible, false);
  const full = FJTradeMap.tradeMapModel(t, { tickSize: TICK, labelOf, full: true });
  assert.equal(full.hiddenAbove, 0);
  assert.equal(full.hiddenBelow, 0);
  assert.ok(full.lines.every(l => l.visible));
  assert.equal(full.range.full, true);
});

// ------------------------------------------------------ 3. sloučené popisky

test('3 hladiny na stejné ceně mají jeden popisek, data zůstanou dva řádky', () => {
  const t = longTrade({ nearLevels: [{ level: 'VPOC_30M_CURRENT', price: 7602.5, source: 'snapshot' }, { level: 'LTA_GAMMA_L2', price: 7602.5, source: 'lta' }] });
  const before = plain(t);
  const m = FJTradeMap.tradeMapModel(t, { tickSize: TICK, labelOf });
  const lab = m.labels.filter(l => l.price === 7602.5);
  assert.equal(lab.length, 1);
  assert.match(lab[0].text, /^VPOC 30M aktuální \+ Gamma L2 · \+10 t$/);
  assert.equal(m.lines.filter(l => l.kind === 'level').length, 2);
  assert.deepEqual(plain(t), before, 'model obchod nemění');
});

test('3 blízké ceny (popisky by se kryly) se sloučí, vzdálené ne', () => {
  const t = longTrade({ nearLevels: [{ level: 'VWAP', price: 7602.5 }, { level: 'VAH', price: 7602.75 }, { level: 'VAL', price: 7597.5 }] });
  const m = FJTradeMap.tradeMapModel(t, { tickSize: TICK, labelOf, heightPx: 200, labelGapPx: 13 });
  const merged = m.labels.find(l => l.lines.length === 2 && l.lines.every(i => m.lines[i].kind === 'level'));
  assert.ok(merged, 'VWAP a VAH mají jeden popisek');
  // Shora dolů: VAH 7602,75 nad VWAP 7602,5.
  assert.match(merged.text, /VAH \+ VWAP · \+11 t \/ \+10 t/);
  assert.ok(m.labels.some(l => l.text.startsWith('VAL')));
});

test('3 hodně hladin v celém rozsahu: popisky se neřetězí, Vstup / SL / cíl mají vlastní, nic se nekryje', () => {
  const prices = [-9, -4.5, 3, -2, 5.25, 7, 7, 12, -1, 14.5, 18, -12, 22, -16, 10, 1.25, -6];
  const t = longTrade({ entryPrice: 7700, slPrice: 7694, targetLevel1: { price: 7708 }, targetLevel2: { price: 7716 },
    nearLevels: prices.map((d, i) => ({ level: 'L' + i, price: 7700 + d })) });
  const m = FJTradeMap.tradeMapModel(t, { tickSize: TICK, labelOf, full: true, heightPx: 240, maxHeightPx: 560, labelGapPx: 16 });
  for (const lab of m.labels) {
    const kinds = lab.lines.map(i => m.lines[i].kind);
    if (kinds.some(k => k !== 'level')) assert.equal(new Set(lab.lines.map(i => m.lines[i].price)).size, 1, 'Vstup / SL / cíl jen s hladinou na stejné ceně: ' + lab.text);
    // Skupina = ceny, jejichž popisky by se kryly vůči PRVNÍ ceně (ne řetěz).
    const ps = lab.lines.map(i => m.lines[i].price);
    const px = (Math.max(...ps) - Math.min(...ps)) / (m.range.max - m.range.min) * m.heightPx;
    assert.ok(px < 16, 'skupina drží jen blízké ceny, ne řetěz: ' + lab.text);
  }
  m.labels.forEach((lab, k) => { if (k) assert.ok(lab.ly - m.labels[k - 1].ly >= 16 - 1e-9, 'popisky se nekryjí'); });
  assert.ok(m.labels.every(l => l.ly >= 0 && l.ly <= m.heightPx));
  assert.ok(m.heightPx > 240 && m.heightPx <= 560, 'graf se zvětšil, aby se popisky vešly');
  assert.equal(m.lines.filter(l => l.kind === 'level').length, 17, 'žádný řádek nezmizel');
});

// -------------------------------------------------- 4. chybějící vstupy

test('4 obchod bez snímku = model bez svíček; se snímkem 5 / 10 svíček podle času', () => {
  assert.deepEqual(FJTradeMap.tradeMapModel(longTrade(), { tickSize: TICK }).candles, []);
  const bars1m = [];
  for (let i = 0; i < 25; i++) bars1m.push({ t: new Date(Date.parse('2026-11-12T11:16:00.000Z') + i * 60000).toISOString(), o: 7600, h: 7601, l: 7599, c: 7600.5, v: 10, delta: 1, vpoc: [7600] });
  const snap = { time: '2026-11-12T11:40:30.000Z', bars1m };
  const m5 = FJTradeMap.tradeMapModel(longTrade({ marketSnapshot: snap }), { tickSize: TICK, bars: 5 });
  assert.deepEqual(m5.candles.map(c => c.offset), [-5, -4, -3, -2, -1]);
  assert.equal(m5.candles[4].t, FJSnapshot.signalBarEnd(snap, -1));
  assert.equal(m5.candles[4].signal, true);
  const m10 = FJTradeMap.tradeMapModel(longTrade({ marketSnapshot: snap, signalBarOffset: -3 }), { tickSize: TICK, bars: 10 });
  assert.equal(m10.candles.length, 10);
  assert.deepEqual(m10.candles.filter(c => c.signal).map(c => c.offset), [-3]);
  assert.deepEqual(m10.candles.filter(c => !c.selectable).map(c => c.offset), [-10, -9, -8, -7, -6]);
  assert.ok(m10.candles.every(c => c.bar), 'všechny svíčky jsou ve snímku');
});

test('4 bez SL nebo cíle se pásmo nekreslí, bez hladin jen vstup, SL a cíl; nic nepadá', () => {
  const noSl = FJTradeMap.tradeMapModel(longTrade({ slPrice: '' }), { tickSize: TICK });
  assert.deepEqual(noSl.bands.map(b => b.kind), ['reward']);
  const noTarget = FJTradeMap.tradeMapModel(longTrade({ targetLevel1: null, targetLevel2: null }), { tickSize: TICK });
  assert.deepEqual(noTarget.bands.map(b => b.kind), ['risk']);
  const bare = FJTradeMap.tradeMapModel(longTrade({ nearLevels: [] }), { tickSize: TICK });
  assert.deepEqual(bare.lines.map(l => l.kind), ['entry', 'sl', 'target', 'target']);
  const empty = FJTradeMap.tradeMapModel({}, {});
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.range, null);
  // Jen vstup a hladiny: rozsah = celý (nic jiného, podle čeho ho určit).
  const onlyEntry = FJTradeMap.tradeMapModel({ side: 'long', entryPrice: 7600, nearLevels: [{ level: 'VWAP', price: 7610 }] }, { tickSize: TICK });
  assert.equal(onlyEntry.range.full, true);
  assert.equal(onlyEntry.hiddenAbove + onlyEntry.hiddenBelow, 0);
});

// ------------------------------------------------------------ 5. řádek slovy

test('5 řádek slovy vyjmenuje přesně hladiny mezi SL a vstupem a před (posledním) cílem', () => {
  assert.equal(
    FJTradeMap.summarySentence(longTrade(), { tickSize: TICK, labelOf }),
    'Mezi SL a vstupem: VPOC 30M aktuální (−5 t), LUDVIK (−10 t) · Před cílem: VWAP (+10 t), Gamma L2 (+30 t)'
  );
  // Hladina přesně na vstupu patří mezi SL a vstup.
  const at = longTrade({ nearLevels: [{ level: 'VWAP', price: 7600 }] });
  assert.equal(FJTradeMap.summarySentence(at, { tickSize: TICK, labelOf }), 'Mezi SL a vstupem: VWAP (0 t) · Před cílem: nic');
  // Short.
  assert.equal(FJTradeMap.summarySentence(shortTrade(), { tickSize: TICK, labelOf }), 'Mezi SL a vstupem: VPOC 30M aktuální (−5 t) · Před cílem: VWAP (+10 t)');
  // Jednotka body (dist z UI).
  const dist = (n, plus) => (n > 0 && plus ? '+' : n < 0 ? '−' : '') + String(Math.abs(n) * TICK).replace('.', ',') + ' b';
  assert.match(FJTradeMap.summarySentence(longTrade(), { tickSize: TICK, labelOf, dist }), /VPOC 30M aktuální \(−1,25 b\)/);
  // Bez hladin nic; „žádná hladina" výslovně.
  assert.equal(FJTradeMap.summarySentence(longTrade({ nearLevels: [] }), { tickSize: TICK }), '');
  assert.equal(FJTradeMap.summarySentence(longTrade({ nearLevels: [], nearLevelsNone: true }), { tickSize: TICK }), 'Žádná hladina v blízkosti.');
});

test('5 souhrnný počet pro řádek mimo detail obchodu', () => {
  const c = FJTradeMap.summaryCounts(longTrade(), { tickSize: TICK });
  assert.equal(c.text, 'Hladiny: 2 mezi SL a vstupem · 2 před cílem');
  assert.equal(FJTradeMap.summaryCounts(longTrade({ nearLevels: [] }), { tickSize: TICK }).text, '');
  assert.equal(FJTradeMap.summaryCounts(longTrade({ nearLevels: [], nearLevelsNone: true }), { tickSize: TICK }).text, 'Hladiny: žádná v blízkosti');
});

// ----------------------------------------------------------------- 6. žebříček

const ladderKinds = items => items.map(i => i.kind === 'level' ? i.row.level + '@' + i.price : i.kind + (i.n ? i.n : '') + '@' + i.price);

test('6 seznam podle ceny shora dolů, Vstup / SL / Cíl na správném místě (long)', () => {
  const t = longTrade({ nearLevels: [...longTrade().nearLevels, { level: 'VPOC_DAY', price: 7600 }, { level: 'VAH', price: 7595 }, { level: 'VAL', price: 7605 }] });
  assert.deepEqual(ladderKinds(FJTradeMap.ladder(t)), [
    'VAH@7620', 'target2@7610', 'LTA_GAMMA_L2@7607.5', 'target1@7605', 'VAL@7605', 'VWAP@7602.5',
    'entry@7600', 'VPOC_DAY@7600', 'VPOC_30M_CURRENT@7598.75', 'LTA_LUDVIK@7597.5', 'VAH@7595', 'sl@7595', 'VAL@7580'
  ]);
});

test('6 seznam podle ceny shora dolů, Vstup / SL / Cíl na správném místě (short)', () => {
  const t = shortTrade({ nearLevels: [...shortTrade().nearLevels, { level: 'VPOC_DAY', price: 7600 }, { level: 'VAH', price: 7605 }, { level: 'LTA_LUDVIK', price: 7595 }] });
  assert.deepEqual(ladderKinds(FJTradeMap.ladder(t)), [
    'sl@7605', 'VAH@7605', 'VPOC_30M_CURRENT@7601.25', 'VPOC_DAY@7600', 'entry@7600', 'VWAP@7597.5',
    'LTA_LUDVIK@7595', 'target1@7595', 'target2@7590', 'VAL@7570'
  ]);
});

test('6 řádek bez ceny (starší zápis) je na konci, nic se neztratí', () => {
  const t = longTrade({ nearLevels: [{ level: 'VWAP', legacySide: 'TG', ticksFromEntry: 8 }, { level: 'VAH', price: 7602 }] });
  const items = FJTradeMap.ladder(t);
  assert.equal(items[items.length - 1].row.level, 'VWAP');
  assert.equal(items.filter(i => i.kind === 'level').length, 2);
});

// ------------------------------------------------------- nastavení zobrazení

test('nastavení zobrazení: výchozí mapa zapnutá, 5 svíček, souhrnný řádek vypnutý', () => {
  assert.deepEqual(FJTradeMap.normalizeLevelsView(null), { map: true, bars: 5, summaryLine: false });
  assert.deepEqual(FJTradeMap.normalizeLevelsView({ map: false, bars: 10, summaryLine: true }), { map: false, bars: 10, summaryLine: true });
  assert.equal(FJTradeMap.normalizeLevelsView({ bars: 7 }).bars, 5);
  assert.deepEqual(FJTradeMap.normalizeSourceFilter({ lta: false }), { lta: false, snapshot: true, manual: true });
});

// --------------------------------------------------- VPOC 30M aktuální (§2)

test('snímek: rozvíjející se 30min VPOC (konektor v9) → typ VPOC 30M aktuální; v8 = null, nic nepadá', () => {
  const base = { executionId: 'E1', time: '2026-11-12T11:40:30.000Z', bars1m: [], bars30m: [], day: {} };
  assert.equal(FJSnapshot.normalizeSnapshotPayload(base).snapshot.bar30mCurrent, null);
  const v9 = FJSnapshot.normalizeSnapshotPayload({ ...base, bar30mCurrent: { start: '2026-11-12T11:30:00.000Z', vpoc: [7598.75] } }).snapshot;
  assert.deepEqual(v9.bar30mCurrent, { t: '2026-11-12T11:30:00.000Z', vpoc: [7598.75] });
  // Svíčka, která začala až po vstupu, se zahodí.
  assert.equal(FJSnapshot.normalizeSnapshotPayload({ ...base, bar30mCurrent: { start: '2026-11-12T12:00:00.000Z', vpoc: [7600] } }).snapshot.bar30mCurrent, null);
  const type = FJSnapshot.LEVEL_TYPES.find(t => t.key === 'VPOC_30M_CURRENT');
  assert.equal(type.level, 'VPOC_30M_CURRENT');
  assert.equal(type.group, 'DAY');
  const cands = FJSnapshot.snapshotLevelCandidates(v9);
  assert.deepEqual(cands.filter(c => c.type === 'VPOC_30M_CURRENT').map(c => c.price), [7598.75]);
  assert.deepEqual(FJSnapshot.snapshotLevelCandidates(v9, { VPOC_30M_CURRENT: false }).filter(c => c.type === 'VPOC_30M_CURRENT'), []);
  const FJTaxonomy = require('../app/taxonomy.js');
  assert.equal(FJTaxonomy.labelOf('NEAR_LEVEL', 'VPOC_30M_CURRENT'), 'VPOC 30M aktuální');
});

test('barEndAt: stejné pravidlo jako signální svíčka, sahá až k −25', () => {
  const snap = { time: '2026-11-12T11:40:30.000Z' };
  for (const o of [-1, -3, -5]) assert.equal(FJSnapshot.barEndAt(snap, o), FJSnapshot.signalBarEnd(snap, o));
  assert.equal(FJSnapshot.barEndAt(snap, -10), '2026-11-12T11:31:00.000Z');
  assert.equal(FJSnapshot.signalBarEnd(snap, -10), FJSnapshot.signalBarEnd(snap, -5), 'výběr signální svíčky dál jen −1 … −5');
});
