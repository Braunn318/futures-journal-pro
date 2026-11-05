'use strict';
// Swingový CFD deník (docs/ZADANI_SWING_CFD.md): typ deníku, tabulka CFD
// instrumentů, datový model swing obchodu a dopočty.
//
// PENÍZE Z BROKERA, R Z CEN. CFD nemá pevnou hodnotu ticku, deník proto P/L
// nepočítá – opíše se z výpisu brokera se znaménkem. Pipy a R se počítají jen
// z cen; R z pipů na jednotku (objemově vážený průměr nohou), nikdy z peněz ani
// z celkového objemu. pnlNet = pnl + swap + commission – prostý součet, žádné
// abs() ani odečítání provize.
//
// DOPOČTY SE NEUKLÁDAJÍ. swingDerived() je čistá funkce nad obchodem; chybějící
// vstup = null, nikdy 0.
//
// ČASY: openedAt, exits[].closedAt, slMoves[].at jsou „YYYY-MM-DDTHH:MM" v
// berlínském čase (stejná konvence jako date + entryTime u futures obchodů).
//
// Modul se načítá přes <script src> po app/context.js a zároveň jde načíst
// v Node testech.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const context = () => (isNode ? require('./context.js') : root.FJContext);
  const api = factory(context);
  if (isNode) module.exports = api;
  if (root) root.FJSwing = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (FJContext) {

  const JOURNAL_TYPES = Object.freeze({ FUTURES_INTRADAY: 'FUTURES_INTRADAY', CFD_SWING: 'CFD_SWING' });
  const JOURNAL_TYPE_VERSION = 1;
  const JOURNAL_TYPE_LABELS = Object.freeze({ FUTURES_INTRADAY: 'Futures intraday', CFD_SWING: 'Swing · CFD' });
  const EXIT_REASONS = ['TARGET', 'SL', 'BE', 'MANUAL', 'TIME'];
  const EXIT_REASON_LABELS = { TARGET: 'Cíl', SL: 'Stop loss', BE: 'Break even', MANUAL: 'Ručně', TIME: 'Čas' };
  const SL_MOVE_REASONS = ['BE', 'TRAIL', 'MANUAL'];
  const SL_MOVE_REASON_LABELS = { BE: 'Break even', TRAIL: 'Trail', MANUAL: 'Ručně' };
  const ASSET_CLASSES = ['FX', 'INDEX', 'COMMODITY', 'OTHER'];
  const CURRENCIES = ['USD', 'EUR', 'CZK', 'GBP', 'CHF', 'JPY', 'AUD', 'CAD'];
  // Nabídka setupů z poznámek Forex – Swing (§6). Jen nabídka do pole, plné
  // uživatelské číselníky přijdou v kroku 6 swing zadání.
  const SWING_SETUP_SUGGESTIONS = ['4h profil – VA/VPOC na tupo', 'M2 daily', 'Gap jako SR', 'Třetí dotek', 'Výběr likvidity (protisvíce v trendu)', 'Jiný'];

  function fx(symbol, pip) {
    const base = symbol.slice(0, 3), quote = symbol.slice(3, 6);
    return { symbol, pipSize: pip, priceDecimals: pip === 0.01 ? 3 : 5, lotSize: 100000, assetClass: 'FX', baseCcy: base, quoteCcy: quote };
  }
  // Výchozí tabulka. Uživatelsky editovatelná (settings.cfdInstruments), uložené hodnoty mají přednost.
  const DEFAULT_CFD_INSTRUMENTS = Object.freeze([
    ...['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'EURGBP', 'EURAUD', 'EURCAD', 'EURCHF', 'EURNZD',
      'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPNZD', 'AUDCAD', 'AUDCHF', 'AUDNZD', 'NZDCAD', 'NZDCHF', 'CADCHF'].map(s => fx(s, 0.0001)),
    ...['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY'].map(s => fx(s, 0.01)),
    { symbol: 'US500', pipSize: 1, priceDecimals: 1, assetClass: 'INDEX', baseCcy: '', quoteCcy: '' },
    { symbol: 'US100', pipSize: 1, priceDecimals: 1, assetClass: 'INDEX', baseCcy: '', quoteCcy: '' },
    { symbol: 'GER40', pipSize: 1, priceDecimals: 1, assetClass: 'INDEX', baseCcy: '', quoteCcy: '' },
    { symbol: 'XAUUSD', pipSize: 0.1, priceDecimals: 2, lotSize: 100, assetClass: 'COMMODITY', baseCcy: '', quoteCcy: '' },
    { symbol: 'USOIL', pipSize: 0.01, priceDecimals: 2, assetClass: 'COMMODITY', baseCcy: '', quoteCcy: '' }
  ].map(Object.freeze));

  function num(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const EPS = 1e-9;
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

  function journalTypeOf(obj) {
    const t = obj && obj.journalType;
    return t === JOURNAL_TYPES.CFD_SWING ? t : JOURNAL_TYPES.FUTURES_INTRADAY;
  }
  const isSwingType = obj => journalTypeOf(obj) === JOURNAL_TYPES.CFD_SWING;
  const isSwingRecord = t => !!t && t.kind === 'SWING';

  function normalizeSymbol(s) { return String(s || '').trim().toUpperCase(); }
  function sanitizeInstrument(raw) {
    const symbol = normalizeSymbol(raw && raw.symbol);
    if (!symbol) return null;
    const pipSize = num(raw.pipSize);
    const priceDecimals = num(raw.priceDecimals);
    const lotSize = num(raw.lotSize);
    return {
      symbol,
      pipSize: pipSize != null && pipSize > 0 ? pipSize : null,
      priceDecimals: priceDecimals != null && priceDecimals >= 0 ? Math.round(priceDecimals) : null,
      // jednotek v 1 lotu (cTrader posílá objem v jednotkách); null = neznámé
      lotSize: lotSize != null && lotSize > 0 ? lotSize : null,
      assetClass: ASSET_CLASSES.includes(raw.assetClass) ? raw.assetClass : 'OTHER',
      baseCcy: normalizeSymbol(raw.baseCcy).slice(0, 3),
      quoteCcy: normalizeSymbol(raw.quoteCcy).slice(0, 3)
    };
  }
  // Výchozí tabulka + uložené záznamy deníku (stejný symbol = uložený vyhrává).
  function instrumentsOf(settings) {
    const out = new Map(DEFAULT_CFD_INSTRUMENTS.map(i => [i.symbol, { ...i, builtin: true }]));
    for (const raw of (settings && Array.isArray(settings.cfdInstruments) ? settings.cfdInstruments : [])) {
      const i = sanitizeInstrument(raw);
      if (!i) continue;
      // uložený řádek doplňuje výchozí: prázdná hodnota výchozí nepřepíše
      const merged = { ...(out.get(i.symbol) || {}) };
      for (const [k, v] of Object.entries(i)) if (v !== null && v !== '') merged[k] = v;
      out.set(i.symbol, { ...merged, builtin: DEFAULT_CFD_INSTRUMENTS.some(d => d.symbol === i.symbol) });
    }
    return [...out.values()];
  }
  function findInstrument(symbol, list) {
    const s = normalizeSymbol(symbol);
    return (list || []).find(i => i.symbol === s) || null;
  }

  // ---- čas ----
  function splitLocal(value) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})/.exec(String(value || '').trim());
    return m ? { date: m[1], time: m[2] } : null;
  }
  function instantOf(value) {
    const p = splitLocal(value);
    return p ? FJContext().berlinInstant(p.date, p.time) : null;
  }
  const berlinDate = (() => {
    let f;
    return ms => {
      f = f || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
      return f.format(new Date(ms));
    };
  })();
  function daysBetween(dateA, dateB) {
    const a = Date.parse(dateA + 'T00:00:00Z'), b = Date.parse(dateB + 'T00:00:00Z');
    return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
  }
  // Teď jako „YYYY-MM-DDTHH:MM" v berlínském čase (výchozí hodnota formulářů).
  function berlinNowLocal(ms) {
    const d = new Date(ms == null ? Date.now() : ms);
    const p = {};
    for (const part of new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d)) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  // ---- peníze ----
  function legPnlNet(leg) {
    const pnl = num(leg && leg.pnl);
    if (pnl == null) return null;
    return round((pnl) + (num(leg.swap) || 0) + (num(leg.commission) || 0), 8);
  }

  function dirOf(t) { return t && t.direction === 'short' ? -1 : t && t.direction === 'long' ? 1 : null; }
  function validExits(t) { return (Array.isArray(t && t.exits) ? t.exits : []).filter(e => e && typeof e === 'object'); }
  function exitsVolume(t) { return validExits(t).reduce((s, e) => s + (num(e.volume) || 0), 0); }
  function exitsVolumeError(t) {
    const v = num(t && t.volume);
    return v != null && exitsVolume(t) > v + EPS;
  }
  function sortedMoves(t) {
    return (Array.isArray(t && t.slMoves) ? t.slMoves : [])
      .filter(m => m && num(m.price) != null)
      .map(m => ({ ...m, ms: instantOf(m.at) }))
      .sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  }
  // SL platný v okamžiku ms (poslední posun nejpozději v ms, jinak slInitial).
  function slAt(t, ms) {
    let sl = num(t && t.slInitial);
    for (const m of sortedMoves(t)) if (m.ms != null && ms != null && m.ms <= ms) sl = num(m.price);
    return sl;
  }

  function status(t) {
    const v = num(t && t.volume);
    if (v == null) return validExits(t).length ? 'CLOSED' : 'OPEN';
    return exitsVolume(t) < v - EPS ? 'OPEN' : 'CLOSED';
  }

  function swingDerived(t, instrument, nowMs) {
    const pip = instrument && num(instrument.pipSize) > 0 ? num(instrument.pipSize) : null;
    const dir = dirOf(t);
    const entry = num(t && t.entryPrice);
    const slInitial = num(t && t.slInitial);
    const volume = num(t && t.volume);
    const exits = validExits(t);
    const st = status(t);
    const exitTimes = exits.map(e => ({ e, ms: instantOf(e.closedAt) }));
    const last = exitTimes.filter(x => x.ms != null).sort((a, b) => a.ms - b.ms).pop();
    const closedAt = st === 'CLOSED' && last ? last.e.closedAt : null;

    const slPips = pip && entry != null && slInitial != null ? round(Math.abs(entry - slInitial) / pip, 6) : null;
    let wSum = 0, wPips = 0, priced = true;
    for (const e of exits) {
      const p = num(e.price), v = num(e.volume);
      if (p == null || v == null || v <= 0) { priced = false; continue; }
      wSum += v; wPips += v * ((p - entry) * dir / pip);
    }
    const pipsPerUnit = pip && dir && entry != null && exits.length && priced && wSum > 0 ? round(wPips / wSum, 6) : null;
    const rPrice = st === 'CLOSED' && pipsPerUnit != null && slPips ? round(pipsPerUnit / slPips, 6) : null;

    const nets = exits.map(legPnlNet);
    const pnlNetTotal = exits.length && nets.every(n => n != null) ? round(nets.reduce((s, n) => s + n, 0), 8) : null;
    const sumOf = key => (exits.length ? round(exits.reduce((s, e) => s + (num(e[key]) || 0), 0), 8) : null);
    const riskAmount = num(t && t.riskAmount);
    const rMoney = pnlNetTotal != null && riskAmount ? round(pnlNetTotal / riskAmount, 6) : null;

    const openMs = instantOf(t && t.openedAt);
    const endMs = closedAt ? instantOf(closedAt) : (st === 'OPEN' ? (nowMs == null ? Date.now() : nowMs) : null);
    const holdingHours = openMs != null && endMs != null ? round((endMs - openMs) / 3600000, 4) : null;
    const holdingDays = holdingHours != null ? round(holdingHours / 24, 1) : null;
    const openDate = splitLocal(t && t.openedAt);
    const endDate = closedAt ? splitLocal(closedAt).date : (endMs != null ? berlinDate(endMs) : null);
    const nightsHeld = openDate && endDate ? Math.max(0, daysBetween(openDate.date, endDate)) : null;

    const moves = sortedMoves(t);
    const currentSl = moves.length ? num(moves[moves.length - 1].price) : slInitial;
    let slSlippagePips = null;
    const slLegs = exitTimes.filter(x => x.e.reason === 'SL' && num(x.e.price) != null).sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
    if (slLegs.length && pip && dir) {
      const x = slLegs[slLegs.length - 1];
      const sl = slAt(t, x.ms);
      if (sl != null) slSlippagePips = round((num(x.e.price) - sl) * dir / pip, 6);
    }
    return {
      status: st, closedAt, slInitial, currentSl, slPips, pipsPerUnit, rPrice, rMoney,
      holdingHours, holdingDays, nightsHeld,
      swapTotal: sumOf('swap'), commissionTotal: sumOf('commission'), pnlTotal: sumOf('pnl'), pnlNetTotal,
      slSlippagePips, exitsVolume: round(exitsVolume(t), 8),
      remainingVolume: volume != null ? round(Math.max(0, volume - exitsVolume(t)), 8) : null,
      volumeError: exitsVolumeError(t)
    };
  }

  // „Neúplné": chybí slInitial, setup, nebo pnl u některé nohy uzavřeného obchodu.
  function swingMissing(t) {
    if (!t || t.recordType === 'SETUP_ONLY') return [];
    const out = [];
    if (num(t.slInitial) == null) out.push('slInitial');
    if (!String(t.swingSetup || '').trim()) out.push('swingSetup');
    if (status(t) === 'CLOSED' && validExits(t).some(e => num(e.pnl) == null)) out.push('exitPnl');
    return out;
  }
  const MISSING_LABELS = { slInitial: 'SL při otevření', swingSetup: 'setup', exitPnl: 'P/L u nohy' };

  // ---- čekající příkazy (limitky) ----
  const ORDER_TYPES = ['LIMIT', 'STOP'];
  function sanitizePendingOrder(raw, now) {
    const symbol = normalizeSymbol(raw && raw.symbol);
    if (!symbol) return null;
    return {
      id: String(raw.id || ('po_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36))),
      source: raw.source === 'CTRADER' ? 'CTRADER' : 'MANUAL',
      symbol,
      direction: raw.direction === 'short' ? 'short' : 'long',
      orderType: ORDER_TYPES.includes(raw.orderType) ? raw.orderType : 'LIMIT',
      price: num(raw.price), sl: num(raw.sl), tp: num(raw.tp), volume: num(raw.volume),
      placedAt: splitLocal(raw.placedAt) ? raw.placedAt : (now || berlinNowLocal()),
      expiresAt: splitLocal(raw.expiresAt) ? raw.expiresAt : null,
      note: String(raw.note || '').slice(0, 500),
      externalId: raw.externalId != null ? String(raw.externalId) : null
    };
  }
  // Řádek z cTrader MCP get_pending_orders → stejný tvar jako ruční limitka (jen pro zobrazení).
  function pendingFromMcp(o) {
    if (!o || !o.symbolName) return null;
    const exp = o.expiration ? Date.parse(o.expiration) : NaN;
    return {
      id: 'ct_' + o.id, source: 'CTRADER', externalId: o.id != null ? String(o.id) : null,
      symbol: normalizeSymbol(o.symbolName),
      direction: String(o.tradeSide).toLowerCase() === 'sell' ? 'short' : 'long',
      orderType: /stop/i.test(o.orderType || '') ? 'STOP' : 'LIMIT',
      orderTypeRaw: o.orderType || null,
      price: num(o.targetPrice), sl: num(o.stopLossPrice), tp: num(o.takeProfitPrice),
      volume: num(o.volumeInLots), volumeInUnits: num(o.volumeInUnits),
      placedAt: null,
      expiresAt: Number.isFinite(exp) ? berlinNowLocal(exp) : null,
      currentPrice: num(o.currentPrice), note: ''
    };
  }
  // Návrh obchodu z limitky. filled = otevřená pozice, jinak SETUP_ONLY s NO_FILL.
  // Nic se neukládá – formulář se jen předvyplní a uživatel potvrdí.
  function draftFromPendingOrder(order, filled, nowLocal) {
    const base = {
      kind: 'SWING', source: 'MANUAL', symbol: order.symbol, direction: order.direction,
      entryPrice: order.price, volume: order.volume, slInitial: order.sl,
      targetsPlanned: order.tp != null ? [{ price: order.tp, levelType: '' }] : [],
      orderPlacedAt: order.placedAt || null, orderPrice: order.price, exits: [], slMoves: []
    };
    if (filled) return { ...base, openedAt: nowLocal || berlinNowLocal() };
    return { ...base, recordType: 'SETUP_ONLY', fillStatus: 'NO_FILL', openedAt: order.placedAt || nowLocal || berlinNowLocal() };
  }

  // Den obchodu pro seznam (Berlín): den otevření. Kalendář a P/L podle dne nohy
  // výstupu přijdou v kroku 5 swing zadání.
  function swingListDate(t) {
    const p = splitLocal(t && t.openedAt);
    return p ? p.date : '';
  }

  // ---- import z cTraderu (cBot konektor; docs/ZADANI_CTRADER_MCP.md §4) ----
  // Obchod = pozice (positionId "ctrader-<id>", stejný klíč jako cBot), každé uzavření
  // = noha. Peníze se znaménkem z cTraderu: pnl + swap + commission = NetProfit.
  // Import vyplní pole jen prázdná nebo dřív importovaná (importedFields) – ruční hodnota vyhrává.
  const IMPORT_FIELDS = ['symbol', 'direction', 'openedAt', 'entryPrice', 'volume', 'slInitial', 'targetsPlanned'];
  const isEmpty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  const fromUtcIso = iso => { const ms = Date.parse(iso || ''); return Number.isFinite(ms) ? berlinNowLocal(ms) : null; };
  const lotsOf = (units, lotSize) => { const u = num(units), l = num(lotSize); return u != null && l > 0 ? round(Math.abs(u) / l, 8) : null; };

  // Nový swing obchod z události cBota (trade_opened i trade_closed). Bez lotSize u otevření null.
  function swingFromCtraderEvent(e, lotSize) {
    const open = e && e.type === 'trade_opened';
    const volume = open ? lotsOf(e.quantity, lotSize) : 0;
    if (open && volume == null) return null;
    const pid = String(e.positionId || '');
    const t = {
      id: 'sw_' + pid.replace(/[^A-Za-z0-9_-]/g, '_'), kind: 'SWING', source: 'CTRADER',
      positionId: pid, ctraderAccount: e.account != null ? String(e.account) : null,
      symbol: normalizeSymbol(e.instrument), direction: e.side === 'short' ? 'short' : 'long',
      openedAt: fromUtcIso(e.entryTime), entryPrice: num(e.entryPrice), volume,
      slInitial: null, slMoves: [], targetsPlanned: [], riskAmount: null, exits: [],
      swingSetup: '', grade: '', comment: '', images: [],
      importedFields: ['symbol', 'direction', 'openedAt', 'entryPrice', 'volume']
    };
    if (!open) t.volumeFromLegs = true;
    if (open && num(e.quantity) != null) t.volumeUnits = Math.abs(num(e.quantity));
    t.date = swingListDate(t);
    return t;
  }
  // Doplní importovaná pole do existujícího obchodu (spárovaný ruční obchod, pozdní otevírací událost).
  function mergeImported(existing, imported) {
    const out = { ...existing, importedFields: [...(existing.importedFields || [])] };
    for (const f of IMPORT_FIELDS) {
      if (isEmpty(imported[f])) continue;
      if (isEmpty(out[f]) || out.importedFields.includes(f)) {
        out[f] = imported[f];
        if (!out.importedFields.includes(f)) out.importedFields.push(f);
      }
    }
    // otevírací událost zná celkový objem → objem už neroste s nohami
    if (!imported.volumeFromLegs && out.importedFields.includes('volume')) delete out.volumeFromLegs;
    if (imported.volumeUnits != null && out.importedFields.includes('volume')) out.volumeUnits = imported.volumeUnits;
    for (const k of ['positionId', 'ctraderAccount']) if (!out[k] && imported[k]) out[k] = imported[k];
    out.date = swingListDate(out);
    return out;
  }
  // Přidá nohu z uzavírací události. Stejný closingDealId podruhé nic nezmění.
  function applyCtraderClose(trade, e, lotSize) {
    const externalId = String(e.sourceExecutionId || e.closingDealId || e.id || '');
    const exits = Array.isArray(trade.exits) ? trade.exits : [];
    if (externalId && exits.some(x => x && x.externalId === externalId)) return { trade, changed: false };
    const volume = lotsOf(e.quantity, lotSize);
    if (volume == null) return { trade, changed: false, missingLot: true };
    const net = num(e.ctraderNet != null ? e.ctraderNet : e.pnl);
    const hasRaw = e.ctraderSwap !== undefined || e.ctraderCommission !== undefined;
    const swap = hasRaw ? (num(e.ctraderSwap) || 0) : null;
    const commission = hasRaw ? (num(e.ctraderCommission) || 0) : null;
    const pnl = net == null ? null : round(net - (swap || 0) - (commission || 0), 8);
    const leg = { closedAt: fromUtcIso(e.exitTime), price: num(e.exitPrice), volume, reason: null, pnl, swap, commission, externalId, source: 'CTRADER' };
    const next = { ...trade, exits: [...exits, leg] };
    if (next.volumeFromLegs) next.volume = round((num(next.volume) || 0) + volume, 8);
    if (next.entryPrice == null && num(e.entryPrice) != null) next.entryPrice = num(e.entryPrice);
    if (!next.openedAt && e.entryTime) { next.openedAt = fromUtcIso(e.entryTime); next.date = swingListDate(next); }
    return { trade: next, changed: true };
  }
  // Ručně zadaný obchod, který nejspíš odpovídá importované pozici: stejný symbol a směr,
  // otevření ± 5 min a stejný objem (u pozice z uzavírací události objem neznáme).
  function findPairCandidate(rows, draft) {
    const ms = instantOf(draft && draft.openedAt);
    if (ms == null) return null;
    return (rows || []).find(t => isSwingRecord(t) && !t.positionId && t.recordType !== 'SETUP_ONLY'
      && normalizeSymbol(t.symbol) === draft.symbol && t.direction === draft.direction
      && instantOf(t.openedAt) != null && Math.abs(instantOf(t.openedAt) - ms) <= 5 * 60000
      && (draft.volumeFromLegs || (num(t.volume) != null && Math.abs(num(t.volume) - num(draft.volume)) < 1e-6))) || null;
  }
  // SL / TP otevřené pozice z cTrader MCP (get_positions) při synchronizaci.
  function applyMcpPosition(trade, pos, nowLocal) {
    const sl = num(pos && pos.stopLossPrice), tp = num(pos && pos.takeProfitPrice);
    const t = { ...trade, slMoves: [...(trade.slMoves || [])], importedFields: [...(trade.importedFields || [])] };
    let changed = false;
    if (sl != null) {
      if (num(t.slInitial) == null) { t.slInitial = sl; if (!t.importedFields.includes('slInitial')) t.importedFields.push('slInitial'); changed = true; }
      else {
        const moves = sortedMoves(t);
        const current = moves.length ? num(moves[moves.length - 1].price) : num(t.slInitial);
        if (Math.abs(current - sl) > 1e-9) { t.slMoves.push({ at: nowLocal || berlinNowLocal(), price: sl, reason: null, timeApprox: true }); changed = true; }
      }
    }
    if (tp != null && isEmpty(t.targetsPlanned)) {
      t.targetsPlanned = [{ price: tp, levelType: '' }];
      if (!t.importedFields.includes('targetsPlanned')) t.importedFields.push('targetsPlanned');
      changed = true;
    }
    return { trade: changed ? t : trade, changed };
  }
  // Ruční úprava importovaného pole ho vyřadí z importedFields (další import ho už nepřepíše).
  function dropEditedImportedFields(before, after) {
    const list = (before && before.importedFields) || [];
    if (!list.length) return after;
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    return { ...after, importedFields: list.filter(f => same(before[f], after[f])) };
  }

  // ---- synchronizace přes lokální MCP server cTrader Desktop (bez cBota) ----
  // get_positions = otevřené pozice, get_order_history = jeden řádek za každý zavírací deal
  // (i částečný) se stejným positionId. Řádek historie nemá id dealu → noha se pozná podle
  // času, objemu a ceny (shoduje se i s nohou, kterou už zapsal cBot).
  function sameLeg(a, b) {
    if (!a || !b) return false;
    if (a.externalId && b.externalId && a.externalId === b.externalId) return true;
    const ta = instantOf(a.closedAt), tb = instantOf(b.closedAt);
    return ta != null && tb != null && Math.abs(ta - tb) <= 60000
      && Math.abs((num(a.volume) || 0) - (num(b.volume) || 0)) < 1e-6
      && Math.abs((num(a.price) || 0) - (num(b.price) || 0)) < 1e-9;
  }
  // Řádek get_order_history → noha. Rozdíl netProfit − (gross + swap + commission) (u FTMO
  // poplatek za převod měny P/L) jde do komise (rozhodnutí 2026-11-04) → netto nohy = netProfit.
  function legFromMcpHistory(row, lotSize) {
    const volume = lotsOf(row && row.volume, lotSize);
    if (volume == null) return null;
    const gross = num(row.grossProfit), swap = num(row.swap) || 0, commission = num(row.commission) || 0, net = num(row.netProfit);
    const rest = net != null && gross != null ? round(net - gross - swap - commission, 8) : 0;
    return {
      closedAt: fromUtcIso(row.closeTime), price: num(row.closePrice), volume, reason: null,
      pnl: gross != null ? gross : net, swap, commission: round(commission + (rest || 0), 8),
      externalId: `mcp:${row.positionId}:${row.closeTime}:${row.volume}`, source: 'CTRADER'
    };
  }
  function swingFromMcpPosition(pos) {
    const pid = 'ctrader-' + pos.id;
    const t = {
      id: 'sw_ctrader-' + String(pos.id).replace(/[^A-Za-z0-9_-]/g, '_'), kind: 'SWING', source: 'CTRADER', positionId: pid,
      symbol: normalizeSymbol(pos.symbolName), direction: String(pos.tradeSide).toLowerCase() === 'sell' ? 'short' : 'long',
      openedAt: fromUtcIso(pos.openTime), entryPrice: num(pos.entryPrice), volume: num(pos.volumeInLots),
      volumeUnits: num(pos.volumeInUnits), slInitial: null, slMoves: [], targetsPlanned: [], riskAmount: null, exits: [],
      swingSetup: '', grade: '', comment: '', images: [],
      importedFields: ['symbol', 'direction', 'openedAt', 'entryPrice', 'volume']
    };
    t.date = swingListDate(t);
    return t;
  }
  function swingFromMcpHistory(row) {
    const pid = 'ctrader-' + row.positionId;
    const t = {
      id: 'sw_ctrader-' + String(row.positionId).replace(/[^A-Za-z0-9_-]/g, '_'), kind: 'SWING', source: 'CTRADER', positionId: pid,
      symbol: normalizeSymbol(row.symbolName), direction: String(row.side).toLowerCase() === 'sell' ? 'short' : 'long',
      openedAt: fromUtcIso(row.openTime), entryPrice: num(row.entryPrice), volume: 0, volumeFromLegs: true,
      slInitial: null, slMoves: [], targetsPlanned: [], riskAmount: null, exits: [],
      swingSetup: '', grade: '', comment: '', images: [],
      importedFields: ['symbol', 'direction', 'openedAt', 'entryPrice', 'volume']
    };
    t.date = swingListDate(t);
    return t;
  }
  // Přidá nohu, když v obchodu ještě není (stejná noha z cBota se nepřidá podruhé).
  function addLeg(trade, leg) {
    const exits = Array.isArray(trade.exits) ? trade.exits : [];
    if (exits.some(x => sameLeg(x, leg))) return { trade, changed: false };
    const next = { ...trade, exits: [...exits, leg] };
    if (next.volumeFromLegs && (next.importedFields || []).includes('volume')) next.volume = round((num(next.volume) || 0) + leg.volume, 8);
    return { trade: next, changed: true };
  }
  // Otevřená pozice zná zbývající objem: celkový objem = zbytek + součet nohou.
  function reconcileOpenVolume(trade, pos) {
    if (!(trade.importedFields || []).includes('volume')) return { trade, changed: false };
    const remaining = num(pos && pos.volumeInLots);
    if (remaining == null) return { trade, changed: false };
    const total = round(remaining + exitsVolume(trade), 8);
    if (num(trade.volume) === total && !trade.volumeFromLegs) return { trade, changed: false };
    const next = { ...trade, volume: total };
    delete next.volumeFromLegs;
    return { trade: next, changed: true };
  }
  // Účet vybraný v deníku musí být v cTraderu právě aktivní. Odpovědi MCP číslo účtu nenesou,
  // aktivní účet se pozná shodou broker + měna + zůstatek s řádkem seznamu účtů; víc shod = nejisté.
  function mcpActiveAccountCheck(selected, balance, accounts) {
    if (!selected || !selected.login) return { ok: false, reason: 'NO_ACCOUNT' };
    if (!balance) return { ok: false, reason: 'NO_BALANCE' };
    const same = (accounts || []).filter(a => a.brokerTitle === balance.brokerName && a.currency === balance.depositAsset && Number(a.balance) === Number(balance.balance));
    if (!same.length) return { ok: false, reason: 'UNKNOWN_ACTIVE' };
    if (same.length > 1) return { ok: false, reason: 'AMBIGUOUS' };
    return String(same[0].login) === String(selected.login) ? { ok: true } : { ok: false, reason: 'OTHER_ACTIVE', active: same[0] };
  }

  // Plán synchronizace: z obchodů deníku a dat MCP (positions, history) spočítá nový seznam
  // obchodů. Čistá funkce – nic nezapisuje. Pozice, ke které existuje ručně zadaný obchod
  // (findPairCandidate) a ještě není rozhodnuto (opts.decisions: positionId → id obchodu / 'NEW'),
  // se přeskočí a vrátí v `pairs` – rozhodne uživatel. Idempotentní: druhý běh nic nezmění.
  function planMcpSync(trades, data, opts = {}) {
    const decisions = opts.decisions || new Map();
    const nowLocal = opts.nowLocal || berlinNowLocal();
    const nowIso = opts.nowIso || new Date().toISOString();
    const fromMs = opts.importFrom ? Date.parse(opts.importFrom + 'T00:00:00Z') : null;
    const tooOld = iso => fromMs != null && Number.isFinite(Date.parse(iso || '')) && Date.parse(iso) < fromMs;
    const rows = [...(trades || [])];
    const byPid = new Map();
    rows.forEach((t, i) => { if (isSwingRecord(t) && t.positionId) byPid.set(t.positionId, i); });
    const open = new Map((data.positions || []).map(p => ['ctrader-' + p.id, p]));
    const hist = new Map();
    for (const h of data.history || []) {
      const pid = 'ctrader-' + h.positionId;
      if (!hist.has(pid)) hist.set(pid, []);
      hist.get(pid).push(h);
    }
    const out = { trades: rows, created: 0, updated: 0, missingLot: new Set(), pairs: [], skippedOld: 0 };
    for (const pid of new Set([...open.keys(), ...hist.keys()])) {
      const pos = open.get(pid) || null;
      const legsRows = (hist.get(pid) || []).slice().sort((a, b) => String(a.closeTime).localeCompare(String(b.closeTime)));
      let idx = byPid.has(pid) ? byPid.get(pid) : -1;
      if (idx < 0 && tooOld(pos ? pos.openTime : legsRows[0] && legsRows[0].openTime)) { out.skippedOld++; continue; }
      let t = idx >= 0 ? rows[idx] : null;
      const before = JSON.stringify(t);
      if (!t) {
        const draft = pos ? swingFromMcpPosition(pos) : swingFromMcpHistory(legsRows[0]);
        const dec = decisions.get(pid);
        const cand = dec && dec !== 'NEW' ? rows.find(x => x && x.id === dec && !x.positionId) : (dec === 'NEW' ? null : findPairCandidate(rows, draft));
        if (cand && !dec) { out.pairs.push({ positionId: pid, candidateId: cand.id, draft }); continue; }
        if (cand) { idx = rows.indexOf(cand); t = mergeImported({ ...cand, positionId: pid }, draft); }
        else { t = { ...draft, createdAt: nowIso }; if (rows.some(x => x && x.id === t.id)) t.id += '_' + nowIso.replace(/\D/g, '').slice(-8); }
      } else if (pos) {
        t = mergeImported(t, swingFromMcpPosition(pos));
      }
      for (const h of legsRows) {
        const lot = opts.lotSizeOf ? opts.lotSizeOf(normalizeSymbol(h.symbolName), pos) : null;
        if (!lot) { out.missingLot.add(normalizeSymbol(h.symbolName)); continue; }
        const leg = legFromMcpHistory(h, lot);
        if (leg) t = addLeg(t, leg).trade;
      }
      if (pos) {
        t = reconcileOpenVolume(t, pos).trade;
        t = applyMcpPosition(t, pos, nowLocal).trade;
      } else if ((t.exits || []).length && (t.importedFields || []).includes('volume')) {
        // pozice už není otevřená → celý objem = součet nohou
        const total = round(exitsVolume(t), 8);
        if (num(t.volume) !== total || t.volumeFromLegs) { t = { ...t, volume: total }; delete t.volumeFromLegs; }
      }
      // nová pozice jen z historie, ze které nešla přidat žádná noha (neznámý lot) → nezakládat
      if (idx < 0 && !pos && !(t.exits || []).length) continue;
      if (JSON.stringify(t) === before) continue;
      t = { ...t, updatedAt: nowIso };
      if (idx >= 0) { rows[idx] = t; if (before === 'null') out.created++; else out.updated++; }
      else { rows.push(t); byPid.set(pid, rows.length - 1); out.created++; }
    }
    return out;
  }

  return {
    planMcpSync, sameLeg, legFromMcpHistory, swingFromMcpPosition, swingFromMcpHistory, addLeg, reconcileOpenVolume, mcpActiveAccountCheck,
    IMPORT_FIELDS, swingFromCtraderEvent, mergeImported, applyCtraderClose, findPairCandidate, applyMcpPosition, dropEditedImportedFields,
    JOURNAL_TYPES, JOURNAL_TYPE_VERSION, JOURNAL_TYPE_LABELS, journalTypeOf, isSwingType, isSwingRecord,
    DEFAULT_CFD_INSTRUMENTS, ASSET_CLASSES, CURRENCIES, instrumentsOf, findInstrument, sanitizeInstrument, normalizeSymbol,
    EXIT_REASONS, EXIT_REASON_LABELS, SL_MOVE_REASONS, SL_MOVE_REASON_LABELS, SWING_SETUP_SUGGESTIONS,
    legPnlNet, status, swingDerived, exitsVolume, exitsVolumeError, slAt, swingMissing, MISSING_LABELS,
    splitLocal, instantOf, berlinNowLocal, swingListDate,
    ORDER_TYPES, sanitizePendingOrder, pendingFromMcp, draftFromPendingOrder
  };
}));
