'use strict';
// Data trhu k obchodu – nastavení (Nastavení → Data trhu).
//
// Jeden hlavní vypínač a pod ním samostatný přepínač pro každou funkci
// (Claude files/ZADANI_DENIK_SNAPSHOT_TRHU.md, „Nastavení"). Výchozí stav po
// aktualizaci i u nové instalace je VYPNUTO: deník se pak chová a vypadá jako
// před touto dávkou. Vypnutí funkce nikdy nemaže uložená data, jen přestane
// sbírat a zobrazovat.
//
// Čisté funkce – načítá je renderer (<script src>) i main proces (require).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJMarket = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Pořadí = pořadí v kartě. `ready` = funkce už je v této verzi hotová
  // (karta ukazuje jen hotové). `recommended` = zapne ji první zapnutí
  // hlavního vypínače. `requires` = předpoklad, bez něj je přepínač zešedlý.
  const FEATURES = Object.freeze([
    { key: 'ltaExport', label: 'Export archivu LTA levelů pro Backtest Lab', desc: 'Archiv verzí levelů po dnech se kopíruje do ai-export/lta-levels (přepis jen při změně).', recommended: true, ready: true },
    { key: 'ltaWarnings', label: 'Upozornění na verzi levelů po vstupu / chybějící archiv', desc: 'Levely, které deník uložil až po vstupu, nebo den bez archivu se nedoplní samy – v kartě Hladiny se ukáže proč a rozhodneš ty.', recommended: true, ready: true },
    { key: 'marketBars', label: 'Ukládání minutových svíček dne', desc: 'Po uzavření obchodu konektor NT8 (verze 5) pošle minutové svíčky OHLCV celé seance dne obchodu (<userData>/market, kopie v ai-export/market).', recommended: true, ready: true },
    { key: 'snapshot', label: 'Snímek trhu při vstupu', desc: 'Konektor NT8 (verze 6) při vstupu pošle 25 minutových svíček před vstupem s VPOC a deltou, 30min svíčky s VPOC, VPOC / VAH / VAL a high / low dne do vstupu a VWAP. Včerejší hodnoty ze svíček předchozího dne.', recommended: true, ready: true },
    { key: 'signalBar', label: 'Náhled a výběr signální svíčky v kartě Setup', desc: 'Posledních 5 svíček před vstupem; klikem se vybere jiná. Zavření vůči vlastnímu VPOC a objem vůči mediánu 20 předchozích (dopočet, neukládá se).', recommended: true, ready: true, requires: ['snapshot'] },
    { key: 'snapshotLevels', label: 'Doplňování řádků hladin ze snímku', desc: 'Netestované VPOC 30m, VPOC / VAH / VAL dne a včerejška, high / low seance a včerejška do Hladin v blízkosti – N nejbližších nad a pod vstupem. Ruční řádky se nikdy nepřepíšou.', recommended: true, ready: true, requires: ['snapshot'] },
    { key: 'autoTest', label: 'Test / netest doplněný ze svíček', desc: 'U řádků bez ručního test / netest doplní ze svíček dne, jestli se cena hladiny v seanci před vstupem dotkla (test) nebo ne (netest). Jde ručně přepsat.', recommended: true, ready: true, requires: ['snapshot'] },
    { key: 'csvColumns', label: 'Nové sloupce v CSV', desc: 'Na konec CSV (Deník i Reporty) přidá „Signální svíčka vůči VPOC“, „Objem signální svíčky ×“ a „Hladina n: zdroj“. Ostatní sloupce se nemění.', recommended: false, ready: true }
  ]);
  const BY_KEY = Object.freeze(Object.fromEntries(FEATURES.map(f => [f.key, f])));

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    configured: false, // hlavní vypínač už byl někdy zapnutý (doporučená sada se zapne jen poprvé)
    features: Object.freeze(Object.fromEntries(FEATURES.map(f => [f.key, false]))),
    levelsN: 3,          // řádky Hladin ze snímku: N nejbližších nad a N pod vstupem
    valueAreaPct: 70,    // value area (VAH / VAL) v % objemu
    levelTypes: Object.freeze({}) // vypnuté typy řádků ze snímku { DAY_VAH: false }
  });

  // Typy řádků ze snímku (app/market-snapshot.js) – v Node přes require,
  // v rendereru je skript načtený dřív.
  function levelTypeKeys() {
    let mod = typeof globalThis !== 'undefined' ? globalThis.FJSnapshot : null;
    if (!mod && typeof require === 'function') { try { mod = require('./market-snapshot.js'); } catch { mod = null; } }
    return (mod?.LEVEL_TYPES || []).map(t => t.key);
  }
  const clampInt = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

  function cleanMarketSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const f = s.features && typeof s.features === 'object' ? s.features : {};
    const types = s.levelTypes && typeof s.levelTypes === 'object' ? s.levelTypes : {};
    const known = new Set(levelTypeKeys());
    return {
      enabled: s.enabled === true,
      configured: s.configured === true,
      features: Object.fromEntries(FEATURES.map(x => [x.key, f[x.key] === true])),
      levelsN: clampInt(s.levelsN, 0, 20, DEFAULT_SETTINGS.levelsN),
      valueAreaPct: clampInt(s.valueAreaPct, 50, 95, DEFAULT_SETTINGS.valueAreaPct),
      // Ukládají se jen vypnuté typy – nový typ je tak zapnutý.
      levelTypes: Object.fromEntries(Object.entries(types).filter(([k, v]) => known.has(k) && v === false))
    };
  }

  // Zapnutí hlavního vypínače: poprvé zapne doporučenou sadu, potom už drží
  // přepínače, jak je uživatel nastavil.
  function setEnabled(settings, on) {
    const s = cleanMarketSettings(settings);
    if (!on) return { ...s, enabled: false };
    if (s.configured) return { ...s, enabled: true };
    const features = { ...s.features };
    for (const f of FEATURES) if (f.recommended) features[f.key] = true;
    return { ...s, enabled: true, configured: true, features };
  }

  function setFeature(settings, key, on) {
    const s = cleanMarketSettings(settings);
    if (!BY_KEY[key]) return s;
    return { ...s, features: { ...s.features, [key]: on === true } };
  }

  // Změna z UI / IPC: { enabled } přes setEnabled, { features: {...} } po jednom.
  function applyPatch(settings, patch) {
    let s = cleanMarketSettings(settings);
    const p = patch && typeof patch === 'object' ? patch : {};
    if (typeof p.enabled === 'boolean') s = setEnabled(s, p.enabled);
    if (p.features && typeof p.features === 'object') {
      for (const [k, v] of Object.entries(p.features)) s = setFeature(s, k, v === true);
    }
    if (p.levelsN !== undefined) s = cleanMarketSettings({ ...s, levelsN: p.levelsN });
    if (p.valueAreaPct !== undefined) s = cleanMarketSettings({ ...s, valueAreaPct: p.valueAreaPct });
    if (p.levelTypes && typeof p.levelTypes === 'object') {
      const merged = { ...s.levelTypes };
      for (const [k, v] of Object.entries(p.levelTypes)) { if (v === false) merged[k] = false; else delete merged[k]; }
      s = cleanMarketSettings({ ...s, levelTypes: merged });
    }
    return s;
  }

  function isOn(settings, key) {
    if (!settings || settings.enabled !== true || !BY_KEY[key]) return false;
    if (settings.features?.[key] !== true) return false;
    return (BY_KEY[key].requires || []).every(r => isOn(settings, r));
  }

  // Proč přepínač nejde použít (zešedlý v kartě), nebo null.
  function blockedReason(settings, key) {
    if (!settings || settings.enabled !== true) return 'Nejdřív zapni hlavní vypínač Data trhu.';
    const missing = (BY_KEY[key]?.requires || []).filter(r => !isOn(settings, r));
    if (missing.length) return 'Vyžaduje: ' + missing.map(r => `„${BY_KEY[r].label}“`).join(', ') + ' (snímek trhu).';
    return null;
  }

  return { FEATURES, DEFAULT_SETTINGS, cleanMarketSettings, setEnabled, setFeature, applyPatch, isOn, blockedReason };
}));
