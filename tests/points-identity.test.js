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
// ROZSAH (spec §1.1, revize 12. 9. 2026): historická data se NEOPRAVUJÍ.
// Identita se vymáhá jen u nově vytvořených obchodů – to hlídá
// tests/new-trade-identity.test.js. Tady se ověřuje:
//   1. že starý export z doby před opravou chybu opravdu obsahuje (doklad
//      chyby a zároveň autotest detektoru – ten soubor projít nemůže),
//   2. že migrace historickým obchodům jen přidá příznak a NIC jim nezmění,
//   3. odvození ceny SL a výpočet R.

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

test('živý deník: staré obchody se jen označí a jejich zobrazení se nezmění', (t) => {
  const sources = journalSources();
  if (!sources.length) {
    const msg = 'PŘESKOČENO: nenalezen žádný datový soubor deníku (hledá se ai-export v userData / customDataDir, přepsatelné env FJ_JOURNAL). Reálná data se do repozitáře nekopírují – je veřejný.';
    skips.push(msg);
    report.heading('ČÁST 2 – živý deník (historie se neopravuje)').line(msg);
    t.skip(msg);
    return;
  }

  const templates = loadTemplates();
  const displayChanged = [];
  const flaggedLegacy = [];
  const alreadyUnambiguous = [];
  let checked = 0;

  report.heading('ČÁST 2 – živý deník (historie se neopravuje)');
  report.line('Rozsah podle spec §1.1: historická data se NEOPRAVUJÍ. Migrace jim jen');
  report.line('přidá příznak `legacyPointsConvention`, aby vypadly ze statistik podle R.');
  report.line('Zobrazené body ani P/L se u nich nemění.');
  report.line('');

  for (const source of sources) {
    report.line(`soubor: ${source}`);
    for (const journal of readJournalFile(source)) {
      const settings = journal.settings.templates.length ? journal.settings : { ...journal.settings, templates: templates || [] };
      const renderer = loadRenderer(RENDERER_NAMES, { settings });
      report.line(`  deník: ${journal.name} · obchodů: ${journal.trades.length}`);

      for (const raw of journal.trades) {
        const label = `${journal.name} · ${raw.date || '?'} ${raw.entryTime || '?'} ${String(raw.instrument || '?')}`;
        const before = renderer.displayPointsTotal(raw);
        const patch = renderer.migrateTradePointsFields(raw);
        const trade = { ...raw, ...(patch || {}) };
        checked++;

        if (trade.legacyPointsConvention === true) flaggedLegacy.push(label);
        else alreadyUnambiguous.push(label);

        const after = renderer.displayPointsTotal(trade);
        if (Math.abs(after - before) > 0.0001) {
          displayChanged.push(`${label} · zobrazené body ${fmt(before)} → ${fmt(after)}`);
        }

        // Migrace nesmí sahat na nic jiného než na ten jeden příznak.
        const touched = Object.keys(patch || {});
        assert.deepEqual(touched.filter(k => k !== 'legacyPointsConvention'), [],
          `${label}: migrace změnila i jiná pole než legacyPointsConvention (${touched.join(', ')})`);
      }
    }
  }

  report.line('');
  report.line(`obchodů prošlo migrací: ${checked}`);
  report.line(`označeno jako legacy (mimo statistiky podle R, v P/L zůstávají): ${flaggedLegacy.length}`);
  report.line(`už má jednoznačná bodová pole: ${alreadyUnambiguous.length}`);
  report.line(`obchodů, kterým se změnilo zobrazené číslo: ${displayChanged.length}`);
  displayChanged.forEach(l => report.line(`  ✗ ${l}`));

  assert.equal(displayChanged.length, 0,
    `Migrace změnila zobrazené body u ${displayChanged.length} historických obchodů – podle §1.1 se historie nemá opravovat. Detail: tests/output/points-identity.txt`);
});

test('migrace je idempotentní', (t) => {
  const sources = journalSources();
  if (!sources.length) { t.skip('bez datového souboru deníku'); return; }
  const templates = loadTemplates();

  for (const source of sources) {
    for (const journal of readJournalFile(source)) {
      const settings = journal.settings.templates.length ? journal.settings : { ...journal.settings, templates: templates || [] };
      const renderer = loadRenderer(RENDERER_NAMES, { settings });
      for (const raw of journal.trades) {
        const once = { ...raw, ...(renderer.migrateTradePointsFields(raw) || {}) };
        const twice = { ...once, ...(renderer.migrateTradePointsFields(once) || {}) };
        assert.deepEqual(Object.keys(twice).sort(), Object.keys(once).sort(),
          `Druhé spuštění migrace přidalo pole u obchodu ${raw.date} ${raw.entryTime}`);
        for (const k of Object.keys(once)) {
          if (typeof once[k] === 'object') continue;
          assert.equal(twice[k], once[k], `Druhé spuštění migrace změnilo ${k} u ${raw.date} ${raw.entryTime}`);
        }
      }
    }
  }
});

// --- Odvození ceny SL (§3.3b). Používá se při UKLÁDÁNÍ nového obchodu, ne
// --- v migraci: historická data se podle §1.1 neopravují.

test('odvození ceny SL: obchod ukončený na SL bez zadané ceny', () => {
  const renderer = loadRenderer(RENDERER_NAMES, {
    settings: { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }], breakEvenEnabled: false, breakEvenThreshold: 0 }
  });
  const derived = renderer.deriveStopLossPrice({
    instrument: 'MES', entryPrice: 7700, exitPrice: 7696, result: 'stoploss', side: 'long',
    points: 4, contracts: 1, commission: 1.9, pnlRaw: -21.9
  });
  assert.equal(derived, 7696, 'cena SL se odvodí z výstupní ceny');
});

test('odvození ceny SL: ziskový obchod žádnou cenu neodvozuje', () => {
  const renderer = loadRenderer(RENDERER_NAMES, {
    settings: { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }], breakEvenEnabled: false, breakEvenThreshold: 0 }
  });
  const derived = renderer.deriveStopLossPrice({
    instrument: 'MES', entryPrice: 7700, exitPrice: 7703, result: 'target', side: 'long',
    points: 3, contracts: 1, commission: 1.9, pnlRaw: 13.1
  });
  assert.equal(derived, null, 'u ziskového obchodu se cena SL hádat nesmí');
});

test('odvození ceny SL: u víc cílů se bere cena nohy, která šla na SL', () => {
  const renderer = loadRenderer(RENDERER_NAMES, {
    settings: { templates: [{ instrument: 'MES', pointValue: 5, defaultCommission: 1.9 }], breakEvenEnabled: false, breakEvenThreshold: 0 }
  });
  // TP1 vybral 3 body, druhá noha skončila na SL 2 body pod vstupem. Vážený
  // průměr výstupních cen by dal 7700.5, což není úroveň SL.
  const derived = renderer.deriveStopLossPrice({
    instrument: 'MES', entryPrice: 7700, exitPrice: 7700.5, result: 'target', side: 'long',
    points: 5, contracts: 2, commission: 3.8, pnlRaw: 1.2,
    legs: [
      { label: 'TP1', exitTime: '16:05', exitPrice: 7703, points: 3, contracts: 1, result: 'target', commission: 1.9, pnlRaw: 13.1 },
      { label: 'SL', exitTime: '16:09', exitPrice: 7698, points: 2, contracts: 1, result: 'stoploss', commission: 1.9, pnlRaw: -11.9 }
    ]
  });
  assert.equal(derived, 7698, 'bere se cena nohy na SL, ne vážený průměr');
});

test('R se počítá z bodů na kontrakt, nikdy z celkových', () => {
  // Dvoukontraktová pozice: 4 body na kontrakt, riziko 4 body → 1R.
  // Kdyby se R počítalo z celkových 8 bodů, vyšlo by 2R.
  assert.equal(FJPoints.rMultipleOf(4, 4), 1);
  assert.equal(FJPoints.rMultipleOf(8, 4), 2, 'kontrolní hodnota: z celkových bodů by vyšlo 2R');
  assert.equal(FJPoints.slPointsOf(7700, 7696), 4);
  assert.equal(FJPoints.slPointsOf(7700, 7700), null, 'nulové riziko nedává R');
  assert.equal(FJPoints.rMultipleOf(4, null), null, 'bez ceny SL není R');
});

test.after(() => {
  if (skips.length) {
    report.heading('PŘESKOČENÉ KONTROLY');
    skips.forEach(s => report.line(`  ! ${s}`));
  }
  const file = report.write();
  console.log(`\nVýstup testu identity: ${file}`);
});
