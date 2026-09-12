'use strict';
// Identita bodů a P/L (spec §3.1, §2.1 KOREKCE, akceptační kritéria §9).
//
// Uložené pole `points` je VŽDY nevážený součet `Σ |leg.points|`
// (`combineTradeObjects`), případně přímo hodnota z formuláře. Celkovým bodům
// pozice se rovná jen tehdy, když má KAŽDÁ noha 1 kontrakt – jinak je to
// hodnota na kontrakt. Odtud dvojznačnost §3.1:
//   merged, každá noha 1 kontrakt → `points` vyjde jako CELKOVÝ součet
//   noha o 2+ kontraktech         → `points` je hodnota NA KONTRAKT
// Pozor, to druhé se týká i merged obchodů: v živém deníku má 4 z 34 merged
// obchodů jedinou nohu o 2 kontraktech. Rozdělení „merged = total, nemerged =
// na kontrakt" tedy neplatí, rozhoduje počet kontraktů na nohu.
//
// Tři testy, každý na něco jiného:
//   1. Starý export z doby PŘED opravou – důkaz, že chyba existovala, a
//      zároveň kontrola, že ji detektor pozná. Tenhle CSV soubor už nikdy
//      projít nemůže, je to historický doklad.
//   2. Živý deník po migraci v paměti – akceptační kritéria §9.
//   3. Konvence uloženého pole a označení nekonzistentních obchodů.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { loadRenderer } = require('./helpers/extract');
const { parseCsvRecords } = require('./helpers/csv');
const { readJournalFile, readTemplates } = require('./helpers/journal');
const { createReport } = require('./helpers/report');
const { REPORT_CSV, SETTINGS_JSON, exists, journalSources } = require('./helpers/paths');
const FJPoints = require('../app/points.js');

// Strop počtu kontraktů na jeden obchod. NENÍ to hodnota provize – slouží jen
// k tomu, aby horní mez zbytku byla konečná. Provize samotná se bere z šablony
// instrumentu v datech, nikdy z konstanty v testu.
const SANITY_MAX_CONTRACTS = 10;
const TOLERANCE = 0.01;

// Instrumenty vyloučené z ověřování rozhodnutím ze spec §2.1 („FDXS
// nezachraňovat"): poměr hrubého zisku k bodům u nich vychází na 0.62 až 2.20,
// nesedí tedy na žádnou jednu hodnotu bodu. Ta data jsou vadná sama o sobě,
// rekonstruovat se nemají a do statistik nepatří.
const UNVERIFIABLE_INSTRUMENTS = new Set(['FDXS']);

const report = createReport('points-identity.txt');
const skips = [];

function num(value) {
  const n = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fmt(n) {
  return n == null ? '—' : (Math.round(n * 100) / 100).toFixed(2);
}

// Vysvětlí řádek chybějícím násobkem počtu kontraktů: `Body` je na kontrakt,
// zatímco P/L je za celou pozici o k kontraktech.
//
// Klíčové je, že provize škáluje se stejným k jako body: u k kontraktů musí
// dopočtená provize vyjít na `provize za kontrakt × k`. Bez téhle podmínky
// vyhraje první k, jehož zbytek se jen vejde pod strop – u MES 2026-08-10 17:24
// (3 kontrakty) to dává nesmyslné „k=2, provize 18.20" místo správného
// „k=3, provize 5.70 = 1.90 × 3".
function explainByContractMultiple(points, pointValue, pnl, perContractCommission, commissionCeiling) {
  const candidates = [];
  for (let k = 2; k <= SANITY_MAX_CONTRACTS; k++) {
    const impliedCommission = points * pointValue * k - pnl;
    if (impliedCommission <= 0) continue;
    if (perContractCommission != null && Math.abs(impliedCommission - perContractCommission * k) <= TOLERANCE) {
      return { k, impliedCommission, exact: true, text: `Body × ${pointValue} × ${k} − ${fmt(impliedCommission)} (Body je na kontrakt, P/L za ${k} kontrakty; provize = ${fmt(perContractCommission)} × ${k})` };
    }
    if (commissionCeiling == null || impliedCommission <= commissionCeiling + TOLERANCE) candidates.push({ k, impliedCommission });
  }
  if (!candidates.length) return null;
  return { ...candidates[0], exact: false, text: `Body × ${pointValue} × ${candidates[0].k} − ${fmt(candidates[0].impliedCommission)} PŘIBLIŽNĚ (dopočtená provize nesedí na násobek provize za kontrakt)` };
}

function loadTemplates() {
  return exists(SETTINGS_JSON) ? readTemplates(SETTINGS_JSON) : null;
}

const RENDERER_NAMES = [
  'BUILTIN_POINT_VALUES',
  'normalizeInstrumentCode',
  'findTemplate',
  'getPointValueForInstrument',
  'getDefaultCommissionForInstrument',
  'classifyResult',
  'signed',
  'displayPoints',
  'weightedExitFields',
  'tradeTotalPoints',
  'tradePointsTotal',
  'displayPointsTotal',
  'deriveStopLossPrice',
  'migrateTradePointsFields'
];

test('starý export před opravou: detektor pozná záměnu jednotek v Body', (t) => {
  if (!exists(REPORT_CSV)) {
    const msg = `PŘESKOČENO: report CSV nenalezeno na ${REPORT_CSV} (přepsatelné env FJ_REPORT_CSV)`;
    skips.push(msg);
    report.heading('ČÁST 1 – starý export (důkaz chyby)').line(msg);
    t.skip(msg);
    return;
  }

  const templates = loadTemplates();
  const renderer = loadRenderer(RENDERER_NAMES, { settings: { templates: templates || [] } });
  const { header, records } = parseCsvRecords(fs.readFileSync(REPORT_CSV, 'utf8'));
  // Nový export má sloupec „Body celkem"; starý jen „Body".
  const pointsColumn = header.includes('Body celkem') ? 'Body celkem' : 'Body';

  const explained = [];
  const approximate = [];
  const unexplained = [];
  const incomplete = [];
  const excluded = [];
  let clean = 0;

  for (const rec of records) {
    const instrument = String(rec['Instrument'] || '').trim();
    const points = num(rec[pointsColumn]);
    const pnl = num(rec['P/L']);
    const label = `${rec['Datum'] || '?'} ${rec['Čas vstupu'] || '?'} ${instrument || '?'} ${rec['Výsledek'] || '?'}`;

    if (UNVERIFIABLE_INSTRUMENTS.has(instrument)) { excluded.push(label); continue; }
    if (!instrument || points == null || pnl == null || !String(rec['Cena vstupu'] || '').trim() || !String(rec['Cena výstupu'] || '').trim()) {
      incomplete.push(`${label} · ${pointsColumn}=${rec[pointsColumn] || '—'} P/L=${rec['P/L'] || '—'}`);
      continue;
    }
    const pointValue = renderer.getPointValueForInstrument(instrument);
    if (!pointValue) { incomplete.push(`${label} · hodnota bodu neznámá`); continue; }

    const perContractCommission = renderer.getDefaultCommissionForInstrument(instrument);
    const ceiling = perContractCommission == null ? null : perContractCommission * SANITY_MAX_CONTRACTS;
    const residual = points * pointValue - pnl;
    const belowZero = residual < -TOLERANCE;
    const aboveCeiling = ceiling != null && residual > ceiling + TOLERANCE;
    if (!belowZero && !aboveCeiling) { clean++; continue; }

    const explanation = explainByContractMultiple(points, pointValue, pnl, perContractCommission, ceiling);
    const where = belowZero ? 'pod nulou' : `nad stropem provize ${fmt(ceiling)}`;
    const base = `${label} · ${pointsColumn}=${fmt(points)} × ${pointValue} = ${fmt(points * pointValue)} · P/L=${fmt(pnl)} · zbytek=${fmt(residual)} (${where})`;
    if (explanation && explanation.exact) explained.push(`${base} · sedí na ${explanation.text}`);
    else if (explanation) approximate.push(`${base} · ${explanation.text}`);
    else unexplained.push(`${base} · NEODPOVÍDÁ žádnému celočíselnému násobku kontraktů – jiná chyba než §3.1`);
  }

  report.heading('ČÁST 1 – starý export (důkaz chyby)');
  report.line(`soubor: ${REPORT_CSV}`);
  report.line(`sloupec s body: „${pointsColumn}" · řádků: ${records.length} · sloupců: ${header.length}`);
  report.line(`má Kontrakty: ${header.includes('Kontrakty') ? 'ano' : 'NE'} · má Komise: ${header.includes('Komise') ? 'ano' : 'NE'}`);
  report.line(`v pořádku: ${clean}`);
  report.line(`záměna jednotek, přesně vysvětlená: ${explained.length}`);
  explained.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`vysvětlená jen přibližně: ${approximate.length}`);
  approximate.forEach(l => report.line(`  ? ${l}`));
  report.line(`nevysvětlená (jiná chyba): ${unexplained.length}`);
  unexplained.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`neúplné / neověřitelné: ${incomplete.length}`);
  incomplete.forEach(l => report.line(`  ? ${l}`));
  report.line(`vyloučeno rozhodnutím §2.1 (${[...UNVERIFIABLE_INSTRUMENTS].join(', ')}): ${excluded.length}`);

  if (pointsColumn === 'Body celkem') {
    // Export z opraveného kódu už chybu obsahovat nesmí.
    assert.equal(explained.length + approximate.length + unexplained.length, 0,
      'Nový export (se sloupcem „Body celkem") už nesmí porušovat identitu. Detail: tests/output/points-identity.txt');
    return;
  }
  // Starý export: chyba v něm JE a detektor ji musí najít. Kdyby tenhle assert
  // přestal platit, znamená to, že se rozbil detektor, ne že se opravila data.
  assert.ok(explained.length > 0,
    'Ve starém exportu má být záměna jednotek vidět – pokud není, přestal fungovat detektor.');
});

test('živý deník po migraci: pointsTotal × hodnota bodu − provize == pnlRaw (§9)', (t) => {
  const sources = journalSources();
  if (!sources.length) {
    const msg = 'PŘESKOČENO: nenalezen žádný datový soubor deníku (hledá se ai-export v userData / customDataDir, přepsatelné env FJ_JOURNAL). Reálná data se do repozitáře nekopírují – je veřejný.';
    skips.push(msg);
    report.heading('ČÁST 2 – živý deník po migraci').line(msg);
    t.skip(msg);
    return;
  }

  const templates = loadTemplates();
  const identityViolations = [];
  const perContractIdentityViolations = [];
  const flaggedInconsistent = [];
  const excluded = [];
  const noPointValue = [];
  const changedDisplay = [];
  let checked = 0;

  report.heading('ČÁST 2 – živý deník po migraci');

  for (const source of sources) {
    report.line(`soubor: ${source}`);
    for (const journal of readJournalFile(source)) {
      const settings = journal.settings.templates.length ? journal.settings : { ...journal.settings, templates: templates || [] };
      const renderer = loadRenderer(RENDERER_NAMES, { settings });
      report.line(`  deník: ${journal.name} · obchodů: ${journal.trades.length}`);

      for (const raw of journal.trades) {
        const instrument = String(raw.instrument || '').trim();
        const label = `${journal.name} · ${raw.date || '?'} ${raw.entryTime || '?'} ${instrument || '?'}`;
        if (UNVERIFIABLE_INSTRUMENTS.has(instrument)) { excluded.push(label); continue; }
        const pointValue = renderer.getPointValueForInstrument(instrument);
        if (!pointValue) { noPointValue.push(`${label} · hodnota bodu chybí`); continue; }

        // Migrace se spouští V PAMĚTI produkční funkcí – testuje se tím kód,
        // který data opravdu změní, ne jeho popis.
        const displayBefore = renderer.displayPoints(raw);
        const patch = renderer.migrateTradePointsFields(raw);
        const trade = { ...raw, ...(patch || {}) };
        checked++;

        if (trade.pointsInconsistent === true) {
          flaggedInconsistent.push(`${label} · body neodpovídají žádné konvenci, obchod je označený a patří mimo statistiky · ${raw.sourceEventId ? 'import' : 'ruční záznam'}`);
          continue;
        }

        const commission = Math.abs(Number(trade.commission) || 0);
        const net = renderer.signed(trade, 'pnl');
        const contracts = FJPoints.contractsOf(trade);

        // §9, kritérium 1: pointsTotal × hodnota bodu − provize == pnlRaw.
        const signedTotal = renderer.displayPointsTotal(trade);
        const residual = signedTotal * pointValue - commission * Math.sign(signedTotal || 1) - net;
        const identityOk = Math.abs(Math.abs(signedTotal) * pointValue - Math.abs(net + commission)) <= TOLERANCE;
        if (!identityOk) {
          identityViolations.push(`${label} · pointsTotal=${fmt(trade.pointsTotal)} × ${pointValue} = ${fmt(Math.abs(signedTotal) * pointValue)} · hrubý ${fmt(net + commission)} · rozdíl ${fmt(residual)}`);
        }

        // §9, kritérium 2: pointsTotal == pointsPerContract × contracts.
        if (Math.abs(Number(trade.pointsPerContract) * contracts - Number(trade.pointsTotal)) > 0.0001) {
          perContractIdentityViolations.push(`${label} · pointsPerContract=${fmt(trade.pointsPerContract)} × ${contracts} ≠ pointsTotal=${fmt(trade.pointsTotal)}`);
        }

        const displayAfter = renderer.displayPointsTotal(trade);
        if (Math.abs(displayAfter - displayBefore) > 0.005) {
          changedDisplay.push(`${label} · zobrazené body ${fmt(displayBefore)} → ${fmt(displayAfter)} (${contracts} kontrakty)`);
        }
      }
    }
  }

  report.line('');
  report.line(`obchodů ověřeno: ${checked}`);
  report.line(`porušení §9 „pointsTotal × hodnota bodu − provize == pnlRaw": ${identityViolations.length}`);
  identityViolations.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`porušení §9 „pointsTotal == pointsPerContract × contracts": ${perContractIdentityViolations.length}`);
  perContractIdentityViolations.forEach(l => report.line(`  ✗ ${l}`));
  report.line('');
  report.line(`MIGRACE ZMĚNÍ ZOBRAZENÉ BODY u ${changedDisplay.length} obchodů:`);
  changedDisplay.forEach(l => report.line(`  → ${l}`));
  report.line('');
  report.line(`označeno jako nekonzistentní (mimo statistiky): ${flaggedInconsistent.length}`);
  flaggedInconsistent.forEach(l => report.line(`  – ${l}`));
  report.line(`vyloučeno rozhodnutím §2.1 (${[...UNVERIFIABLE_INSTRUMENTS].join(', ')}): ${excluded.length}`);
  report.line(`bez hodnoty bodu (nelze ověřit): ${noPointValue.length}`);
  noPointValue.forEach(l => report.line(`  ? ${l}`));

  assert.equal(identityViolations.length, 0, `Identita §9 neplatí u ${identityViolations.length} obchodů. Detail: tests/output/points-identity.txt`);
  assert.equal(perContractIdentityViolations.length, 0, `pointsTotal ≠ pointsPerContract × contracts u ${perContractIdentityViolations.length} obchodů. Detail: tests/output/points-identity.txt`);
});

test('migrace je idempotentní a nepřepíše ruční hodnotu', (t) => {
  const sources = journalSources();
  if (!sources.length) { t.skip('bez datového souboru deníku'); return; }
  const templates = loadTemplates();

  for (const source of sources) {
    for (const journal of readJournalFile(source)) {
      const settings = journal.settings.templates.length ? journal.settings : { ...journal.settings, templates: templates || [] };
      const renderer = loadRenderer(RENDERER_NAMES, { settings });
      for (const raw of journal.trades) {
        if (UNVERIFIABLE_INSTRUMENTS.has(String(raw.instrument || '').trim())) continue;
        const once = { ...raw, ...(renderer.migrateTradePointsFields(raw) || {}) };
        const twice = { ...once, ...(renderer.migrateTradePointsFields(once) || {}) };
        assert.deepEqual(twice, once, `Druhé spuštění migrace změnilo obchod ${raw.date} ${raw.entryTime}`);
      }
    }
  }
});

test('migrace nepřepíše ručně zadanou cenu SL', () => {
  const renderer = loadRenderer(RENDERER_NAMES, {
    settings: { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }], breakEvenEnabled: false, breakEvenThreshold: 0 }
  });
  const trade = {
    instrument: 'MES', date: '2026-09-01', entryTime: '16:00',
    entryPrice: 7700, exitPrice: 7696, result: 'stoploss', side: 'long',
    points: 4, contracts: 1, commission: 1.9, pnl: 21.9, pnlRaw: -21.9,
    slPrice: 7697, slDerived: false
  };
  const patch = renderer.migrateTradePointsFields(trade) || {};
  assert.equal(patch.slPrice, undefined, 'ruční cena SL se nesmí přepsat');
  assert.equal(patch.slDerived, undefined, 'příznak odvozené ceny se nesmí nastavit na ruční hodnotu');
  // R se počítá z bodů na kontrakt a z ručního SL: 4 / |7700 − 7697| = 1.33.
  assert.equal(patch.rMultiple, 1.33);
});

test('u obchodu ukončeného na SL bez zadané ceny se cena odvodí a označí', () => {
  const renderer = loadRenderer(RENDERER_NAMES, {
    settings: { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }], breakEvenEnabled: false, breakEvenThreshold: 0 }
  });
  const trade = {
    instrument: 'MES', date: '2026-09-01', entryTime: '16:00',
    entryPrice: 7700, exitPrice: 7696, result: 'stoploss', side: 'long',
    points: 4, contracts: 1, commission: 1.9, pnl: 21.9, pnlRaw: -21.9
  };
  const patch = renderer.migrateTradePointsFields(trade) || {};
  assert.equal(patch.slPrice, 7696, 'cena SL se odvodí z výstupní ceny');
  assert.equal(patch.slDerived, true, 'odvozená hodnota musí být označená');
  assert.equal(patch.rMultiple, 1, '4 body na kontrakt / 4 body rizika = 1R');
});

test('u obchodu s víc cíli se cena SL bere z nohy, která šla na SL', () => {
  const renderer = loadRenderer(RENDERER_NAMES, {
    settings: { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }], breakEvenEnabled: false, breakEvenThreshold: 0 }
  });
  // TP1 vybral 3 body, druhá noha skončila na SL 2 body pod vstupem. Vážený
  // průměr výstupních cen by dal 7701.5, což není úroveň SL.
  const trade = {
    instrument: 'MES', date: '2026-09-01', entryTime: '16:00',
    entryPrice: 7700, exitPrice: 7701.5, result: 'target', side: 'long',
    points: 5, contracts: 2, commission: 3.8, pnl: 1.2, pnlRaw: 1.2,
    legs: [
      { label: 'TP1', exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, result: 'target', commission: 1.9, pnlRaw: 13.1 },
      { label: 'SL', exitTime: '16:09', exitPrice: 7698, points: 2, contracts: 1, result: 'stoploss', commission: 1.9, pnlRaw: -11.9 }
    ]
  };
  const patch = renderer.migrateTradePointsFields(trade) || {};
  assert.equal(patch.slPrice, 7698, 'bere se cena nohy na SL, ne vážený průměr 7701.5');
  assert.equal(patch.slDerived, true);
});

test.after(() => {
  if (skips.length) {
    report.heading('PŘESKOČENÉ KONTROLY');
    skips.forEach(s => report.line(`  ! ${s}`));
  }
  const file = report.write();
  console.log(`\nVýstup testu identity: ${file}`);
});
