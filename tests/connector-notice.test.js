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
  ['ninjaConnectorVersion', 'ninjaConnectorTargetPath', 'findNinjaConnectorDuplicates', 'installNinjaConnectorFile'],
  { path }
);

// Falešný fs: stromeček {cesta: obsah} (složky = cesty, které jsou prefixem
// jiných). Každý zápis a mkdir se zaznamená.
function fakeFs(files, dirs) {
  const norm = p => path.resolve(p).toLowerCase();
  const fileMap = new Map(Object.entries(files).map(([p, c]) => [norm(p), { p: path.resolve(p), c }]));
  const dirSet = new Set(dirs.map(norm));
  for (const { p } of fileMap.values()) {
    for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) dirSet.add(norm(d));
  }
  const calls = { write: [], mkdir: [] };
  return {
    calls,
    existsSync: p => dirSet.has(norm(p)) || fileMap.has(norm(p)),
    mkdirSync: (p, opts) => { calls.mkdir.push({ p, opts }); dirSet.add(norm(p)); },
    writeFileSync: (p, c) => { calls.write.push({ p, c }); fileMap.set(norm(p), { p: path.resolve(p), c }); },
    readFileSync: p => { const f = fileMap.get(norm(p)); if (!f) throw new Error('ENOENT'); return f.c; },
    readdirSync: dir => {
      const d = norm(dir);
      const names = new Map();
      for (const x of dirSet) if (path.dirname(x) === d && x !== d) names.set(path.basename(x), true);
      for (const [k, v] of fileMap) if (path.dirname(k) === d) names.set(path.basename(v.p), false);
      return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    }
  };
}

const DOCS = path.resolve('C:/Users/test/Documents');
const CUSTOM = path.join(DOCS, 'NinjaTrader 8', 'bin', 'Custom');
const TARGET = path.join(CUSTOM, 'AddOns', 'FuturesJournalCapture.cs');

test('verze konektoru: bez značky 1, se značkou číslo', () => {
  const m = main();
  assert.equal(m.ninjaConnectorVersion('// starý konektor\nclass X{}'), 1);
  assert.equal(m.ninjaConnectorVersion('// FJ_CONNECTOR_VERSION: 7\n'), 7);
});

test('šablona konektoru v repu nese značku verze >= 2', () => {
  const source = readRepoFile(path.join('CONNECTORS', 'NinjaTrader8', 'FuturesJournalCapture.cs'));
  assert.ok(main().ninjaConnectorVersion(source) >= 2, 'bez značky by upozornění nikdy nevyskočilo');
});

test('instalace: přesně jeden zápis na správné místo, nic se nezakládá', () => {
  const fsApi = fakeFs({ [TARGET]: '// starý' }, [CUSTOM]);
  const r = main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'NOVÝ key=abc', fsApi });
  assert.equal(r.ok, true);
  assert.equal(fsApi.calls.write.length, 1, 'jediný zápis');
  assert.equal(path.resolve(fsApi.calls.write[0].p), path.resolve(TARGET));
  assert.equal(fsApi.calls.write[0].c, 'NOVÝ key=abc');
  assert.equal(fsApi.calls.mkdir.length, 0, 'AddOns existuje, nic se nezakládá');
});

test('instalace: bez složky NinjaTrader 8 se nezapíše nic a nic se nezaloží', () => {
  const fsApi = fakeFs({}, [DOCS]);
  const r = main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'X', fsApi });
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
  assert.match(r.error, /Tools → Import/);
  assert.equal(fsApi.calls.write.length, 0);
  assert.equal(fsApi.calls.mkdir.length, 0);
});

test('instalace: chybějící AddOns uvnitř existujícího Custom se založí bez recursive', () => {
  const fsApi = fakeFs({}, [CUSTOM]);
  const r = main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'X', fsApi });
  assert.equal(r.ok, true);
  assert.equal(fsApi.calls.mkdir.length, 1);
  assert.equal(path.resolve(fsApi.calls.mkdir[0].p), path.dirname(TARGET));
  assert.equal(fsApi.calls.mkdir[0].opts, undefined, 'žádné recursive – rodič musí existovat');
  assert.equal(fsApi.calls.write.length, 1);
});

test('instalace: duplicitní třída jinde v Custom → nezapíše nic a řekne kde', () => {
  const dup = path.join(CUSTOM, 'AddOns', 'FuturesJournalCapture_old.cs');
  const fsApi = fakeFs({
    [TARGET]: 'public class FuturesJournalCapture : AddOnBase {}',
    [dup]: 'public class FuturesJournalCapture : AddOnBase {}',
    [path.join(CUSTOM, 'Indicators', 'Foo.cs')]: 'public class Foo {}'
  }, [CUSTOM]);
  const r = main().installNinjaConnectorFile({ documentsDir: DOCS, source: 'X', fsApi });
  assert.equal(r.ok, false);
  assert.deepEqual(Array.from(r.duplicates).map(p => path.resolve(p).toLowerCase()), [path.resolve(dup).toLowerCase()], 'Windows: cesty bez ohledu na velikost písmen');
  assert.equal(fsApi.calls.write.length, 0);
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

test('showConfirm: vlastní popisky tlačítek, po zavření zpět na výchozí', async () => {
  const nodes = new Map();
  const head = { textContent: 'Potvrzení' };
  const node = id => ({
    id, textContent: '', classList: { add() {}, remove() {} }, focus() {},
    querySelector: sel => (sel === '.modalhead h2' ? head : null)
  });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); } };
  const r = loadRenderer(['$', 'CONFIRM_DEFAULTS', 'setConfirmLabels', 'showConfirm', 'resolveConfirm', 'confirmResolver'],
    { document, setTimeout: () => {} });
  const pending = r.showConfirm('text', { title: 'NinjaTrader 8 konektor', ok: 'Přeinstalovat teď', cancel: 'Později' });
  assert.equal(head.textContent, 'NinjaTrader 8 konektor');
  assert.equal(nodes.get('confirmModalOk').textContent, 'Přeinstalovat teď');
  assert.equal(nodes.get('confirmModalCancel').textContent, 'Později');
  r.resolveConfirm(true);
  assert.equal(await pending, true);
  assert.equal(nodes.get('confirmModalOk').textContent, 'Pokračovat');
  assert.equal(nodes.get('confirmModalCancel').textContent, 'Zrušit');
  assert.equal(head.textContent, 'Potvrzení');
});
