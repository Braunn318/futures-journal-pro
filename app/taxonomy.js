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

  const DEFAULT_ENUMS = { SETUP, ENTRY_LEVEL, OF_CONFIRM, TREND, FILL_STATUS };

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
  // překážku před targetem – proto se udržuje na jednom místě a přejmenování
  // i nová vlastní volba platí rovnou pro všechny tři kolonky. Skrývání a
  // pořadí si ale každá kolonka může nastavit vlastní.
  const GROUPS = [
    { name: 'SETUP', label: 'Setup', cardinality: 'single' },
    { name: 'TREND', label: 'Trend', cardinality: 'single' },
    { name: 'ENTRY_LEVEL', label: 'Hladina vstupu', cardinality: 'multi' },
    { name: 'SR_TARGET', label: 'SR proti targetu', cardinality: 'multi', optionsFrom: 'ENTRY_LEVEL' },
    { name: 'SR_SL', label: 'SR proti S/L', cardinality: 'multi', optionsFrom: 'ENTRY_LEVEL' },
    { name: 'OF_CONFIRM', label: 'Order flow potvrzení', cardinality: 'multi' },
    { name: 'FILL_STATUS', label: 'Stav naplnění', cardinality: 'single' }
  ];

  const GROUP_BY_NAME = Object.fromEntries(GROUPS.map(g => [g.name, g]));

  // Skupina, ze které se berou volby a jejich popisky.
  function vocabularyOf(group) {
    return GROUP_BY_NAME[group]?.optionsFrom || group;
  }

  const TRADE_CONTEXT_FIELDS = [
    { key: 'setupCode', cardinality: 'single', enumName: 'SETUP', label: 'Setup' },
    { key: 'trend', cardinality: 'single', enumName: 'TREND', label: 'Trend' },
    { key: 'entryLevels', cardinality: 'multi', enumName: 'ENTRY_LEVEL', label: 'Hladina vstupu' },
    { key: 'srTarget', cardinality: 'multi', enumName: 'SR_TARGET', label: 'SR proti targetu' },
    { key: 'srStopLoss', cardinality: 'multi', enumName: 'SR_SL', label: 'SR proti S/L' },
    { key: 'ofConfirm', cardinality: 'multi', enumName: 'OF_CONFIRM', label: 'Order flow potvrzení' },
    { key: 'fillStatus', cardinality: 'single', enumName: 'FILL_STATUS', label: 'Stav naplnění' },
    { key: 'slPrice', cardinality: 'number', enumName: null, label: 'Cena Stop Lossu' },
    // Chování ceny PO VÝSTUPU. merge: 'lastExit' znamená, že u sloučeného
    // obchodu se hodnota NEBERE z první nohy jako u ostatních jednohodnotových
    // polí, ale z nohy s nejpozdějším časem výstupu – měří se pokračování ceny
    // po tom, co pozice fakticky skončila, ne po částečném výstupu uprostřed.
    { key: 'postExitFavorableTicks', cardinality: 'number', enumName: null, merge: 'lastExit', label: 'Pokračování po výstupu (ticky)' },
    { key: 'postExitAdverseTicks', cardinality: 'number', enumName: null, merge: 'lastExit', label: 'Protipohyb po výstupu (ticky)' },
    { key: 'postExitAdverseFirst', cardinality: 'bool', enumName: null, merge: 'lastExit', label: 'Protipohyb přišel dřív' }
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
    // smysl nabízet ani u SR kolonek.
    const own = groupConfig(group, config);
    const vocab = vocabularyOf(group);
    const inherited = vocab === group ? {} : groupConfig(vocab, config);
    const hasOwn = Array.isArray(own.hidden) || Array.isArray(own.visible);
    const g = hasOwn ? own : inherited;
    const explicit = Array.isArray(g.hidden) ? g.hidden : [];
    const unhidden = Array.isArray(g.visible) ? g.visible : [];
    const aliased = Object.keys(aliasesFor(group, config));
    return new Set([...explicit, ...aliased].filter(k => !unhidden.includes(k)));
  }

  function isHidden(group, key, config) {
    return hiddenKeys(group, config).has(key);
  }

  function labelOf(group, key, config) {
    if (!key) return '';
    // Popisek je vlastnost VOLBY, ne kolonky – přejmenovaná hladina se tak
    // stejně jmenuje u vstupu i u obou SR kolonek.
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

  // Konfluence: `NONE` je výslovné „žádná hladina", takže se nepočítá.
  function confluenceCount(entryLevels, config) {
    return sanitizeMulti('ENTRY_LEVEL', entryLevels, config).filter(k => k !== 'NONE').length;
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

      const valid = new Set([...Object.keys(defaults), ...Object.keys(custom)]);

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
    const clean = sanitizeConfig(source);
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
      return parts.length ? group.label + ': ' + parts.join(', ') : null;
    }).filter(Boolean);
  }

  return {
    // výchozí číselníky (neměnné – uživatelská úprava jde přes config)
    SETUP, ENTRY_LEVEL, OF_CONFIRM, TREND, FILL_STATUS,
    ENUMS: DEFAULT_ENUMS, DEFAULT_ENUMS, DEFAULT_ALIASES, GROUPS, GROUP_BY_NAME, vocabularyOf, TRADE_CONTEXT_FIELDS,
    // konfigurace
    applyConfig, getConfig, groupConfig,
    // dotazy
    allKeys, aliasesFor, canonicalKey, hiddenKeys, isHidden, labelOf, isValidKey,
    visibleOptions, sanitizeMulti, sanitizeSingle, confluenceCount,
    makeCustomKey,
    // přenos mezi deníky a soubor
    sanitizeConfig, exportPayload, configFromImport, describeConfig,
    EXPORT_KIND, EXPORT_VERSION
  };
}));
