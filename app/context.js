'use strict';
// Kontext obchodu (docs/ZADANI_KONTEXT.md část A, revize ZADANI_KONTEXT_V3.md):
// dopočty a kontroly nad tím, co v obchodu už je. Čisté funkce – NIC se
// nezapisuje do obchodu, vše se počítá při čtení. Chybějící vstup = null,
// nikdy 0.
//
// HLADINY V BLÍZKOSTI (v3). Deník o hladinách nic NEPOSUZUJE, jen měří. Jeden
// seznam řádků { level, price, testState? }; stranu ani roli uživatel nevolí.
// Dopočty jsou čistá geometrie v ticích (kladný směr = směr obchodu): žádná
// tolerance, žádné pásmo, žádná konstanta. Co hladina v obchodu dělá (chrání
// SL, brzdí cenu, kolik ticků nad vstupem ještě „patří ke vstupu"), má vyjít
// statisticky v Backtest Labu, ne z pravidla tady. Tvar řádků a převod starého
// zápisu (dva seznamy proti targetu / proti S/L) drží app/taxonomy.js.
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

  // ------------------------------------------- hladiny v blízkosti (v3 A3)
  // Jen geometrie. Kladný směr = směr obchodu (k cíli).

  // Poloha ceny vůči vstupu v ticích, + ve směru obchodu. Null bez ceny,
  // vstupu, směru nebo velikosti ticku. (`+ 0` srovná zápornou nulu.)
  function offsetFromEntry(price, trade, tickSize) {
    const p = num(price), entry = num(trade?.entryPrice), dir = dirOf(trade?.side);
    if (p == null || entry == null || dir == null) return null;
    const ticks = FJPoints.ticksOf((p - entry) * dir, tickSize);
    return ticks == null ? null : ticks + 0;
  }

  function roundTicks(n) {
    return Math.round(n * 10000) / 10000 + 0;
  }

  // Geometrie jednoho řádku hladiny:
  //   fromEntry  vzdálenost od vstupu, + ve směru obchodu. Řádek bez ceny
  //              (starší zápis): ±ticksFromEntry podle legacySide
  //   fromStop   vzdálenost od SL, + na straně vstupu, − za SL
  //   toTarget   vzdálenost do cíle 1, + před cílem, − za ním
  //   position   úsek, ve kterém hladina leží – čistě podle ceny. Hladina
  //              přesně na ceně SL nebo cíle patří ještě dovnitř úseku,
  //              AT_ENTRY je jen přesná nula.
  // Co nejde určit (chybí cena i ticky, směr, tick, SL resp. cíl), je null.
  const POSITIONS = ['BEYOND_STOP', 'STOP_TO_ENTRY', 'AT_ENTRY', 'ENTRY_TO_TARGET', 'BEYOND_TARGET'];

  function levelGeometry(row, trade, tickSize) {
    const out = { fromEntry: null, fromStop: null, toTarget: null, position: null };
    let fromEntry = null;
    if (num(row?.price) != null) {
      fromEntry = offsetFromEntry(row.price, trade, tickSize);
    } else {
      const ticks = num(row?.ticksFromEntry);
      if (ticks != null && row.legacySide === 'TG') fromEntry = Math.abs(ticks);
      else if (ticks != null && row.legacySide === 'SL') fromEntry = -Math.abs(ticks) + 0;
    }
    if (fromEntry == null) return out;
    const stop = offsetFromEntry(trade?.slPrice, trade, tickSize);
    const target = offsetFromEntry(targetPriceOf(trade), trade, tickSize);
    out.fromEntry = fromEntry;
    if (stop != null) out.fromStop = roundTicks(fromEntry - stop);
    if (target != null) out.toTarget = roundTicks(target - fromEntry);
    if (fromEntry === 0) out.position = 'AT_ENTRY';
    else if (fromEntry > 0) out.position = out.toTarget == null ? null : (out.toTarget < 0 ? 'BEYOND_TARGET' : 'ENTRY_TO_TARGET');
    else out.position = out.fromStop == null ? null : (out.fromStop < 0 ? 'BEYOND_STOP' : 'STOP_TO_ENTRY');
    return out;
  }

  // Dopočty z hladin na obchodu (`geometry` = levelGeometry všech řádků):
  //   nearestAheadTicks    nejbližší hladina ve směru obchodu před cílem
  //   nearestAheadR        totéž v násobcích rizika (slTicks)
  //   stopBehindTicks      o kolik ticků je SL za nejbližší hladinou mezi SL
  //                        a cílem – počítá se i hladina nad vstupem do longu
  //   levelsStopToEntry, levelsEntryToTarget   počty řádků v úseku
  // Vzdálenosti se berou z řádků, které polohu mají. Počty jsou null, když
  // hladiny nejsou vyplněné NEBO některý řádek polohu nemá (nejde tvrdit,
  // kolik jich kde je); výslovné „žádná hladina v blízkosti" = 0.
  const BETWEEN_STOP_AND_TARGET = ['STOP_TO_ENTRY', 'AT_ENTRY', 'ENTRY_TO_TARGET'];

  function nearLevelMetrics(trade, tickSize, geometry) {
    const tax = FJTaxonomy();
    const rows = Array.isArray(geometry) ? geometry : tax.nearLevelsOf(trade).map(r => levelGeometry(r, trade, tickSize));
    const out = { nearestAheadTicks: null, nearestAheadR: null, stopBehindTicks: null, levelsStopToEntry: null, levelsEntryToTarget: null };
    if (!rows.length) {
      if (tax.nearLevelsNoneOf(trade)) out.levelsStopToEntry = out.levelsEntryToTarget = 0;
      return out;
    }
    const min = list => (list.length ? Math.min(...list) : null);
    out.nearestAheadTicks = min(rows.filter(g => g.position === 'ENTRY_TO_TARGET').map(g => g.fromEntry));
    out.nearestAheadR = ratio(out.nearestAheadTicks, slTicks(trade, tickSize));
    out.stopBehindTicks = min(rows.filter(g => BETWEEN_STOP_AND_TARGET.includes(g.position) && g.fromStop > 0).map(g => g.fromStop));
    if (rows.every(g => g.position != null)) {
      out.levelsStopToEntry = rows.filter(g => g.position === 'STOP_TO_ENTRY').length;
      out.levelsEntryToTarget = rows.filter(g => g.position === 'ENTRY_TO_TARGET').length;
    }
    return out;
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
  //   gradeRetroGraceMin  lhůta „doplněno zpětně“ z nastavení deníku (výchozí 30)
  function derivedFields(trade, opts = {}) {
    const tick = opts.tickSize;
    const order = opts.dayOrder && trade ? opts.dayOrder.get(trade.id) : null;
    // Geometrie řádků ve stejném pořadí jako nearLevels obchodu (starý tvar
    // se čte přes stejný převod jako při migraci).
    const levels = FJTaxonomy().nearLevelsOf(trade).map(r => levelGeometry(r, trade, tick));
    return {
      targetTicks: targetTicks(trade, tick),
      slTicks: slTicks(trade, tick),
      targetOnLevel: targetOnLevel(trade, opts.config),
      ...nearLevelMetrics(trade, tick, levels),
      tradeNoInDay: order ? order.tradeNoInDay : null,
      prevResultInDay: order ? order.prevResultInDay : null,
      dayPnlBefore: order ? order.dayPnlBefore : null,
      session: sessionOf(trade?.date, trade?.entryTime),
      gradeRetro: gradeRetro(trade, opts.mode, opts.gradeRetroGraceMin),
      nearLevels: levels
    };
  }

  // ------------------------------------------------------- známka A/B/C (A4)
  // Deník neumí ověřit, že známka vznikla před vstupem. Proto:
  //   gradeSetAt   čas PRVNÍHO zadání (ISO), dál se nemění
  //   gradeEdited  true při každé další změně (i smazání) – „změněno dodatečně"
  //   gradeRetro   dopočet: zadáno až po lhůtě od uložení obchodu (viz gradeRetro níž)
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

  // Známka doplněná zpětně: zadaná až po LHŮTĚ od uložení obchodu do deníku.
  // Importovaný obchod v deníku vznikne teprve výstupem, takže známku dřív
  // zadat nejde – pravidlo „po čase výstupu" označilo každý takový obchod.
  //   uložení  createdAt (import / první ruční uložení). U pozice s víc cíli je
  //            createdAt čas PRVNÍHO cíle, proto se bere pozdější z createdAt
  //            a času posledního výstupu. Bez createdAt (starší data) jen výstup.
  //   lhůta    nastavení deníku gradeRetroGraceMinutes, výchozí 30 minut;
  //            0 = hned po uložení.
  // V backtest deníku je čas výstupu čas REPLAYE (minulost) – tam se nedá
  // ověřit nic a výsledek je null („nejde ověřit"), nikdy false.
  const GRADE_RETRO_GRACE_MIN = 30;

  function gradeRetroGrace(value) {
    const n = num(value);
    return n != null && n >= 0 ? n : GRADE_RETRO_GRACE_MIN;
  }

  function gradeRetro(trade, mode, graceMinutes) {
    if (mode === MODES.BACKTEST || !trade?.grade || !trade?.gradeSetAt) return null;
    const set = Date.parse(trade.gradeSetAt);
    const exit = berlinInstant(trade.date, trade.exitTime || trade.entryTime);
    const created = num(trade.createdAt);
    const saved = Math.max(created != null && created > 0 ? created : -Infinity, exit != null ? exit : -Infinity);
    if (!Number.isFinite(set) || !Number.isFinite(saved)) return null;
    return set > saved + gradeRetroGrace(graceMinutes) * 60000;
  }

  // ------------------------------------------------------- kontext dne (A5)
  // Jednou za den a deník, uložený v dayNotes[date].dayContext (ne jako nová
  // top-level entita – readJournal() je whitelist). Ranní pole se vyplňují
  // před obchodováním, večerní po něm / po replayi.
  //
  // Volby polí jsou číselníky deníku (app/taxonomy.js, Nastavení → Číselníky):
  // uživatel je přejmenuje, skryje, přeřadí a přidá vlastní. Očekávaný
  // i skutečný typ dne berou z jednoho seznamu. V datech je vždy klíč.
  const DAY_CONTEXT_GROUPS = {
    openVsValue: 'DAY_OPEN', dayTypeExpected: 'DAY_TYPE', dayTypeActual: 'DAY_TYPE',
    valueMigration: 'DAY_VALUE_MIGRATION', newsEvent: 'DAY_NEWS'
  };
  const DAY_CONTEXT_FIELDS = Object.keys(DAY_CONTEXT_GROUPS);
  // VÝCHOZÍ volby polí (klíč → popisek), bez úprav uživatele. Co je platné
  // a jak se to jmenuje v konkrétním deníku, říkají dayContextOptions /
  // dayContextLabel.
  const DAY_CONTEXT = Object.fromEntries(DAY_CONTEXT_FIELDS.map(field => [field, FJTaxonomy().DEFAULT_ENUMS[DAY_CONTEXT_GROUPS[field]]]));
  const DAY_CONTEXT_LABELS = {
    openVsValue: 'Open vůči value', dayTypeExpected: 'Typ dne – očekávaný', dayTypeActual: 'Typ dne – skutečný',
    valueMigration: 'Migrace value', newsEvent: 'Zprávy'
  };
  const DAY_CONTEXT_MORNING = ['openVsValue', 'dayTypeExpected', 'newsEvent'];
  const DAY_CONTEXT_EVENING = ['dayTypeActual', 'valueMigration'];

  // Nabídka pole: [{ key, label, hidden }] podle číselníku deníku. Skrytá volba
  // se nenabízí, leda by ji den už měl uloženou (`selected`).
  function dayContextOptions(field, selected, config) {
    const group = DAY_CONTEXT_GROUPS[field];
    return group ? FJTaxonomy().visibleOptions(group, selected, config) : [];
  }

  function dayContextLabel(field, key, config) {
    const group = DAY_CONTEXT_GROUPS[field];
    return group && key ? FJTaxonomy().labelOf(group, key, config) : '';
  }

  // Jen známá pole s hodnotou, kterou číselník deníku zná (i skrytou nebo
  // vlastní); nic vyplněno = null.
  function sanitizeDayContext(value, config) {
    const out = {};
    for (const field of DAY_CONTEXT_FIELDS) {
      const v = value && typeof value === 'object' ? value[field] : undefined;
      if (typeof v === 'string' && v && FJTaxonomy().isValidKey(DAY_CONTEXT_GROUPS[field], v, config)) out[field] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  const SESSION_LABELS = {
    EU_MORNING: 'EU dopoledne', US_OPEN: 'US open', US_MID: 'US poledne', US_CLOSE: 'US závěr', EVENING_OTHER: 'mimo hlavní seance'
  };
  // Čísla česky (desetinná čárka) a se znaménkem: + jen na přání, − vždy.
  function cz(n) {
    return String(n).replace('.', ',');
  }
  function signedTicks(n, plus) {
    return (n > 0 && plus ? '+' : n < 0 ? '−' : '') + cz(Math.abs(n));
  }

  // Vzdálenosti jednoho řádku hladiny pro formulář a kartu obchodu, např.
  // „+5 t od vstupu · 3 t od SL · 11 t do cíle". Jen čísla – žádný štítek role.
  function levelDistanceText(g) {
    if (!g) return '';
    const parts = [];
    if (g.fromEntry != null) parts.push(signedTicks(g.fromEntry, true) + ' t od vstupu');
    if (g.fromStop != null) parts.push(signedTicks(g.fromStop) + ' t od SL');
    if (g.toTarget != null) parts.push(signedTicks(g.toTarget) + ' t do cíle');
    return parts.join(' · ');
  }

  // Jeden řádek dopočtů pro formulář a kartu obchodu, např. „Nejbližší hladina
  // ve směru: +5 t (0,5 R) · SL 3 t za VAL · mezi SL a vstupem 2, před cílem 1".
  // Co nejde spočítat, se vynechá – nic se nedoplňuje odhadem.
  // `opts.levelName(i)` vrací popisek i-tého řádku hladin (číselník zná volající).
  function derivedSummaryParts(d, opts = {}) {
    if (!d) return [];
    const parts = [];
    const rows = Array.isArray(d.nearLevels) ? d.nearLevels : [];
    if (d.nearestAheadTicks != null) {
      parts.push('Nejbližší hladina ve směru: ' + signedTicks(d.nearestAheadTicks, true) + ' t' + (d.nearestAheadR != null ? ' (' + cz(d.nearestAheadR) + ' R)' : ''));
    }
    if (d.stopBehindTicks != null) {
      const i = rows.findIndex(g => g.fromStop === d.stopBehindTicks && BETWEEN_STOP_AND_TARGET.includes(g.position));
      const name = i >= 0 && typeof opts.levelName === 'function' ? opts.levelName(i) : '';
      parts.push('SL ' + cz(d.stopBehindTicks) + ' t za ' + (name || 'nejbližší hladinou'));
    }
    if (d.levelsStopToEntry != null && d.levelsEntryToTarget != null) {
      parts.push(rows.length ? 'mezi SL a vstupem ' + d.levelsStopToEntry + ', před cílem ' + d.levelsEntryToTarget : 'žádná hladina v blízkosti');
    }
    if (d.targetOnLevel === false) parts.push('cíl není hladina');
    if (d.tradeNoInDay != null) parts.push(d.tradeNoInDay + '. obchod dne');
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

  // Hromadné odebrání „naživo bych nevzal" v živém deníku – jen na výslovný
  // pokyn uživatele (tlačítko v Kontrole dat). Mění jen záznamy s kódem
  // SKIP_LIVE_IN_LIVE a jen tyto dvě vlastnosti; v backtestu nic.
  // Vrací nové pole (ostatní záznamy stejné objekty) a počet změněných.
  function clearSkipLiveInLive(records, mode) {
    const list = Array.isArray(records) ? records : [];
    if (mode === MODES.BACKTEST) return { records: list, count: 0 };
    let count = 0;
    const out = list.map(r => {
      if (r?.wouldSkipLive !== true) return r;
      count++;
      const next = { ...r };
      delete next.wouldSkipLive;
      delete next.wouldSkipReason;
      return next;
    });
    return { records: out, count };
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

  // Tvar hladin a převod starého zápisu drží app/taxonomy.js; tady jsou jen
  // přeposlané, ať má doménová vrstva kontextu jedno rozhraní (main.js, testy).
  const viaTaxonomy = name => (...args) => FJTaxonomy()[name](...args);
  const CONTEXT_VERSION = 3;

  return {
    MODES, dirOf, CONTEXT_VERSION,
    blockingIssues,
    targetTicks, slTicks, targetOnLevel,
    POSITIONS, levelGeometry, nearLevelMetrics, levelDistanceText,
    nearLevelsFromLegacy: viaTaxonomy('nearLevelsFromLegacy'), nearLevelsOf: viaTaxonomy('nearLevelsOf'),
    nearLevelsNoneOf: viaTaxonomy('nearLevelsNoneOf'), setNearLevels: viaTaxonomy('setNearLevels'),
    convertLegacyNear: viaTaxonomy('convertLegacyNear'), stripRemovedV3: viaTaxonomy('stripRemovedV3'),
    migrateConfigV3: viaTaxonomy('migrateConfigV3'),
    countsInDay, signedPnl, dayOrder, SESSIONS, sessionOf, berlinInstant, derivedFields,
    SESSION_LABELS, derivedSummaryParts, applyGrade, gradeRetro, gradeRetroGrace, GRADE_RETRO_GRACE_MIN,
    DAY_CONTEXT, DAY_CONTEXT_GROUPS, DAY_CONTEXT_FIELDS, DAY_CONTEXT_LABELS, DAY_CONTEXT_MORNING, DAY_CONTEXT_EVENING,
    dayContextOptions, dayContextLabel, sanitizeDayContext,
    journalMode, skipLiveAllowed, allowedFillStatus,
    dataCheckIssues, dataCheckLabel, DATA_CHECK_LABELS, clearSkipLiveInLive,
    includeToggleState, includeInvalidNote
  };
}));
