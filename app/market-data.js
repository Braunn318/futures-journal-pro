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
    { key: 'snapshot', label: 'Snímek trhu při vstupu', desc: 'Konektor při vstupu pošle svíčky před vstupem s VPOC a deltou, profil dne a předchozí den.', recommended: true, ready: false },
    { key: 'signalBar', label: 'Náhled a výběr signální svíčky v kartě Setup', desc: 'Posledních 5 svíček před vstupem a zavření vůči vlastnímu VPOC.', recommended: true, ready: false, requires: ['snapshot'] },
    { key: 'snapshotLevels', label: 'Doplňování řádků hladin ze snímku', desc: 'VPOC 30m, VPOC / VAH / VAL dne a včerejška, high / low seance do Hladin v blízkosti.', recommended: true, ready: false, requires: ['snapshot'] },
    { key: 'autoTest', label: 'Test / netest doplněný ze svíček', desc: 'U řádků bez ručního test / netest doplní, jestli se cena hladiny před vstupem dotkla.', recommended: true, ready: false, requires: ['snapshot'] },
    { key: 'csvColumns', label: 'Nové sloupce v CSV', desc: 'Signální svíčka vůči VPOC, objem signální svíčky a zdroj řádků hladin.', recommended: false, ready: false }
  ]);
  const BY_KEY = Object.freeze(Object.fromEntries(FEATURES.map(f => [f.key, f])));

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    configured: false, // hlavní vypínač už byl někdy zapnutý (doporučená sada se zapne jen poprvé)
    features: Object.freeze(Object.fromEntries(FEATURES.map(f => [f.key, false])))
  });

  function cleanMarketSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const f = s.features && typeof s.features === 'object' ? s.features : {};
    return {
      enabled: s.enabled === true,
      configured: s.configured === true,
      features: Object.fromEntries(FEATURES.map(x => [x.key, f[x.key] === true]))
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
    return { enabled: true, configured: true, features };
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
