'use strict';
// LTA Custom Levels → „Hladiny v blízkosti" (4.8.99).
//
// Čtení XML z LiveTradingAsistent, výběr kontraktu, N nejbližších nad a pod
// vstupem, číselník LTA Levels (zakládá se sám), archiv verzí po dnech
// a VWAP vstupu z konektoru NT8 (událost entry_vwap).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FJLta = require('../app/lta-levels.js');
const FJTaxonomy = require('../app/taxonomy.js');
const { createLtaStore, localDate } = require('../app/lta-store.js');
const { loadRenderer } = require('./helpers/extract');
const { captureHarness } = require('./helpers/capture-harness');

const plain = v => JSON.parse(JSON.stringify(v));

// Tvar souboru jako v LTA (zkráceno na podstatné).
function level(instrument, price, caption, { id = 'X', lower = 0, upper = 0 } = {}) {
  return `  <Level Workspace="SannyBot" Instrument="${instrument}" Price="${price}" LevelId="${id}" xsi:type="Chart">
    <Guid>00000000-0000-0000-0000-000000000000</Guid>
    <Caption Text="${caption}" Position="Right" />
    <Line><Color>#FFFE3101</Color><Width>1</Width><DashStyle>Solid</DashStyle></Line>
    <ZoneRangeLower>${lower}</ZoneRangeLower>
    <ZoneRangeUpper>${upper}</ZoneRangeUpper>
    <Alerts /><StartTime /><EndTime />
    <ShowInAllWorkspaces>true</ShowInAllWorkspaces>
    <LinkedLevels />
  </Level>`;
}
const xml = (...levels) => `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfLevel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
${levels.join('\n')}
</ArrayOfLevel>`;

// ------------------------------------------------------------------ parser

test('parser: instrument, cena, název bez čísla na začátku, zóny', () => {
  const levels = FJLta.parseLtaXml(xml(
    level('ES 12-26', '7754.25', '30 SETT', { id: 'SETT' }),
    level('NQ 12-26', '29562.00', '43 W VWAP'),
    level('@XAUUSD', '2650.5', '30 vPOC ASIE'),
    level('6E 12-26', '1.16380', '30 LUDVIK', { id: '39C5', lower: 14, upper: 14 }),
    level('ES 12-26', '7631', '30 Combo L1 &amp; more')
  ), 'System\\SETT_NT8.xml');
  assert.deepEqual(plain(levels), [
    { source: 'System/SETT_NT8.xml', instrument: 'ES 12-26', root: 'ES', name: 'SETT', price: 7754.25 },
    { source: 'System/SETT_NT8.xml', instrument: 'NQ 12-26', root: 'NQ', name: 'W VWAP', price: 29562 },
    { source: 'System/SETT_NT8.xml', instrument: '@XAUUSD', root: 'XAUUSD', name: 'vPOC ASIE', price: 2650.5 },
    { source: 'System/SETT_NT8.xml', instrument: '6E 12-26', root: '6E', name: 'LUDVIK', price: 1.1638, zoneLower: 14, zoneUpper: 14 },
    { source: 'System/SETT_NT8.xml', instrument: 'ES 12-26', root: 'ES', name: 'Combo L1 & more', price: 7631 }
  ]);
});

test('parser: prázdný soubor (Local/CustomLevels.xml) a level bez ceny', () => {
  assert.deepEqual(FJLta.parseLtaXml('<?xml version="1.0"?>\n<ArrayOfLevel xmlns:xsd="x" />', 'Local/CustomLevels.xml'), []);
  assert.deepEqual(FJLta.parseLtaXml(xml(level('ES 12-26', 'abc', '30 SETT')), 'a.xml'), []);
});

test('parser: reálné soubory LTA, jsou-li na tomto počítači', { skip: !fs.existsSync(path.join(os.homedir(), 'Documents', ...FJLta.DEFAULT_SUBDIR, 'System')) }, () => {
  const dir = path.join(os.homedir(), 'Documents', ...FJLta.DEFAULT_SUBDIR, 'System');
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.xml'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const count = (text.match(/<Level\b/g) || []).length;
    const levels = FJLta.parseLtaXml(text, 'System/' + name);
    assert.equal(levels.length, count, name + ': každý <Level> se přečte');
    assert.ok(levels.every(l => l.name && !/^\d+\s/.test(l.name) && Number.isFinite(l.price)), name);
  }
});

// ------------------------------------------------------- kontrakt a verze

test('kontrakt: kořen bez měsíce, instrumentFull z obchodu, jinak nejbližší neexpirovaný', () => {
  const levels = [
    { instrument: 'CL 11-26', name: 'LUDVIK', price: 60 },
    { instrument: 'CL 12-26', name: 'LUDVIK', price: 61 },
    { instrument: 'MCL 12-26', name: 'LUDVIK', price: 99 },
    { instrument: 'EURUSD', name: 'OPEN', price: 1.1 }
  ];
  const prices = list => list.map(l => l.price);
  assert.deepEqual(prices(FJLta.levelsForInstrument(levels, 'CL', 'CL 12-26', '2026-10-20T10:00:00Z')), [61]);
  assert.deepEqual(prices(FJLta.levelsForInstrument(levels, 'CL', '', '2026-10-20T10:00:00Z')), [60]);
  assert.deepEqual(prices(FJLta.levelsForInstrument(levels, 'CL', '', '2026-11-20T10:00:00Z')), [60], 'listopad: 11-26 ještě platí');
  assert.deepEqual(prices(FJLta.levelsForInstrument(levels, 'CL', '', '2026-12-02T10:00:00Z')), [61]);
  assert.deepEqual(prices(FJLta.levelsForInstrument(levels, 'eurusd', '', null)), [1.1]);
  assert.deepEqual(prices(FJLta.levelsForInstrument(levels, 'MCL', '', null)), [99], 'MCL není CL');
});

test('verze: platná v čase vstupu, vstup před první verzí dne bere první', () => {
  const v = [
    { from: '2026-11-02T08:00:00Z', levels: [1] },
    { from: '2026-11-02T14:00:00Z', levels: [2] }
  ];
  assert.deepEqual(FJLta.versionAt(v, Date.parse('2026-11-02T07:00:00Z')).levels, [1]);
  assert.deepEqual(FJLta.versionAt(v, Date.parse('2026-11-02T13:59:00Z')).levels, [1]);
  assert.deepEqual(FJLta.versionAt(v, Date.parse('2026-11-02T15:00:00Z')).levels, [2]);
  assert.equal(FJLta.versionAt([], 0), null);
});

// ------------------------------------------------------------ N nejbližších

test('N nejbližších: N nad (včetně ceny vstupu) a N pod, skrytá se vynechá, stejný typ + cena jednou', () => {
  const levels = [
    { name: 'A', price: 110 }, { name: 'B', price: 105 }, { name: 'C', price: 101 }, { name: 'D', price: 100 },
    { name: 'E', price: 99 }, { name: 'F', price: 95 }, { name: 'G', price: 90 }, { name: 'H', price: 98 },
    { name: 'E', price: 99 }
  ];
  const key = n => 'LTA_' + n;
  const rows = FJLta.nearestRows(levels, 100, 2, key, k => k === 'LTA_H');
  assert.deepEqual(rows, [
    { level: 'LTA_C', price: 101 }, { level: 'LTA_D', price: 100 },
    { level: 'LTA_E', price: 99 }, { level: 'LTA_F', price: 95 }
  ]);
  assert.deepEqual(FJLta.nearestRows(levels, '', 2, key), [], 'bez vstupní ceny nic');
  assert.deepEqual(FJLta.nearestRows(levels, 100, 0, key), [], 'N = 0 nic');
});

test('doplnění: zadané řádky zůstanou i s test / netest, stejná hladina se nepřidá podruhé', () => {
  const manual = [{ level: 'VAH', price: 101, testState: 'TESTED' }, { level: 'LTA_C', price: 101 }];
  assert.deepEqual(FJLta.mergeRows(manual, [{ level: 'LTA_C', price: 101 }, { level: 'LTA_E', price: 99 }]), [
    { level: 'VAH', price: 101, testState: 'TESTED' }, { level: 'LTA_C', price: 101 }, { level: 'LTA_E', price: 99 }
  ]);
});

// ---------------------------------------------------------- číselník

test('číselník LTA Levels: zakládá se sám, opakovaně nic nepřibude, klíč nekoliduje', () => {
  const first = FJTaxonomy.registerLtaNames(['ID vPOC', 'Call Wall', 'ID vPOC', 'LEVEL'], {});
  assert.deepEqual(first.added, ['LTA_ID_VPOC', 'LTA_CALL_WALL', 'LTA_LEVEL_2'], 'LTA_LEVEL je klíč hladiny vstupu („LTA hladina")');
  assert.equal(FJTaxonomy.labelOf('LTA_LEVELS', 'LTA_ID_VPOC', first.config), 'ID vPOC');
  const again = FJTaxonomy.registerLtaNames(['ID vPOC', 'Call Wall'], first.config);
  assert.equal(again.config, first.config, 'beze změny tentýž objekt');
  assert.deepEqual(again.added, []);
});

test('číselník LTA Levels: přejmenování nezaloží novou volbu, smazaná se neobnoví', () => {
  const { config } = FJTaxonomy.registerLtaNames(['ID vPOC'], {});
  config.LTA_LEVELS.labels = { LTA_ID_VPOC: 'vPOC včerejška' };
  config.LTA_LEVELS.custom.LTA_ID_VPOC = 'vPOC včerejška';
  const after = FJTaxonomy.registerLtaNames(['ID vPOC'], config);
  assert.deepEqual(after.added, []);
  assert.equal(after.keys['ID vPOC'], 'LTA_ID_VPOC');
  config.LTA_LEVELS.removed = ['LTA_ID_VPOC'];
  const removed = FJTaxonomy.registerLtaNames(['ID vPOC'], config);
  assert.deepEqual(removed.added, [], 'smazaná volba se nezaloží znovu');
  assert.ok(!FJTaxonomy.allKeys('NEAR_LEVEL', config).includes('LTA_ID_VPOC'));
});

test('Hladiny v blízkosti přijímají LTA volby: řádek se drží, skrytí se dědí, popisek z LTA', () => {
  const { config } = FJTaxonomy.registerLtaNames(['ID vPOC', 'ATR HIGH'], {});
  assert.deepEqual(FJTaxonomy.sanitizeNearLevels('NEAR_LEVEL', [{ level: 'LTA_ID_VPOC', price: 7700 }], config), [{ level: 'LTA_ID_VPOC', price: 7700 }]);
  assert.deepEqual(FJTaxonomy.sanitizeNearLevels('NEAR_LEVEL', [{ level: 'LTA_NEZNAMY', price: 1 }], config), []);
  assert.equal(FJTaxonomy.labelOf('NEAR_LEVEL', 'LTA_ATR_HIGH', config), 'ATR HIGH');
  config.LTA_LEVELS.hidden = ['LTA_ATR_HIGH'];
  assert.equal(FJTaxonomy.isHidden('NEAR_LEVEL', 'LTA_ATR_HIGH', config), true);
  assert.deepEqual(FJTaxonomy.visibleOptions('NEAR_LEVEL', [], config).filter(o => o.key.startsWith('LTA_')).map(o => o.key), ['LTA_LEVEL', 'LTA_ID_VPOC']);
  assert.ok(!FJTaxonomy.allKeys('ENTRY_LEVEL', config).includes('LTA_ID_VPOC'), 'hladina vstupu beze změny');
});

test('export / kopie číselníku drží LTA volby, jejich původní názvy i skrytí u Hladin v blízkosti', () => {
  const { config } = FJTaxonomy.registerLtaNames(['ID vPOC'], {});
  config.NEAR_LEVEL = { hidden: ['LTA_ID_VPOC'] };
  const clean = FJTaxonomy.sanitizeConfig(config);
  assert.deepEqual(clean.LTA_LEVELS.sourceNames, { LTA_ID_VPOC: 'ID vPOC' });
  assert.deepEqual(clean.NEAR_LEVEL.hidden, ['LTA_ID_VPOC']);
});

// ---------------------------------------------- renderer: řádky k obchodu

test('renderer ltaRowsFor: zakládá volby, vybírá N + N, přidá VWAP vstupu', async () => {
  const queries = [];
  const levels = [
    { name: 'ID vPOC', price: 7760 }, { name: 'SETT', price: 7754.25 }, { name: 'ID LOW', price: 7700 },
    { name: 'ATR HIGH', price: 7800 }
  ];
  const r = loadRenderer(['ltaRowsFor'], {
    FJLta,
    normalizeInstrumentCode: i => String(i || '').trim().toUpperCase().split(/\s+/)[0],
    window: { desktopAPI: { ltaLevelsFor: async q => { queries.push(q); return { ok: true, levels, source: 'archive' }; } } }
  });
  const s = FJLta.cleanSettings({ nearestCount: 1 });
  const out = await r.ltaRowsFor({ instrument: 'es', instrumentFull: 'ES 12-26', entryISO: '2026-11-02T15:30:00.000Z', entryPrice: 7750, vwap: 7751.123456789, config: {}, s });
  assert.deepEqual(plain(queries), [{ root: 'ES', instrumentFull: 'ES 12-26', entryISO: '2026-11-02T15:30:00.000Z' }]);
  assert.deepEqual(plain(out.rows), [{ level: 'LTA_VWAP', price: 7751.123457 }, { level: 'LTA_ID_LOW', price: 7700 }]);
  assert.deepEqual(out.added, ['LTA_ID_VPOC', 'LTA_SETT', 'LTA_ID_LOW', 'LTA_ATR_HIGH', 'LTA_VWAP']);
  const off = await r.ltaRowsFor({ instrument: 'ES', entryPrice: 7750, config: {}, s: { ...s, enabled: false } });
  assert.deepEqual(plain(off.rows), []);
});

// --------------------------------------------------------------- archiv

function tempStore(t0 = Date.parse('2026-11-02T09:00:00')) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-lta-'));
  const docs = path.join(base, 'docs');
  const lta = path.join(docs, ...FJLta.DEFAULT_SUBDIR);
  fs.mkdirSync(path.join(lta, 'System'), { recursive: true });
  fs.mkdirSync(path.join(lta, 'Local'), { recursive: true });
  const clock = { t: t0 };
  const store = createLtaStore({ userDataDir: path.join(base, 'user'), documentsDir: docs, now: () => clock.t });
  const write = (rel, text, mtime) => {
    const file = path.join(lta, rel);
    fs.writeFileSync(file, text);
    if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  };
  return { base, lta, store, clock, write, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('archiv: verze se uloží jen při změně levelů, přepis souboru se stejným obsahem nic nezapíše', async () => {
  const h = tempStore();
  try {
    h.write('System/SETT_NT8.xml', xml(level('ES 12-26', '7754.25', '30 SETT')));
    assert.equal((await h.store.snapshot()).written, true);
    h.clock.t += 5 * 60000;
    h.write('System/SETT_NT8.xml', xml(level('ES 12-26', '7754.25', '30 SETT')), h.clock.t);
    assert.equal((await h.store.snapshot()).written, false, 'LTA soubor přepsal, levely stejné');
    h.clock.t += 5 * 60000;
    h.write('System/SETT_NT8.xml', xml(level('ES 12-26', '7760.00', '30 SETT')), h.clock.t + 1000);
    assert.equal((await h.store.snapshot()).written, true);
    const day = JSON.parse(fs.readFileSync(path.join(h.store.root, localDate(h.clock.t) + '.json'), 'utf8'));
    assert.equal(day.versions.length, 2);
    // Obchod z 9:02 dostane první verzi, i když je už v souboru jiná cena.
    const early = await h.store.levelsFor({ root: 'ES', entryISO: new Date(Date.parse('2026-11-02T09:02:00')).toISOString() });
    assert.equal(early.source, 'archive');
    assert.deepEqual(early.levels.map(l => l.price), [7754.25]);
    const late = await h.store.levelsFor({ root: 'ES', entryISO: new Date(h.clock.t).toISOString() });
    assert.deepEqual(late.levels.map(l => l.price), [7760]);
    assert.ok(!fs.readdirSync(path.join(h.lta, 'System')).some(n => n.endsWith('.tmp')), 'do složky LTA se nezapisuje');
  } finally { h.cleanup(); }
});

test('archiv: vypnutý soubor se nečte, den bez archivu nic nevrátí, staré dny se smažou', async () => {
  const h = tempStore();
  try {
    h.write('System/SETT_NT8.xml', xml(level('ES 12-26', '7754.25', '30 SETT')));
    h.write('Local/LUDVIK_NT8.xml', xml(level('ES 12-26', '7583.96', '7 LUDVIK', { lower: 12, upper: 12 })));
    h.store.setSettings({ disabledFiles: ['Local/LUDVIK_NT8.xml'], retentionDays: 90 });
    h.store.stop();
    const today = await h.store.levelsFor({ root: 'ES', entryISO: new Date(h.clock.t).toISOString() });
    assert.deepEqual(today.levels.map(l => l.name), ['SETT']);
    const old = await h.store.levelsFor({ root: 'ES', entryISO: '2026-10-01T15:00:00.000Z' });
    assert.equal(old.source, 'none');
    assert.deepEqual(old.levels, []);
    fs.writeFileSync(path.join(h.store.root, '2026-01-01.json'), '{"versions":[]}');
    assert.equal(h.store.prune(), 1);
    const st = await h.store.status();
    assert.equal(st.folderExists, true);
    assert.deepEqual(st.files.map(f => [f.rel, f.enabled]), [['System/SETT_NT8.xml', true], ['Local/LUDVIK_NT8.xml', false]]);
  } finally { h.cleanup(); }
});

test('archiv vypnutý: dnešní obchod z aktuálních souborů, nic se neukládá', async () => {
  const h = tempStore();
  try {
    h.write('System/SETT_NT8.xml', xml(level('ES 12-26', '7754.25', '30 SETT')));
    h.store.setSettings({ archive: false });
    assert.equal((await h.store.snapshot()).written, false);
    const r = await h.store.levelsFor({ root: 'ES', entryISO: new Date(h.clock.t).toISOString() });
    assert.equal(r.source, 'live');
    assert.deepEqual(r.levels.map(l => l.price), [7754.25]);
    assert.ok(!fs.readdirSync(h.store.root).some(n => /^\d{4}-/.test(n)));
  } finally { h.cleanup(); }
});

// ------------------------------------------- vyloučené levely (4.8.100)

test('vyloučení: nastavení se čistí, přesný název i vzor bez ohledu na velikost písmen', () => {
  const s = FJLta.cleanSettings({ excludedNames: [' OPEN ', 'OPEN', '', 5, 'Combo L2'], excludePatterns: ['close', '  ', '/'] });
  assert.deepEqual(s.excludedNames, ['OPEN', 'Combo L2']);
  assert.deepEqual(s.excludePatterns, ['close', '/']);
  assert.deepEqual(FJLta.cleanSettings({}).excludedNames, []);
  assert.equal(FJLta.isExcluded('OPEN', s), true);
  assert.equal(FJLta.isExcluded('open', s), false, 'seznam názvů je přesný');
  assert.equal(FJLta.isExcluded('Combo L2', s), true);
  assert.equal(FJLta.isExcluded('Combo L1', s), false);
  assert.equal(FJLta.isExcluded('ID CLOSE', s), true, 'vzor „close“');
  assert.equal(FJLta.isExcluded('11/02 - 00:', s), true, 'vzor „/“ na popisek s datem');
  assert.equal(FJLta.excludingPattern('ID CLOSE', s), 'close');
  assert.equal(FJLta.excludingPattern('OPEN', s), null, 'vyloučený názvem, ne vzorem');
  assert.equal(FJLta.isExcluded('SETT', FJLta.cleanSettings({})), false);
});

test('vyloučení: levelsFor vyloučené nevrací, archiv je drží, status ukazuje názvy souboru', async () => {
  const h = tempStore();
  try {
    h.write('System/GammaEsNq.xml', xml(
      level('ES 12-26', '7529', '2 Combo L1'), level('ES 12-26', '7430', '2 Combo L2'), level('ES 12-26', '7612', '2 11/02 - 00:')));
    h.write('System/OPEN_NT8.xml', xml(level('ES 12-26', '7700', '30 OPEN')));
    h.store.setSettings({ excludedNames: ['OPEN', 'Combo L2'], excludePatterns: ['/'] });
    h.store.stop();
    const iso = new Date(h.clock.t).toISOString();
    assert.deepEqual((await h.store.levelsFor({ root: 'ES', entryISO: iso })).levels.map(l => l.name), ['Combo L1']);
    const day = JSON.parse(fs.readFileSync(path.join(h.store.root, localDate(h.clock.t) + '.json'), 'utf8'));
    assert.equal(day.versions[0].levels.length, 4, 'archiv ukládá všechny levely');
    h.store.setSettings({ excludedNames: [], excludePatterns: [] });
    h.store.stop();
    assert.equal((await h.store.levelsFor({ root: 'ES', entryISO: iso })).levels.length, 4, 'zrušení vyloučení platí hned');
    const st = await h.store.status();
    assert.deepEqual(st.files.find(f => f.rel === 'System/GammaEsNq.xml').names, ['11/02 - 00:', 'Combo L1', 'Combo L2']);
  } finally { h.cleanup(); }
});

test('renderer ltaRowsFor: vyloučený VWAP se nepřidá', async () => {
  const r = loadRenderer(['ltaRowsFor'], {
    FJLta,
    normalizeInstrumentCode: i => String(i || '').trim().toUpperCase(),
    window: { desktopAPI: { ltaLevelsFor: async () => ({ ok: true, levels: [{ name: 'SETT', price: 7700 }], source: 'archive' }) } }
  });
  const s = FJLta.cleanSettings({ nearestCount: 2, excludedNames: ['VWAP'] });
  const out = await r.ltaRowsFor({ instrument: 'ES', entryPrice: 7750, vwap: 7751, config: {}, s });
  assert.deepEqual(plain(out.rows), [{ level: 'LTA_SETT', price: 7700 }]);
});

// ----------------------------------------------------- VWAP z konektoru

const ENTRY = { executionId: 'E1', time: '2026-11-02T14:28:20.000Z', orderAction: 'Sell', orderName: 'Entry', quantity: 1, price: 7854.25, positionAfter: -1, marketPosition: 'Short', commission: 1 };
const EXIT = { executionId: 'X1', time: '2026-11-02T14:35:00.000Z', orderAction: 'BuyToCover', orderName: 'Stop1', quantity: 1, price: 7856.75, positionAfter: 0, marketPosition: 'Long', commission: 1 };

test('VWAP vstupu: dorazí po vstupu → jde s trade_closed', async () => {
  const h = captureHarness();
  await h.exec(ENTRY);
  assert.equal(h.vwap('E1', 7850.5), true);
  await h.exec(EXIT);
  assert.equal(h.closed()[0].entryVwap, 7850.5);
});

test('VWAP vstupu: dorazí před exekucí (předběhl ji) → použije se', async () => {
  const h = captureHarness();
  assert.equal(h.vwap('E1', 7850.5), false);
  await h.exec(ENTRY);
  await h.exec(EXIT);
  assert.equal(h.closed()[0].entryVwap, 7850.5);
});

test('VWAP vstupu: dorazí po uzavření → doplní se do neimportovaného trade_closed; bez VWAP pole chybí', async () => {
  const h = captureHarness();
  await h.exec(ENTRY);
  await h.exec(EXIT);
  assert.equal('entryVwap' in h.closed()[0], false, 'bez VWAP se pole nezakládá');
  assert.equal(h.vwap('E1', 7850.5), true);
  assert.equal(h.closed()[0].entryVwap, 7850.5);
  assert.equal(h.vwap('E1', 1), false, 'už doplněné se nepřepisuje');
  assert.equal(h.vwap('', 7850), false);
  assert.equal(h.vwap('E9', 'x'), false);
});
