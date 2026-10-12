'use strict';
// Automatické aktualizace z GitHubu.
//
// Aplikace běží na pozadí a zaznamenává exekuce, takže aktualizace se smí jen
// NABÍDNOUT – nic se nestahuje ani neinstaluje bez potvrzení. Testy hlídají
// tohle chování, tichou automatickou kontrolu a konfiguraci sestavení, bez
// které by se aktualizace přestaly nabízet úplně potichu.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadMain, loadRenderer, readRepoFile } = require('./helpers/extract');

const pkg = () => JSON.parse(readRepoFile('package.json'));

// ------------------------------------------------------------ hlavní proces

// Chyba přesně ve tvaru, v jakém ji electron-updater hlásí u vydání bez
// instalátoru (opsáno z chybového protokolu nainstalované 4.8.3).
function noInstallerError(tag) {
  const error = new Error(`Cannot find latest.yml in the latest release artifacts (https://github.com/Braunn318/futures-journal-pro/releases/download/${tag}/latest.yml): HttpError: 404 \n"method: GET url: …"`);
  error.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
  return error;
}

function fakeUpdater({ checkFails = false, checkError = null, downloadFails = false } = {}) {
  const handlers = {};
  const calls = { check: 0, download: 0, quitAndInstall: [] };
  return {
    handlers,
    calls,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(name, fn) { handlers[name] = fn; return this; },
    async checkForUpdates() { calls.check++; if (checkError) throw checkError; if (checkFails) throw new Error('net::ERR_INTERNET_DISCONNECTED'); },
    async downloadUpdate() { calls.download++; if (downloadFails) throw new Error('sha512 checksum mismatch'); },
    quitAndInstall(...args) { calls.quitAndInstall.push(args); }
  };
}

// Stavový automat z main.js s falešným electron-updaterem místo skutečného.
function updateMachine(updater, initialState) {
  const sent = [];
  const info = [];
  const m = loadMain(
    ['isQuitting', 'UPDATE_REPO', 'UPDATE_CHECK_FAILED', 'UPDATE_NO_INSTALLER_CODE', 'updateNoInstallerLogged', 'UPDATE_DOWNLOAD_FAILED',
      'autoUpdater', 'updateState', 'setUpdateState', 'compareVersions', 'releaseVersionFromUpdateError',
      'updateWithoutInstallerMessage', 'checkForUpdates', 'downloadUpdate', 'installUpdate'],
    {
      logInfo: (context, message) => info.push(message),
      app: { getVersion: () => '4.8.3' },
      mainWindow: { isDestroyed: () => false, webContents: { send: (channel, state) => sent.push({ channel, state }) } },
      refreshTrayMenu: () => {},
      setImmediate: fn => fn(),
      __updater: updater,
      __initial: initialState
    }
  );
  const run = code => vm.runInContext(code, m.__context);
  if (updater) run('autoUpdater = __updater');
  if (initialState) run('updateState = { ...updateState, ...__initial }');
  return { m, sent, info, state: () => run('updateState'), isQuitting: () => run('isQuitting') };
}

function loadInit({ isPackaged, platform = 'win32', requireImpl }) {
  const timers = { timeout: [], interval: [] };
  const logged = [];
  const states = [];
  const m = loadMain(['UPDATE_FIRST_CHECK_MS', 'UPDATE_CHECK_INTERVAL_MS', 'UPDATE_NO_INSTALLER_CODE', 'releaseVersionFromUpdateError', 'autoUpdater', 'initAutoUpdate'], {
    app: { isPackaged },
    process: { platform },
    require: requireImpl,
    logError: (context, error) => logged.push({ context, error }),
    // Kopie: objekt z izolovaného kontextu má jiný prototyp a deepEqual by neprošel.
    setUpdateState: patch => states.push({ ...patch }),
    onUpdateAvailable: () => {},
    checkForUpdates: () => {},
    setTimeout: (fn, ms) => timers.timeout.push(ms),
    setInterval: (fn, ms) => timers.interval.push(ms)
  });
  return { m, timers, logged, states };
}

test('spuštění ze zdrojových souborů: electron-updater se vůbec nenačte', () => {
  let required = 0;
  const { m, timers } = loadInit({ isPackaged: false, requireImpl: () => { required++; return {}; } });
  assert.equal(m.initAutoUpdate(), false);
  assert.equal(required, 0, 'npm start ani testy na modulu nesmí záviset');
  assert.equal(timers.timeout.length + timers.interval.length, 0, 'žádná naplánovaná kontrola');
});

test('nainstalovaná aplikace: nic se nestahuje ani neinstaluje samo', () => {
  const updater = fakeUpdater();
  const { m, timers, states } = loadInit({ isPackaged: true, requireImpl: name => { assert.equal(name, 'electron-updater'); return { autoUpdater: updater }; } });
  assert.equal(m.initAutoUpdate(), true);
  assert.equal(updater.autoDownload, false, 'stažení až po potvrzení');
  assert.equal(updater.autoInstallOnAppQuit, false, 'instalace až po potvrzení');
  assert.equal(typeof updater.handlers.error, 'function', 'bez posluchače by chyba aktualizace shodila aplikaci');
  assert.deepEqual(states, [{ status: 'idle' }]);
  assert.deepEqual(timers.timeout, [m.UPDATE_FIRST_CHECK_MS]);
  assert.deepEqual(timers.interval, [m.UPDATE_CHECK_INTERVAL_MS]);
  assert.ok(m.UPDATE_FIRST_CHECK_MS >= 10000, 'po startu Windows ještě nemusí běžet síť');
});

test('chybějící modul aktualizací nezabrání startu aplikace', () => {
  const { m, logged, timers } = loadInit({ isPackaged: true, requireImpl: () => { throw new Error('Cannot find module'); } });
  assert.equal(m.initAutoUpdate(), false);
  assert.equal(logged.length, 1);
  assert.equal(timers.timeout.length, 0);
});

test('automatická kontrola selhává tiše a nalezenou verzi nechává v nabídce', async () => {
  const idle = updateMachine(fakeUpdater({ checkFails: true }), { status: 'idle' });
  assert.equal((await idle.m.checkForUpdates(false)).ok, false);
  assert.equal(idle.state().status, 'idle');
  assert.equal(idle.state().error, null, 'chyba jen v protokolu');

  const known = updateMachine(fakeUpdater({ checkFails: true }), { status: 'available', version: '4.8.4' });
  await known.m.checkForUpdates(false);
  assert.equal(known.state().status, 'available');
  assert.equal(known.state().version, '4.8.4');
});

test('ruční kontrola chybu ukáže', async () => {
  const x = updateMachine(fakeUpdater({ checkFails: true }), { status: 'idle' });
  const r = await x.m.checkForUpdates(true);
  assert.equal(r.ok, false);
  assert.equal(x.state().status, 'error');
  assert.equal(x.state().error, x.m.UPDATE_CHECK_FAILED);
  assert.deepEqual(x.sent.at(-1).channel, 'update:state', 'stav jde do okna');
});

// Hlášeno 2026-10-12: nainstalovaná 4.8.3, poslední finální vydání v4.7.4
// ještě bez instalátoru. Internet fungoval, GitHub odpověděl – přesto hláška
// radila zkontrolovat připojení. Správně: není co aktualizovat.
test('poslední vydání bez instalátoru, starší nebo stejné: „aktuální verze“, žádná chyba', async () => {
  for (const tag of ['v4.7.4', 'v4.8.3']) {
    for (const manual of [true, false]) {
      const x = updateMachine(fakeUpdater({ checkError: noInstallerError(tag) }), { status: 'idle' });
      const r = await x.m.checkForUpdates(manual);
      assert.equal(r.ok, true, `${tag} manual=${manual}`);
      assert.equal(r.error, undefined);
      assert.equal(x.state().status, 'none');
      assert.equal(x.state().error, null);
    }
  }
});

test('poslední vydání bez instalátoru, ale novější: řekne verzi a že se instaluje ručně', async () => {
  for (const manual of [true, false]) {
    const x = updateMachine(fakeUpdater({ checkError: noInstallerError('v4.9.0') }), { status: 'idle' });
    const r = await x.m.checkForUpdates(manual);
    assert.equal(r.ok, false);
    assert.equal(x.state().status, 'error');
    assert.match(x.state().error, /verze 4\.9\.0/);
    assert.match(x.state().error, /bez instalátoru/);
    assert.match(x.state().error, /github\.com\/Braunn318\/futures-journal-pro\/releases/);
    assert.doesNotMatch(x.state().error, /připojení/, 'se sítí to nesouvisí');
    assert.equal(r.error, x.state().error);
  }
});

test('vydání bez instalátoru se do protokolu zapíše jednou za spuštění, ne při každé kontrole', async () => {
  const x = updateMachine(fakeUpdater({ checkError: noInstallerError('v4.7.4') }), { status: 'idle' });
  await x.m.checkForUpdates(false);
  await x.m.checkForUpdates(false);
  await x.m.checkForUpdates(true);
  assert.equal(x.info.length, 1);
  assert.match(x.info[0], /4\.7\.4/);

  // Posluchač chyb ho přeskakuje, ostatní chyby zapisuje jedním řádkem.
  const updater = fakeUpdater();
  const { m, logged } = loadInit({ isPackaged: true, requireImpl: () => ({ autoUpdater: updater }) });
  m.initAutoUpdate();
  updater.handlers.error(noInstallerError('v4.7.4'));
  assert.equal(logged.length, 0);
  updater.handlers.error(new Error('net::ERR_NAME_NOT_RESOLVED\nheaders: …'));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].error, 'net::ERR_NAME_NOT_RESOLVED');
});

test('skutečně nepovedená kontrola: hláška nesvádí vinu jen na internet', async () => {
  const x = updateMachine(fakeUpdater({ checkFails: true }), { status: 'idle' });
  await x.m.checkForUpdates(true);
  assert.match(x.state().error, /GitHub neodpověděl nebo není připojení/);
  // Stejný kód chyby, ale bez čitelné adresy vydání → nic se nehádá.
  const odd = new Error('Cannot find latest.yml');
  odd.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
  const y = updateMachine(fakeUpdater({ checkError: odd }), { status: 'idle' });
  assert.equal((await y.m.checkForUpdates(true)).ok, false);
  assert.equal(y.state().status, 'error');
  assert.equal(y.state().error, y.m.UPDATE_CHECK_FAILED);
});

test('verze vydání z chyby a porovnání verzí', () => {
  const { releaseVersionFromUpdateError, compareVersions } = loadMain(['UPDATE_NO_INSTALLER_CODE', 'releaseVersionFromUpdateError', 'compareVersions']);
  assert.equal(releaseVersionFromUpdateError(noInstallerError('v4.7.4')), '4.7.4');
  assert.equal(releaseVersionFromUpdateError(noInstallerError('v4.10.0')), '4.10.0');
  assert.equal(releaseVersionFromUpdateError(new Error('net::ERR_FAILED https://github.com/x/y/releases/download/v4.7.4/latest.yml')), null, 'jiná chyba se stejnou adresou');
  assert.equal(releaseVersionFromUpdateError(null), null);
  assert.equal(compareVersions('4.7.4', '4.8.3'), -1);
  assert.equal(compareVersions('4.8.3', '4.8.3'), 0);
  assert.equal(compareVersions('v4.8.4', '4.8.3'), 1);
  assert.equal(compareVersions('4.10.0', '4.9.9'), 1, 'čísla, ne řetězce');
  assert.equal(compareVersions('5.0.0', '4.99.99'), 1);
  assert.equal(compareVersions('4.8.3-test', '4.8.3'), 0, 'přípona se nepočítá');
});

test('kontrola nepřepíše rozběhnuté stahování ani stažený instalátor', async () => {
  for (const status of ['checking', 'downloading', 'downloaded']) {
    const updater = fakeUpdater();
    const x = updateMachine(updater, { status, version: '4.8.4' });
    await x.m.checkForUpdates(false);
    assert.equal(updater.calls.check, 0, status);
    assert.equal(x.state().status, status);
  }
});

test('bez nainstalované aplikace kontrola jen řekne, že není podporovaná', async () => {
  const x = updateMachine(null);
  assert.deepEqual({ ...(await x.m.checkForUpdates(true)) }, { ok: false, unsupported: true });
  assert.equal(x.state().status, 'unsupported');
  assert.equal(x.state().currentVersion, '4.8.3');
});

test('stažení: jen u nabídnuté verze; po úspěchu je stav „staženo“', async () => {
  const none = fakeUpdater();
  const idle = updateMachine(none, { status: 'none' });
  assert.equal((await idle.m.downloadUpdate()).ok, false);
  assert.equal(none.calls.download, 0);

  const x = updateMachine(fakeUpdater(), { status: 'available', version: '4.8.4' });
  assert.equal((await x.m.downloadUpdate()).ok, true);
  assert.equal(x.state().status, 'downloaded', 'renderer po návratu rovnou instaluje');
});

test('nepovedené stažení vrátí nabídku a řekne proč', async () => {
  const x = updateMachine(fakeUpdater({ downloadFails: true }), { status: 'available', version: '4.8.4' });
  const r = await x.m.downloadUpdate();
  assert.equal(r.ok, false);
  assert.equal(x.state().status, 'available', 'jde to zkusit znovu');
  assert.equal(x.state().error, x.m.UPDATE_DOWNLOAD_FAILED);
});

test('instalace: jen stažená verze, tiše, s opětovným spuštěním a skutečným ukončením', () => {
  const early = fakeUpdater();
  const notYet = updateMachine(early, { status: 'available', version: '4.8.4' });
  assert.equal(notYet.m.installUpdate().ok, false);
  assert.equal(early.calls.quitAndInstall.length, 0);
  assert.equal(notYet.isQuitting(), false);

  const updater = fakeUpdater();
  const x = updateMachine(updater, { status: 'downloaded', version: '4.8.4' });
  assert.equal(x.m.installUpdate().ok, true);
  assert.equal(x.isQuitting(), true, 'jinak se okno při zavření jen schová a aplikace běží dál');
  assert.deepEqual(updater.calls.quitAndInstall, [[true, true]]);
});

test('seznam změn: sjednocené konce řádků, zkrácení na celé řádky', () => {
  const { cleanReleaseNotes } = loadMain(['UPDATE_NOTES_MAX', 'cleanReleaseNotes']);
  assert.equal(cleanReleaseNotes('- a\r\n- b\r\n'), '- a\n- b');
  assert.equal(cleanReleaseNotes(null), '');
  const long = Array.from({ length: 200 }, (_, i) => `- změna číslo ${i}`).join('\n');
  const cut = cleanReleaseNotes(long, 300);
  assert.ok(cut.length <= 302);
  assert.ok(cut.endsWith('\n…'));
  for (const line of cut.split('\n').slice(0, -1)) assert.match(line, /^- změna číslo \d+$/, 'žádný useknutý řádek');
});

test('menu ikony u hodin: položka aktualizace jen když je co instalovat', () => {
  const { trayMenuTemplate } = loadMain(['trayMenuTemplate']);
  const labels = state => Array.from(trayMenuTemplate(state), item => item.label).filter(Boolean);
  const base = ['Otevřít Futures Journal PRO', 'Ukončit aplikaci a záznam'];
  for (const status of ['unsupported', 'idle', 'checking', 'none', 'downloading', 'error']) {
    assert.deepEqual(labels({ status, version: '4.8.4' }), base, status);
  }
  assert.deepEqual(labels({ status: 'available', version: null }), base);
  for (const status of ['available', 'downloaded']) {
    assert.deepEqual(labels({ status, version: '4.8.4' }), [base[0], 'Nainstalovat aktualizaci 4.8.4…', base[1]], status);
  }
});

// ------------------------------------------------------------------ renderer

test('nabídka: jen dostupná verze; „Později“ platí pro tu verzi do restartu', () => {
  const { shouldOfferUpdate } = loadRenderer(['shouldOfferUpdate']);
  const available = { status: 'available', version: '4.8.4' };
  assert.equal(shouldOfferUpdate(available, null, false), true);
  assert.equal(shouldOfferUpdate(available, '4.8.4', false), false, 'odloženo');
  assert.equal(shouldOfferUpdate(available, '4.8.4', true), true, 'vyžádáno z Nastavení / ikony u hodin');
  assert.equal(shouldOfferUpdate({ status: 'available', version: '4.8.5' }, '4.8.4', false), true, 'mezitím vyšla další verze');
  for (const status of ['unsupported', 'idle', 'checking', 'none', 'downloading', 'downloaded', 'error']) {
    assert.equal(shouldOfferUpdate({ status, version: '4.8.4' }, null, true), false, status);
  }
  assert.equal(shouldOfferUpdate({ status: 'available', version: null }, null, false), false);
  assert.equal(shouldOfferUpdate(null, null, true), false);
});

test('text nabídky: verze, seznam změn jako prostý text, ujištění o datech', () => {
  const { updateOfferMessage } = loadRenderer(['updateOfferMessage']);
  const state = { version: '4.8.4', currentVersion: '4.8.3', notes: '- Oprava <b>X</b>' };
  const text = updateOfferMessage(state);
  assert.match(text, /4\.8\.4/);
  assert.match(text, /4\.8\.3/);
  assert.ok(text.includes('- Oprava <b>X</b>'), 'značky se nepřevádějí, okno je vypíše jako text');
  assert.match(text, /zůstávají/);
  assert.doesNotMatch(updateOfferMessage({ ...state, notes: '' }), /Co je nového/);
});

test('nabídka i seznam změn jdou do okna jen přes textContent', () => {
  const html = readRepoFile('app/index.html');
  assert.match(html, /\$\('confirmModalMessage'\)\.textContent=next\.message/);
  assert.match(html, /\$\('updateInfo'\)\.textContent=updateStatusText\(updateState\)/);
});

test('karta v Nastavení: každý stav má srozumitelný text', () => {
  const { updateStatusText } = loadRenderer(['updateStatusText']);
  const s = (status, extra = {}) => updateStatusText({ status, currentVersion: '4.8.3', version: '4.8.4', percent: 42, ...extra });
  assert.equal(updateStatusText(null), 'Dostupné jen v desktopové aplikaci.');
  assert.match(s('unsupported'), /jen v nainstalované aplikaci/);
  assert.match(s('none'), /aktuální verzi/);
  assert.match(s('available'), /Dostupná je verze 4\.8\.4/);
  assert.match(s('downloading'), /42 %/);
  assert.match(s('downloaded'), /připravená k instalaci/);
  assert.match(s('error', { error: 'Bez sítě.' }), /Bez sítě\./);
  for (const status of ['unsupported', 'idle', 'checking', 'none', 'available', 'downloading', 'downloaded', 'error']) {
    assert.match(s(status), /^Nainstalovaná verze: 4\.8\.3\./, status);
  }
});

test('nabídka se ukazuje až po přihlášení a nepřekryje rozdělanou práci', () => {
  const html = readRepoFile('app/index.html');
  const { extractDeclaration, inlineScripts } = require('./helpers/extract');
  const script = inlineScripts(html);
  const offer = extractDeclaration(script, 'maybeOfferUpdate');
  assert.match(offer, /if\(!updateOfferReady\|\|/, 'před přihlášením nic');
  assert.ok(offer.indexOf('waitForNoOpenModal()') < offer.indexOf('showConfirm('), 'nejdřív počkat na zavřená okna');
  const start = extractDeclaration(script, 'startUpdate');
  assert.ok(start.indexOf('waitForNoOpenModal()') < start.indexOf('installUpdate()'), 'restart až po zavření oken');
  assert.ok(start.indexOf('positionsOk()') < start.indexOf('downloadUpdate()'), 'otevřená pozice se řeší před stažením');
  // Připravenost je navázaná na přihlášení, ne na načtení deníku – bez deníku
  // load() neproběhne a tlačítko „Aktualizovat“ v Nastavení by nic neudělalo.
  assert.match(script, /addEventListener\('journal:authenticated',\(\)=>setTimeout\(\(\)=>\{updateOfferReady=true;maybeOfferUpdate\(\)\}/);
  assert.equal(script.split('updateOfferReady=true').length - 1, 1, 'jediné místo, kde se nabídka povoluje');
  assert.match(script, /sessionStorage\.setItem\(UPDATE_POSTPONED_KEY/, '„Později“ přežije přepnutí deníku (reload stránky)');
});

// ---------------------------------------------------- konfigurace sestavení

test('electron-updater je běhová závislost (jinak se nezabalí do instalátoru)', () => {
  const p = pkg();
  assert.ok(p.dependencies?.['electron-updater'], 'musí být v dependencies');
  assert.equal(p.devDependencies?.['electron-updater'], undefined);
});

test('sestavení míří na stejný repozitář jako aplikace a samo nic nenahrává', () => {
  const p = pkg();
  const { UPDATE_REPO } = loadMain(['UPDATE_REPO']);
  assert.deepEqual(p.build.publish, [{ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo }]);
  assert.match(p.scripts.dist, /--publish never/);
});

// GitHub mezery v názvu nahraného souboru nahrazuje tečkami – latest.yml by
// pak odkazoval na soubor, který v releasu není, a stažení by skončilo 404.
test('název instalátoru je bez mezer', () => {
  assert.doesNotMatch(pkg().build.artifactName, /\s/);
});

test('preload vystavuje API aktualizací a hlavní proces obsluhuje každý kanál', () => {
  const preload = readRepoFile('preload.js');
  const main = readRepoFile('main.js');
  for (const method of ['getAppVersion', 'getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'onUpdateState']) {
    assert.match(preload, new RegExp(`\\b${method}:`), method);
  }
  const channels = [...preload.matchAll(/invoke\('((?:update|app):[A-Za-z]+)'/g)].map(m => m[1]);
  assert.ok(channels.includes('update:install'));
  for (const channel of channels) assert.ok(main.includes(`ipcMain.handle('${channel}'`), channel);
});
