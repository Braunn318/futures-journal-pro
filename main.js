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
const logPath = () => path.join(resolveDataDir(), 'futures-journal-error.log');

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
function resolveDataDir() {
  try {
    const raw = fs.readFileSync(dataLocationConfigPath(), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg.customDataDir && fs.existsSync(cfg.customDataDir)) return cfg.customDataDir;
  } catch {}
  return app.getPath('userData');
}
function writeDataLocationConfig(customDataDir) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataLocationConfigPath(), JSON.stringify({ customDataDir }, null, 2), 'utf8');
}
// Přesune existující deníky/nastavení/screenshoty ze staré do nové složky
// (kopie + smazání originálu, aby se místo na starém disku opravdu uvolnilo).
// Doplňková pojistka navíc: těsně před JAKÝMKOLIV přesunem se obchody
// (bez screenshotů, kvůli rychlosti) zkopírují i do pevného, nikdy se
// nepřesouvajícího umístění – pro případ, že by se přesun i přes výše
// popsané bezpečné pořadí něčím nečekaným přerušil (např. vynucené
// ukončení procesu uprostřed kopírování).
function writeSafetyBackupBeforeMove(oldDir) {
  try {
    const journalDataSrc = path.join(oldDir, 'journal-data');
    if (!fs.existsSync(journalDataSrc)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(app.getPath('userData'), 'safety-backups', `pred-presunem-${stamp}`, 'journal-data');
    fs.cpSync(journalDataSrc, backupDir, { recursive: true });
  } catch (error) {
    logError('writeSafetyBackupBeforeMove', error);
  }
}
// Přesune existující deníky/nastavení/screenshoty ze staré do nové složky.
// Pořadí je záměrně: 1) zkopírovat VŠECHNO, 2) teprve pak přepnout appku na
// nové umístění, 3) až úplně nakonec (a jen jako "úklid") smazat staré
// soubory. Kdyby cokoliv selhalo v kroku 1, nic se nesmaže a appka dál vidí
// svá data na původním místě beze změny – nikdy nemůže nastat stav, kdy je
// originál pryč, ale appka o novém umístění ještě neví (přesně tohle byl
// dřívější, nebezpečnější postup: kopírovat a rovnou mazat po jedné položce).
function moveDataContents(oldDir, newDir) {
  const entries = ['journal-data', 'trade-capture', 'backup-settings.json', 'futures-journal-error.log', 'news-calendar.json'];
  fs.mkdirSync(newDir, { recursive: true });
  const copied = [];
  for (const name of entries) {
    const src = path.join(oldDir, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(newDir, name);
    fs.cpSync(src, dest, { recursive: true, force: true });
    if (!fs.existsSync(dest)) throw new Error(`Kopírování "${name}" do nového umístění se nezdařilo.`);
    copied.push(src);
  }
  // Od tohoto místa dál appka už najde svá data v newDir bez ohledu na to,
  // jestli se podaří smazat staré soubory – volající hned poté zapíše
  // ukazatel na nové umístění (writeDataLocationConfig).
  for (const src of copied) {
    try { fs.rmSync(src, { recursive: true, force: true }); } catch (error) { logError('moveDataContents cleanup', error); }
  }
}
ipcMain.handle('data:getLocation', async () => {
  try { const p = resolveDataDir(); return { ok: true, path: p, isDefault: p === app.getPath('userData') }; }
  catch (error) { return { ok: false, error: error.message }; }
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
    if (path.resolve(newDir) === path.resolve(oldDir)) return { ok: false, error: 'Vybraná složka už je aktuálním umístěním dat.' };
    writeSafetyBackupBeforeMove(oldDir);
    moveDataContents(oldDir, newDir);
    writeDataLocationConfig(newDir);
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
    if (path.resolve(oldDir) !== path.resolve(defaultDir)) {
      writeSafetyBackupBeforeMove(oldDir);
      moveDataContents(oldDir, defaultDir);
    }
    fs.rmSync(dataLocationConfigPath(), { force: true });
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
// Jméno souboru je otisk jeho obsahu: stejný obrázek se na disku neuloží
// dvakrát a přesun obchodu mezi deníky nevyžaduje kopírování souborů.
const IMAGE_NAME_RE = /^[a-f0-9]{64}\.[a-z0-9]{1,5}$/;
const IMAGE_CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml'
};
const imagesRoot = () => path.join(dataRoot(), 'images');

function isImageRef(value) {
  return typeof value === 'string'
    && value.startsWith(IMAGE_REF_PREFIX)
    && IMAGE_NAME_RE.test(value.slice(IMAGE_REF_PREFIX.length));
}
function imageRefName(ref) { return isImageRef(ref) ? ref.slice(IMAGE_REF_PREFIX.length) : null; }
// Cesta se skládá jen ze jména, které prošlo IMAGE_NAME_RE – přes ten se
// neprotlačí ".." ani podadresář, takže odkaz nikdy neukáže mimo složku
// s obrázky, ať přijde odkudkoli.
function imageRefPath(ref) {
  const name = imageRefName(ref);
  return name ? path.join(imagesRoot(), name) : null;
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
function imageToBuffer(source) {
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
// Obsluha adres "fjimg://store/<jméno>" – díky ní stačí v rendereru napsat
// <img src="<odkaz>"> a obrázek se načte přímo ze souboru, bez base64 a bez
// posílání dat přes IPC. Jméno je otisk obsahu, takže se smí cachovat natrvalo.
function registerImageProtocol() {
  try {
    protocol.handle(IMAGE_SCHEME, request => {
      const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
      if (!IMAGE_NAME_RE.test(name)) return new Response('', { status: 400 });
      const file = path.join(imagesRoot(), name);
      if (!fs.existsSync(file)) return new Response('', { status: 404 });
      const ext = path.extname(file).slice(1).toLowerCase();
      return new Response(fs.readFileSync(file), {
        headers: {
          'content-type': IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable'
        }
      });
    });
  } catch (error) {
    logError('registerImageProtocol', error);
  }
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
function buildJournalsBackup(meta) {
  const profiles = Array.isArray(meta?.profiles) ? meta.profiles : [];
  const journals = profiles.map(profile => {
    const data = readJournal(profile.id);
    inflateJournalImages(data);
    // dayNotes se dřív do zálohy nedávaly vůbec, takže obnova ze zálohy tiše
    // smazala denní komentáře, náhledy a poznámky. Patří sem stejně jako obchody.
    return { profile, trades: data.trades, settings: data.settings, dayNotes: data.dayNotes };
  });
  return JSON.stringify({
    app: 'Futures Journal',
    version: 2,
    exportedAt: new Date().toISOString(),
    activeJournalId: meta?.activeJournalId || profiles[0]?.id || '',
    profiles,
    journals
  });
}
function restoreJournalsBackup(content) {
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
  return { activeJournalId: data.activeJournalId || data.profiles[0]?.id || '', profiles: data.profiles };
}
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
      backupPath = result.filePath;
      writeSettings({ ...readSettings(), backupPath });
    }
    fs.writeFileSync(backupPath, buildJournalsBackup(meta), 'utf8');
    return { ok: true, path: backupPath };
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
    const restored = restoreJournalsBackup(fs.readFileSync(backupPath, 'utf8'));
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
    inflateJournalImages(data);
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
    manualAccounts: []
  };
}
function readCaptureSettings() {
  ensureCaptureRoot();
  try {
    return { ...defaultCaptureSettings(), ...JSON.parse(fs.readFileSync(captureSettingsPath(), 'utf8')) };
  } catch {
    const defaults = defaultCaptureSettings();
    fs.writeFileSync(captureSettingsPath(), JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }
}
function writeCaptureSettings(settings) {
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
async function openPositionFromExecution(state, key, payload, { delta, price, commission, rate, pointValue, time, executionId, positionId }) {
  const images = await takeScreenshots('entry');
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
  return appendCaptureEvent({
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
  }, 'ninjatrader');
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
async function processExecution(payload) {
  const executionId = String(payload.executionId || '');
  const state = readCaptureState();
  if (executionId && state.executionIds.includes(executionId)) return [];
  if (executionId) state.executionIds.push(executionId);

  const delta = signedExecutionQuantity(payload);
  if (!delta) {
    writeCaptureState(state);
    return [];
  }

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
    writeCaptureState(state);
    return derived;
  }

  if (!current || current.qty === 0) {
    derived.push(await openPositionFromExecution(state, key, payload, { ...opts, positionId: crypto.randomUUID() }));
    writeCaptureState(state);
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
    derived.push(await openPositionFromExecution(state, key, payload, { ...opts, positionId: current.positionId || crypto.randomUUID() }));
    writeCaptureState(state);
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
    writeCaptureState(state);
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
  const exitImages = await takeScreenshots('exit');

  for (const chunk of takeFromLots(lots, closeQty)) {
    const pointsSigned = (price - chunk.price) * direction;
    const grossPnl = pointsSigned * pointValue * chunk.qty * rate;
    const chunkCommission = chunk.commission + exitCommissionShare * (chunk.qty / closeQty);
    const netPnl = grossPnl - chunkCommission;
    derived.push(appendCaptureEvent({
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
    }, 'ninjatrader'));
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
    }));
  } else {
    delete state.positions[key];
  }

  writeCaptureState(state);
  return derived;
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
function startCaptureServer() {
  if (captureServer) return;
  captureServer = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
    const url = new URL(req.url, `http://127.0.0.1:${CAPTURE_PORT}`);
    const settings = readCaptureSettings();

    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'Futures Journal Trade Capture', version: '2.0', port: CAPTURE_PORT });
    }
    if (url.pathname === '/api/v1/events' && req.method === 'POST') {
      const key = req.headers['x-fj-api-key'] || url.searchParams.get('key');
      if (key !== settings.apiKey) return sendJson(res, 401, { ok: false, error: 'Neplatný API klíč.' });
      let raw = '';
      req.on('data', chunk => {
        raw += chunk;
        if (raw.length > 2_000_000) req.destroy();
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(raw || '{}');
          const source = payload.source || req.headers['x-fj-source'] || 'external';
          const event = await processIncomingPayload(payload, source);
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
async function pollTradingViewRelay() {
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
  return { ok: true };
});
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
async function ninjaConnectorStatus({ documentsDir, currentVersion, fsApi }) {
  const target = ninjaConnectorTargetPath(documentsDir);
  if (!fsApi.existsSync(target.customDir)) return { installed: false, currentVersion };
  const copies = await findNinjaConnectorCopies(target.customDir, fsApi);
  if (!copies.length) return { installed: false, currentVersion };
  const installedVersion = Math.min(...copies.map(copy => ninjaConnectorVersion(copy.source)));
  return { installed: true, installedVersion, currentVersion, outdated: installedVersion < currentVersion };
}
function ninjaConnectorTemplateSource() {
  return fs.readFileSync(path.join(connectorsDir(), 'NinjaTrader8', 'FuturesJournalCapture.cs'), 'utf8');
}
// Šablona s dosazeným API klíčem – sdílí ji automatická instalace i „Uložit konektor".
function ninjaConnectorSourceWithKey() {
  return ninjaConnectorTemplateSource().replace('SEM_VLOZ_API_KLIC_Z_APLIKACE', readCaptureSettings().apiKey);
}

ipcMain.handle('capture:installNinjaConnector', async () => {
  try {
    const result = await installNinjaConnectorFile({ documentsDir: app.getPath('documents'), source: ninjaConnectorSourceWithKey(), fsApi: fs });
    if (result.ok) await shell.openPath(result.addOnsDir);
    return result;
  } catch (error) {
    logError('Install NinjaTrader connector', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('capture:ninjaConnectorStatus', async () => {
  try {
    const currentVersion = ninjaConnectorVersion(ninjaConnectorTemplateSource());
    return await ninjaConnectorStatus({ documentsDir: app.getPath('documents'), currentVersion, fsApi: fs });
  } catch (error) {
    logError('NinjaTrader connector status', error);
    return { installed: false };
  }
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
function openImageExternally(source) {
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
ipcMain.handle('image:storeCapture', async (_event, filePath) => {
  try {
    const resolved = path.resolve(String(filePath || ''));
    if (!resolved.startsWith(path.resolve(screenshotRoot()))) throw new Error('Neplatná cesta screenshotu.');
    return { ok: true, ref: storeImageBuffer(fs.readFileSync(resolved), imageExtension(`image/${path.extname(resolved).slice(1) || 'png'}`)) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
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

app.whenReady().then(() => {
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
  startCaptureServer();
  startRelayPolling();
  createTray();
  initAutoUpdate();
  return createWindow();
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
