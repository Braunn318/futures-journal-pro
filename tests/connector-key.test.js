'use strict';
// Nesedící API klíč konektoru a upozornění po aktualizaci NinjaTraderu (4.8.92).
//
// 2026-10-16 smazala aktualizace data ve složce programu, aplikace si založila
// nové nastavení konektoru s NOVÝM klíčem a NT8 pak tři dny posílal starý –
// každá zpráva skončila 401, nic se nezalogovalo ani neukázalo a obchody se
// neimportovaly. Testy hlídají, že se nesoulad pozná předem (soubor konektoru),
// i za běhu (odmítnuté zprávy), a že se klíč nepřepíše při chybě čtení.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const realFs = require('node:fs');

const { loadMain, loadRenderer } = require('./helpers/extract');

const DOCS = path.resolve('C:/Users/test/Documents');
const CUSTOM = path.join(DOCS, 'NinjaTrader 8', 'bin', 'Custom');
const TARGET = path.join(CUSTOM, 'AddOns', 'FuturesJournalCapture.cs');
const cls = key => `// FJ_CONNECTOR_VERSION: 3\npublic class FuturesJournalCapture : AddOnBase {\n  private const string API_KEY = "${key}";\n}`;

function fakeFs(files) {
  const norm = p => path.resolve(p).toLowerCase();
  const fileMap = new Map(Object.entries(files).map(([p, c]) => [norm(p), { p: path.resolve(p), c }]));
  const dirSet = new Set([norm(CUSTOM)]);
  for (const { p } of fileMap.values()) for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) dirSet.add(norm(d));
  const readdir = dir => {
    const d = norm(dir);
    const names = new Map();
    for (const x of dirSet) if (path.dirname(x) === d && x !== d) names.set(path.basename(x), true);
    for (const [k, v] of fileMap) if (path.dirname(k) === d) names.set(path.basename(v.p), false);
    return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
  };
  const readFile = p => { const f = fileMap.get(norm(p)); if (!f) throw new Error('ENOENT'); return f.c; };
  return {
    existsSync: p => dirSet.has(norm(p)) || fileMap.has(norm(p)),
    promises: { readdir: async d => readdir(d), readFile: async p => readFile(p) }
  };
}

const status = () => loadMain(['ninjaConnectorVersion', 'ninjaConnectorTargetPath', 'findNinjaConnectorCopies',
  'ninjaConnectorApiKey', 'ninjaConnectorStatus'], { path });

test('klíč z konektoru: konstanta API_KEY, jinak null', () => {
  const m = status();
  assert.equal(m.ninjaConnectorApiKey(cls('abc123')), 'abc123');
  assert.equal(m.ninjaConnectorApiKey('class FuturesJournalCapture {}'), null);
});

test('stav: klíč sedí / nesedí / nejde posoudit', async () => {
  const m = status();
  const run = (files, apiKey) => m.ninjaConnectorStatus({ documentsDir: DOCS, currentVersion: 3, fsApi: fakeFs(files), apiKey });
  assert.equal((await run({ [TARGET]: cls('KEY') }, 'KEY')).keyMismatch, false, 'sedí');
  assert.equal((await run({ [TARGET]: cls('OLD') }, 'KEY')).keyMismatch, true, 'nesedí – obchody by se neimportovaly');
  assert.equal((await run({ [TARGET]: cls('SEM_VLOZ_API_KLIC_Z_APLIKACE') }, 'KEY')).keyMismatch, true, 'nevyplněná šablona');
  assert.equal((await run({ [TARGET]: 'public class FuturesJournalCapture {}' }, 'KEY')).keyMismatch, false, 'bez konstanty se neposuzuje');
  assert.equal((await run({ [TARGET]: cls('OLD') }, undefined)).keyMismatch, false, 'bez klíče aplikace se neposuzuje');
  const renamed = path.join(CUSTOM, 'AddOns', 'FuturesJournalCapture (1).cs');
  assert.equal((await run({ [TARGET]: cls('KEY'), [renamed]: cls('OLD') }, 'KEY')).keyMismatch, true, 'kterákoli kopie se starým klíčem');
});

test('odmítnuté zprávy: počítají se, protokol jednou po každém přijetí, aktivní dokud nepřijde platná', () => {
  const m = loadMain(['noteCaptureRequest', 'captureRejectedActive'], {});
  const s = { count: 0, lastAt: null, source: '', lastAcceptedAt: null, loggedSinceAccept: false };
  assert.equal(m.captureRejectedActive(s), false);
  assert.equal(m.noteCaptureRequest(s, false, '', '2026-10-19T10:00:00.000Z'), true, 'první odmítnutí do protokolu');
  assert.equal(m.noteCaptureRequest(s, false, '', '2026-10-19T10:00:01.000Z'), false, 'další ne');
  assert.equal(s.count, 2);
  assert.equal(m.captureRejectedActive(s), true);
  m.noteCaptureRequest(s, true, '', '2026-10-19T10:05:00.000Z');
  assert.equal(m.captureRejectedActive(s), false, 'po přeinstalaci chodí platné zprávy');
  assert.equal(m.noteCaptureRequest(s, false, '', '2026-10-19T11:00:00.000Z'), true, 'nové odmítnutí po přijetí se zase zaloguje');
  assert.equal(m.captureRejectedActive(s), true);
});

// readCaptureSettings nad skutečnou dočasnou složkou.
function settingsHarness() {
  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'fj-capture-'));
  const logs = [];
  const m = loadMain(['defaultCaptureSettings', 'readCaptureSettings', 'writeCaptureSettings'], {
    path, fs: realFs, crypto: require('node:crypto'),
    ensureCaptureRoot: () => realFs.mkdirSync(dir, { recursive: true }),
    captureSettingsPath: () => path.join(dir, 'settings.json'),
    logError: (ctx, e) => logs.push(`${ctx}: ${e?.message || e}`)
  });
  return { m, dir, logs, file: path.join(dir, 'settings.json') };
}

test('nastavení konektoru: chybějící soubor se založí, existující klíč zůstává', () => {
  const { m, file } = settingsHarness();
  const first = m.readCaptureSettings();
  assert.ok(realFs.existsSync(file));
  assert.equal(m.readCaptureSettings().apiKey, first.apiKey, 'druhé čtení stejný klíč');
  assert.equal(first.ntUpdateNotice, true, 'upozornění po aktualizaci NT8 výchozí zapnuté');
});

test('nastavení konektoru: poškozený soubor se odloží a zaloguje, ne tiše přepíše', () => {
  const { m, dir, logs, file } = settingsHarness();
  realFs.writeFileSync(file, '{"apiKey":"OLD", ', 'utf8');
  const s = m.readCaptureSettings();
  assert.notEqual(s.apiKey, 'OLD');
  const aside = realFs.readdirSync(dir).filter(n => n.startsWith('settings.json.poskozeny-'));
  assert.equal(aside.length, 1, 'poškozený soubor odložený vedle');
  assert.equal(realFs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"apiKey":"OLD", ');
  assert.ok(logs.some(l => /poškozené/.test(l)), 'zapsáno do protokolu');
});

test('nastavení konektoru: chyba čtení (zámek) soubor nepřepíše a zápis odmítne', () => {
  const { m, dir, logs, file } = settingsHarness();
  // Složka místo souboru = čtení selže jinak než ENOENT (EISDIR), jako zamčený soubor.
  realFs.mkdirSync(file);
  const s = m.readCaptureSettings();
  assert.equal(s._readFailed, true);
  assert.ok(realFs.statSync(file).isDirectory(), 'nic se nepřepsalo');
  assert.throws(() => m.writeCaptureSettings({ ...s, autoImport: false }), /nejde přečíst/);
  assert.ok(logs.some(l => /nejde přečíst/.test(l)));
  realFs.rmSync(dir, { recursive: true, force: true });
});

const REG_OUTPUT = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{c8bc5b41}_is1',
  '    DisplayName    REG_SZ    Czechwealth Market Profit Pack (1.0.241105) pro NinjaTrader 8 verze 1.0.241105',
  '    DisplayVersion    REG_SZ    1.0.241105',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{A0C468F8-FAA7-483A-8809-6469CAC9B5DA}',
  '    Comments    REG_SZ    ',
  '    DisplayVersion    REG_SZ    8.1.8.4',
  '    InstallDate    REG_SZ    20261019',
  '    DisplayName    REG_SZ    NinjaTrader',
  '',
  'Suchvorgang abgeschlossen: 1 Übereinstimmende Zeichenfolge(n) gefunden.'
].join('\r\n');

test('verze NinjaTraderu z registru: jen záznam přesně „NinjaTrader“', () => {
  const { ninjaTraderVersionFromReg } = loadMain(['ninjaTraderVersionFromReg'], {});
  assert.equal(ninjaTraderVersionFromReg(REG_OUTPUT), '8.1.8.4');
  assert.equal(ninjaTraderVersionFromReg(REG_OUTPUT.replace('    DisplayName    REG_SZ    NinjaTrader\r\n', '')), '', 'jen doplněk pro NT8');
  assert.equal(ninjaTraderVersionFromReg(''), '');
});

const renderer = () => loadRenderer(['shouldShowConnectorNotice', 'ntUpdateNoticeAction', 'connectorNoticeKind'], {});

test('aktualizace NT8: první zjištění jen zapsat, nová verze upozornit, vypnuté / bez konektoru jen zapsat', () => {
  const { ntUpdateNoticeAction: a } = renderer();
  const base = { ntVersion: '8.1.8.4', ntSeenVersion: '8.1.8.3', ntUpdateNotice: true, ntConnectorSeen: true };
  assert.equal(a({ ...base }), 'notice');
  assert.equal(a({ ...base, ntSeenVersion: '' }), 'record', 'první spuštění');
  assert.equal(a({ ...base, ntSeenVersion: '8.1.8.4' }), 'none', 'stejná verze');
  assert.equal(a({ ...base, ntUpdateNotice: false }), 'record', 'upozornění vypnuté');
  assert.equal(a({ ...base, ntConnectorSeen: false }), 'record', 'konektor nikdy nainstalovaný');
  assert.equal(a({ ...base, ntVersion: '' }), 'none', 'verze nezjištěna');
  assert.equal(a(undefined), 'none');
});

test('pořadí upozornění: nesedící klíč → aktualizace NT8 → starší konektor', () => {
  const { connectorNoticeKind: k } = renderer();
  const ok = { installed: true, outdated: false, currentVersion: 3, keyMismatch: false, ntVersion: '8.1.8.4', ntSeenVersion: '8.1.8.4', ntUpdateNotice: true, ntConnectorSeen: true };
  assert.equal(k(ok, '3'), null, 'vše v pořádku');
  assert.equal(k({ ...ok, keyMismatch: true, ntSeenVersion: '8.1.8.3', outdated: true }, null), 'key');
  assert.equal(k({ ...ok, keyMismatch: true }, null, { keyNoticeShown: true }), null, 'klíč jednou za běh');
  assert.equal(k({ ...ok, rejectedActive: true, installed: false }, null), 'key', 'odmítání i bez souboru v Dokumentech');
  assert.equal(k({ ...ok, ntSeenVersion: '8.1.8.3' }, '3'), 'nt');
  assert.equal(k({ ...ok, ntSeenVersion: '8.1.8.3' }, '3', { ntNoticeDismissed: true }), null, '„Později“ do dalšího spuštění');
  assert.equal(k({ ...ok, outdated: true }, null), 'outdated');
  assert.equal(k(undefined, null), null);
});
