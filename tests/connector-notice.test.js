'use strict';
// Jednorázové upozornění na přeinstalaci NT8 konektoru a bezpečná instalace.
//
// Instalace smí jen přepsat JEDEN soubor na JEDNOM místě (Custom\AddOns\
// FuturesJournalCapture.cs) – automatická instalace dřív dělala problémy.
// Testy proto hlídají počet a cíl zápisů přes falešný fs.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadMain, loadRenderer, readRepoFile } = require('./helpers/extract');

const main = () => loadMain(
  ['ninjaConnectorVersion', 'ninjaConnectorTargetPath', 'NINJA_MANUAL_INSTALL_HINT', 'sameNinjaPath',
    'findNinjaConnectorCopies', 'installNinjaConnectorFile', 'ninjaConnectorStatus'],
  { path }
);

// Falešný fs: stromeček {cesta: obsah} (složky = cesty, které jsou prefixem
// jiných). Každý zápis, mkdir i čtení se zaznamená.
function fakeFs(files, dirs) {
  const norm = p => path.resolve(p).toLowerCase();
  const fileMap = new Map(Object.entries(files).map(([p, c]) => [norm(p), { p: path.resolve(p), c }]));
  const dirSet = new Set(dirs.map(norm));
  for (const { p } of fileMap.values()) {
    for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) dirSet.add(norm(d));
  }
  const calls = { write: [], mkdir: [], read: [] };
  const readFile = p => { calls.read.push(p); const f = fileMap.get(norm(p)); if (!f) throw new Error('ENOENT'); return f.c; };
  const readdir = dir => {
    const d = norm(dir);
    const names = new Map();
    for (const x of dirSet) if (path.dirname(x) === d && x !== d) names.set(path.basename(x), true);
    for (const [k, v] of fileMap) if (path.dirname(k) === d) names.set(path.basename(v.p), false);
    return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
  };
  return {
    calls,
    existsSync: p => dirSet.has(norm(p)) || fileMap.has(norm(p)),
    mkdirSync: (p, opts) => { calls.mkdir.push({ p, opts }); dirSet.add(norm(p)); },
    writeFileSync: (p, c) => { calls.write.push({ p, c }); fileMap.set(norm(p), { p: path.resolve(p), c }); },
    readFileSync: readFile,
    readdirSync: readdir,
    // Prohledávání Custom běží asynchronně (hlavní proces se nesmí zastavit),
    // synchronní readdirSync/readFileSync by v něm neměly být potřeba.
    promises: {
      readdir: async dir => readdir(dir),
      readFile: async p => readFile(p)
    }
  };
}

const DOCS = path.resolve('C:/Users/test/Documents');
const CUSTOM = path.join(DOCS, 'NinjaTrader 8', 'bin', 'Custom');
const TARGET = path.join(CUSTOM, 'AddOns', 'FuturesJournalCapture.cs');
const CLASS_V1 = 'public class FuturesJournalCapture : AddOnBase {}';
const CLASS_V3 = '// FJ_CONNECTOR_VERSION: 3\npublic class FuturesJournalCapture : AddOnBase {}';

test('verze konektoru: bez značky 1, se značkou číslo', () => {
  const m = main();
  assert.equal(m.ninjaConnectorVersion('// starý konektor\nclass X{}'), 1);
  assert.equal(m.ninjaConnectorVersion('// FJ_CONNECTOR_VERSION: 7\n'), 7);
});

test('šablona konektoru v repu nese značku verze >= 3', () => {
  const source = readRepoFile(path.join('CONNECTORS', 'NinjaTrader8', 'FuturesJournalCapture.cs'));
  assert.ok(main().ninjaConnectorVersion(source) >= 3, 'bez zvýšení by oprava NaN nedošla k nikomu, kdo má verzi 2');
});

// NaN / Infinity by konektor zapsal do JSONu jako holé NaN – aplikace by celou
// výstupní exekuci odmítla a obchod by se do deníku nedostal.
test('šablona konektoru: extrémy ceny se posílají jen jako konečná čísla', () => {
  const source = readRepoFile(path.join('CONNECTORS', 'NinjaTrader8', 'FuturesJournalCapture.cs'));
  assert.match(source, /double\.IsNaN\(price\)/);
  assert.match(source, /double\.IsInfinity\(price\)/);
  assert.match(source, /!IsUsablePrice\(e\.MaxPrice\) \|\| !IsUsablePrice\(e\.MinPrice\)/);
  assert.match(source, /if \(!any \|\| !IsUsablePrice\(max\) \|\| !IsUsablePrice\(min\)\) return "";/);
});

test('instalace: přesně jeden zápis na správné místo, nic se nezakládá', async () => {
  const fsApi = fakeFs({ [TARGET]: '// starý' }, [CUSTOM]);
  const r = await main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'NOVÝ key=abc', fsApi });
  assert.equal(r.ok, true);
  assert.equal(fsApi.calls.write.length, 1, 'jediný zápis');
  assert.equal(path.resolve(fsApi.calls.write[0].p), path.resolve(TARGET));
  assert.equal(fsApi.calls.write[0].c, 'NOVÝ key=abc');
  assert.equal(fsApi.calls.mkdir.length, 0, 'AddOns existuje, nic se nezakládá');
});

test('instalace: bez složky NinjaTrader 8 se nezapíše nic a nic se nezaloží', async () => {
  const fsApi = fakeFs({}, [DOCS]);
  const r = await main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'X', fsApi });
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
  assert.equal(fsApi.calls.write.length, 0);
  assert.equal(fsApi.calls.mkdir.length, 0);
});

// Tools → Import → NinjaScript Add-On bere jen .zip archiv exportovaný z NT,
// holý .cs z „Uložit konektor" jím nahrát nejde.
test('instalace bez složky NT: ruční postup je zkopírovat .cs do AddOns, ne Import', async () => {
  const r = await main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'X', fsApi: fakeFs({}, [DOCS]) });
  assert.match(r.error, /Custom\\AddOns/);
  assert.match(r.error, /F5/);
  assert.doesNotMatch(r.error, /Tools → Import/);
  assert.doesNotMatch(readRepoFile(path.join('app', 'index.html')), /importuj přes Tools → Import/, 'ani toast po „Uložit konektor"');
});

test('instalace: chybějící AddOns uvnitř existujícího Custom se založí bez recursive', async () => {
  const fsApi = fakeFs({}, [CUSTOM]);
  const r = await main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'X', fsApi });
  assert.equal(r.ok, true);
  assert.equal(fsApi.calls.mkdir.length, 1);
  assert.equal(path.resolve(fsApi.calls.mkdir[0].p), path.dirname(TARGET));
  assert.equal(fsApi.calls.mkdir[0].opts, undefined, 'žádné recursive – rodič musí existovat');
  assert.equal(fsApi.calls.write.length, 1);
});

test('instalace: duplicitní třída jinde v Custom → nezapíše nic a řekne kde', async () => {
  const dup = path.join(CUSTOM, 'AddOns', 'FuturesJournalCapture_old.cs');
  const fsApi = fakeFs({
    [TARGET]: CLASS_V1,
    [dup]: CLASS_V1,
    [path.join(CUSTOM, 'Indicators', 'Foo.cs')]: 'public class Foo {}'
  }, [CUSTOM]);
  const r = await main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'X', fsApi });
  assert.equal(r.ok, false);
  assert.deepEqual(Array.from(r.duplicates).map(p => path.resolve(p).toLowerCase()), [path.resolve(dup).toLowerCase()], 'Windows: cesty bez ohledu na velikost písmen');
  assert.equal(fsApi.calls.write.length, 0);
});

// Custom mívá stovky vestavěných skriptů NT (@SMA.cs…). Konektor mezi nimi být
// nemůže a jejich čtení by jen zdržovalo.
test('prohledávání Custom: vestavěné skripty NinjaTraderu (@…) se nečtou', async () => {
  const builtin = path.join(CUSTOM, 'Indicators', '@SMA.cs');
  const fsApi = fakeFs({ [TARGET]: CLASS_V1, [builtin]: 'public class SMA {}' }, [CUSTOM]);
  const copies = await main().findNinjaConnectorCopies(CUSTOM, fsApi);
  assert.equal(copies.length, 1);
  assert.ok(!fsApi.calls.read.some(p => /@SMA\.cs$/.test(p)), '@SMA.cs se nečetl');
});

test('stav: nic nenainstalováno / nainstalovaná aktuální verze', async () => {
  const m = main();
  assert.deepEqual({ ...(await m.ninjaConnectorStatus({ documentsDir: DOCS, currentVersion: 3, fsApi: fakeFs({}, [DOCS]) })) },
    { installed: false, currentVersion: 3 }, 'bez NinjaTraderu');
  assert.equal((await m.ninjaConnectorStatus({ documentsDir: DOCS, currentVersion: 3, fsApi: fakeFs({}, [CUSTOM]) })).installed, false, 'NT bez konektoru');
  const current = await m.ninjaConnectorStatus({ documentsDir: DOCS, currentVersion: 3, fsApi: fakeFs({ [TARGET]: CLASS_V3 }, [CUSTOM]) });
  assert.equal(current.installed, true);
  assert.equal(current.outdated, false);
});

// Stará kopie pod jiným jménem je taky starý konektor. Kdyby se hledal jen
// soubor na správném místě, upozornění by se takovému uživateli nikdy neukázalo.
test('stav: stará kopie pod jiným jménem se počítá jako zastaralá instalace', async () => {
  const m = main();
  const renamed = path.join(CUSTOM, 'AddOns', 'FuturesJournalCapture (1).cs');
  const only = await m.ninjaConnectorStatus({ documentsDir: DOCS, currentVersion: 3, fsApi: fakeFs({ [renamed]: CLASS_V1 }, [CUSTOM]) });
  assert.equal(only.installed, true);
  assert.equal(only.installedVersion, 1);
  assert.equal(only.outdated, true);
  const beside = await m.ninjaConnectorStatus({ documentsDir: DOCS, currentVersion: 3, fsApi: fakeFs({ [TARGET]: CLASS_V3, [renamed]: CLASS_V1 }, [CUSTOM]) });
  assert.equal(beside.outdated, true, 'rozhoduje nejstarší nalezená kopie');
});

test('upozornění: jen u nainstalovaného starého konektoru a jen jednou', () => {
  const { shouldShowConnectorNotice } = loadRenderer(['shouldShowConnectorNotice'], {});
  assert.equal(shouldShowConnectorNotice({ installed: false, currentVersion: 2 }, null), false, 'nový uživatel');
  assert.equal(shouldShowConnectorNotice({ installed: true, outdated: false, currentVersion: 2 }, null), false, 'už aktuální');
  assert.equal(shouldShowConnectorNotice({ installed: true, outdated: true, currentVersion: 2 }, null), true, 'starý konektor');
  assert.equal(shouldShowConnectorNotice({ installed: true, outdated: true, currentVersion: 2 }, '2'), false, 'už jednou ukázáno');
  assert.equal(shouldShowConnectorNotice({ installed: true, outdated: true, currentVersion: 3 }, '2'), true, 'další verze konektoru');
  assert.equal(shouldShowConnectorNotice(undefined, null), false, 'status selhal');
});

function confirmDom() {
  const nodes = new Map();
  const head = { textContent: 'Potvrzení' };
  const node = id => ({
    id, textContent: '', classList: { add() {}, remove() {} }, focus() {},
    querySelector: sel => (sel === '.modalhead h2' ? head : null)
  });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); } };
  const r = loadRenderer(['$', 'CONFIRM_DEFAULTS', 'setConfirmLabels', 'confirmResolver', 'confirmPending',
    'showConfirm', 'openNextConfirm', 'resolveConfirm'], { document, setTimeout: () => {} });
  return { r, head, get: id => nodes.get(id) };
}

test('showConfirm: vlastní popisky tlačítek, po zavření zpět na výchozí', async () => {
  const { r, head, get } = confirmDom();
  const pending = r.showConfirm('text', { title: 'NinjaTrader 8 konektor', ok: 'Přeinstalovat teď', cancel: 'Později' });
  assert.equal(head.textContent, 'NinjaTrader 8 konektor');
  assert.equal(get('confirmModalOk').textContent, 'Přeinstalovat teď');
  assert.equal(get('confirmModalCancel').textContent, 'Později');
  r.resolveConfirm(true);
  assert.equal(await pending, true);
  assert.equal(get('confirmModalOk').textContent, 'Pokračovat');
  assert.equal(get('confirmModalCancel').textContent, 'Zrušit');
  assert.equal(head.textContent, 'Potvrzení');
});

// Upozornění na konektor přichází samo, 800 ms po přihlášení. Kdyby přepsalo
// rozdělané potvrzení (třeba smazání obchodu), první `await showConfirm` by
// nikdy nedoběhl a odpověď by patřila jiné otázce.
test('showConfirm: druhé potvrzení počká ve frontě, první se nepřepíše', async () => {
  const { r, get } = confirmDom();
  const first = r.showConfirm('Opravdu smazat tento obchod?');
  const second = r.showConfirm('Přeinstalovat konektor?', { ok: 'Přeinstalovat teď', cancel: 'Později' });
  assert.equal(get('confirmModalMessage').textContent, 'Opravdu smazat tento obchod?', 'otevřené zůstává první');
  assert.equal(get('confirmModalOk').textContent, 'Pokračovat');
  r.resolveConfirm(true);
  assert.equal(await first, true, 'odpověď patří první otázce');
  assert.equal(get('confirmModalMessage').textContent, 'Přeinstalovat konektor?', 'po zavření se otevře druhé');
  assert.equal(get('confirmModalOk').textContent, 'Přeinstalovat teď');
  r.resolveConfirm(false);
  assert.equal(await second, false);
  assert.equal(get('confirmModalOk').textContent, 'Pokračovat');
});
