'use strict';
// Plánovaný obchod = skupina čekajících příkazů (docs/ZADANI_SWING_SLUCOVANI_PRIKAZU.md).
//
// Jedna skupina = jeden zamýšlený swing obchod = jedna nebo víc limitek se stejným
// účtem, symbolem, směrem, typem, cenou vstupu a SL (TP, objem a čas se liší smí –
// jsou to části pozice). Konzervativně: při jakékoli neshodě se automaticky neslučuje.
//
// Skupiny leží v deníku (top-level `orderGroups`). Ruční limitky dál žijí v
// `pendingOrders` (tam se upravují), skupina drží jejich snímek; limitky z cTraderu
// (MCP, jen čtení) existují jen jako snímek ve skupině. Synchronizace mění jen
// snímky členů a přidává nové příkazy – nikdy nepřesouvá členy mezi skupinami a
// nikdy nečte ani nepíše kontext. Ruční rozhodnutí (sloučit / rozdělit) nese
// `groupManual` a automatika na takovou skupinu nesahá.
//
// Všechno jsou čisté funkce nad kopiemi dat – nic se tu nezapisuje.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const api = factory();
  if (isNode) module.exports = api;
  if (root) root.FJOrderGroups = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const ORDER_GROUPS_VERSION = 1;
  const SEEN_REFRESH_MS = 15 * 60000; // lastSeenAt se přepisuje nejvýš jednou za 15 min (méně zápisů)
  // Kontext před vstupem (§3) – stejná pole jako u swing obchodu, stejné názvy.
  const CONTEXT_FIELDS = ['swingSetup', 'entryReason', 'entryTf', 'htfTrend', 'weeklyCheck', 'entryLevelType', 'grade', 'riskAmount', 'images', 'comment'];

  function num(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const sym = s => String(s || '').trim().toUpperCase();
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function priceKey(v, decimals) {
    const n = num(v);
    if (n == null) return '-';
    return round(n, decimals != null ? decimals : 8).toFixed(decimals != null ? decimals : 8);
  }
  // Klíč automatického seskupení (§2.1). Ruční limitka nemá účet (null), cTrader = login.
  function groupKeyOf(o, decimals) {
    return [o.account == null ? '' : String(o.account), sym(o.symbol), o.direction === 'short' ? 'short' : 'long',
      o.orderType === 'STOP' ? 'STOP' : 'LIMIT', priceKey(o.price, decimals), priceKey(o.sl, decimals)].join('|');
  }
  function decimalsFor(opts, symbol) {
    const d = opts && typeof opts.decimalsOf === 'function' ? opts.decimalsOf(sym(symbol)) : null;
    return Number.isInteger(d) && d >= 0 ? d : null;
  }
  function newId(opts) {
    return opts && typeof opts.idGen === 'function' ? opts.idGen() : 'og_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  const SNAPSHOT_KEYS = ['source', 'externalId', 'price', 'sl', 'tp', 'volume', 'volumeInUnits', 'expiresAt', 'note'];
  function memberFromOrder(o, nowIso) {
    return {
      orderId: String(o.id), source: o.source === 'CTRADER' ? 'CTRADER' : 'MANUAL', externalId: o.externalId != null ? String(o.externalId) : null,
      price: num(o.price), sl: num(o.sl), tp: num(o.tp), volume: num(o.volume), volumeInUnits: num(o.volumeInUnits),
      placedAt: o.placedAt || null, ...(o.placedAt ? {} : { placedAtApprox: true }),
      expiresAt: o.expiresAt || null, note: String(o.note || ''),
      firstSeenAt: nowIso, lastSeenAt: nowIso, state: 'PENDING'
    };
  }
  function groupFromOrder(o, opts) {
    const g = {
      id: newId(opts), account: o.account == null ? null : String(o.account), symbol: sym(o.symbol),
      direction: o.direction === 'short' ? 'short' : 'long', orderType: o.orderType === 'STOP' ? 'STOP' : 'LIMIT',
      price: num(o.price), sl: num(o.sl), groupManual: false, members: [],
      context: {}, contextFilledAt: null, tradeId: null, resolution: null,
      createdAt: opts.nowIso, updatedAt: opts.nowIso
    };
    return g;
  }
  const hasFill = g => (g.members || []).some(m => m.state === 'FILLED');
  // Do skupiny smí automatika přidat příkaz, jen dokud se o ní nic nerozhodlo.
  function isOpenGroup(g) {
    return !!g && !g.tradeId && !g.resolution && !hasFill(g);
  }
  function contextFilled(g) {
    const c = (g && g.context) || {};
    return !!(g && g.contextFilledAt) && CONTEXT_FIELDS.some(k => {
      const v = c[k];
      return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== '';
    });
  }
  // Členové od TP nejbližšího k ceně vstupu (TP1, TP2 …); bez TP na konci.
  function sortMembers(g) {
    const p = num(g.price);
    const dist = m => (num(m.tp) == null || p == null ? Infinity : Math.abs(num(m.tp) - p));
    return [...(g.members || [])].sort((a, b) => dist(a) - dist(b) || String(a.firstSeenAt || '').localeCompare(String(b.firstSeenAt || '')) || String(a.orderId).localeCompare(String(b.orderId)));
  }

  // Synchronizace skupin s aktuálními příkazy. `liveOrders` = ruční (pendingOrders) +
  // cTrader (MCP); `opts.sources` = zdroje, které jsou teď opravdu načtené (cTrader
  // neodpovídá → jeho členy nijak neměnit). `opts.account` = login účtu deníku pro
  // cTrader příkazy. Idempotentní: stejný vstup podruhé → changed:false.
  function planOrderGroups(groups, liveOrders, opts = {}) {
    const o = { nowIso: new Date().toISOString(), sources: ['MANUAL', 'CTRADER'], ...opts };
    const nowMs = Date.parse(o.nowIso);
    const sources = new Set(o.sources);
    const out = (groups || []).map(clone);
    let changed = false, created = 0, added = 0;
    const memberIndex = new Map();
    out.forEach(g => (g.members || []).forEach(m => memberIndex.set(m.orderId, { g, m })));
    const liveIds = new Set();
    for (const raw of liveOrders || []) {
      if (!raw || !raw.id || !raw.symbol) continue;
      const src = raw.source === 'CTRADER' ? 'CTRADER' : 'MANUAL';
      if (!sources.has(src)) continue;
      const order = { ...raw, source: src, account: src === 'CTRADER' ? (o.account != null ? String(o.account) : null) : null };
      liveIds.add(String(order.id));
      const hit = memberIndex.get(String(order.id));
      if (hit) {
        const { g, m } = hit;
        const snap = memberFromOrder(order, o.nowIso);
        for (const k of SNAPSHOT_KEYS) {
          if (JSON.stringify(m[k] ?? null) !== JSON.stringify(snap[k] ?? null)) { m[k] = snap[k]; changed = true; }
        }
        if (order.placedAt && m.placedAt !== order.placedAt) { m.placedAt = order.placedAt; delete m.placedAtApprox; changed = true; }
        if (m.state !== 'PENDING' && m.state !== 'FILLED') { m.state = 'PENDING'; delete m.goneAt; changed = true; }
        const seen = Date.parse(m.lastSeenAt || '');
        if (!Number.isFinite(seen) || nowMs - seen >= SEEN_REFRESH_MS) { m.lastSeenAt = o.nowIso; changed = true; }
        if (changed) g.updatedAt = o.nowIso;
        continue;
      }
      const d = decimalsFor(o, order.symbol);
      const key = groupKeyOf(order, d);
      let g = out.find(x => isOpenGroup(x) && !x.groupManual && groupKeyOf(x, d) === key);
      if (!g) { g = groupFromOrder(order, o); out.push(g); created++; }
      const m = memberFromOrder(order, o.nowIso);
      g.members.push(m);
      g.updatedAt = o.nowIso;
      memberIndex.set(m.orderId, { g, m });
      added++; changed = true;
    }
    // Zmizelé příkazy načtených zdrojů. cTrader limitka může být naplněná – to rozhodne
    // párování na pozici (linkFills); tady jen „už ji nevidím“.
    for (const g of out) {
      for (const m of g.members || []) {
        if (m.state !== 'PENDING' || !sources.has(m.source) || liveIds.has(m.orderId)) continue;
        m.state = 'GONE'; m.goneAt = o.nowIso; g.updatedAt = o.nowIso; changed = true;
      }
    }
    return { groups: out, changed, created, added };
  }

  function groupView(g) {
    const members = sortMembers(g);
    const vols = members.map(m => num(m.volume));
    const total = vols.every(v => v != null) ? round(vols.reduce((s, v) => s + v, 0), 8) : null;
    const counts = { PENDING: 0, FILLED: 0, GONE: 0 };
    members.forEach(m => { counts[m.state] = (counts[m.state] || 0) + 1; });
    let status = 'PENDING';
    if (g.resolution === 'NO_FILL') status = 'NO_FILL';
    else if (g.resolution === 'DISMISSED') status = 'DISMISSED';
    else if (counts.FILLED || g.tradeId) status = counts.PENDING ? 'PARTIAL' : 'FILLED';
    else if (!counts.PENDING) status = 'GONE';
    const price = num(g.price), sl = num(g.sl);
    return {
      members, count: members.length, tps: members.map(m => num(m.tp)).filter(v => v != null),
      volumes: vols, totalVolume: total,
      sources: [...new Set(members.map(m => m.source))],
      pending: counts.PENDING, filled: counts.FILLED, gone: counts.GONE, status,
      priceMismatch: members.some(m => num(m.price) !== price), slMismatch: members.some(m => num(m.sl) !== sl),
      placedAt: members.map(m => m.placedAt).filter(Boolean).sort()[0] || null,
      expiresAt: members.map(m => m.expiresAt).filter(Boolean).sort()[0] || null,
      contextFilled: contextFilled(g)
    };
  }

  // Ruční sloučení (§2.2). block = nejde (account / symbol / direction / filled / context / count),
  // warn = jde po potvrzení v aplikaci (price / sl / orderType).
  function canMerge(list) {
    const gs = (list || []).filter(Boolean);
    if (gs.length < 2) return { ok: false, block: 'count', warn: [] };
    const first = gs[0];
    for (const k of ['account', 'symbol', 'direction']) {
      if (gs.some(g => String(g[k] ?? '') !== String(first[k] ?? ''))) return { ok: false, block: k, warn: [] };
    }
    if (gs.some(g => !isOpenGroup(g))) return { ok: false, block: 'filled', warn: [] };
    if (gs.filter(contextFilled).length > 1) return { ok: false, block: 'context', warn: [] };
    const warn = [];
    const prices = new Set(gs.flatMap(g => [num(g.price), ...(g.members || []).map(m => num(m.price))]).map(String));
    const sls = new Set(gs.flatMap(g => [num(g.sl), ...(g.members || []).map(m => num(m.sl))]).map(String));
    if (prices.size > 1) warn.push('price');
    if (sls.size > 1) warn.push('sl');
    if (new Set(gs.map(g => g.orderType)).size > 1) warn.push('orderType');
    return { ok: true, block: null, warn };
  }
  // Sloučí skupiny `ids` do jedné. Cílem je skupina s kontextem, jinak nejstarší.
  function mergeGroups(groups, ids, opts = {}) {
    const nowIso = opts.nowIso || new Date().toISOString();
    const out = (groups || []).map(clone);
    const picked = out.filter(g => (ids || []).includes(g.id));
    const chk = canMerge(picked);
    if (!chk.ok) throw new Error('Skupiny nejde sloučit: ' + chk.block);
    const target = picked.find(contextFilled) || [...picked].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
    for (const g of picked) if (g !== target) target.members.push(...g.members);
    target.groupManual = true;
    target.updatedAt = nowIso;
    const drop = new Set(picked.filter(g => g !== target).map(g => g.id));
    return { groups: out.filter(g => !drop.has(g.id)), targetId: target.id, warn: chk.warn };
  }
  // Rozdělí skupinu na jednu skupinu za každý příkaz. Všechny dostanou groupManual
  // (automatika je znovu nesloučí); kontext zůstane u skupiny s nejbližším TP.
  function splitGroup(groups, id, opts = {}) {
    const nowIso = opts.nowIso || new Date().toISOString();
    const out = (groups || []).map(clone);
    const i = out.findIndex(g => g.id === id);
    if (i < 0) throw new Error('Skupina neexistuje.');
    const g = out[i];
    if (!isOpenGroup(g)) throw new Error('Skupinu s naplněním nejde rozdělit.');
    const members = sortMembers(g);
    if (members.length < 2) return { groups: out, ids: [g.id] };
    const parts = members.map((m, j) => {
      const first = j === 0;
      const p = first ? { ...g } : {
        ...g, id: newId(opts), context: {}, contextFilledAt: null, createdAt: nowIso
      };
      if (!first) { delete p.contextEditedAfterFill; delete p.contextUpdatedAt; }
      return { ...p, members: [m], groupManual: true, price: num(m.price) ?? g.price, sl: m.sl === undefined ? g.sl : num(m.sl), updatedAt: nowIso };
    });
    out.splice(i, 1, ...parts);
    return { groups: out, ids: parts.map(p => p.id) };
  }

  // Migrace (§5): každý dosavadní ruční příkaz do skupiny podle §2.1. Volající udělá
  // zálohu před zápisem. Idempotentní přes značku orderGroupsVersion.
  function migratePendingOrders(data, opts = {}) {
    if (Number(data && data.orderGroupsVersion || 0) >= ORDER_GROUPS_VERSION) return { skipped: true };
    const orders = (Array.isArray(data && data.pendingOrders) ? data.pendingOrders : []).filter(x => x && x.id && x.symbol).map(x => ({ ...x, source: 'MANUAL' }));
    const r = planOrderGroups(Array.isArray(data && data.orderGroups) ? data.orderGroups : [], orders, { ...opts, sources: ['MANUAL'] });
    return { skipped: false, orderGroups: r.groups, orderGroupsVersion: ORDER_GROUPS_VERSION, created: r.created };
  }

  return {
    ORDER_GROUPS_VERSION, CONTEXT_FIELDS, groupKeyOf, planOrderGroups, groupView, sortMembers, isOpenGroup, contextFilled,
    canMerge, mergeGroups, splitGroup, migratePendingOrders
  };
}));
