const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen, shell, clipboard, Tray, Menu, nativeImage, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
// Dopočty kontextu obchodu (kontext v2, A3) – tytéž čisté funkce jako
// v rendereru, pro AI export. Modul je dual (script src i require).
const FJContext = require('./app/context.js');
const FJPoints = require('./app/points.js');

// Screenshoty obchodů se nedrží v JSONu deníku, ale jako obyčejné soubory, na
// které deník odkazuje adresou "fjimg://store/<otisk>.<přípona>" (viz sekce
// "Úložiště screenshotů" níž). Aby <img src="fjimg://…"> uvnitř aplikace
// fungoval, musí být schéma zaregistrované JEŠTĚ PŘED tím, než je Electron
// připravený – proto je tohle volání hned u requirů, ne až v app.whenReady().
protocol.registerSchemesAsPrivileged([{
  scheme: 'fjimg',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

let mainWindow;
let tray = null;
let isQuitting = false;
const startHidden = process.argv.includes('--background');

// Šablony konektorů (CONNECTORS) se v zabaleném instalátoru drží MIMO asar
// archiv (viz "extraResources" v package.json) – jde o soubory, které mají
// zůstat čitelné/otevíratelné jako normální soubory na disku (Průzkumník
// Windows neumí "otevřít" cestu uvnitř .asar archivu). V nezabalené appce
// (spuštěno přes "npm start") žádný resources adresář neexistuje, tam se
// použije prostá cesta ve zdrojové složce projektu.
function connectorsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'CONNECTORS')
    : path.join(__dirname, 'CONNECTORS');
}

// Zabrání spuštění více kopií aplikace. Druhé spuštění pouze otevře existující okno.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}
const settingsPath = () => path.join(resolveDataDir(), 'backup-settings.json');
// Protokol se zapíše vždy: když složka dat zrovna chybí, do výchozí userData
// (jen pro diagnostiku – data deníku tam nikdy nejdou).
function logPath() {
  let dir;
  try { dir = resolveDataDir(); } catch { dir = app.getPath('userData'); }
  return path.join(dir, 'futures-journal-error.log');
}

function appendLog(context, text) {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${context}: ${text}\n`, 'utf8');
  } catch {}
}
function logError(context, error) { appendLog(context, error?.stack || error); }
// Do stejného protokolu patří i události, které nejsou chyba, ale u kterých je
// důležité vědět, že a kdy proběhly – hlavně jednorázový přesun screenshotů
// z JSONu deníku do samostatných souborů.
function logInfo(context, message) { appendLog(context, message); }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}
function writeSettings(data) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
}

// ---------- Umístění dat (volitelně mimo systémový disk C:) ----------
// V "userData" (vždy na C:, dané Windows/Electronem) se drží jen tenhle
// malý ukazatel na skutečné umístění dat – samotné deníky, screenshoty a
// nastavení se pak čtou/zapisují ZE ZVOLENÉ SLOŽKY, ne z C:.
const dataLocationConfigPath = () => path.join(app.getPath('userData'), 'data-location.json');
// Nastavená složka dat chybí (odpojený disk, spadlá síťová jednotka, smazaná
// složka): appka NIKDY tiše nepřejde na výchozí userData – dřív tam zapisovala
// obchody, které po návratu disku nebyly vidět, a konektor si založil nové
// nastavení s NOVÝM API klíčem (2026-10-16). Místo toho resolveDataDir hodí
// chybu FJ_DATA_DIR_MISSING: zápis i čtení selžou nahlas, ukládání je
// pozastavené, zprávy konektoru se drží v záloze (captureSpool) a uživatel
// dostane upozornění (watchDataDir).
// Výjimka: při startu zvolené „Pokračovat s výchozí" (checkDataLocationAtStartup)
// – pak tenhle běh vědomě jede z userData až do konce.
const dataDirState = { sessionDefault: false, missing: null, onMissing: null };
function dataDirMissingError(dir) {
  const error = new Error(`Složka s daty není dostupná: ${dir}. Ukládání je pozastavené – připoj disk a dej „Zkusit znovu".`);
  error.code = 'FJ_DATA_DIR_MISSING';
  return error;
}
// Nastavená vlastní složka, ze které tenhle běh má jet (null = výchozí userData).
function configuredDataDir() {
  if (dataDirState.sessionDefault) return null;
  return readDataLocationConfig().customDataDir || null;
}
function resolveDataDir() {
  const custom = configuredDataDir();
  if (!custom) return app.getPath('userData');
  if (fs.existsSync(custom)) return custom;
  if (dataDirState.missing !== custom) {
    dataDirState.missing = custom;
    if (dataDirState.onMissing) { try { dataDirState.onMissing(custom); } catch {} }
  }
  throw dataDirMissingError(custom);
}
function dataDirAvailable() {
  try { resolveDataDir(); return true; } catch { return false; }
}
function readDataLocationConfig() {
  try { return JSON.parse(fs.readFileSync(dataLocationConfigPath(), 'utf8')) || {}; }
  catch { return {}; }
}
// Instalační složka programu. Instalátor ji při každé aktualizaci celou smaže
// (odinstalace staré verze), i s tím, co do ní uživatel uložil – data ani
// obrázky v ní proto ležet nesmí (4.8.9: takhle se ztratily screenshoty).
// Ve zdrojové verzi instalace není; test si ji podstrčí přes FJ_TEST_INSTALL_DIR.
function installDir() {
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  return process.env.FJ_TEST_INSTALL_DIR || null;
}
function isInsideInstallDir(p) {
  const inst = installDir();
  if (!inst || !p) return false;
  const norm = x => path.resolve(x).toLowerCase();
  const target = norm(p);
  return target === norm(inst) || target.startsWith(norm(inst) + path.sep);
}
const INSTALL_DIR_ERROR = 'Tahle složka je uvnitř složky programu. Instalátor ji při každé aktualizaci smaže i s daty – vyber složku mimo program (např. E:\\ nebo Dokumenty).';
function writeDataLocationConfig(customDataDir) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataLocationConfigPath(), JSON.stringify({ customDataDir }, null, 2), 'utf8');
}
// ---------- Přesun složky dat (bezpečné pořadí, 4.8.93) ----------
// Co ve složce dat patří deníku a stěhuje se s ní. ESSENTIAL jsou data, která
// nejdou znovu vytvořit – když už je cíl má, přesun se odmítne (nic se
// nepřepisuje). Ostatní jsou dopočet / mezipaměť / protokol.
const DATA_ENTRIES = ['journal-data', 'trade-capture', 'backup-settings.json', 'ai-export', 'futures-journal-error.log', 'news-calendar.json'];
const DATA_ENTRIES_ESSENTIAL = ['journal-data', 'trade-capture', 'backup-settings.json'];
// Pojistka těsně před přesunem do pevného, nikdy se nepřesouvajícího místa
// (userData/safety-backups): deníky (bez obrázků – ty se kopírují a ověřují
// stejně jako zbytek), konektor (API klíč, mapování účtů, exekuce, pozice; bez
// screenshotů), nastavení a manifest AI exportu. Když se záloha nepovede,
// přesun se nespustí.
function writeSafetyBackupBeforeMove(oldDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(app.getPath('userData'), 'safety-backups', `pred-presunem-${stamp}`);
  const skip = [path.join(oldDir, 'journal-data', 'images'), path.join(oldDir, 'trade-capture', 'screenshots')].map(p => path.resolve(p));
  const keep = src => { const r = path.resolve(src); return !skip.some(s => r === s || r.startsWith(s + path.sep)); };
  for (const name of ['journal-data', 'trade-capture', 'backup-settings.json', path.join('ai-export', 'index.json')]) {
    const src = path.join(oldDir, name);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(backupDir, name)), { recursive: true });
    fs.cpSync(src, path.join(backupDir, name), { recursive: true, filter: keep });
  }
  return backupDir;
}
// Soubory položky (složky i jednoho souboru) jako relativní cesta → velikost.
function dataEntryFiles(root) {
  const out = new Map();
  const walk = (abs, rel) => {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) { out.set(rel, st.size); return; }
    for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), rel ? path.join(rel, name) : name);
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}
function assertSameDataEntry(src, dest, name) {
  const a = dataEntryFiles(src), b = dataEntryFiles(dest);
  for (const [rel, size] of a) {
    if (b.get(rel) !== size) throw new Error(`Kopie „${path.join(name, rel)}“ v novém umístění nesedí – přesun zastaven, data zůstávají na původním místě.`);
  }
  if (b.size !== a.size) throw new Error(`Kopie „${name}“ v novém umístění nesedí (počet souborů) – přesun zastaven, data zůstávají na původním místě.`);
}
// Přesun dat ze staré do nové složky. Pořadí:
//   1) cíl nesmí už mít data deníku (jinak odmítnout – nic se nepřepisuje),
//   2) pojistná záloha (když selže, konec),
//   3) zkopírovat vše a OVĚŘIT (seznam souborů a velikosti),
//   4) přepnout ukazatel (`switchPointer`),
//   5) až potom smazat staré kopie (jen úklid – selhání se jen zaloguje).
// Selže-li cokoli v 1–4, ze staré složky se nic nesmaže a z cíle se odstraní
// jen to, co sem tenhle přesun nakopíroval.
// Celý přesun MUSÍ zůstat synchronní: dokud běží, hlavní proces nevyřídí
// žádný jiný zápis (uložení obchodu, zprávu konektoru) – ty počkají a zapíšou
// se až do nového umístění. S async kopírováním by zápis během přesunu skončil
// ve staré složce a úklid by ho smazal.
function moveDataContents(oldDir, newDir, switchPointer) {
  const present = DATA_ENTRIES.filter(name => fs.existsSync(path.join(oldDir, name)));
  const target = path.resolve(newDir);
  if (present.some(name => { const base = path.resolve(path.join(oldDir, name)); return target === base || target.startsWith(base + path.sep); })) {
    throw new Error('Nová složka nesmí ležet uvnitř přesouvaných dat (např. v journal-data).');
  }
  const clash = DATA_ENTRIES_ESSENTIAL.filter(name => fs.existsSync(path.join(newDir, name)));
  if (clash.length) throw new Error(`Ve vybrané složce už jsou data deníku (${clash.join(', ')}): ${newDir}. Vyber prázdnou složku, nebo tu starou nejdřív přejmenuj – nic se nepřepisuje.`);
  writeSafetyBackupBeforeMove(oldDir);
  const createdDir = !fs.existsSync(newDir);
  const copied = [];
  try {
    fs.mkdirSync(newDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const name of present) {
      const src = path.join(oldDir, name), dest = path.join(newDir, name);
      if (fs.existsSync(dest)) {
        // Jen dopočet / mezipaměť / protokol (data deníku odmítnuta výš):
        // starý protokol se odloží, zbytek se nahradí čerstvou kopií.
        if (name === 'futures-journal-error.log') fs.renameSync(dest, `${dest}.predchozi-${stamp}`);
        else fs.rmSync(dest, { recursive: true, force: true });
      }
      copied.push(name);
      fs.cpSync(src, dest, { recursive: true });
      assertSameDataEntry(src, dest, name);
    }
    // Vlastní složka obrázků uvnitř přesouvané položky se stěhuje s ní –
    // nastavení v NOVÉ kopii musí ukazovat na nové místo.
    const custom = readImagesDirFrom(newDir);
    const inside = custom && copied.find(name => { const base = path.resolve(path.join(oldDir, name)); const r = path.resolve(custom); return r === base || r.startsWith(base + path.sep); });
    const movedImagesDir = inside ? path.join(newDir, path.relative(oldDir, custom)) : null;
    if (movedImagesDir) {
      const file = path.join(newDir, 'backup-settings.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), imagesDir: movedImagesDir }, null, 2), 'utf8');
    }
    switchPointer();
    if (movedImagesDir) { imagesDirSetting.dir = movedImagesDir; imagesDirSetting.loaded = true; }
  } catch (error) {
    for (const name of copied) { try { fs.rmSync(path.join(newDir, name), { recursive: true, force: true }); } catch {} }
    if (createdDir) { try { fs.rmdirSync(newDir); } catch {} }
    throw error;
  }
  // Ukazatel už vede do newDir – appka svá data najde i kdyby úklid selhal.
  for (const name of copied) {
    try { fs.rmSync(path.join(oldDir, name), { recursive: true, force: true }); } catch (error) { logError('Přesun dat – úklid', error); }
  }
  logInfo('Umístění dat', `${oldDir} → ${newDir}: ${copied.join(', ') || 'nic k přesunu'}`);
  return copied;
}
function readImagesDirFrom(dir) {
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(dir, 'backup-settings.json'), 'utf8')).imagesDir;
    return typeof custom === 'string' && path.isAbsolute(custom) ? custom : null;
  } catch { return null; }
}
ipcMain.handle('data:getLocation', async () => {
  try { const p = resolveDataDir(); return { ok: true, path: p, isDefault: p === app.getPath('userData') }; }
  catch (error) {
    if (error?.code === 'FJ_DATA_DIR_MISSING') return { ok: true, path: configuredDataDir(), isDefault: false, missing: true };
    return { ok: false, error: error.message };
  }
});
// ---------- Složka dat zmizela za běhu ----------
// Hlídá se každých 5 s a hned při prvním neúspěšném resolveDataDir. Zmizení:
// protokol, banner v rendereru, upozornění (Zkusit znovu / Vybrat složku… /
// Zavřít). Návrat: banner pryč a přehrání zálohy konektoru. Do userData se
// mezitím nic nezapisuje (rozhodnutí 2026-10-19: žádné „Pokračovat s výchozí"
// za běhu – data by se rozdělila na dvě místa).
const DATA_DIR_WATCH_MS = 5000;
const dataDirWatch = { timer: null, dialogOpen: false };
function sendDataDirState(ok, dir) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data:availability', { ok, path: dir });
}
function handleDataDirMissing(dir) {
  // Volá se zevnitř resolveDataDir (třeba uprostřed zápisu) – zbytek až po něm.
  setImmediate(() => {
    logInfo('Umístění dat', `složka dat ${dir} není dostupná – ukládání pozastaveno, zprávy konektoru jdou do zálohy (userData/capture-spool)`);
    sendDataDirState(false, dir);
    showDataDirMissingDialog(dir).catch(error => logError('Umístění dat – upozornění', error));
  });
}
// Je složka zpět? Pokud ano, zruší stav „chybí", dá vědět rendereru a přehraje zálohu.
function checkDataDirBack() {
  if (!dataDirState.missing) return true;
  const custom = configuredDataDir();
  if (custom && !fs.existsSync(custom)) return false;
  const was = dataDirState.missing;
  dataDirState.missing = null;
  logInfo('Umístění dat', `složka dat ${was} je zpět, ukládání pokračuje`);
  sendDataDirState(true, custom || app.getPath('userData'));
  replayCaptureSpool().catch(error => logError('Záloha konektoru', error));
  return true;
}
// Vybraná složka (nebo její podsložka FuturesJournalPRO-Data) musí obsahovat journal-data.
function findDataDirIn(picked) {
  return [picked, path.join(picked, 'FuturesJournalPRO-Data')].find(dir => fs.existsSync(path.join(dir, 'journal-data'))) || null;
}
async function showDataDirMissingDialog(dir) {
  if (dataDirWatch.dialogOpen) return;
  dataDirWatch.dialogOpen = true;
  try {
    for (;;) {
      if (checkDataDirBack()) return;
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const { response } = await dialog.showMessageBox(owner, {
        type: 'warning',
        title: 'Futures Journal PRO',
        message: 'Složka s daty není dostupná.',
        detail: `${dir}\n\nUkládání je pozastavené, nic se nezapisuje jinam. Zprávy z NinjaTraderu se drží v záloze a doplní se, až bude složka zpět.\n\nPřipoj disk a dej „Zkusit znovu". Pokud se složka přesunula, vyber ji (aplikace se pak restartuje a načte data z ní).`,
        buttons: ['Zkusit znovu', 'Vybrat složku…', 'Zavřít'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      if (response === 0) continue;
      if (response === 2) return;
      const picked = await dialog.showOpenDialog(owner, { title: 'Vyber složku s daty Futures Journal PRO', properties: ['openDirectory'] });
      if (picked.canceled || !picked.filePaths?.[0]) continue;
      const found = findDataDirIn(picked.filePaths[0]);
      if (!found) {
        await dialog.showMessageBox(owner, { type: 'error', title: 'Futures Journal PRO', message: 'Ve vybrané složce nejsou data deníku (chybí podsložka journal-data).', noLink: true });
        continue;
      }
      if (isInsideInstallDir(found)) {
        await dialog.showMessageBox(owner, { type: 'error', title: 'Futures Journal PRO', message: INSTALL_DIR_ERROR, noLink: true });
        continue;
      }
      writeDataLocationConfig(found);
      logInfo('Umístění dat', `${dir} nedostupné, za běhu vybráno ${found} – restart`);
      app.relaunch();
      app.exit(0);
      return;
    }
  } finally {
    dataDirWatch.dialogOpen = false;
  }
}
function watchDataDir() {
  dataDirState.onMissing = handleDataDirMissing;
  if (dataDirWatch.timer) clearInterval(dataDirWatch.timer);
  dataDirWatch.timer = setInterval(() => {
    if (dataDirState.missing) checkDataDirBack();
    else dataDirAvailable();
  }, DATA_DIR_WATCH_MS);
}
ipcMain.handle('data:retryLocation', async () => {
  if (checkDataDirBack()) return { ok: true };
  showDataDirMissingDialog(dataDirState.missing).catch(error => logError('Umístění dat – upozornění', error));
  return { ok: false, missing: true, path: dataDirState.missing };
});
ipcMain.handle('data:availability', async () => {
  const ok = dataDirAvailable();
  return { ok, path: ok ? resolveDataDir() : dataDirState.missing };
});
// ---------- Složka obrázků (4.8.7) ----------
// Obrázky můžou ležet kdekoli (jiný disk, synchronizovaná složka). Přesun:
// kontrola konfliktů → kopie všeho → ověření velikostí → přepnutí → smazání
// starých kopií. Když cokoli selže před přepnutím, platí dál stará složka
// a nic se nesmaže. Soubor se stejným jménem a JINÝM obsahem v cíli přesun
// zastaví – nic se nepřepisuje.
function listImageFiles(dir) {
  const out = [];
  const walk = (base, rel) => {
    if (!fs.existsSync(base)) return;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const r = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) { if (!rel && entry.name === THUMB_DIR) walk(path.join(base, entry.name), r); }
      else if (!entry.name.endsWith('.tmp')) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}
function imagesLocationInfo() {
  const dir = imagesRoot();
  const files = listImageFiles(dir).filter(f => !f.startsWith(THUMB_DIR + path.sep) && f !== IMAGE_RENAME_FILE);
  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(path.join(dir, f)).size; } catch {} }
  return { dir, isDefault: !imagesRoot() || path.resolve(imagesRoot()) === path.resolve(path.join(dataRoot(), 'images')), count: files.length, bytes, includeInBackup: backupIncludesImages() };
}
function moveImagesDir(target) {
  const from = path.resolve(imagesRoot());
  const to = path.resolve(target);
  if (from === to) return { ok: true, unchanged: true };
  if (isInsideInstallDir(to)) throw new Error(INSTALL_DIR_ERROR);
  if (to.startsWith(from + path.sep) || from.startsWith(to + path.sep)) throw new Error('Nová složka nesmí být uvnitř stávající ani naopak.');
  const files = listImageFiles(from);
  const conflicts = files.filter(f => fs.existsSync(path.join(to, f)) && !sameFileContent(path.join(from, f), path.join(to, f)));
  if (conflicts.length) throw new Error(`V cílové složce už jsou jiné soubory se stejným jménem (${conflicts.slice(0, 3).join(', ')}${conflicts.length > 3 ? ' …' : ''}). Vyber prázdnou složku.`);
  fs.mkdirSync(to, { recursive: true });
  for (const f of files) {
    const src = path.join(from, f), dest = path.join(to, f);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (fs.statSync(dest).size !== fs.statSync(src).size) throw new Error(`Kopie ${f} nesedí – přesun zastaven, platí dál stará složka.`);
  }
  const defaultDir = path.resolve(path.join(dataRoot(), 'images'));
  writeSettings({ ...readSettings(), imagesDir: to === defaultDir ? undefined : to });
  imagesDirSetting.dir = to === defaultDir ? null : to;
  imagesDirSetting.loaded = true;
  for (const f of files) { try { fs.rmSync(path.join(from, f), { force: true }); } catch (error) { logError('Přesun obrázků – úklid', error); } }
  logInfo('Složka obrázků', `${from} → ${to}: ${files.length} souborů`);
  return { ok: true, moved: files.length };
}
ipcMain.handle('images:getLocation', async () => {
  try { return { ok: true, ...imagesLocationInfo() }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('images:chooseLocation', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Vyber složku pro obrázky', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return { ...moveImagesDir(result.filePaths[0]), ...imagesLocationInfo() };
  } catch (error) { logError('images:chooseLocation', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('images:resetLocation', async () => {
  try { return { ...moveImagesDir(path.join(dataRoot(), 'images')), ...imagesLocationInfo() }; }
  catch (error) { logError('images:resetLocation', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('images:openFolder', async () => {
  fs.mkdirSync(imagesRoot(), { recursive: true });
  const error = await shell.openPath(imagesRoot());
  return error ? { ok: false, error } : { ok: true };
});
ipcMain.handle('images:setBackupInclude', async (_event, value) => {
  writeSettings({ ...readSettings(), backupIncludeImages: value === true });
  return { ok: true, includeInBackup: backupIncludesImages() };
});
ipcMain.handle('data:chooseLocation', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Vyber složku pro ukládání dat Futures Journal PRO',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
    const oldDir = resolveDataDir();
    const newDir = path.join(result.filePaths[0], 'FuturesJournalPRO-Data');
    if (isInsideInstallDir(newDir)) return { ok: false, error: INSTALL_DIR_ERROR };
    if (path.resolve(newDir) === path.resolve(oldDir)) return { ok: false, error: 'Vybraná složka už je aktuálním umístěním dat.' };
    moveDataContents(oldDir, newDir, () => writeDataLocationConfig(newDir));
    return { ok: true, path: newDir };
  } catch (error) {
    logError('data:chooseLocation', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('data:resetLocationToDefault', async () => {
  try {
    const oldDir = resolveDataDir();
    const defaultDir = app.getPath('userData');
    const dropPointer = () => fs.rmSync(dataLocationConfigPath(), { force: true });
    if (path.resolve(oldDir) !== path.resolve(defaultDir)) moveDataContents(oldDir, defaultDir, dropPointer);
    else dropPointer();
    return { ok: true, path: defaultDir };
  } catch (error) {
    logError('data:resetLocationToDefault', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.exit(0);
});

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // Známý problém Electronu na Windows: .focus() občas okno vizuálně aktivuje,
  // ale klávesnicový fokus OS oknu doopravdy nepředá – textová pole pak reagují
  // na myš (např. šipky u číselného pole), ale ne na psaní, dokud uživatel
  // neklikne jinam a zpět. Krátké přepnutí "vždy nahoře" fokus spolehlivě
  // vynutí i v těchto případech.
  if (process.platform === 'win32') {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.focus();
  }
}

// Menu ikony u hodin se skládá znovu při každé změně stavu aktualizace –
// položka „Nainstalovat aktualizaci“ v něm je jen tehdy, když je co instalovat.
function trayMenuTemplate(state) {
  const template = [
    {
      label: 'Otevřít Futures Journal PRO',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        else focusMainWindow();
      }
    }
  ];
  if (state && state.version && (state.status === 'available' || state.status === 'downloaded')) {
    const label = state.channel === 'test' ? `Nainstalovat testovací verzi ${state.version}…` : `Nainstalovat aktualizaci ${state.version}…`;
    template.push({ label, click: () => requestUpdateOffer() });
  }
  template.push(
    { type: 'separator' },
    {
      label: 'Ukončit aplikaci a záznam',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  );
  return template;
}
function refreshTrayMenu() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(updateState)));
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'app', 'assets', 'bull_bear_icon.ico'));
  tray.setTitle('Futures Journal PRO');
  tray.setToolTip('Futures Journal PRO – aplikace běží a automaticky zaznamenává');
  refreshTrayMenu();
  if (process.platform === 'win32') {
    try {
      tray.displayBalloon({
        title: 'Futures Journal PRO',
        content: 'Aplikace běží na pozadí. Pravým tlačítkem na ikonu ji můžete úplně ukončit.',
        iconType: 'info'
      });
    } catch {}
  }
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else focusMainWindow();
  });
  tray.on('double-click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else focusMainWindow();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1450,
    height: 920,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    title: 'Futures Journal PRO',
    icon: path.join(__dirname, 'app', 'assets', 'bull_bear_icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Odkaz s target="_blank" nebo window.open: http/https do systémového
  // prohlížeče, nikdy do nového okna Electronu.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url);
    if (external) shell.openExternal(external).catch(error => logError('window.open', error));
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => { if (!startHidden) focusMainWindow(); });
  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('Renderer process ended', JSON.stringify(details));
    dialog.showErrorBox('Futures Journal PRO', 'Aplikace se neočekávaně ukončila. Podrobnosti byly uloženy do chybového protokolu.');
  });
  // Nativní kontextové menu při kliknutí pravým tlačítkem na screenshot obchodu –
  // Electron ho jinak nenabízí sám od sebe. Umožní zkopírovat obrázek do schránky
  // nebo ho otevřít ve výchozím prohlížeči obrázků nastaveném ve Windows.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image' || !params.srcURL) return;
    // Screenshot je buď odkaz do úložiště ("fjimg://…"), nebo – u obrázku
    // právě vloženého do formuláře, než se uloží – ještě base64.
    const parsed = imageToBuffer(params.srcURL);
    if (!parsed) return;
    const img = nativeImage.createFromBuffer(parsed.buffer);
    const menu = Menu.buildFromTemplate([
      { label: 'Kopírovat obrázek', click: () => clipboard.writeImage(img) },
      { label: 'Otevřít ve výchozím prohlížeči obrázků', click: () => openImageExternally(params.srcURL) },
      { label: 'Uložit obrázek jako…', click: () => saveImageAs(params.srcURL) }
    ]);
    menu.popup();
  });
  // Spolehlivé nalezení index.html ve zdrojové i nainstalované verzi.
  const indexCandidates = [
    path.join(__dirname, 'app', 'index.html'),
    path.join(process.resourcesPath || '', 'app', 'index.html'),
    path.join(process.resourcesPath || '', 'app.asar', 'app', 'index.html')
  ];
  const indexPath = indexCandidates.find(candidate => candidate && fs.existsSync(candidate));

  if (!indexPath) {
    const detail = `Hlavní soubor index.html nebyl nalezen.\n\nKontrolované cesty:\n${indexCandidates.join('\n')}`;
    logError('Missing application index', detail);
    dialog.showErrorBox('Futures Journal PRO', `${detail}\n\nProtokol: ${logPath()}`);
    return;
  }

  mainWindow.loadFile(indexPath).catch(error => {
    logError(`Failed to load application from ${indexPath}`, error);
    // Krátké opakování načtení řeší ojedinělé ERR_FAILED při startu Windows.
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.loadFile(indexPath).catch(secondError => {
        logError(`Second load failed from ${indexPath}`, secondError);
        dialog.showErrorBox('Futures Journal PRO', `Aplikaci se nepodařilo načíst.\n\n${secondError.message}\n\nSoubor: ${indexPath}\n\nProtokol: ${logPath()}`);
      });
    }, 800);
  });
}


const dataRoot = () => path.join(resolveDataDir(), 'journal-data');
function safeJournalId(id) {
  const value = String(id || 'default');
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Neplatný identifikátor deníku.');
  return value;
}
function journalPath(id) { return path.join(dataRoot(), `${safeJournalId(id)}.json`); }
function defaultJournalData() { return { trades: [], settings: [] }; }
function readJournal(id) {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const file = journalPath(id);
  if (!fs.existsSync(file)) return defaultJournalData();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const journal = {
    trades: Array.isArray(parsed.trades) ? parsed.trades : [],
    settings: Array.isArray(parsed.settings) ? parsed.settings : [],
    dayNotes: (parsed.dayNotes && typeof parsed.dayNotes === 'object') ? parsed.dayNotes : {},
    // POZOR: tenhle seznam je whitelist. Cokoli, co v něm není, se při čtení
    // tiše zahodí a následný zápis to smaže – u `dayNotes` to už jednou
    // reálně nastalo. Každý nový top-level klíč sem musí být doplněn.
    schemaVersion: Number(parsed.schemaVersion) || 0,
    // Značka migrace tiků / MFE / MAE (runTickFieldsMigration v rendereru).
    // Dokud tu chyběla, zahodila se při každém čtení a migrace se spouštěla
    // (a celý deník zapisovala) při každém startu.
    tickFieldsVersion: Number(parsed.tickFieldsVersion) || 0,
    // Značka převodu na kontext v3 (runContextV3Migration v rendereru): jeden
    // seznam hladin místo dvou a odebraná pole. Bez ní by se převod spouštěl
    // při každém otevření deníku.
    contextVersion: Number(parsed.contextVersion) || 0
  };
  // Jednorázový přesun starých base64 obrázků do souborů. Proběhne při prvním
  // otevření deníku po aktualizaci a pak už nikdy (podruhé nenajde co
  // převádět). Pořadí je záměrné: obrázky jsou na disku DŘÍV, než se z deníku
  // odstraní jejich base64 podoba, a před přepsáním deníku se ještě udělá
  // záloha – když se cokoli přeruší, původní soubor zůstane nedotčený a
  // migrace se zopakuje při dalším otevření.
  const moved = deflateJournalImages(journal);
  if (moved) {
    backupJournalFile(id, 'pred-presunem-screenshotu');
    writeJournalFile(id, journal);
    logInfo('Přesun screenshotů do souborů', `deník ${safeJournalId(id)}: ${moved} obrázků`);
  }
  // Deník ze starší zálohy může odkazovat na obrázek pod jménem z doby před
  // přejmenováním (4.8.7) – odkaz se přepíše na nové jméno, soubor je týž.
  const remapped = remapRenamedImages(journal);
  if (remapped) {
    backupJournalFile(id, 'pred-prepisem-jmen-obrazku');
    writeJournalFile(id, journal);
    logInfo('Jména obrázků', `deník ${safeJournalId(id)}: ${remapped} odkazů na přejmenované obrázky`);
  }
  return journal;
}
function writeJournalFile(id, data) {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const target = journalPath(id);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, target);
}
function writeJournal(id, data) {
  // Pojistka: i kdyby do zápisu přišel obrázek jako base64 (obnovená starší
  // záloha, ruční import JSONu), do souboru deníku se nedostane – uloží se
  // jako samostatný soubor a v deníku zůstane jen odkaz. Bez toho by se deník
  // mohl kdykoli znovu nafouknout na stovky MB a renderer by se při ukládání
  // obchodu zase začal ukončovat na nedostatek paměti.
  deflateJournalImages(data);
  writeJournalFile(id, data);
  writeAiExportMirror(id, data);
}

// ---------- Úložiště screenshotů (obrázky mimo JSON deníku) ----------
// Screenshoty jsou jediná objemná část deníku: pár stovek obrázků v base64
// udělá ze souboru deníku stovky MB. Takový soubor se při KAŽDÉM uložení
// obchodu celý posílal mezi rendererem a hlavním procesem, celý znovu
// serializoval a celý znovu vykresloval – rendereru na tom došla paměť a
// Electron ho ukončil ("Aplikace se neočekávaně ukončila", v chybovém
// protokolu "Renderer process ended"). Obrázky proto leží jako obyčejné
// soubory a v deníku po nich zůstane jen krátký odkaz.
const IMAGE_SCHEME = 'fjimg';
const IMAGE_REF_PREFIX = `${IMAGE_SCHEME}://store/`;
// Jméno souboru: nově vložený obrázek dostane otisk obsahu (stejný obrázek se
// neuloží dvakrát) a při uložení obchodu nebo dne čitelné jméno podle obchodu,
// např. 2026-10-16_1428_MES_long_1.webp (4.8.7, nameStoredImages /
// image:assignNames). Jméno je jen písmena, číslice, tečka, pomlčka
// a podtržítko, nezačíná tečkou a neobsahuje „..“ – přes něj se tak
// neprotlačí podadresář ani cesta mimo složku obrázků.
const IMAGE_NAME_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.[a-z0-9]{1,5}$/;
const IMAGE_HASH_NAME_RE = /^[a-f0-9]{64}\.[a-z0-9]{1,5}$/;
const IMAGE_CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml'
};
// Složka obrázků: vlastní (Nastavení → Data a zálohy → Složka obrázků,
// imagesDir v backup-settings.json), jinak <data>/journal-data/images. Čte se
// při každém požadavku na obrázek, proto se pamatuje; mění ji jen
// moveImagesDir.
const imagesDirSetting = { loaded: false, dir: null };
function imagesRoot() {
  if (!imagesDirSetting.loaded) {
    // Bez složky dat nejde nastavení přečíst – hodí chybu a nic si nezapamatuje
    // (jinak by si běh natrvalo uložil výchozí složku místo vlastní).
    dataRoot();
    const custom = readSettings().imagesDir;
    imagesDirSetting.dir = typeof custom === 'string' && path.isAbsolute(custom) ? custom : null;
    imagesDirSetting.loaded = true;
  }
  return imagesDirSetting.dir || path.join(dataRoot(), 'images');
}
// Náhledy (šířka 320 px, WebP) – jen mezipaměť pro seznamy; kdykoli jde
// smazat, vytvoří se znovu.
const THUMB_DIR = '_nahledy';
const thumbsRoot = () => path.join(imagesRoot(), THUMB_DIR);
const thumbPath = name => path.join(thumbsRoot(), `${name}.thumb.webp`);

function isImageRef(value) {
  return typeof value === 'string'
    && value.startsWith(IMAGE_REF_PREFIX)
    && IMAGE_NAME_RE.test(value.slice(IMAGE_REF_PREFIX.length));
}
function imageRefName(ref) { return isImageRef(ref) ? ref.slice(IMAGE_REF_PREFIX.length) : null; }
// Přejmenované obrázky (otisk → čitelné jméno) si složka pamatuje
// v _prejmenovani.json. Starší záloha nebo bezpečnostní kopie deníku tak dál
// najde své obrázky i pod původním jménem (imageRefPath, readJournal).
const IMAGE_RENAME_FILE = '_prejmenovani.json';
function readImageRenames() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(imagesRoot(), IMAGE_RENAME_FILE), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}
function writeImageRenames(map) {
  fs.mkdirSync(imagesRoot(), { recursive: true });
  const file = path.join(imagesRoot(), IMAGE_RENAME_FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(map, null, 1), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}
// Cesta se skládá jen ze jména, které prošlo IMAGE_NAME_RE – přes ten se
// neprotlačí ".." ani podadresář, takže odkaz nikdy neukáže mimo složku
// s obrázky, ať přijde odkudkoli. Chybí-li soubor, zkusí se nové jméno
// přejmenovaného obrázku.
function imageRefPath(ref) {
  const name = imageRefName(ref);
  if (!name) return null;
  const file = path.join(imagesRoot(), name);
  if (fs.existsSync(file)) return file;
  const renamed = readImageRenames()[name];
  return renamed && IMAGE_NAME_RE.test(renamed) ? path.join(imagesRoot(), renamed) : file;
}
// Odkaz na náhled (fjimg://thumb/<jméno>) → odkaz na plný obrázek.
function storeRefOf(value) {
  const s = String(value || '');
  return s.startsWith(`${IMAGE_SCHEME}://thumb/`) ? IMAGE_REF_PREFIX + s.slice(`${IMAGE_SCHEME}://thumb/`.length) : s;
}
function imageExtension(mime) {
  const subtype = String(mime || '').split('/')[1] || '';
  const ext = subtype.split('+')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  if (!ext) return 'png';
  return ext === 'jpeg' ? 'jpg' : ext;
}
function storeImageBuffer(buffer, ext) {
  fs.mkdirSync(imagesRoot(), { recursive: true });
  const name = `${crypto.createHash('sha256').update(buffer).digest('hex')}.${ext}`;
  const file = path.join(imagesRoot(), name);
  // Zápis přes dočasný soubor: přerušení uprostřed nenechá na disku půlku
  // obrázku, která by se podle jména tvářila jako platný screenshot.
  if (!fs.existsSync(file)) {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, file);
  }
  return IMAGE_REF_PREFIX + name;
}
function storeImageDataUrl(dataUrl) {
  const parsed = dataUrlToBuffer(dataUrl);
  return parsed ? storeImageBuffer(parsed.buffer, parsed.ext) : null;
}
// Obrázek může přijít jako odkaz (běžný stav) nebo jako base64 (starší záloha,
// import). Když se přečíst nedá, vrací se null a volající to bere jako
// "nedá se zpracovat", nikdy jako "smaž".
function imageToBuffer(sourceValue) {
  const source = storeRefOf(sourceValue);
  if (isImageRef(source)) {
    const file = imageRefPath(source);
    if (!file || !fs.existsSync(file)) return null;
    return { buffer: fs.readFileSync(file), ext: path.extname(file).slice(1).toLowerCase() };
  }
  return dataUrlToBuffer(source);
}
function imageToDataUrl(source) {
  const parsed = imageToBuffer(source);
  if (!parsed) return null;
  const mime = IMAGE_CONTENT_TYPES[parsed.ext] || 'application/octet-stream';
  return `data:${mime};base64,${parsed.buffer.toString('base64')}`;
}
// Projde celou strukturu deníku a převede obrázkové řetězce funkcí "convert".
// Prochází se celý strom, ne jen známá pole "images": obrázky jsou u obchodů,
// u jejich cílů i u denních poznámek a každé další místo by se jinak tiše
// přehlédlo a zůstalo by v JSONu jako base64. Když "convert" vrátí null,
// hodnota se nechá být – neznámý formát se nikdy nezahodí.
function mapImageStrings(value, convert, seen) {
  const visited = seen || new Set();
  if (!value || typeof value !== 'object' || visited.has(value)) return 0;
  visited.add(value);
  let changed = 0;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === 'string') {
      const next = convert(item);
      if (next != null && next !== item) { value[key] = next; changed++; }
    } else if (item && typeof item === 'object') {
      changed += mapImageStrings(item, convert, visited);
    }
  }
  return changed;
}
// base64 v datech deníku -> soubor na disku + odkaz. Vrací počet převodů.
function deflateJournalImages(data) {
  return mapImageStrings(data, value => value.startsWith('data:image/') ? storeImageDataUrl(value) : null);
}
// Opačný směr. Používá se JEN při tvorbě zálohy/exportu, aby výsledný soubor
// byl soběstačný a šel obnovit i na stroji, kde složka s obrázky není.
function inflateJournalImages(data) {
  return mapImageStrings(data, value => isImageRef(value) ? imageToDataUrl(value) : null);
}
// Obsluha adres "fjimg://store/<jméno>" (plný obrázek) a "fjimg://thumb/<jméno>"
// (náhled ze složky _nahledy) – v rendereru stačí <img src="<odkaz>"> a obrázek
// se načte přímo ze souboru, bez base64 a bez IPC. Jméno se může přejmenováním
// uvolnit pro jiný obrázek, proto se nic necachuje natrvalo. Chybějící náhled
// = 404 a renderer si ho vytvoří (thumbMissing).
function registerImageProtocol() {
  try {
    protocol.handle(IMAGE_SCHEME, request => {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!IMAGE_NAME_RE.test(name)) return new Response('', { status: 400 });
      let file;
      try {
        if (url.hostname === 'thumb') file = thumbPath(name);
        else if (url.hostname === 'store') file = imageRefPath(IMAGE_REF_PREFIX + name);
        else return new Response('', { status: 400 });
      } catch (error) {
        // Složka dat chybí – obrázek teď nejde načíst (renderer si náhled nemá tvořit).
        if (error?.code === 'FJ_DATA_DIR_MISSING') return new Response('', { status: 503 });
        throw error;
      }
      if (!file || !fs.existsSync(file)) return new Response('', { status: 404 });
      const ext = url.hostname === 'thumb' ? 'webp' : path.extname(file).slice(1).toLowerCase();
      return new Response(fs.readFileSync(file), {
        headers: {
          'content-type': IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream',
          'cache-control': 'no-cache',
          // Náhled vzniká v rendereru přes canvas; bez CORS by canvas s obrázkem
          // z vlastního protokolu nešel exportovat (tainted canvas).
          'access-control-allow-origin': '*'
        }
      });
    });
  } catch (error) {
    logError('registerImageProtocol', error);
  }
}

// ---------- Čitelná jména obrázků (4.8.7) ----------
// Základ jména podle záznamu: obchod „2026-10-16_1428_MES_long“, setup bez
// vstupu „…_setup“, den „2026-10-16_den“. Soubor pak „<základ>_<n>.<přípona>“.
function imageBaseFor(record) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(record?.date || '')) ? record.date : null;
  if (!date) return null;
  if (record.day) return `${date}_den`;
  const clean = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 20);
  const time = /^(\d{1,2}):(\d{2})/.exec(String(record.entryTime || ''));
  const hhmm = time ? time[1].padStart(2, '0') + time[2] : '0000';
  const instrument = clean(String(record.instrument || '').trim().split(/\s+/)[0]) || 'obchod';
  const side = record.recordType === 'SETUP_ONLY' ? 'setup' : (record.side === 'long' || record.side === 'short' ? record.side : 'obchod');
  return `${date}_${hhmm}_${instrument}_${side}`;
}
function sameFileContent(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}
// Volné jméno pro obrázek `source` se základem `base`: první <base>_<n>.<ext>,
// které neexistuje – nebo už obsahuje přesně tentýž obrázek (pak se použije,
// nic se nekopíruje). `taken` = jména rezervovaná v téže dávce.
function freeImageName(base, ext, source, taken = new Set()) {
  // Číslo je jedinečné napříč příponami: vedle „…_1.png“ nevznikne „…_1.webp“.
  const existing = fs.existsSync(imagesRoot()) ? fs.readdirSync(imagesRoot()).filter(n => n.startsWith(`${base}_`)) : [];
  const stems = new Set([...existing, ...taken].map(n => n.replace(/\.[^.]+$/, '')));
  for (let n = 1; n < 1000; n++) {
    const name = `${base}_${n}.${ext}`;
    if (taken.has(name)) continue;
    const file = path.join(imagesRoot(), name);
    if (fs.existsSync(file) && source && sameFileContent(file, source)) return name;
    if (!stems.has(`${base}_${n}`)) return name;
  }
  return null;
}
// Přejmenování / kopie souboru i s jeho náhledem. Kopie, když na staré jméno
// odkazuje ještě jiný záznam.
function moveImageFile(oldName, newName, keepOld) {
  const from = path.join(imagesRoot(), oldName), to = path.join(imagesRoot(), newName);
  if (!fs.existsSync(to)) {
    fs.copyFileSync(from, `${to}.tmp`);
    fs.renameSync(`${to}.tmp`, to);
  }
  if (!sameFileContent(from, to)) throw new Error(`Kopie obrázku ${newName} nesedí s originálem.`);
  try {
    if (fs.existsSync(thumbPath(oldName)) && !fs.existsSync(thumbPath(newName))) fs.copyFileSync(thumbPath(oldName), thumbPath(newName));
  } catch (error) { logError('moveImageFile – náhled', error); }
  if (!keepOld) {
    fs.rmSync(from, { force: true });
    fs.rmSync(thumbPath(oldName), { force: true });
  }
}
// Všechny záznamy se screenshoty v deníku: [{ key, record, base }]. Klíč
// záznamu: id obchodu, nebo „day:<datum>“.
function journalImageOwners(journal) {
  const out = [];
  for (const t of Array.isArray(journal?.trades) ? journal.trades : []) {
    if (t && typeof t === 'object') out.push({ key: String(t.id || ''), record: t, base: imageBaseFor(t) });
  }
  const notes = journal?.dayNotes && typeof journal.dayNotes === 'object' ? journal.dayNotes : {};
  for (const [date, note] of Object.entries(notes)) {
    if (note && typeof note === 'object') out.push({ key: `day:${date}`, record: note, base: imageBaseFor({ date, day: true }) });
  }
  return out;
}
function journalFiles() {
  if (!fs.existsSync(dataRoot())) return [];
  return fs.readdirSync(dataRoot()).filter(f => f.endsWith('.json') && /^[a-zA-Z0-9_-]+\.json$/.test(f));
}
// Kolikrát se na jméno odkazuje mimo záznam `owner` ({ journalId, key }).
// Nečitelný deník = „nevím" → bere se jako odkaz (raději kopie než ztráta).
function imageUsedElsewhere(name, owner) {
  for (const file of journalFiles()) {
    const journalId = file.slice(0, -5);
    let journal;
    try { journal = JSON.parse(fs.readFileSync(path.join(dataRoot(), file), 'utf8')); }
    catch { return true; }
    for (const o of journalImageOwners(journal)) {
      if (journalId === owner?.journalId && o.key === owner?.key) continue;
      let used = false;
      mapImageStrings(o.record, v => { if (imageRefName(storeRefOf(v)) === name) used = true; return null; });
      if (used) return true;
    }
  }
  return false;
}
// Při uložení obchodu / dne: obrázky záznamu dostanou čitelná jména podle
// jeho data, času, instrumentu a směru. Obrázek, který už jméno se stejným
// základem má, se nechá. Vrací { staré: nové } – volající přepíše odkazy
// v záznamu ještě před zápisem deníku.
function assignImageNames(refs, record, owner) {
  const base = imageBaseFor(record);
  const mapping = {};
  if (!base) return mapping;
  const renames = readImageRenames();
  const taken = new Set();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const name = imageRefName(storeRefOf(ref));
    if (!name || mapping[ref]) continue;
    const file = path.join(imagesRoot(), name);
    if (!fs.existsSync(file)) continue;
    if (name.startsWith(`${base}_`)) { taken.add(name); continue; }
    const ext = path.extname(name).slice(1).toLowerCase();
    const target = freeImageName(base, ext, file, taken);
    if (!target || target === name) continue;
    taken.add(target);
    moveImageFile(name, target, imageUsedElsewhere(name, owner));
    renames[name] = target;
    mapping[ref] = IMAGE_REF_PREFIX + target;
  }
  if (Object.keys(mapping).length) writeImageRenames(renames);
  return mapping;
}
// Odkazy podle tabulky přejmenování (deník ze starší zálohy). Vrací počet změn.
function remapRenamedImages(data) {
  const renames = readImageRenames();
  if (!Object.keys(renames).length) return 0;
  return mapImageStrings(data, value => {
    const name = imageRefName(value);
    if (!name || fs.existsSync(path.join(imagesRoot(), name))) return null;
    const next = renames[name];
    return next && IMAGE_NAME_RE.test(next) ? IMAGE_REF_PREFIX + next : null;
  });
}
// Jednorázově (a znovu po obnově zálohy): obrázky s otiskem místo jména dostanou
// čitelná jména ve VŠECH denících najednou – stejný soubor může patřit víc
// záznamům. Pořadí: přečíst všechny deníky (nečitelný = nic se nedělá) →
// záloha každého dotčeného deníku → kopie souborů pod nová jména → přepsání
// odkazů v denících → teprve když se zapsaly všechny, smazání starých souborů.
// Přerušení kdekoli nechá platná data; příští start dokončí zbytek.
function nameStoredImages() {
  const files = journalFiles();
  const journals = [];
  for (const file of files) {
    try { journals.push({ id: file.slice(0, -5), data: JSON.parse(fs.readFileSync(path.join(dataRoot(), file), 'utf8')) }); }
    catch (error) { logError(`Pojmenování obrázků: deník ${file} nejde přečíst, nic se nemění`, error); return { ok: false, renamed: 0 }; }
  }
  const mapping = {};
  const taken = new Set();
  for (const j of journals) {
    for (const o of journalImageOwners(j.data)) {
      if (!o.base) continue;
      mapImageStrings(o.record, value => {
        const name = imageRefName(value);
        if (!name || !IMAGE_HASH_NAME_RE.test(name) || mapping[name]) return null;
        const file = path.join(imagesRoot(), name);
        if (!fs.existsSync(file)) return null;
        const target = freeImageName(o.base, path.extname(name).slice(1).toLowerCase(), file, taken);
        if (target) { mapping[name] = target; taken.add(target); }
        return null;
      });
    }
  }
  if (!Object.keys(mapping).length) return { ok: true, renamed: 0 };
  // Dotčený je každý deník, který některé z přejmenovaných jmen obsahuje
  // (i u záznamu bez data – odkaz se přepíše všude).
  const touched = new Set(journals.filter(j => {
    let hit = false;
    mapImageStrings(j.data, value => { const name = imageRefName(value); if (name && mapping[name]) hit = true; return null; });
    return hit;
  }).map(j => j.id));
  for (const id of touched) backupJournalFile(id, 'pred-pojmenovanim-obrazku');
  for (const [oldName, newName] of Object.entries(mapping)) moveImageFile(oldName, newName, true);
  for (const j of journals) {
    if (!touched.has(j.id)) continue;
    const changed = mapImageStrings(j.data, value => {
      const name = imageRefName(value);
      return name && mapping[name] ? IMAGE_REF_PREFIX + mapping[name] : null;
    });
    if (changed) writeJournalFile(j.id, j.data);
  }
  writeImageRenames({ ...readImageRenames(), ...mapping });
  for (const oldName of Object.keys(mapping)) {
    fs.rmSync(path.join(imagesRoot(), oldName), { force: true });
    fs.rmSync(thumbPath(oldName), { force: true });
  }
  logInfo('Pojmenování obrázků', `${Object.keys(mapping).length} obrázků v ${touched.size} denících`);
  return { ok: true, renamed: Object.keys(mapping).length };
}

// ---------- "Odlehčený" export bez screenshotů – pro čtení jinými nástroji ----------
// Screenshoty (base64 obrázky) jsou to, co dělá surová data deníku objemná.
// Tahle kopie se udržuje automaticky při KAŽDÉM uložení obchodu a obsahuje
// úplně všechna textová pole (komentář, denní plán, setup/scénář, psycho-
// logický checklist…), jen bez obrázků – bezpečně malá i pro nástroje s
// omezenou velikostí dat (např. jiný Claude projekt hodnotící obchody).
const aiExportRoot = () => path.join(resolveDataDir(), 'ai-export');
function aiExportPath(id) { return path.join(aiExportRoot(), `${safeJournalId(id)}.json`); }
function stripImages(trade) {
  const { images, legs, ...rest } = trade || {};
  return {
    ...rest,
    imageCount: Array.isArray(images) ? images.length : 0,
    legs: Array.isArray(legs) ? legs.map(({ images: legImages, ...legRest }) => legRest) : undefined
  };
}
function stripDayNote(note) {
  const { images, ...rest } = note || {};
  return { ...rest, imageCount: Array.isArray(images) ? images.length : 0 };
}
// Režim deníku (LIVE / BACKTEST) z manifestu index.json – profil deníku žije
// v rendereru, do main procesu se dostane jen přes manifest. Bez něj živý.
function aiExportModeOf(id) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(aiExportRoot(), 'index.json'), 'utf8'));
    const entry = (Array.isArray(manifest?.journals) ? manifest.journals : []).find(j => j?.id === id);
    return entry?.mode === 'BACKTEST' ? 'BACKTEST' : 'LIVE';
  } catch {
    return 'LIVE';
  }
}
// Dopočty (A3) ke každému obchodu – v samostatném objektu `derived`, uložené
// hodnoty obchodu zůstávají, jak jsou. Pořadí v dni nad celým deníkem.
function aiDerivedFields(rawTrades, main, mode) {
  const order = FJContext.dayOrder(rawTrades);
  const templates = Array.isArray(main?.templates) ? main.templates : [];
  // Lhůta „doplněno zpětně“ je nastavení deníku – export počítá stejně jako aplikace.
  return t => FJContext.derivedFields(t, { tickSize: FJPoints.tickSizeFor(t?.instrument, templates), config: main?.taxonomy || {}, dayOrder: order, mode, gradeRetroGraceMin: main?.gradeRetroGraceMinutes });
}
function writeAiExportMirror(id, data) {
  try {
    fs.mkdirSync(aiExportRoot(), { recursive: true });
    const rawTrades = Array.isArray(data?.trades) ? data.trades : [];
    const mainSettings = (Array.isArray(data?.settings) ? data.settings : []).find(s => s?.key === 'main')?.value || {};
    const derivedOf = aiDerivedFields(rawTrades, mainSettings, aiExportModeOf(id));
    // Kontext v3: export nese vždy nový tvar (nearLevels, bez odebraných
    // polí) – i u deníku, který od aktualizace ještě nebyl otevřen a na disku
    // má starý zápis. Převod je tentýž jako při migraci deníku.
    const exportTrade = t => FJContext.tradeToV3(stripImages(t));
    // Dokup: vstupy pozice dopočítané z nohou (FJPoints.entriesOf). Jen
    // u obchodu, který víc vstupů opravdu má.
    const entriesOf = t => { const entries = FJPoints.entriesOf(t); return entries.length > 1 ? { entries } : {}; };
    const trades = rawTrades.map(t => ({ ...exportTrade(t), derived: { ...derivedOf(t), ...entriesOf(t) } }));
    const dayNotes = {};
    for (const date in (data?.dayNotes || {})) dayNotes[date] = stripDayNote(data.dayNotes[date]);
    // Úprava číselníků deníku (vlastní volby, přejmenování) – bez ní by
    // nástroj čtoucí export neznal klíče typu CUSTOM_… a jejich popisky.
    // Stejně jako obchody jde ven vždy v novém tvaru (kontext v3): u deníku,
    // který ještě nebyl otevřen, by jinak export nesl kolonky SR proti targetu
    // / S/L vedle obchodů s „Hladinami v blízkosti".
    const taxonomy = FJContext.migrateConfigV3(mainSettings.taxonomy || {});
    const temp = `${aiExportPath(id)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ journalId: id, updatedAt: new Date().toISOString(), taxonomy, trades, dayNotes }, null, 2), 'utf8');
    fs.renameSync(temp, aiExportPath(id));
  } catch (error) {
    logError('writeAiExportMirror', error);
  }
}
// Položka manifestu: id, název a režim deníku (kontext v2) – Lab i export
// deníku z něj poznají backtest.
function aiManifestEntry(j) {
  return { id: j?.id, name: j?.name, mode: j?.backtest === true ? 'BACKTEST' : 'LIVE' };
}
ipcMain.handle('data:getAiExportInfo', async () => {
  try { return { ok: true, path: aiExportRoot() }; }
  catch (error) { return { ok: false, error: error.message }; }
});
// Ruční přegenerování pro všechny deníky – užitečné hlavně hned po zapnutí
// téhle funkce, ať se odlehčená kopie vytvoří i pro obchody uložené dřív.
ipcMain.handle('data:regenerateAiExports', async (_event, journals) => {
  try {
    fs.mkdirSync(aiExportRoot(), { recursive: true });
    const list = Array.isArray(journals) ? journals : [];
    // Manifest nejdřív – export deníku z něj bere režim (gradeRetro).
    const manifest = { updatedAt: new Date().toISOString(), journals: list.map(aiManifestEntry) };
    fs.writeFileSync(path.join(aiExportRoot(), 'index.json'), JSON.stringify(manifest, null, 2), 'utf8');
    for (const j of list) {
      if (!j?.id) continue;
      writeAiExportMirror(j.id, readJournal(j.id));
    }
    return { ok: true, count: list.length, path: aiExportRoot() };
  } catch (error) {
    logError('data:regenerateAiExports', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('data:writeAiExportManifest', async (_event, journals) => {
  try {
    fs.mkdirSync(aiExportRoot(), { recursive: true });
    const list = Array.isArray(journals) ? journals : [];
    const manifest = { updatedAt: new Date().toISOString(), journals: list.map(aiManifestEntry) };
    fs.writeFileSync(path.join(aiExportRoot(), 'index.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { ok: true };
  } catch (error) {
    logError('data:writeAiExportManifest', error);
    return { ok: false, error: error.message };
  }
});

// Tichá bezpečnostní kopie JEDNOHO souboru deníku – používá se před migrací
// schématu. Dialog se záměrně neotevírá: migrace běží při startu a vyskakovací
// okno by bralo focus. Pořadí u volajícího je vždy záloha → zápis, nikdy
// naopak (v minulosti move-then-delete způsobil reálnou ztrátu dat).
function backupJournalFile(journalId, reason) {
  const source = journalPath(journalId);
  if (!fs.existsSync(source)) return { ok: true, skipped: true };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(app.getPath('userData'), 'safety-backups', `${String(reason || 'migrace').replace(/[^a-zA-Z0-9_-]/g, '-')}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${safeJournalId(journalId)}.json`);
  fs.copyFileSync(source, target);
  return { ok: true, path: target };
}
ipcMain.handle('storage:backupJournal', async (_event, journalId, reason) => {
  try {
    return backupJournalFile(journalId, reason);
  } catch (error) {
    logError('storage:backupJournal', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('storage:read', async (_event, journalId) => {
  try { return { ok: true, data: readJournal(journalId) }; }
  catch (error) { logError('Storage read', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('storage:write', async (_event, journalId, data) => {
  try { writeJournal(journalId, data || defaultJournalData()); return { ok: true }; }
  catch (error) { logError('Storage write', error); return { ok: false, error: error.message }; }
});
// Jména obrázků, na které deník (soubor v journal-data) odkazuje.
function journalImageNames(file) {
  const names = new Set();
  mapImageStrings(JSON.parse(fs.readFileSync(file, 'utf8')), value => {
    const name = imageRefName(value);
    if (name) names.add(name);
    return null;
  });
  return names;
}
// Úplné smazání deníku: soubor deníku, jeho odlehčený AI export a screenshoty,
// které nepoužívá žádný jiný deník. Screenshoty jsou společné (jméno = otisk
// obsahu), takže stejný obrázek může patřit i jinému deníku – ten se nechá.
// Když se některý zbývající deník nedá přečíst, nesmaže se ŽÁDNÝ obrázek:
// nevíme, co používá, a ztracený screenshot už nikdo nevrátí.
// Bezpečnostní kopie v safety-backups se nemažou.
function deleteJournalCompletely(journalId) {
  const file = journalPath(journalId);
  let own = new Set();
  if (fs.existsSync(file)) {
    try { own = journalImageNames(file); }
    catch (error) { logError('deleteJournal: čtení obrázků deníku', error); }
  }
  fs.rmSync(file, { force: true });
  fs.rmSync(aiExportPath(journalId), { force: true });
  let removedImages = 0;
  if (own.size && fs.existsSync(dataRoot())) {
    const used = new Set();
    for (const entry of fs.readdirSync(dataRoot())) {
      if (!entry.endsWith('.json')) continue;
      try { for (const name of journalImageNames(path.join(dataRoot(), entry))) used.add(name); }
      catch (error) {
        logError(`deleteJournal: deník ${entry} nejde přečíst, obrázky se nemažou`, error);
        return { ok: true, removedImages: 0, keptImages: own.size };
      }
    }
    for (const name of own) {
      if (used.has(name)) continue;
      fs.rmSync(path.join(imagesRoot(), name), { force: true });
      fs.rmSync(thumbPath(name), { force: true });
      removedImages++;
    }
  }
  return { ok: true, removedImages, keptImages: own.size - removedImages };
}
ipcMain.handle('storage:deleteJournal', async (_event, journalId) => {
  try { return deleteJournalCompletely(journalId); }
  catch (error) { logError('Storage delete journal', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('storage:reset', async () => {
  try { fs.rmSync(dataRoot(), { recursive: true, force: true }); return { ok: true }; }
  catch (error) { logError('Storage reset', error); return { ok: false, error: error.message }; }
});

ipcMain.handle('backup:getPath', async () => readSettings().backupPath || null);
// Umožní znovu zvolit umístění "Aktualizovat zálohu na SSD" – jinak si appka
// napořád pamatuje jen tu VŮBEC první zvolenou cestu bez možnosti změny.
ipcMain.handle('backup:changePath', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Vyber nové umístění aktuální zálohy',
      defaultPath: 'FuturesJournal_AKTUALNI_ZALOHA.json',
      filters: [{ name: 'Záloha Futures Journal', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    if (isInsideInstallDir(result.filePath)) return { ok: false, error: INSTALL_DIR_ERROR };
    writeSettings({ ...readSettings(), backupPath: result.filePath });
    return { ok: true, path: result.filePath };
  } catch (error) {
    logError('backup:changePath', error);
    return { ok: false, error: error.message };
  }
});
// "Stáhnout zálohu JSON" – na rozdíl od "Aktualizovat na SSD" si nic
// nepamatuje, pokaždé se ukáže skutečný dialog Uložit jako.
async function exportFileOnce(content, suggestedName) {
  const name = suggestedName || 'futures-journal-export.json';
  const ext = path.extname(name).replace('.', '') || 'json';
  const extLabels = { json: 'JSON soubor', csv: 'CSV soubor', txt: 'Textový soubor' };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Uložit soubor',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: extLabels[ext] || `Soubor .${ext}`, extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { ok: true, path: result.filePath };
}
ipcMain.handle('backup:exportOnce', async (_event, content, suggestedName) => {
  try {
    return await exportFileOnce(content, suggestedName);
  } catch (error) {
    logError('backup:exportOnce', error);
    return { ok: false, error: error.message };
  }
});

// ---------- Zálohy deníků ----------
// Záloha se skládá TADY, v hlavním procesu, a ne v rendereru: obsahuje i
// screenshoty, takže jde o desítky až stovky MB. Kdyby si ten text renderer
// sestavoval sám a posílal ho přes IPC, byl by to přesně ten druh obřího
// přenosu, kvůli kterému se aplikace při ukládání obchodu ukončovala.
// Obrázky se do zálohy vkládají jako base64, aby byl soubor soběstačný a šel
// obnovit i na stroji, kde složka s obrázky neexistuje.
// Obrázky jen na přání (Nastavení → Data a zálohy → „Zahrnout obrázky do
// zálohy“, výchozí vypnuto): bez nich záloha nese jen odkazy a obrázky se
// zálohují se svou složkou.
const backupIncludesImages = () => readSettings().backupIncludeImages === true;
function buildJournalsBackup(meta, images) {
  const profiles = Array.isArray(meta?.profiles) ? meta.profiles : [];
  const includeImages = backupIncludesImages();
  const journals = profiles.map(profile => {
    const data = readJournal(profile.id);
    if (includeImages) inflateJournalImages(data);
    // dayNotes se dřív do zálohy nedávaly vůbec, takže obnova ze zálohy tiše
    // smazala denní komentáře, náhledy a poznámky. Patří sem stejně jako obchody.
    return { profile, trades: data.trades, settings: data.settings, dayNotes: data.dayNotes };
  });
  return JSON.stringify({
    app: 'Futures Journal',
    version: 2,
    imagesIncluded: includeImages,
    // Druhá část zálohy (zrcadlo obrázků) – obnova podle toho ví, kde hledat.
    imagesBackup: images ? { dir: images.dir, count: images.total } : null,
    exportedAt: new Date().toISOString(),
    activeJournalId: meta?.activeJournalId || profiles[0]?.id || '',
    profiles,
    journals
  });
}
function restoreJournalsBackup(content, sourcePath) {
  const data = JSON.parse(content);
  if (!data || !Array.isArray(data.profiles) || !Array.isArray(data.journals)) throw new Error('Neplatná záloha.');
  for (const entry of data.journals) {
    const id = entry?.profile?.id;
    if (!id) continue;
    // writeJournal si base64 obrázky ze zálohy sám uloží jako soubory.
    writeJournal(id, {
      trades: Array.isArray(entry.trades) ? entry.trades : [],
      settings: Array.isArray(entry.settings) ? entry.settings : [],
      dayNotes: (entry.dayNotes && typeof entry.dayNotes === 'object') ? entry.dayNotes : {}
    });
  }
  // Obrázky ze zálohy s base64 dostanou čitelná jména; odkazy na soubory, které
  // ve složce obrázků nejsou (záloha bez obrázků z jiného počítače), se jen
  // spočítají – nic se nemaže.
  try { nameStoredImages(); } catch (error) { logError('Obnova zálohy – jména obrázků', error); }
  // Druhá část zálohy: chybějící obrázky se doplní ze zrcadla – složka uvedená
  // v záloze, jinak <soubor zálohy>_obrazky vedle zvoleného souboru.
  let restoredImages = 0;
  const mirror = [data.imagesBackup?.dir, defaultBackupImagesDir(sourcePath), backupImagesDirPath()]
    .find(dir => typeof dir === 'string' && path.isAbsolute(dir) && fs.existsSync(dir));
  if (mirror) {
    try { restoredImages = restoreImagesFromMirror(mirror).restored; }
    catch (error) { logError('Obnova zálohy – obrázky ze zálohy', error); }
  }
  let missingImages = 0;
  for (const entry of data.journals) {
    const id = entry?.profile?.id;
    if (!id) continue;
    try {
      mapImageStrings(readJournal(id), value => { const file = isImageRef(value) ? imageRefPath(value) : null; if (file && !fs.existsSync(file)) missingImages++; return null; });
    } catch (error) { logError('Obnova zálohy – kontrola obrázků', error); }
  }
  return { activeJournalId: data.activeJournalId || data.profiles[0]?.id || '', profiles: data.profiles, missingImages, restoredImages };
}
// ---------- Záloha ve dvou částech: obchody (JSON) + obrázky (složka) ----------
// 4.8.9: po aktualizaci 4.8.8 se ztratily všechny screenshoty – data ležela ve
// složce programu, instalátor ji smazal, deníky se vrátily ze zálohy, ale
// záloha nesla jen odkazy a obrázky nebyly zálohované nikde. „Aktualizovat
// zálohu" proto vedle JSONu udržuje zrcadlo obrázků (výchozí složka
// <záloha>_obrazky, jde změnit nebo vypnout). Zrcadlo drží přesně obrázky, na
// které některý deník odkazuje (obrázky smazaných obchodů se z něj uklidí),
// ale odkazovaný obrázek, který chybí ve zdroji, v něm zůstane – i záloha
// spuštěná až po ztrátě tak o zálohu obrázků nepřijde.
const BACKUP_MANIFEST_FILE = '_manifest.json';
const BACKUP_KEEP_PREVIOUS = 3;
const backupMirrorsImages = () => readSettings().backupImagesMirror !== false;
function defaultBackupImagesDir(backupPath) {
  if (!backupPath) return null;
  const ext = path.extname(backupPath);
  return `${ext ? backupPath.slice(0, -ext.length) : backupPath}_obrazky`;
}
function backupImagesDirPath(backupPath = readSettings().backupPath) {
  const custom = readSettings().backupImagesDir;
  return typeof custom === 'string' && path.isAbsolute(custom) ? custom : defaultBackupImagesDir(backupPath);
}
// Jména obrázků, na které odkazuje některý deník v datové složce →
// { jméno: [deníky] }. Nečitelný deník = výjimka: nevíme, co používá, a ze
// zrcadla se pak nesmí nic smazat.
function referencedImageNames() {
  const refs = {};
  for (const file of journalFiles()) {
    const id = file.slice(0, -5);
    let journal;
    try { journal = JSON.parse(fs.readFileSync(path.join(dataRoot(), file), 'utf8')); }
    catch (error) { throw new Error(`Deník ${file} nejde přečíst – záloha obrázků se neprovedla, nic se nesmazalo (${error.message}).`); }
    mapImageStrings(journal, value => {
      const name = imageRefName(storeRefOf(value));
      if (name) (refs[name] ||= []).includes(id) || refs[name].push(id);
      return null;
    });
  }
  return refs;
}
function readBackupManifest(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, BACKUP_MANIFEST_FILE), 'utf8'));
    return data && typeof data.files === 'object' ? data : { files: {} };
  } catch { return { files: {} }; }
}
function fileSha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function copyFileChecked(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, `${dest}.tmp`);
  if (fs.statSync(`${dest}.tmp`).size !== fs.statSync(src).size) {
    fs.rmSync(`${dest}.tmp`, { force: true });
    throw new Error(`Kopie ${path.basename(dest)} nesedí s originálem.`);
  }
  fs.renameSync(`${dest}.tmp`, dest);
}
// Pořadí: 1) zkopírovat všechny nové / změněné obrázky, 2) teprve když se
// zkopírovalo vše, uklidit soubory, na které už nic neodkazuje, 3) manifest.
// Selhání v kroku 1 nic nesmaže a výjimka zastaví i zápis JSONu zálohy.
function mirrorImagesToBackup(dir) {
  if (isInsideInstallDir(dir)) throw new Error(INSTALL_DIR_ERROR);
  const refs = referencedImageNames();
  fs.mkdirSync(dir, { recursive: true });
  const previous = readBackupManifest(dir).files;
  const files = {};
  let copied = 0, missingInSource = 0;
  for (const [name, journals] of Object.entries(refs)) {
    const src = imageRefPath(IMAGE_REF_PREFIX + name);
    const dest = path.join(dir, name);
    const old = previous[name];
    if (!src || !fs.existsSync(src)) {
      if (fs.existsSync(dest)) files[name] = { ...(old || { size: fs.statSync(dest).size }), journals };
      missingInSource++;
      continue;
    }
    const stat = fs.statSync(src);
    const unchanged = fs.existsSync(dest) && old && old.size === stat.size && old.mtimeMs === stat.mtimeMs && fs.statSync(dest).size === stat.size;
    if (unchanged) { files[name] = { ...old, journals }; continue; }
    const sha256 = fileSha256(src);
    if (!(fs.existsSync(dest) && fs.statSync(dest).size === stat.size && fileSha256(dest) === sha256)) {
      copyFileChecked(src, dest);
      copied++;
    }
    files[name] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256, journals };
  }
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === BACKUP_MANIFEST_FILE || entry.name === IMAGE_RENAME_FILE || files[entry.name]) continue;
    if (refs[entry.name]) continue;
    fs.rmSync(path.join(dir, entry.name), { force: true });
    removed++;
  }
  const renames = path.join(imagesRoot(), IMAGE_RENAME_FILE);
  if (fs.existsSync(renames)) copyFileChecked(renames, path.join(dir, IMAGE_RENAME_FILE));
  const manifest = { app: 'Futures Journal', updatedAt: new Date().toISOString(), imagesDir: imagesRoot(), count: Object.keys(files).length, files };
  fs.writeFileSync(path.join(dir, `${BACKUP_MANIFEST_FILE}.tmp`), JSON.stringify(manifest, null, 1), 'utf8');
  fs.renameSync(path.join(dir, `${BACKUP_MANIFEST_FILE}.tmp`), path.join(dir, BACKUP_MANIFEST_FILE));
  return { dir, copied, removed, total: Object.keys(files).length, referenced: Object.keys(refs).length, missingInSource };
}
// Odkazované obrázky, které ve složce obrázků chybí, se doplní ze zrcadla.
// Nic se nepřepisuje, jen doplňuje.
function restoreImagesFromMirror(dir) {
  const refs = referencedImageNames();
  let restored = 0, missing = 0;
  for (const name of Object.keys(refs)) {
    const target = imageRefPath(IMAGE_REF_PREFIX + name);
    if (target && fs.existsSync(target)) continue;
    const src = dir ? path.join(dir, name) : null;
    if (src && fs.existsSync(src)) { copyFileChecked(src, path.join(imagesRoot(), name)); restored++; }
    else missing++;
  }
  if (restored) logInfo('Obrázky doplněné ze zálohy', `${restored} souborů z ${dir}`);
  return { restored, missing };
}
// Kontrola integrity pro Nastavení: kolik odkazů vede na chybějící soubor
// a kolik z nich jde doplnit ze zrcadla.
function imageIntegrityReport() {
  const refs = referencedImageNames();
  const mirror = backupImagesDirPath();
  const missing = Object.keys(refs).filter(name => { const f = imageRefPath(IMAGE_REF_PREFIX + name); return !f || !fs.existsSync(f); });
  const recoverable = mirror ? missing.filter(name => fs.existsSync(path.join(mirror, name))).length : 0;
  return { refs: Object.keys(refs).length, missing: missing.length, sample: missing.slice(0, 20), recoverable, mirrorDir: mirror };
}
const countBackupTrades = backup => (Array.isArray(backup?.journals) ? backup.journals : []).reduce((n, j) => n + (Array.isArray(j?.trades) ? j.trades.length : 0), 0);
// Předchozí verze zálohy se nechá vedle jako …_predchozi-1..3.json – jen když
// se obsah deníků opravdu změnil, aby opakované klikání nevytlačilo starší
// dobrou zálohu (třeba tu z doby před ztrátou dat).
function rotatePreviousBackup(backupPath, nextJournals) {
  if (!fs.existsSync(backupPath)) return { rotated: false, tradesBefore: null };
  let old = null;
  try { old = JSON.parse(fs.readFileSync(backupPath, 'utf8')); } catch {}
  const tradesBefore = old ? countBackupTrades(old) : null;
  if (old && JSON.stringify(old.journals) === JSON.stringify(nextJournals)) return { rotated: false, tradesBefore };
  const ext = path.extname(backupPath) || '.json';
  const stem = backupPath.slice(0, backupPath.length - path.extname(backupPath).length);
  const nth = n => `${stem}_predchozi-${n}${ext}`;
  fs.rmSync(nth(BACKUP_KEEP_PREVIOUS), { force: true });
  for (let n = BACKUP_KEEP_PREVIOUS - 1; n >= 1; n--) if (fs.existsSync(nth(n))) fs.renameSync(nth(n), nth(n + 1));
  fs.copyFileSync(backupPath, nth(1));
  return { rotated: true, tradesBefore };
}
// Celá záloha: obrázky → JSON (JSON nikdy neodkazuje na obrázek, který
// v zrcadle není), JSON atomicky přes .tmp.
function saveJournalsBackupTo(backupPath, meta) {
  if (isInsideInstallDir(backupPath)) throw new Error(INSTALL_DIR_ERROR);
  const images = backupMirrorsImages() ? mirrorImagesToBackup(backupImagesDirPath(backupPath)) : null;
  const content = buildJournalsBackup(meta, images);
  const next = JSON.parse(content);
  const { rotated, tradesBefore } = rotatePreviousBackup(backupPath, next.journals);
  fs.writeFileSync(`${backupPath}.tmp`, content, 'utf8');
  fs.renameSync(`${backupPath}.tmp`, backupPath);
  return { ok: true, path: backupPath, images, rotated, tradesBefore, tradesAfter: countBackupTrades(next) };
}
function backupImagesMirrorInfo() {
  const backupPath = readSettings().backupPath || null;
  const dir = backupImagesDirPath(backupPath);
  const manifest = dir ? readBackupManifest(dir) : { files: {} };
  return { enabled: backupMirrorsImages(), dir, isDefault: !readSettings().backupImagesDir, count: Object.keys(manifest.files).length, updatedAt: manifest.updatedAt || null };
}
ipcMain.handle('backup:getImagesMirror', async () => {
  try { return { ok: true, ...backupImagesMirrorInfo() }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('backup:setImagesMirror', async (_event, value) => {
  writeSettings({ ...readSettings(), backupImagesMirror: value === true });
  return { ok: true, ...backupImagesMirrorInfo() };
});
ipcMain.handle('backup:chooseImagesDir', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Vyber složku pro zálohu obrázků', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    if (isInsideInstallDir(result.filePaths[0])) return { ok: false, error: INSTALL_DIR_ERROR };
    if (path.resolve(result.filePaths[0]) === path.resolve(imagesRoot())) return { ok: false, error: 'Záloha obrázků nesmí být přímo ve složce obrázků.' };
    writeSettings({ ...readSettings(), backupImagesDir: result.filePaths[0] });
    return { ok: true, ...backupImagesMirrorInfo() };
  } catch (error) { logError('backup:chooseImagesDir', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('backup:resetImagesDir', async () => {
  const next = readSettings();
  delete next.backupImagesDir;
  writeSettings(next);
  return { ok: true, ...backupImagesMirrorInfo() };
});
ipcMain.handle('images:integrity', async () => {
  try { return { ok: true, ...imageIntegrityReport() }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('images:restoreFromBackup', async () => {
  try { return { ok: true, ...restoreImagesFromMirror(backupImagesDirPath()), ...imageIntegrityReport() }; }
  catch (error) { logError('images:restoreFromBackup', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('backup:saveJournals', async (_event, meta) => {
  try {
    let { backupPath } = readSettings();
    if (!backupPath) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Vyber umístění aktuální zálohy',
        defaultPath: 'FuturesJournal_AKTUALNI_ZALOHA.json',
        filters: [{ name: 'Záloha Futures Journal', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      if (isInsideInstallDir(result.filePath)) return { ok: false, error: INSTALL_DIR_ERROR };
      backupPath = result.filePath;
      writeSettings({ ...readSettings(), backupPath });
    }
    return saveJournalsBackupTo(backupPath, meta);
  } catch (error) {
    logError('backup:saveJournals', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('backup:restoreJournals', async () => {
  try {
    let { backupPath } = readSettings();
    if (!backupPath || !fs.existsSync(backupPath)) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Vyber zálohu k obnovení', properties: ['openFile'],
        filters: [{ name: 'Záloha Futures Journal', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      backupPath = result.filePaths[0];
      writeSettings({ ...readSettings(), backupPath });
    }
    const restored = restoreJournalsBackup(fs.readFileSync(backupPath, 'utf8'), backupPath);
    return { ok: true, path: backupPath, ...restored };
  } catch (error) {
    logError('backup:restoreJournals', error);
    return { ok: false, error: error.message };
  }
});
// "Stáhnout zálohu JSON" u jednoho deníku – stejný tvar { settings, trades },
// jaký umí načíst tlačítko "Nahrát zálohu JSON".
ipcMain.handle('backup:exportJournalOnce', async (_event, journalId, suggestedName) => {
  try {
    const data = readJournal(journalId);
    if (backupIncludesImages()) inflateJournalImages(data);
    const main = (data.settings || []).find(s => s?.key === 'main')?.value || {};
    return await exportFileOnce(JSON.stringify({ settings: main, trades: data.trades, dayNotes: data.dayNotes }, null, 2), suggestedName);
  } catch (error) {
    logError('backup:exportJournalOnce', error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('app:factoryReset', async () => {
  try {
    const userDataPath = app.getPath('userData');
    const dataDir = resolveDataDir();
    // Vlastní obchody/nastavení/log mažeme z AKTUÁLNÍHO umístění dat (mohlo
    // být přesunuté mimo C:), zatímco vnitřní cache Chromia/Electronu
    // (IndexedDB, Local Storage…) zůstává vždy v defaultní userData složce.
    const dataEntries = ['journal-data', 'trade-capture', 'backup-settings.json', 'futures-journal-error.log', 'news-calendar.json'];
    for (const name of dataEntries) {
      try { fs.rmSync(path.join(dataDir, name), { recursive: true, force: true }); } catch {}
    }
    const cacheEntries = [
      'IndexedDB', 'Local Storage', 'Session Storage', 'databases', 'Cache',
      'Code Cache', 'GPUCache', 'DawnCache', 'Network', 'Preferences',
      'Shared Dictionary', 'WebStorage', 'data-location.json'
    ];
    for (const name of cacheEntries) {
      try { fs.rmSync(path.join(userDataPath, name), { recursive: true, force: true }); } catch {}
    }
    return { ok: true };
  } catch (error) {
    logError('Factory reset', error);
    return { ok: false, error: error.message };
  }
});


// ---------- Trade Capture Service 2.0 ----------
let captureServer = null;
let relayTimer = null;
const CAPTURE_PORT = 17654;
const captureRoot = () => path.join(resolveDataDir(), 'trade-capture');
const captureEventsPath = () => path.join(captureRoot(), 'events.json');
const captureSettingsPath = () => path.join(captureRoot(), 'settings.json');
const captureStatePath = () => path.join(captureRoot(), 'positions.json');
const screenshotRoot = () => path.join(captureRoot(), 'screenshots');

function ensureCaptureRoot() {
  fs.mkdirSync(captureRoot(), { recursive: true });
  fs.mkdirSync(screenshotRoot(), { recursive: true });
}
function defaultCaptureSettings() {
  return {
    apiKey: crypto.randomBytes(24).toString('hex'),
    autoImport: true,
    screenshotMode: 'primary',
    accountMappings: {},
    hiddenAccounts: [],
    deletedAccounts: [],
    relayEnabled: false,
    relayUrl: '',
    relayToken: '',
    // Účty přidané ručně v Nastavení. Bez nich by se dal namapovat jen účet,
    // který už někdy poslal událost – Playback účet tedy až PO prvním
    // obchodě, který by mezitím spadl do živého deníku.
    manualAccounts: [],
    // Upozornění po aktualizaci NinjaTraderu (4.8.92): poslední viděná verze
    // NT8, jestli se upozorňuje a jestli kdy byl konektor nainstalovaný.
    ntSeenVersion: '',
    ntUpdateNotice: true,
    ntConnectorSeen: false
  };
}
// Nové nastavení (a s ním nový API klíč) se zakládá JEN když soubor chybí.
// Dřív ho přepsala jakákoli chyba čtení – i dočasný zámek souboru – a NT8 pak
// posílal klíč, který aplikace odmítala, aniž by o tom kdokoli věděl.
//  - poškozený JSON: odloží se vedle (settings.json.poskozeny-<čas>), zapíše
//    do protokolu a založí nové – nový klíč odhalí kontrola konektoru,
//  - jiná chyba čtení: výchozí hodnoty jen v paměti, soubor se nepřepíše
//    a zápis takového nastavení writeCaptureSettings odmítne.
// Poslední úspěšně přečtený API klíč – když složka dat zrovna chybí, ověří
// se jím zprávy konektoru, které jdou do zálohy (captureSpool).
const captureKeyCache = { key: null };
function readCaptureSettings() {
  const settings = readCaptureSettingsFile();
  if (!settings._readFailed && settings.apiKey) captureKeyCache.key = settings.apiKey;
  return settings;
}
function readCaptureSettingsFile() {
  ensureCaptureRoot();
  let raw;
  try {
    raw = fs.readFileSync(captureSettingsPath(), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const defaults = defaultCaptureSettings();
      fs.writeFileSync(captureSettingsPath(), JSON.stringify(defaults, null, 2), 'utf8');
      return defaults;
    }
    logError('Nastavení konektoru nejde přečíst', error);
    return { ...defaultCaptureSettings(), _readFailed: true };
  }
  try {
    return { ...defaultCaptureSettings(), ...JSON.parse(raw) };
  } catch (error) {
    const aside = `${captureSettingsPath()}.poskozeny-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.renameSync(captureSettingsPath(), aside); } catch (renameError) { logError('Nastavení konektoru – odložení poškozeného souboru', renameError); }
    logError('Nastavení konektoru je poškozené', `${error.message}; odloženo jako ${aside}, založen nový API klíč – konektor v NT8 je potřeba přeinstalovat`);
    const defaults = defaultCaptureSettings();
    fs.writeFileSync(captureSettingsPath(), JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }
}
function writeCaptureSettings(settings) {
  if (settings && settings._readFailed) throw new Error('Nastavení konektoru teď nejde přečíst, změna se neuložila. Zkus to znovu.');
  ensureCaptureRoot();
  fs.writeFileSync(captureSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}
function readCaptureEvents() {
  ensureCaptureRoot();
  try {
    const parsed = JSON.parse(fs.readFileSync(captureEventsPath(), 'utf8'));
    // Snímky pozic se do historie záměrně neukládají (viz appendCaptureEvent).
    // Starší verze je ukládaly, a protože chodí zhruba jednou za sekundu na
    // každý účet, vytlačily z 10 000místného kruhového bufferu skoro všechny
    // opravdové události (exekuce a uzavřené obchody). Tenhle filtr je při
    // prvním dalším zápisu jednorázově vyhodí.
    return Array.isArray(parsed) ? parsed.filter(e => e?.type !== 'position_snapshot') : [];
  } catch { return []; }
}
function writeCaptureEvents(events) {
  ensureCaptureRoot();
  const tmp = `${captureEventsPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(events, null, 2), 'utf8');
  fs.renameSync(tmp, captureEventsPath());
}
function readCaptureState() {
  ensureCaptureRoot();
  try {
    const state = JSON.parse(fs.readFileSync(captureStatePath(), 'utf8'));
    return { positions: state.positions || {}, executionIds: state.executionIds || [] };
  } catch { return { positions: {}, executionIds: [] }; }
}
function writeCaptureState(state) {
  ensureCaptureRoot();
  const safe = { positions: state.positions || {}, executionIds: (state.executionIds || []).slice(-10000) };
  fs.writeFileSync(captureStatePath(), JSON.stringify(safe, null, 2), 'utf8');
}
// Pozice, která ve snímku pozic z NinjaTraderu chybí, se nemaže hned – jen se
// odloží (missingSince) a ještě chvíli čeká na svou exekuci. Konektor posílá
// exekuci a snímek pozic jako dvě nezávislé zprávy a plochý snímek občas
// dorazí DŘÍV než výstupní exekuce, která ho způsobila. Když snímek pozici
// smazal, výstup neměl co uzavřít, zapsal se jako otevření opačné pozice
// a obchod se do deníku nedostal (2026-09-22 a 2026-10-12, 2 pozice z 211).
// Odložená pozice se nikde neukazuje jako otevřená.
const POSITION_MISSING_GRACE_MS = 10 * 60 * 1000;
// O kolik smí snímek předběhnout exekuci, aby se změna počtu kontraktů ve
// snímku brala jako táž změna, kterou nese exekuce (stejné okno jako u vstupu,
// viz adoptSnapshot v processExecution).
const SNAPSHOT_RACE_WINDOW_MS = 15000;
function positionIsMissing(position) {
  return Number(position?.missingSince) > 0;
}
function openCapturePositions(state) {
  return Object.values(state?.positions || {}).filter(position => !positionIsMissing(position));
}
// persist=false: událost se jen pošle do okna (živé obnovení přehledu otevřených
// pozic), ale neuloží se do historie. Používá se pro snímky pozic – ty chodí
// zhruba jednou za sekundu na každý účet a jejich ukládáním se z historie
// vytlačovaly exekuce a uzavřené obchody, tedy jediná data, která mají trvalou
// hodnotu. Aktuální stav pozic stejně žije v positions.json.
function appendCaptureEvent(payload, source='unknown', persist=true) {
  const event = {
    id: payload.id || crypto.randomUUID(),
    receivedAt: payload.receivedAt || new Date().toISOString(),
    imported: payload.imported === true,
    source,
    ...payload
  };
  if (persist) {
    const events = readCaptureEvents();
    events.push(event);
    writeCaptureEvents(events.slice(-10000));
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('capture:event', event);
  return event;
}
function signedExecutionQuantity(payload) {
  const qty = Math.abs(Number(payload.quantity || 0));
  const action = String(payload.orderAction || payload.action || '').toLowerCase();
  if (action.includes('buy')) return qty;
  if (action.includes('sell')) return -qty;
  const mp = String(payload.marketPosition || '').toLowerCase();
  if (mp.includes('long')) return qty;
  if (mp.includes('short')) return -qty;
  return 0;
}
// Zajišťuje, že se dvě téměř současně přijaté zprávy z NinjaTraderu (např. rychlý
// částečný fill hlášený dvěma HTTP požadavky těsně po sobě) nikdy nezpracují
// souběžně – bez toho by obě mohly přečíst stejný "zbývající počet kontraktů"
// dřív, než ho ta první stihne zapsat, a vytvořit tak dva duplicitní uzavřené
// obchody se stejnou cenou/časem/počtem kontraktů (viditelné jako dva identické
// cíle TP2/TP3 po sloučení).
let captureQueue = Promise.resolve();
function withCaptureLock(fn) {
  const run = captureQueue.then(fn, fn);
  captureQueue = run.then(() => undefined, () => undefined);
  return run;
}
// Doplňková pojistka: i kdyby duplicitu nezachytilo serializování výše (např.
// když NinjaTrader tentýž fill nahlásí dvakrát s různým executionId s odstupem
// několika sekund), zkontrolujeme nedávné odvozené události (otevření i uzavření)
// na stejném účtu a instrumentu se stejnou cenou/počtem kontraktů a blízkým časem.
// Kontroluje se bez ohledu na aktuální stav pozice, protože duplicitní hlášení
// uzavření může dorazit až POTÉ, co už byla pozice mezitím plně uzavřena (jinak
// Dřívější verze měla tady i pomocnou funkci isDuplicateExecutionReport, která
// hlídala duplicity podle shody účtu/instrumentu/ceny/počtu kontraktů/času.
// Ukázalo se, že to bylo NEBEZPEČNÉ zjednodušení: dvě opravdu ROZDÍLNÉ pozice
// (např. dva samostatné 1-kontraktové obchody uzavřené za sebou při stejné
// ceně) mají naprosto legitimně stejné hodnoty, a tahle kontrola je omylem
// zahodila jako "duplicitu" – reálný obchod tak z deníku úplně zmizel.
// Přesná ochrana proti opravdovým duplicitám (NinjaTrader umí tutéž exekuci
// nahlásit znovu po výpadku spojení) je jen ta, co funguje na skutečné ID:
// 1) state.executionIds výše v této funkci, 2) HashSet v NinjaScript
// konektoru samotném, 3) sourceEventId/sourceEventIds na úrovni obchodů a
// jejich legů (viz appendOrMergeCapturedTrade ve frontendu). Hádání podle
// shody hodnot se záměrně nepoužívá – je to jen zdroj ztráty dat.
function positionKey(payload) {
  return `${payload.account || 'UNKNOWN'}|${payload.instrumentFull || payload.instrument || payload.symbol || 'UNKNOWN'}`;
}
async function takeScreenshots(label) {
  const settings = readCaptureSettings();
  if (settings.screenshotMode === 'none') return [];
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false
    });
    if (!sources.length) return [];
    let selected = sources;
    if (settings.screenshotMode === 'primary') {
      const primaryId = String(screen.getPrimaryDisplay().id);
      selected = [sources.find(s => String(s.display_id) === primaryId) || sources[0]];
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const paths = [];
    selected.forEach((source, index) => {
      const filename = `${stamp}_${label}_${index + 1}.png`;
      const file = path.join(screenshotRoot(), filename);
      fs.writeFileSync(file, source.thumbnail.toPNG());
      paths.push(file);
    });
    return paths;
  } catch (error) {
    logError('Automatic screenshot', error);
    return [];
  }
}
// Zapíše do stavu nově otevřenou pozici a vrátí odvozenou událost "trade_opened".
// Používá se ze dvou míst: při běžném otevření z ploché pozice a při "převzetí"
// pozice, kterou pár milisekund předtím založil snímek pozic (viz processExecution).
// `positionId` se předává, aby si převzatá pozice udržela svoje ID – na něm stojí
// automatické slučování legů (TP1/TP2/BE) ve frontendu.
// Živý konektor: screenshoty obrazovky a událost do historie i do okna. Ruční
// import z CSV (manualImportReplay) jádro pouští s vlastním ctx bez obojího.
const LIVE_CAPTURE = {
  shots: label => takeScreenshots(label),
  emit: event => appendCaptureEvent(event, 'ninjatrader')
};
async function openPositionFromExecution(state, key, payload, { delta, price, commission, rate, pointValue, time, executionId, positionId }, ctx = LIVE_CAPTURE) {
  const images = await ctx.shots('entry');
  const side = delta > 0 ? 'long' : 'short';
  const instrument = payload.instrument || payload.symbol || '';
  const instrumentFull = payload.instrumentFull || payload.instrument || payload.symbol || '';
  const strategy = payload.strategy || payload.orderName || '';
  state.positions[key] = {
    qty: delta,
    avgPrice: price,
    currentPrice: price,
    openedAt: time,
    pointValue,
    rate,
    entryCommission: commission,
    maxQuantity: Math.abs(delta),
    side,
    entryImages: images,
    account: payload.account || '',
    instrument,
    instrumentFull,
    strategy,
    positionId,
    fromSnapshot: false,
    executionsApplied: true,
    lots: [{ key: lotKeyOf(payload, executionId), time, price, qty: Math.abs(delta), commission }]
  };
  return ctx.emit({
    type: 'trade_opened',
    account: payload.account || '',
    instrument,
    instrumentFull,
    side,
    entryTime: time,
    entryPrice: price,
    quantity: Math.abs(delta),
    strategy,
    screenshotPaths: images,
    sourceExecutionId: executionId,
    positionId
  });
}
// MFE / MAE v ticích od průměrné vstupní ceny pozice, z extrémů ceny, které
// NinjaTrader vede u vstupních exekucí (konektor je posílá s každým výstupem jako
// excursionMaxPrice / excursionMinPrice). Výstupní cena se do extrémů přidává –
// cena na ní prokazatelně obchodovala, i kdyby NT poslední tick ještě nezapsal.
// Bez extrémů nebo bez velikosti ticku se nevrací nic: prázdno, ne nula.
// Totéž u nesmyslných vstupů: sentinel NT (±1e300 a víc) a vstupní cena 0 –
// tu dosazuje normalizeSnapshotPosition, když snímek pozice cenu neposlal,
// a „MFE" by pak byla celá cena instrumentu v ticích.
function excursionTicks(payload, side, avgPrice, exitPrice) {
  const tick = Number(payload?.tickSize);
  const hi = Number(payload?.excursionMaxPrice);
  const lo = Number(payload?.excursionMinPrice);
  if (!(tick > 0) || !Number.isFinite(hi) || !Number.isFinite(lo) || hi < lo) return {};
  if (Math.abs(hi) >= 1e300 || Math.abs(lo) >= 1e300) return {};
  const entry = Number(avgPrice), exit = Number(exitPrice);
  if (!Number.isFinite(entry) || entry === 0) return {};
  const max = Number.isFinite(exit) ? Math.max(hi, exit) : hi;
  const min = Number.isFinite(exit) ? Math.min(lo, exit) : lo;
  const toTicks = v => Math.max(0, Math.round((v / tick) * 100) / 100);
  let favorable, adverse;
  if (side === 'long') { favorable = max - entry; adverse = entry - min; }
  else if (side === 'short') { favorable = entry - min; adverse = max - entry; }
  else return {};
  const mfeTicks = toTicks(favorable), maeTicks = toTicks(adverse);
  if (!Number.isFinite(mfeTicks) || !Number.isFinite(maeTicks)) return {};
  return { mfeTicks, maeTicks };
}
// ---- Loty pozice (FIFO) ----
// Pozice si vede vstupy zvlášť: jeden lot na vstupní příkaz (dílčí plnění téhož
// příkazu se sčítají do jednoho lotu s váženou cenou, jinak by se běžný vstup
// na dvě plnění rozpadl na dvě nohy). Výstup loty spotřebovává od nejstaršího,
// stejně jako NinjaTrader páruje obchody v Trade Performance.
//
// Dřív měla pozice jen jednu průměrnou cenu ze dvou zdrojů: vlastní vážený
// průměr při přikoupení a Position.AveragePrice ze snímku pozic. NinjaTrader ale
// po částečném výstupu vede průměr ZBYTKU (FIFO), takže po dokupu a částečném
// výstupu snímek průměr přepsal jinou hodnotou a další výstup se počítal od ní.
// Součet přes cíle pak neseděl na peněžní tok (2026-10-13, MNQ 7 kontraktů:
// 148 b místo 155 b). Loty vede jen processExecution, snímek na ně nesahá
// a výsledek výstupu už se z avgPrice nepočítá.
function lotKeyOf(payload, executionId) {
  return String(payload?.orderId || executionId || '');
}
// Loty, ze kterých se má počítat. Když jejich součet nesedí na počet kontraktů
// pozice (pozice známá jen ze snímku, stav ze starší verze, zmeškaná exekuce),
// platí jeden náhradní lot z toho, co o pozici víme – tedy chování před loty.
function positionLots(position) {
  const lots = Array.isArray(position.lots) ? position.lots.filter(l => l && Number(l.qty) > 0) : [];
  const qty = Math.abs(Number(position.qty) || 0);
  if (lots.length && lots.reduce((a, l) => a + Number(l.qty), 0) === qty) return lots;
  return [{ key: '', time: position.openedAt, price: Number(position.avgPrice) || 0, qty, commission: Number(position.entryCommission) || 0 }];
}
// Zapíše loty zpět na pozici i s tím, co se z nich odvozuje: průměrnou vstupní
// cenu zbytku (pro tabulku otevřených pozic) a zbývající vstupní komisi.
function applyLots(position, lots) {
  position.lots = lots;
  const qty = lots.reduce((a, l) => a + l.qty, 0);
  if (lots.length === 1) position.avgPrice = lots[0].price;
  else if (qty > 0) position.avgPrice = lots.reduce((a, l) => a + l.price * l.qty, 0) / qty;
  position.entryCommission = lots.reduce((a, l) => a + l.commission, 0);
}
// Odebere z lotů `closeQty` kontraktů od nejstaršího a vrátí úseky podle
// vstupní ceny: výstup, který zavírá kontrakty ze dvou vstupů, jsou dvě nohy.
// Vstupní komise jde s kontrakty, ke kterým patří.
function takeFromLots(lots, closeQty) {
  const chunks = [];
  let left = closeQty;
  while (left > 0 && lots.length) {
    const lot = lots[0];
    const take = Math.min(lot.qty, left);
    const fee = lot.qty ? lot.commission * (take / lot.qty) : 0;
    const last = chunks[chunks.length - 1];
    if (last && last.price === lot.price) { last.qty += take; last.commission += fee; }
    else chunks.push({ price: lot.price, time: lot.time, qty: take, commission: fee });
    lot.qty -= take;
    lot.commission = Math.max(0, lot.commission - fee);
    left -= take;
    if (lot.qty === 0) lots.shift();
  }
  return chunks;
}
// Živá exekuce z konektoru: stav pozic z positions.json, po zpracování zpět.
async function processExecution(payload) {
  const state = readCaptureState();
  const executionId = String(payload.executionId || '');
  if (executionId && state.executionIds.includes(executionId)) return [];
  const derived = await applyExecution(state, payload);
  writeCaptureState(state);
  return derived;
}
// Jádro: jedna exekuce nad předaným stavem pozic (state se mění na místě).
// Vrací odvozené události (trade_opened / trade_closed). Stav nečte ani
// nezapisuje – to dělá volající (processExecution, manualImportReplay).
async function applyExecution(state, payload, ctx = LIVE_CAPTURE) {
  const executionId = String(payload.executionId || '');
  if (executionId && state.executionIds.includes(executionId)) return [];
  if (executionId) state.executionIds.push(executionId);

  const delta = signedExecutionQuantity(payload);
  if (!delta) return [];

  const key = positionKey(payload);
  const price = Number(payload.price || 0);
  const commission = Math.abs(Number(payload.commission || 0));
  const rate = Number(payload.rate || 1) || 1;
  const pointValue = Number(payload.pointValue || 1) || 1;
  const time = payload.time || new Date().toISOString();
  let current = state.positions[key] || null;
  const derived = [];

  const opts = { delta, price, commission, rate, pointValue, time, executionId };

  // Konektor posílá s každou exekucí pozici účtu PO ní (positionAfter, se
  // znaménkem). Pozice PŘED exekucí je tedy údaj přímo z NinjaTraderu, ne
  // odhad – podle něj se pozná, jestli exekuce patří k pozici, kterou mezitím
  // odložil nebo upravil snímek pozic. Bez positionAfter (testovací sekvence,
  // jiný zdroj) se nic z toho nepoužije.
  const positionAfter = (payload.positionAfter === undefined || payload.positionAfter === null || payload.positionAfter === '')
    ? NaN : Number(payload.positionAfter);
  const qtyBefore = Number.isFinite(positionAfter) ? positionAfter - delta : null;

  // Snímek krátce předtím změnil počet kontraktů ve stejném směru, v jakém
  // pozici hlásí NinjaTrader před touhle exekucí – tedy ji nejspíš předběhl.
  // Opačný směr (nebo nula) by znamenal jinou pozici.
  const snapshotOutranExecution = position => qtyBefore !== null
    && position.qty !== qtyBefore
    && Math.sign(position.qty) === Math.sign(qtyBefore)
    && (Date.now() - Number(position.qtySnapshotAt)) <= SNAPSHOT_RACE_WINDOW_MS;

  if (current && positionIsMissing(current)) {
    const stillWaiting = Date.now() - Number(current.missingSince) <= POSITION_MISSING_GRACE_MS;
    // Odložená pozice patří k exekuci, když sedí počet kontraktů – nebo když ho
    // těsně před plochým snímkem stihl změnit ještě jeden snímek (dva cíle
    // naráz: snímek s 1 kontraktem, hned po něm plochý, a teprve pak obě
    // exekuce). Počet pak vrátí blok níž.
    if (stillWaiting && qtyBefore !== null && qtyBefore !== 0 && (qtyBefore === current.qty || snapshotOutranExecution(current))) {
      // Snímek předběhl tuhle exekuci: pozice se vrací a zpracuje se běžně.
      delete current.missingSince;
      logInfo('Capture', `Exekuce ${executionId || '(bez ID)'} patří k pozici ${key}, kterou předtím odložil snímek pozic – pozice vzata zpět.`);
    } else {
      delete state.positions[key];
      current = null;
    }
  }

  // Částečný výstup nebo přikoupení, které snímek předběhl: snímek už počet
  // kontraktů změnil a exekuce by tutéž změnu započítala podruhé (u výstupu by
  // pozice zmizela a další cíl by neměl co uzavřít). Krátce po takovém snímku
  // proto platí počet kontraktů před exekucí, jak ho hlásí NinjaTrader.
  // S počtem se vrací i průměrná vstupní cena z doby před snímkem: snímek po
  // přikoupení už nese průměr VČETNĚ téhle exekuce a ta by se do něj jinak
  // započítala podruhé (100 + přikoupení na 110 → 107,5 místo 105).
  if (current && snapshotOutranExecution(current)) {
    logInfo('Capture', `Snímek pozic předběhl exekuci ${executionId || '(bez ID)'} na ${key}: počet kontraktů vrácen z ${current.qty} na ${qtyBefore}.`);
    current.qty = qtyBefore;
    const avgBefore = Number(current.avgPriceBeforeSnapshot);
    if (Number.isFinite(avgBefore) && avgBefore !== 0) current.avgPrice = avgBefore;
  }
  if (current) {
    delete current.qtySnapshotAt;
    delete current.avgPriceBeforeSnapshot;
  }

  // Po téhle exekuci je účet na instrumentu plochý a žádnou pozici k uzavření
  // neznáme: není co otevřít. Dřív z toho vznikla falešná opačná pozice.
  if ((!current || current.qty === 0) && positionAfter === 0) {
    logInfo('Capture', `Výstupní exekuce ${executionId || '(bez ID)'} na ${key} (${payload.orderAction || ''} ${Math.abs(delta)} @ ${price}) bez známé otevřené pozice – obchod nelze sestavit.`);
    if (current) delete state.positions[key];
    return derived;
  }

  if (!current || current.qty === 0) {
    derived.push(await openPositionFromExecution(state, key, payload, { ...opts, positionId: crypto.randomUUID() }, ctx));
    return derived;
  }

  const sameDirection = Math.sign(current.qty) === Math.sign(delta);
  // NinjaTrader posílá snímek pozic při každé změně pozice, takže snímek vzniklý
  // vstupním fillem občas dorazí o pár milisekund DŘÍV než exekuce, která ho
  // způsobila (v reálném logu 25 ms). Pozice pak existuje ještě předtím, než ji
  // exekuce založí, a bez téhle větve by se vstup započítal podruhé jako
  // přikoupení (2 kontrakty → 4). Když tedy jde o pozici založenou snímkem, která
  // ještě neviděla ani jednu exekuci, má stejný směr i velikost a snímek dorazil
  // před chvílí, jde o týž fill – pozice se nepřičítá, ale převezme se (včetně
  // ceny, času, komise a názvu vstupního příkazu). ID pozice se zachovává.
  const adoptSnapshot = sameDirection
    && current.fromSnapshot === true
    && current.executionsApplied !== true
    && Math.abs(current.qty) === Math.abs(delta)
    && (Date.now() - (Number(current.snapshotSeenAt) || 0)) <= 15000;
  if (adoptSnapshot) {
    derived.push(await openPositionFromExecution(state, key, payload, { ...opts, positionId: current.positionId || crypto.randomUUID() }, ctx));
    return derived;
  }

  const lots = positionLots(current);

  if (sameDirection) {
    // Přikoupení: další plnění téhož vstupního příkazu rozšíří jeho lot,
    // nový příkaz (dokup) založí vlastní.
    const addAbs = Math.abs(delta);
    const lotKey = lotKeyOf(payload, executionId);
    const sameOrder = lotKey ? lots.find(l => l.key === lotKey) : null;
    if (sameOrder) {
      sameOrder.price = ((sameOrder.price * sameOrder.qty) + (price * addAbs)) / (sameOrder.qty + addAbs);
      sameOrder.qty += addAbs;
      sameOrder.commission += commission;
    } else {
      lots.push({ key: lotKey, time, price, qty: addAbs, commission });
    }
    applyLots(current, lots);
    current.currentPrice = price;
    current.qty += delta;
    current.maxQuantity = Math.max(current.maxQuantity || 0, Math.abs(current.qty));
    current.executionsApplied = true;
    state.positions[key] = current;
    return derived;
  }

  const previousQty = current.qty;
  const closeQty = Math.min(Math.abs(previousQty), Math.abs(delta));
  const direction = Math.sign(previousQty);
  // MFE / MAE se měří od vstupní ceny pozice, tedy od jejího prvního vstupu –
  // od téže ceny, kterou ponese sloučený obchod. Platí pro všechny výstupy
  // pozice, i ty, které zavírají až dokoupené kontrakty.
  if (!(Number(current.entryRefPrice) > 0)) current.entryRefPrice = lots[0].price;
  const exitCommissionShare = commission * (closeQty / Math.abs(delta));
  const exitImages = await ctx.shots('exit');

  for (const chunk of takeFromLots(lots, closeQty)) {
    const pointsSigned = (price - chunk.price) * direction;
    const grossPnl = pointsSigned * pointValue * chunk.qty * rate;
    const chunkCommission = chunk.commission + exitCommissionShare * (chunk.qty / closeQty);
    const netPnl = grossPnl - chunkCommission;
    derived.push(ctx.emit({
      type: 'trade_closed',
      account: current.account,
      instrument: current.instrument,
      instrumentFull: current.instrumentFull,
      side: current.side,
      entryTime: chunk.time || current.openedAt,
      exitTime: time,
      entryPrice: chunk.price,
      exitPrice: price,
      quantity: chunk.qty,
      contracts: chunk.qty,
      points: Math.abs(pointsSigned),
      grossPnl,
      commission: chunkCommission,
      pnl: netPnl,
      result: netPnl >= 0 ? 'target' : 'stoploss',
      pointValue,
      strategy: current.strategy || payload.strategy || payload.orderName || '',
      screenshotPaths: [...(current.entryImages || []), ...exitImages],
      sourceExecutionId: executionId,
      positionId: current.positionId || '',
      ...excursionTicks(payload, current.side, current.entryRefPrice, price)
    }));
  }

  const remainingOld = Math.abs(previousQty) - closeQty;
  const excessNew = Math.abs(delta) - closeQty;
  if (remainingOld > 0) {
    current.qty = direction * remainingOld;
    applyLots(current, lots);
    current.executionsApplied = true;
    state.positions[key] = current;
  } else if (excessNew > 0) {
    // Otočka pozice: zbytek exekuce otevírá novou pozici opačným směrem.
    derived.push(await openPositionFromExecution(state, key, payload, {
      ...opts,
      delta: Math.sign(delta) * excessNew,
      commission: Math.max(0, commission - exitCommissionShare),
      positionId: crypto.randomUUID()
    }, ctx));
  } else {
    delete state.positions[key];
  }

  return derived;
}
// Ruční import exekucí z CSV / schránky (4.8.7): stejné jádro jako živý
// konektor, ale nad VLASTNÍM prázdným stavem v paměti – positions.json,
// historie událostí ani screenshoty se nemění. Exekuce přicházejí seřazené
// (app/nt8import.js). Výstup, ke kterému soubor nemá vstup (začátek exportu
// uprostřed pozice), se vynechá a vrátí se jako `skipped` – jinak by z něj
// jádro založilo opačnou pozici. Pozice bez výstupu na konci souboru se
// vrátí jako `open`.
// ID událostí jsou odvozená z ID exekucí (nt8m:<výstup>:<n>) a ID pozice ze
// vstupní exekuce – opakovaný import téhož souboru tak nic nezdvojí
// a nohy jedné pozice se sloučí i při importu po částech.
async function manualImportReplay(payloads) {
  const state = { positions: {}, executionIds: [] };
  const closed = [], skipped = [];
  const perExit = new Map();
  const positionIds = new Map();
  const ctx = {
    shots: async () => [],
    emit: event => {
      if (event.type === 'trade_opened') {
        positionIds.set(event.positionId, `nt8m:pos:${event.sourceExecutionId}`);
        return event;
      }
      const exitId = String(event.sourceExecutionId || '');
      const n = (perExit.get(exitId) || 0) + 1;
      perExit.set(exitId, n);
      const out = { id: `nt8m:${exitId}:${n}`, receivedAt: event.exitTime, imported: false, source: 'ninjatrader', ...event,
        positionId: positionIds.get(event.positionId) || event.positionId };
      closed.push(out);
      return out;
    }
  };
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    const current = state.positions[positionKey(payload)];
    if (payload.entryExit === 'exit' && (!current || current.qty === 0)) {
      skipped.push({ executionId: payload.executionId, time: payload.time, instrumentFull: payload.instrumentFull, account: payload.account, quantity: payload.quantity, price: payload.price, orderAction: payload.orderAction });
      continue;
    }
    await applyExecution(state, payload, ctx);
  }
  const open = Object.values(state.positions).filter(p => p.qty).map(p => ({
    account: p.account, instrumentFull: p.instrumentFull, side: p.side, quantity: Math.abs(p.qty), openedAt: p.openedAt, avgPrice: p.avgPrice
  }));
  return { closed, open, skipped };
}
function normalizeSnapshotPosition(item, account, snapshotTime) {
  const qtyRaw = Number(item.quantity ?? item.qty ?? 0);
  const marketPosition = String(item.marketPosition || item.side || '').toLowerCase();
  const signedQty = marketPosition.includes('short') ? -Math.abs(qtyRaw) : Math.abs(qtyRaw);
  if (!signedQty) return null;
  const instrument = String(item.instrument || item.symbol || '');
  const instrumentFull = String(item.instrumentFull || instrument);
  if (!instrumentFull) return null;
  const avgPrice = Number(item.avgPrice ?? item.averagePrice ?? item.price ?? 0);
  const currentPrice = Number(item.currentPrice ?? item.lastPrice ?? avgPrice);
  return {
    key: `${account || 'UNKNOWN'}|${instrumentFull}`,
    value: {
      qty: signedQty,
      avgPrice: Number.isFinite(avgPrice) ? avgPrice : 0,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : (Number.isFinite(avgPrice) ? avgPrice : 0),
      openedAt: item.openedAt || snapshotTime,
      pointValue: Number(item.pointValue || 1) || 1,
      rate: Number(item.rate || 1) || 1,
      entryCommission: Number(item.entryCommission || 0) || 0,
      maxQuantity: Math.abs(signedQty),
      side: signedQty > 0 ? 'long' : 'short',
      entryImages: [],
      account: account || '',
      instrument,
      instrumentFull,
      strategy: item.strategy || '',
      // Pozice založená ze snímku musí mít ID stejně jako pozice založená
      // exekucí – na shodě positionId stojí automatické slučování legů
      // (TP1/TP2/BE) do jednoho obchodu. Bez něj se každý výstup uložil jako
      // samostatný obchod. Snímek chodí i těsně před vstupní exekucí, proto se
      // ukládá i čas, kdy byl vidět poprvé (viz adoptSnapshot v processExecution).
      positionId: crypto.randomUUID(),
      fromSnapshot: true,
      snapshotSeenAt: Date.now()
    }
  };
}
function processPositionSnapshot(payload) {
  const account = String(payload.account || '');
  if (!account) return;
  const snapshotTime = payload.time || new Date().toISOString();
  const incoming = Array.isArray(payload.positions) ? payload.positions : [];
  const state = readCaptureState();
  const authoritative = {};
  for (const item of incoming) {
    const normalized = normalizeSnapshotPosition(item, account, snapshotTime);
    if (normalized) authoritative[normalized.key] = normalized.value;
  }
  const now = Date.now();
  for (const [key, position] of Object.entries(state.positions || {})) {
    if (String(position.account || '') !== account || authoritative[key]) continue;
    // Chybějící pozice se jen odloží, viz POSITION_MISSING_GRACE_MS. Smaže se,
    // až když si pro ni do té doby žádná exekuce nepřišla.
    if (!positionIsMissing(position)) position.missingSince = now;
    else if (now - Number(position.missingSince) > POSITION_MISSING_GRACE_MS) delete state.positions[key];
  }
  // Snímek je autoritativní jen pro to, co opravdu obsahuje: počet kontraktů,
  // průměrnou a aktuální cenu. Zbytek pozice pochází z exekucí a snímek ho
  // NESMÍ přepsat – dřív každý snímek (chodí ~1× za sekundu) vynuloval
  // nasčítanou vstupní komisi a smazal název vstupního příkazu, takže uzavřený
  // obchod měl jen výstupní komisi a jako strategii název stop/target příkazu.
  for (const [key, position] of Object.entries(authoritative)) {
    let existing = state.positions[key];
    // Odložená pozice, která se ve snímku vrátila se stejným počtem kontraktů,
    // je táž pozice (výpadek na straně NinjaTraderu). S jiným počtem jde
    // o novou pozici a stará se zahodí.
    if (existing && positionIsMissing(existing)) {
      if (existing.qty === position.qty) delete existing.missingSince;
      else existing = undefined;
    }
    // Snímek, který mění počet kontraktů, mohl předběhnout exekuci, která tu
    // změnu způsobila – processExecution podle toho pozná, že ji nemá započítat
    // podruhé. K tomu si pozice pamatuje průměrnou vstupní cenu z doby PŘED
    // snímkem (snímek ji níž přepíše průměrem po exekuci); když počet změní víc
    // snímků po sobě dřív, než exekuce dorazí, platí cena před prvním z nich.
    const raceOpen = existing && existing.avgPriceBeforeSnapshot !== undefined
      && (now - Number(existing.qtySnapshotAt)) <= SNAPSHOT_RACE_WINDOW_MS;
    const qtyChange = existing && existing.qty !== position.qty
      ? { qtySnapshotAt: now, avgPriceBeforeSnapshot: raceOpen ? existing.avgPriceBeforeSnapshot : existing.avgPrice }
      : {};
    state.positions[key] = existing ? {
      ...existing,
      ...position,
      positionId: existing.positionId || position.positionId,
      openedAt: existing.openedAt || position.openedAt,
      entryImages: existing.entryImages || [],
      entryCommission: Number(existing.entryCommission) || 0,
      strategy: existing.strategy || position.strategy,
      maxQuantity: Math.max(Number(existing.maxQuantity) || 0, Math.abs(position.qty)),
      fromSnapshot: existing.fromSnapshot === true,
      snapshotSeenAt: existing.snapshotSeenAt || position.snapshotSeenAt,
      ...qtyChange
    } : position;
  }
  writeCaptureState(state);
}

async function processCTraderOpen(payload) {
  const images = await takeScreenshots('entry');
  appendCaptureEvent({
    type: 'trade_opened',
    account: payload.account || '',
    instrument: payload.instrument || '',
    instrumentFull: payload.instrumentFull || payload.instrument || '',
    side: payload.side || '',
    entryTime: payload.entryTime,
    entryPrice: Number(payload.entryPrice || 0),
    quantity: Math.abs(Number(payload.quantity || 0)),
    strategy: payload.strategy || '',
    screenshotPaths: images,
    positionId: payload.positionId || ''
  }, 'ctrader');
}
async function processCTraderClose(payload) {
  const dealId = String(payload.closingDealId || '');
  const state = readCaptureState();
  state.ctraderDealIds = Array.isArray(state.ctraderDealIds) ? state.ctraderDealIds : [];
  if (dealId && state.ctraderDealIds.includes(dealId)) {
    writeCaptureState(state);
    return;
  }
  if (dealId) {
    state.ctraderDealIds.push(dealId);
    if (state.ctraderDealIds.length > 2000) state.ctraderDealIds = state.ctraderDealIds.slice(-2000);
  }
  const quantity = Math.abs(Number(payload.quantity || 0));
  writeCaptureState(state);
  const images = await takeScreenshots('exit');
  const netPnl = Number(payload.pnl || 0);
  appendCaptureEvent({
    type: 'trade_closed',
    account: payload.account || '',
    instrument: payload.instrument || '',
    instrumentFull: payload.instrumentFull || payload.instrument || '',
    side: payload.side || '',
    entryTime: payload.entryTime,
    entryPrice: Number(payload.entryPrice || 0),
    exitTime: payload.exitTime,
    exitPrice: Number(payload.exitPrice || 0),
    quantity,
    contracts: quantity,
    points: Math.abs(Number(payload.points || 0)),
    pnl: netPnl,
    commission: Math.abs(Number(payload.commission || 0)) + Math.abs(Number(payload.swap || 0)),
    result: netPnl >= 0 ? 'target' : 'stoploss',
    strategy: payload.strategy || '',
    screenshotPaths: images,
    sourceExecutionId: dealId || undefined,
    positionId: payload.positionId || ''
  }, 'ctrader');
}
async function processIncomingPayload(payload, source='external') {
  const raw = appendCaptureEvent(payload, source, payload.type !== 'position_snapshot');
  if (payload.type === 'execution' && source === 'ninjatrader') await withCaptureLock(() => processExecution(payload));
  if (payload.type === 'position_snapshot' && source === 'ninjatrader') await withCaptureLock(() => processPositionSnapshot(payload));
  if (payload.type === 'ctrader_position_opened' && source === 'ctrader') await withCaptureLock(() => processCTraderOpen(payload));
  if (payload.type === 'ctrader_trade_closed' && source === 'ctrader') await withCaptureLock(() => processCTraderClose(payload));
  if (payload.type === 'market_data' || payload.type === 'quote') {
    const state = readCaptureState();
    const instrument = String(payload.instrumentFull || payload.instrument || payload.symbol || '');
    const account = String(payload.account || '');
    const price = Number(payload.price ?? payload.lastPrice ?? payload.last);
    if (instrument && Number.isFinite(price)) {
      for (const position of openCapturePositions(state)) {
        const sameInstrument = position.instrumentFull === instrument || position.instrument === instrument;
        const sameAccount = !account || position.account === account;
        if (sameInstrument && sameAccount) position.currentPrice = price;
      }
      writeCaptureState(state);
    }
  }
  return raw;
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-FJ-API-Key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}
// Zprávy odmítnuté kvůli API klíči. Dřív se odmítnutí nikde neukázalo: NT8
// posílal starý klíč a obchody se tři dny tiše neimportovaly (2026-10-16 až 19).
// Jen v paměti – po restartu se počítá znovu, protokol dostane první
// odmítnutí po každém přijetí (ne každou sekundu snímku pozic).
const captureRejected = { count: 0, lastAt: null, source: '', lastAcceptedAt: null, loggedSinceAccept: false };
function noteCaptureRequest(state, accepted, source, now) {
  if (accepted) {
    state.lastAcceptedAt = now;
    state.loggedSinceAccept = false;
    return false;
  }
  state.count += 1;
  state.lastAt = now;
  state.source = String(source || '');
  if (state.loggedSinceAccept) return false;
  state.loggedSinceAccept = true;
  return true;
}
// Odmítání trvá = poslední odmítnutí je novější než poslední přijatá zpráva.
function captureRejectedActive(state) {
  return !!(state && state.lastAt && (!state.lastAcceptedAt || state.lastAt > state.lastAcceptedAt));
}
function startCaptureServer() {
  if (captureServer) return;
  captureServer = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
    const url = new URL(req.url, `http://127.0.0.1:${CAPTURE_PORT}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'Futures Journal Trade Capture', version: '2.0', port: CAPTURE_PORT });
    }
    if (url.pathname === '/api/v1/events' && req.method === 'POST') {
      const key = req.headers['x-fj-api-key'] || url.searchParams.get('key');
      const source = String(req.headers['x-fj-source'] || '');
      // Bez složky dat se klíč ověří poslední přečtenou kopií a zpráva jde do
      // zálohy (NT8 neposílá znovu – odmítnutá zpráva by byla pryč).
      const settings = dataDirAvailable() ? readCaptureSettings() : { apiKey: captureKeyCache.key, _readFailed: !captureKeyCache.key };
      // Nastavení se teď nepodařilo přečíst – klíč nejde ověřit, není to odmítnutí.
      if (settings._readFailed) return sendJson(res, 503, { ok: false, error: 'Nastavení nejde přečíst, zkus to znovu.' });
      if (key !== settings.apiKey) {
        if (noteCaptureRequest(captureRejected, false, source, new Date().toISOString())) {
          logInfo('Konektor', `zpráva odmítnuta – neplatný API klíč${source ? ` (${source})` : ''}. Obchody se neimportují, konektor je potřeba přeinstalovat (Integrace → NinjaTrader).`);
        }
        return sendJson(res, 401, { ok: false, error: 'Neplatný API klíč.' });
      }
      noteCaptureRequest(captureRejected, true, source, new Date().toISOString());
      let raw = '';
      req.on('data', chunk => {
        raw += chunk;
        if (raw.length > 2_000_000) req.destroy();
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(raw || '{}');
          const source = payload.source || req.headers['x-fj-source'] || 'external';
          // Chybí složka dat, nebo se ze zálohy ještě přehrávají starší zprávy
          // (pořadí fillů je důležité) → do zálohy.
          if (!dataDirAvailable() || captureSpoolBusy()) {
            spoolCapturePayload(payload, source);
            sendJson(res, 202, { ok: true, spooled: true });
            if (dataDirAvailable()) replayCaptureSpool().catch(error => logError('Záloha konektoru', error));
            return;
          }
          let event;
          try { event = await processIncomingPayload(payload, source); }
          catch (error) {
            // Složka zmizela právě během zpracování – zpráva do zálohy.
            if (error?.code !== 'FJ_DATA_DIR_MISSING') throw error;
            spoolCapturePayload(payload, source);
            return sendJson(res, 202, { ok: true, spooled: true });
          }
          sendJson(res, 201, { ok: true, id: event.id });
        } catch (error) {
          logError('Capture request', error);
          sendJson(res, 400, { ok: false, error: error.message || 'Neplatný požadavek.' });
        }
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Nenalezeno.' });
  });
  captureServer.on('error', error => logError('Capture service', error));
  captureServer.listen(CAPTURE_PORT, '127.0.0.1');
}
// ---------- Záloha zpráv konektoru, když chybí složka dat ----------
// Zprávy se přijmou (202) a připíšou do userData/capture-spool/pending.jsonl
// (jedna zpráva = jeden řádek, pořadí zachované). Až je složka dat zpět,
// replayCaptureSpool je zpracuje v původním pořadí přes processIncomingPayload
// – stejně, jako kdyby právě přišly. Duplicitní fill po přerušeném přehrávání
// zachytí kontrola executionIds.
const captureSpoolDir = () => path.join(app.getPath('userData'), 'capture-spool');
const captureSpoolPath = () => path.join(captureSpoolDir(), 'pending.jsonl');
const captureSpool = { replaying: false };
function spoolCapturePayload(payload, source) {
  fs.mkdirSync(captureSpoolDir(), { recursive: true });
  const now = new Date().toISOString();
  const entry = { spooledAt: now, source, payload: { ...payload, receivedAt: payload.receivedAt || now } };
  fs.appendFileSync(captureSpoolPath(), JSON.stringify(entry) + '\n', 'utf8');
}
function captureSpoolFiles() {
  try { return fs.readdirSync(captureSpoolDir()).filter(n => n === 'pending.jsonl' || /^processing-.*\.jsonl$/.test(n)); }
  catch { return []; }
}
function captureSpoolBusy() {
  return captureSpool.replaying || captureSpoolFiles().length > 0;
}
async function replayCaptureSpool() {
  if (captureSpool.replaying || !dataDirAvailable()) return { ok: true, count: 0, failed: 0 };
  captureSpool.replaying = true;
  let count = 0, failed = 0;
  try {
    const dir = captureSpoolDir();
    // Dokud během přehrávání přibývají nové zprávy, přehrává se dál.
    while (fs.existsSync(captureSpoolPath()) || captureSpoolFiles().some(n => n.startsWith('processing-'))) {
      if (fs.existsSync(captureSpoolPath())) {
        fs.renameSync(captureSpoolPath(), path.join(dir, `processing-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
      }
      for (const file of captureSpoolFiles().filter(n => n.startsWith('processing-')).sort()) {
        const full = path.join(dir, file);
        const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          let entry;
          try { entry = JSON.parse(lines[i]); } catch (error) { failed++; fs.appendFileSync(path.join(dir, `failed-${file}`), lines[i] + '\n'); continue; }
          try {
            await processIncomingPayload(entry.payload || {}, entry.source || 'external');
            count++;
          } catch (error) {
            if (error?.code === 'FJ_DATA_DIR_MISSING') {
              // Složka zase zmizela: nezpracované řádky zůstanou na příště.
              fs.writeFileSync(full, lines.slice(i).join('\n') + '\n', 'utf8');
              logInfo('Záloha konektoru', `přehrávání přerušeno (složka dat chybí), zpracováno ${count}, zbývá ${lines.length - i}`);
              return { ok: false, count, failed, error: error.message };
            }
            failed++;
            fs.appendFileSync(path.join(dir, `failed-${file}`), lines[i] + '\n');
            logError('Záloha konektoru – zprávu nejde zpracovat (zůstává v ' + `failed-${file})`, error);
          }
        }
        fs.rmSync(full, { force: true });
      }
    }
    if (count || failed) logInfo('Záloha konektoru', `zpracováno ${count} zpráv ze zálohy${failed ? `, ${failed} nešlo zpracovat (capture-spool/failed-*)` : ''}`);
    return { ok: true, count, failed };
  } finally {
    captureSpool.replaying = false;
  }
}
async function pollTradingViewRelay() {
  // Relay drží zprávy, dokud je appka nepotvrdí – bez složky dat se nestahuje.
  if (!dataDirAvailable()) return { ok: true, count: 0 };
  const settings = readCaptureSettings();
  if (!settings.relayEnabled || !settings.relayUrl || !settings.relayToken) return { ok: true, count: 0 };
  const base = settings.relayUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/pull?token=${encodeURIComponent(settings.relayToken)}&limit=50`);
  if (!response.ok) throw new Error(`Relay odpověděl HTTP ${response.status}`);
  const data = await response.json();
  const rows = Array.isArray(data.events) ? data.events : [];
  for (const item of rows) await processIncomingPayload(item.payload || item, 'tradingview');
  if (rows.length) {
    await fetch(`${base}/ack?token=${encodeURIComponent(settings.relayToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: rows.map(r => r.id).filter(Boolean) })
    });
  }
  return { ok: true, count: rows.length };
}
function startRelayPolling() {
  if (relayTimer) clearInterval(relayTimer);
  relayTimer = setInterval(() => pollTradingViewRelay().catch(error => logError('TradingView relay poll', error)), 10000);
}

// Seznam účtů pro mapování: účty z historie událostí, účty, které už mapování
// má, a účty přidané ručně. Odstraněné účty se vynechají.
function captureAccountList(settings, events) {
  const deleted = new Set(Array.isArray(settings.deletedAccounts) ? settings.deletedAccounts : []);
  const fromEvents = (Array.isArray(events) ? events : []).map(e => e && e.account).filter(Boolean);
  const fromMappings = Object.keys(settings.accountMappings || {});
  const manual = Array.isArray(settings.manualAccounts) ? settings.manualAccounts : [];
  return [...new Set([...fromEvents, ...fromMappings, ...manual])].filter(a => !deleted.has(a)).sort();
}
ipcMain.handle('capture:addAccount', async (_event, account) => {
  const name = String(account || '').trim();
  if (!name) return { ok: false, error: 'Název účtu je prázdný.' };
  const settings = readCaptureSettings();
  settings.manualAccounts = [...new Set([...(Array.isArray(settings.manualAccounts) ? settings.manualAccounts : []), name])].sort();
  // Ručně přidaný účet nesmí zůstat na seznamu odstraněných, jinak by se
  // hned zase odfiltroval.
  settings.deletedAccounts = (Array.isArray(settings.deletedAccounts) ? settings.deletedAccounts : []).filter(a => a !== name);
  writeCaptureSettings(settings);
  return { ok: true, account: name };
});
ipcMain.handle('capture:status', async () => {
  const settings = readCaptureSettings();
  const events = readCaptureEvents();
  const state = readCaptureState();
  const accounts = captureAccountList(settings, events);
  return {
    ok: true,
    running: !!captureServer,
    port: CAPTURE_PORT,
    endpoint: `http://127.0.0.1:${CAPTURE_PORT}/api/v1/events`,
    health: `http://127.0.0.1:${CAPTURE_PORT}/health`,
    apiKey: settings.apiKey,
    autoImport: settings.autoImport,
    screenshotMode: settings.screenshotMode,
    accountMappings: settings.accountMappings || {},
    hiddenAccounts: Array.isArray(settings.hiddenAccounts) ? settings.hiddenAccounts : [],
    deletedAccounts: Array.isArray(settings.deletedAccounts) ? settings.deletedAccounts : [],
    relayEnabled: settings.relayEnabled,
    relayUrl: settings.relayUrl,
    relayToken: settings.relayToken,
    pending: events.filter(e => !e.imported && e.type === 'trade_closed').length,
    rejected: { count: captureRejected.count, lastAt: captureRejected.lastAt, active: captureRejectedActive(captureRejected) },
    accounts,
    openPositions: openCapturePositions(state)
  };
});
ipcMain.handle('capture:events', async (_event, includeImported=false) => {
  const events = readCaptureEvents();
  return { ok: true, events: includeImported ? events : events.filter(e => !e.imported) };
});
ipcMain.handle('capture:markImported', async (_event, ids) => {
  const set = new Set(Array.isArray(ids) ? ids : []);
  const events = readCaptureEvents().map(e => set.has(e.id) ? { ...e, imported: true, importedAt: new Date().toISOString() } : e);
  writeCaptureEvents(events);
  try { cleanupImportedCaptureScreenshots(events, set); } catch (error) { logError('Úklid screenshotů konektoru', error); }
  return { ok: true };
});
// Automatický screenshot je po importu v úložišti obrázků podruhé. Originál se
// smaže, jen když ho úložiště opravdu převzalo (v tomto běhu aplikace) a když
// na něj nečeká žádná nenaimportovaná událost ani otevřená pozice.
function cleanupImportedCaptureScreenshots(events, importedIds) {
  const waiting = new Set();
  for (const e of events) if (!e.imported) for (const p of e.screenshotPaths || []) waiting.add(path.resolve(String(p)));
  for (const pos of Object.values(readCaptureState().positions || {})) for (const p of pos.entryImages || []) waiting.add(path.resolve(String(p)));
  for (const e of events) {
    if (!importedIds.has(e.id)) continue;
    for (const p of e.screenshotPaths || []) {
      const resolved = path.resolve(String(p));
      if (!storedCapturePaths.has(resolved) || waiting.has(resolved)) continue;
      fs.rmSync(resolved, { force: true });
      storedCapturePaths.delete(resolved);
    }
  }
}
ipcMain.handle('capture:clear', async () => { writeCaptureEvents([]); return { ok: true }; });
ipcMain.handle('capture:clearPositions', async () => { const state = readCaptureState(); state.positions = {}; writeCaptureState(state); return { ok: true }; });
ipcMain.handle('capture:setAutoImport', async (_event, value) => {
  const settings = readCaptureSettings(); settings.autoImport = !!value; writeCaptureSettings(settings); return { ok: true };
});
ipcMain.handle('capture:setScreenshotMode', async (_event, mode) => {
  const settings = readCaptureSettings();
  settings.screenshotMode = ['none','primary','all'].includes(mode) ? mode : 'primary';
  writeCaptureSettings(settings);
  return { ok: true, screenshotMode: settings.screenshotMode };
});
ipcMain.handle('capture:setMappings', async (_event, mappings) => {
  const settings = readCaptureSettings();
  settings.accountMappings = mappings && typeof mappings === 'object' ? mappings : {};
  writeCaptureSettings(settings);
  return { ok: true };
});
ipcMain.handle('capture:setHiddenAccounts', async (_event, accounts) => {
  const settings = readCaptureSettings();
  settings.hiddenAccounts = [...new Set((Array.isArray(accounts) ? accounts : []).map(v => String(v || '').trim()).filter(Boolean))].sort();
  writeCaptureSettings(settings);
  return { ok: true, hiddenAccounts: settings.hiddenAccounts };
});
ipcMain.handle('capture:deleteAccount', async (_event, account) => {
  const value = String(account || '').trim();
  if (!value) return { ok: false, error: 'Chybí účet.' };
  const settings = readCaptureSettings();
  settings.deletedAccounts = [...new Set([...(Array.isArray(settings.deletedAccounts) ? settings.deletedAccounts : []), value])].sort();
  settings.hiddenAccounts = (Array.isArray(settings.hiddenAccounts) ? settings.hiddenAccounts : []).filter(a => a !== value);
  if (settings.accountMappings && typeof settings.accountMappings === 'object') delete settings.accountMappings[value];
  writeCaptureSettings(settings);
  return { ok: true };
});
ipcMain.handle('capture:setRelay', async (_event, relay) => {
  const settings = readCaptureSettings();
  settings.relayEnabled = !!relay?.enabled;
  settings.relayUrl = String(relay?.url || '').trim();
  settings.relayToken = String(relay?.token || '').trim();
  writeCaptureSettings(settings);
  return { ok: true };
});
ipcMain.handle('capture:pollRelay', async () => pollTradingViewRelay());
ipcMain.handle('capture:regenerateKey', async () => {
  const settings = readCaptureSettings(); settings.apiKey = crypto.randomBytes(24).toString('hex'); writeCaptureSettings(settings); return { ok: true, apiKey: settings.apiKey };
});
ipcMain.handle('capture:readScreenshot', async (_event, filePath) => {
  try {
    const resolved = path.resolve(String(filePath || ''));
    if (!resolved.startsWith(path.resolve(screenshotRoot()))) throw new Error('Neplatná cesta screenshotu.');
    return { ok: true, dataUrl: `data:image/png;base64,${fs.readFileSync(resolved).toString('base64')}` };
  } catch (error) { return { ok: false, error: error.message }; }
});


// ---------------------------------------------------------------- NT8 konektor
// Verze konektoru je značka v hlavičce .cs souboru (FJ_CONNECTOR_VERSION: N).
// Konektor nainstalovaný před jejím zavedením ji nemá – ten je verze 1.
function ninjaConnectorVersion(source) {
  const m = /FJ_CONNECTOR_VERSION:\s*(\d+)/.exec(String(source || ''));
  return m ? Number(m[1]) : 1;
}
function ninjaConnectorTargetPath(documentsDir) {
  const customDir = path.join(documentsDir, 'NinjaTrader 8', 'bin', 'Custom');
  const addOnsDir = path.join(customDir, 'AddOns');
  return { customDir, addOnsDir, filePath: path.join(addOnsDir, 'FuturesJournalCapture.cs') };
}
// Ruční postup pro případ, kdy automatická instalace nemá kam zapsat. Import
// v NinjaTraderu (Tools → Import → NinjaScript Add-On) bere jen .zip archiv
// exportovaný z NT, holý .cs soubor z „Uložit konektor" jím nahrát nejde.
const NINJA_MANUAL_INSTALL_HINT = 'Použij „Uložit konektor“, soubor zkopíruj do složky NinjaTrader 8\\bin\\Custom\\AddOns (v Dokumentech, kde má NinjaTrader svá data) a v NinjaTraderu otevři NinjaScript Editor a stiskni F5.';
function sameNinjaPath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
// Všechny .cs soubory ve složce Custom, které deklarují třídu konektoru – ten
// na správném místě i kopie pod jiným jménem (typicky stará ručně importovaná).
// NT kompiluje všechny .cs najednou, takže s dvěma kopiemi by kompilace spadla.
// Jen čte, a asynchronně: Custom mívá stovky souborů a synchronní čtení by
// zastavilo hlavní proces i s příjmem exekucí. Vestavěné skripty NinjaTraderu
// (název začíná „@") se nečtou – konektor mezi nimi být nemůže.
async function findNinjaConnectorCopies(customDir, fsApi) {
  const found = [];
  const walk = async dir => {
    let entries = [];
    try { entries = await fsApi.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.cs$/i.test(entry.name) || entry.name.startsWith('@')) continue;
      let source = '';
      try { source = await fsApi.promises.readFile(full, 'utf8'); } catch { continue; }
      if (/\bclass\s+FuturesJournalCapture\b/.test(source)) found.push({ path: full, source });
    }
  };
  await walk(customDir);
  return found;
}
// Instalace = přepsání JEDNOHO souboru na JEDNOM místě, nic víc (automatická
// instalace dřív dělala problémy). Konkrétně:
//  - nezakládá se složka NinjaTrader 8 – když v Dokumentech není (OneDrive,
//    jiná instalace NT), nezapíše se nic a uživatel dostane ruční postup,
//  - založit se smí jen chybějící podsložka AddOns uvnitř existujícího Custom,
//  - žádná záloha starého souboru: záložní .cs v Custom by NT zkompiloval jako
//    druhou třídu FuturesJournalCapture,
//  - s duplicitní třídou jinde v Custom se nezapisuje – kompilace by selhala.
async function installNinjaConnectorFile({ documentsDir, source, fsApi }) {
  const target = ninjaConnectorTargetPath(documentsDir);
  if (!fsApi.existsSync(target.customDir)) {
    return { ok: false, notFound: true, error: 'Složka NinjaTrader 8 nebyla v Dokumentech nalezena, konektor se nikam nezapsal. ' + NINJA_MANUAL_INSTALL_HINT };
  }
  const duplicates = (await findNinjaConnectorCopies(target.customDir, fsApi))
    .map(copy => copy.path)
    .filter(p => !sameNinjaPath(p, target.filePath));
  if (duplicates.length) {
    return { ok: false, duplicates, error: 'Konektor se nezapsal: v NinjaTraderu je jiná kopie téže třídy, se kterou by kompilace selhala. Smaž ji a zkus to znovu: ' + duplicates.join(', ') };
  }
  if (!fsApi.existsSync(target.addOnsDir)) fsApi.mkdirSync(target.addOnsDir);
  fsApi.writeFileSync(target.filePath, source, 'utf8');
  return { ok: true, path: target.filePath, addOnsDir: target.addOnsDir };
}
// Jen čte: je konektor v NT nainstalovaný a je starší než ten, který aplikace
// nese? Počítá se každá kopie třídy v Custom, nejen soubor na správném místě –
// stará kopie pod jiným jménem je taky „starý konektor" a bez ní by se
// upozornění nikdy neukázalo. Rozhoduje nejstarší nalezená verze.
// API klíč zapsaný v konektoru (konstanta API_KEY v .cs). null = konektor ho
// v téhle podobě nemá a posoudit nejde.
function ninjaConnectorApiKey(source) {
  const m = /\bAPI_KEY\s*=\s*"([^"]*)"/.exec(String(source || ''));
  return m ? m[1] : null;
}
// keyMismatch: některá kopie konektoru posílá jiný klíč, než má aplikace –
// každá její zpráva skončí 401 a obchody se neimportují. Klíč sám se z funkce
// nevrací, jen příznak.
async function ninjaConnectorStatus({ documentsDir, currentVersion, fsApi, apiKey }) {
  const target = ninjaConnectorTargetPath(documentsDir);
  if (!fsApi.existsSync(target.customDir)) return { installed: false, currentVersion };
  const copies = await findNinjaConnectorCopies(target.customDir, fsApi);
  if (!copies.length) return { installed: false, currentVersion };
  const installedVersion = Math.min(...copies.map(copy => ninjaConnectorVersion(copy.source)));
  const keyMismatch = typeof apiKey === 'string' && copies.some(copy => {
    const key = ninjaConnectorApiKey(copy.source);
    return key !== null && key !== apiKey;
  });
  return { installed: true, installedVersion, currentVersion, outdated: installedVersion < currentVersion, keyMismatch };
}
// Verze NinjaTraderu ze záznamu odinstalace ve Windows (výstup `reg query …
// \Uninstall /s`): blok, jehož DisplayName je přesně „NinjaTrader" (ne doplňky
// typu „… pro NinjaTrader 8"), a jeho DisplayVersion. Nenalezeno = ''.
function ninjaTraderVersionFromReg(output) {
  const blocks = String(output || '').split(/\r?\n(?=HKEY_)/);
  for (const block of blocks) {
    const value = name => {
      const m = new RegExp(`^[ \\t]+${name}[ \\t]+REG_\\w+[ \\t]*(.*?)[ \\t\\r]*$`, 'm').exec(block);
      return m ? m[1] : null;
    };
    if (value('DisplayName') === 'NinjaTrader') return value('DisplayVersion') || '';
  }
  return '';
}
const NT_UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
];
// Jen čte registr, asynchronně (hlavní proces přijímá exekuce). Mimo Windows
// nebo bez NT8 v registru (přenosná instalace) vrátí ''.
async function readNinjaTraderVersion() {
  if (process.platform !== 'win32') return '';
  const { execFile } = require('child_process');
  for (const key of NT_UNINSTALL_KEYS) {
    const output = await new Promise(resolve => {
      execFile('reg', ['query', key, '/s'], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout));
    });
    const version = ninjaTraderVersionFromReg(output);
    if (version) return version;
  }
  return '';
}
function ninjaConnectorTemplateSource() {
  return fs.readFileSync(path.join(connectorsDir(), 'NinjaTrader8', 'FuturesJournalCapture.cs'), 'utf8');
}
// Šablona s dosazeným API klíčem – sdílí ji automatická instalace i „Uložit konektor".
function ninjaConnectorSourceWithKey() {
  const settings = readCaptureSettings();
  // Bez přečteného nastavení by se do konektoru zapsal náhodný klíč.
  if (settings._readFailed) throw new Error('Nastavení konektoru teď nejde přečíst, konektor se nezapsal. Zkus to znovu.');
  return ninjaConnectorTemplateSource().replace('SEM_VLOZ_API_KLIC_Z_APLIKACE', settings.apiKey);
}

ipcMain.handle('capture:installNinjaConnector', async () => {
  try {
    const result = await installNinjaConnectorFile({ documentsDir: app.getPath('documents'), source: ninjaConnectorSourceWithKey(), fsApi: fs });
    if (result.ok) {
      // Přeinstalace vyřizuje i upozornění po aktualizaci NT8.
      const ntVersion = await readNinjaTraderVersion();
      const settings = readCaptureSettings();
      if (!settings._readFailed) writeCaptureSettings({ ...settings, ntConnectorSeen: true, ...(ntVersion ? { ntSeenVersion: ntVersion } : {}) });
      await shell.openPath(result.addOnsDir);
    }
    return result;
  } catch (error) {
    logError('Install NinjaTrader connector', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('capture:ninjaConnectorStatus', async () => {
  try {
    const currentVersion = ninjaConnectorVersion(ninjaConnectorTemplateSource());
    const settings = readCaptureSettings();
    const status = await ninjaConnectorStatus({ documentsDir: app.getPath('documents'), currentVersion, fsApi: fs, apiKey: settings._readFailed ? undefined : settings.apiKey });
    // Pamatuje si, že konektor kdy nainstalovaný byl – upozornění po
    // aktualizaci NT8 pak platí i tehdy, když ho aktualizace odstranila.
    if (status.installed && !settings.ntConnectorSeen && !settings._readFailed) writeCaptureSettings({ ...settings, ntConnectorSeen: true });
    const ntVersion = await readNinjaTraderVersion();
    return {
      ...status,
      ntVersion,
      ntSeenVersion: settings.ntSeenVersion || '',
      ntUpdateNotice: settings.ntUpdateNotice !== false,
      ntConnectorSeen: !!(settings.ntConnectorSeen || status.installed),
      rejectedActive: captureRejectedActive(captureRejected)
    };
  } catch (error) {
    logError('NinjaTrader connector status', error);
    return { installed: false };
  }
});
// Uživatel upozornění po aktualizaci NT8 vyřídil (přeinstaloval, nebo jen
// první zjištění verze) – tahle verze už se hlásit nebude.
ipcMain.handle('capture:ackNinjaTraderVersion', async (_event, version) => {
  try {
    const settings = readCaptureSettings();
    writeCaptureSettings({ ...settings, ntSeenVersion: String(version || '') });
    return { ok: true };
  } catch (error) { logError('capture:ackNinjaTraderVersion', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('capture:setNtUpdateNotice', async (_event, value) => {
  try {
    const settings = readCaptureSettings();
    writeCaptureSettings({ ...settings, ntUpdateNotice: value !== false });
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('capture:prepareTradingViewPine', async () => {
  try {
    const source = fs.readFileSync(path.join(connectorsDir(), 'TradingView', 'FuturesJournalAlertConnector.pine'), 'utf8');
    clipboard.writeText(source);
    await shell.openExternal('https://www.tradingview.com/chart/');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('capture:prepareTradingViewWorker', async () => {
  try {
    const source = fs.readFileSync(path.join(connectorsDir(), 'TradingViewRelayWorker', 'worker.js'), 'utf8');
    clipboard.writeText(source);
    await shell.openExternal('https://dash.cloudflare.com/');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('capture:exportNinjaConnector', async () => {
  try {
    const source = ninjaConnectorSourceWithKey();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Uložit připravený konektor pro NinjaTrader 8',
      defaultPath: path.join(app.getPath('downloads'), 'FuturesJournalCapture.cs'),
      filters: [{ name: 'NinjaScript C#', extensions: ['cs'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, source, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    logError('Export NinjaTrader connector', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('capture:installCTraderConnector', async () => {
  try {
    const settings = readCaptureSettings();
    const templatePath = path.join(connectorsDir(), 'cTrader', 'FuturesJournalCTraderConnector.cs');
    let source = fs.readFileSync(templatePath, 'utf8');
    source = source.replace('SEM_VLOZ_API_KLIC_Z_APLIKACE', settings.apiKey);
    const robotName = 'FuturesJournalCTraderConnector';
    const robotsRoot = path.join(app.getPath('documents'), 'cAlgo', 'Sources', 'Robots', robotName);
    // Když vytvoříš nový cBot v cTraderu přes Algo → cBots → New, cTrader sám
    // vytvoří vnořenou strukturu Robots\<Název>\<Název>\<Název>.cs (spolu s
    // .csproj, .sln a GlobalUsings.cs, které si spravuje sám). Tohle tlačítko
    // takový už existující projekt najde a jen aktualizuje jeho .cs soubor –
    // nezakládá projekt od nuly, protože obsah .csproj/.sln je specifický pro
    // verzi cTraderu a jeho ruční vytvoření by mohlo projekt rozbít.
    const nestedPath = path.join(robotsRoot, robotName, `${robotName}.cs`);
    if (fs.existsSync(nestedPath)) {
      fs.writeFileSync(nestedPath, source, 'utf8');
      await shell.openPath(path.dirname(nestedPath));
      return { ok: true, updated: true, path: nestedPath };
    }
    return {
      ok: false,
      notFound: true,
      error: 'Projekt cBota v cTraderu ještě neexistuje. Nejdřív ho jednou vytvoř přes Algo → cBots → New (viz návod výše) – pak tímto tlačítkem půjde kdykoliv aktualizovat na novou verzi bez ručního kopírování.'
    };
  } catch (error) {
    logError('Install cTrader connector', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('capture:exportCTraderConnector', async () => {
  try {
    const settings = readCaptureSettings();
    const templatePath = path.join(connectorsDir(), 'cTrader', 'FuturesJournalCTraderConnector.cs');
    let source = fs.readFileSync(templatePath, 'utf8');
    source = source.replace('SEM_VLOZ_API_KLIC_Z_APLIKACE', settings.apiKey);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Uložit připravený konektor pro cTrader',
      defaultPath: path.join(app.getPath('downloads'), 'FuturesJournalCTraderConnector.cs'),
      filters: [{ name: 'cAlgo cBot C#', extensions: ['cs'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, source, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    logError('Export cTrader connector', error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('capture:exportTradingViewConnector', async () => {
  try {
    const templatePath = path.join(connectorsDir(), 'TradingView', 'FuturesJournalAlertConnector.pine');
    const source = fs.readFileSync(templatePath, 'utf8');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Uložit TradingView Pine Script',
      defaultPath: path.join(app.getPath('downloads'), 'FuturesJournalAlertConnector.pine'),
      filters: [{ name: 'TradingView Pine Script', extensions: ['pine'] }, { name: 'Textový soubor', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, source, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    logError('Export TradingView connector', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('capture:exportTradingViewWorker', async () => {
  try {
    const templatePath = path.join(connectorsDir(), 'TradingViewRelayWorker', 'worker.js');
    const source = fs.readFileSync(templatePath, 'utf8');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Uložit TradingView webhook relay',
      defaultPath: path.join(app.getPath('downloads'), 'FuturesJournalTradingViewWorker.js'),
      filters: [{ name: 'JavaScript', extensions: ['js'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, source, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    logError('Export TradingView worker', error);
    return { ok: false, error: error.message };
  }
});

// Ruční import z NinjaTraderu: renderer pošle exekuce převedené z CSV
// (app/nt8import.js) a dostane uzavřené obchody k náhledu. Nic se neukládá.
ipcMain.handle('capture:manualReplay', async (_event, payloads) => {
  try {
    if (!Array.isArray(payloads) || payloads.length > 20000) return { ok: false, error: 'Neplatný seznam exekucí.' };
    return { ok: true, ...(await manualImportReplay(payloads)) };
  } catch (error) {
    logError('capture:manualReplay', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('capture:openConnectorFolder', async () => {
  try {
    const { shell } = require('electron');
    const folder = connectorsDir();
    const error = await shell.openPath(folder);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

// ---- Screenshoty obchodů: kopírování do schránky a otevření ve výchozím prohlížeči obrázků ----
function dataUrlToBuffer(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  return { buffer: Buffer.from(match[2], 'base64'), ext: imageExtension(match[1]) };
}
function openImageExternally(sourceValue) {
  const source = storeRefOf(sourceValue);
  // U obrázku uloženého jako soubor se otevře rovnou on – není důvod dělat
  // kopii v TEMPu a plnit disk druhou sadou screenshotů.
  const stored = imageRefPath(source);
  if (stored && fs.existsSync(stored)) {
    shell.openPath(stored).then(err => { if (err) logError('openImageExternally', err); });
    return { ok: true };
  }
  const parsed = dataUrlToBuffer(source);
  if (!parsed) return { ok: false, error: 'Neplatný formát obrázku.' };
  try {
    const tmpDir = path.join(app.getPath('temp'), 'futures-journal-screenshots');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `screenshot-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${parsed.ext}`);
    fs.writeFileSync(filePath, parsed.buffer);
    shell.openPath(filePath).then(err => { if (err) logError('openImageExternally', err); });
    return { ok: true };
  } catch (error) {
    logError('openImageExternally', error);
    return { ok: false, error: error.message };
  }
}
async function saveImageAs(source) {
  const parsed = imageToBuffer(source);
  if (!parsed) return { ok: false, error: 'Neplatný formát obrázku.' };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Uložit obrázek jako',
    defaultPath: `screenshot-${Date.now()}.${parsed.ext}`,
    filters: [{ name: 'Obrázek', extensions: [parsed.ext] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, parsed.buffer);
  return { ok: true, path: result.filePath };
}
ipcMain.handle('image:copyToClipboard', async (_event, source) => {
  const parsed = imageToBuffer(source);
  if (!parsed) return { ok: false, error: 'Neplatný formát obrázku.' };
  try {
    clipboard.writeImage(nativeImage.createFromBuffer(parsed.buffer));
    return { ok: true };
  } catch (error) {
    logError('image:copyToClipboard', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('image:openExternally', async (_event, source) => openImageExternally(source));
ipcMain.handle('image:saveAs', async (_event, source) => saveImageAs(source));
// Renderer sem posílá JEDEN obrázek (zmenšený a převedený na WebP) a dostane
// zpátky krátký odkaz, který si uloží k obchodu. Přes IPC tak nikdy neteče
// celý deník s obrázky, jen jednotky set kB.
ipcMain.handle('image:store', async (_event, dataUrl) => {
  try {
    const ref = storeImageDataUrl(dataUrl);
    return ref ? { ok: true, ref } : { ok: false, error: 'Neplatný formát obrázku.' };
  } catch (error) {
    logError('image:store', error);
    return { ok: false, error: error.message };
  }
});
// Automatické screenshoty jsou už na disku jako PNG – uloží se do úložiště
// rovnou ze souboru, bez oklikou přes base64 v rendereru.
// `record` (datum, čas vstupu, instrument, směr) dá screenshotu rovnou čitelné
// jméno; stejný obrázek (vstupní screenshot sdílený nohami pozice) se uloží
// jen jednou. Originál v trade-capture/screenshots se smaže až po označení
// události jako naimportované (capture:markImported), když ho už nic nečeká.
const storedCapturePaths = new Set();
ipcMain.handle('image:storeCapture', async (_event, filePath, record) => {
  try {
    const resolved = path.resolve(String(filePath || ''));
    if (!resolved.startsWith(path.resolve(screenshotRoot()) + path.sep)) throw new Error('Neplatná cesta screenshotu.');
    let ref = storeImageBuffer(fs.readFileSync(resolved), imageExtension(`image/${path.extname(resolved).slice(1) || 'png'}`));
    if (record) ref = assignImageNames([ref], record, null)[ref] || ref;
    storedCapturePaths.add(resolved);
    return { ok: true, ref };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('image:assignNames', async (_event, refs, record, owner) => {
  try { return { ok: true, mapping: assignImageNames(refs, record, owner) }; }
  catch (error) { logError('image:assignNames', error); return { ok: false, error: error.message, mapping: {} }; }
});
// Náhled vytváří renderer (canvas → WebP) a posílá ho sem; jen WebP, jen do
// složky náhledů a jen pro existující obrázek.
ipcMain.handle('image:storeThumb', async (_event, ref, dataUrl) => {
  try {
    const name = imageRefName(storeRefOf(ref));
    const file = name ? imageRefPath(IMAGE_REF_PREFIX + name) : null;
    const parsed = dataUrlToBuffer(dataUrl);
    if (!file || !fs.existsSync(file) || !parsed || parsed.ext !== 'webp' || parsed.buffer.length > 2 * 1024 * 1024) return { ok: false, error: 'Neplatný náhled.' };
    fs.mkdirSync(thumbsRoot(), { recursive: true });
    const target = thumbPath(path.basename(file));
    fs.writeFileSync(`${target}.tmp`, parsed.buffer);
    fs.renameSync(`${target}.tmp`, target);
    return { ok: true };
  } catch (error) { logError('image:storeThumb', error); return { ok: false, error: error.message }; }
});

ipcMain.handle('capture:testExecutionSequence', async () => {
  const base = Date.now();
  const common = { source:'ninjatrader', type:'execution', account:'SIM101', instrument:'NQ', instrumentFull:'NQ 09-26', pointValue:20, rate:1 };
  await processIncomingPayload({ ...common, executionId:`test-entry-${base}`, time:new Date(base).toISOString(), price:20000, quantity:1, orderAction:'Buy', commission:2.5 }, 'ninjatrader');
  await processIncomingPayload({ ...common, executionId:`test-exit-${base}`, time:new Date(base+60000).toISOString(), price:20010, quantity:1, orderAction:'Sell', commission:2.5 }, 'ninjatrader');
  return { ok: true };
});
// Simuluje pozici se 3 kontrakty uzavíranou na TP1 / Break Even / TP2 – slouží k ověření
// automatického slučování obchodů (funkce "Sloučit vybrané" / automatické slučování legů).
ipcMain.handle('capture:testMultiTargetSequence', async () => {
  const base = Date.now();
  const common = { source:'ninjatrader', type:'execution', account:'SIM101', instrument:'NQ', instrumentFull:'NQ 09-26', pointValue:20, rate:1 };
  await processIncomingPayload({ ...common, executionId:`test-mt-entry-${base}`, time:new Date(base).toISOString(), price:20000, quantity:3, orderAction:'Buy', commission:2.5 }, 'ninjatrader');
  await processIncomingPayload({ ...common, executionId:`test-mt-tp1-${base}`, time:new Date(base+45000).toISOString(), price:20010, quantity:1, orderAction:'Sell', commission:2.5 }, 'ninjatrader');
  await processIncomingPayload({ ...common, executionId:`test-mt-be-${base}`, time:new Date(base+120000).toISOString(), price:20000, quantity:1, orderAction:'Sell', commission:2.5 }, 'ninjatrader');
  await processIncomingPayload({ ...common, executionId:`test-mt-tp2-${base}`, time:new Date(base+300000).toISOString(), price:20022, quantity:1, orderAction:'Sell', commission:2.5 }, 'ninjatrader');
  return { ok: true };
});
// Simuluje dokup: vstup 2 kontrakty, TP1 jeden, dokup jednoho kontraktu výš
// a TP2, který zavře zbytek – tedy jeden kontrakt z původního vstupu a jeden
// dokoupený. V deníku má vzniknout jeden obchod: TP1 +10 b, TP2 +30 b
// a „TP2 · dokup" +15 b, s řádkem „Vstupy: 2 @ 20000 · dokup 1 @ 20015".
ipcMain.handle('capture:testScaleInSequence', async () => {
  const base = Date.now();
  const common = { source:'ninjatrader', type:'execution', account:'SIM101', instrument:'NQ', instrumentFull:'NQ 09-26', pointValue:20, rate:1 };
  const step = (name, offset, fields) => processIncomingPayload({ ...common, executionId:`test-si-${name}-${base}`, orderId:`test-si-order-${name}-${base}`, time:new Date(base+offset).toISOString(), ...fields }, 'ninjatrader');
  await step('entry', 0, { price:20000, quantity:2, orderAction:'Buy', orderName:'Entry', positionAfter:2, commission:5 });
  await step('tp1', 60000, { price:20010, quantity:1, orderAction:'Sell', orderName:'Target1', positionAfter:1, commission:2.5 });
  await step('dokup', 120000, { price:20015, quantity:1, orderAction:'Buy', orderName:'Entry', positionAfter:2, commission:2.5 });
  await step('tp2', 300000, { price:20030, quantity:2, orderAction:'Sell', orderName:'Target2', positionAfter:0, commission:5 });
  return { ok: true };
});
// Simuluje cTrader pozici uzavřenou přes dva cíle (TP1 a TP2) se stejným
// positionId – ověří, že se konektor/merge chová stejně jako u NinjaTraderu.
ipcMain.handle('capture:testCTraderSequence', async () => {
  const base = Date.now();
  const positionId = `ctrader-test-${base}`;
  const common = { source:'ctrader', account:'FTMO-TEST', instrument:'EURUSD', instrumentFull:'EURUSD' };
  await processIncomingPayload({ ...common, type:'ctrader_position_opened', side:'long', entryTime:new Date(base).toISOString(), entryPrice:1.1000, quantity:200000, positionId, strategy:'Test cBot' }, 'ctrader');
  await processIncomingPayload({ ...common, type:'ctrader_trade_closed', side:'long', entryTime:new Date(base).toISOString(), entryPrice:1.1000, exitTime:new Date(base+45000).toISOString(), exitPrice:1.1020, quantity:100000, points:20, pnl:200, commission:2, swap:0, positionId, closingDealId:`test-deal-tp1-${base}`, strategy:'Test cBot' }, 'ctrader');
  await processIncomingPayload({ ...common, type:'ctrader_trade_closed', side:'long', entryTime:new Date(base).toISOString(), entryPrice:1.1000, exitTime:new Date(base+90000).toISOString(), exitPrice:1.1035, quantity:100000, points:35, pnl:350, commission:2, swap:0, positionId, closingDealId:`test-deal-tp2-${base}`, strategy:'Test cBot' }, 'ctrader');
  return { ok: true };
});
// Simuluje reálný závod z 8. 9. 2026: snímek pozic dorazí o pár milisekund DŘÍV
// než vstupní exekuce, která ho způsobila. Ověřuje, že se vstup nezapočítá
// podruhé (2 kontrakty, ne 4), že pozice má positionId (bez něj se dva výstupy
// uložily jako dva samostatné obchody) a že si udrží vstupní komisi i název
// vstupního příkazu ("Entry", ne "Stop1"/"Stop2").
ipcMain.handle('capture:testSnapshotRaceSequence', async () => {
  const base = Date.now();
  const account = 'SIM101';
  const instrument = { instrument:'MES', instrumentFull:'MES 09-26' };
  const common = { source:'ninjatrader', type:'execution', account, ...instrument, pointValue:5, rate:1 };
  const snapshot = (quantity, marketPosition) => ({
    source:'ninjatrader', type:'position_snapshot', account, time:new Date().toISOString(),
    positions: quantity ? [{ ...instrument, quantity, avgPrice:7685, marketPosition, pointValue:5 }] : []
  });
  await processIncomingPayload(snapshot(2, 'Short'), 'ninjatrader');
  await processIncomingPayload({ ...common, executionId:`test-sr-entry-${base}`, time:new Date(base).toISOString(), price:7685, quantity:2, orderAction:'Sell', orderName:'Entry', commission:1.02 }, 'ninjatrader');
  await processIncomingPayload(snapshot(2, 'Short'), 'ninjatrader');
  await processIncomingPayload({ ...common, executionId:`test-sr-stop1-${base}`, time:new Date(base+95000).toISOString(), price:7688, quantity:1, orderAction:'BuyToCover', orderName:'Stop1', commission:0.51 }, 'ninjatrader');
  await processIncomingPayload(snapshot(1, 'Short'), 'ninjatrader');
  await processIncomingPayload({ ...common, executionId:`test-sr-stop2-${base}`, time:new Date(base+95000).toISOString(), price:7688, quantity:1, orderAction:'BuyToCover', orderName:'Stop2', commission:0.51 }, 'ninjatrader');
  await processIncomingPayload(snapshot(0), 'ninjatrader');
  return { ok: true };
});

// ---------- Automatické aktualizace ----------
// Aplikace si na GitHubu sama zjistí novou finální verzi (release označený
// „Latest“ – testovací pre-release se sama nenabízí) a NABÍDNE ji. Bez
// potvrzení se nic nestahuje ani neinstaluje: aplikace běží na pozadí a
// zaznamenává exekuce, restart uprostřed otevřené pozice by je ztratil.
// Testovací pre-release (větev test) se hledá jen ručně, tlačítkem, které si
// uživatel musí v Nastavení sám zapnout – viz checkForUpdates(manual, test).
const UPDATE_REPO = { owner: 'Braunn318', repo: 'futures-journal-pro' };
// Po startu Windows ještě nemusí běžet síť, proto první kontrola až za chvíli.
// Další v intervalu – aplikace běží u hodin klidně několik dní bez restartu.
const UPDATE_FIRST_CHECK_MS = 30 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_NOTES_MAX = 1800;
const UPDATE_CHECK_FAILED = 'Kontrolu aktualizací se nepodařilo dokončit – GitHub neodpověděl nebo není připojení k internetu. Podrobnosti jsou v chybovém protokolu.';
// Kód, kterým electron-updater hlásí, že poslední finální vydání na GitHubu
// nenese latest.yml, tedy ani instalátor (vydání před 4.8.3 ho neměla).
const UPDATE_NO_INSTALLER_CODE = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
let updateNoInstallerLogged = false;
const UPDATE_DOWNLOAD_FAILED = 'Stažení aktualizace se nezdařilo. Zkontroluj připojení k internetu a zkus to znovu; podrobnosti jsou v chybovém protokolu.';
let autoUpdater = null;
// status: unsupported (spuštěno ze zdrojových souborů) | idle | checking |
// none (aktuální verze) | available | downloading | downloaded | error
// channel: jaké vydání je nalezené – 'stable' (finální) | 'test' (pre-release).
let updateState = { status: 'unsupported', currentVersion: app.getVersion(), version: null, percent: 0, error: null, notes: '', channel: 'stable' };

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', updateState);
  refreshTrayMenu();
}
// Seznam změn je text stažený z internetu: do okna jde jen jako prostý text
// (renderer ho vkládá přes textContent) a zkrácený na celé řádky.
function cleanReleaseNotes(body, max = UPDATE_NOTES_MAX) {
  const text = String(body || '').replace(/\r\n?/g, '\n').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastLine = cut.lastIndexOf('\n');
  return (lastLine > max / 2 ? cut.slice(0, lastLine) : cut).trimEnd() + '\n…';
}
// Tělo releasu na GitHubu = odrážky dané verze z CHANGELOG.txt. Když se
// nenačte, nabídka se ukáže bez seznamu změn.
async function fetchReleaseNotes(tag) {
  try {
    const url = `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tags/${encodeURIComponent(tag)}`;
    const response = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return '';
    return cleanReleaseNotes((await response.json())?.body);
  } catch (error) {
    logError('Auto-update release notes', error);
    return '';
  }
}
// Testovací vydání má tag s příponou (v4.8.6-test, v4.8.6-test.2), finální
// jen číslo. Verze v instalátoru je u obou stejná X.Y.Z, pozná se to jen z tagu.
function releaseChannelFromTag(tag) {
  const prerelease = /^v?\d+\.\d+\.\d+-/.test(String(tag || ''));
  return prerelease ? 'test' : 'stable';
}
async function onUpdateAvailable(info) {
  const version = String(info?.version || '');
  // Kontrola testovacích verzí bere nejnovější vydání vůbec – může to být
  // i finální. Kanál proto říká, co se našlo, ne čím se hledalo.
  const tag = String(info?.tag || `v${version}`);
  // Stav se přepne až se seznamem změn, aby ho nabídka měla hned při otevření.
  const notes = await fetchReleaseNotes(tag);
  setUpdateState({ status: 'available', version, percent: 0, error: null, notes, channel: releaseChannelFromTag(tag) });
}
// Porovnání verzí X.Y.Z podle čísel: záporné, když a < b. Přípona za pomlčkou
// (např. „-test“) se nepočítá.
function compareVersions(a, b) {
  const parts = v => String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}
// Vydání bez instalátoru není chyba připojení: GitHub odpověděl a adresa
// v chybě nese verzi posledního finálního vydání. Bez téhle verze (jiná chyba,
// nečitelná adresa) vrací null a kontrola se bere jako nepovedená.
function releaseVersionFromUpdateError(error) {
  if (error?.code !== UPDATE_NO_INSTALLER_CODE) return null;
  const match = /\/releases\/download\/v?(\d+\.\d+\.\d+[^/]*)\//.exec(String(error?.message || ''));
  return match ? match[1] : null;
}
function updateWithoutInstallerMessage(version) {
  return `Na GitHubu je verze ${version}, ale bez instalátoru pro automatickou aktualizaci. Stáhni ji ručně ze stránky vydání: github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`;
}
function initAutoUpdate() {
  // Ze zdrojových souborů (npm start) není co aktualizovat a modul se ani
  // nenačítá. Chyba aktualizací nesmí nikdy zabránit startu aplikace.
  if (!app.isPackaged || process.platform !== 'win32') return false;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    logError('Auto-update init', error);
    return false;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  // Jen první řádek: chyba sítě od GitHubu s sebou nese výpis hlaviček na
  // desítky řádků a kontrola se opakuje každých pár hodin. Vydání bez
  // instalátoru chyba není – to si zapisuje checkForUpdates, jednou.
  autoUpdater.on('error', error => {
    if (releaseVersionFromUpdateError(error)) return;
    logError('Auto-update', String(error?.message || error).split('\n')[0].slice(0, 300));
  });
  autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', info => onUpdateAvailable(info));
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'none', version: null, percent: 0, notes: '', channel: 'stable' }));
  autoUpdater.on('download-progress', progress => setUpdateState({ status: 'downloading', percent: Math.round(progress?.percent || 0) }));
  autoUpdater.on('update-downloaded', () => setUpdateState({ status: 'downloaded', percent: 100, error: null }));
  setUpdateState({ status: 'idle' });
  setTimeout(() => checkForUpdates(false), UPDATE_FIRST_CHECK_MS);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
  return true;
}
// test = true: hledá se i mezi testovacími pre-release (jen ručně, z tlačítka
// v Nastavení). Bez něj jen finální vydání – tak běží i každá automatická
// kontrola, bez ohledu na to, co se hledalo naposledy.
async function checkForUpdates(manual, test = false) {
  if (!autoUpdater) return { ok: false, unsupported: true };
  // Rozběhnutou kontrolu, stahování ani hotový stažený instalátor nová
  // kontrola nepřepisuje.
  if (['checking', 'downloading', 'downloaded'].includes(updateState.status)) return { ok: true };
  // Automatická kontrola hledá jen finální verze a testovací nabídku, kterou
  // si uživatel před chvílí sám vyžádal, by přepsala na „máš aktuální verzi“.
  if (!manual && updateState.status === 'available' && updateState.channel === 'test') return { ok: true };
  const before = updateState.status;
  try {
    autoUpdater.allowPrerelease = !!test;
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    const releaseVersion = releaseVersionFromUpdateError(error);
    if (releaseVersion) {
      if (!updateNoInstallerLogged) {
        updateNoInstallerLogged = true;
        logInfo('Auto-update', `Poslední ${test ? 'vydání (včetně testovacích)' : 'finální vydání'} ${releaseVersion} nenese instalátor pro automatickou aktualizaci (nainstalovaná verze ${updateState.currentVersion}).`);
      }
      // Stejné nebo starší vydání než nainstalovaná verze: není co
      // aktualizovat, ať už instalátor má, nebo ne.
      if (compareVersions(releaseVersion, updateState.currentVersion) <= 0) {
        setUpdateState({ status: 'none', version: null, percent: 0, error: null, notes: '', channel: 'stable' });
        return { ok: true };
      }
      const message = updateWithoutInstallerMessage(releaseVersion);
      setUpdateState({ status: 'error', version: null, percent: 0, error: message, notes: '', channel: 'stable' });
      return { ok: false, error: message };
    }
    // Automatická kontrola selhává tiše (po startu Windows bez sítě, GitHub
    // nedostupný) – v protokolu je, uživatele neruší a už nalezená verze
    // zůstává v nabídce. Ruční kontrola chybu ukáže.
    if (manual) setUpdateState({ status: 'error', error: UPDATE_CHECK_FAILED });
    else setUpdateState({ status: before === 'available' ? 'available' : 'idle', error: null });
    return { ok: false, error: UPDATE_CHECK_FAILED };
  }
}
async function downloadUpdate() {
  if (!autoUpdater || updateState.status !== 'available') return { ok: false, error: 'Žádná aktualizace ke stažení.' };
  setUpdateState({ status: 'downloading', percent: 0, error: null });
  try {
    await autoUpdater.downloadUpdate();
    // Renderer po návratu rovnou instaluje – stav musí být „staženo“ bez
    // ohledu na to, jestli událost update-downloaded už dorazila.
    if (updateState.status !== 'downloaded') setUpdateState({ status: 'downloaded', percent: 100, error: null });
    return { ok: true };
  } catch (error) {
    setUpdateState({ status: 'available', percent: 0, error: UPDATE_DOWNLOAD_FAILED });
    return { ok: false, error: UPDATE_DOWNLOAD_FAILED };
  }
}
function installUpdate() {
  if (!autoUpdater || updateState.status !== 'downloaded') return { ok: false, error: 'Aktualizace ještě není stažená.' };
  // Zavření okna ho jinak jen schová (viz 'close' v createWindow) – aplikace
  // by zůstala běžet a instalátor by ji musel ukončit natvrdo.
  isQuitting = true;
  // Tichá instalace do stávající složky, po ní se aplikace sama spustí.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
}
// Z menu ikony u hodin: otevře okno a řekne rendereru, ať nabídku ukáže
// i tehdy, když ji uživatel v tomhle spuštění už odložil.
function requestUpdateOffer() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  focusMainWindow();
  mainWindow.webContents.send('update:state', { ...updateState, requested: true });
}
// ---------- Odkazy do systémového prohlížeče ----------
// Renderer smí otevřít jen http/https adresu – nic jiného (file:, javascript:,
// vlastní schémata) se do shellu nepustí.
function externalUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}
ipcMain.handle('shell:openExternal', async (_event, value) => {
  const url = externalUrl(value);
  if (!url) return { ok: false, error: 'Adresa musí začínat https:// nebo http://.' };
  try { await shell.openExternal(url); return { ok: true }; }
  catch (error) { logError('shell:openExternal', error); return { ok: false, error: error.message }; }
});

// ---------- Kalendář makro zpráv (ForexFactory) ----------
// Zdroj je veřejný týdenní JSON (výchozí nfs.faireconomy.media, adresa jde
// změnit v Nastavení): [{ title, country, date (ISO s posunem), impact, forecast,
// previous }]. Dává jen AKTUÁLNÍ týden, takže si deník stažené týdny drží
// v mezipaměti news-calendar.json v datové složce – historie roste od prvního
// stažení. Stahuje se nejvýš jednou za hodinu (ručně jednou za 5 minut), ať
// zdroj nezahltíme; selhání se jen zapíše do protokolu a platí mezipaměť.
const NEWS_FEED_DEFAULT = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const NEWS_MIN_INTERVAL_MS = 60 * 60 * 1000;
const NEWS_MANUAL_INTERVAL_MS = 5 * 60 * 1000;
const newsCachePath = () => path.join(resolveDataDir(), 'news-calendar.json');
const NEWS_TEXT_MAX = 160;
function newsText(value) { return typeof value === 'string' ? value.trim().slice(0, NEWS_TEXT_MAX) : ''; }
// Jen platné události: čas jde přečíst, název a měna jsou text. Ostatní se
// zahodí (cizí data, nikdy se z nich nic nespouští ani nevkládá jako HTML).
function normalizeNewsEvents(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const date = newsText(e.date);
    const time = Date.parse(date);
    const title = newsText(e.title);
    const country = newsText(e.country).toUpperCase();
    if (!title || !country || !Number.isFinite(time)) continue;
    out.push({ title, country, date: new Date(time).toISOString(), impact: newsText(e.impact), forecast: newsText(e.forecast), previous: newsText(e.previous) });
  }
  return out;
}
// Nový týden nahradí v mezipaměti všechny události ve stejném rozsahu dnů
// (zdroj mohl událost přesunout nebo zrušit); ostatní týdny zůstávají.
function mergeNewsEvents(cached, fresh) {
  const old = Array.isArray(cached) ? cached : [];
  if (!fresh.length) return old.slice();
  const day = iso => iso.slice(0, 10);
  const days = fresh.map(e => day(e.date)).sort();
  const from = days[0], to = days[days.length - 1];
  const kept = old.filter(e => day(e.date) < from || day(e.date) > to);
  return [...kept, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
}
function readNewsCache() {
  try {
    const data = JSON.parse(fs.readFileSync(newsCachePath(), 'utf8'));
    return { fetchedAt: data.fetchedAt || null, attemptAt: data.attemptAt || null, error: data.error || null, events: Array.isArray(data.events) ? data.events : [] };
  } catch { return { fetchedAt: null, attemptAt: null, error: null, events: [] }; }
}
function writeNewsCache(cache) {
  fs.mkdirSync(path.dirname(newsCachePath()), { recursive: true });
  const temp = newsCachePath() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(cache), 'utf8');
  fs.renameSync(temp, newsCachePath());
}
let newsFetching = null;
async function refreshNewsCalendar({ feedUrl, manual } = {}) {
  const cache = readNewsCache();
  const url = externalUrl(feedUrl || NEWS_FEED_DEFAULT);
  if (!url || !url.startsWith('https:')) return { ...cache, error: 'Adresa zdroje musí začínat https://.' };
  const last = Date.parse(cache.attemptAt || '') || 0;
  if (Date.now() - last < (manual ? NEWS_MANUAL_INTERVAL_MS : NEWS_MIN_INTERVAL_MS)) return { ...cache, skipped: true };
  if (newsFetching) return newsFetching;
  newsFetching = (async () => {
    const attemptAt = new Date().toISOString();
    try {
      const response = await net.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const fresh = normalizeNewsEvents(await response.json());
      if (!fresh) throw new Error('Zdroj nevrátil seznam událostí.');
      const next = { fetchedAt: attemptAt, attemptAt, error: null, events: mergeNewsEvents(cache.events, fresh) };
      writeNewsCache(next);
      return next;
    } catch (error) {
      logError('Kalendář zpráv', error);
      const next = { ...cache, attemptAt, error: String(error?.message || error) };
      try { writeNewsCache(next); } catch (e) { logError('Kalendář zpráv – mezipaměť', e); }
      return next;
    } finally { newsFetching = null; }
  })();
  return newsFetching;
}
ipcMain.handle('news:get', () => readNewsCache());
ipcMain.handle('news:refresh', (_event, options) => refreshNewsCalendar(options || {}));

ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('update:getState', () => updateState);
ipcMain.handle('update:check', (_event, options) => checkForUpdates(true, !!options?.test));
ipcMain.handle('update:download', () => downloadUpdate());
ipcMain.handle('update:install', () => installUpdate());

process.on('uncaughtException', error => {
  logError('Uncaught exception', error);
  dialog.showErrorBox('Futures Journal PRO – chyba', `${error.message}\n\nProtokol: ${logPath()}`);
});
process.on('unhandledRejection', error => logError('Unhandled rejection', error));

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else focusMainWindow();
});

// Vlastní složka dat, která chybí (odpojený disk, smazaná aktualizací), se už
// potichu nenahradí výchozí AppData – uživatel by viděl prázdný deník nebo
// starou kopii a nevěděl proč. Ukazatel v data-location.json se nemaže.
function checkDataLocationAtStartup() {
  for (;;) {
    const custom = readDataLocationConfig().customDataDir;
    if (!custom || fs.existsSync(custom)) break;
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Futures Journal PRO',
      message: 'Složka s daty nebyla nalezena.',
      detail: `Nastavená složka:\n${custom}\n\nPokud je na odpojeném disku, připoj ho a dej „Zkusit znovu". Pokud se přesunula, vyber ji. „Pokračovat s výchozí" otevře data z AppData jen pro tohle spuštění – nastavená složka zůstane a příště se zeptám znovu.`,
      buttons: ['Zkusit znovu', 'Vybrat složku…', 'Pokračovat s výchozí', 'Ukončit'],
      defaultId: 0,
      cancelId: 3,
      noLink: true
    });
    if (choice === 0) continue;
    if (choice === 2) { dataDirState.sessionDefault = true; logInfo('Umístění dat', `Nenalezeno ${custom}, tento běh používá výchozí složku.`); break; }
    if (choice === 3) { app.exit(0); return false; }
    const picked = dialog.showOpenDialogSync({ title: 'Vyber složku s daty Futures Journal PRO', properties: ['openDirectory'] });
    if (!picked?.[0]) continue;
    const candidates = [picked[0], path.join(picked[0], 'FuturesJournalPRO-Data')];
    const found = candidates.find(dir => fs.existsSync(path.join(dir, 'journal-data')));
    if (!found) { dialog.showMessageBoxSync({ type: 'error', title: 'Futures Journal PRO', message: 'Ve vybrané složce nejsou data deníku (chybí podsložka journal-data).', noLink: true }); continue; }
    writeDataLocationConfig(found);
    logInfo('Umístění dat', `${custom} nenalezeno, vybráno ${found}`);
    break;
  }
  return true;
}
// Data nebo obrázky uvnitř složky programu: příští aktualizace je smaže.
function warnIfDataInsideInstallDir() {
  const places = [resolveDataDir(), imagesRoot()].filter(isInsideInstallDir);
  if (!places.length) return;
  logInfo('Umístění dat', `Data uvnitř složky programu: ${places.join(', ')}`);
  dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Futures Journal PRO',
    message: 'Data leží ve složce programu – příští aktualizace je smaže.',
    detail: `${[...new Set(places)].join('\n')}\n\nPřesuň je jinam: Nastavení → Data a zálohy → umístění dat (a případně Složka obrázků). Vyber složku mimo ${installDir()}.`,
    noLink: true
  }).catch(() => {});
}
app.whenReady().then(() => {
  if (!checkDataLocationAtStartup()) return;
  // Ve Windows se aplikace automaticky spustí po přihlášení skrytě do oznamovací oblasti.
  if (process.platform === 'win32' && app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: ['--background'],
      enabled: true
    });
    const loginState = app.getLoginItemSettings({ path: process.execPath, args: ['--background'] });
    if (!loginState.openAtLogin) logError('Windows auto-start', 'Automatické spuštění se nepodařilo aktivovat.');
  }
  registerImageProtocol();
  // Obrázky s otiskem místo jména (do 4.8.6, obnovená záloha) dostanou čitelná
  // jména dřív, než si deníky přečte okno. Chyba nic nezastaví – zkusí se
  // znovu při dalším startu.
  try {
    const named = nameStoredImages();
    if (named.renamed) logInfo('Start', `Pojmenováno obrázků: ${named.renamed}`);
  } catch (error) { logError('Pojmenování obrázků při startu', error); }
  // API klíč do paměti hned – kdyby složka dat zmizela dřív, než přijde první zpráva.
  try { readCaptureSettings(); } catch (error) { logError('Nastavení konektoru při startu', error); }
  startCaptureServer();
  startRelayPolling();
  watchDataDir();
  // Zprávy zadržené v minulém běhu (složka dat tehdy chyběla).
  replayCaptureSpool().catch(error => logError('Záloha konektoru při startu', error));
  createTray();
  initAutoUpdate();
  const created = createWindow();
  // Až když je okno vidět – při startu na pozadí (po přihlášení) by se
  // varování ztratilo za skrytým oknem.
  mainWindow.once('show', () => {
    try { warnIfDataInsideInstallDir(); } catch (error) { logError('Kontrola umístění dat', error); }
  });
  return created;
}).catch(error => {
  logError('Application startup', error);
  dialog.showErrorBox('Futures Journal PRO', `Aplikaci se nepodařilo spustit.

${error.message}`);
});
app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { /* aplikace zůstává běžet na pozadí */ });
app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else focusMainWindow();
});
