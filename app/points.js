'use strict';
// Bodová matematika obchodu na jednom místě (spec §3.1, §3.3c).
//
// PROČ SAMOSTATNÝ MODUL: klasifikaci „je uložené `points` na kontrakt, nebo
// celkové?" potřebuje jak migrace, tak testy. V živém deníku má 45 z 86 obchodů
// jednu konvenci a 27 druhou, takže plošný přepočet by těch 27 rozbil. Jedna
// funkce, jedno rozhodnutí, ověřené testem.
//
// CO SE NEMĚNÍ: pole `points` si nechává svůj dosavadní význam – nevážený součet
// bodů nohou, u jednonohého obchodu hodnota na kontrakt. Visí na něm formulářová
// matematika (`recomputePnlFromInputs` počítá `points × contracts × pointValue`),
// `displayPoints`, pilulky nohou i přepočet komisí. Kdyby se `points` přeznačilo
// na celkové body, formulář by násobil počtem kontraktů dvakrát.
// Nová pole `pointsPerContract` a `pointsTotal` stojí VEDLE, ne místo.
//
// Modul se načítá přes <script src> před hlavním skriptem (bundler v projektu
// není) a zároveň jde načíst v Node testech.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJPoints = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Tolerance v penězích, stejná jako v akceptačních kritériích §9.
  const MONEY_TOLERANCE = 0.01;

  const POINTS_CONVENTION = {
    TOTAL: 'TOTAL',                 // uložené `points` = celkové body pozice
    PER_CONTRACT: 'PER_CONTRACT',   // uložené `points` = body na jeden kontrakt
    AMBIGUOUS: 'AMBIGUOUS',         // 1 kontrakt – obojí je totéž
    INCONSISTENT: 'INCONSISTENT',   // neodpovídá ani jedné konvenci (vadná data)
    UNKNOWN: 'UNKNOWN'              // nelze určit (chybí hodnota bodu nebo P/L)
  };

  function legsOf(trade) {
    return Array.isArray(trade?.legs) && trade.legs.length ? trade.legs : null;
  }

  // Počet kontraktů pozice. U obchodu s nohami je pravdou součet přes nohy –
  // `contracts` na obchodu se při ruční editaci rozešlo s nohami u čtyř obchodů
  // v živém deníku, takže nohy mají přednost.
  function contractsOf(trade) {
    const legs = legsOf(trade);
    if (legs) {
      const sum = legs.reduce((a, l) => a + (Math.abs(Number(l.contracts)) || 1), 0);
      if (sum > 0) return sum;
    }
    return Math.abs(Number(trade?.contracts)) || 1;
  }

  // Nevážený součet bodů, tedy dosavadní význam pole `points`.
  function storedPointsOf(trade) {
    const legs = legsOf(trade);
    if (legs) return legs.reduce((a, l) => a + Math.abs(Number(l.points) || 0), 0);
    return Math.abs(Number(trade?.points) || 0);
  }

  // Celkové body pozice vážené počtem kontraktů na nohu. Tohle je táž
  // matematika, jakou dělá `tradeTotalPoints()` v app/index.html – ta funkce
  // zůstává, protože na ni odkazuje UI, a tady je proto, aby ji mohla použít
  // i migrace a testy bez vytahování z HTML.
  function weightedPointsOf(trade) {
    const legs = legsOf(trade);
    if (legs) return legs.reduce((a, l) => a + Math.abs(Number(l.points) || 0) * (Math.abs(Number(l.contracts)) || 1), 0);
    return Math.abs(Number(trade?.points) || 0) * (Math.abs(Number(trade?.contracts)) || 1);
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function roundPoints(n) {
    return Math.round((Number(n) || 0) * 10000) / 10000;
  }

  // Jádro klasifikace – čistá čísla, žádný obchod. `gross` je hrubý (předkomisní)
  // výsledek v penězích, `net + |commission|`.
  function classifyStoredPoints({ storedPoints, contracts, gross, pointValue }) {
    const pv = Number(pointValue);
    const ct = Math.abs(Number(contracts)) || 1;
    const pts = Math.abs(Number(storedPoints) || 0);
    if (!pv || !Number.isFinite(pv) || !Number.isFinite(Number(gross))) {
      return { convention: POINTS_CONVENTION.UNKNOWN, pointsTotal: null, pointsPerContract: null, expectedTotal: null, expectedPerContract: null };
    }
    const expectedTotal = Math.abs(Number(gross)) / pv;
    const expectedPerContract = expectedTotal / ct;
    // Porovnává se v penězích, ne v bodech – tolerance §9 je peněžní a u
    // instrumentů s velkou hodnotou bodu by bodová tolerance byla příliš hrubá.
    const matchesTotal = Math.abs(pts * pv - Math.abs(Number(gross))) <= MONEY_TOLERANCE;
    const matchesPerContract = Math.abs(pts * ct * pv - Math.abs(Number(gross))) <= MONEY_TOLERANCE;

    let convention;
    if (matchesTotal && matchesPerContract) convention = POINTS_CONVENTION.AMBIGUOUS;
    else if (matchesTotal) convention = POINTS_CONVENTION.TOTAL;
    else if (matchesPerContract) convention = POINTS_CONVENTION.PER_CONTRACT;
    else convention = POINTS_CONVENTION.INCONSISTENT;

    // U nekonzistentních dat se body NEDOPOČÍTÁVAJÍ. Vymyslet číslo je horší
    // než přiznat, že se ověřit nedá – viz `exitPriceApprox` ve stejném duchu.
    const pointsTotal = (convention === POINTS_CONVENTION.PER_CONTRACT)
      ? roundPoints(pts * ct)
      : (convention === POINTS_CONVENTION.INCONSISTENT ? null : roundPoints(pts));

    return {
      convention,
      pointsTotal,
      pointsPerContract: pointsTotal == null ? null : roundPoints(pointsTotal / ct),
      expectedTotal: roundPoints(expectedTotal),
      expectedPerContract: roundPoints(expectedPerContract),
      contracts: ct
    };
  }

  // Klasifikace celého obchodu. `net` je znaménkový čistý výsledek – volající
  // ho předává, aby existoval jediný zdroj pravdy (`signed()` v rendereru).
  function classifyTrade(trade, { pointValue, net }) {
    const commission = Math.abs(Number(trade?.commission) || 0);
    const gross = Number(net) + commission;
    return classifyStoredPoints({
      storedPoints: storedPointsOf(trade),
      contracts: contractsOf(trade),
      gross,
      pointValue
    });
  }

  // Co zapsat na obchod. Pro NOVĚ vznikající obchod (formulář, import, merge)
  // se konvence neháda – tam je známá: `points` je na kontrakt u jedné nohy,
  // nevážený součet u víc nohou. Proto se použije vážený výpočet.
  function pointsFieldsForNewTrade(trade) {
    const total = roundPoints(weightedPointsOf(trade));
    const ct = contractsOf(trade);
    return { pointsTotal: total, pointsPerContract: roundPoints(total / ct) };
  }

  // Objemově vážený průměr výstupních cen přes nohy (§3.2). Vrací i cenu
  // poslední nohy a příznak, když vážený průměr spočítat nelze – pak se
  // původní `exitPrice` NECHÁVÁ být, nic se neodhaduje.
  function exitPriceFields(trade) {
    const legs = legsOf(trade);
    const lastLeg = legs
      ? [...legs].sort((a, b) => String(a.exitTime || '').localeCompare(String(b.exitTime || '')))[legs.length - 1]
      : null;
    const lastLegExitPrice = lastLeg ? Number(lastLeg.exitPrice) : Number(trade?.exitPrice);
    if (!legs || legs.length < 2) {
      return { exitPrice: Number(trade?.exitPrice), lastLegExitPrice, approx: false, weighted: false };
    }
    let weight = 0;
    let sum = 0;
    for (const leg of legs) {
      const price = Number(leg.exitPrice);
      const ct = Math.abs(Number(leg.contracts)) || 0;
      if (!Number.isFinite(price) || !price || !ct) {
        return { exitPrice: Number(trade?.exitPrice), lastLegExitPrice, approx: true, weighted: false };
      }
      sum += price * ct;
      weight += ct;
    }
    return { exitPrice: roundPoints(sum / weight), lastLegExitPrice, approx: false, weighted: true };
  }

  // §3.3c – R se počítá VŽDY z bodů na kontrakt, nikdy z celkových.
  function slPointsOf(entryPrice, slPrice) {
    const e = Number(entryPrice);
    const s = Number(slPrice);
    if (!Number.isFinite(e) || !Number.isFinite(s)) return null;
    const diff = Math.abs(e - s);
    return diff > 0 ? roundPoints(diff) : null;
  }

  // ---------------------------------------------------- chování ceny po výstupu
  //
  // Dvě ručně zadávaná čísla (`postExitFavorableTicks`, `postExitAdverseTicks`)
  // popisují, co cena udělala PO VÝSTUPU – měřeno od výstupní ceny, v ticích,
  // obě VŽDY KLADNĚ; směr nese název pole. Z nich se dopočítá, jak daleko
  // pozice došla OD VSTUPU na obě strany, což je vstup pro pozdější analýzu
  // (SL sweep, mřížka SL × TP).
  //
  // Tady je jen matematika – velikost ticku posílá volající, protože ji zná
  // renderer (šablona instrumentu nebo vestavěná tabulka).

  function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // Tiky bývají celá čísla, ale dělení desetinnou velikostí ticku umí vyrobit
  // 11.999999999999998 (RTY, tick 0,1). Zaokrouhlení na 4 desetinná místa to
  // srovná a přitom nechá průchozí i půltik.
  function roundTicks(n) {
    return Math.round((Number(n) || 0) * 10000) / 10000;
  }

  function ticksOf(priceDiff, tickSize) {
    const tick = Number(tickSize);
    if (!Number.isFinite(tick) || tick <= 0) return null;
    const diff = Number(priceDiff);
    if (!Number.isFinite(diff)) return null;
    return roundTicks(diff / tick);
  }

  function directionOf(side) {
    if (side === 'long') return 1;
    if (side === 'short') return -1;
    return null;
  }

  // Výstupní cena pro tohle měření je cena POSLEDNÍ nohy, ne vážený průměr:
  // uživatel měří pokračování ceny od okamžiku, kdy z pozice fakticky vystoupil.
  function measuredExitPriceOf(trade) {
    const last = finiteOrNull(trade?.lastLegExitPrice);
    return last != null ? last : finiteOrNull(trade?.exitPrice);
  }

  // Znaménkový posun výstupu proti vstupu v ticích: kladně = ve směru obchodu,
  // záporně = proti (typicky stop loss). Bez směru obchodu se NEHÁDÁ – vrací se
  // null a dopočty, které na něm stojí, zůstanou prázdné.
  function exitTicksOf(trade, tickSize) {
    const dir = directionOf(trade?.side);
    const entry = finiteOrNull(trade?.entryPrice);
    const exit = measuredExitPriceOf(trade);
    if (dir == null || entry == null || exit == null) return null;
    return ticksOf(dir * (exit - entry), tickSize);
  }

  // Vzdálenost vstup → Stop Loss v ticích. Bez ceny SL zůstává null a NIKDY se
  // nedosazuje nula – nula by znamenala „obchod bez rizika", což není totéž co
  // „nevyplněno".
  function slTicksOf(trade, tickSize) {
    const entry = finiteOrNull(trade?.entryPrice);
    const sl = finiteOrNull(trade?.slPrice);
    if (entry == null || sl == null) return null;
    const t = ticksOf(Math.abs(entry - sl), tickSize);
    return t != null && t > 0 ? t : null;
  }

  // Předvyplnění MFE/MAE, které jde ODVODIT ze samotného obchodu (ne odhadnout):
  //   target   → mfeTicks = exitTicks (výš to nedošlo, tam byl výstup)
  //   stoploss → maeTicks = |exitTicks| (proti pozici to došlo přesně na SL)
  //   breakeven / ruční výstup → nic
  // Platí jen tehdy, když výstup odpovídá zadanému cíli / SL. Obchod zavřený
  // ručně někde mezi tím se nepředvyplňuje – jde-li to z dat rozlišit (cena
  // cílové hladiny, resp. cena SL, se liší od skutečné výstupní ceny). Bez
  // zadané ceny hladiny se rozlišit nedá a výsledek `target` se bere za pravdu.
  // Obchod s víc nohami se neodvozuje: „výstup" tam není jedna cena.
  function deriveCourseTicks(trade, tickSize) {
    const out = {};
    const legs = legsOf(trade);
    if (legs && legs.length > 1) return out;
    const exitTicks = exitTicksOf(trade, tickSize);
    const exit = measuredExitPriceOf(trade);
    const tick = Number(tickSize);
    if (exitTicks == null || exit == null || !(tick > 0)) return out;
    const same = price => Math.abs(price - exit) < tick / 2;
    const result = String(trade?.result);
    if (result === 'target') {
      const prices = [trade?.targetLevel1?.price, trade?.targetLevel2?.price]
        .map(finiteOrNull).filter(p => p != null);
      if (prices.length && !prices.some(same)) return out;
      if (exitTicks > 0) out.mfeTicks = exitTicks;
    } else if (result === 'stoploss') {
      const sl = finiteOrNull(trade?.slPrice);
      if (sl != null && !same(sl)) return out;
      if (exitTicks < 0) out.maeTicks = Math.abs(exitTicks);
    }
    return out;
  }

  // Soft validace: SL dál než 40 ticků (10 bodů u ES) je skoro jistě překlep
  // (živá data: slPrice 7338, slTicks 1607). Nikdy neblokuje uložení.
  const SL_TICKS_SUSPICIOUS = 40;
  function slTicksSuspicious(slTicks) {
    const n = finiteOrNull(slTicks);
    return n != null && n > SL_TICKS_SUSPICIOUS;
  }

  // Obchod, který se naplnil, ale chybí mu průběh (MFE nebo MAE), má neúplný
  // kontext: SL sweep i mřížka SL × TP z něj nedostanou celý obrázek. Nenaplněný
  // setup se neposuzuje – není z čeho měřit. Prázdný stav se bere jako naplněný
  // (stejně jako `postExitApplies` ve formuláři).
  function contextIncomplete(trade) {
    // Záznam setupu bez exekuce nemá výstup, od kterého by se MFE/MAE měřilo.
    if (trade?.recordType === 'SETUP_ONLY') return false;
    const fill = trade?.fillStatus;
    if (fill && fill !== 'FILLED') return false;
    return finiteOrNull(trade?.mfeTicks) == null || finiteOrNull(trade?.maeTicks) == null;
  }

  // Dopočítaná pole. Volající je ukládá NA OBCHOD (ne jen zobrazuje), aby se
  // dala analyzovat bez opakovaného přepočtu a aby přežila sloučení cílů.
  //
  // Vstupy (ručně, vždy kladně, v ticích):
  //   mfeTicks / maeTicks                  nejdál ve směru / proti směru DO VÝSTUPU, od vstupu
  //   postExitFavorableTicks / ...Adverse  po výstupu, od VÝSTUPNÍ ceny
  //
  // Výstupy:
  //   exitTicks         výstup − vstup se znaménkem podle směru
  //   maxFavorableTicks max(mfe, exitTicks + postExitFavorable)
  //   maxTicks          exitTicks + postExitFavorable (starší pole, ponecháno)
  //   maxAdverseTicks   max(mae, postExitAdverse − exitTicks); u stopnutého obchodu
  //                     nejméně slTicks
  //   touchedEntry      protipohyb po výstupu se vrátil až na vstupní cenu
  //   touchedSl         maxAdverseTicks >= slTicks (u stopnutého obchodu se
  //                     nepočítá – viz níž)
  //
  // Když některý vstup chybí, počítá se z toho, co je. Když chybí všechny,
  // výsledek je null – NIKDY nula. Nula znamená „cena nešla ani o tick".
  // Bez `maeTicks` je záporný výsledek `postExitAdverse − exitTicks` jen
  // „nevím" (co se dělo uvnitř obchodu, data neříkají), ne naměřená nula –
  // proto se vrací null místo ořezu na 0. Nula vzniká jen z naměřeného MAE.
  function postExitTickFields(trade, tickSize) {
    const out = { slTicks: null, exitTicks: null, maxTicks: null, maxFavorableTicks: null, maxAdverseTicks: null, touchedEntry: null, touchedSl: null };
    const tick = Number(tickSize);
    if (!Number.isFinite(tick) || tick <= 0) return out;

    const exitTicks = exitTicksOf(trade, tickSize);
    const slTicks = slTicksOf(trade, tickSize);
    const absOrNull = v => { const n = finiteOrNull(v); return n == null ? null : Math.abs(n); };
    const fav = absOrNull(trade?.postExitFavorableTicks);
    const adv = absOrNull(trade?.postExitAdverseTicks);
    const mfe = absOrNull(trade?.mfeTicks);
    const mae = absOrNull(trade?.maeTicks);
    const stopped = String(trade?.result) === 'stoploss';

    out.slTicks = slTicks;
    out.exitTicks = exitTicks;

    const favCandidates = [];
    if (mfe != null) favCandidates.push(mfe);
    if (exitTicks != null && fav != null) {
      const after = roundTicks(exitTicks + fav);
      out.maxTicks = after;
      favCandidates.push(after);
    }
    if (favCandidates.length) out.maxFavorableTicks = roundTicks(Math.max(...favCandidates));

    const advCandidates = [];
    if (mae != null) advCandidates.push(mae);
    if (adv != null && exitTicks != null) advCandidates.push(roundTicks(adv - exitTicks));
    // Stopnutý obchod už proti pozici došel nejméně na SL – to je fakt.
    if (stopped && slTicks != null) advCandidates.push(slTicks);
    if (advCandidates.length) {
      const maxAdv = Math.max(...advCandidates);
      if (mae != null || maxAdv >= 0) out.maxAdverseTicks = roundTicks(Math.max(0, maxAdv));
    }

    // „Došla cena zpátky na vstup / na SL?" dává smysl jen u obchodu, který
    // vystoupil VE SMĚRU (zisk, BE). U obchodu ukončeného na stop lossu jsou
    // OBA PŘÍZNAKY DEGENEROVANÉ: výstup JE cena SL, takže by podle definice
    // vyšly vždycky true, a jako filtr v analýze by jen rozdělily vzorek na
    // „všechny stopnuté obchody" a zbytek. U stopnutého obchodu se proto
    // NEPOČÍTAJÍ a zůstávají null – pracuje se s `maxAdverseTicks`.
    if (!stopped) {
      if (adv != null && exitTicks != null && exitTicks > 0) out.touchedEntry = adv >= exitTicks;
      if (out.maxAdverseTicks != null && slTicks != null) out.touchedSl = out.maxAdverseTicks >= slTicks;
    }
    return out;
  }

  function rMultipleOf(pointsPerContract, slPoints) {
    const p = Number(pointsPerContract);
    const sl = Number(slPoints);
    if (!Number.isFinite(p) || !Number.isFinite(sl) || !sl) return null;
    return round2(p / sl);
  }

  return {
    POINTS_CONVENTION,
    MONEY_TOLERANCE,
    legsOf,
    contractsOf,
    storedPointsOf,
    weightedPointsOf,
    classifyStoredPoints,
    classifyTrade,
    pointsFieldsForNewTrade,
    exitPriceFields,
    slPointsOf,
    rMultipleOf,
    roundTicks,
    ticksOf,
    directionOf,
    measuredExitPriceOf,
    exitTicksOf,
    slTicksOf,
    SL_TICKS_SUSPICIOUS,
    slTicksSuspicious,
    contextIncomplete,
    deriveCourseTicks,
    postExitTickFields
  };
}));
