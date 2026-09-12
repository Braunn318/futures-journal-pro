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
    rMultipleOf
  };
}));
