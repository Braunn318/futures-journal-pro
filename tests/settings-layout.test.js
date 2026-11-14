'use strict';
// Nové uspořádání Nastavení (docs/ZADANI_DENIK_NASTAVENI.md §6). Jen UI:
// klíče, úložiště, výchozí hodnoty a chování se nemění.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readRepoFile, inlineScripts, loadRenderer } = require('./helpers/extract');
const FJSettings = require('../app/settings-registry.js');

const HTML = readRepoFile('app/index.html');
const SRC = inlineScripts(HTML) + '\n' + readRepoFile('app/swing-ui.js');

// Všechny prvky Nastavení a Integrací před touto dávkou (4.8.103-test.2),
// bez čistě stavebních kontejnerů (podzáložky, obal sekce).
const OLD_IDS = `newsShowButton newsUrl newsBadges newsCurrencies newsMinImpact newsFeedUrl newsRefreshBtn newsStatus journalVisibilityList changePassword lockApp
startingBalance currency usdCzkRate saveSettings updateInfo checkUpdates installUpdate updateTestChannel updateTestBox checkTestUpdates updateTestWarning
distanceUnitSelect themeMode customThemeFields tp_bgStart tp_bgEnd tp_sidebarBg tp_panel tp_text tp_line tp_blue tp_green tp_red tp_yellow resetThemeDefaults
saveTheme tradeCardSettings contextFieldSettings gradeRetroGraceMinutes levelsViewMap levelsViewBars levelsViewSummary ltaEnabled ltaAutoInForm ltaVwapRow
ltaArchive ltaNearestCount ltaRetentionDays ltaFolderInfo ltaChooseFolder ltaResetFolder ltaOpenFolder ltaRefresh ltaFiles ltaExcludePatterns ltaArchiveInfo
ltaMissingDays levelsSnapshotSection levelsSnapshotOnLabel levelsSnapshotOn levelsSnapshotWhy marketLevelsNField marketLevelsN marketLevelTypes marketEnabled
marketFeatures marketBarsPanel marketBarsInfo marketConnectorInfo marketBackfill marketCancel marketOpenFolder marketProgress marketSnapshotPanel
marketSnapshotConn marketVaPct marketLiveRoots marketInfo overviewFilterSettings riskMaxDailyDrawdown riskMaxTotalDrawdown riskMaxSlPerDay riskMaxTradesPerDay
riskMaxProfitTradesPerDay riskProfitTargetPerDay saveRiskSettings breakEvenEnabled breakEvenThreshold autoMergeLegs saveBreakEvenSettings tplNewInstrument
tplNewPlan tplNewPointValue tplNewTickSize tplNewCommission tplNewMaxSl tplNewComment addTemplate templateList useConnectorCommission
saveConnectorCommissionSetting recalcCommissionBtn backfillSideBtn backfillSideReport taxonomyGroups taxonomyCopyTarget taxonomyCopyBtn taxonomyExportBtn
taxonomyImportInput taxonomyTransferNote aiExportInfo regenerateAiExports dataLocationInfo changeDataLocation resetDataLocation imagesLocationInfo
changeImagesLocation openImagesFolder resetImagesLocation imagesIntegrityInfo restoreImagesFromBackup updateBackup restoreBackup backupPathInfo
backupImagesMirror backupImagesMirrorInfo chooseBackupImagesDir resetBackupImagesDir backupIncludeImages changeBackupPath exportJson importJson clearAll
factoryReset captureStatusText capturePendingCount captureEndpoint captureApiKey captureShotJournal captureScreenshotMode captureAutoImportSelect
captureWindowsBox captureWindowRules captureWindowNew captureWindowAdd captureWindowLoad captureWindowList captureMissingBox captureScreenshotMissing
captureAfterEnabled captureAfterMinutes captureAfterMax captureRefresh captureTestSequence captureTestMultiTarget captureTestScaleIn captureImport
nt8ManualImportBtn captureOpenConnectors captureNewKey captureClear ntConnectorState ntUpdateNoticeSelect captureInstallNinja captureExportConnector
capCtrader captureTestCTrader captureExportCTrader captureInstallCTrader capturePrepareTradingView capturePrepareWorker captureExportTradingView
captureExportTradingViewWorker relayUrl relayToken relayEnabled saveRelay pollRelay captureNewAccount captureAddAccount captureMappingRows
captureSaveMappings captureHiddenAccountsBox`.split(/\s+/).filter(Boolean);
// Prvky, které jsou jen informace bez vlastní položky (patří ke skupině).
const INFO_ONLY = new Set(['marketInfo']);

const count = (hay, needle) => hay.split(needle).length - 1;

// Výřez sekce a karty z HTML.
function sectionSlice(key) {
  const start = HTML.indexOf(`<div class="settings-sec" data-sec="${key}"`);
  assert.ok(start > 0, `sekce ${key} v HTML`);
  const next = HTML.indexOf('<div class="settings-sec" data-sec="', start + 10);
  const end = next > 0 ? next : HTML.indexOf('</section>', start);
  return HTML.slice(start, end);
}
function groupSlice(id) {
  const start = HTML.indexOf(`settings-card" data-card="${id}"`);
  assert.ok(start > 0, `skupina ${id} v HTML`);
  const next = HTML.indexOf('settings-card" data-card="', start + 30);
  const sectionEnd = HTML.indexOf('<div class="settings-sec" data-sec="', start);
  const ends = [next, sectionEnd, HTML.indexOf('</section>', start)].filter(x => x > 0);
  return HTML.slice(start, Math.min(...ends));
}

// --------------------------------------------------------- 1 právě jednou

test('1 každé dosavadní nastavení je v novém Nastavení právě jednou a v registru', () => {
  const covered = new Set(FJSettings.ITEMS.flatMap(i => i.ids));
  for (const id of OLD_IDS) {
    assert.equal(count(HTML, `id="${id}"`), 1, `prvek ${id} je v HTML právě jednou`);
    if (!INFO_ONLY.has(id)) assert.ok(covered.has(id), `prvek ${id} má položku v registru`);
  }
});

test('1 každá skupina je v HTML jednou a ve své sekci; každá položka ve své skupině', () => {
  for (const g of FJSettings.GROUPS) {
    assert.equal(count(HTML, `settings-card" data-card="${g.id}"`), 1, `skupina ${g.id} právě jednou`);
    assert.ok(sectionSlice(g.section).includes(`data-card="${g.id}"`), `skupina ${g.id} v sekci ${g.section}`);
  }
  const itemIds = FJSettings.ITEMS.map(i => i.id);
  assert.equal(new Set(itemIds).size, itemIds.length, 'id položek jsou jedinečná');
  for (const it of FJSettings.ITEMS) {
    const slice = groupSlice(it.group);
    for (const id of it.ids) assert.ok(slice.includes(`id="${id}"`), `${id} (${it.id}) leží ve skupině ${it.group}`);
  }
  for (const s of FJSettings.SECTIONS) assert.ok(FJSettings.groupsOf(s.key).length, `sekce ${s.key} má skupiny`);
});

test('1 sekce Integrace v levém menu vede do Nastavení → Připojení; podzáložky Nastavení nejsou', () => {
  assert.ok(!HTML.includes('<section id="integrations"'), 'samostatná sekce Integrace už není');
  assert.match(HTML, /data-section="settings" data-settings-open="connections"/);
  assert.ok(!/data-subtab="settings(General|Customize|Risk|Templates|Taxonomy|Backup)"/.test(HTML));
  for (const s of FJSettings.SECTIONS) assert.ok(HTML.includes(`data-settings-sec="${s.key}"`), `položka ${s.key} v seznamu sekcí`);
});

// ------------------------------------------- 2 klíče a úložiště beze změny

test('2 ukládání: stejné klíče a tvar jako dřív (žádný nový klíč nastavení)', () => {
  for (const key of ['FJ_distanceUnit', 'FJ_theme', 'FJ_tradeCards', 'FJ_contextFields', 'FJ_levelsView', 'FJ_overviewFilters', 'FJ_overviewSections',
    'FJ_newsCalendar', 'FJ_updateTestChannel', 'FJ_ctraderMcp', 'FJ_overviewStartJournal']) {
    assert.ok(SRC.includes(`'${key}'`), `klíč ${key} se dál používá`);
  }
  assert.match(SRC, /saveMarketSettings\(\{features:\{\[box\.dataset\.key\]:box\.checked\}\}\)/, 'přepínače Dat trhu ukládají stejně');
  assert.match(SRC, /saveMarketSettings\(\{features:\{snapshotLevels:\$\('levelsSnapshotOn'\)\.checked\}\}\)/);
  assert.match(SRC, /setLevelsView\(\{summaryLine:\$\('levelsViewSummary'\)\.checked\}\)/);
  // Nový klíč je jen stav UI (naposledy otevřená sekce), ne nastavení.
  assert.match(SRC, /const SETTINGS_SECTION_KEY='FJ_settingsSection';/);
});

test('2 každý přepínač Dat trhu je v Nastavení právě jednou (rozdělené do skupin)', () => {
  const r = loadRenderer(['MARKET_FEATURE_HOME']);
  const FJMarket = require('../app/market-data.js');
  const homes = FJMarket.FEATURES.filter(f => f.ready).map(f => r.MARKET_FEATURE_HOME[f.key] || 'marketFeatures');
  assert.equal(homes.length, FJMarket.FEATURES.filter(f => f.ready).length);
  for (const h of new Set(homes)) if (h !== 'levelsSnapshotOn') assert.equal(count(HTML, `id="${h}"`), 1, `kontejner ${h}`);
  assert.equal(r.MARKET_FEATURE_HOME.csvColumns, 'exportFeatures');
  assert.equal(r.MARKET_FEATURE_HOME.snapshotLevels, 'levelsSnapshotOn', 'vlastní přepínač, ne v seznamu');
});

// ---------------------------------------------------------------- 3 hledání

test('3 hledání najde podle názvu, popisu i starého umístění', () => {
  const ids = q => FJSettings.search(q).map(r => r.id);
  assert.ok(ids('heslo').includes('password'), 'název');
  assert.ok(ids('drawdown').includes('risk'), 'popis');
  assert.ok(ids('LTA').includes('ltaEnabled'));
  assert.ok(ids('prizpusobeni').includes('distanceUnit'), 'staré umístění bez diakritiky');
  assert.ok(ids('přizpůsobení hladiny').includes('mapOn'));
  assert.ok(ids('integrace').includes('accountMapping'));
  assert.deepEqual(FJSettings.search(''), []);
  const r = FJSettings.search('VWAP')[0];
  assert.equal(r.sectionLabel, 'Hladiny a data trhu');
});

// ---------------------------------------------------------- 4 přímé odkazy

test('4 každý přímý odkaz z aplikace vede na existující skupinu', () => {
  const targets = [...SRC.matchAll(/openSettings\('([^']+)'/g), ...HTML.matchAll(/data-settings-link="([^"]+)"/g), ...HTML.matchAll(/data-settings-open="([^"]+)"/g)].map(m => m[1]);
  assert.ok(targets.length >= 5, 'odkazy existují');
  for (const t of targets) {
    const r = FJSettings.resolve(t);
    assert.ok(r, `cíl ${t} je v registru`);
    if (r.group) assert.equal(count(HTML, `settings-card" data-card="${r.group}"`), 1, `skupina ${r.group} existuje`);
  }
  assert.equal(FJSettings.resolve('neexistuje'), null);
  assert.deepEqual(FJSettings.resolve('summaryLine'), { section: 'display', group: 'tradeList', anchor: 'levelsViewSummary' });
});

test('4 staré textové odkazy „Přizpůsobení → …“ míří na nové umístění', () => {
  assert.ok(!/Přizpůsobení → (Hladiny|LTA levely|Data trhu)/.test(SRC.replace(/old: [^\n]*/g, '')), 'žádný text nevede do starého umístění');
});

// ------------------------------------------------- 5 zobrazit + upozorňovat

test('5 karty obchodu a pole kontextu: zobrazit a upozorňovat dál na jednom řádku', () => {
  assert.ok(groupSlice('tradeCards').includes('id="tradeCardSettings"'));
  assert.ok(groupSlice('contextFields').includes('id="contextFieldSettings"'));
  assert.match(SRC, /function renderToggleSettings\(/, 'stejný renderer řádků');
});

// ------------------------------------------------------------- 6 zešedlé

test('6 zešedlé nastavení uvádí důvod; po splnění předpokladu je aktivní', () => {
  const FJMarket = require('../app/market-data.js');
  const off = FJMarket.cleanMarketSettings({ enabled: true, features: { signalBar: true } });
  assert.match(FJMarket.blockedReason(off, 'signalBar'), /Vyžaduje/);
  const on = FJMarket.cleanMarketSettings({ enabled: true, features: { snapshot: true, signalBar: true } });
  assert.equal(FJMarket.blockedReason(on, 'signalBar'), null);
});

// ----------------------------------------------------- 8 bez interních pojmů

test('8 názvy sekcí a skupin jsou běžná čeština bez interních pojmů', () => {
  for (const x of [...FJSettings.SECTIONS.map(s => s.label), ...FJSettings.GROUPS.map(g => g.title)]) {
    for (const term of FJSettings.INTERNAL_TERMS) assert.ok(!FJSettings.fold(x).includes(term), `„${x}“ obsahuje „${term}“`);
  }
});

test('štítek platnosti: každá skupina má platnost, deníkové položky jsou označené', () => {
  for (const g of FJSettings.GROUPS) assert.ok(FJSettings.SCOPE_LABEL[g.scope], g.id);
  assert.equal(FJSettings.scopeOf('gradeRetro'), 'journal');
  assert.equal(FJSettings.scopeOf('screenshots'), 'journal');
  assert.equal(FJSettings.scopeOf('distanceUnit'), 'app');
});
