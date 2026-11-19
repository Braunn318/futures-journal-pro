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
  const swing = () => (isNode ? require('./swing.js') : root.FJSwing);
  const api = factory(swing);
  if (isNode) module.exports = api;
  if (root) root.FJOrderGroups = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (FJSwing) {

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
  // Bez idGen je id skupiny odvozené z prvního příkazu – zobrazení (bez zápisu) i pozdější
  // zápis tak dají stejné id a tlačítka u řádku najdou uloženou skupinu.
  function stableId(o, taken) {
    const base = 'og_' + String(o.id).replace(/[^A-Za-z0-9_-]/g, '_');
    let id = base, i = 2;
    while (taken.has(id)) id = base + '_' + (i++);
    return id;
  }
  function groupFromOrder(o, opts, taken) {
    const g = {
      id: opts && typeof opts.idGen === 'function' ? opts.idGen() : stableId(o, taken || new Set()), account: o.account == null ? null : String(o.account), symbol: sym(o.symbol),
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
    return !!g && !g.tradeId && !g.resolution && !hasFill(g) && (!(g.members || []).length || g.members.some(m => m.state === 'PENDING'));
  }
  function contextFilled(g) {
    const c = (g && g.context) || {};
    return !!(g && g.contextFilledAt) && (CONTEXT_FIELDS.some(k => {
      const v = c[k];
      return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== '';
    }) || Object.keys(c.targetLevels || {}).length > 0);
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
      let hit = memberIndex.get(String(order.id));
      if (hit && (sym(order.symbol) !== hit.g.symbol || (order.direction === 'short' ? 'short' : 'long') !== hit.g.direction
        || (order.orderType === 'STOP' ? 'STOP' : 'LIMIT') !== hit.g.orderType)) {
        // ruční limitka upravená na jiný symbol / směr / typ: do své skupiny už nepatří
        hit.g.members = hit.g.members.filter(x => x !== hit.m);
        hit.g.updatedAt = o.nowIso;
        memberIndex.delete(String(order.id));
        hit = null; changed = true;
      }
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
      if (!g) { g = groupFromOrder(order, o, new Set(out.map(x => x.id))); out.push(g); created++; }
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
    // skupina bez členů, bez kontextu a bez obchodu nemá co nést
    const kept = out.filter(g => (g.members || []).length || g.tradeId || g.resolution || contextFilled(g));
    if (kept.length !== out.length) changed = true;
    return { groups: kept, changed, created, added };
  }

  function groupView(g) {
    const members = sortMembers(g);
    const live = members.some(m => m.state !== 'GONE') ? members.filter(m => m.state !== 'GONE') : members;
    const vols = live.map(m => num(m.volume));
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

  // ---- kontext před vstupem (§3) ----
  function cleanContext(raw) {
    const c = {};
    for (const k of CONTEXT_FIELDS) {
      const v = raw ? raw[k] : undefined;
      if (k === 'images') c.images = Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
      else if (k === 'riskAmount') c.riskAmount = num(v);
      else if (k === 'grade') c.grade = ['A', 'B', 'C'].includes(v) ? v : '';
      else c[k] = v == null ? '' : String(v);
    }
    const tl = raw && raw.targetLevels && typeof raw.targetLevels === 'object' ? raw.targetLevels : {};
    c.targetLevels = {};
    for (const [id, v] of Object.entries(tl)) if (String(v || '').trim()) c.targetLevels[id] = String(v).trim();
    return c;
  }
  const ctxSig = c => JSON.stringify(cleanContext(c));
  // Uloží kontext do skupiny. contextFilledAt = první uložení s aspoň jedním vyplněným
  // polem (pak se nemění); změna po naplnění (obchod / naplněný člen) → contextEditedAfterFill.
  function applyGroupContext(group, raw, nowIso) {
    const g = clone(group);
    const next = cleanContext(raw);
    const changed = ctxSig(g.context || {}) !== JSON.stringify(next);
    g.context = next;
    const filled = contextFilled({ context: next, contextFilledAt: 'x' }) || Object.keys(next.targetLevels).length > 0;
    if (filled && !g.contextFilledAt) g.contextFilledAt = nowIso;
    if (!filled && !g.contextFilledAt) g.contextFilledAt = null;
    if (changed) g.contextUpdatedAt = nowIso;
    if (changed && g.contextFilledAt && (g.tradeId || hasFill(g))) g.contextEditedAfterFill = true;
    g.updatedAt = nowIso;
    return g;
  }
  // Kontextová pole obchodu (stejné názvy) + typy hladin cílů.
  function tradeContextSig(t) {
    const c = {};
    for (const k of CONTEXT_FIELDS) c[k] = k === 'images' ? (Array.isArray(t && t.images) ? t.images : []) : k === 'riskAmount' ? num(t && t.riskAmount) : (t && t[k] != null ? String(t[k]) : '');
    c.targetLevels = (Array.isArray(t && t.targetsPlanned) ? t.targetsPlanned : []).map(x => String((x && x.levelType) || ''));
    return JSON.stringify(c);
  }
  // Obchod, který kontext zdědil ze skupiny (contextFilledAt): změna kontextu se označí.
  function markContextEdit(before, after) {
    if (!before || !before.contextFilledAt) return after;
    if (before.contextEditedAfterFill) return { ...after, contextEditedAfterFill: true };
    return tradeContextSig(before) === tradeContextSig(after) ? after : { ...after, contextEditedAfterFill: true };
  }

  // ---- naplnění a přenos do obchodu (§4) ----
  const EPS = 1e-9;
  const isoToLocal = iso => { const ms = Date.parse(iso || ''); return Number.isFinite(ms) ? FJSwing().berlinNowLocal(ms) : null; };
  const pidsOfTrade = t => [t && t.positionId, ...((t && Array.isArray(t.ctraderPositionIds)) ? t.ctraderPositionIds : [])].filter(Boolean);
  const unresolved = g => !g.resolution;

  // Pozice z MCP (otevřené + historie) jako kandidáti naplnění: celkový objem v jednotkách
  // (zbytek otevřené pozice + všechny zavírací dealy), vstup, čas otevření, TP.
  function positionCandidates(data, opts) {
    const out = new Map();
    for (const p of (data && data.positions) || []) {
      const pid = 'ctrader-' + p.id;
      out.set(pid, { pid, symbol: sym(p.symbolName), direction: String(p.tradeSide).toLowerCase() === 'sell' ? 'short' : 'long',
        units: num(p.volumeInUnits) || 0, lotSize: num(p.lotSize), entry: num(p.entryPrice), openMs: Date.parse(p.openTime || ''), openTime: p.openTime, tp: num(p.takeProfitPrice), open: true });
    }
    for (const h of (data && data.history) || []) {
      const pid = 'ctrader-' + h.positionId;
      const c = out.get(pid) || { pid, symbol: sym(h.symbolName), direction: String(h.side).toLowerCase() === 'sell' ? 'short' : 'long',
        units: 0, lotSize: null, entry: num(h.entryPrice), openMs: Date.parse(h.openTime || ''), openTime: h.openTime, tp: null, open: false };
      c.units += num(h.volume) || 0;
      out.set(pid, c);
    }
    for (const c of out.values()) {
      const lot = c.lotSize || (opts && typeof opts.lotSizeOf === 'function' ? num(opts.lotSizeOf(c.symbol)) : null);
      c.lots = lot ? round(c.units / lot, 8) : null;
    }
    return [...out.values()];
  }
  function fillMatches(g, m, c, decimals) {
    if (c.symbol !== g.symbol || c.direction !== g.direction || c.entry == null || !Number.isFinite(c.openMs)) return false;
    const mu = num(m.volumeInUnits), mv = num(m.volume);
    if (mu != null) { if (Math.abs(c.units - mu) > EPS) return false; }
    else if (mv == null || c.lots == null || Math.abs(c.lots - mv) > EPS) return false;
    const from = Date.parse(m.lastSeenAt || m.firstSeenAt || ''), to = Date.parse(m.goneAt || '');
    if (!Number.isFinite(from) || !Number.isFinite(to) || c.openMs < from - 60000 || c.openMs > to + 60000) return false;
    const price = num(m.price != null ? m.price : g.price);
    if (price == null) return false;
    // limitka se plní na své ceně nebo lepší, stop na své ceně nebo horší
    const better = g.direction === 'long' ? c.entry <= price + EPS : c.entry >= price - EPS;
    const worse = g.direction === 'long' ? c.entry >= price - EPS : c.entry <= price + EPS;
    if (g.orderType === 'STOP' ? !worse : !better) return false;
    if (c.open && c.tp != null && num(m.tp) != null && priceKey(c.tp, decimals) !== priceKey(m.tp, decimals)) return false;
    return true;
  }
  // Zmizelé cTrader limitky → pozice. Konzervativně: pozice, která už je v obchodu (mimo
  // obchod téže skupiny) nebo u jiného člena, se nebere; pozice, která pasuje na členy
  // víc skupin, se nepáruje vůbec. Vrací kopie skupin.
  function linkFills(groups, trades, data, opts = {}) {
    const out = (groups || []).map(clone);
    const cands = positionCandidates(data, opts);
    if (!cands.length) return { groups: out, changed: false, linked: 0 };
    const usedBy = new Map();
    for (const t of trades || []) for (const pid of pidsOfTrade(t)) usedBy.set(pid, t);
    for (const g of out) for (const m of g.members || []) if (m.fill && m.fill.positionId) usedBy.set(m.fill.positionId, { _member: true });
    const ownTrade = (g, t) => t && !t._member && (t.id === g.tradeId || t.orderGroupId === g.id);
    const wanted = [];
    for (const g of out) {
      if (!unresolved(g)) continue;
      const d = decimalsFor(opts, g.symbol);
      for (const m of g.members || []) {
        if (m.source !== 'CTRADER' || m.state !== 'GONE' || m.fill) continue;
        const list = cands.filter(c => (!usedBy.has(c.pid) || ownTrade(g, usedBy.get(c.pid))) && fillMatches(g, m, c, d));
        if (list.length) wanted.push({ g, m, list });
      }
    }
    // pozice, o kterou stojí členové víc skupin = nejednoznačné
    const groupsOf = new Map();
    for (const w of wanted) for (const c of w.list) { if (!groupsOf.has(c.pid)) groupsOf.set(c.pid, new Set()); groupsOf.get(c.pid).add(w.g.id); }
    // Uvnitř skupiny jednoznačně: kandidáti člena (po zúžení podle TP) tvoří množinu; člen se
    // páruje, jen když na stejnou množinu připadá právě tolik členů jako pozic (zaměnitelné
    // limitky téže skupiny). Jinak se nepáruje – pozice pak vznikne jako samostatný obchod.
    const claimed = new Set();
    let linked = 0;
    const narrowed = wanted.map(w => {
      const d = decimalsFor(opts, w.g.symbol);
      const free = w.list.filter(c => groupsOf.get(c.pid).size === 1);
      const tpHit = free.filter(c => c.tp != null && num(w.m.tp) != null && priceKey(c.tp, d) === priceKey(w.m.tp, d));
      const set = (tpHit.length ? tpHit : free).sort((a, b) => a.openMs - b.openMs || String(a.pid).localeCompare(String(b.pid)));
      return { ...w, set, sig: w.g.id + '|' + set.map(c => c.pid).join(',') };
    }).filter(w => w.set.length);
    const perSig = new Map();
    for (const w of narrowed) perSig.set(w.sig, (perSig.get(w.sig) || 0) + 1);
    for (const w of narrowed) {
      if (perSig.get(w.sig) !== w.set.length) continue;
      const pick = w.set.find(c => !claimed.has(c.pid));
      if (!pick) continue;
      claimed.add(pick.pid);
      w.m.state = 'FILLED';
      w.m.fill = { positionId: pick.pid, entryPrice: pick.entry, openedAt: isoToLocal(pick.openTime), openTime: pick.openTime, volume: num(w.m.volume) };
      w.g.updatedAt = opts.nowIso || w.g.updatedAt;
      linked++;
    }
    return { groups: out, changed: linked > 0, linked };
  }

  // Otevírací událost cBota (real-time, dřív než MCP synchronizace pozná zmizelou limitku):
  // pozice, která může patřit čekajícímu členu skupiny, se má nechat na synchronizaci –
  // jinak by vznikl samostatný obchod a skupina by si ji už nevzala.
  function groupMayClaimEvent(groups, e, opts = {}) {
    const symbol = sym(e && e.instrument), dir = e && e.side === 'short' ? 'short' : 'long';
    const units = Math.abs(num(e && e.quantity) || 0), entry = num(e && e.entryPrice), ms = Date.parse((e && e.entryTime) || '');
    if (!symbol || entry == null || !Number.isFinite(ms)) return false;
    return (groups || []).some(g => unresolved(g) && g.symbol === symbol && g.direction === dir && (g.members || []).some(m => {
      if (m.source !== 'CTRADER' || m.state === 'FILLED') return false;
      const mu = num(m.volumeInUnits);
      if (mu != null && Math.abs(mu - units) > EPS) return false;
      const seen = Date.parse(m.firstSeenAt || '');
      if (Number.isFinite(seen) && ms < seen - 60000) return false;
      return fillMatches(g, { ...m, lastSeenAt: m.firstSeenAt, goneAt: new Date(ms).toISOString() }, { symbol, direction: dir, units, lots: null, entry, openMs: ms, tp: null, open: false }, decimalsFor(opts, symbol));
    }));
  }

  // TP všech příkazů skupiny (od nejbližšího) s typem hladiny z kontextu.
  function targetsOfGroup(g) {
    const tl = (g.context && g.context.targetLevels) || {};
    return sortMembers(g).filter(m => num(m.tp) != null).map(m => ({ price: num(m.tp), levelType: tl[m.orderId] || '' }));
  }
  function contextCopy(g) {
    const c = cleanContext(g.context || {});
    const out = {};
    for (const k of CONTEXT_FIELDS) out[k] = clone(c[k]);
    return out;
  }
  function fillAggregate(g) {
    const filled = (g.members || []).filter(m => m.state === 'FILLED' && m.fill);
    let w = 0, wp = 0, vol = 0, first = null, firstMs = Infinity;
    for (const m of filled) {
      const v = num(m.fill.volume != null ? m.fill.volume : m.volume), p = num(m.fill.entryPrice);
      if (v != null) vol += v;
      if (v != null && p != null) { w += v; wp += v * p; }
      const ms = Date.parse(m.fill.openTime || '');
      if (Number.isFinite(ms) && ms < firstMs) { firstMs = ms; first = m.fill.openedAt; }
    }
    return { filled, pids: filled.map(m => m.fill.positionId).filter(Boolean), volume: filled.length ? round(vol, 8) : null, entryPrice: w > 0 ? round(wp / w, 8) : null, openedAt: first };
  }
  // Návrh obchodu ze skupiny (tlačítka Naplněno / Nenaplněno): celá skupina = jeden obchod
  // nebo jeden SETUP_ONLY. Nic se neukládá – formulář se předvyplní a uživatel potvrdí.
  function draftFromGroup(g, filled, nowLocal) {
    const v = groupView(g);
    const agg = fillAggregate(g);
    const base = {
      kind: 'SWING', source: 'MANUAL', symbol: g.symbol, direction: g.direction,
      entryPrice: agg.entryPrice != null ? agg.entryPrice : num(g.price), volume: v.totalVolume, slInitial: num(g.sl),
      targetsPlanned: targetsOfGroup(g), exits: [], slMoves: [],
      ...contextCopy(g),
      orderGroupId: g.id, contextFilledAt: g.contextFilledAt || null, ...(g.account != null ? { ctraderAccountId: String(g.account) } : {}),
      orderPlacedAt: v.placedAt, orderPrice: num(g.price)
    };
    if (!g.contextFilledAt) delete base.contextFilledAt;
    const now = nowLocal || FJSwing().berlinNowLocal();
    if (filled) return { ...base, openedAt: agg.openedAt || now };
    return { ...base, recordType: 'SETUP_ONLY', fillStatus: 'NO_FILL', openedAt: v.placedAt || now };
  }
  // Uložený obchod / SETUP_ONLY z návrhu skupiny → skupina ví, kam patří.
  function recordGroupDecision(groups, groupId, trade, nowIso) {
    return (groups || []).map(g => {
      if (g.id !== groupId) return g;
      const x = { ...clone(g), tradeId: trade.id, updatedAt: nowIso || new Date().toISOString() };
      if (trade.recordType === 'SETUP_ONLY') x.resolution = 'NO_FILL';
      return x;
    });
  }
  // Naplněné členy skupin → jeden obchod za skupinu. Nový obchod nese kontext skupiny celý;
  // existující (uložený tlačítkem Naplněno) jen dostane pozice a agregát do prázdných /
  // importovaných polí. Zbylé limitky, které zmizely bez naplnění → cancelledOrders.
  function planGroupTrades(trades, groups, opts = {}) {
    const nowIso = opts.nowIso || new Date().toISOString();
    const rows = [...(trades || [])];
    const gs = (groups || []).map(clone);
    let created = 0, updated = 0, changed = false;
    for (const g of gs) {
      if (!unresolved(g)) continue;
      const agg = fillAggregate(g);
      if (!agg.filled.length) continue;
      const idx = rows.findIndex(t => t && ((g.tradeId && t.id === g.tradeId) || t.orderGroupId === g.id));
      const before = idx >= 0 ? JSON.stringify(rows[idx]) : null;
      let t;
      if (idx < 0) {
        const allCt = (g.members || []).every(m => m.source === 'CTRADER');
        t = {
          id: 'sw_og_' + String(g.id).replace(/[^A-Za-z0-9_-]/g, '_'), kind: 'SWING', source: allCt ? 'CTRADER' : 'MANUAL',
          orderGroupId: g.id, ...(g.account != null ? { ctraderAccountId: String(g.account) } : {}),
          positionId: undefined, ctraderPositionIds: [],
          symbol: g.symbol, direction: g.direction, openedAt: agg.openedAt, entryPrice: agg.entryPrice, volume: agg.volume,
          slInitial: num(g.sl), slMoves: [], targetsPlanned: targetsOfGroup(g), riskAmount: null, exits: [],
          ...contextCopy(g), ...(g.contextFilledAt ? { contextFilledAt: g.contextFilledAt } : {}),
          orderPlacedAt: groupView(g).placedAt, orderPrice: num(g.price),
          importedFields: ['symbol', 'direction', 'openedAt', 'entryPrice', 'volume', 'slInitial', 'targetsPlanned'],
          createdAt: nowIso
        };
        if (rows.some(x => x && x.id === t.id)) t.id += '_' + nowIso.replace(/\D/g, '').slice(-8);
      } else {
        t = { ...rows[idx], ctraderPositionIds: [...(rows[idx].ctraderPositionIds || [])], importedFields: [...(rows[idx].importedFields || [])] };
        if (!t.orderGroupId) t.orderGroupId = g.id;
      }
      // pozice skupiny (žádná nesmí být v jiném obchodu)
      const elsewhere = new Set(rows.filter((x, i) => i !== idx && x).flatMap(pidsOfTrade));
      for (const pid of agg.pids) if (!elsewhere.has(pid) && !t.ctraderPositionIds.includes(pid)) t.ctraderPositionIds.push(pid);
      if (!t.positionId && t.ctraderPositionIds.length) t.positionId = t.ctraderPositionIds[0];
      if (t.positionId === undefined) delete t.positionId;
      const imp = f => t[f] === null || t[f] === undefined || t[f] === '' || t.importedFields.includes(f);
      for (const [f, v] of [['entryPrice', agg.entryPrice], ['volume', agg.volume], ['openedAt', agg.openedAt]]) {
        if (v == null || !imp(f)) continue;
        t[f] = v;
        if (!t.importedFields.includes(f)) t.importedFields.push(f);
      }
      if (t.openedAt) t.date = FJSwing().swingListDate(t);
      const withTp = sortMembers(g).filter(x => num(x.tp) != null);
      const cancelled = sortMembers(g).filter(m => m.state === 'GONE')
        .map(m => ({ orderId: m.orderId, label: num(m.tp) != null ? 'TP' + (withTp.indexOf(m) + 1) : 'bez TP', tp: num(m.tp), volume: num(m.volume) }));
      if (cancelled.length) t.cancelledOrders = cancelled; else delete t.cancelledOrders;
      if (JSON.stringify(t) === before) { if (g.tradeId !== t.id) { g.tradeId = t.id; changed = true; } continue; }
      t.updatedAt = nowIso;
      if (idx >= 0) { rows[idx] = t; updated++; } else { rows.push(t); created++; }
      if (g.tradeId !== t.id) { g.tradeId = t.id; g.updatedAt = nowIso; }
      changed = true;
    }
    return { trades: rows, groups: gs, created, updated, changed };
  }
  // Jedna synchronizace skupin: snímky příkazů → naplnění → obchody skupin. planMcpSync běží až
  // nad výsledkem (pozice skupin už mají svůj obchod, takže se neptá na spárování).
  function syncStage(groups, trades, liveOrders, data, opts = {}) {
    const a = planOrderGroups(groups, liveOrders, opts);
    const b = (opts.sources || ['MANUAL', 'CTRADER']).includes('CTRADER') ? linkFills(a.groups, trades, data, opts) : { groups: a.groups, changed: false, linked: 0 };
    const c = planGroupTrades(trades, b.groups, opts);
    return { groups: c.groups, trades: c.trades, changed: a.changed || b.changed || c.changed, linked: b.linked, created: c.created, updated: c.updated };
  }


  return {
    groupMayClaimEvent, linkFills, planGroupTrades, syncStage, draftFromGroup, recordGroupDecision, targetsOfGroup,
    applyGroupContext, markContextEdit, cleanContext, tradeContextSig,
    ORDER_GROUPS_VERSION, CONTEXT_FIELDS, groupKeyOf, planOrderGroups, groupView, sortMembers, isOpenGroup, contextFilled,
    canMerge, mergeGroups, splitGroup, migratePendingOrders
  };
}));
