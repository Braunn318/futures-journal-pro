'use strict';
// Data trhu – minutové svíčky celé seance dne obchodu (J2).
//
// Konektor NT8 (verze 5) si požadavky vyzvedává (GET /api/v1/market/requests)
// a odpovídá zprávou market_bars. Tady jsou jen čisté funkce: kontrola zprávy,
// pravidlo přepisu, fronta požadavků a plán zpětného doplnění.
//
// Svíčky se ukládají bez dopočtů (žádný VPOC, žádné pásmo). Čas svíčky `t` =
// její konec (jako v NT8), ISO UTC. V Playbacku vrací NinjaTrader jen
// přehrávaný den, i když se žádá jiný (docs/SNAPSHOT_DISCOVERY.md) – proto se
// každá svíčka kontroluje proti seanci, kterou konektor hledal.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJMarketBars = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const FILE_VERSION = 1;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  // Den je úplný, když poslední svíčka končí nejvýš 5 minut před koncem seance.
  const COMPLETE_SLACK_MS = 5 * 60000;

  const num = v => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN));

  function rootOf(instrument) {
    return String(instrument || '').trim().toUpperCase().split(/\s+/)[0] || '';
  }

  // Zpráva market_bars → { ok, data, dropped } nebo { ok:false, error }.
  function normalizeBarsPayload(p, receivedAt) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'invalid' };
    if (p.error) return { ok: false, error: String(p.error).slice(0, 200) };
    const root = rootOf(p.root || p.instrumentFull);
    const day = String(p.day || '');
    const begin = Date.parse(p.sessionBegin);
    const end = Date.parse(p.sessionEnd);
    if (!root || !DAY_RE.test(day) || !Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) return { ok: false, error: 'invalid' };
    const list = Array.isArray(p.bars) ? p.bars : [];
    const byTime = new Map();
    let dropped = 0;
    for (const b of list) {
      const raw = Array.isArray(b) ? { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] } : (b || {});
      const t = Date.parse(raw.t);
      const o = num(raw.o), h = num(raw.h), l = num(raw.l), c = num(raw.c), v = num(raw.v);
      const valid = Number.isFinite(t) && [o, h, l, c].every(x => Number.isFinite(x) && x > 0) && Number.isFinite(v) && v >= 0;
      // Svíčka končící přesně začátkem seance patří předchozí seanci.
      if (!valid || t <= begin || t > end) { dropped++; continue; }
      byTime.set(t, { t: new Date(t).toISOString(), o, h, l, c, v });
    }
    if (!byTime.size) return { ok: false, error: list.length ? 'out_of_range' : 'empty' };
    const bars = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    dropped += list.length - dropped - bars.length;
    return {
      ok: true,
      dropped,
      data: {
        v: FILE_VERSION,
        root,
        instrumentFull: String(p.instrumentFull || ''),
        day,
        tradingHours: String(p.tradingHours || ''),
        timeZone: String(p.timeZone || ''),
        sessionBegin: new Date(begin).toISOString(),
        sessionEnd: new Date(end).toISOString(),
        receivedAt: receivedAt || new Date().toISOString(),
        source: 'ninjatrader',
        bars
      }
    };
  }

  // Přepis jen tehdy, když přibyly svíčky (delší soubor se nikdy nenahradí kratším).
  function shouldReplace(current, next) {
    if (!next || !Array.isArray(next.bars)) return false;
    const have = Array.isArray(current?.bars) ? current.bars.length : 0;
    return next.bars.length > have;
  }

  function isComplete(data) {
    if (!data || !Array.isArray(data.bars) || !data.bars.length) return false;
    const last = Date.parse(data.bars[data.bars.length - 1].t);
    const end = Date.parse(data.sessionEnd);
    return Number.isFinite(last) && Number.isFinite(end) && last >= end - COMPLETE_SLACK_MS;
  }

  // Fronta požadavků pro konektor. Požadavek = kořen + den (+ kontrakt a čas
  // uvnitř seance). Rozdaný požadavek bez odpovědi se po `timeoutMs` vrátí do
  // fronty, po `maxTries` pokusech je chyba „timeout".
  function createMarketQueue({ now = () => Date.now(), timeoutMs = 180000, maxTries = 2, limit = 5000 } = {}) {
    const items = [];
    let seq = 0;
    const active = it => it.state === 'pending' || it.state === 'inflight';

    function enqueue(req, batch = null) {
      const root = rootOf(req?.root || req?.instrumentFull);
      const day = String(req?.day || '');
      if (!root || !DAY_RE.test(day)) return null;
      const same = items.find(it => active(it) && it.root === root && it.day === day);
      if (same) {
        if (!same.instrumentFull && req.instrumentFull) same.instrumentFull = String(req.instrumentFull);
        return same;
      }
      const it = {
        id: 'm' + now().toString(36) + '-' + (++seq).toString(36),
        root, day,
        instrumentFull: String(req.instrumentFull || ''),
        time: String(req.time || ''),
        reason: String(req.reason || ''),
        batch, state: 'pending', tries: 0, takenAt: null, error: null
      };
      items.push(it);
      if (items.length > limit) {
        const idx = items.findIndex(x => !active(x));
        if (idx >= 0) items.splice(idx, 1);
      }
      return it;
    }

    function expire() {
      const t = now();
      for (const it of items) {
        if (it.state !== 'inflight' || t - it.takenAt < timeoutMs) continue;
        if (it.tries >= maxTries) { it.state = 'failed'; it.error = 'timeout'; }
        else it.state = 'pending';
      }
    }

    function take(max = 1) {
      expire();
      const out = [];
      for (const it of items) {
        if (out.length >= max) break;
        if (it.state !== 'pending') continue;
        it.state = 'inflight';
        it.tries += 1;
        it.takenAt = now();
        out.push(it);
      }
      return out;
    }

    function done(id, ok, error) {
      const it = items.find(x => x.id === id);
      if (!it || !active(it)) return null;
      it.state = ok ? 'done' : 'failed';
      it.error = ok ? null : String(error || 'error');
      return it;
    }

    function cancelBatch(batch) {
      let n = 0;
      for (const it of items) if (it.batch === batch && it.state === 'pending') { it.state = 'cancelled'; n++; }
      return n;
    }

    function progress(batch) {
      expire();
      const list = batch === undefined ? items : items.filter(it => it.batch === batch);
      const p = { total: list.length, done: 0, failed: 0, pending: 0, inflight: 0, cancelled: 0, errors: {} };
      for (const it of list) {
        p[it.state] += 1;
        if (it.state === 'failed') p.errors[it.error] = (p.errors[it.error] || 0) + 1;
      }
      return p;
    }

    function get(id) { return items.find(x => x.id === id) || null; }

    return { enqueue, take, done, cancelBatch, progress, get };
  }

  // Den YYYY-MM-DD → čas uvnitř seance (poledne místního dne) pro konektor.
  function timeForDay(day) {
    const [y, m, d] = String(day).split('-').map(Number);
    return new Date(y, m - 1, d, 12).toISOString();
  }

  // Zpětné doplnění: dny s obchody (po kořenech) a dny archivu LTA levelů
  // (pro kořeny, které uživatel obchoduje). Bez swingových obchodů, bez dnů
  // s úplným souborem a bez dnů po dnešku. Nejnovější první.
  function planBackfill({ trades = [], archiveDays = [], stored = {}, today } = {}) {
    const days = new Map(); // root → Set(day)
    const add = (root, day) => {
      if (!root || !DAY_RE.test(day) || (today && day > today)) return;
      if (!days.has(root)) days.set(root, new Set());
      days.get(root).add(day);
    };
    for (const t of trades) {
      if (!t || t.kind === 'SWING') continue;
      add(rootOf(t.instrument), String(t.date || ''));
    }
    for (const root of [...days.keys()]) for (const d of archiveDays) add(root, String(d));
    const out = [];
    for (const [root, set] of days) {
      for (const day of set) if (stored[root + '|' + day] !== true) out.push({ root, day, time: timeForDay(day) });
    }
    return out.sort((a, b) => (a.day === b.day ? a.root.localeCompare(b.root) : b.day.localeCompare(a.day)));
  }

  // Odpověď pro konektor: jeden požadavek na řádek, pole oddělená tabulátorem
  // (id, kořen, kontrakt, den, čas uvnitř seance) – C# nemusí parsovat JSON.
  function requestsText(list) {
    const clean = v => String(v || '').replace(/[\t\r\n]/g, ' ');
    return (list || []).map(r => [r.id, r.root, r.instrumentFull, r.day, r.time].map(clean).join('\t') + '\n').join('');
  }

  return { FILE_VERSION, rootOf, normalizeBarsPayload, shouldReplace, isComplete, createMarketQueue, timeForDay, planBackfill, requestsText };
}));
