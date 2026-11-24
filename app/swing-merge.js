'use strict';
// Slučování swing obchodů, které jsou ve skutečnosti jeden zamýšlený obchod (víc pozic se
// stejným vstupem), i bez skupiny limitek a i u uzavřených obchodů (4.8.105).
//
// - mergeSwingTrades: ruční / automatické sloučení 2+ obchodů do jednoho. Pozice se sjednotí
//   (ctraderPositionIds), výstupy a posuny SL se sjednotí, objem = součet, vstup = průměr
//   vážený objemem, otevření = nejdřívější. Tyto tři hodnoty se vyřadí z importedFields, aby je
//   synchronizace z cTraderu nepřepsala jednou pozicí; ručně se dají dál přepsat ve formuláři.
//   Původní obchody se uloží do `mergedFrom` (rozdělení zpět).
// - splitSwingTrade: rozdělí sloučený obchod zpět a dvojici označí `mergeDeclined`, aby ji
//   automatika znovu nespojila.
// - planAutoMerge: najde shluky obchodů z cTraderu se stejným účtem, symbolem, směrem a
//   vstupní cenou, otevřené do `windowMin` minut od sebe.
//
// Všechno jsou čisté funkce nad kopiemi dat – nic se tu nezapisuje.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const swing = () => (isNode ? require('./swing.js') : root.FJSwing);
  const api = factory(swing);
  if (isNode) module.exports = api;
  if (root) root.FJSwingMerge = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (FJSwing) {

  const DEFAULT_SETTINGS = Object.freeze({ autoMerge: true, windowMin: 5 });
  // Pole, která se při sloučení doplní do cíle, když je v něm prázdno.
  const CONTEXT_FIELDS = ['swingSetup', 'entryReason', 'entryTf', 'htfTrend', 'weeklyCheck', 'entryLevelType', 'grade', 'riskAmount',
    'slInitial', 'targetsPlanned', 'currency', 'ctraderAccountId', 'ctraderAccount', 'contextFilledAt', 'images', 'imagesAfter', 'comment'];
  const OWN_FIELDS = ['entryPrice', 'volume', 'openedAt'];

  function num(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const accountOf = t => {
    const v = t && (t.ctraderAccountId != null && t.ctraderAccountId !== '' ? t.ctraderAccountId : t.ctraderAccount);
    return v == null || v === '' ? null : String(typeof v === 'object' ? (v.login || '') : v) || null;
  };

  function settingsOf(s) {
    const src = (s && s.swingMerge) || {};
    const w = num(src.windowMin);
    return { autoMerge: src.autoMerge !== false, windowMin: w != null && w >= 0 ? w : DEFAULT_SETTINGS.windowMin };
  }

  // Jsou dvě pozice zakázané ke sloučení (uživatel je rozdělil)?
  function declined(a, b) {
    const pa = FJSwing().tradePositionIds(a), pb = FJSwing().tradePositionIds(b);
    const da = a.mergeDeclined || [], db = b.mergeDeclined || [];
    return pb.some(p => da.includes(p)) || pa.some(p => db.includes(p));
  }

  // Ruční i automatické sloučení. Vrací { ok, trades, targetId, removed } nebo { ok:false, block }.
  function mergeSwingTrades(trades, ids, opts = {}) {
    const S = FJSwing();
    const rows = (trades || []).filter(Boolean);
    const picked = [...new Set(ids || [])].map(id => rows.find(t => t.id === id)).filter(t => t && S.isSwingRecord(t));
    if (picked.length < 2) return { ok: false, block: 'count' };
    if (picked.some(t => t.recordType === 'SETUP_ONLY')) return { ok: false, block: 'setup' };
    if (new Set(picked.map(t => S.normalizeSymbol(t.symbol))).size > 1) return { ok: false, block: 'symbol' };
    if (new Set(picked.map(t => t.direction)).size > 1) return { ok: false, block: 'direction' };
    if (new Set(picked.map(accountOf).filter(Boolean)).size > 1) return { ok: false, block: 'account' };
    if (new Set(picked.map(t => t.orderGroupId).filter(Boolean)).size > 1) return { ok: false, block: 'twoGroups' };
    const allPids = picked.flatMap(t => S.tradePositionIds(t));
    if (new Set(allPids).size !== allPids.length) return { ok: false, block: 'samePosition' };
    // cíl: otevřený → se skupinou limitek → nejstarší
    const ms = t => { const v = S.instantOf(t.openedAt); return v == null ? Infinity : v; };
    const sorted = picked.slice().sort((a, b) => ms(a) - ms(b) || String(a.id).localeCompare(String(b.id)));
    const target = sorted.find(t => S.status(t) === 'OPEN') || sorted.find(t => t.orderGroupId) || sorted[0];
    const sources = sorted.filter(t => t !== target);
    const nowIso = opts.nowIso || new Date().toISOString();

    const snapshot = t => { const c = clone(t); delete c.mergedFrom; return c; };
    let t = { ...clone(target) };
    const mergedFrom = [...(target.mergedFrom || [snapshot(target)])];
    for (const s of sources) {
      t = S.mergeTradeContext(t, s, CONTEXT_FIELDS);
      if (s.mergedFrom) mergedFrom.push(...clone(s.mergedFrom)); else mergedFrom.push(snapshot(s));
    }
    // pozice
    const pids = [...new Set(sorted.flatMap(x => S.tradePositionIds(x)))];
    if (pids.length) { t.ctraderPositionIds = pids; if (!t.positionId) t.positionId = pids[0]; }
    // výstupy a posuny SL
    const exits = [...(target.exits || [])].map(clone);
    // různé pozice = různé nohy; vyřadí se jen stejná noha (stejné externalId)
    for (const s of sources) for (const e of s.exits || []) if (!(e.externalId && exits.some(x => x.externalId === e.externalId))) exits.push(clone(e));
    t.exits = exits.sort((a, b) => String(a.closedAt || '').localeCompare(String(b.closedAt || '')));
    const moves = [];
    for (const x of sorted) for (const m of x.slMoves || []) if (!moves.some(y => y.at === m.at && num(y.price) === num(m.price))) moves.push(clone(m));
    t.slMoves = moves.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    // vstup, objem, otevření – ze všech původních (i z dřívějších sloučení)
    const parts = mergedFrom;
    let vol = 0, w = 0, wp = 0, volOk = true;
    for (const p of parts) {
      const v = num(p.volume), e = num(p.entryPrice);
      if (v == null) volOk = false; else vol += v;
      if (v != null && v > 0 && e != null) { w += v; wp += v * e; }
    }
    if (volOk) t.volume = round(vol, 8);
    if (w > 0) t.entryPrice = round(wp / w, 8);
    const first = parts.filter(p => S.instantOf(p.openedAt) != null).sort((a, b) => S.instantOf(a.openedAt) - S.instantOf(b.openedAt))[0];
    if (first) t.openedAt = first.openedAt;
    delete t.volumeFromLegs;
    delete t.volumeUnits;
    // objem neupravený ručně u žádné části: po uzavření všech pozic = součet výstupů (planMcpSync)
    const volImported = !t.orderGroupId && parts.every(p => (p.importedFields || []).includes('volume'));
    t.importedFields = (t.importedFields || []).filter(f => !OWN_FIELDS.includes(f));
    if (volImported) t.importedFields.push('volume');
    t.mergedFrom = mergedFrom;
    t.mergedAt = nowIso;
    if (opts.auto) t.mergedAuto = true; else delete t.mergedAuto;
    t.date = S.swingListDate(t);
    t.updatedAt = nowIso;
    const gone = new Set(sources.map(s => s.id));
    const out = (trades || []).map(x => (x && x.id === target.id ? t : x)).filter(x => !(x && gone.has(x.id)));
    return { ok: true, trades: out, targetId: target.id, removed: [...gone] };
  }

  // Rozdělí sloučený obchod zpět na původní obchody. Výstupy přidané po sloučení jdou k obchodu
  // své pozice (podle externalId z MCP), jinak k prvnímu. Dvojice se označí mergeDeclined.
  function splitSwingTrade(trades, id, opts = {}) {
    const S = FJSwing();
    const rows = trades || [];
    const t = rows.find(x => x && x.id === id);
    if (!t || !Array.isArray(t.mergedFrom) || t.mergedFrom.length < 2) return { ok: false, block: 'notMerged' };
    const nowIso = opts.nowIso || new Date().toISOString();
    const parts = t.mergedFrom.map(clone);
    const allPids = [...new Set(parts.flatMap(p => S.tradePositionIds(p)))];
    for (const e of t.exits || []) {
      if (parts.some(p => (p.exits || []).some(x => S.sameLeg(x, e)))) continue;
      const m = /^mcp:([^:]+):/.exec(String(e.externalId || ''));
      const owner = (m && parts.find(p => S.tradePositionIds(p).includes('ctrader-' + m[1]))) || parts[0];
      owner.exits = [...(owner.exits || []), clone(e)];
    }
    const restored = parts.map(p => {
      const own = S.tradePositionIds(p);
      const others = allPids.filter(x => !own.includes(x));
      const r = { ...p, mergeDeclined: [...new Set([...(p.mergeDeclined || []), ...(t.mergeDeclined || []).filter(x => !own.includes(x)), ...others])], updatedAt: nowIso };
      r.exits = (r.exits || []).sort((a, b) => String(a.closedAt || '').localeCompare(String(b.closedAt || '')));
      r.date = S.swingListDate(r);
      return r;
    });
    // původní id nesmí kolidovat s ostatními obchody
    const taken = new Set(rows.filter(x => x && x.id !== id).map(x => x.id));
    for (const r of restored) { while (taken.has(r.id)) r.id += '_r'; taken.add(r.id); }
    const out = [];
    for (const x of rows) { if (x && x.id === id) out.push(...restored); else out.push(x); }
    return { ok: true, trades: out, ids: restored.map(r => r.id) };
  }

  // Shluky obchodů ke sloučení (pole polí id). Jen obchody z cTraderu (mají pozici), stejný
  // účet / symbol / směr / vstupní cena (po desetinných místech instrumentu), otevření do
  // windowMin minut od sebe (tranzitivně), nanejvýš jedna skupina limitek, ne rozdělené uživatelem.
  function planAutoMerge(trades, opts = {}) {
    const S = FJSwing();
    const windowMs = (num(opts.windowMin) != null ? num(opts.windowMin) : DEFAULT_SETTINGS.windowMin) * 60000;
    const decimalsOf = typeof opts.decimalsOf === 'function' ? opts.decimalsOf : () => null;
    const priceKey = (v, sym) => { const d = num(decimalsOf(sym)); const n = num(v); return n == null ? null : (d != null ? n.toFixed(d) : String(round(n, 8))); };
    const cand = (trades || []).filter(t => t && S.isSwingRecord(t) && t.recordType !== 'SETUP_ONLY'
      && S.tradePositionIds(t).length && S.instantOf(t.openedAt) != null && num(t.entryPrice) != null);
    const buckets = new Map();
    for (const t of cand) {
      const sym = S.normalizeSymbol(t.symbol);
      const k = [accountOf(t) || '', sym, t.direction, priceKey(t.entryPrice, sym)].join('|');
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(t);
    }
    const out = [];
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => S.instantOf(a.openedAt) - S.instantOf(b.openedAt) || String(a.id).localeCompare(String(b.id)));
      let cur = [list[0]];
      const flush = () => {
        // rozdělené dvojice a dvě různé skupiny limitek: shluk se rozpadne na části, kde nic nekoliduje
        let part = [];
        for (const t of cur) {
          const clash = part.some(p => declined(p, t) || (p.orderGroupId && t.orderGroupId && p.orderGroupId !== t.orderGroupId));
          if (clash) { if (part.length > 1) out.push(part.map(x => x.id)); part = [t]; } else part.push(t);
        }
        if (part.length > 1) out.push(part.map(x => x.id));
      };
      for (let i = 1; i < list.length; i++) {
        const prev = cur[cur.length - 1];
        if (S.instantOf(list[i].openedAt) - S.instantOf(prev.openedAt) <= windowMs) cur.push(list[i]);
        else { flush(); cur = [list[i]]; }
      }
      flush();
    }
    return out;
  }

  // Automatické sloučení nad celým seznamem obchodů (opakovaně, dokud něco přibývá).
  function applyAutoMerge(trades, opts = {}) {
    let rows = trades || [];
    let merged = 0;
    for (let pass = 0; pass < 10; pass++) {
      const clusters = planAutoMerge(rows, opts);
      let now = 0;
      for (const ids of clusters) {
        const r = mergeSwingTrades(rows, ids, { ...opts, auto: true });
        if (!r.ok) continue;
        rows = r.trades; merged += r.removed.length; now++;
      }
      if (!now) break;
    }
    return { trades: rows, merged, changed: merged > 0 };
  }

  return { DEFAULT_SETTINGS, CONTEXT_FIELDS, settingsOf, mergeSwingTrades, splitSwingTrade, planAutoMerge, applyAutoMerge, declined };
}));
