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
  const points = (typeof module !== 'undefined' && module.exports) ? require('./points.js') : root.FJPoints;
  const api = factory(points);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJContext = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (FJPoints) {

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

  return {
    MODES, dirOf,
    srRowMetrics, srRowNotes, blockingIssues,
    journalMode, skipLiveAllowed, allowedFillStatus,
    dataCheckIssues, dataCheckLabel, DATA_CHECK_LABELS
  };
}));
