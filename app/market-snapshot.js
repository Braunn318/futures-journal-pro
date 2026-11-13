'use strict';
// Data trhu – snímek trhu při vstupu (J3).
//
// Konektor NT8 (verze 6) při vstupu spočítá z ticků seance: posledních 25
// uzavřených 1min svíček (OHLCV, VPOC, delta – tick rule se směrem přes celou
// seanci), uzavřené 30min svíčky (VPOC, jestli se ho cena po uzavření svíčky
// dotkla), profil dne do vstupu, high / low a VWAP. Tady jsou čisté funkce:
// kontrola zprávy, value area, signální svíčka, řádky Hladin ze snímku
// a test / netest ze svíček dne.
//
// Deník MĚŘÍ, nehodnotí: žádná tolerance ani pásmo. „AT" = přesná shoda ceny.
// Dopočty signální svíčky se neukládají – počítají se při čtení.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJSnapshot = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const VERSION = 1;
  const BARS_1M = 25;
  const DEFAULT_VA_PCT = 70;

  const num = v => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN));
  const price = v => { const n = num(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const iso = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
  const priceList = v => (Array.isArray(v) ? v : (v == null ? [] : [v])).map(price).filter(x => x != null);

  // Value area z profilu [[cena, objem]]: VPOC = cena s největším objemem (při
  // shodě ta blíž středu rozsahu), pak se přidává po jedné ceně na stranu
  // s větším objemem, dokud oblast nemá `pct` % objemu. Prázdný profil = null.
  function valueArea(profile, pct = DEFAULT_VA_PCT) {
    const levels = (Array.isArray(profile) ? profile : [])
      .map(r => [price(Array.isArray(r) ? r[0] : r?.p), num(Array.isArray(r) ? r[1] : r?.v)])
      .filter(([p, v]) => p != null && Number.isFinite(v) && v >= 0);
    if (!levels.length) return null;
    const byPrice = new Map();
    for (const [p, v] of levels) byPrice.set(p, (byPrice.get(p) || 0) + v);
    const list = [...byPrice.entries()].sort((a, b) => a[0] - b[0]);
    const total = list.reduce((s, [, v]) => s + v, 0);
    const mid = (list.length - 1) / 2;
    let idx = 0;
    for (let i = 1; i < list.length; i++) {
      if (list[i][1] > list[idx][1] || (list[i][1] === list[idx][1] && Math.abs(i - mid) < Math.abs(idx - mid))) idx = i;
    }
    let lo = idx, hi = idx, sum = list[idx][1];
    const target = total * Math.min(100, Math.max(1, Number(pct) || DEFAULT_VA_PCT)) / 100;
    while (sum < target) {
      const up = hi + 1 < list.length ? list[hi + 1][1] : -1;
      const down = lo > 0 ? list[lo - 1][1] : -1;
      if (up < 0 && down < 0) break;
      if (up >= down) { hi++; sum += up; } else { lo--; sum += down; }
    }
    return { vpoc: list[idx][0], vah: list[hi][0], val: list[lo][0] };
  }

  // Zpráva market_snapshot z konektoru → snímek pro obchod, nebo { ok:false }.
  // Profil dne se do obchodu neukládá – jen VPOC / VAH / VAL z něj.
  function normalizeSnapshotPayload(p, pct = DEFAULT_VA_PCT) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'invalid' };
    if (p.error) return { ok: false, error: String(p.error).slice(0, 200) };
    const time = iso(p.time);
    if (!time || !p.executionId) return { ok: false, error: 'invalid' };
    const entry = Date.parse(time);
    const bars1m = [];
    for (const b of Array.isArray(p.bars1m) ? p.bars1m : []) {
      const [t, o, h, l, c, v, d, vp] = Array.isArray(b) ? b : [b?.t, b?.o, b?.h, b?.l, b?.c, b?.v, b?.delta, b?.vpoc];
      const bar = { t: iso(t), o: price(o), h: price(h), l: price(l), c: price(c), v: num(v), delta: Number.isFinite(num(d)) ? num(d) : null, vpoc: priceList(vp) };
      // Jen uzavřené svíčky před vstupem (konec svíčky <= vstup).
      if (!bar.t || Date.parse(bar.t) > entry || [bar.o, bar.h, bar.l, bar.c].includes(null) || !Number.isFinite(bar.v)) continue;
      bars1m.push(bar);
    }
    bars1m.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const bars30m = [];
    for (const b of Array.isArray(p.bars30m) ? p.bars30m : []) {
      const [t, o, h, l, c, v, vp, tested] = Array.isArray(b) ? b : [b?.t, b?.o, b?.h, b?.l, b?.c, b?.v, b?.vpoc, b?.vpocTested];
      const vpoc = priceList(vp);
      const testedList = (Array.isArray(tested) ? tested : [tested]).map(x => x === true);
      const bar = { t: iso(t), o: price(o), h: price(h), l: price(l), c: price(c), v: num(v), vpoc, vpocTested: vpoc.map((_, i) => testedList[i] === true) };
      if (!bar.t || Date.parse(bar.t) > entry || [bar.o, bar.h, bar.l, bar.c].includes(null) || !Number.isFinite(bar.v)) continue;
      bars30m.push(bar);
    }
    bars30m.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const va = valueArea(p.day?.profile, pct);
    const snapshot = {
      v: VERSION,
      source: 'ninjatrader',
      executionId: String(p.executionId),
      instrumentFull: String(p.instrumentFull || ''),
      time,
      tradingHours: String(p.tradingHours || ''),
      timeZone: String(p.timeZone || ''),
      valueAreaPct: Number(pct) || DEFAULT_VA_PCT,
      bars1m: bars1m.slice(-BARS_1M),
      bars30m,
      day: { vpoc: va?.vpoc ?? null, vah: va?.vah ?? null, val: va?.val ?? null, high: price(p.day?.high), low: price(p.day?.low), vwap: price(p.day?.vwap) },
      prevDay: null
    };
    return { ok: true, snapshot };
  }

  function median(values) {
    const s = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Signální svíčka: offset −1 = poslední uzavřená svíčka před vstupem, až −5.
  // Zavření vůči vlastnímu VPOC: ABOVE / AT (přesná shoda) / BELOW; víc VPOC
  // se stejným objemem a zavření mezi nimi = null. Objem vůči mediánu 20
  // předchozích svíček (null, když jich snímek tolik nemá).
  function signalBar(snapshot, offset = -1) {
    const bars = Array.isArray(snapshot?.bars1m) ? snapshot.bars1m : [];
    const off = Math.max(-5, Math.min(-1, Math.round(Number(offset)) || -1));
    const idx = bars.length + off;
    if (idx < 0) return null;
    const bar = bars[idx];
    const vpocs = Array.isArray(bar.vpoc) ? bar.vpoc : [];
    let closeVsVpoc = null;
    if (vpocs.length) {
      if (vpocs.includes(bar.c)) closeVsVpoc = 'AT';
      else if (vpocs.every(v => bar.c > v)) closeVsVpoc = 'ABOVE';
      else if (vpocs.every(v => bar.c < v)) closeVsVpoc = 'BELOW';
    }
    let volumeVsMedian20 = null;
    if (idx >= 20) {
      const m = median(bars.slice(idx - 20, idx).map(b => b.v));
      if (m > 0) volumeVsMedian20 = bar.v / m;
    }
    return { offset: off, bar, closeVsVpoc, volumeVsMedian20 };
  }

  // Ruční štítek „Uzavření vůči VPOC v pořádku" (OF_CONFIRM CLOSE_VS_VPOC_OK)
  // má přednost – tady se jen zjistí, jestli mu dopočet odporuje
  // (long a zavření POD VPOC, short a zavření NAD VPOC).
  function vpocTagMismatch(trade, sig) {
    const tag = Array.isArray(trade?.ofConfirm) && trade.ofConfirm.includes('CLOSE_VS_VPOC_OK');
    if (!tag || !sig?.closeVsVpoc || sig.closeVsVpoc === 'AT') return false;
    const side = String(trade?.side || '').toLowerCase();
    return (side === 'long' && sig.closeVsVpoc === 'BELOW') || (side === 'short' && sig.closeVsVpoc === 'ABOVE');
  }

  // Typy řádků Hladin ze snímku. `level` = klíč číselníku (Hladina vstupu),
  // `group` = kdy jsou data: DAY hned se snímkem, PREV až s předchozím dnem.
  const LEVEL_TYPES = Object.freeze([
    { key: 'VPOC_30M_UNTESTED', level: 'VPOC_30M', group: 'DAY', label: 'Netestovaný VPOC 30m' },
    { key: 'DAY_VPOC', level: 'VPOC_DAY', group: 'DAY', label: 'VPOC dne' },
    { key: 'DAY_VAH', level: 'VAH', group: 'DAY', label: 'VAH dne' },
    { key: 'DAY_VAL', level: 'VAL', group: 'DAY', label: 'VAL dne' },
    { key: 'SESSION_HIGH', level: 'HOD_LOD', group: 'DAY', label: 'High seance' },
    { key: 'SESSION_LOW', level: 'HOD_LOD', group: 'DAY', label: 'Low seance' },
    { key: 'PREV_VPOC', level: 'VPOC_PREV_DAY', group: 'PREV', label: 'Včerejší VPOC' },
    { key: 'PREV_VAH', level: 'VAH_PREV', group: 'PREV', label: 'Včerejší VAH' },
    { key: 'PREV_VAL', level: 'VAL_PREV', group: 'PREV', label: 'Včerejší VAL' },
    { key: 'PREV_HIGH', level: 'PDH_PDL', group: 'PREV', label: 'Včerejší high' },
    { key: 'PREV_LOW', level: 'PDH_PDL', group: 'PREV', label: 'Včerejší low' }
  ]);

  function snapshotLevelCandidates(snapshot, types = {}) {
    if (!snapshot) return [];
    const on = key => types[key] !== false;
    const out = [];
    const add = (key, p) => { const pr = price(p); if (on(key) && pr != null) out.push({ type: key, level: LEVEL_TYPES.find(t => t.key === key).level, price: pr }); };
    for (const b of snapshot.bars30m || []) (b.vpoc || []).forEach((v, i) => { if (!b.vpocTested?.[i]) add('VPOC_30M_UNTESTED', v); });
    const d = snapshot.day || {};
    add('DAY_VPOC', d.vpoc); add('DAY_VAH', d.vah); add('DAY_VAL', d.val); add('SESSION_HIGH', d.high); add('SESSION_LOW', d.low);
    const p = snapshot.prevDay;
    if (p) { add('PREV_VPOC', p.vpoc); add('PREV_VAH', p.vah); add('PREV_VAL', p.val); add('PREV_HIGH', p.high); add('PREV_LOW', p.low); }
    return out;
  }

  // N nejbližších nad a N pod vstupem (stejné pravidlo jako u LTA), bez
  // skrytých voleb a bez toho, co už v Hladinách je (typ + cena). Ruční
  // řádky se nikdy nemění – vracejí se jen nové řádky.
  function snapshotRows(existing, candidates, entryPrice, n = 3, isHidden = () => false) {
    const entry = price(entryPrice);
    const count = Math.max(0, Math.round(Number(n)) || 0);
    if (entry == null || !count) return [];
    const seen = new Set((existing || []).map(r => r?.level + '|' + Number(r?.price)));
    const uniq = new Map();
    for (const c of candidates || []) {
      const sig = c.level + '|' + c.price;
      if (isHidden(c.level) || seen.has(sig) || uniq.has(sig)) continue;
      uniq.set(sig, { level: c.level, price: c.price, source: 'snapshot' });
    }
    const rows = [...uniq.values()];
    const above = rows.filter(r => r.price >= entry).sort((a, b) => a.price - b.price).slice(0, count);
    const below = rows.filter(r => r.price < entry).sort((a, b) => b.price - a.price).slice(0, count);
    return [...above.reverse(), ...below];
  }

  // Test / netest ze svíček dne: jen u řádků s cenou, kde ho nikdo nevyplnil.
  // Dotek = některá svíčka, která skončila nejpozději při vstupu, měla cenu
  // hladiny v rozsahu low–high. Bez svíček před vstupem se nic nedoplní.
  function autoTestStates(rows, bars, entryIso) {
    const entry = Date.parse(entryIso);
    const before = (Array.isArray(bars) ? bars : []).filter(b => Date.parse(b?.t) <= entry && price(b?.h) != null && price(b?.l) != null);
    let changed = 0;
    const out = (Array.isArray(rows) ? rows : []).map(r => {
      if (!before.length || !Number.isFinite(entry) || r?.testState || price(r?.price) == null) return r;
      const p = price(r.price);
      const touched = before.some(b => b.l <= p && p <= b.h);
      changed++;
      return { ...r, testState: touched ? 'TESTED' : 'UNTESTED', testStateAuto: true };
    });
    return { rows: out, changed };
  }

  // Předchozí den ze souboru svíček dne (J2, s profilem): VPOC / VAH / VAL
  // z profilu, high / low ze svíček. Soubor bez profilu dá jen high / low.
  function prevDayFromFile(file, pct = DEFAULT_VA_PCT) {
    if (!file || !Array.isArray(file.bars) || !file.bars.length) return null;
    const va = valueArea(file.profile, pct);
    const highs = file.bars.map(b => price(b.h)).filter(x => x != null);
    const lows = file.bars.map(b => price(b.l)).filter(x => x != null);
    return { day: String(file.day || ''), vpoc: va?.vpoc ?? null, vah: va?.vah ?? null, val: va?.val ?? null, high: highs.length ? Math.max(...highs) : null, low: lows.length ? Math.min(...lows) : null };
  }

  // Čas vstupu obchodu: přesný ze snímku, jinak z data a času formuláře.
  function entryIsoOf(trade) {
    if (trade?.marketSnapshot?.time) return trade.marketSnapshot.time;
    if (!trade?.date) return null;
    const d = new Date(`${trade.date}T${trade.entryTime || '12:00'}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Průchod daty trhu u jednoho obchodu (nový objekt, `changed` = co se změnilo):
  //  - prevDay ze souboru předchozího dne (jen úplný den),
  //  - řádky Hladin ze snímku (každá skupina jen jednou – smazaný řádek se nevrací),
  //  - test / netest ze svíček dne.
  // `opts`: { levels, autoTest, types, n, isHidden, dayFile, prevFile, prevComplete, pct }
  function applyMarketData(trade, opts = {}) {
    if (!trade || typeof trade !== 'object') return { trade, changed: [] };
    const next = { ...trade };
    const changed = [];
    const snap = trade.marketSnapshot;
    if (snap && !snap.prevDay && opts.prevFile && opts.prevComplete) {
      const prev = prevDayFromFile(opts.prevFile, snap.valueAreaPct || opts.pct);
      if (prev) { next.marketSnapshot = { ...snap, prevDay: prev }; changed.push('prevDay'); }
    }
    const hasRows = Array.isArray(next.nearLevels);
    let rows = hasRows ? next.nearLevels.slice() : [];
    if (opts.levels && next.marketSnapshot && next.nearLevelsNone !== true) {
      const applied = new Set(Array.isArray(next.marketLevelsApplied) ? next.marketLevelsApplied : []);
      const groups = ['DAY', ...(next.marketSnapshot.prevDay ? ['PREV'] : [])].filter(g => !applied.has(g));
      if (groups.length) {
        // N nejbližších se vybírá ze VŠECH typů (i z dřív doplněné skupiny),
        // doplní se jen ty z nových skupin – včerejšek, který dorazí později,
        // tak nepřidá řádky nad limit N.
        const cands = snapshotLevelCandidates(next.marketSnapshot, opts.types || {});
        const groupOf = new Map(LEVEL_TYPES.map(t => [t.key, t.group]));
        const fresh = new Set(cands.filter(c => groups.includes(groupOf.get(c.type))).map(c => c.level + '|' + c.price));
        const seen = new Set(rows.map(r => r?.level + '|' + Number(r?.price)));
        const add = snapshotRows([], cands, next.entryPrice, opts.n ?? 3, opts.isHidden || (() => false))
          .filter(r => fresh.has(r.level + '|' + r.price) && !seen.has(r.level + '|' + r.price));
        if (add.length) { rows = rows.concat(add); changed.push('levels'); }
        next.marketLevelsApplied = [...applied, ...groups];
        if (!changed.includes('levels')) changed.push('levelsApplied');
      }
    }
    if (opts.autoTest && opts.dayFile) {
      const r = autoTestStates(rows, opts.dayFile.bars, entryIsoOf(next));
      if (r.changed) { rows = r.rows; changed.push('testState'); }
    }
    if (changed.includes('levels') || changed.includes('testState')) next.nearLevels = rows;
    return { trade: changed.length ? next : trade, changed };
  }

  return {
    VERSION, BARS_1M, DEFAULT_VA_PCT, LEVEL_TYPES,
    valueArea, normalizeSnapshotPayload, signalBar, vpocTagMismatch,
    snapshotLevelCandidates, snapshotRows, autoTestStates, prevDayFromFile, entryIsoOf, applyMarketData
  };
}));
