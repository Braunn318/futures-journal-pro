'use strict';
// Editovatelné číselníky: neměnný klíč, editovatelný popisek, skrývání místo
// mazání, vlastní volby, pořadí a sloučené volby (aliasy).
//
// Nejdůležitější vlastnost celého návrhu je, že ÚPRAVA ČÍSELNÍKU SE NIKDY
// NEDOTKNE ULOŽENÝCH OBCHODŮ. V datech obchodu je klíč, ne popisek, takže
// přejmenování je čistě zobrazovací změna; a skrytá volba zůstává platnou
// hodnotou, takže obchod, který ji má, se nesmí změnit ani osekat.
//
// Kdyby šlo volbu smazat, obchody, které ji používají, by zůstaly s hodnotou
// mimo číselník – proto mazání v API vůbec není.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

const SETTINGS = {
  templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }],
  breakEvenEnabled: false,
  breakEvenThreshold: 0,
  autoMergeLegs: true
};

// Každý test si konfiguraci nastaví sám; modul je jinak sdílený.
test.beforeEach(() => FJTaxonomy.applyConfig({}));
test.afterEach(() => FJTaxonomy.applyConfig({}));

function tradeWith(overrides) {
  return {
    id: 'tx-' + Math.random().toString(16).slice(2),
    instrument: 'MES', date: '2026-09-20', entryTime: '16:00', entryPrice: 7700,
    exitTime: '16:05', exitPrice: 7703, result: 'target', side: 'long',
    points: 3, pointsTotal: 3, pointsPerContract: 3, contracts: 1,
    commission: 1.9, pnl: 13.1, pnlRaw: 13.1,
    ...overrides
  };
}

// ---------------------------------------------------------------- přejmenování

test('přejmenování mění POUZE popisek, klíč zůstává', () => {
  const key = 'VWAP';
  assert.equal(FJTaxonomy.labelOf('ENTRY_LEVEL', key), 'VWAP');

  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { labels: { VWAP: 'VWAP (15min)' } } });

  assert.equal(FJTaxonomy.labelOf('ENTRY_LEVEL', key), 'VWAP (15min)');
  assert.ok(FJTaxonomy.isValidKey('ENTRY_LEVEL', key), 'klíč po přejmenování dál platí');
  assert.ok(FJTaxonomy.allKeys('ENTRY_LEVEL').includes('VWAP'), 'v číselníku je pořád týž klíč');
  // A hlavně: obchod s tou hodnotou se nezměnil.
  assert.deepEqual([...FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', ['VWAP'])], ['VWAP']);
});

// ------------------------------------------------------------------- skrývání

test('skrytí volby NEZMĚNÍ žádný existující obchod', () => {
  const trades = [
    tradeWith({ setupCode: 'AVE', entryLevels: ['VWAP', 'VAH'], ofConfirm: ['IMBALANCE'] }),
    tradeWith({ setupCode: 'M2_OF', entryLevels: ['VWAP'], ofConfirm: ['ABS_BID', 'HIGH_VOLUME'] }),
    tradeWith({ setupCode: 'AVE', entryLevels: ['LIQUIDITY'], ofConfirm: [] })
  ];
  // Nejdřív se hodnoty jednou projdou očistou při VÝCHOZÍM číselníku. Očista
  // hodnoty řadí do pořadí číselníku (viz test níž), takže bez tohohle kroku
  // by test měřil normalizaci pořadí, ne dopad skrytí. Takhle je jedinou
  // proměnnou opravdu jen to skrytí.
  for (const trade of trades) {
    trade.entryLevels = FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', trade.entryLevels);
    trade.ofConfirm = FJTaxonomy.sanitizeMulti('OF_CONFIRM', trade.ofConfirm);
    trade.setupCode = FJTaxonomy.sanitizeSingle('SETUP', trade.setupCode);
  }
  const before = JSON.parse(JSON.stringify(trades));

  // Skryjeme hodnotu, kterou dva z těch obchodů používají.
  FJTaxonomy.applyConfig({
    ENTRY_LEVEL: { hidden: ['VWAP'] },
    SETUP: { hidden: ['AVE'] }
  });

  for (const trade of trades) {
    // Přesně to, co s obchodem dělá uložení i sloučení.
    trade.entryLevels = FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', trade.entryLevels);
    trade.ofConfirm = FJTaxonomy.sanitizeMulti('OF_CONFIRM', trade.ofConfirm);
    trade.setupCode = FJTaxonomy.sanitizeSingle('SETUP', trade.setupCode);
  }

  assert.deepEqual(trades, before, 'skrytí volby nesmí změnit ani jedno pole uloženého obchodu');
});

test('skrytá volba zůstává platnou hodnotou a nabídne se u obchodu, který ji má', () => {
  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { hidden: ['VWAP'] } });

  assert.ok(FJTaxonomy.isValidKey('ENTRY_LEVEL', 'VWAP'), 'skrytá volba je pořád platná hodnota');
  assert.ok(FJTaxonomy.isHidden('ENTRY_LEVEL', 'VWAP'));

  const forNewTrade = FJTaxonomy.visibleOptions('ENTRY_LEVEL').map(o => o.key);
  assert.ok(!forNewTrade.includes('VWAP'), 'novému obchodu se skrytá volba nenabízí');

  // Obchod, který ji má uloženou, ji musí v nabídce pořád vidět – jinak by se
  // jeho hodnota při editaci tiše ztratila.
  const forExisting = FJTaxonomy.visibleOptions('ENTRY_LEVEL', ['VWAP']);
  const entry = forExisting.find(o => o.key === 'VWAP');
  assert.ok(entry, 'u obchodu s touhle hodnotou se volba nabízí dál');
  assert.equal(entry.hidden, true, 'a je označená jako skrytá');
});

test('skrytá hodnota se dál objevuje ve statistikách', () => {
  // groupSummary je skutečná funkce, na které stojí tabulky v Reportech.
  const r = loadRenderer(['signed', 'reportSigned', 'groupSummary'], { settings: SETTINGS });

  FJTaxonomy.applyConfig({ SETUP: { hidden: ['AVE'] } });

  const rows = [
    tradeWith({ setupCode: 'AVE', pnlRaw: 13.1, pnl: 13.1, result: 'target' }),
    tradeWith({ setupCode: 'AVE', pnlRaw: -21.9, pnl: 21.9, result: 'stoploss' }),
    tradeWith({ setupCode: 'M2_OF', pnlRaw: 26.2, pnl: 26.2, result: 'target' })
  ];

  const groups = r.groupSummary(rows, 'setupCode');
  const ave = groups.find(g => g.name === 'AVE');

  assert.ok(ave, 'skrytý setup má ve statistice pořád vlastní řádek');
  assert.equal(ave.count, 2, 'počítají se oba obchody');
  assert.equal(ave.wins, 1);
  assert.equal(ave.losses, 1);
  assert.ok(Math.abs(ave.pnl - (13.1 - 21.9)) < 0.001, 'P/L skryté hodnoty se dál sčítá');
  // A popisek je pořád k dispozici, takže řádek nebude bezejmenný.
  assert.equal(FJTaxonomy.labelOf('SETUP', 'AVE'), 'AVE Pattern');
});

test('skrytí jde vrátit zpět', () => {
  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { hidden: ['VWAP'] } });
  assert.ok(FJTaxonomy.isHidden('ENTRY_LEVEL', 'VWAP'));
  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { hidden: [], visible: ['VWAP'] } });
  assert.ok(!FJTaxonomy.isHidden('ENTRY_LEVEL', 'VWAP'));
});

test('mazání volby v API vůbec není', () => {
  // Pojistka proti tomu, aby někdo mazání časem doplnil: obchod s takovou
  // hodnotou by zůstal s klíčem mimo číselník.
  const api = Object.keys(FJTaxonomy);
  assert.ok(!api.some(name => /^(delete|remove|drop)/i.test(name)),
    'číselník nesmí mít mazací operaci, jen skrývání: ' + api.join(', '));
});

// -------------------------------------------------------------- vlastní volby

test('vlastní volba dostane stabilní klíč odvozený z popisku', () => {
  const key = FJTaxonomy.makeCustomKey('ENTRY_LEVEL', 'Týdenní open');
  assert.equal(key, 'CUSTOM_TYDENNI_OPEN', 'diakritika se odstraní, klíč je ASCII');

  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { custom: { [key]: 'Týdenní open' } } });
  assert.ok(FJTaxonomy.isValidKey('ENTRY_LEVEL', key));
  assert.equal(FJTaxonomy.labelOf('ENTRY_LEVEL', key), 'Týdenní open');
  assert.deepEqual([...FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', [key])], [key], 'projde přes očistu hodnot');
});

test('přejmenování vlastní volby nemění její klíč', () => {
  const key = FJTaxonomy.makeCustomKey('ENTRY_LEVEL', 'Týdenní open');
  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { custom: { [key]: 'Týdenní open' } } });
  const trade = tradeWith({ entryLevels: [key] });

  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { custom: { [key]: 'Weekly open' } } });

  assert.equal(FJTaxonomy.labelOf('ENTRY_LEVEL', key), 'Weekly open');
  assert.deepEqual([...FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', trade.entryLevels)], [key],
    'obchod si drží původní klíč');
});

test('dvě vlastní volby se stejným popiskem nedostanou stejný klíč', () => {
  const first = FJTaxonomy.makeCustomKey('ENTRY_LEVEL', 'Open');
  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { custom: { [first]: 'Open' } } });
  const second = FJTaxonomy.makeCustomKey('ENTRY_LEVEL', 'Open');
  assert.notEqual(second, first);
});

test('vlastní volba s popiskem bez písmen dostane použitelný klíč', () => {
  assert.equal(FJTaxonomy.makeCustomKey('ENTRY_LEVEL', '???'), 'CUSTOM_VOLBA');
});

// -------------------------------------------------------------------- pořadí

test('změna pořadí nemění množinu klíčů ani data obchodů', () => {
  const original = FJTaxonomy.allKeys('ENTRY_LEVEL');
  const reordered = ['VWAP', 'VAH', ...original.filter(k => k !== 'VWAP' && k !== 'VAH')];

  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { order: reordered } });

  assert.deepEqual(FJTaxonomy.allKeys('ENTRY_LEVEL'), reordered);
  assert.deepEqual([...FJTaxonomy.allKeys('ENTRY_LEVEL')].sort(), [...original].sort(),
    'pořadí mění jen pořadí, ne obsah');
  // Očista hodnot respektuje nové pořadí, ale hodnoty nemění.
  assert.deepEqual([...FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', ['VAH', 'VWAP'])], ['VWAP', 'VAH']);
});

test('klíč, který v uloženém pořadí chybí, nezmizí', () => {
  // Nastane po aktualizaci appky, která do výchozího číselníku přidá volbu.
  FJTaxonomy.applyConfig({ ENTRY_LEVEL: { order: ['VWAP', 'VAH'] } });
  const keys = FJTaxonomy.allKeys('ENTRY_LEVEL');
  assert.equal(keys[0], 'VWAP');
  assert.equal(keys[1], 'VAH');
  assert.ok(keys.includes('LIQUIDITY'), 'neuvedené klíče se přidají na konec');
  assert.equal(keys.length, Object.keys(FJTaxonomy.ENTRY_LEVEL).length);
});

// -------------------------------------------------------- sloučené volby (aliasy)

test('MEGA_BID a MEGA_ASK jsou sloučené do absorpce, klíče zůstávají platné', () => {
  assert.equal(FJTaxonomy.canonicalKey('OF_CONFIRM', 'MEGA_BID'), 'ABS_BID');
  assert.equal(FJTaxonomy.canonicalKey('OF_CONFIRM', 'MEGA_ASK'), 'ABS_ASK');

  // Nenabízejí se u nových obchodů…
  const offered = FJTaxonomy.visibleOptions('OF_CONFIRM').map(o => o.key);
  assert.ok(!offered.includes('MEGA_BID'));
  assert.ok(!offered.includes('MEGA_ASK'));

  // …ale zůstávají platné, aby obchod, který je má, zůstal nedotčený.
  assert.ok(FJTaxonomy.isValidKey('OF_CONFIRM', 'MEGA_BID'));
  assert.deepEqual([...FJTaxonomy.sanitizeMulti('OF_CONFIRM', ['MEGA_BID'])], ['MEGA_BID'],
    'stará hodnota se NEPŘEPISUJE na ABS_BID – data obchodu se nemění');
  assert.equal(FJTaxonomy.labelOf('OF_CONFIRM', 'MEGA_BID'), 'Mega bid', 'popisek zůstává čitelný');
});

test('VPOC_CANDLE je sloučené do VPOC_1M', () => {
  assert.equal(FJTaxonomy.canonicalKey('ENTRY_LEVEL', 'VPOC_CANDLE'), 'VPOC_1M');
  assert.ok(!FJTaxonomy.visibleOptions('ENTRY_LEVEL').map(o => o.key).includes('VPOC_CANDLE'));
  assert.ok(FJTaxonomy.isValidKey('ENTRY_LEVEL', 'VPOC_CANDLE'));
});

test('VWAP_DEV se NESLUČUJE – je to jiná hladina než VAH/VAL', () => {
  assert.equal(FJTaxonomy.canonicalKey('ENTRY_LEVEL', 'VWAP_DEV'), 'VWAP_DEV', 'nemá alias');
  assert.ok(!FJTaxonomy.isHidden('ENTRY_LEVEL', 'VWAP_DEV'), 'zůstává v nabídce');
  assert.ok(FJTaxonomy.visibleOptions('ENTRY_LEVEL').map(o => o.key).includes('VWAP_DEV'));
});

test('sloučení nezmění obchod, který starý klíč používá', () => {
  const trade = tradeWith({ ofConfirm: ['MEGA_BID', 'IMBALANCE'], entryLevels: ['VPOC_CANDLE'] });
  // Aliasy jsou ve výchozím číselníku, takže tady se porovnává proti hodnotám
  // po jednom průchodu očistou – stejně jako u testu skrývání.
  trade.ofConfirm = FJTaxonomy.sanitizeMulti('OF_CONFIRM', trade.ofConfirm);
  trade.entryLevels = FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', trade.entryLevels);
  const before = JSON.parse(JSON.stringify(trade));

  trade.ofConfirm = FJTaxonomy.sanitizeMulti('OF_CONFIRM', trade.ofConfirm);
  trade.entryLevels = FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', trade.entryLevels);

  assert.deepEqual(trade, before, 'očista hodnot je idempotentní a aliasy nic nepřepisují');
  assert.ok(trade.ofConfirm.includes('MEGA_BID'), 'starý klíč v datech zůstává');
  assert.ok(trade.entryLevels.includes('VPOC_CANDLE'));
});

test('očista hodnot řadí do pořadí číselníku – zdokumentované chování', () => {
  // Tohle platí bez ohledu na skrývání a aliasy: uložená hodnota má stabilní
  // pořadí, aby se stejná kombinace v seznamu i v CSV vypisovala vždy stejně.
  // Mění se pořadí pole, nikdy jeho obsah.
  const out = FJTaxonomy.sanitizeMulti('OF_CONFIRM', ['IMBALANCE', 'ABS_BID']);
  assert.deepEqual([...out], ['ABS_BID', 'IMBALANCE']);
  assert.deepEqual([...out].sort(), ['ABS_BID', 'IMBALANCE'].sort(), 'obsah se nemění');
});

// ------------------------------------------------- úprava nepřežije jen v UI

test('sloučení víc cílů respektuje upravený číselník a nezahodí skryté hodnoty', () => {
  const r = loadRenderer([
    'normalizeInstrumentCode', 'findTemplate', 'getPointValueForInstrument',
    'getDefaultCommissionForInstrument', 'classifyResult', 'signed', 'tradeTotalPoints',
    'weightedExitFields', 'legFromTrade', 'mergeSamePriceLegs', 'labelLegs',
    'mergeContextFields', 'combineTradeObjects'
  ], { settings: SETTINGS });

  const customKey = FJTaxonomy.makeCustomKey('ENTRY_LEVEL', 'Týdenní open');
  FJTaxonomy.applyConfig({
    ENTRY_LEVEL: { hidden: ['VWAP'], custom: { [customKey]: 'Týdenní open' } }
  });

  const tp1 = tradeWith({ positionId: 'p', exitTime: '16:05', entryLevels: ['VWAP'], ofConfirm: ['MEGA_BID'] });
  const tp2 = tradeWith({ positionId: 'p', exitTime: '16:09', exitPrice: 7705, points: 5, pnlRaw: 23.1, pnl: 23.1, entryLevels: [customKey] });

  const merged = r.combineTradeObjects([tp1, tp2]);

  assert.ok([...merged.entryLevels].includes('VWAP'), 'skrytá hodnota přežije sloučení');
  assert.ok([...merged.entryLevels].includes(customKey), 'vlastní volba přežije sloučení');
  assert.deepEqual([...merged.ofConfirm], ['MEGA_BID'], 'aliasovaná hodnota se nepřepíše');
  assert.equal(merged.confluenceCount, 2);
});

// ------------------------------------------------- přenos mezi deníky a soubor
//
// Číselníky patří ke kartě deníku, takže se musí dát přenést. Import je jediné
// místo, kam se do konfigurace dostane cizí soubor – proto je na něj nejvíc
// kontrol: cizí klíč se zahodí a vlastní volba nesmí přebít výchozí klíč.

test('export a import projdou celým kolečkem beze změny', () => {
  const customKey = FJTaxonomy.makeCustomKey('ENTRY_LEVEL', 'Týdenní open');
  const config = {
    ENTRY_LEVEL: {
      labels: { VWAP: 'VWAP (15min)' },
      custom: { [customKey]: 'Týdenní open' },
      hidden: ['LIQUIDITY'],
      order: ['VWAP', 'VAH']
    },
    OF_CONFIRM: { labels: { IMBALANCE: 'Imbalance 3:1' } }
  };

  const payload = FJTaxonomy.exportPayload(config, { journalName: 'Backtest' });
  assert.equal(payload.kind, FJTaxonomy.EXPORT_KIND);
  assert.equal(payload.journalName, 'Backtest');

  // Přes JSON a zpátky, jako přes soubor.
  const back = FJTaxonomy.configFromImport(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(back, config);
});

test('import přijme i holou konfiguraci bez obalu', () => {
  const back = FJTaxonomy.configFromImport({ ENTRY_LEVEL: { hidden: ['VWAP'] } });
  assert.deepEqual(back, { ENTRY_LEVEL: { hidden: ['VWAP'] } });
});

test('import zahodí cizí klíče a neznámé skupiny', () => {
  const clean = FJTaxonomy.configFromImport({
    ENTRY_LEVEL: {
      labels: { VWAP: 'VWAP jinak', NEEXISTUJE: 'nic' },
      hidden: ['VAH', 'TAKY_NE'],
      order: ['VWAP', 'CIZI_KLIC']
    },
    NEZNAMA_SKUPINA: { labels: { A: 'B' } }
  });

  assert.deepEqual(clean, {
    ENTRY_LEVEL: { labels: { VWAP: 'VWAP jinak' }, hidden: ['VAH'], order: ['VWAP'] }
  });
  assert.ok(!('NEZNAMA_SKUPINA' in clean));
});

test('import nedovolí vlastní volbě přebít výchozí klíč', () => {
  // Kdyby prošla, import by tiše přeznačil význam hodnoty, kterou už obchody
  // používají – VWAP by najednou znamenal něco jiného.
  const clean = FJTaxonomy.configFromImport({
    ENTRY_LEVEL: { custom: { VWAP: 'Něco úplně jiného', CUSTOM_MOJE: 'Moje volba' } }
  });
  assert.deepEqual(clean.ENTRY_LEVEL.custom, { CUSTOM_MOJE: 'Moje volba' });
  assert.equal(FJTaxonomy.labelOf('ENTRY_LEVEL', 'VWAP'), 'VWAP', 'výchozí popisek zůstal');
});

test('import odmítne soubor, který není export číselníků', () => {
  assert.throws(() => FJTaxonomy.configFromImport({ kind: 'futures-journal-backup', trades: [] }),
    /není export číselníků/);
  assert.throws(() => FJTaxonomy.configFromImport(null), /platný JSON objekt/);
  assert.throws(() => FJTaxonomy.configFromImport({ ENTRY_LEVEL: { labels: { NIC: 'x' } } }),
    /žádnou použitelnou úpravu/, 'soubor bez jediné použitelné položky projít nemá');
});

test('import nezmění obchody – přenáší se popisky a viditelnost, ne data', () => {
  const trade = tradeWith({ entryLevels: ['VWAP', 'VAH'], ofConfirm: ['IMBALANCE'] });
  trade.entryLevels = FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', trade.entryLevels);
  trade.ofConfirm = FJTaxonomy.sanitizeMulti('OF_CONFIRM', trade.ofConfirm);
  const before = JSON.parse(JSON.stringify(trade));

  FJTaxonomy.applyConfig(FJTaxonomy.configFromImport({
    ENTRY_LEVEL: { labels: { VWAP: 'VWAP (15min)' }, hidden: ['VAH'] }
  }));

  trade.entryLevels = FJTaxonomy.sanitizeMulti('ENTRY_LEVEL', trade.entryLevels);
  trade.ofConfirm = FJTaxonomy.sanitizeMulti('OF_CONFIRM', trade.ofConfirm);

  assert.deepEqual(trade, before, 'naimportovaný číselník se obchodů nedotkne');
  assert.equal(FJTaxonomy.labelOf('ENTRY_LEVEL', 'VWAP'), 'VWAP (15min)', 'změnil se jen popisek');
});

test('popis konfigurace řekne, co se přenáší', () => {
  const lines = FJTaxonomy.describeConfig({
    ENTRY_LEVEL: { labels: { VWAP: 'x' }, hidden: ['VAH'], custom: { CUSTOM_A: 'A' }, order: ['VWAP'] },
    SETUP: {}
  });
  assert.equal(lines.length, 1, 'skupina bez úprav se nevypisuje');
  assert.match(lines[0], /^Hladina vstupu: /);
  assert.match(lines[0], /1× přejmenováno/);
  assert.match(lines[0], /1× vlastní volba/);
  assert.match(lines[0], /1× skryto/);
  assert.match(lines[0], /vlastní pořadí/);
  assert.deepEqual(FJTaxonomy.describeConfig({}), [], 'výchozí číselník nemá co přenášet');
});
