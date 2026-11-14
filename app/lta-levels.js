'use strict';
// LTA (LiveTradingAsistent) Custom Levels → řádky „Hladiny v blízkosti".
//
// LTA ukládá levely do <Dokumenty>\NinjaTrader 8\bin\LiveTradingAsistent\
// CustomLevels\{System,Local}\*.xml a každých pár minut je přepisuje – v
// souborech je vždy jen aktuální stav. Archiv verzí po dnech vede main proces
// (app/lta-store.js); tady jsou jen čisté funkce, které potřebuje main proces
// i renderer: čtení XML, výběr kontraktu, klíč číselníku a výběr nejbližších.
//
// Deník hladiny MĚŘÍ, nehodnotí (kontext v3): výběr N nejbližších je jen to,
// které řádky se předvyplní. Žádná tolerance ani pásmo se neukládá a řádek
// nese jen { level, price } – test / netest LTA nezná, doplňuje ho uživatel.
//
// Modul se načítá přes <script src> v rendereru i přes require v Node.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJLta = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Skupina číselníku, do které se názvy LTA levelů zakládají (taxonomy.js).
  const GROUP = 'LTA_LEVELS';
  const KEY_PREFIX = 'LTA_';
  // Řádek VWAP v čase vstupu (počítá ho konektor NT8, ne LTA soubory).
  const VWAP_NAME = 'VWAP';

  // Výchozí složka relativně k Dokumentům.
  const DEFAULT_SUBDIR = ['NinjaTrader 8', 'bin', 'LiveTradingAsistent', 'CustomLevels'];

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    folder: '',            // '' = výchozí složka v Dokumentech
    nearestCount: 3,       // N nad + N pod vstupem
    autoInForm: true,      // doplnit ve formuláři, když je seznam prázdný
    archive: true,         // ukládat verze levelů po dnech
    retentionDays: 0,      // 0 = archiv se nemaže (od 4.8.102; mazání = ztráta dat)
    retentionMigrated: false, // stará výchozí 90 už převedená na 0 (lta-store.getSettings)
    vwapRow: true,         // přidat VWAP v čase vstupu (z konektoru NT8)
    disabledFiles: [],     // relativní cesty souborů, které se nečtou (System/ATR_NT8.xml)
    excludedNames: [],     // názvy levelů z LTA, které se nedoplňují (OPEN, Combo L2…)
    excludePatterns: []    // level se nedoplní, když jeho název obsahuje text (bez ohledu na velikost)
  });

  function cleanSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    const int = (v, min, max, def) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
    };
    return {
      enabled: s.enabled !== false,
      folder: typeof s.folder === 'string' ? s.folder.trim() : '',
      nearestCount: int(s.nearestCount, 0, 50, DEFAULT_SETTINGS.nearestCount),
      autoInForm: s.autoInForm !== false,
      archive: s.archive !== false,
      retentionDays: int(s.retentionDays, 0, 3650, DEFAULT_SETTINGS.retentionDays),
      retentionMigrated: s.retentionMigrated === true,
      vwapRow: s.vwapRow !== false,
      disabledFiles: Array.isArray(s.disabledFiles)
        ? [...new Set(s.disabledFiles.filter(f => typeof f === 'string' && f).map(normalizeRelPath))]
        : [],
      excludedNames: cleanTextList(s.excludedNames),
      excludePatterns: cleanTextList(s.excludePatterns)
    };
  }

  function cleanTextList(list) {
    return Array.isArray(list)
      ? [...new Set(list.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))]
      : [];
  }

  // Vzor, kterým je název vyloučený (první shoda), jinak null.
  function excludingPattern(name, settings) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    for (const p of (settings && settings.excludePatterns) || []) {
      const t = String(p || '').trim().toLowerCase();
      if (t && n.includes(t)) return p;
    }
    return null;
  }

  // Level se nedoplňuje: název je v seznamu vyloučených nebo obsahuje vzor.
  // Týká se jen doplňování – v archivu i v číselníku level zůstává.
  function isExcluded(name, settings) {
    const n = String(name || '').trim();
    if (!n || !settings) return false;
    if ((settings.excludedNames || []).includes(n)) return true;
    return excludingPattern(n, settings) !== null;
  }

  function normalizeRelPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  // ------------------------------------------------------------- čtení XML

  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, '&');
  }

  function attr(tag, name) {
    const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
    return m ? decodeEntities(m[1]) : null;
  }

  function childText(block, name) {
    const m = new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(block);
    return m ? decodeEntities(m[1]).trim() : '';
  }

  // Popisek levelu v LTA začíná číslem (velikost písma v grafu): „30 ID vPOC",
  // „43 W VWAP", „9 MHL_0". Do deníku jde název bez něj.
  function levelName(caption) {
    return String(caption || '').trim().replace(/^\d+\s+/, '').trim();
  }

  // „ES 12-26" → ES, „@XAUUSD" → XAUUSD, „EURUSD" → EURUSD.
  function instrumentRoot(instrument) {
    return String(instrument || '').trim().toUpperCase().replace(/^@/, '').split(/\s+/)[0] || '';
  }

  // „ES 12-26" → { month: 12, year: 2026 }; forex / bez měsíce → null.
  function contractMonth(instrument) {
    const m = /\s(\d{1,2})-(\d{2})\s*$/.exec(String(instrument || ''));
    if (!m) return null;
    const month = Number(m[1]);
    if (month < 1 || month > 12) return null;
    return { month, year: 2000 + Number(m[2]) };
  }

  function parseLtaXml(text, source) {
    const out = [];
    const re = /<Level\b([^>]*)>([\s\S]*?)<\/Level>/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      const head = m[1];
      const body = m[2];
      const instrument = (attr(head, 'Instrument') || '').trim();
      const price = Number(attr(head, 'Price'));
      const capMatch = /<Caption\b([^>]*)\/?>/.exec(body);
      const name = levelName(capMatch ? attr(capMatch[1], 'Text') : '') || (attr(head, 'LevelId') || '').trim();
      if (!instrument || !name || !Number.isFinite(price)) continue;
      const level = { source: normalizeRelPath(source), instrument, root: instrumentRoot(instrument), name, price };
      const lower = Number(childText(body, 'ZoneRangeLower'));
      const upper = Number(childText(body, 'ZoneRangeUpper'));
      if (Number.isFinite(lower) && lower) level.zoneLower = lower;
      if (Number.isFinite(upper) && upper) level.zoneUpper = upper;
      out.push(level);
    }
    return out;
  }

  // Podpis obsahu – mění se jen se skutečnou změnou levelů (ne s GUID, barvou
  // ani časem zápisu souboru). Podle něj archiv pozná, že není co ukládat.
  function levelsSignature(levels) {
    const rows = (Array.isArray(levels) ? levels : [])
      .map(l => [l.source, l.instrument, l.name, l.price, l.zoneLower || 0, l.zoneUpper || 0].join('|'))
      .sort();
    let h = 2166136261;
    const text = rows.join('\n');
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return rows.length + ':' + (h >>> 0).toString(16);
  }

  // -------------------------------------------------- výběr verze a kontraktu

  // Verze platná v čase vstupu: poslední s `from` <= vstup. Vstup před první
  // verzí dne (deník v tu dobu neběžel) bere první verzi dne – levely se
  // během dne běžně nemění.
  function versionAt(versions, entryMs) {
    const list = (Array.isArray(versions) ? versions : [])
      .filter(v => v && Array.isArray(v.levels))
      .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
    if (!list.length) return null;
    if (!Number.isFinite(entryMs)) return list[list.length - 1];
    let pick = list[0];
    for (const v of list) if (Date.parse(v.from) <= entryMs) pick = v;
    return pick;
  }

  // Levely jednoho kořene. Když jich kořen má víc kontraktů (CL 11-26 i
  // CL 12-26), bere se kontrakt z obchodu (instrumentFull z konektoru), jinak
  // nejbližší neexpirovaný k datu obchodu, jinak poslední. Bez měsíce (forex)
  // se nevybírá nic.
  function levelsForInstrument(levels, root, instrumentFull, dateIso) {
    const want = instrumentRoot(root);
    const list = (Array.isArray(levels) ? levels : []).filter(l => l && instrumentRoot(l.instrument) === want);
    const contracts = [...new Set(list.map(l => l.instrument))];
    if (contracts.length <= 1) return list;
    const full = String(instrumentFull || '').trim().toUpperCase();
    const exact = contracts.find(c => c.toUpperCase() === full);
    if (exact) return list.filter(l => l.instrument === exact);
    const d = dateIso ? new Date(dateIso) : new Date();
    const now = Number.isNaN(d.getTime()) ? { y: 0, m: 0 } : { y: d.getFullYear(), m: d.getMonth() + 1 };
    const dated = contracts
      .map(c => ({ c, cm: contractMonth(c) }))
      .filter(x => x.cm)
      .sort((a, b) => (a.cm.year - b.cm.year) || (a.cm.month - b.cm.month));
    const front = dated.find(x => x.cm.year > now.y || (x.cm.year === now.y && x.cm.month >= now.m));
    const chosen = front ? front.c : (dated.length ? dated[dated.length - 1].c : contracts[0]);
    return list.filter(l => l.instrument === chosen);
  }

  // ------------------------------------------------------- klíč číselníku

  function slug(name) {
    return String(name || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      .slice(0, 48);
  }

  // Klíč volby pro název z LTA. `existing` = { klíč: popisek } dosud založených
  // LTA voleb; klíč se hledá PODLE NÁZVU z LTA (uloženého v `names`), ne podle
  // popisku – přejmenování volby tak nezaloží novou. `taken` = klíče, které
  // nesmí vzniknout znovu (jiné skupiny, smazané volby).
  function keyForName(name, names, taken) {
    const wanted = String(name || '').trim();
    for (const [key, n] of Object.entries(names || {})) if (n === wanted) return key;
    const base = KEY_PREFIX + (slug(wanted) || 'LEVEL');
    const used = taken instanceof Set ? taken : new Set(taken || []);
    if (!used.has(base) && !Object.prototype.hasOwnProperty.call(names || {}, base)) return base;
    for (let i = 2; i < 999; i++) {
      const k = base + '_' + i;
      if (!used.has(k) && !Object.prototype.hasOwnProperty.call(names || {}, k)) return k;
    }
    return base + '_' + Date.now();
  }

  // ------------------------------------------------------ N nejbližších

  // `levels` = [{ name, price }], `keyFor(name)` → klíč číselníku,
  // `isHidden(key)` → skrytá volba se nedoplňuje. Vrací N nejbližších nad
  // (cena >= vstup) a N pod vstupem, každý pár typ + cena jen jednou, seřazené
  // od nejvyšší ceny. Bez vstupní ceny nic.
  function nearestRows(levels, entryPrice, n, keyFor, isHidden) {
    const entry = Number(entryPrice);
    const count = Math.max(0, Math.round(Number(n)) || 0);
    if (!Number.isFinite(entry) || entry <= 0 || !count) return [];
    const seen = new Set();
    const rows = [];
    for (const l of Array.isArray(levels) ? levels : []) {
      const price = Number(l?.price);
      if (!Number.isFinite(price)) continue;
      const level = keyFor(l.name);
      if (!level || (isHidden && isHidden(level))) continue;
      const sig = level + '|' + price;
      if (seen.has(sig)) continue;
      seen.add(sig);
      rows.push({ level, price });
    }
    const above = rows.filter(r => r.price >= entry).sort((a, b) => a.price - b.price).slice(0, count);
    const below = rows.filter(r => r.price < entry).sort((a, b) => b.price - a.price).slice(0, count);
    return [...above.reverse(), ...below];
  }

  // Doplní nové řádky ke stávajícím: nic nemaže ani nepřepisuje, stejný typ +
  // cena se nepřidá podruhé. Ruční řádky mají vždy přednost.
  function mergeRows(existing, added) {
    const list = Array.isArray(existing) ? existing.slice() : [];
    const seen = new Set(list.map(r => r?.level + '|' + Number(r?.price)));
    for (const r of Array.isArray(added) ? added : []) {
      const sig = r.level + '|' + Number(r.price);
      if (seen.has(sig)) continue;
      seen.add(sig);
      list.push({ level: r.level, price: r.price, ...(r.source ? { source: r.source } : {}) });
    }
    return list;
  }

  function roundPrice(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
  }

  // Cena na nejbližší tick instrumentu (VWAP v čase vstupu je průměr – jako
  // hladina se kreslí na tick). Bez platného ticku cena beze změny; výsledek
  // na 6 míst, ať desetinný tick (0,1) nevyrobí 2051.2000000000003.
  function roundToTick(v, tickSize) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return null;
    const t = Number(tickSize);
    if (!Number.isFinite(t) || t <= 0) return n;
    return Math.round(Math.round(n / t) * t * 1e6) / 1e6;
  }

  // Řádky Hladin s VWAP doplněným strojem (source 'lta', typ ve `vwapKeys`)
  // a cenou mimo tick → na tick. Ruční řádky a ostatní hladiny se nemění
  // (vrací se tentýž objekt). { rows, changed }.
  function snapVwapRows(rows, { tickSize, vwapKeys } = {}) {
    const keys = new Set(Array.isArray(vwapKeys) ? vwapKeys : []);
    const t = Number(tickSize);
    let changed = 0;
    const out = (Array.isArray(rows) ? rows : []).map(r => {
      if (!r || r.source !== 'lta' || !keys.has(r.level) || !(t > 0)) return r;
      const p = Number(r.price);
      if (!Number.isFinite(p)) return r;
      const snapped = roundToTick(p, t);
      if (snapped === p) return r;
      changed++;
      return { ...r, price: snapped };
    });
    return { rows: out, changed };
  }

  return {
    roundToTick, snapVwapRows,
    GROUP, KEY_PREFIX, VWAP_NAME, DEFAULT_SUBDIR, DEFAULT_SETTINGS,
    cleanSettings, normalizeRelPath, isExcluded, excludingPattern,
    parseLtaXml, levelName, instrumentRoot, contractMonth, levelsSignature,
    versionAt, levelsForInstrument,
    slug, keyForName, nearestRows, mergeRows, roundPrice
  };
}));
