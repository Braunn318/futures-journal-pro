'use strict';
// Registr Nastavení (docs/ZADANI_DENIK_NASTAVENI.md, soupis docs/NASTAVENI_SOUPIS.md).
//
// Jediný seznam sekcí, skupin a nastavení: z něj se kreslí levý seznam sekcí,
// štítek „platí pro tento deník / pro celou aplikaci“, hledání (název, popis
// i staré umístění) a přímé odkazy z aplikace. Úložiště, klíče ani výchozí
// hodnoty se tu NEURČUJÍ – jen kde co v Nastavení je.
//
// Pravidlo (CLAUDE.md): nové nastavení se zařadí podle sekcí níže a zapíše
// sem; každé nastavení je v Nastavení právě jednou (testy).
//
// Skupina = karta v Nastavení (`<details class="settings-card" data-card="…">`),
// `group.id` = hodnota data-card. Položka = jedno nastavení nebo akce;
// `ids` = prvky v HTML, které k ní patří (první = kam se skočí z hledání).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJSettings = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const SECTIONS = Object.freeze([
    { key: 'general', label: 'Obecné', icon: '⚙️', desc: 'Základ aplikace' },
    { key: 'display', label: 'Vzhled a zobrazení', icon: '🎨', desc: 'Jak to vypadá a co vidím' },
    { key: 'dictionaries', label: 'Číselníky', icon: '📚', desc: 'Z čeho vybírám' },
    { key: 'levels', label: 'Hladiny a data trhu', icon: '📐', desc: 'Co se k obchodu doplní samo' },
    { key: 'accounts', label: 'Instrumenty a účty', icon: '💼', desc: 'Co a kde obchoduju' },
    { key: 'connections', label: 'Připojení a zdroje dat', icon: '🔌', desc: 'Odkud tečou obchody a data' },
    { key: 'data', label: 'Data a zálohy', icon: '💾', desc: 'Kde mám data' },
    { key: 'app', label: 'Aplikace', icon: 'ℹ️', desc: 'Verze a aktualizace' }
  ]);

  // scope: 'app' = celá aplikace, 'journal' = tento deník, 'mixed' = podle řádku.
  const GROUPS = Object.freeze([
    { id: 'journals', section: 'general', title: 'Deníky', desc: 'Které deníky se ukazují a co Přehled účtu ukáže po spuštění.', scope: 'app' },
    { id: 'security', section: 'general', title: 'Přihlášení a heslo', desc: 'Heslo aplikace a okamžité zamknutí.', scope: 'app' },

    { id: 'distanceUnit', section: 'display', title: 'Jednotka vzdáleností', desc: 'Ticky nebo body v celé aplikaci – stejný přepínač je v horní liště.', scope: 'app' },
    { id: 'theme', section: 'display', title: 'Motiv a barvy', desc: 'Tmavý, světlý nebo vlastní motiv.', scope: 'app' },
    { id: 'tradeCards', section: 'display', title: 'Karty obchodu', desc: 'Které karty má formulář obchodu a u kterých hlídat nevyplněné.', scope: 'app' },
    { id: 'contextFields', section: 'display', title: 'Pole kontextu', desc: 'Která pole kontextu se ukazují a u kterých hlídat nevyplněné.', scope: 'app' },
    { id: 'tradeForm', section: 'display', title: 'Formulář obchodu', desc: 'Chování formuláře obchodu v tomto deníku.', scope: 'journal' },
    { id: 'tradeList', section: 'display', title: 'Seznam obchodů', desc: 'Co se ukazuje u obchodu v Deníku, Kalendáři a Reportech.', scope: 'app' },
    { id: 'overviewFilters', section: 'display', title: 'Přehled účtu', desc: 'Které filtry a karty Přehled účtu ukazuje.', scope: 'app' },

    { id: 'taxonomy', section: 'dictionaries', title: 'Volby číselníků', desc: 'Setupy, hladiny, LTA Levels, order flow, typy cílů a další: přejmenovat, skrýt, přidat, pořadí.', scope: 'journal' },
    { id: 'taxonomyTransfer', section: 'dictionaries', title: 'Přenos číselníků', desc: 'Zkopírovat číselníky do jiného deníku, export a import souboru.', scope: 'journal' },

    { id: 'marketData', section: 'levels', title: 'Data z NinjaTraderu', desc: 'Hlavní vypínač a sběr svíček dne a snímku trhu z NinjaTraderu.', scope: 'app' },
    { id: 'levels', section: 'levels', title: 'Hladiny z LTA souborů', desc: 'N nejbližších levelů z LiveTradingAsistent nad a pod vstupem, archiv a vyloučené názvy.', scope: 'app' },
    { id: 'levelsSnapshot', section: 'levels', title: 'Hladiny ze snímku trhu', desc: 'Které hodnoty ze snímku trhu se doplní do Hladin a kolik.', scope: 'app' },
    { id: 'levelsMap', section: 'levels', title: 'Signální svíčky a Mapa obchodu', desc: 'Graf hladin v kartě Hladiny a svíčky před vstupem.', scope: 'app' },

    { id: 'account', section: 'accounts', title: 'Účet tohoto deníku', desc: 'Počáteční stav a kurz pro přepočet do CZK.', scope: 'journal' },
    { id: 'templates', section: 'accounts', title: 'Šablony podle instrumentu', desc: 'Hodnota bodu, tick, komise a předvyplnění podle instrumentu.', scope: 'journal' },
    { id: 'risk', section: 'accounts', title: 'Limity a pravidla účtu', desc: 'Denní a celkové limity zvýrazněné v Kalendáři.', scope: 'journal' },
    { id: 'breakEven', section: 'accounts', title: 'Výsledek a slučování obchodů', desc: 'Break Even a slučování cílů jedné pozice při importu.', scope: 'journal' },
    { id: 'accountMapping', section: 'accounts', title: 'Přiřazení účtů k deníkům', desc: 'Který účet NinjaTraderu / cTraderu patří do kterého deníku (i Playback).', scope: 'app' },

    { id: 'captureStatus', section: 'connections', title: 'Stav služby a screenshoty', desc: 'Příjem obchodů z konektorů, automatický import a screenshoty.', scope: 'mixed' },
    { id: 'ninjatrader', section: 'connections', title: 'NinjaTrader', desc: 'Konektor NinjaTraderu: instalace a upozornění.', scope: 'app' },
    { id: 'ctrader', section: 'connections', title: 'cTrader', desc: 'cBot a čtení limitek z cTraderu.', scope: 'app' },
    { id: 'tradingview', section: 'connections', title: 'TradingView', desc: 'Pine Script a webhook relay pro alerty z TradingView.', scope: 'app' },
    { id: 'newsCalendar', section: 'connections', title: 'Kalendář zpráv', desc: 'Ekonomický kalendář: tlačítko v liště, štítky u dnů a zdroj dat.', scope: 'app' },

    { id: 'dataLocation', section: 'data', title: 'Umístění dat', desc: 'Složka s deníky, obchody a screenshoty.', scope: 'app' },
    { id: 'imagesLocation', section: 'data', title: 'Složka obrázků', desc: 'Kde jsou screenshoty a doplnění chybějících ze zálohy.', scope: 'app' },
    { id: 'backup', section: 'data', title: 'Záloha a obnova', desc: 'Záloha všech deníků, obnova, záloha aktivního deníku a reset.', scope: 'mixed' },
    { id: 'aiExport', section: 'data', title: 'Exporty', desc: 'Export pro Backtest Lab a AI a sloupce CSV.', scope: 'app' },
    { id: 'tools', section: 'data', title: 'Nástroje opravy dat', desc: 'Jednorázové opravy uložených obchodů v aktivním deníku.', scope: 'journal' },

    { id: 'update', section: 'app', title: 'Aktualizace', desc: 'Kontrola a instalace nových verzí, i testovacích.', scope: 'app' }
  ]);

  // Položky. `old` = kde to bylo před novým uspořádáním (hledání najde i podle
  // starého místa). `scope` jen tam, kde se liší od skupiny.
  const P = 'Přizpůsobení';
  const ITEMS = Object.freeze([
    // 1 Obecné
    { id: 'overviewStart', group: 'journals', name: 'Přehled účtu po spuštění ukáže', desc: 'Poslední aktivní deník, nebo všechny deníky.', old: 'Obecné → Deníky', ids: ['journalVisibilityList'] },
    { id: 'journalVisibility', group: 'journals', name: 'Zobrazené deníky', desc: 'Skrýt nebo zobrazit deník; data zůstanou.', old: 'Obecné → Deníky', ids: ['journalVisibilityList'] },
    { id: 'password', group: 'security', name: 'Změnit heslo', desc: 'Heslo pro přihlášení do aplikace.', old: 'Obecné → Zabezpečení aplikace', ids: ['changePassword'] },
    { id: 'lock', group: 'security', name: 'Zamknout aplikaci', desc: 'Okamžitě zamkne, vyžádá heslo.', old: 'Obecné → Zabezpečení aplikace', ids: ['lockApp'] },

    // 2 Vzhled a zobrazení
    { id: 'distanceUnit', group: 'distanceUnit', name: 'Jednotka vzdáleností (ticky / body)', desc: 'Jak se ukazují SL, MFE / MAE a vzdálenosti hladin.', old: P + ' → Jednotka vzdáleností', ids: ['distanceUnitSelect'] },
    { id: 'themeMode', group: 'theme', name: 'Motiv', desc: 'Tmavý, světlý nebo vlastní.', old: P + ' → Vzhled (téma)', ids: ['themeMode'] },
    { id: 'themeColors', group: 'theme', name: 'Barvy vlastního motivu', desc: 'Pozadí, panely, text, zisk, ztráta, Break Even.', old: P + ' → Vzhled (téma)', ids: ['customThemeFields', 'tp_bgStart', 'tp_bgEnd', 'tp_sidebarBg', 'tp_panel', 'tp_text', 'tp_line', 'tp_blue', 'tp_green', 'tp_red', 'tp_yellow', 'resetThemeDefaults', 'saveTheme'] },
    { id: 'tradeCards', group: 'tradeCards', name: 'Karty obchodu – zobrazit a upozorňovat', desc: 'SL / TP, Pohyb ceny, Setup, Hladiny, Komentáře …', old: P + ' → Karty obchodu', ids: ['tradeCardSettings'] },
    { id: 'contextFields', group: 'contextFields', name: 'Pole kontextu – zobrazit a upozorňovat', desc: 'Trend 30m, známka, test / netest, řádek dopočtů, kontext dne, psychika …', old: P + ' → Pole kontextu', ids: ['contextFieldSettings'] },
    { id: 'gradeRetro', group: 'tradeForm', name: 'Známka „doplněno zpětně“ až po … minut', desc: 'Lhůta od uložení obchodu, po které se známka označí jako zpětná.', old: P + ' → Pole kontextu', ids: ['gradeRetroGraceMinutes'] },
    { id: 'summaryLine', group: 'tradeList', name: 'Souhrnný řádek hladin u obchodu', desc: '„Hladiny: 2 mezi SL a vstupem · 2 před cílem“ mimo detail obchodu.', old: P + ' → Hladiny → Zobrazení', ids: ['levelsViewSummary'] },
    { id: 'overviewFilters', group: 'overviewFilters', name: 'Další filtry Přehledu účtu', desc: 'Které filtry Přehled účtu nabízí.', old: P + ' → Přehled účtu', ids: ['overviewFilterSettings'] },
    { id: 'overviewSections', group: 'overviewFilters', name: 'Zobrazené sekce Přehledu účtu', desc: 'Které karty Přehled účtu ukazuje (totéž jde přepnout přímo v přehledu).', old: P + ' → Přehled účtu', ids: ['overviewSectionSettings'] },

    // 3 Číselníky
    { id: 'taxonomyEditor', group: 'taxonomy', name: 'Volby číselníků', desc: 'Setupy, hladiny, LTA Levels, order flow, typy cílů, trend, kontext dne, psychika …', old: 'Číselníky', ids: ['taxonomyGroups'] },
    { id: 'taxonomyTransfer', group: 'taxonomyTransfer', name: 'Přenos číselníků', desc: 'Zkopírovat do jiného deníku, export a import souboru.', old: 'Číselníky', ids: ['taxonomyCopyTarget', 'taxonomyCopyBtn', 'taxonomyExportBtn', 'taxonomyImportInput', 'taxonomyTransferNote'] },

    // 4 Hladiny a data trhu
    { id: 'marketEnabled', group: 'marketData', name: 'Data z NinjaTraderu – hlavní vypínač', desc: 'Vypnuto = deník se chová jako dřív. První zapnutí zapne doporučenou sadu.', old: P + ' → Data trhu', ids: ['marketEnabled'] },
    { id: 'marketFeatures', group: 'marketData', name: 'Ukládání minutových svíček dne · Snímek trhu při vstupu', desc: 'Co se z NinjaTraderu sbírá.', old: P + ' → Data trhu', ids: ['marketFeatures'] },
    { id: 'marketBackfill', group: 'marketData', name: 'Doplnit svíčky a snímky pro dny s obchody', desc: 'Zpětné doplnění, stav konektoru a složka svíček.', old: P + ' → Data trhu', ids: ['marketBarsPanel', 'marketBarsInfo', 'marketConnectorInfo', 'marketBackfill', 'marketCancel', 'marketOpenFolder', 'marketProgress'] },
    { id: 'marketVa', group: 'marketData', name: 'Value area (VAH / VAL) – % objemu', desc: 'Kolik procent objemu dne tvoří value area.', old: P + ' → Data trhu', ids: ['marketSnapshotPanel', 'marketVaPct', 'marketSnapshotConn'] },
    { id: 'marketLiveRoots', group: 'marketData', name: 'Živé ticky – instrumenty', desc: 'Které instrumenty konektor sleduje; prázdné = automaticky.', old: P + ' → Data trhu', ids: ['marketLiveRoots'] },
    { id: 'ltaFeatures', group: 'levels', name: 'Export archivu LTA levelů · Upozornění na verzi levelů po vstupu', desc: 'Archiv pro Backtest Lab a hlídání verze levelů.', old: P + ' → Data trhu', ids: ['ltaFeatures'] },
    { id: 'ltaEnabled', group: 'levels', name: 'Import LTA levelů zapnutý', desc: 'Doplňování levelů z LiveTradingAsistent.', old: P + ' → Hladiny → Z LTA souborů (dřív LTA levely)', ids: ['ltaEnabled'] },
    { id: 'ltaAutoInForm', group: 'levels', name: 'Doplnit automaticky ve formuláři', desc: 'Po vyplnění instrumentu a ceny vstupu, jen při prázdném seznamu.', old: P + ' → Hladiny → Z LTA souborů', ids: ['ltaAutoInForm'] },
    { id: 'ltaVwapRow', group: 'levels', name: 'Přidat VWAP v čase vstupu', desc: 'VWAP z konektoru NT8 jako řádek Hladin.', old: P + ' → Hladiny → Z LTA souborů', ids: ['ltaVwapRow'] },
    { id: 'ltaNearestCount', group: 'levels', name: 'Počet levelů nad a pod vstupem', desc: 'N + N nejbližších.', old: P + ' → Hladiny → Z LTA souborů', ids: ['ltaNearestCount'] },
    { id: 'ltaFiles', group: 'levels', name: 'Soubory a levely', desc: 'Které soubory a názvy LTA se nečtou.', old: P + ' → Hladiny → Z LTA souborů', ids: ['ltaFiles'] },
    { id: 'ltaExclude', group: 'levels', name: 'Vyloučit názvy obsahující…', desc: 'Textové vzory názvů, které se nedoplňují.', old: P + ' → Hladiny → Z LTA souborů', ids: ['ltaExcludePatterns'] },
    { id: 'ltaArchive', group: 'levels', name: 'Ukládat verze levelů po dnech', desc: 'Archiv pro obchody zapsané později.', old: P + ' → Hladiny → Z LTA souborů', ids: ['ltaArchive', 'ltaArchiveInfo', 'ltaMissingDays'] },
    { id: 'ltaRetention', group: 'levels', name: 'Mazat archiv starší než (dní)', desc: '0 = nemazat.', old: P + ' → Hladiny → Z LTA souborů', ids: ['ltaRetentionDays'] },
    { id: 'ltaFolder', group: 'levels', name: 'Složka LTA', desc: 'Odkud se levely čtou (změnit, výchozí, otevřít, obnovit).', old: P + ' → Hladiny → Z LTA souborů', ids: ['ltaFolderInfo', 'ltaChooseFolder', 'ltaResetFolder', 'ltaOpenFolder', 'ltaRefresh'] },
    { id: 'snapshotLevelsOn', group: 'levelsSnapshot', name: 'Doplňovat řádky hladin ze snímku trhu', desc: 'VPOC, VAH / VAL, high / low dne a včerejška do Hladin.', old: P + ' → Hladiny → Ze snímku trhu', ids: ['levelsSnapshotSection', 'levelsSnapshotOnLabel', 'levelsSnapshotOn', 'levelsSnapshotWhy'] },
    { id: 'snapshotLevelsN', group: 'levelsSnapshot', name: 'Řádky ze snímku – N nad a N pod', desc: 'Kolik nejbližších hodnot ze snímku.', old: P + ' → Hladiny → Ze snímku trhu', ids: ['marketLevelsNField', 'marketLevelsN'] },
    { id: 'snapshotLevelTypes', group: 'levelsSnapshot', name: 'Typy řádků ze snímku', desc: 'VPOC 30M netest / aktuální, VPOC / VAH / VAL dne a včerejška, high / low.', old: P + ' → Hladiny → Ze snímku trhu', ids: ['marketLevelTypes'] },
    { id: 'snapshotFeatures', group: 'levelsSnapshot', name: 'Test / netest doplněný ze svíček', desc: 'U řádků bez ručního test / netest.', old: P + ' → Data trhu', ids: ['snapshotFeatures'] },
    { id: 'mapOn', group: 'levelsMap', name: 'Mapa obchodu v kartě Hladiny', desc: 'Graf hladin, Vstupu, SL a cílů; vypnuto = karta jako dřív.', old: P + ' → Hladiny → Zobrazení', ids: ['levelsViewMap'] },
    { id: 'mapBars', group: 'levelsMap', name: 'Počet svíček v mapě', desc: '5 nebo 10 svíček ze snímku trhu.', old: P + ' → Hladiny → Zobrazení', ids: ['levelsViewBars'] },
    { id: 'signalBar', group: 'levelsMap', name: 'Náhled a výběr signální svíčky', desc: 'Svíčky před vstupem a dopočet signální svíčky.', old: P + ' → Data trhu', ids: ['mapFeatures'] },

    // 5 Instrumenty a účty
    { id: 'accountBasics', group: 'account', name: 'Počáteční stav, měna a kurz USD / CZK', desc: 'Základ equity tohoto deníku a přepočet do CZK.', old: 'Obecné → Účet', ids: ['startingBalance', 'currency', 'usdCzkRate', 'saveSettings'] },
    { id: 'templates', group: 'templates', name: 'Šablony podle instrumentu', desc: 'Plán, hodnota bodu, tick, komise, max. SL, komentář.', old: 'Šablony', ids: ['templateList', 'tplNewInstrument', 'tplNewPlan', 'tplNewPointValue', 'tplNewTickSize', 'tplNewCommission', 'tplNewMaxSl', 'tplNewComment', 'addTemplate'] },
    { id: 'connectorCommission', group: 'templates', name: 'Komise u nových importovaných obchodů', desc: 'Ze šablony, nebo nahlášená konektorem.', old: 'Šablony', ids: ['useConnectorCommission', 'saveConnectorCommissionSetting'] },
    { id: 'risk', group: 'risk', name: 'Limity účtu', desc: 'Max. denní a celkový drawdown, limity obchodů, profit target za den.', old: 'Řízení rizika', ids: ['riskMaxDailyDrawdown', 'riskMaxTotalDrawdown', 'riskMaxSlPerDay', 'riskMaxTradesPerDay', 'riskMaxProfitTradesPerDay', 'riskProfitTargetPerDay', 'saveRiskSettings'] },
    { id: 'breakEven', group: 'breakEven', name: 'Break Even a slučování cílů', desc: 'Rozpoznávat Break Even, práh, slučovat TP1 / TP2 / BE.', old: 'Řízení rizika → Break Even a slučování obchodů', ids: ['breakEvenEnabled', 'breakEvenThreshold', 'autoMergeLegs', 'saveBreakEvenSettings'] },
    { id: 'accountMapping', group: 'accountMapping', name: 'Přiřazení účtů ke kartám', desc: 'Účet → deník, ruční přidání účtu, skryté účty.', old: 'Integrace → Přiřazení účtů', ids: ['captureNewAccount', 'captureAddAccount', 'captureMappingRows', 'captureSaveMappings', 'captureHiddenAccountsBox'] },

    // 6 Připojení a zdroje dat
    { id: 'captureInfo', group: 'captureStatus', name: 'Stav služby, endpoint a API klíč', desc: 'Kam konektory posílají obchody.', old: 'Integrace → Stav a obecné', ids: ['captureStatusText', 'capturePendingCount', 'captureEndpoint', 'captureApiKey'] },
    { id: 'autoImport', group: 'captureStatus', name: 'Automatický import', desc: 'Import uzavřených obchodů z konektorů.', old: 'Integrace → Stav a obecné', ids: ['captureAutoImportSelect'] },
    { id: 'screenshots', group: 'captureStatus', name: 'Screenshoty u obchodů tohoto deníku', desc: 'Vypnuto, monitor nebo vybraná okna; co když okno chybí.', old: 'Integrace → Stav a obecné', scope: 'journal', ids: ['captureScreenshotMode', 'captureShotJournal', 'captureWindowsBox', 'captureWindowRules', 'captureWindowNew', 'captureWindowAdd', 'captureWindowLoad', 'captureWindowList', 'captureMissingBox', 'captureScreenshotMissing'] },
    { id: 'afterShots', group: 'captureStatus', name: 'Screenshoty po výstupu', desc: 'Druhá sekce „Po obchodu“: kolik minut po výstupu a kolik snímků.', old: 'Integrace → Stav a obecné', scope: 'journal', ids: ['captureAfterEnabled', 'captureAfterMinutes', 'captureAfterMax'] },
    { id: 'captureActions', group: 'captureStatus', name: 'Obnovit stav, testy, import, nový API klíč, fronta', desc: 'Akce a diagnostika příjmu obchodů.', old: 'Integrace → Stav a obecné', ids: ['captureRefresh', 'captureTestSequence', 'captureTestMultiTarget', 'captureTestScaleIn', 'captureImport', 'nt8ManualImportBtn', 'captureOpenConnectors', 'captureNewKey', 'captureClear'] },
    { id: 'ninjaConnector', group: 'ninjatrader', name: 'Konektor NinjaTraderu', desc: 'Stav, upozornění po aktualizaci NT8, instalace.', old: 'Integrace → NinjaTrader', ids: ['ntConnectorState', 'ntUpdateNoticeSelect', 'captureInstallNinja', 'captureExportConnector'] },
    { id: 'ctraderCbot', group: 'ctrader', name: 'cTrader cBot a limitky přes MCP', desc: 'Test, stažení a aktualizace cBota; čtení čekajících příkazů.', old: 'Integrace → cTrader', ids: ['capCtrader', 'captureTestCTrader', 'captureExportCTrader', 'captureInstallCTrader'] },
    { id: 'tradingview', group: 'tradingview', name: 'TradingView – Pine Script a webhook relay', desc: 'Příprava skriptu, adresa Workeru, token, stažení alertů.', old: 'Integrace → TradingView', ids: ['capturePrepareTradingView', 'capturePrepareWorker', 'captureExportTradingView', 'captureExportTradingViewWorker', 'relayUrl', 'relayToken', 'relayEnabled', 'saveRelay', 'pollRelay'] },
    { id: 'newsButton', group: 'newsCalendar', name: 'Tlačítko „📰 Kalendář zpráv“ v horní liště', desc: 'A adresa, kterou otevře.', old: 'Obecné → Kalendář zpráv', ids: ['newsShowButton', 'newsUrl'] },
    { id: 'newsBadges', group: 'newsCalendar', name: 'Štítky „📰“ u dnů se zprávami', desc: 'Měny, dopad a zdroj dat štítků.', old: 'Obecné → Kalendář zpráv', ids: ['newsBadges', 'newsCurrencies', 'newsMinImpact', 'newsFeedUrl', 'newsRefreshBtn', 'newsStatus'] },

    // 7 Data a zálohy
    { id: 'dataLocation', group: 'dataLocation', name: 'Umístění dat', desc: 'Změnit nebo vrátit složku dat (aplikace se restartuje).', old: 'Data a zálohy', ids: ['dataLocationInfo', 'changeDataLocation', 'resetDataLocation'] },
    { id: 'imagesLocation', group: 'imagesLocation', name: 'Složka obrázků', desc: 'Změnit, otevřít, vrátit; doplnit chybějící obrázky ze zálohy.', old: 'Data a zálohy', ids: ['imagesLocationInfo', 'changeImagesLocation', 'openImagesFolder', 'resetImagesLocation', 'imagesIntegrityInfo', 'restoreImagesFromBackup'] },
    { id: 'backupAll', group: 'backup', name: 'Záloha všech deníků', desc: 'Aktualizovat zálohu, obnovit, umístění zálohy.', old: 'Data a zálohy → Záloha a obnova', ids: ['updateBackup', 'restoreBackup', 'backupPathInfo', 'changeBackupPath'] },
    { id: 'backupImages', group: 'backup', name: 'Obrázky v záloze', desc: 'Zrcadlo obrázků vedle zálohy, nebo obrázky přímo v souboru.', old: 'Data a zálohy → Záloha a obnova', ids: ['backupImagesMirror', 'backupImagesMirrorInfo', 'chooseBackupImagesDir', 'resetBackupImagesDir', 'backupIncludeImages'] },
    { id: 'backupJournal', group: 'backup', name: 'Záloha aktivního deníku (JSON)', desc: 'Stáhnout a nahrát zálohu jednoho deníku.', old: 'Data a zálohy → Záloha a obnova', scope: 'journal', ids: ['exportJson', 'importJson'] },
    { id: 'dangerZone', group: 'backup', name: 'Smazat data deníku · Kompletní reset', desc: 'Nevratné akce.', old: 'Data a zálohy → Záloha a obnova', ids: ['clearAll', 'factoryReset'] },
    { id: 'aiExport', group: 'aiExport', name: 'Export pro Backtest Lab a AI', desc: 'Odlehčená kopie deníků pro Backtest Lab a Claude Cowork.', old: 'Data a zálohy → Export pro AI analýzu', ids: ['aiExportInfo', 'regenerateAiExports'] },
    { id: 'csvColumns', group: 'aiExport', name: 'Nové sloupce v CSV', desc: 'Signální svíčka, objem a zdroj hladin na konec CSV (vyžaduje Data z NinjaTraderu).', old: P + ' → Data trhu', ids: ['exportFeatures'] },
    { id: 'recalcCommission', group: 'tools', name: 'Přepočítat komisi u uložených obchodů', desc: 'Podle šablon instrumentů v aktivním deníku.', old: 'Šablony', ids: ['recalcCommissionBtn'] },
    { id: 'backfillSide', group: 'tools', name: 'Doplnit směr u starších obchodů', desc: 'Long / Short podle cen a výsledku.', old: 'Šablony', ids: ['backfillSideBtn', 'backfillSideReport'] },

    // 8 Aplikace
    { id: 'update', group: 'update', name: 'Zkontrolovat a nainstalovat aktualizaci', desc: 'Nová verze aplikace.', old: 'Obecné → Aktualizace aplikace', ids: ['updateInfo', 'checkUpdates', 'installUpdate'] },
    { id: 'updateTest', group: 'update', name: 'Povolit testovací (pre-release) verze', desc: 'Nabízet i testovací verze.', old: 'Obecné → Aktualizace aplikace', ids: ['updateTestChannel', 'updateTestBox', 'checkTestUpdates', 'updateTestWarning'] }
  ]);

  const groupById = new Map(GROUPS.map(g => [g.id, g]));
  const sectionByKey = new Map(SECTIONS.map(s => [s.key, s]));
  const itemById = new Map(ITEMS.map(i => [i.id, i]));

  // Interní pojmy, které nepatří do názvů sekcí a skupin (zadání §2, test 8).
  const INTERNAL_TERMS = Object.freeze(['taxonom', 'snapshot', 'derived', 'legacy', 'capture', 'subtab', 'config', 'feature']);

  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function scopeOf(item) {
    const it = typeof item === 'string' ? itemById.get(item) : item;
    if (!it) return null;
    return it.scope || groupById.get(it.group)?.scope || null;
  }
  const SCOPE_LABEL = Object.freeze({ app: 'pro celou aplikaci', journal: 'pro tento deník', mixed: 'podle řádku: aplikace i deník' });

  // Hledání: název, popis, staré umístění, název skupiny a sekce. Bez diakritiky,
  // všechna slova dotazu musí sedět. Vrací položky s cestou „Sekce › Skupina“.
  function search(query, limit = 30) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const it of ITEMS) {
      const g = groupById.get(it.group), s = sectionByKey.get(g.section);
      const hay = fold([it.name, it.desc, it.old, g.title, g.desc, s.label].join(' '));
      if (!words.every(w => hay.includes(w))) continue;
      const inName = words.every(w => fold(it.name).includes(w));
      out.push({ id: it.id, name: it.name, desc: it.desc, old: it.old, group: g.id, groupTitle: g.title, section: s.key, sectionLabel: s.label, rank: inName ? 0 : 1 });
    }
    return out.sort((a, b) => a.rank - b.rank).slice(0, limit);
  }

  // Cíl přímého odkazu: sekce, skupina a prvek. `target` = id skupiny, id
  // položky nebo klíč sekce. Neznámý cíl = null.
  function resolve(target) {
    if (sectionByKey.has(target)) return { section: target, group: null, anchor: null };
    if (groupById.has(target)) return { section: groupById.get(target).section, group: target, anchor: null };
    const it = itemById.get(target);
    if (it) return { section: groupById.get(it.group).section, group: it.group, anchor: it.ids[0] || null };
    return null;
  }

  function groupsOf(section) { return GROUPS.filter(g => g.section === section); }

  return { SECTIONS, GROUPS, ITEMS, INTERNAL_TERMS, SCOPE_LABEL, scopeOf, search, resolve, groupsOf, fold };
}));
