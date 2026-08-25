const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen, shell, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

let mainWindow;
let tray = null;
let isQuitting = false;
const startHidden = process.argv.includes('--background');

// Zabrání spuštění více kopií aplikace. Druhé spuštění pouze otevře existující okno.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}
const settingsPath = () => path.join(app.getPath('userData'), 'backup-settings.json');
const logPath = () => path.join(app.getPath('userData'), 'futures-journal-error.log');

function logError(context, error) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${context}: ${error?.stack || error}\n`, 'utf8');
  } catch {}
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}
function writeSettings(data) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
}

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

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'app', 'assets', 'bull_bear_icon.ico'));
  tray.setTitle('Futures Journal PRO');
  tray.setToolTip('Futures Journal PRO – aplikace běží a automaticky zaznamenává');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Otevřít Futures Journal PRO',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        else focusMainWindow();
      }
    },
    { type: 'separator' },
    {
      label: 'Ukončit aplikaci a záznam',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
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
    const img = nativeImage.createFromDataURL(params.srcURL);
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


const dataRoot = () => path.join(app.getPath('userData'), 'journal-data');
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
  return {
    trades: Array.isArray(parsed.trades) ? parsed.trades : [],
    settings: Array.isArray(parsed.settings) ? parsed.settings : []
  };
}
function writeJournal(id, data) {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const target = journalPath(id);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, target);
}

ipcMain.handle('storage:read', async (_event, journalId) => {
  try { return { ok: true, data: readJournal(journalId) }; }
  catch (error) { logError('Storage read', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('storage:write', async (_event, journalId, data) => {
  try { writeJournal(journalId, data || defaultJournalData()); return { ok: true }; }
  catch (error) { logError('Storage write', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('storage:deleteJournal', async (_event, journalId) => {
  try { fs.rmSync(journalPath(journalId), { force: true }); return { ok: true }; }
  catch (error) { logError('Storage delete journal', error); return { ok: false, error: error.message }; }
});
ipcMain.handle('storage:reset', async () => {
  try { fs.rmSync(dataRoot(), { recursive: true, force: true }); return { ok: true }; }
  catch (error) { logError('Storage reset', error); return { ok: false, error: error.message }; }
});

ipcMain.handle('backup:getPath', async () => readSettings().backupPath || null);
ipcMain.handle('backup:save', async (_event, content) => {
  try {
    let { backupPath } = readSettings();
    if (!backupPath) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Vyber umístění aktuální zálohy',
        defaultPath: 'FuturesJournal_AKTUALNI_ZALOHA.json',
        filters: [{ name: 'Záloha Futures Journal', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return { ok: false };
      backupPath = result.filePath;
      writeSettings({ backupPath });
    }
    fs.writeFileSync(backupPath, content, 'utf8');
    return { ok: true, path: backupPath };
  } catch (error) {
    logError('Backup save', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('backup:load', async () => {
  try {
    let { backupPath } = readSettings();
    if (!backupPath || !fs.existsSync(backupPath)) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Vyber zálohu k obnovení', properties: ['openFile'],
        filters: [{ name: 'Záloha Futures Journal', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false };
      backupPath = result.filePaths[0];
      writeSettings({ backupPath });
    }
    return { ok: true, path: backupPath, content: fs.readFileSync(backupPath, 'utf8') };
  } catch (error) {
    logError('Backup load', error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('app:factoryReset', async () => {
  try {
    const userDataPath = app.getPath('userData');
    const ownedEntries = [
      'IndexedDB', 'Local Storage', 'Session Storage', 'databases', 'Cache',
      'Code Cache', 'GPUCache', 'DawnCache', 'Network', 'Preferences',
      'Shared Dictionary', 'WebStorage', 'backup-settings.json', 'journal-data'
    ];
    for (const name of ownedEntries) {
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
const captureRoot = () => path.join(app.getPath('userData'), 'trade-capture');
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
    relayToken: ''
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
    return Array.isArray(parsed) ? parsed : [];
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
function appendCaptureEvent(payload, source='unknown') {
  const events = readCaptureEvents();
  const event = {
    id: payload.id || crypto.randomUUID(),
    receivedAt: payload.receivedAt || new Date().toISOString(),
    imported: payload.imported === true,
    source,
    ...payload
  };
  events.push(event);
  writeCaptureEvents(events.slice(-10000));
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
  const current = state.positions[key] || null;
  const derived = [];

  if (!current || current.qty === 0) {
    const images = await takeScreenshots('entry');
    const positionId = crypto.randomUUID();
    state.positions[key] = {
      qty: delta,
      avgPrice: price,
      currentPrice: price,
      openedAt: time,
      pointValue,
      rate,
      entryCommission: commission,
      maxQuantity: Math.abs(delta),
      side: delta > 0 ? 'long' : 'short',
      entryImages: images,
      account: payload.account || '',
      instrument: payload.instrument || payload.symbol || '',
      instrumentFull: payload.instrumentFull || payload.instrument || payload.symbol || '',
      strategy: payload.strategy || payload.orderName || '',
      positionId
    };
    derived.push(appendCaptureEvent({
      type: 'trade_opened',
      account: payload.account || '',
      instrument: payload.instrument || payload.symbol || '',
      instrumentFull: payload.instrumentFull || payload.instrument || payload.symbol || '',
      side: delta > 0 ? 'long' : 'short',
      entryTime: time,
      entryPrice: price,
      quantity: Math.abs(delta),
      strategy: payload.strategy || payload.orderName || '',
      screenshotPaths: images,
      sourceExecutionId: executionId,
      positionId
    }, 'ninjatrader'));
    writeCaptureState(state);
    return derived;
  }

  const sameDirection = Math.sign(current.qty) === Math.sign(delta);
  if (sameDirection) {
    const oldAbs = Math.abs(current.qty);
    const addAbs = Math.abs(delta);
    current.avgPrice = ((current.avgPrice * oldAbs) + (price * addAbs)) / (oldAbs + addAbs);
    current.currentPrice = price;
    current.qty += delta;
    current.entryCommission += commission;
    current.maxQuantity = Math.max(current.maxQuantity || 0, Math.abs(current.qty));
    state.positions[key] = current;
    writeCaptureState(state);
    return derived;
  }

  const previousQty = current.qty;
  const closeQty = Math.min(Math.abs(previousQty), Math.abs(delta));
  const direction = Math.sign(previousQty);
  const pointsSigned = (price - current.avgPrice) * direction;
  const grossPnl = pointsSigned * pointValue * closeQty * rate;
  const entryCommissionShare = Math.abs(previousQty) ? current.entryCommission * (closeQty / Math.abs(previousQty)) : 0;
  const exitCommissionShare = commission * (closeQty / Math.abs(delta));
  const netPnl = grossPnl - entryCommissionShare - exitCommissionShare;
  const exitImages = await takeScreenshots('exit');

  const closed = appendCaptureEvent({
    type: 'trade_closed',
    account: current.account,
    instrument: current.instrument,
    instrumentFull: current.instrumentFull,
    side: current.side,
    entryTime: current.openedAt,
    exitTime: time,
    entryPrice: current.avgPrice,
    exitPrice: price,
    quantity: closeQty,
    contracts: closeQty,
    points: Math.abs(pointsSigned),
    grossPnl,
    commission: entryCommissionShare + exitCommissionShare,
    pnl: netPnl,
    result: netPnl >= 0 ? 'target' : 'stoploss',
    pointValue,
    strategy: current.strategy || payload.strategy || payload.orderName || '',
    screenshotPaths: [...(current.entryImages || []), ...exitImages],
    sourceExecutionId: executionId,
    comment: 'Automaticky sestaveno z exekucí NinjaTraderu.',
    positionId: current.positionId || ''
  }, 'ninjatrader');
  derived.push(closed);

  const remainingOld = Math.abs(previousQty) - closeQty;
  const excessNew = Math.abs(delta) - closeQty;
  if (remainingOld > 0) {
    current.qty = direction * remainingOld;
    current.entryCommission = Math.max(0, current.entryCommission - entryCommissionShare);
    state.positions[key] = current;
  } else if (excessNew > 0) {
    const newDelta = Math.sign(delta) * excessNew;
    const images = await takeScreenshots('entry');
    const positionId = crypto.randomUUID();
    state.positions[key] = {
      qty: newDelta,
      avgPrice: price,
      currentPrice: price,
      openedAt: time,
      pointValue,
      rate,
      entryCommission: Math.max(0, commission - exitCommissionShare),
      maxQuantity: excessNew,
      side: newDelta > 0 ? 'long' : 'short',
      entryImages: images,
      account: payload.account || '',
      instrument: payload.instrument || payload.symbol || '',
      instrumentFull: payload.instrumentFull || payload.instrument || payload.symbol || '',
      strategy: payload.strategy || payload.orderName || '',
      positionId
    };
    derived.push(appendCaptureEvent({
      type: 'trade_opened',
      account: payload.account || '',
      instrument: payload.instrument || payload.symbol || '',
      instrumentFull: payload.instrumentFull || payload.instrument || payload.symbol || '',
      side: newDelta > 0 ? 'long' : 'short',
      entryTime: time,
      entryPrice: price,
      quantity: excessNew,
      strategy: payload.strategy || payload.orderName || '',
      screenshotPaths: images,
      sourceExecutionId: executionId,
      positionId
    }, 'ninjatrader'));
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
      strategy: item.strategy || ''
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
  for (const [key, position] of Object.entries(state.positions || {})) {
    if (String(position.account || '') === account && !authoritative[key]) delete state.positions[key];
  }
  for (const [key, position] of Object.entries(authoritative)) {
    const existing = state.positions[key];
    state.positions[key] = existing ? {
      ...existing,
      ...position,
      openedAt: existing.openedAt || position.openedAt,
      entryImages: existing.entryImages || []
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
    comment: 'Automaticky sestaveno z cTrader cBota.',
    positionId: payload.positionId || ''
  }, 'ctrader');
}
async function processIncomingPayload(payload, source='external') {
  const raw = appendCaptureEvent(payload, source);
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
      for (const position of Object.values(state.positions || {})) {
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

ipcMain.handle('capture:status', async () => {
  const settings = readCaptureSettings();
  const events = readCaptureEvents();
  const state = readCaptureState();
  const deletedAccounts = new Set(Array.isArray(settings.deletedAccounts) ? settings.deletedAccounts : []);
  const accounts = [...new Set(events.map(e => e.account).filter(Boolean))].filter(a => !deletedAccounts.has(a)).sort();
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
    openPositions: Object.values(state.positions || {})
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


ipcMain.handle('capture:installNinjaConnector', async () => {
  try {
    const settings = readCaptureSettings();
    const templatePath = path.join(__dirname, 'CONNECTORS', 'NinjaTrader8', 'FuturesJournalCapture.cs');
    let source = fs.readFileSync(templatePath, 'utf8');
    source = source.replace('SEM_VLOZ_API_KLIC_Z_APLIKACE', settings.apiKey);
    const targetDir = path.join(app.getPath('documents'), 'NinjaTrader 8', 'bin', 'Custom', 'AddOns');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'FuturesJournalCapture.cs');
    fs.writeFileSync(targetPath, source, 'utf8');
    await shell.openPath(targetDir);
    return { ok: true, path: targetPath };
  } catch (error) {
    logError('Install NinjaTrader connector', error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('capture:prepareTradingViewPine', async () => {
  try {
    const source = fs.readFileSync(path.join(__dirname, 'CONNECTORS', 'TradingView', 'FuturesJournalAlertConnector.pine'), 'utf8');
    clipboard.writeText(source);
    await shell.openExternal('https://www.tradingview.com/chart/');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('capture:prepareTradingViewWorker', async () => {
  try {
    const source = fs.readFileSync(path.join(__dirname, 'CONNECTORS', 'TradingViewRelayWorker', 'worker.js'), 'utf8');
    clipboard.writeText(source);
    await shell.openExternal('https://dash.cloudflare.com/');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('capture:exportNinjaConnector', async () => {
  try {
    const settings = readCaptureSettings();
    const templatePath = path.join(__dirname, 'CONNECTORS', 'NinjaTrader8', 'FuturesJournalCapture.cs');
    let source = fs.readFileSync(templatePath, 'utf8');
    source = source.replace('SEM_VLOZ_API_KLIC_Z_APLIKACE', settings.apiKey);
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
    const templatePath = path.join(__dirname, 'CONNECTORS', 'cTrader', 'FuturesJournalCTraderConnector.cs');
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
    const templatePath = path.join(__dirname, 'CONNECTORS', 'cTrader', 'FuturesJournalCTraderConnector.cs');
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
    const templatePath = path.join(__dirname, 'CONNECTORS', 'TradingView', 'FuturesJournalAlertConnector.pine');
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
    const templatePath = path.join(__dirname, 'CONNECTORS', 'TradingViewRelayWorker', 'worker.js');
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
    const folder = path.join(__dirname, 'CONNECTORS');
    const error = await shell.openPath(folder);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});

// ---- Screenshoty obchodů: kopírování do schránky a otevření ve výchozím prohlížeči obrázků ----
function dataUrlToBuffer(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const ext = match[1].split('/')[1].split('+')[0] === 'jpeg' ? 'jpg' : match[1].split('/')[1].split('+')[0];
  return { buffer: Buffer.from(match[2], 'base64'), ext };
}
function openImageExternally(dataUrl) {
  const parsed = dataUrlToBuffer(dataUrl);
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
async function saveImageAs(dataUrl) {
  const parsed = dataUrlToBuffer(dataUrl);
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
ipcMain.handle('image:copyToClipboard', async (_event, dataUrl) => {
  const parsed = dataUrlToBuffer(dataUrl);
  if (!parsed) return { ok: false, error: 'Neplatný formát obrázku.' };
  try {
    clipboard.writeImage(nativeImage.createFromBuffer(parsed.buffer));
    return { ok: true };
  } catch (error) {
    logError('image:copyToClipboard', error);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('image:openExternally', async (_event, dataUrl) => openImageExternally(dataUrl));
ipcMain.handle('image:saveAs', async (_event, dataUrl) => saveImageAs(dataUrl));

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
  startCaptureServer();
  startRelayPolling();
  createTray();
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
