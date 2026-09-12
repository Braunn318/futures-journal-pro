'use strict';
// Číselníky pro backtest kontext obchodu (spec §4.2).
//
// Proč číselníky a ne volný text: podle čeho se nedá filtrovat, to se nedá
// vyhodnotit. Dnes je kontext obchodu ve volném komentáři, takže se z něj
// nedá udělat breakdown podle setupu ani podle hladiny vstupu.
//
// Hodnoty jsou STABILNÍ KLÍČE, popisky jsou jen lokalizované řetězce pro UI.
// Do dat se ukládá klíč, nikdy popisek – jinak by přejmenování popisku
// znehodnotilo historii.
//
// Rozsah podle spec §1.1: zavádí se pět polí, která blokují start sběru dat
// (setupCode, entryLevels, ofConfirm, fillStatus, slPrice). Zbytek číselníků
// z §4.2 (target1Level, profileDay, structure, violations…) přijde souběžně
// se sběrem, proto tu zatím nejsou – ať se nezavádí pole, která nikdo neplní.
//
// Modul se načítá přes <script src> před hlavním skriptem (bundler v projektu
// není) a zároveň jde načíst v Node testech.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJTaxonomy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

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

  // Hladina, na které ležel vstup. MULTI-SELECT, protože konfluence hladin je
  // sama o sobě informace – kolik jich bylo, se dopočítává jako confluenceCount.
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
    NONE: 'Žádná hladina'
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

  // Stav naplnění. Povinné u backtest záznamů – bez něj statistika měří jen
  // přeživší obchody a je systematicky optimistická.
  const FILL_STATUS = {
    FILLED: 'naplněno',
    NO_FILL: 'limitka se nenaplnila',
    MISSED: 'setup byl, nestihl jsem',
    SKIPPED: 'setup byl, vědomě vynechán'
  };

  // Popis polí na obchodu: kardinalita rozhoduje, jak se pole chová při
  // slučování víc cílů do jednoho obchodu (spec §2.1) a jak se vykresluje.
  const TRADE_CONTEXT_FIELDS = [
    { key: 'setupCode', cardinality: 'single', enumName: 'SETUP', label: 'Setup' },
    { key: 'entryLevels', cardinality: 'multi', enumName: 'ENTRY_LEVEL', label: 'Hladina vstupu' },
    { key: 'ofConfirm', cardinality: 'multi', enumName: 'OF_CONFIRM', label: 'Order flow potvrzení' },
    { key: 'fillStatus', cardinality: 'single', enumName: 'FILL_STATUS', label: 'Stav naplnění' },
    { key: 'slPrice', cardinality: 'number', enumName: null, label: 'Cena Stop Lossu' }
  ];

  const ENUMS = { SETUP, ENTRY_LEVEL, OF_CONFIRM, FILL_STATUS };

  function labelOf(enumName, key) {
    const table = ENUMS[enumName];
    if (!table) return String(key || '');
    return table[key] || String(key || '');
  }

  function isValidKey(enumName, key) {
    const table = ENUMS[enumName];
    return !!(table && Object.prototype.hasOwnProperty.call(table, key));
  }

  // Očistí hodnotu multi-select pole: jen známé klíče, bez duplicit, stabilní
  // pořadí podle číselníku. Neznámý klíč se zahazuje – do dat nesmí prosáknout
  // překlep, který by pak v breakdownu vytvořil vlastní řádek.
  function sanitizeMulti(enumName, values) {
    const table = ENUMS[enumName] || {};
    const wanted = new Set(Array.isArray(values) ? values : []);
    return Object.keys(table).filter(k => wanted.has(k));
  }

  function sanitizeSingle(enumName, value) {
    return isValidKey(enumName, value) ? value : '';
  }

  // Počet hladin v konfluenci: `NONE` se nepočítá, je to výslovné „žádná".
  function confluenceCount(entryLevels) {
    return sanitizeMulti('ENTRY_LEVEL', entryLevels).filter(k => k !== 'NONE').length;
  }

  return {
    SETUP, ENTRY_LEVEL, OF_CONFIRM, FILL_STATUS,
    ENUMS, TRADE_CONTEXT_FIELDS,
    labelOf, isValidKey, sanitizeMulti, sanitizeSingle, confluenceCount
  };
}));
