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
    return { symbol, pipSize: pip, priceDecimals: pip === 0.01 ? 3 : 5, assetClass: 'FX', baseCcy: base, quoteCcy: quote };
  }
  // Výchozí tabulka. Uživatelsky editovatelná (settings.cfdInstruments), uložené hodnoty mají přednost.
  const DEFAULT_CFD_INSTRUMENTS = Object.freeze([
    ...['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'EURGBP', 'EURAUD', 'EURCAD', 'EURCHF', 'EURNZD',
      'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPNZD', 'AUDCAD', 'AUDCHF', 'AUDNZD', 'NZDCAD', 'NZDCHF', 'CADCHF'].map(s => fx(s, 0.0001)),
    ...['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY'].map(s => fx(s, 0.01)),
    { symbol: 'US500', pipSize: 1, priceDecimals: 1, assetClass: 'INDEX', baseCcy: '', quoteCcy: '' },
    { symbol: 'US100', pipSize: 1, priceDecimals: 1, assetClass: 'INDEX', baseCcy: '', quoteCcy: '' },
    { symbol: 'GER40', pipSize: 1, priceDecimals: 1, assetClass: 'INDEX', baseCcy: '', quoteCcy: '' },
    { symbol: 'XAUUSD', pipSize: 0.1, priceDecimals: 2, assetClass: 'COMMODITY', baseCcy: '', quoteCcy: '' },
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
    return {
      symbol,
      pipSize: pipSize != null && pipSize > 0 ? pipSize : null,
      priceDecimals: priceDecimals != null && priceDecimals >= 0 ? Math.round(priceDecimals) : null,
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
      if (i) out.set(i.symbol, { ...i, builtin: DEFAULT_CFD_INSTRUMENTS.some(d => d.symbol === i.symbol) });
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

  return {
    JOURNAL_TYPES, JOURNAL_TYPE_VERSION, JOURNAL_TYPE_LABELS, journalTypeOf, isSwingType, isSwingRecord,
    DEFAULT_CFD_INSTRUMENTS, ASSET_CLASSES, CURRENCIES, instrumentsOf, findInstrument, sanitizeInstrument, normalizeSymbol,
    EXIT_REASONS, EXIT_REASON_LABELS, SL_MOVE_REASONS, SL_MOVE_REASON_LABELS, SWING_SETUP_SUGGESTIONS,
    legPnlNet, status, swingDerived, exitsVolume, exitsVolumeError, slAt, swingMissing, MISSING_LABELS,
    splitLocal, instantOf, berlinNowLocal, swingListDate,
    ORDER_TYPES, sanitizePendingOrder, pendingFromMcp, draftFromPendingOrder
  };
}));
