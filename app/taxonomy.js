'use strict';
// Číselníky pro kontext obchodu (spec §4.2), editovatelné uživatelem.
//
// ZÁKLADNÍ PRAVIDLO: každá volba má NEMĚNNÝ KLÍČ a EDITOVATELNÝ POPISEK.
// V datech obchodu je vždy klíč, nikdy popisek. Přejmenování volby proto mění
// jen to, co se zobrazuje – uložené obchody se nedotkne.
//
// VOLBA SE NIKDY NEMAŽE, jen skrývá. Smazání volby by zneplatnilo obchody,
// které ji používají: buď by z nich hodnota zmizela, nebo by v breakdownu
// zůstal řádek bez názvu. Skrytá volba se dál počítá do statistik a pořád se
// zobrazuje u obchodů, které ji mají – jen se nenabízí u nových.
//
// ALIASY slouží ke slučování voleb, které se ukázaly jako totéž. Aliasovaný
// klíč zůstává platný (starý obchod ho může mít uložený), ale ve statistikách
// se počítá pod cílovým klíčem a nenabízí se.
//
// Modul se načítá přes <script src> před hlavním skriptem (bundler v projektu
// není) a zároveň jde načíst v Node testech.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJTaxonomy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ---------------------------------------------------------------- výchozí

  // Setup – odpovídá Strategy.md.
  const SETUP = {
    M2_OF: 'M2 + Order Flow',
    M2_PA: 'M2 – čistá price action',
    M2_TREND: 'M2 v trendu',
    M2_DELTA: 'M2 + změna delty',
    M2_STRUCTURE: 'M2 – změna struktury od high/low dne',
    REVERSAL_CANDLE: 'Obrat setup – dlouhá svíce',
    DELTA_CHANGE: 'Změna delty',
    BREAK_IB_PA: 'Break IB – price action',
    BREAK_IB_OF: 'Break IB – s order flow',
    BREAK_IB_FX: 'Break IB na FX (4h swing)',
    AVE: 'AVE Pattern',
    IB_VPOC_GAP: 'IB+VPOC – hrana 123 gapu',
    IB_VPOC_VWAP_TEST: 'IB+VPOC – 1. test VWAP',
    IB_VPOC_VWAP_RETEST: 'IB+VPOC – retest proraženého VWAP',
    IB_VPOC_LQ2: 'IB+VPOC – výkop 2 likvidit',
    IB_VPOC_LQ_RANGE: 'IB+VPOC – výkop LQ range',
    IB_VPOC_TREND: 'IB+VPOC – v trendu do levelu',
    IB_VPOC_AVE_LONG: 'IB+VPOC – AVE dlouhá do levelu',
    M2HL: 'Metoda 2HL',
    SCALP_OF: 'Scalping – OF setup',
    OTHER: 'Jiný / mimo strategii'
  };

  // Hladina, na které ležel vstup. MULTI-SELECT – konfluence hladin je sama
  // o sobě informace.
  const ENTRY_LEVEL = {
    LIQUIDITY: 'Likvidita',
    VPOC_DAY: 'VPOC dne',
    VPOC_30M: 'VPOC 30M',
    VPOC_1M: 'VPOC 1M',
    VPOC_IB: 'VPOC IB',
    VPOC_CANDLE: 'VPOC svíce',
    VAH: 'VAH',
    VAL: 'VAL',
    VWAP: 'VWAP',
    VWAP_DEV: 'VWAP odchylka',
    M2_EDGE: 'Hrana M2',
    IB_EDGE: 'Hrana IB',
    GAP_EDGE: 'Hrana gapu',
    LTA_LEVEL: 'LTA hladina',
    PDH_PDL: 'PDH / PDL',
    ONH_ONL: 'ONH / ONL',
    NONE: 'Žádná hladina',
    // Kontext v2 (ZADANI_KONTEXT A2.1) – přidané klíče, existující beze změny.
    VPOC_PREV_DAY: 'VPOC předchozího dne',
    VAH_PREV: 'VAH předchozího dne',
    VAL_PREV: 'VAL předchozího dne',
    VWAP_DEV1: 'VWAP odchylka 1',
    VWAP_DEV2: 'VWAP odchylka 2',
    HVN: 'HVN',
    LVN: 'LVN',
    // High / Low of Day – dosavadní denní maximum / minimum. Ve výchozím stavu
    // skrytá (DEFAULT_HIDDEN), uživatel si ji zapne v Nastavení → Číselníky.
    HOD_LOD: 'High / Low dne'
  };

  // Potvrzení z order flow. MULTI-SELECT.
  const OF_CONFIRM = {
    ABS_BID: 'Absorpce na bidu',
    ABS_ASK: 'Absorpce na asku',
    IMBALANCE: 'Imbalance',
    DELTA_CHANGE: 'Změna delty',
    MEGA_BID: 'Mega bid',
    MEGA_ASK: 'Mega ask',
    PATTERN_0x1: 'Pattern 0x1',
    PATTERN_1x0: 'Pattern 1x0',
    HIGH_VOLUME: 'Vysoký objem',
    CLOSE_VS_VPOC_OK: 'Uzavření vůči VPOC v pořádku',
    NONE: 'Bez potvrzení'
  };

  // Trend v době vstupu. SINGLE-SELECT – trh je v jednu chvíli v jednom
  // z těch tří stavů, ne ve dvou naráz.
  const TREND = {
    LONG: 'Long',
    SHORT: 'Short',
    RANGE: 'Range'
  };

  // Stav naplnění. Bez něj statistika měří jen přeživší obchody.
  const FILL_STATUS = {
    FILLED: 'naplněno',
    NO_FILL: 'limitka se nenaplnila',
    MISSED: 'setup byl, nestihl jsem',
    SKIPPED: 'setup byl, vědomě vynechán'
  };

  // Typ cílové hladiny: kam obchod mířil (targetLevel1 / targetLevel2). Vlastní
  // číselník, ne sdílený s hladinou vstupu – „Trail podle 1min M2" nebo „Ruční
  // výstup bez hladiny" nejsou místa vstupu. Cena hladiny se ukládá vedle typu,
  // bez ní nejde spočítat, na kolika R hladina ležela.
  const TARGET_LEVEL = {
    LIQUIDITY: 'Likvidita',
    VPOC_DAY: 'VPOC dne',
    VPOC_30M: 'Netestovaný VPOC 30min svíce',
    VPOC_1M: 'VPOC 1M svíce',
    VAH: 'VAH',
    VAL: 'VAL',
    VWAP: 'VWAP',
    LVN: 'LVN',
    GAP_EDGE: 'Hrana gapu',
    LTA_LEVEL: 'LTA hladina',
    TRAIL_M2: 'Trail podle 1min M2',
    MANUAL_EXIT: 'Ruční výstup bez hladiny',
    // Kontext v2 (ZADANI_KONTEXT A2.1) – klíče ze slovníku hladin, které tu
    // chyběly. Existující klíče i popisky beze změny.
    VPOC_PREV_DAY: 'VPOC předchozího dne',
    VPOC_IB: 'VPOC IB',
    VAH_PREV: 'VAH předchozího dne',
    VAL_PREV: 'VAL předchozího dne',
    VWAP_DEV1: 'VWAP odchylka 1',
    VWAP_DEV2: 'VWAP odchylka 2',
    HVN: 'HVN',
    HOD_LOD: 'High / Low dne',
    M2_EDGE: 'Hrana M2',
    IB_EDGE: 'Hrana IB',
    PDH_PDL: 'PDH / PDL',
    ONH_ONL: 'ONH / ONL'
  };

  // Nová ruční pole obchodu (ZADANI_KONTEXT A4). Single-select, klíče ze
  // zadání, popisky jdou upravit jako u ostatních číselníků.
  // Trend na 30min grafu – existující `trend` (TREND) zůstává beze změny.
  // Popisky jsou stejné jako u trendu 1m (Long / Short / Range); klíče UP /
  // DOWN / RANGE jsou ze zadání, jsou v uložených obchodech i v exportu a
  // nemění se.
  const TREND_HTF = { UP: 'Long', DOWN: 'Short', RANGE: 'Range' };
  // Kde byla absorpce: na extrému svíčky / pohybu, nebo uprostřed.
  const ABS_LOCATION = { EXTREME: 'Na extrému', MIDDLE: 'Uprostřed', NONE: 'Bez absorpce' };
  // Kolikátý test vstupní hladiny v seanci.
  const ENTRY_TEST_NO = { '1': '1. test', '2': '2. test', '3+': '3. a další' };
  // Známka zadaná PŘED vstupem (ochrana: gradeSetAt / gradeEdited / gradeRetro).
  const GRADE = { A: 'A', B: 'B', C: 'C' };
  // Netest / test hladiny: cena se hladiny v seanci ještě nedotkla / už ano.
  // Pevné, needitovatelné – na obou hodnotách stojí analýza.
  const TEST_STATE = { UNTESTED: 'netest', TESTED: 'test' };

  // Proč by obchod naživo NEVZAL (wouldSkipLive). V backtestu se setup dá vzít
  // i tak – replay nic nestojí a výsledek je informace –, ale do výkonu
  // strategie takový obchod ve výchozím stavu nepatří. NENÍ to planFollowed:
  // ten říká „vzal jsem to a neměl podle pravidel“, tohle „vzal jsem to jen
  // kvůli měření".
  const SKIP_REASON = {
    LIQUIDITY_SWEPT: 'Velký výběr likvidity proti směru',
    SR_IN_WAY: 'SR zóna / hladina v cestě',
    CONTEXT: 'Kontext neseděl',
    TOO_LATE: 'Pozdě, cena už odjela',
    LOW_CONVICTION: 'Slabý signál, nedůvěra',
    RISK_RULE: 'Riziko / denní limit',
    OTHER: 'Jiný důvod'
  };

  // Kontext dne (ZADANI_KONTEXT A5): jednou za den a deník, uložený
  // v dayNotes[date].dayContext. Klíče jsou ze zadání a nemění se; popisky,
  // skrytí, pořadí a vlastní volby si uživatel upraví jako u ostatních
  // číselníků. Typ dne je JEDEN seznam pro očekávaný i skutečný – jen tak jde
  // porovnat, jestli se odhad trefil. Která pole z číselníků berou, říká
  // FJContext.DAY_CONTEXT_GROUPS.
  const DAY_OPEN = { IN_VA: 'Open ve value', ABOVE_VAH: 'Open nad VAH', BELOW_VAL: 'Open pod VAL', GAP_UP: 'Gap nahoru', GAP_DOWN: 'Gap dolů' };
  const DAY_TYPE = {
    TREND_UP: 'Trend nahoru', TREND_DOWN: 'Trend dolů', BALANCE_D: 'Balance (D)', P: 'P profil', b: 'b profil',
    DOUBLE_DIST: 'Dvojitá distribuce', UNKNOWN: 'Nevím'
  };
  const DAY_VALUE_MIGRATION = { HIGHER: 'Výš', LOWER: 'Níž', OVERLAP: 'Překryv' };
  const DAY_NEWS = { NONE: 'Bez zpráv', CPI: 'CPI', FOMC: 'FOMC', NFP: 'NFP', OTHER: 'Jiné zprávy' };

  const DEFAULT_ENUMS = { SETUP, ENTRY_LEVEL, OF_CONFIRM, TREND, FILL_STATUS, TARGET_LEVEL, SKIP_REASON,
    TREND_HTF, ABS_LOCATION, ENTRY_TEST_NO, GRADE, DAY_OPEN, DAY_TYPE, DAY_VALUE_MIGRATION, DAY_NEWS };

  // Výchozí skryté klíče (uživatel je zobrazí tlačítkem Zobrazit). PDH/PDL
  // a ONH/ONL jsou skryté i u vstupu – Adam je nepoužívá. High / Low dne
  // (HOD_LOD) je skrytá všude: u vstupu, u hladin v blízkosti i u cílů.
  const DEFAULT_HIDDEN = { ENTRY_LEVEL: ['HOD_LOD'], TARGET_LEVEL: ['PDH_PDL', 'ONH_ONL', 'HOD_LOD'] };

  // Sloučené volby. Klíč vlevo zůstává PLATNÝ (starý obchod ho může mít
  // uložený), ale ve statistikách se počítá pod klíčem vpravo a u nových
  // obchodů se nenabízí.
  //
  // MEGA_BID/MEGA_ASK jsou v praxi totéž co absorpce – rozlišovat je znamenalo
  // dělit malý vzorek na dvě poloviny, ze kterých nejde nic vyčíst.
  // VPOC_CANDLE je VPOC jednominutové svíce, tedy VPOC_1M jiným jménem.
  // VWAP_DEV se ZÁMĚRNĚ neslučuje: odchylka VWAP je jiná hladina než VAH/VAL
  // a počítá se jinak.
  const DEFAULT_ALIASES = {
    OF_CONFIRM: { MEGA_BID: 'ABS_BID', MEGA_ASK: 'ABS_ASK' },
    ENTRY_LEVEL: { VPOC_CANDLE: 'VPOC_1M' }
  };

  // `optionsFrom` znamená, že skupina SDÍLÍ SEZNAM VOLEB s jinou skupinou.
  // Hladina je hladina, ať se na ni kouká jako na místo vstupu, nebo jako na
  // hladinu v blízkosti obchodu – proto se udržuje na jednom místě a
  // přejmenování i nová vlastní volba platí rovnou pro obě kolonky. Skrývání
  // a pořadí si ale každá kolonka může nastavit vlastní.
  const GROUPS = [
    { name: 'SETUP', label: 'Setup', cardinality: 'single' },
    { name: 'TREND', label: 'Trend 1m', cardinality: 'single' },
    { name: 'ENTRY_LEVEL', label: 'Hladina vstupu', cardinality: 'multi' },
    { name: 'NEAR_LEVEL', label: 'Hladiny v blízkosti', cardinality: 'multi', optionsFrom: 'ENTRY_LEVEL' },
    { name: 'OF_CONFIRM', label: 'Order flow potvrzení', cardinality: 'multi' },
    { name: 'FILL_STATUS', label: 'Stav naplnění', cardinality: 'single' },
    { name: 'TARGET_LEVEL', label: 'Typ cílové hladiny', cardinality: 'single' },
    { name: 'SKIP_REASON', label: 'Důvod „naživo bych nevzal“', cardinality: 'single' },
    { name: 'TREND_HTF', label: 'Trend 30m', cardinality: 'single' },
    { name: 'ABS_LOCATION', label: 'Absorpce – kde', cardinality: 'single' },
    { name: 'ENTRY_TEST_NO', label: 'Kolikátý test vstupu', cardinality: 'single' },
    { name: 'GRADE', label: 'Známka', cardinality: 'single' },
    { name: 'DAY_OPEN', label: 'Kontext dne – open vůči value', cardinality: 'single' },
    { name: 'DAY_TYPE', label: 'Kontext dne – typ dne (očekávaný i skutečný)', cardinality: 'single' },
    { name: 'DAY_VALUE_MIGRATION', label: 'Kontext dne – migrace value', cardinality: 'single' },
    { name: 'DAY_NEWS', label: 'Kontext dne – zprávy', cardinality: 'single' }
  ];

  const GROUP_BY_NAME = Object.fromEntries(GROUPS.map(g => [g.name, g]));

  // Skupina, ze které se berou volby a jejich popisky.
  function vocabularyOf(group) {
    return GROUP_BY_NAME[group]?.optionsFrom || group;
  }

  const TRADE_CONTEXT_FIELDS = [
    { key: 'setupCode', cardinality: 'single', enumName: 'SETUP', label: 'Setup' },
    { key: 'trend', cardinality: 'single', enumName: 'TREND', label: 'Trend 1m' },
    { key: 'entryLevels', cardinality: 'multi', enumName: 'ENTRY_LEVEL', label: 'Hladina vstupu' },
    // Hladiny v blízkosti jsou ŘÁDKY { level, price, testState? } – jedna
    // hladina jeden řádek, stejný typ může být víckrát (dvě VAH na různých
    // cenách). Sloučený obchod bere sjednocení řádků (sanitizeNearLevels).
    { key: 'nearLevels', cardinality: 'levelRows', enumName: 'NEAR_LEVEL', label: 'Hladiny v blízkosti' },
    // „Žádná hladina v blízkosti" – odlišuje „nic tam nebylo" od „nevyplněno".
    // Ukládá se jen true a jen u obchodu bez řádků. `noneFor` říká, ke
    // kterému poli patří: sloučený obchod ho má, jen když ho mají všechny
    // nohy a sjednocené řádky jsou prázdné.
    { key: 'nearLevelsNone', cardinality: 'bool', enumName: null, noneFor: 'nearLevels', label: 'Hladiny v blízkosti: žádná' },
    { key: 'ofConfirm', cardinality: 'multi', enumName: 'OF_CONFIRM', label: 'Order flow potvrzení' },
    { key: 'fillStatus', cardinality: 'single', enumName: 'FILL_STATUS', label: 'Stav naplnění' },
    { key: 'slPrice', cardinality: 'number', enumName: null, label: 'Cena Stop Lossu' },
    // Cílová hladina: { type: klíč z TARGET_LEVEL, price: číslo }. Bere se vcelku
    // z prvního obchodu, který ji má – typ a cena patří k sobě.
    { key: 'targetLevel1', cardinality: 'target', enumName: 'TARGET_LEVEL', label: 'Cílová hladina 1' },
    { key: 'targetLevel2', cardinality: 'target', enumName: 'TARGET_LEVEL', label: 'Cílová hladina 2' },
    // Průběh obchodu DO VÝSTUPU, od vstupní ceny, v ticích, vždy kladně.
    // merge: 'max' – sloučený obchod bere maximum přes nohy: nejdál, kam pozice
    // jako celek došla, je nejdál z jakékoli její nohy.
    { key: 'mfeTicks', cardinality: 'number', enumName: null, merge: 'max', label: 'MFE' },
    { key: 'maeTicks', cardinality: 'number', enumName: null, merge: 'max', label: 'MAE' },
    { key: 'observedMinutes', cardinality: 'number', enumName: null, merge: 'lastExit', label: 'Sledováno po výstupu (min)' },
    // Chování ceny PO VÝSTUPU. merge: 'lastExit' znamená, že u sloučeného
    // obchodu se hodnota NEBERE z první nohy jako u ostatních jednohodnotových
    // polí, ale z nohy s nejpozdějším časem výstupu – měří se pokračování ceny
    // po tom, co pozice fakticky skončila, ne po částečném výstupu uprostřed.
    { key: 'postExitFavorableTicks', cardinality: 'number', enumName: null, merge: 'lastExit', label: 'Ticky po výstupu – ve směru zisku' },
    { key: 'postExitAdverseTicks', cardinality: 'number', enumName: null, merge: 'lastExit', label: 'Ticky po výstupu – proti' },
    { key: 'postExitAdverseFirst', cardinality: 'bool', enumName: null, merge: 'lastExit', label: 'Protipohyb přišel dřív' },
    // Kontext v2 (A4). Single-select bere první neprázdný.
    { key: 'trendHtf', cardinality: 'single', enumName: 'TREND_HTF', label: 'Trend 30m' },
    { key: 'entryTestNo', cardinality: 'single', enumName: 'ENTRY_TEST_NO', label: 'Kolikátý test vstupu' },
    { key: 'absLocation', cardinality: 'single', enumName: 'ABS_LOCATION', label: 'Absorpce – kde' },
    { key: 'grade', cardinality: 'single', enumName: 'GRADE', label: 'Známka' },
    // Čas prvního zadání známky: sloučený obchod bere nejdřívější. „Změněno
    // dodatečně" platí, když to tvrdí kterákoli noha.
    { key: 'gradeSetAt', cardinality: 'string', enumName: null, merge: 'min', label: 'Známka zadána' },
    { key: 'gradeEdited', cardinality: 'bool', enumName: null, merge: 'any', label: 'Známka změněna dodatečně' }
  ];

  // ------------------------------------------------------- uživatelská úprava

  // Tvar uloženého nastavení (settings.taxonomy):
  //   { ENTRY_LEVEL: { labels:{KLÍČ:'nový popisek'}, hidden:['KLÍČ'],
  //                    order:['KLÍČ',…], custom:{KLÍČ:'popisek'} }, … }
  // Všechno je nepovinné; chybějící skupina znamená „beze změny".
  let activeConfig = {};

  function applyConfig(config) {
    activeConfig = (config && typeof config === 'object') ? config : {};
    return activeConfig;
  }

  function getConfig() {
    return activeConfig;
  }

  function groupConfig(group, config) {
    const source = config || activeConfig;
    const g = source && source[group];
    return (g && typeof g === 'object') ? g : {};
  }

  // Všechny klíče skupiny včetně vlastních – i skryté a aliasované. Tohle je
  // množina PLATNÝCH hodnot, ne nabídka pro uživatele.
  function allKeys(group, config) {
    // Volby i vlastní volby se berou ze zdrojové skupiny, pořadí si ale může
    // každá kolonka nastavit vlastní (níž `groupConfig(group)`).
    const vocab = vocabularyOf(group);
    const v = groupConfig(vocab, config);
    const g = vocab === group ? v : { ...groupConfig(group, config), custom: v.custom };
    const custom = (g.custom && typeof g.custom === 'object') ? Object.keys(g.custom) : [];
    const base = Object.keys(DEFAULT_ENUMS[vocab] || {});
    const merged = [...base, ...custom.filter(k => !base.includes(k))];
    const order = Array.isArray(g.order) ? g.order : [];
    if (!order.length) return merged;
    // Klíče neuvedené v pořadí (např. nově přidané do výchozího číselníku
    // aktualizací appky) se přidají na konec, nikdy nezmizí.
    const ordered = order.filter(k => merged.includes(k));
    return [...ordered, ...merged.filter(k => !ordered.includes(k))];
  }

  function aliasesFor(group, config) {
    const vocab = vocabularyOf(group);
    const g = groupConfig(vocab, config);
    const custom = (g.aliases && typeof g.aliases === 'object') ? g.aliases : {};
    return { ...(DEFAULT_ALIASES[vocab] || {}), ...custom };
  }

  // Aliasovaný klíč se ve statistikách počítá pod cílovým klíčem.
  function canonicalKey(group, key, config) {
    const aliases = aliasesFor(group, config);
    let current = key;
    // Řetězec aliasů se rozplete, ale s pojistkou proti zacyklení.
    for (let i = 0; i < 5 && aliases[current]; i++) current = aliases[current];
    return current;
  }

  // Skryté klíče: co uživatel skryl, plus aliasované (ty se nenabízejí nikdy).
  function hiddenKeys(group, config) {
    // Kolonka si smí skrýt volbu sama pro sebe. Když vlastní nastavení nemá,
    // zdědí ho ze zdrojové skupiny – co je skryté u hladiny vstupu, nemá
    // smysl nabízet ani u hladin v blízkosti.
    const own = groupConfig(group, config);
    const vocab = vocabularyOf(group);
    const inherited = vocab === group ? {} : groupConfig(vocab, config);
    const hasOwn = Array.isArray(own.hidden) || Array.isArray(own.visible);
    const g = hasOwn ? own : inherited;
    const explicit = Array.isArray(g.hidden) ? g.hidden : [];
    const unhidden = Array.isArray(g.visible) ? g.visible : [];
    const aliased = Object.keys(aliasesFor(group, config));
    // Výchozí skrytí odvozené kolonky (Hladiny v blízkosti) se bere ze zdrojové
    // skupiny – hladina skrytá u vstupu se ve výchozím stavu nenabízí ani tam.
    const defaults = DEFAULT_HIDDEN[group] || DEFAULT_HIDDEN[vocab] || [];
    return new Set([...defaults, ...explicit, ...aliased].filter(k => !unhidden.includes(k)));
  }

  function isHidden(group, key, config) {
    return hiddenKeys(group, config).has(key);
  }

  function labelOf(group, key, config) {
    if (!key) return '';
    // Popisek je vlastnost VOLBY, ne kolonky – přejmenovaná hladina se tak
    // stejně jmenuje u vstupu i u hladin v blízkosti.
    const vocab = vocabularyOf(group);
    const g = groupConfig(vocab, config);
    const labels = (g.labels && typeof g.labels === 'object') ? g.labels : {};
    const custom = (g.custom && typeof g.custom === 'object') ? g.custom : {};
    const base = DEFAULT_ENUMS[vocab] || {};
    // Neznámý klíč se vrací, jak přišel – v UI je pak vidět, že něco nesedí,
    // místo tichého prázdna.
    return labels[key] || custom[key] || base[key] || String(key);
  }

  function isValidKey(group, key, config) {
    return allKeys(group, config).includes(key);
  }

  // „Je to hladina" u položky slovníku cílů (TARGET_LEVEL). Cíl, který není
  // hladina (ruční výstup, trail, pevné RRR), neříká nic o tom, jestli cena
  // na hladině reagovala. Výchozí je true; uživatel to přepne v Nastavení →
  // Číselníky a uloží se do `TARGET_LEVEL.isLevel { KLÍČ: bool }`.
  // CUSTOM_FIX_RRR je uživatelský klíč, výchozí „ne" pro něj schválil Adam
  // (nastavení slovníku, ne data obchodů).
  const DEFAULT_NOT_LEVEL = { TARGET_LEVEL: ['MANUAL_EXIT', 'TRAIL_M2', 'CUSTOM_FIX_RRR'] };

  function isLevelKey(key, config, group = 'TARGET_LEVEL') {
    const own = groupConfig(group, config).isLevel;
    if (own && typeof own === 'object' && typeof own[key] === 'boolean') return own[key];
    return !(DEFAULT_NOT_LEVEL[group] || []).includes(key);
  }

  // Nabídka pro NOVÝ obchod: ve zvoleném pořadí, bez skrytých a aliasovaných.
  // `keepSelected` vrátí i skryté klíče, které obchod už má uložené – jinak by
  // se editací obchodu jeho hodnota tiše ztratila.
  function visibleOptions(group, keepSelected, config) {
    const keep = new Set(Array.isArray(keepSelected) ? keepSelected : (keepSelected ? [keepSelected] : []));
    const hidden = hiddenKeys(group, config);
    return allKeys(group, config)
      .filter(k => !hidden.has(k) || keep.has(k))
      .map(k => ({ key: k, label: labelOf(group, k, config), hidden: hidden.has(k) }));
  }

  // Očistí multi-select hodnotu: jen PLATNÉ klíče, bez duplicit, ve stabilním
  // pořadí. Skryté ani aliasované klíče se NEZAHAZUJÍ – obchod, který je má,
  // si je musí ponechat. Zahazuje se jen klíč, který v číselníku vůbec není.
  function sanitizeMulti(group, values, config) {
    const wanted = new Set(Array.isArray(values) ? values : []);
    return allKeys(group, config).filter(k => wanted.has(k));
  }

  function sanitizeSingle(group, value, config) {
    return isValidKey(group, value, config) ? value : '';
  }

  // Cílová hladina { type, price }. Neznámý typ se zahazuje (ne opravuje);
  // cena je nepovinná, ale bez ní se R hladiny nedá spočítat. Prázdné = null.
  function sanitizeTargetLevel(value, config) {
    if (!value || typeof value !== 'object') return null;
    const type = sanitizeSingle('TARGET_LEVEL', value.type, config);
    const raw = value.price;
    const n = (raw === null || raw === undefined || String(raw).trim() === '') ? null : Number(raw);
    const price = Number.isFinite(n) ? n : null;
    if (!type && price == null) return null;
    return { type, price };
  }

  // Netest / test: platný stav, nebo '' (nevyplněno).
  function sanitizeTestState(value) {
    return Object.prototype.hasOwnProperty.call(TEST_STATE, value) ? value : '';
  }

  // STARÝ TVAR (do 4.8.4): dva seznamy srTarget / srStopLoss s řádky
  // { level, price, ticksFromEntry }. Funkce zůstává jen pro ČTENÍ starého
  // zápisu – nový tvar je jeden seznam nearLevels (sanitizeNearLevels níž).
  //   level          klíč číselníku
  //   price          cena hladiny, nebo null
  //   ticksFromEntry vzdálenost od vstupu v ticích, VŽDY KLADNĚ, nebo null –
  //                  stranu nese název pole a směr obchodu, ne znaménko
  // Přijímá i starý tvar (pole klíčů z doby multi-selectu) – takový řádek
  // nemá cenu ani vzdálenost. Neznámý typ se zahazuje (ne opravuje), stejně
  // jako u multi-selectu. Identické řádky se sloučí; holý řádek (bez ceny
  // i vzdálenosti) se zahodí, když stejná hladina existuje i s údajem – nese
  // tutéž informaci, jen chudší. Řádky stejného typu s jinou cenou zůstávají.
  function numOrNull(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // `group` null = typ se proti číselníku NEOVĚŘUJE, jen se srovná tvar – pro
  // export dat z víc deníků, kde má každý vlastní číselník.
  function sanitizeLevelRows(group, value, config) {
    const list = Array.isArray(value) ? value : [];
    const known = group ? new Set(allKeys(group, config)) : null;
    const valid = { has: key => key !== '' && (known ? known.has(key) : true) };
    const rows = [];
    const seen = new Set();
    for (const item of list) {
      const raw = (item && typeof item === 'object') ? item : { level: item };
      const level = typeof raw.level === 'string' && valid.has(raw.level) ? raw.level : '';
      if (!level) continue;
      const price = numOrNull(raw.price);
      const ticks = numOrNull(raw.ticksFromEntry);
      const row = { level, price, ticksFromEntry: ticks == null ? null : Math.abs(ticks) };
      // Netest / test jen když je vyplněný – tvar starých řádků se nemění.
      const testState = sanitizeTestState(raw.testState);
      if (testState) row.testState = testState;
      const sig = row.level + '|' + row.price + '|' + row.ticksFromEntry + '|' + (row.testState || '');
      if (seen.has(sig)) continue;
      seen.add(sig);
      rows.push(row);
    }
    const detailed = new Set(rows.filter(r => r.price != null || r.ticksFromEntry != null).map(r => r.level));
    return rows.filter(r => r.price != null || r.ticksFromEntry != null || !detailed.has(r.level));
  }

  // Starý tvar (pole klíčů) – pro migraci: je co převádět?
  function hasLegacyLevelRows(value) {
    return Array.isArray(value) && value.some(item => typeof item === 'string');
  }

  // ------------------------------------------- hladiny v blízkosti (kontext v3)
  // Jeden seznam řádků { level, price, testState? } místo dvojice srTarget /
  // srStopLoss. Uživatel zadává jen typ, cenu a test / netest – stranu ani roli
  // nevolí; polohu vůči vstupu, SL a cíli dopočítá FJContext.levelGeometry.
  //
  // Řádek BEZ ceny převzatý ze starého zápisu si nese `legacySide` ('TG' / 'SL')
  // a původní kladné `ticksFromEntry` – jen díky nim má polohu. Řádek s cenou je
  // nenese nikdy: cena je jediný zdroj pravdy. `NONE` není hladina („žádná
  // hladina v blízkosti" je příznak nearLevelsNone, ne řádek).
  // Shodné řádky (typ + cena) se sloučí, vyplněný test / netest se neztratí;
  // holý řádek ustoupí řádku téže hladiny s cenou. `group` null = typ se proti
  // číselníku NEOVĚŘUJE (převod běží dřív, než se načtou vlastní volby, a export
  // bere obchody z víc deníků).
  const LEGACY_SIDES = ['TG', 'SL'];

  function sanitizeNearLevels(group, value, config) {
    const list = Array.isArray(value) ? value : [];
    const known = group ? new Set(allKeys(group, config)) : null;
    const rows = [];
    const bySignature = new Map();
    for (const item of list) {
      const raw = (item && typeof item === 'object') ? item : { level: item };
      const level = typeof raw.level === 'string' ? raw.level : '';
      if (!level || level === 'NONE' || (known && !known.has(level))) continue;
      const price = numOrNull(raw.price);
      const row = { level, price };
      if (price == null && LEGACY_SIDES.includes(raw.legacySide)) {
        const ticks = numOrNull(raw.ticksFromEntry);
        row.ticksFromEntry = ticks == null ? null : Math.abs(ticks);
        row.legacySide = raw.legacySide;
      }
      const testState = sanitizeTestState(raw.testState);
      const signature = level + '|' + price + '|' + (row.legacySide || '') + '|' + (row.ticksFromEntry ?? '');
      const same = bySignature.get(signature);
      if (same) {
        if (testState && !same.testState) same.testState = testState;
        continue;
      }
      if (testState) row.testState = testState;
      bySignature.set(signature, row);
      rows.push(row);
    }
    const priced = new Set(rows.filter(r => r.price != null).map(r => r.level));
    return rows.filter(r => r.price != null || r.legacySide || !priced.has(r.level));
  }

  // JEDINÉ pravidlo převodu starého zápisu (ZADANI_KONTEXT_V3 A2). Používá ho
  // migrace deníku, čtení deníku, který ještě nebyl otevřen, i exporty:
  //  - řádky obou seznamů za sebou (proti targetu, pak proti S/L), shodné
  //    (typ + cena) jen jednou,
  //  - řádek bez ceny dostane legacySide a ponechá si kladné ticksFromEntry,
  //  - „žádná" platí jen tehdy, když byly „žádná" OBĚ strany (příznak, nebo
  //    strana jen s řádkem NONE); jinak je prázdný seznam „nevyplněno".
  const LEGACY_NEAR_KEYS = ['srTarget', 'srStopLoss', 'srTargetNone', 'srStopLossNone'];

  function hasLegacyNearLevels(trade) {
    return !!trade && typeof trade === 'object' && LEGACY_NEAR_KEYS.some(k => trade[k] !== undefined);
  }

  function nearLevelsFromLegacy(trade) {
    const sides = { TG: sanitizeLevelRows(null, trade?.srTarget), SL: sanitizeLevelRows(null, trade?.srStopLoss) };
    const merged = [];
    for (const side of LEGACY_SIDES) {
      for (const row of sides[side]) merged.push(row.price != null ? row : { ...row, legacySide: side });
    }
    const nearLevels = sanitizeNearLevels(null, merged);
    const sideNone = (flag, rows) => trade?.[flag] === true || (rows.length > 0 && rows.every(r => r.level === 'NONE'));
    return {
      nearLevels,
      nearLevelsNone: !nearLevels.length && sideNone('srTargetNone', sides.TG) && sideNone('srStopLossNone', sides.SL)
    };
  }

  const hasNearLevels = trade => Array.isArray(trade.nearLevels) || trade.nearLevelsNone !== undefined;

  // Hladiny v blízkosti obchodu, ať je uložený v novém, nebo starém tvaru.
  function nearLevelsOf(trade) {
    if (!trade || typeof trade !== 'object') return [];
    if (Array.isArray(trade.nearLevels)) return sanitizeNearLevels(null, trade.nearLevels);
    return !hasNearLevels(trade) && hasLegacyNearLevels(trade) ? nearLevelsFromLegacy(trade).nearLevels : [];
  }

  // Výslovné „žádná hladina v blízkosti". Platí jen bez řádků.
  function nearLevelsNoneOf(trade) {
    if (!trade || typeof trade !== 'object') return false;
    if (hasNearLevels(trade)) return trade.nearLevelsNone === true && !nearLevelsOf(trade).length;
    return hasLegacyNearLevels(trade) ? nearLevelsFromLegacy(trade).nearLevelsNone : false;
  }

  // Zapíše hladiny do obchodu v novém tvaru a odstraní starý. Mění `obj`.
  function setNearLevels(obj, rows, none) {
    for (const key of LEGACY_NEAR_KEYS) delete obj[key];
    obj.nearLevels = Array.isArray(rows) ? rows : [];
    if (none === true && !obj.nearLevels.length) obj.nearLevelsNone = true; else delete obj.nearLevelsNone;
    return obj;
  }

  // Obchod ve starém tvaru převedený do nového (nový objekt). Obchod bez
  // starých klíčů se vrací TENTÝŽ – převod je idempotentní a není co zapisovat.
  function convertLegacyNear(trade) {
    if (!hasLegacyNearLevels(trade)) return trade;
    return setNearLevels({ ...trade }, nearLevelsOf(trade), nearLevelsNoneOf(trade));
  }

  // Pole zrušená v kontextu v3 – mažou se i z dat (rozhodnutí uživatele).
  const V3_REMOVED_KEYS = ['liquiditySwept', 'pathProfile', 'entryLevelTests'];

  function stripRemovedV3(trade) {
    if (!trade || typeof trade !== 'object' || !V3_REMOVED_KEYS.some(k => k in trade)) return trade;
    const out = { ...trade };
    for (const key of V3_REMOVED_KEYS) delete out[key];
    return out;
  }

  // Obchod v tvaru kontextu v3: bez zrušených polí a s hladinami v novém
  // tvaru. Tentýž převod pro export, zálohu i čtení neotevřeného deníku;
  // migrace volá oba kroky zvlášť (záloha mezi nimi). Obchod, na kterém není
  // co převést, se vrací tentýž.
  function tradeToV3(trade) {
    return convertLegacyNear(stripRemovedV3(trade));
  }

  // Úprava číselníků deníku pro kontext v3: dvě kolonky SR se stanou jednou
  // („Hladiny v blízkosti") – skryté zůstane jen to, co bylo skryté v OBOU,
  // ať volba, kterou uživatel na jedné straně používal, nezmizí. Skupiny
  // zrušených polí se odstraní. Konfigurace bez nich se vrací táž.
  const DEAD_V3_GROUPS = ['SR_TARGET', 'SR_SL', 'LIQUIDITY_SWEPT', 'PATH_PROFILE'];

  function migrateConfigV3(config) {
    if (!config || typeof config !== 'object' || !DEAD_V3_GROUPS.some(k => config[k] !== undefined)) return config;
    const out = { ...config };
    for (const key of DEAD_V3_GROUPS) delete out[key];
    const isGroup = g => !!g && typeof g === 'object';
    const sides = [config.SR_TARGET, config.SR_SL];
    if (sides.some(isGroup) && !isGroup(out.NEAR_LEVEL)) {
      const base = isGroup(config.ENTRY_LEVEL) ? config.ENTRY_LEVEL : {};
      // Kolonka bez vlastního nastavení dědila skrývání z hladiny vstupu.
      const effective = g => (isGroup(g) && (Array.isArray(g.hidden) || Array.isArray(g.visible)) ? g : base);
      const list = (g, field) => (Array.isArray(g[field]) ? g[field] : []);
      const [a, b] = sides.map(effective);
      const near = { hidden: list(a, 'hidden').filter(k => list(b, 'hidden').includes(k)) };
      const visible = [...new Set([...list(a, 'visible'), ...list(b, 'visible')])];
      if (visible.length) near.visible = visible;
      const order = sides.filter(isGroup).map(g => g.order).find(Array.isArray);
      if (order) near.order = order.slice();
      out.NEAR_LEVEL = near;
    }
    return out;
  }

  // Konfluence: `NONE` je výslovné „žádná hladina", takže se nepočítá.
  function confluenceCount(entryLevels, config) {
    return sanitizeMulti('ENTRY_LEVEL', entryLevels, config).filter(k => k !== 'NONE').length;
  }

  // Klíče kontextových polí, která obchod nemá vyplněná (štítek „Neúplné").
  // Pořadí je pořadí formuláře. Nekontroluje se, co je nepovinné nebo má
  // hodnotu vždy: doba sledování, cílová hladina 2, „protipohyb přišel dřív".
  //  - hladiny v blízkosti jsou vyplněné řádky NEBO příznakem „žádná hladina
  //    v blízkosti" (čte se i starý tvar – nepřevedený deník se posoudí stejně),
  //  - cílová hladina 1 potřebuje typ i cenu (bez ceny nejde R hladiny),
  //  - čísla (cena SL, MFE/MAE, po výstupu): vyplněná je i nula a i hodnota
  //    odvozená z výstupu; chybí jen prázdné,
  //  - u výslovně nenaplněného setupu (NO_FILL, MISSED…) se pole, která
  //    popisují průběh a výstup, nekontrolují – nebylo co měřit.
  function missingContextKeys(trade, config) {
    if (!trade || typeof trade !== 'object' || trade.recordType === 'SETUP_ONLY') return [];
    const missing = [];
    const filledNumber = v => v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(Number(v));
    if (!sanitizeSingle('SETUP', trade.setupCode, config)) missing.push('setupCode');
    if (!sanitizeSingle('FILL_STATUS', trade.fillStatus, config)) missing.push('fillStatus');
    if (!sanitizeSingle('TREND', trade.trend, config)) missing.push('trend');
    if (!sanitizeMulti('ENTRY_LEVEL', trade.entryLevels, config).length) missing.push('entryLevels');
    if (!sanitizeNearLevels('NEAR_LEVEL', nearLevelsOf(trade), config).length && !nearLevelsNoneOf(trade)) missing.push('nearLevels');
    if (!sanitizeMulti('OF_CONFIRM', trade.ofConfirm, config).length) missing.push('ofConfirm');
    // Kontext v2 (A4): trend 30m a známka. Ostatní pole kontextu se hlásí jen
    // na přání (Nastavení → Přizpůsobení → Pole kontextu, missingContextByCard),
    // ať „Neúplné" nezčervená celý deník najednou.
    if (!sanitizeSingle('TREND_HTF', trade.trendHtf, config)) missing.push('trendHtf');
    if (!sanitizeSingle('GRADE', trade.grade, config)) missing.push('grade');
    const target = sanitizeTargetLevel(trade.targetLevel1, config);
    if (!target || !target.type || target.price == null) missing.push('targetLevel1');
    // Nenaplněný / vynechaný setup vyplněný jako celý hypotetický obchod (má
    // výstupní cenu) se posuzuje jako naplněný.
    const fill = trade.fillStatus;
    if (!fill || fill === 'FILLED' || filledNumber(trade.exitPrice)) {
      for (const key of ['slPrice', 'mfeTicks', 'maeTicks', 'postExitFavorableTicks', 'postExitAdverseTicks']) {
        if (!filledNumber(trade[key])) missing.push(key);
      }
    }
    return missing;
  }

  // Popisek kontextového pole podle klíče (TRADE_CONTEXT_FIELDS).
  function contextFieldLabel(key) {
    return TRADE_CONTEXT_FIELDS.find(f => f.key === key)?.label || key;
  }

  // ------------------------------------------------- karty formuláře obchodu
  // Karty formuláře (Nastavení → Přizpůsobení): každou jde skrýt a u každé
  // zvlášť vypnout upozornění na nevyplněná pole. `checks: false` = karta nemá
  // žádné kontrolované pole (komentáře jsou vždy nepovinné).
  const TRADE_CARDS = [
    { key: 'sltp', label: 'SL / TP' },
    { key: 'course', label: 'Pohyb ceny' },
    { key: 'setup', label: 'Setup' },
    { key: 'levels', label: 'Hladiny' },
    { key: 'comments', label: 'Komentáře', checks: false }
  ];
  // Do které karty patří kontrolované pole. Cílová hladina 1 se dělí: typ
  // je v Hladinách, cena v SL / TP – tam se plánovaný cíl ručně přepisuje
  // (bez ceny nejde plánované R).
  const CARD_OF_FIELD = {
    slPrice: 'sltp',
    mfeTicks: 'course', maeTicks: 'course', postExitFavorableTicks: 'course', postExitAdverseTicks: 'course',
    setupCode: 'setup', fillStatus: 'setup', trend: 'setup', trendHtf: 'setup', grade: 'setup',
    entryLevels: 'levels', nearLevels: 'levels', ofConfirm: 'levels'
  };

  // ---------------------------------------------------- pole kontextu (v3 A4)
  // Jednotlivá pole kontextu jdou skrýt a u každého zvlášť zapnout upozornění
  // na nevyplněné (Nastavení → Přizpůsobení → Pole kontextu). Skryté pole
  // zmizí z formuláře, rychlého formuláře, karty obchodu i dne a nepočítá se
  // do „Neúplné"; DATA ZŮSTÁVAJÍ a jdou do exportů.
  // `warnDefault` = pole se hlásilo už dřív (trend 30m, známka). Ostatní mají
  // upozornění ve výchozím stavu vypnuté, ať starší obchody nezčervenají.
  // `checks: false` = není co kontrolovat (dopočet).
  const CONTEXT_FIELDS = [
    { key: 'trendHtf', label: 'Trend 30m', warnDefault: true },
    { key: 'grade', label: 'Známka A/B/C', warnDefault: true },
    { key: 'entryTestNo', label: 'Kolikátý test vstupu' },
    { key: 'absLocation', label: 'Absorpce – kde' },
    { key: 'levelTestState', label: 'Test / netest u hladin' },
    { key: 'dayContext', label: 'Kontext dne' },
    { key: 'derivedRow', label: 'Řádek dopočtů', checks: false },
    // Řádek „Vstupy" na kartě obchodu a pole „Vstup" u cíle ve formuláři.
    { key: 'entries', label: 'Vstupy a dokupy', checks: false }
  ];
  const CONTEXT_FIELD_BY_KEY = Object.fromEntries(CONTEXT_FIELDS.map(f => [f.key, f]));

  // { show, warn } jedné zapínatelné položky (karta, pole kontextu) z uloženého
  // nastavení. Chybějící položka nebo hodnota = výchozí: zobrazeno, upozornění
  // podle `warnDefault`. Čte se jen ta jedna položka – volá se při vykreslení
  // za každý obchod.
  function toggleOf(raw, key, warnDefault) {
    const c = raw && typeof raw === 'object' && raw[key] && typeof raw[key] === 'object' ? raw[key] : {};
    return { show: c.show !== false, warn: typeof c.warn === 'boolean' ? c.warn : warnDefault };
  }
  const normalizeToggles = (items, raw, toggle) => Object.fromEntries(items.map(item => [item.key, toggle(raw, item)]));

  // Nastavení polí: { trendHtf: { show, warn }, … }. Upozornění ve výchozím
  // stavu podle warnDefault.
  const fieldToggle = (raw, field) => toggleOf(raw, field.key, field.warnDefault === true);
  function normalizeFieldConfig(raw) { return normalizeToggles(CONTEXT_FIELDS, raw, fieldToggle); }
  function fieldShown(fieldConfig, key) {
    const field = CONTEXT_FIELD_BY_KEY[key];
    return !field || fieldToggle(fieldConfig, field).show;
  }
  function fieldWarns(fieldConfig, key) {
    const field = CONTEXT_FIELD_BY_KEY[key];
    if (!field || field.checks === false) return false;
    const c = fieldToggle(fieldConfig, field);
    return c.show && c.warn;
  }

  // Chybějící pole rozdělená po kartách, jako popisky. Rozhoduje
  // missingContextKeys – tady se jen třídí a filtruje podle nastavení polí:
  // trend 30m a známka vypadnou, když jsou skryté nebo bez upozornění;
  // kolikátý test, absorpce a test / netest u hladin se naopak přidají jen se
  // zapnutým upozorněním.
  function missingContextByCard(trade, config, fieldConfig) {
    const out = {};
    for (const card of TRADE_CARDS) out[card.key] = [];
    for (const key of missingContextKeys(trade, config)) {
      if (CONTEXT_FIELD_BY_KEY[key] && !fieldWarns(fieldConfig, key)) continue;
      if (key === 'targetLevel1') {
        const tl = (trade && trade.targetLevel1) || {};
        if (!sanitizeSingle('TARGET_LEVEL', tl.type, config)) out.levels.push(contextFieldLabel(key) + ' (typ)');
        if (numOrNull(tl.price) == null) out.sltp.push('Cena targetu');
        continue;
      }
      out[CARD_OF_FIELD[key] || 'setup'].push(contextFieldLabel(key));
    }
    if (!trade || typeof trade !== 'object' || trade.recordType === 'SETUP_ONLY') return out;
    if (fieldWarns(fieldConfig, 'entryTestNo') && !sanitizeSingle('ENTRY_TEST_NO', trade.entryTestNo, config)) out.setup.push(CONTEXT_FIELD_BY_KEY.entryTestNo.label);
    if (fieldWarns(fieldConfig, 'absLocation') && !sanitizeSingle('ABS_LOCATION', trade.absLocation, config)) out.levels.push(CONTEXT_FIELD_BY_KEY.absLocation.label);
    if (fieldWarns(fieldConfig, 'levelTestState') && nearLevelsOf(trade).some(r => !r.testState)) out.levels.push(CONTEXT_FIELD_BY_KEY.levelTestState.label);
    return out;
  }

  // Nastavení karet: { sltp: { show, warn }, … }. Výchozí stav je vše
  // zobrazené i s upozorněním.
  const CARD_BY_KEY = Object.fromEntries(TRADE_CARDS.map(c => [c.key, c]));
  const cardToggle = (raw, card) => toggleOf(raw, card.key, true);
  function normalizeCardConfig(raw) { return normalizeToggles(TRADE_CARDS, raw, cardToggle); }
  function cardShown(cardConfig, key) { return !CARD_BY_KEY[key] || cardToggle(cardConfig, CARD_BY_KEY[key]).show; }
  function cardWarns(cardConfig, key) {
    if (!CARD_BY_KEY[key]) return false;
    const c = cardToggle(cardConfig, CARD_BY_KEY[key]);
    return c.show && c.warn;
  }

  // Chybějící pole jen z karet, které jsou zobrazené a mají zapnuté upozornění
  // (štítek „Neúplné" na kartě obchodu). Kontext dne do žádné karty formuláře
  // nepatří: hlásí se, když má zapnuté upozornění a volající ví, že dni chybí
  // (`opts.dayContextMissing` – denní poznámky tenhle modul nezná).
  function missingForCards(trade, cardConfig, config, fieldConfig, opts) {
    const byCard = missingContextByCard(trade, config, fieldConfig);
    const labels = TRADE_CARDS.filter(card => cardWarns(cardConfig, card.key)).flatMap(card => byCard[card.key]);
    const isTrade = !!trade && typeof trade === 'object' && trade.recordType !== 'SETUP_ONLY';
    if (isTrade && opts?.dayContextMissing === true && fieldWarns(fieldConfig, 'dayContext')) labels.push(CONTEXT_FIELD_BY_KEY.dayContext.label);
    return labels;
  }

  // Klíč pro vlastní volbu. Odvozuje se z popisku, aby byl čitelný i v CSV,
  // ale po vytvoření se už NIKDY nemění – přejmenování volby mění jen popisek.
  function makeCustomKey(group, label, config) {
    const base = 'CUSTOM_' + String(label || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      .slice(0, 32);
    const taken = new Set(allKeys(group, config));
    if (base === 'CUSTOM_') return uniqueKey('CUSTOM_VOLBA', taken);
    return uniqueKey(base, taken);
  }

  function uniqueKey(base, taken) {
    if (!taken.has(base)) return base;
    for (let i = 2; i < 999; i++) {
      const candidate = base + '_' + i;
      if (!taken.has(candidate)) return candidate;
    }
    return base + '_' + Date.now();
  }

  // ------------------------------------------------- přenos mezi deníky

  // Očista importované konfigurace. Soubor může přijít odkudkoli, takže se
  // z něj bere jen to, co má správný tvar a ukazuje na známý klíč. Cizí klíč
  // v `labels`/`hidden`/`order` se zahodí; `custom` naopak nové klíče
  // ZAVÁDÍ, takže se validuje zvlášť a nesmí přebít výchozí klíč.
  const CUSTOM_KEY_RE = /^[A-Z0-9_]{1,64}$/;
  const MAX_LABEL = 120;

  function cleanLabel(value) {
    return (typeof value === 'string' && value.trim()) ? value.trim().slice(0, MAX_LABEL) : null;
  }

  function sanitizeConfig(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const group of GROUPS) {
      const g = raw[group.name];
      if (!g || typeof g !== 'object') continue;
      const clean = {};
      const defaults = DEFAULT_ENUMS[vocabularyOf(group.name)] || {};

      const custom = {};
      if (g.custom && typeof g.custom === 'object') {
        for (const key of Object.keys(g.custom)) {
          if (!CUSTOM_KEY_RE.test(key)) continue;
          // Vlastní volba nesmí přepsat výchozí klíč – jinak by import
          // tiše přeznačil význam hodnoty, kterou už obchody používají.
          if (Object.prototype.hasOwnProperty.call(defaults, key)) continue;
          const label = cleanLabel(g.custom[key]);
          if (label) custom[key] = label;
        }
        if (Object.keys(custom).length) clean.custom = custom;
      }

      // Odvozená skupina (Hladiny v blízkosti) nemá vlastní volby, sdílí je se
      // zdrojovou skupinou – její vlastní volby se proto smí skrývat a řadit
      // i tady. Bez toho kopie / export číselníků tiše zahodila např. skrytou
      // vlastní hladinu.
      const source = vocabularyOf(group.name);
      const sourceCustom = source !== group.name && raw[source]?.custom && typeof raw[source].custom === 'object'
        ? Object.keys(raw[source].custom).filter(k => CUSTOM_KEY_RE.test(k) && cleanLabel(raw[source].custom[k]))
        : [];
      const valid = new Set([...Object.keys(defaults), ...Object.keys(custom), ...sourceCustom]);

      if (g.labels && typeof g.labels === 'object') {
        const labels = {};
        for (const key of Object.keys(g.labels)) {
          if (!valid.has(key)) continue;
          const label = cleanLabel(g.labels[key]);
          if (label) labels[key] = label;
        }
        if (Object.keys(labels).length) clean.labels = labels;
      }

      for (const field of ['hidden', 'visible', 'order']) {
        if (!Array.isArray(g[field])) continue;
        const list = [...new Set(g[field].filter(key => valid.has(key)))];
        if (list.length) clean[field] = list;
      }

      // „Je to hladina" (jen slovník cílů): známé klíče, jen true / false.
      if (group.name === 'TARGET_LEVEL' && g.isLevel && typeof g.isLevel === 'object') {
        const isLevel = {};
        for (const key of Object.keys(g.isLevel)) {
          if (valid.has(key) && typeof g.isLevel[key] === 'boolean') isLevel[key] = g.isLevel[key];
        }
        if (Object.keys(isLevel).length) clean.isLevel = isLevel;
      }

      if (Object.keys(clean).length) out[group.name] = clean;
    }
    return out;
  }

  const EXPORT_KIND = 'futures-journal-taxonomy';
  const EXPORT_VERSION = 1;

  function exportPayload(config, meta) {
    return {
      app: 'futures-journal-pro',
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      ...(meta || {}),
      taxonomy: sanitizeConfig(config)
    };
  }

  // Přijme jak celý exportovaný soubor, tak samotnou konfiguraci – ať se dá
  // naimportovat i výřez, který si někdo vytáhne ze zálohy deníku.
  function configFromImport(parsed) {
    if (!parsed || typeof parsed !== 'object') throw new Error('Soubor není platný JSON objekt.');
    if (parsed.kind && parsed.kind !== EXPORT_KIND) {
      throw new Error('Soubor není export číselníků (kind: ' + parsed.kind + ').');
    }
    const source = parsed.taxonomy && typeof parsed.taxonomy === 'object' ? parsed.taxonomy : parsed;
    // Soubor ze starší verze nese dvě kolonky SR (proti targetu / proti S/L) –
    // převedou se stejným pravidlem jako při migraci deníku, jinak by je očista
    // tiše zahodila i se skrytím a pořadím.
    const clean = sanitizeConfig(migrateConfigV3(source));
    if (!Object.keys(clean).length) throw new Error('Soubor neobsahuje žádnou použitelnou úpravu číselníku.');
    return clean;
  }

  // Krátký popis, co konfigurace obsahuje – do potvrzovacího dialogu, ať
  // uživatel ví, co přepisuje, ještě než to potvrdí.
  function describeConfig(config) {
    const clean = sanitizeConfig(config);
    return GROUPS.map(group => {
      const g = clean[group.name];
      if (!g) return null;
      const parts = [];
      if (g.labels) parts.push(Object.keys(g.labels).length + '× přejmenováno');
      if (g.custom) parts.push(Object.keys(g.custom).length + '× vlastní volba');
      if (g.hidden && g.hidden.length) parts.push(g.hidden.length + '× skryto');
      if (g.order) parts.push('vlastní pořadí');
      if (g.isLevel) parts.push(Object.keys(g.isLevel).length + '× „je to hladina"');
      return parts.length ? group.label + ': ' + parts.join(', ') : null;
    }).filter(Boolean);
  }

  return {
    // výchozí číselníky (neměnné – uživatelská úprava jde přes config)
    SETUP, ENTRY_LEVEL, OF_CONFIRM, TREND, FILL_STATUS, TARGET_LEVEL, SKIP_REASON,
    TREND_HTF, ABS_LOCATION, ENTRY_TEST_NO, GRADE, TEST_STATE, DEFAULT_HIDDEN,
    DAY_OPEN, DAY_TYPE, DAY_VALUE_MIGRATION, DAY_NEWS,
    sanitizeTestState,
    // hladiny v blízkosti (kontext v3) a převod starého zápisu
    sanitizeNearLevels, nearLevelsFromLegacy, nearLevelsOf, nearLevelsNoneOf, setNearLevels,
    convertLegacyNear, stripRemovedV3, tradeToV3, migrateConfigV3, V3_REMOVED_KEYS,
    ENUMS: DEFAULT_ENUMS, DEFAULT_ENUMS, DEFAULT_ALIASES, GROUPS, GROUP_BY_NAME, vocabularyOf, TRADE_CONTEXT_FIELDS,
    // konfigurace
    applyConfig, getConfig, groupConfig,
    // dotazy
    allKeys, aliasesFor, canonicalKey, hiddenKeys, isHidden, labelOf, isValidKey, isLevelKey, DEFAULT_NOT_LEVEL,
    visibleOptions, sanitizeMulti, sanitizeSingle, sanitizeTargetLevel, sanitizeLevelRows, hasLegacyLevelRows, confluenceCount,
    missingContextKeys, contextFieldLabel,
    TRADE_CARDS, missingContextByCard, normalizeCardConfig, cardShown, cardWarns, missingForCards,
    CONTEXT_FIELDS, normalizeFieldConfig, fieldShown, fieldWarns,
    makeCustomKey,
    // přenos mezi deníky a soubor
    sanitizeConfig, exportPayload, configFromImport, describeConfig,
    EXPORT_KIND, EXPORT_VERSION
  };
}));
