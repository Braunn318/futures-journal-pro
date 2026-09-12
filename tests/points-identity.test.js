'use strict';
// Identita bodů a P/L (spec §3.1, akceptační kritéria §9).
//
// Musí platit, že body × hodnota bodu − provize = čistý výsledek. Dnes to
// neplatí, protože uložené `points` míchají dvě jednotky: u merged multi-target
// obchodů jsou to body NA KONTRAKT, u jednorázově uzavřených pozic už agregované.
// Tenhle test je nasazený PŘED opravou, aby bylo vidět, že selhává přesně na tom,
// co se opravuje – commission/points matematika už v projektu dvakrát způsobila
// reálnou chybu v P/L.
//
// Dvě části, protože report CSV nemá `Kontrakty` ani `Komise` (spec §3.3 je
// nařizuje doplnit) a plná identita se z něj spočítat nedá – chybí dva ze čtyř
// členů. CSV proto kontroluje slabší, ale odvoditelnou formu; plnou identitu
// kontroluje JSON deník.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { loadRenderer } = require('./helpers/extract');
const { parseCsvRecords } = require('./helpers/csv');
const { readJournalFile } = require('./helpers/journal');
const { createReport } = require('./helpers/report');
const { REPORT_CSV, JOURNAL_JSON, exists } = require('./helpers/paths');

// Strop počtu kontraktů na jeden obchod. NENÍ to hodnota provize – slouží jen
// k tomu, aby horní mez zbytku byla konečná. Provize samotná se bere z šablony
// instrumentu v datech, nikdy z konstanty v testu.
const SANITY_MAX_CONTRACTS = 10;
const TOLERANCE = 0.01;

const report = createReport('points-identity.txt');
const skips = [];

function num(value) {
  const n = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fmt(n) {
  return n == null ? '—' : (Math.round(n * 100) / 100).toFixed(2);
}

// Jaký chybějící násobek počtu kontraktů by řádek vysvětlil. Vrací např.
// "Body × 5 × 2 − 3.80" – tedy že `Body` je na kontrakt, zatímco P/L je za
// celou pozici o 2 kontraktech.
function diagnose(points, pointValue, pnl, commissionCeiling) {
  for (let k = 2; k <= SANITY_MAX_CONTRACTS; k++) {
    const impliedCommission = points * pointValue * k - pnl;
    if (impliedCommission > 0 && (commissionCeiling == null || impliedCommission <= commissionCeiling + TOLERANCE)) {
      return `sedí na Body × ${pointValue} × ${k} − ${fmt(impliedCommission)} (Body je na kontrakt, P/L za ${k} kontrakty)`;
    }
  }
  return 'neodpovídá žádnému celočíselnému násobku kontraktů – prověřit ručně';
}

// Nastavení deníku (šablony instrumentů s hodnotou bodu a provizí) se berou
// z reálného datového souboru. Bez nich se hodnota bodu omezí na vestavěnou
// tabulku a horní mez zbytku se nedá spočítat – to se hlásí, ne obchází.
function loadSettings() {
  if (!exists(JOURNAL_JSON)) return null;
  const journals = readJournalFile(JOURNAL_JSON);
  const templates = journals.flatMap(j => j.settings.templates);
  return { templates, breakEvenEnabled: false, breakEvenThreshold: 0 };
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
  'tradeTotalPoints'
];

test('CSV report: zbytek Body × hodnota bodu − P/L leží mezi nulou a stropem provize', (t) => {
  if (!exists(REPORT_CSV)) {
    const msg = `PŘESKOČENO: report CSV nenalezeno na ${REPORT_CSV} (přepsatelné env FJ_REPORT_CSV)`;
    skips.push(msg);
    report.heading('ČÁST 1 – CSV report').line(msg);
    t.skip(msg);
    return;
  }

  const settings = loadSettings();
  const renderer = loadRenderer(RENDERER_NAMES, { settings: settings || { templates: [] } });
  const { header, records } = parseCsvRecords(fs.readFileSync(REPORT_CSV, 'utf8'));

  const tooLow = [];
  const tooHigh = [];
  const incomplete = [];
  const noPointValue = [];
  const noCeiling = new Set();

  for (const rec of records) {
    const instrument = String(rec['Instrument'] || '').trim();
    const points = num(rec['Body']);
    const pnl = num(rec['P/L']);
    const label = `${rec['Datum'] || '?'} ${rec['Čas vstupu'] || '?'} ${instrument || '?'} ${rec['Výsledek'] || '?'}`;

    if (!instrument || points == null || pnl == null || !String(rec['Cena vstupu'] || '').trim() || !String(rec['Cena výstupu'] || '').trim()) {
      incomplete.push(`${label} · Body=${rec['Body'] || '—'} P/L=${rec['P/L'] || '—'} vstup=${rec['Cena vstupu'] || '—'} výstup=${rec['Cena výstupu'] || '—'}`);
      continue;
    }

    const pointValue = renderer.getPointValueForInstrument(instrument);
    if (!pointValue) { noPointValue.push(`${label} · hodnota bodu není v šabloně ani ve vestavěné tabulce`); continue; }

    const perContractCommission = renderer.getDefaultCommissionForInstrument(instrument);
    const ceiling = perContractCommission == null ? null : perContractCommission * SANITY_MAX_CONTRACTS;
    if (ceiling == null) noCeiling.add(instrument);

    const residual = points * pointValue - pnl;
    if (residual < -TOLERANCE) {
      tooLow.push(`${label} · Body=${fmt(points)} × ${pointValue} = ${fmt(points * pointValue)} · P/L=${fmt(pnl)} · zbytek=${fmt(residual)} · ${diagnose(points, pointValue, pnl, ceiling)}`);
    } else if (ceiling != null && residual > ceiling + TOLERANCE) {
      tooHigh.push(`${label} · Body=${fmt(points)} × ${pointValue} = ${fmt(points * pointValue)} · P/L=${fmt(pnl)} · zbytek=${fmt(residual)} > strop provize ${fmt(ceiling)}`);
    }
  }

  report.heading('ČÁST 1 – CSV report');
  report.line(`soubor: ${REPORT_CSV}`);
  report.line(`sloupců: ${header.length}, řádků: ${records.length}`);
  report.line(`má sloupec Kontrakty: ${header.includes('Kontrakty') ? 'ano' : 'NE'} · má sloupec Komise: ${header.includes('Komise') ? 'ano' : 'NE'}`);
  report.line(`hodnota bodu a provize ze šablon: ${settings ? 'z reálného deníku' : 'NEDOSTUPNÉ – jen vestavěná tabulka'}`);
  if (noCeiling.size) report.line(`instrumenty bez provize v šabloně (horní mez se u nich nekontroluje): ${[...noCeiling].join(', ')}`);
  report.line('');
  report.line(`porušení DOLNÍ meze (zbytek < 0, aritmeticky nemožné): ${tooLow.length}`);
  tooLow.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`porušení HORNÍ meze (zbytek > strop provize): ${tooHigh.length}`);
  tooHigh.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`neúplné řádky (chybí cena, Body nebo P/L): ${incomplete.length}`);
  incomplete.forEach(l => report.line(`  ? ${l}`));
  report.line(`bez hodnoty bodu (nelze ověřit): ${noPointValue.length}`);
  noPointValue.forEach(l => report.line(`  ? ${l}`));

  assert.equal(
    tooLow.length + tooHigh.length,
    0,
    `Identita neplatí u ${tooLow.length + tooHigh.length} řádků (${tooLow.length} pod dolní mezí, ${tooHigh.length} nad horní). Detail: tests/output/points-identity.txt`
  );
});

test('JSON deník: pointsTotal × hodnota bodu − provize == pnlRaw', (t) => {
  if (!exists(JOURNAL_JSON)) {
    const msg = `PŘESKOČENO: datový soubor deníku nenalezen na ${JOURNAL_JSON} (přepsatelné env FJ_JOURNAL). Fixture se do repozitáře nekopíruje – je veřejný a jde o reálné obchody.`;
    skips.push(msg);
    report.heading('ČÁST 2 – JSON deník').line(msg);
    t.skip(msg);
    return;
  }

  const journals = readJournalFile(JOURNAL_JSON);
  const violations = [];
  const noPointValue = [];
  let checked = 0;

  report.heading('ČÁST 2 – JSON deník');
  report.line(`soubor: ${JOURNAL_JSON}`);

  for (const journal of journals) {
    const renderer = loadRenderer(RENDERER_NAMES, { settings: journal.settings });
    for (const trade of journal.trades) {
      const instrument = String(trade.instrument || '').trim();
      const label = `${journal.name} · ${trade.date || '?'} ${trade.entryTime || '?'} ${instrument || '?'}`;
      const pointValue = renderer.getPointValueForInstrument(instrument);
      if (!pointValue) { noPointValue.push(`${label} · hodnota bodu chybí`); continue; }

      const commission = Math.abs(Number(trade.commission) || 0);
      const net = renderer.signed(trade, 'pnl');       // pnlRaw, jinak odvozeno z result
      const gross = net + commission;                   // provize je vždy náklad
      const pointsTotal = renderer.tradeTotalPoints(trade);
      const expectedGross = pointsTotal * pointValue;
      const residual = Math.abs(gross) - expectedGross;
      checked++;

      if (Math.abs(residual) > TOLERANCE) {
        const legs = Array.isArray(trade.legs) ? trade.legs.length : 0;
        violations.push([
          `${label}`,
          `points=${fmt(Number(trade.points))} contracts=${trade.contracts} legs=${legs}`,
          `pointsTotal=${fmt(pointsTotal)} × ${pointValue} = ${fmt(expectedGross)}`,
          `pnlRaw=${fmt(net)} + provize ${fmt(commission)} = hrubý ${fmt(gross)}`,
          `rozdíl=${fmt(residual)}`
        ].join(' · '));
      }
    }
  }

  report.line(`obchodů ověřeno: ${checked}`);
  report.line(`porušení identity: ${violations.length}`);
  violations.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`bez hodnoty bodu (nelze ověřit): ${noPointValue.length}`);
  noPointValue.forEach(l => report.line(`  ? ${l}`));

  assert.equal(
    violations.length,
    0,
    `Identita neplatí u ${violations.length} z ${checked} obchodů. Detail: tests/output/points-identity.txt`
  );
});

test.after(() => {
  if (skips.length) {
    report.heading('PŘESKOČENÉ KONTROLY');
    skips.forEach(s => report.line(`  ! ${s}`));
  }
  const file = report.write();
  console.log(`\nVýstup testu identity: ${file}`);
});
