'use strict';
// Kontext obchodu v2 (docs/ZADANI_KONTEXT.md, část A): dopočty a kontroly nad
// tím, co v obchodu už je. Čisté funkce – NIC se nezapisuje do obchodu, vše se
// počítá při čtení. Chybějící vstup = null, nikdy 0.
//
// SR ŘÁDKY. Stranu (srTarget / srStopLoss) volí Adam a je to VÝZNAM, ne poloha:
// zóna chránící SL leží mezi SL a cenou trhu, takže smí stát i na vstupu nebo
// nad vstupem do longu (cena kolem ní osciluje a limitka se plní právě při
// jejím testu). Proto se strana z ceny nedopočítává ani nehlásí jako chyba.
// Uložené `ticksFromEntry` zůstává kladné, jak bylo; znaménková vzdálenost je
// dopočet `ticksFromEntrySigned` a jde jen z ceny řádku.
//
// BLOKUJE se jen cíl nebo SL na špatné straně vstupu, a jen hodnota zadaná
// ručně – dopočet z výstupu (slDerived, targetLevel1PriceDerived) není vstup;
// SL odvozený z trailu do BE+ leží v zisku oprávněně.
//
// REŽIM je vlastnost deníku (profil `backtest: true`), ne obchodu. Živý deník
// nemá „naživo bych nevzal", backtest nemá „vědomě vynechán". Existující
// hodnoty se nemění – jen se ukážou v Kontrole dat.
//
// Modul se načítá přes <script src> po app/points.js a zároveň jde načíst
// v Node testech.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const points = isNode ? require('./points.js') : root.FJPoints;
  // Číselníky (isLevel u cílů) – app/taxonomy.js se v index.html načítá dřív.
  const taxonomy = () => (isNode ? require('./taxonomy.js') : root.FJTaxonomy);
  const api = factory(points, taxonomy);
  if (isNode) module.exports = api;
  if (root) root.FJContext = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (FJPoints, FJTaxonomy) {

  function num(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function dirOf(side) {
    return FJPoints.directionOf(side);
  }

  function targetPriceOf(trade) {
    return num(trade?.targetLevel1?.price);
  }

  // ---------------------------------------------------------------- SR řádky

  // Dopočty k jednomu SR řádku. `field` je 'srTarget' nebo 'srStopLoss'.
  //   ticksFromEntrySigned  (cena − vstup) × směr / tick: + k cíli, − k SL
  //   ticksFromStop         |cena − SL| / tick, jen u srStopLoss
  //   beyondStop            srStopLoss leží za SL – SL ho nechrání
  //   beyondTarget          srTarget leží za cílem
  //   behindEntry           srTarget leží na ztrátové straně vstupu
  // Příznaky jsou null, když je nejde určit (chybí cena, směr, SL, cíl).
  function srRowMetrics(field, row, trade, tickSize) {
    const price = num(row?.price);
    const entry = num(trade?.entryPrice);
    const dir = dirOf(trade?.side);
    const sl = num(trade?.slPrice);
    const target = targetPriceOf(trade);
    const out = { ticksFromEntrySigned: null, ticksFromStop: null, beyondStop: null, beyondTarget: null, behindEntry: null };
    if (price == null) return out;
    if (entry != null && dir != null) {
      out.ticksFromEntrySigned = FJPoints.ticksOf((price - entry) * dir, tickSize);
    }
    if (field === 'srStopLoss') {
      if (sl != null) out.ticksFromStop = FJPoints.ticksOf(Math.abs(price - sl), tickSize);
      if (sl != null && dir != null) out.beyondStop = (price - sl) * dir < 0;
    } else if (field === 'srTarget') {
      if (entry != null && dir != null) out.behindEntry = (price - entry) * dir < 0;
      if (target != null && dir != null) out.beyondTarget = (price - target) * dir > 0;
    }
    return out;
  }

  // Upozornění k řádku ve formuláři. Nic z toho neblokuje uložení.
  // Zóna chránící SL na vstupu nebo nad vstupem do longu se NEHLÁSÍ.
  function srRowNotes(field, row, trade, tickSize) {
    const m = srRowMetrics(field, row, trade, tickSize);
    const notes = [];
    if (m.behindEntry) notes.push('Leží na ztrátové straně vstupu – do cesty k cíli nepatří.');
    if (m.beyondTarget) notes.push('Leží až za cílem.');
    if (m.beyondStop) notes.push('Leží za Stop Lossem – SL ji nechrání.');
    return notes;
  }

  // ------------------------------------------------------- dopočty (A3)
  // Všechno se počítá při čtení, nic se neukládá. Chybějící vstup = null.

  function round2(n) {
    return n == null ? null : Math.round(n * 100) / 100;
  }

  function ratio(a, b) {
    return a != null && b != null && b > 0 ? round2(a / b) : null;
  }

  // Ticky od vstupu k ceně cíle 1 (bez znaménka).
  function targetTicks(trade, tickSize) {
    const entry = num(trade?.entryPrice), target = targetPriceOf(trade);
    if (entry == null || target == null) return null;
    return FJPoints.ticksOf(Math.abs(target - entry), tickSize);
  }

  // Riziko v ticích: |vstup − SL|.
  function slTicks(trade, tickSize) {
    const entry = num(trade?.entryPrice), sl = num(trade?.slPrice);
    if (entry == null || sl == null) return null;
    return FJPoints.ticksOf(Math.abs(entry - sl), tickSize);
  }

  // Leží cíl 1 na skutečné hladině? Rozhoduje vlastnost položky slovníku
  // cílů „je to hladina" (isLevel, uživatelské nastavení). Cena dopočtená
  // z výstupu není hladina, kterou Adam zadal. Bez typu nebo s klíčem, který
  // ve slovníku není, null.
  function targetOnLevel(trade, config) {
    const tax = FJTaxonomy();
    const type = trade?.targetLevel1?.type;
    if (!tax || !type || !tax.isValidKey('TARGET_LEVEL', type, config)) return null;
    if (trade?.targetLevel1PriceDerived === true) return false;
    return tax.isLevelKey(type, config);
  }

  // Cesta k cíli z řádků SR proti targetu (jen řádky s cenou):
  //   FREE             výslovně „žádná hladina", nebo všechny řádky leží
  //                    mimo cestu (za cílem / na ztrátové straně)
  //   BLOCKED          v cestě je hladina dál než 1 t před cílem
  //   TARGET_IS_LEVEL  jediné, co v cestě je, leží do 1 t od cíle
  //   UNKNOWN          nevyplněno, nebo to bez cen nejde určit
  // UNKNOWN nikdy není FREE – proto se u něj ani nepočítá volná cesta v R.
  function pathMetrics(trade, tickSize) {
    const out = { firstObstacleTicks: null, pathState: 'UNKNOWN', freePathR: null };
    const rows = (Array.isArray(trade?.srTarget) ? trade.srTarget : []).filter(r => r && r.level);
    const tgt = targetTicks(trade, tickSize);
    if (!rows.length) {
      if (trade?.srTargetNone === true) {
        out.pathState = 'FREE';
        out.freePathR = ratio(tgt, slTicks(trade, tickSize));
      }
      return out;
    }
    if (tgt == null) return out;
    let unpriced = false, nearTarget = false;
    const obstacles = [];
    for (const row of rows) {
      const m = srRowMetrics('srTarget', row, trade, tickSize);
      if (m.ticksFromEntrySigned == null) { unpriced = true; continue; }
      if (m.behindEntry || m.beyondTarget) continue;
      if (m.ticksFromEntrySigned < tgt - 1) obstacles.push(m.ticksFromEntrySigned);
      else nearTarget = true;
    }
    if (obstacles.length) {
      out.firstObstacleTicks = Math.min(...obstacles);
      out.pathState = 'BLOCKED';
    } else if (nearTarget) out.pathState = 'TARGET_IS_LEVEL';
    else if (!unpriced) out.pathState = 'FREE';
    if (out.pathState !== 'UNKNOWN') out.freePathR = ratio(out.firstObstacleTicks ?? tgt, slTicks(trade, tickSize));
    return out;
  }

  // Zóny chránící SL (jen řádky s cenou, bez těch za SL):
  //   slBufferTicks  o kolik ticků leží SL za nejbližší zónou
  //   slZoneCount    kolik vrstev ochrany je mezi SL a trhem
  // Zóna nad vstupem do longu se počítá stejně jako pod ním. Výslovně
  // „žádná" = 0 zón; nevyplněno nebo bez cen = null.
  function slZoneMetrics(trade, tickSize) {
    const rows = (Array.isArray(trade?.srStopLoss) ? trade.srStopLoss : []).filter(r => r && r.level);
    if (!rows.length) return { slBufferTicks: null, slZoneCount: trade?.srStopLossNone === true ? 0 : null };
    const valid = [];
    let priced = 0;
    for (const row of rows) {
      const m = srRowMetrics('srStopLoss', row, trade, tickSize);
      if (m.ticksFromStop == null || m.beyondStop == null) continue;
      priced++;
      if (!m.beyondStop) valid.push(m.ticksFromStop);
    }
    if (!priced) return { slBufferTicks: null, slZoneCount: null };
    return { slBufferTicks: valid.length ? Math.min(...valid) : null, slZoneCount: valid.length };
  }

  // Pořadí obchodu v rámci deníku a dne. Počítá se při čtení nad celým
  // deníkem, takže se po smazání nebo doimportu obchodu přepočítá samo.
  // Do pořadí patří jen skutečně naplněné obchody (ne setup bez vstupu, ne
  // hypotetický NO_FILL / MISSED / SKIPPED); „naživo bych nevzal" ano.
  function countsInDay(t) {
    return !!(t && t.date && t.recordType !== 'SETUP_ONLY' && (!t.fillStatus || t.fillStatus === 'FILLED'));
  }

  // Stejné pravidlo jako signed() v index.html: pnlRaw má přednost.
  function signedPnl(t) {
    if (t.pnlRaw !== undefined && t.pnlRaw !== null && t.pnlRaw !== '') return Number(t.pnlRaw) || 0;
    const v = Number(t.pnl || 0);
    if (t.result === 'breakeven') return 0;
    return t.result === 'target' ? v : -v;
  }

  function dayOrder(trades, pnlOf = signedPnl) {
    const byDay = new Map();
    for (const t of (Array.isArray(trades) ? trades : [])) {
      if (!countsInDay(t)) continue;
      if (!byDay.has(t.date)) byDay.set(t.date, []);
      byDay.get(t.date).push(t);
    }
    const out = new Map();
    for (const list of byDay.values()) {
      list.sort((a, b) => String(a.entryTime || '').localeCompare(String(b.entryTime || '')) || String(a.id || '').localeCompare(String(b.id || '')));
      let before = 0;
      list.forEach((t, i) => {
        out.set(t.id, { tradeNoInDay: i + 1, prevResultInDay: i ? (list[i - 1].result || null) : 'FIRST', dayPnlBefore: round2(before) });
        before += pnlOf(t);
      });
    }
    return out;
  }

  // Seance z času vstupu. Časy v deníku jsou Europe/Berlin; hranice US seancí
  // se počítají v newyorském čase (US open 9:30 ET), aby seděly i v týdnech,
  // kdy USA a Evropa nemají letní čas souběžně. Evropská seance zůstává
  // v berlínském čase. Vše ostatní je EVENING_OTHER (BACKTEST_MODE_SPEC §4.4).
  const BERLIN = 'Europe/Berlin', NEW_YORK = 'America/New_York';
  const SESSIONS = [
    { key: 'EU_MORNING', tz: BERLIN, from: '08:00', to: '13:30' },
    { key: 'US_OPEN', tz: NEW_YORK, from: '09:30', to: '11:00' },
    { key: 'US_MID', tz: NEW_YORK, from: '11:00', to: '13:30' },
    { key: 'US_CLOSE', tz: NEW_YORK, from: '13:30', to: '16:00' }
  ];
  const SESSION_OTHER = 'EVENING_OTHER';

  const zoneFormatters = {};
  function zoneParts(ms, tz) {
    const f = zoneFormatters[tz] || (zoneFormatters[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = Number(part.value);
    return p;
  }
  function zoneOffset(ms, tz) {
    const p = zoneParts(ms, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }

  // Okamžik (ms UTC) z data a času v berlínském čase; null, když nejde přečíst.
  function berlinInstant(date, time) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(time || '').trim());
    if (!d || !t) return null;
    const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], +(t[3] || 0));
    let ms = guess - zoneOffset(guess, BERLIN);
    ms = guess - zoneOffset(ms, BERLIN);
    return ms;
  }

  function sessionOf(date, time) {
    const ms = berlinInstant(date, time);
    if (ms == null) return null;
    const hhmm = {};
    for (const tz of [BERLIN, NEW_YORK]) {
      const p = zoneParts(ms, tz);
      hhmm[tz] = String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0');
    }
    const hit = SESSIONS.find(s => hhmm[s.tz] >= s.from && hhmm[s.tz] < s.to);
    return hit ? hit.key : SESSION_OTHER;
  }

  // Všechny dopočty jednoho obchodu najednou – pro UI, CSV i AI export.
  //   tickSize  velikost ticku instrumentu (šablona / vestavěná tabulka)
  //   config    úprava číselníků deníku (isLevel)
  //   dayOrder  výsledek dayOrder() nad celým deníkem (bez něj null)
  //   mode      režim deníku (gradeRetro)
  function derivedFields(trade, opts = {}) {
    const tick = opts.tickSize;
    const order = opts.dayOrder && trade ? opts.dayOrder.get(trade.id) : null;
    const rowsOf = field => (Array.isArray(trade?.[field]) ? trade[field] : []).map(r => srRowMetrics(field, r, trade, tick));
    return {
      targetTicks: targetTicks(trade, tick),
      slTicks: slTicks(trade, tick),
      targetOnLevel: targetOnLevel(trade, opts.config),
      ...pathMetrics(trade, tick),
      ...slZoneMetrics(trade, tick),
      tradeNoInDay: order ? order.tradeNoInDay : null,
      prevResultInDay: order ? order.prevResultInDay : null,
      dayPnlBefore: order ? order.dayPnlBefore : null,
      session: sessionOf(trade?.date, trade?.entryTime),
      gradeRetro: gradeRetro(trade, opts.mode),
      srTarget: rowsOf('srTarget'),
      srStopLoss: rowsOf('srStopLoss')
    };
  }

  // ------------------------------------------------------- známka A/B/C (A4)
  // Deník neumí ověřit, že známka vznikla před vstupem. Proto:
  //   gradeSetAt   čas PRVNÍHO zadání (ISO), dál se nemění
  //   gradeEdited  true při každé další změně (i smazání) – „změněno dodatečně"
  //   gradeRetro   dopočet: zadáno až po výstupu (viz gradeRetro níž)
  // `obj` je ukládaný obchod, `existing` jeho dosavadní stav. Vrací `obj`.
  function applyGrade(obj, existing, grade, nowIso) {
    const prev = existing?.grade || '';
    const next = grade || '';
    if (existing?.gradeSetAt) obj.gradeSetAt = existing.gradeSetAt; else delete obj.gradeSetAt;
    if (existing?.gradeEdited === true) obj.gradeEdited = true; else delete obj.gradeEdited;
    if (next) obj.grade = next; else delete obj.grade;
    if (next === prev) return obj;
    if (!obj.gradeSetAt) {
      if (next) obj.gradeSetAt = nowIso;
    } else {
      obj.gradeEdited = true;
    }
    return obj;
  }

  // Známka doplněná zpětně: zadaná až po čase výstupu. V backtest deníku je čas
  // výstupu čas REPLAYE (minulost), takže by vyšla „zpětně" pokaždé – tam se
  // nedá ověřit nic a výsledek je null („nejde ověřit"), nikdy false.
  function gradeRetro(trade, mode) {
    if (mode === MODES.BACKTEST || !trade?.grade || !trade?.gradeSetAt) return null;
    const set = Date.parse(trade.gradeSetAt);
    const exit = berlinInstant(trade.date, trade.exitTime || trade.entryTime);
    if (!Number.isFinite(set) || exit == null) return null;
    return set > exit;
  }

  // ------------------------------------------------------- kontext dne (A5)
  // Jednou za den a deník, uložený v dayNotes[date].dayContext (ne jako nová
  // top-level entita – readJournal() je whitelist). Ranní pole se vyplňují
  // před obchodováním, večerní po něm / po replayi.
  const DAY_TYPE = {
    TREND_UP: 'Trend nahoru', TREND_DOWN: 'Trend dolů', BALANCE_D: 'Balance (D)', P: 'P profil', b: 'b profil',
    DOUBLE_DIST: 'Dvojitá distribuce', UNKNOWN: 'Nevím'
  };
  const DAY_CONTEXT = {
    openVsValue: { IN_VA: 'Open ve value', ABOVE_VAH: 'Open nad VAH', BELOW_VAL: 'Open pod VAL', GAP_UP: 'Gap nahoru', GAP_DOWN: 'Gap dolů' },
    dayTypeExpected: DAY_TYPE,
    dayTypeActual: DAY_TYPE,
    valueMigration: { HIGHER: 'Výš', LOWER: 'Níž', OVERLAP: 'Překryv' },
    newsEvent: { NONE: 'Bez zpráv', CPI: 'CPI', FOMC: 'FOMC', NFP: 'NFP', OTHER: 'Jiné zprávy' }
  };
  const DAY_CONTEXT_LABELS = {
    openVsValue: 'Open vůči value', dayTypeExpected: 'Typ dne – očekávaný', dayTypeActual: 'Typ dne – skutečný',
    valueMigration: 'Migrace value', newsEvent: 'Zprávy'
  };
  const DAY_CONTEXT_MORNING = ['openVsValue', 'dayTypeExpected', 'newsEvent'];
  const DAY_CONTEXT_EVENING = ['dayTypeActual', 'valueMigration'];

  // Jen známá pole se známou hodnotou; nic vyplněno = null.
  function sanitizeDayContext(value) {
    const out = {};
    for (const key of Object.keys(DAY_CONTEXT)) {
      const v = value && typeof value === 'object' ? value[key] : undefined;
      if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(DAY_CONTEXT[key], v)) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  const SESSION_LABELS = {
    EU_MORNING: 'EU dopoledne', US_OPEN: 'US open', US_MID: 'US poledne', US_CLOSE: 'US závěr', EVENING_OTHER: 'mimo hlavní seance'
  };
  const PATH_LABELS = {
    FREE: 'cesta k cíli volná', BLOCKED: 'v cestě hladina', TARGET_IS_LEVEL: 'cíl je jediná hladina v cestě', UNKNOWN: 'cesta nezadaná'
  };

  // Krátké shrnutí dopočtů pro formulář a kartu obchodu. Co nejde spočítat,
  // se vynechá – nic se nedoplňuje odhadem.
  function derivedSummaryParts(d) {
    if (!d) return [];
    const parts = [];
    if (d.pathState === 'BLOCKED') parts.push(`${PATH_LABELS.BLOCKED} ${d.firstObstacleTicks} t od vstupu`);
    else if (d.pathState && d.pathState !== 'UNKNOWN') parts.push(PATH_LABELS[d.pathState]);
    if (d.freePathR != null) parts.push(`volná cesta ${d.freePathR} R`);
    if (d.targetOnLevel === false) parts.push('cíl není hladina');
    if (d.slZoneCount === 0) parts.push('SL bez chránící zóny');
    else if (d.slBufferTicks != null) parts.push(`SL ${d.slBufferTicks} t za zónou` + (d.slZoneCount > 1 ? ` (${d.slZoneCount} zóny)` : ''));
    if (d.tradeNoInDay != null) parts.push(`${d.tradeNoInDay}. obchod dne`);
    if (d.session) parts.push(SESSION_LABELS[d.session] || d.session);
    return parts;
  }

  // ------------------------------------------------------- blokující pravidla

  // Cíl musí ležet na ziskové straně vstupu, SL na ztrátové (obojí striktně –
  // cíl ani SL na ceně vstupu nedávají smysl). Bez směru nebo vstupu se
  // nekontroluje nic. Dopočtené hodnoty se nekontrolují.
  function blockingIssues(trade) {
    // Setup bez vstupu (SETUP_ONLY) má jen plánovaný vstup.
    const entry = num(trade?.entryPrice) ?? num(trade?.plannedEntryPrice);
    const dir = dirOf(trade?.side);
    if (entry == null || dir == null) return [];
    const sideWord = dir > 0 ? 'long' : 'short';
    const issues = [];
    const target = targetPriceOf(trade);
    if (target != null && trade?.targetLevel1PriceDerived !== true && (target - entry) * dir <= 0) {
      issues.push({
        field: 'targetLevel1Price', code: 'TARGET_WRONG_SIDE',
        message: `Cena targetu ${target} neleží na ziskové straně vstupu (${sideWord} z ${entry}).`
      });
    }
    const sl = num(trade?.slPrice);
    if (sl != null && trade?.slDerived !== true && (sl - entry) * dir >= 0) {
      issues.push({
        field: 'slPrice', code: 'SL_WRONG_SIDE',
        message: `Cena Stop Lossu ${sl} neleží na ztrátové straně vstupu (${sideWord} z ${entry}).`
      });
    }
    return issues;
  }

  // -------------------------------------------------------------- režim deníku

  const MODES = { LIVE: 'LIVE', BACKTEST: 'BACKTEST' };

  function journalMode(profile) {
    return profile && profile.backtest === true ? MODES.BACKTEST : MODES.LIVE;
  }

  // „Naživo bych nevzal" má smysl jen v backtestu (vzato jen kvůli měření).
  function skipLiveAllowed(mode) {
    return mode === MODES.BACKTEST;
  }

  // Volby stavu naplnění pro režim. Backtest nenabízí „vědomě vynechán" –
  // v replayi se setup dá vzít vždy. Záznam, který SKIPPED už má (`keep`),
  // ho v nabídce vidí dál, jinak by ho editace tiše zahodila.
  function allowedFillStatus(mode, keys, keep) {
    const list = Array.isArray(keys) ? keys : [];
    if (mode !== MODES.BACKTEST) return list.slice();
    return list.filter(k => k !== 'SKIPPED' || keep === 'SKIPPED');
  }

  // ------------------------------------------------------------ Kontrola dat

  const DATA_CHECK_LABELS = {
    TARGET_WRONG_SIDE: 'cíl na ztrátové straně vstupu',
    SL_WRONG_SIDE: 'SL na ziskové straně vstupu',
    SKIP_LIVE_IN_LIVE: 'naživo bych nevzal v živém deníku',
    SKIPPED_IN_BACKTEST: 'vědomě vynechán v backtest deníku'
  };

  // Co má Adam v záznamu zkontrolovat a ručně opravit. Nic se neopravuje samo.
  function dataCheckIssues(trade, mode) {
    const issues = blockingIssues(trade).map(i => ({ code: i.code, message: i.message }));
    if (trade?.wouldSkipLive === true && mode !== MODES.BACKTEST) {
      issues.push({ code: 'SKIP_LIVE_IN_LIVE', message: '„Naživo bych nevzal" je zapnuté v živém deníku.' });
    }
    if (trade?.fillStatus === 'SKIPPED' && mode === MODES.BACKTEST) {
      issues.push({ code: 'SKIPPED_IN_BACKTEST', message: 'Stav „vědomě vynechán" v backtest deníku.' });
    }
    return issues;
  }

  function dataCheckLabel(code) {
    return DATA_CHECK_LABELS[code] || code;
  }

  // ------------------------------------------- přepínače „včetně …" podle režimu
  // „Naživo bych nevzal" patří jen do backtestu, „vědomě vynechán" jen do
  // živého deníku. Kde skupina nepatří, přepínač se neukazuje – leda by tam
  // takové záznamy přesto byly (starší data, Kontrola dat): pak zůstane vidět
  // s počtem neplatných, aby je šlo započítat. Čísla se tím nemění, přepínač
  // dál jen říká, jestli se skupina počítá do výkonu. `journals` = zobrazené
  // deníky [{ mode, records }], records = obchody (bez setupů bez vstupu).
  const INCLUDE_VALID_MODE = { skipLive: MODES.BACKTEST, skipped: MODES.LIVE };
  const INCLUDE_TEST = {
    skipLive: t => t?.wouldSkipLive === true,
    skipped: t => t?.fillStatus === 'SKIPPED'
  };

  function includeToggleState(key, journals) {
    const valid = INCLUDE_VALID_MODE[key];
    if (!valid) return { show: true, invalidCount: 0 };
    let validMode = false;
    let invalidCount = 0;
    for (const j of (Array.isArray(journals) ? journals : [])) {
      if (j?.mode === valid) { validMode = true; continue; }
      invalidCount += (Array.isArray(j?.records) ? j.records : []).filter(INCLUDE_TEST[key]).length;
    }
    return { show: validMode || invalidCount > 0, invalidCount };
  }

  function includeInvalidNote(key, count) {
    if (!count || !INCLUDE_VALID_MODE[key]) return '';
    return `${count}× neplatné v ${INCLUDE_VALID_MODE[key] === MODES.BACKTEST ? 'živém' : 'backtest'} deníku`;
  }

  return {
    MODES, dirOf,
    srRowMetrics, srRowNotes, blockingIssues,
    targetTicks, slTicks, targetOnLevel, pathMetrics, slZoneMetrics,
    countsInDay, signedPnl, dayOrder, SESSIONS, sessionOf, berlinInstant, derivedFields,
    SESSION_LABELS, PATH_LABELS, derivedSummaryParts, applyGrade, gradeRetro,
    DAY_CONTEXT, DAY_CONTEXT_LABELS, DAY_CONTEXT_MORNING, DAY_CONTEXT_EVENING, sanitizeDayContext,
    journalMode, skipLiveAllowed, allowedFillStatus,
    dataCheckIssues, dataCheckLabel, DATA_CHECK_LABELS,
    includeToggleState, includeInvalidNote
  };
}));
