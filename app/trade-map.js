'use strict';
// Mapa obchodu – hladiny, Vstup / SL / cíle a svíčky snímku v jednom grafu
// (docs/ZADANI_DENIK_MAPA_OBCHODU.md). Čisté funkce: model pro graf, řádek
// slovy, souhrnný počet a žebříček seznamu. UI (app/index.html) je jen kreslí.
//
// Deník MĚŘÍ, nehodnotí: pásma jsou jen poloha mezi dvěma cenami, žádná
// tolerance, žádná role. Vzdálenosti od vstupu a SL jsou z
// FJContext.levelGeometry – nic se nepočítá podruhé. Jediné, co tady přibývá,
// je poloha vůči POSLEDNÍMU cíli (rozhodnutí uživatele 2026-11-14): obchod
// s víc cíli má pásmo „před cílem" až k poslednímu; dopočty v exportu
// (levelGeometry, cíl 1) se nemění.
//
// Slučuje se jen KRESLENÍ popisků (hladiny na stejné nebo blízké ceně mají
// jeden popisek). Data – řádky nearLevels – zůstávají, jak jsou.
//
// Načítá se přes <script src> po points.js, taxonomy.js, market-snapshot.js
// a context.js; v Node přes require.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJTradeMap = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  const dep = (name, file) => {
    if (root && root[name]) return root[name];
    if (typeof require === 'function') { try { return require(file); } catch { return null; } }
    return null;
  };
  const Points = () => dep('FJPoints', './points.js');
  const Taxonomy = () => dep('FJTaxonomy', './taxonomy.js');
  const Context = () => dep('FJContext', './context.js');
  const Snapshot = () => dep('FJSnapshot', './market-snapshot.js');

  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const dirOf = side => (side === 'long' ? 1 : side === 'short' ? -1 : null);

  // ------------------------------------------------------- nastavení zobrazení
  // Nastavení → Přizpůsobení → Hladiny → Zobrazení (localStorage FJ_levelsView).
  const DEFAULT_VIEW = Object.freeze({ map: true, bars: 5, summaryLine: false });
  const BAR_CHOICES = Object.freeze([5, 10]);
  function normalizeLevelsView(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      map: s.map !== false,
      bars: BAR_CHOICES.includes(Number(s.bars)) ? Number(s.bars) : DEFAULT_VIEW.bars,
      summaryLine: s.summaryLine === true
    };
  }

  // Zdroj řádku: LTA / snímek trhu / ruční (bez `source`).
  const SOURCES = Object.freeze(['lta', 'snapshot', 'manual']);
  const sourceOf = row => (row?.source === 'lta' || row?.source === 'snapshot' ? row.source : 'manual');
  function normalizeSourceFilter(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return Object.fromEntries(SOURCES.map(k => [k, s[k] !== false]));
  }

  // Cíle obchodu s cenou: [{ n, price }] v pořadí čísel (targetLevel1, 2, 3 …).
  // `trade.targets` (z formuláře, už seřazené) má přednost.
  function targetsOf(trade) {
    if (Array.isArray(trade?.targets)) {
      return trade.targets.map((p, i) => ({ n: i + 1, price: num(p) })).filter(t => t.price != null);
    }
    const tax = Taxonomy();
    const nums = tax ? tax.targetLevelNumbers(trade) : [1, 2];
    return nums.map(n => ({ n, price: num(trade?.['targetLevel' + n]?.price) })).filter(t => t.price != null);
  }

  // Ticky ceny od vstupu ve směru obchodu – stejný výpočet jako
  // offsetFromEntry v context.js (FJPoints.ticksOf).
  function offsetTicks(price, trade, tickSize) {
    const p = num(price), entry = num(trade?.entryPrice), dir = dirOf(trade?.side);
    if (p == null || entry == null || dir == null) return null;
    const t = Points().ticksOf((p - entry) * dir, tickSize);
    return t == null ? null : t + 0;
  }

  // Poslední cíl = nejdál ve směru obchodu (ne nutně nejvyšší číslo).
  function lastTargetOf(trade, tickSize) {
    let best = null;
    for (const t of targetsOf(trade)) {
      const off = offsetTicks(t.price, trade, tickSize);
      if (off == null || off <= 0) continue;
      if (!best || off > best.ticks) best = { ...t, ticks: off };
    }
    return best;
  }

  // Úsek řádku podle geometrie: STOP_TO_ENTRY (včetně hladiny přesně na
  // vstupu), ENTRY_TO_TARGET (až k POSLEDNÍMU cíli), BEYOND_STOP,
  // BEYOND_TARGET; null, když to nejde určit (chybí SL / cíl / cena …).
  function zoneOf(geometry, lastTargetTicks) {
    const g = geometry || {};
    if (g.fromEntry == null) return null;
    if (g.fromEntry === 0) return 'STOP_TO_ENTRY';
    if (g.fromEntry < 0) return g.fromStop == null ? null : (g.fromStop < 0 ? 'BEYOND_STOP' : 'STOP_TO_ENTRY');
    if (lastTargetTicks == null) return null;
    return g.fromEntry > lastTargetTicks ? 'BEYOND_TARGET' : 'ENTRY_TO_TARGET';
  }

  const tickDistance = (n, plus) => (n > 0 && plus ? '+' : n < 0 ? '−' : '') + Math.abs(n) + ' t';

  // Řádky obchodu s geometrií a úsekem (jedno místo pro graf, větu i počty).
  function levelRows(trade, tickSize) {
    const tax = Taxonomy(), ctx = Context();
    const rows = tax ? tax.nearLevelsOf(trade) : (Array.isArray(trade?.nearLevels) ? trade.nearLevels : []);
    const last = lastTargetOf(trade, tickSize);
    return rows.map((row, index) => {
      const geometry = ctx.levelGeometry(row, trade, tickSize);
      return { row, index, price: num(row?.price), source: sourceOf(row), geometry, zone: zoneOf(geometry, last ? last.ticks : null) };
    });
  }

  // ------------------------------------------------------------- model grafu
  // opts: { tickSize, full, bars (5|10), heightPx, labelGapPx, labelOf(key),
  //         dist(n, plus), signalOffset, testLabel(state) }
  function tradeMapModel(trade, opts = {}) {
    const tick = opts.tickSize;
    const labelOf = typeof opts.labelOf === 'function' ? opts.labelOf : (k => String(k || ''));
    const dist = typeof opts.dist === 'function' ? opts.dist : tickDistance;
    const heightPx = Number(opts.heightPx) > 0 ? Number(opts.heightPx) : 260;
    const labelGapPx = Number(opts.labelGapPx) > 0 ? Number(opts.labelGapPx) : 13;
    const entry = num(trade?.entryPrice), sl = num(trade?.slPrice), dir = dirOf(trade?.side);
    const targets = targetsOf(trade);
    const last = lastTargetOf(trade, tick);
    const rows = levelRows(trade, tick);

    const lines = [];
    if (entry != null) lines.push({ kind: 'entry', price: entry, name: 'Vstup' });
    if (sl != null) lines.push({ kind: 'sl', price: sl, name: 'SL' });
    for (const t of targets) lines.push({ kind: 'target', n: t.n, price: t.price, name: 'Cíl ' + t.n });
    for (const r of rows) {
      if (r.price == null) continue; // starší řádek bez ceny: jen v seznamu a ve větě
      lines.push({
        kind: 'level', price: r.price, rowIndex: r.index, level: r.row.level, name: labelOf(r.row.level),
        source: r.source, testState: r.row.testState || '', testStateAuto: r.row.testStateAuto === true,
        geometry: r.geometry, zone: r.zone
      });
    }

    // Svíčky ze snímku podle času: −k = svíčka, která skončila k−1 minut před
    // minutou vstupu (FJSnapshot.barEndAt). Chybějící = prázdné místo.
    const snap = trade?.marketSnapshot;
    const barCount = BAR_CHOICES.includes(Number(opts.bars)) ? Number(opts.bars) : DEFAULT_VIEW.bars;
    const candles = [];
    if (snap && Array.isArray(snap.bars1m) && Snapshot()) {
      const byTime = new Map(snap.bars1m.map(b => [b.t, b]));
      const sig = Math.max(-5, Math.min(-1, Math.round(Number(opts.signalOffset ?? trade?.signalBarOffset ?? -1)) || -1));
      for (let o = -barCount; o <= -1; o++) {
        const t = Snapshot().barEndAt(snap, o);
        candles.push({ offset: o, t, bar: t ? byTime.get(t) || null : null, selectable: o >= -5, signal: o === sig });
      }
    }

    // Svislý rozsah: výchozí SL … poslední cíl (+ vstup), s okrajem. Celý
    // rozsah (nebo když SL i cíl chybí) bere všechny hladiny a svíčky.
    const core = [entry, sl, last ? last.price : null, ...targets.map(t => t.price)].filter(p => p != null);
    const levelPrices = lines.filter(l => l.kind === 'level').map(l => l.price);
    const candlePrices = candles.filter(c => c.bar).flatMap(c => [c.bar.h, c.bar.l]).filter(Number.isFinite);
    const useFull = opts.full === true || core.length < 2;
    const pool = useFull ? [...core, ...levelPrices, ...candlePrices] : core;
    let range = null;
    if (pool.length) {
      let min = Math.min(...pool), max = Math.max(...pool);
      const t = Number(tick) > 0 ? Number(tick) : 0;
      const pad = Math.max((max - min) * 0.08, t * 2, max === min ? Math.max(Math.abs(max) * 0.0005, 1e-6) : 0);
      min -= pad; max += pad;
      range = { min, max, full: useFull };
    }
    const inRange = p => range != null && p >= range.min && p <= range.max;
    let hiddenAbove = 0, hiddenBelow = 0;
    for (const l of lines) {
      l.visible = inRange(l.price);
      if (!l.visible && l.kind === 'level') { if (range && l.price > range.max) hiddenAbove++; else hiddenBelow++; }
    }

    // Pásma: jen geometrie, bez štítku role.
    const bands = [];
    if (entry != null && sl != null) bands.push({ kind: 'risk', from: sl, to: entry });
    if (entry != null && last) bands.push({ kind: 'reward', from: entry, to: last.price });

    // Popisky: viditelné čáry shora dolů. Hladiny na stejné ceně nebo tak
    // blízko, že by se popisky kryly (vůči PRVNÍ ceně skupiny – žádné
    // řetězení), mají jeden společný popisek; Vstup / SL / cíl se slučuje jen
    // na stejné ceně. Zbylé popisky se rozloží pod sebe (vodítko k čáře);
    // když se do výšky nevejdou, graf se zvětší (opts.maxHeightPx).
    const visible = lines.map((l, i) => ({ l, i })).filter(x => x.l.visible)
      .sort((a, b) => b.l.price - a.l.price || kindRank(a.l) - kindRank(b.l));
    const groupLabels = H => {
      const yOf = p => (range ? (range.max - p) / (range.max - range.min) * H : 0);
      const out = [];
      for (const { l, i } of visible) {
        const y = yOf(l.price);
        const prev = out[out.length - 1];
        const near = prev && prev.levelsOnly && l.kind === 'level' && y - prev.firstY < labelGapPx;
        if (prev && (prev.price === l.price || near)) {
          prev.lines.push(i); prev.lastY = y; prev.y = (prev.firstY + y) / 2;
          if (l.kind !== 'level') prev.levelsOnly = false;
        } else {
          out.push({ lines: [i], price: l.price, firstY: y, lastY: y, y, levelsOnly: l.kind === 'level' });
        }
      }
      return out;
    };
    let H = heightPx;
    let labels = groupLabels(H);
    const maxH = Number(opts.maxHeightPx) > H ? Number(opts.maxHeightPx) : H;
    const need = labels.length * labelGapPx + 6;
    if (need > H && maxH > H) { H = Math.min(maxH, need); labels = groupLabels(H); }
    // Rozložení: shora dolů s rozestupem, pak zespodu zpět do výšky grafu.
    labels.forEach((lab, k) => { lab.ly = Math.max(lab.y, k ? labels[k - 1].ly + labelGapPx : 0); });
    for (let k = labels.length - 1; k >= 0; k--) {
      const limit = k === labels.length - 1 ? H : labels[k + 1].ly - labelGapPx;
      labels[k].ly = Math.max(0, Math.min(labels[k].ly, limit));
    }
    for (const lab of labels) {
      const ls = lab.lines.map(i => lines[i]);
      const names = ls.map(l => l.name + (l.kind === 'level' && l.testState ? ' ' + testMark(l.testState) : ''));
      const dists = [...new Set(ls.filter(l => l.kind === 'level' && l.geometry?.fromEntry != null).map(l => dist(l.geometry.fromEntry, true)))];
      lab.text = names.join(' + ') + (dists.length ? ' · ' + dists.join(' / ') : '');
      lab.kinds = [...new Set(ls.map(l => l.kind))];
      delete lab.firstY; delete lab.lastY; delete lab.levelsOnly;
    }

    return {
      entry, sl, dir, targets, lastTarget: last ? { n: last.n, price: last.price } : null,
      lines, labels, bands, candles, range, heightPx: H, hiddenAbove, hiddenBelow,
      hasCandles: candles.length > 0
    };
  }
  // Pořadí popisků na stejné ceně: Vstup, SL, cíl, pak hladiny.
  function kindRank(l) { return { entry: 0, sl: 1, target: 2, level: 3 }[l.kind] ?? 4; }
  function testMark(state) { return state === 'TESTED' ? '(test)' : state === 'UNTESTED' ? '(netest)' : ''; }

  // ------------------------------------------------------------ řádek slovy
  // { stopToEntry: [{ name, fromEntry, rowIndex }], toTarget: [...] }, každá
  // skupina od vstupu ven (nejbližší první). Hladina přesně na vstupu patří
  // „mezi SL a vstupem".
  function summaryGroups(trade, opts = {}) {
    const labelOf = typeof opts.labelOf === 'function' ? opts.labelOf : (k => String(k || ''));
    const rows = levelRows(trade, opts.tickSize);
    const pick = zone => rows.filter(r => r.zone === zone)
      .sort((a, b) => Math.abs(a.geometry.fromEntry) - Math.abs(b.geometry.fromEntry))
      .map(r => ({ name: labelOf(r.row.level), fromEntry: r.geometry.fromEntry, rowIndex: r.index }));
    return { stopToEntry: pick('STOP_TO_ENTRY'), toTarget: pick('ENTRY_TO_TARGET'), total: rows.length };
  }

  // „Mezi SL a vstupem: VPOC 30M aktuální (−5 t), LUDVIK (−10 t) · Před cílem:
  // VWAP (+10 t), Gamma L2 (+20 t)". Bez hladin '' (UI pak nic neukáže).
  function summarySentence(trade, opts = {}) {
    const dist = typeof opts.dist === 'function' ? opts.dist : tickDistance;
    const g = summaryGroups(trade, opts);
    if (!g.total) {
      const tax = Taxonomy();
      return tax && tax.nearLevelsNoneOf(trade) ? 'Žádná hladina v blízkosti.' : '';
    }
    const part = list => (list.length ? list.map(x => `${x.name} (${dist(x.fromEntry, true)})`).join(', ') : 'nic');
    return `Mezi SL a vstupem: ${part(g.stopToEntry)} · Před cílem: ${part(g.toTarget)}`;
  }

  // Souhrnný řádek mimo detail obchodu: „Hladiny: 2 mezi SL a vstupem · 2 před cílem".
  function summaryCounts(trade, opts = {}) {
    const g = summaryGroups(trade, opts);
    const tax = Taxonomy();
    if (!g.total) return { stopToEntry: 0, toTarget: 0, total: 0, none: !!(tax && tax.nearLevelsNoneOf(trade)), text: tax && tax.nearLevelsNoneOf(trade) ? 'Hladiny: žádná v blízkosti' : '' };
    // Řádky, jejichž polohu nejde určit (chybí vstup, směr, SL, cíl, tick),
    // se nepočítají jako „0" – řekne se, kolik jich je.
    const unknown = levelRows(trade, opts.tickSize).filter(r => r.zone == null).length;
    return {
      stopToEntry: g.stopToEntry.length, toTarget: g.toTarget.length, total: g.total, unknown, none: false,
      text: `Hladiny: ${g.stopToEntry.length} mezi SL a vstupem · ${g.toTarget.length} před cílem` + (unknown ? ` · ${unknown} bez polohy` : '')
    };
  }

  // --------------------------------------------------------------- žebříček
  // Seznam pod grafem seřazený podle ceny shora dolů, s oddělovači Vstup / SL
  // / Cíl n na svém místě. Hladina na ceně oddělovače stojí na straně úseku,
  // do kterého patří (na vstupu → k SL, na SL → ke vstupu, na cíli → ke
  // vstupu). Řádky bez ceny (starší zápis) jsou na konci.
  // Položky: { kind: 'entry'|'sl'|'target'|'level', price, n?, rowIndex?, row? }
  function ladder(trade, opts = {}) {
    const entry = num(trade?.entryPrice), sl = num(trade?.slPrice), dir = dirOf(trade?.side) || 1;
    const items = [];
    if (entry != null) items.push({ kind: 'entry', price: entry, key: entry });
    if (sl != null) items.push({ kind: 'sl', price: sl, key: sl });
    const targets = targetsOf(trade);
    for (const t of targets) items.push({ kind: 'target', n: t.n, price: t.price, key: t.price });
    // `opts.rows` = řádky přímo z formuláře (rowIndex pak ukazuje do nich).
    const tax = Taxonomy();
    const rows = Array.isArray(opts.rows) ? opts.rows : (tax ? tax.nearLevelsOf(trade) : []);
    const noPrice = [];
    const tiny = 1e-7;
    rows.forEach((row, rowIndex) => {
      const p = num(row?.price);
      if (p == null) { noPrice.push({ kind: 'level', price: null, rowIndex, row }); return; }
      // Posun jen pro řazení: ke straně úseku, kam hladina patří.
      let nudge = 0;
      if (entry != null && p === entry) nudge = -dir;
      else if (sl != null && p === sl) nudge = dir;
      else if (targets.some(t => t.price === p)) nudge = -dir;
      items.push({ kind: 'level', price: p, rowIndex, row, key: p + nudge * tiny * Math.max(1, Math.abs(p)) });
    });
    items.sort((a, b) => b.key - a.key || (a.kind === 'level') - (b.kind === 'level') || (a.rowIndex ?? 0) - (b.rowIndex ?? 0));
    return [...items.map(({ key, ...rest }) => rest), ...noPrice];
  }

  return {
    DEFAULT_VIEW, BAR_CHOICES, SOURCES, normalizeLevelsView, normalizeSourceFilter, sourceOf,
    targetsOf, lastTargetOf, zoneOf, levelRows, tradeMapModel, summaryGroups, summarySentence, summaryCounts, ladder
  };
}));
