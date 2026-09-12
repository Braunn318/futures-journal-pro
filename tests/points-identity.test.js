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
// Zvolená konvence po opravě je `pointsTotal` – u obchodů, které dnes ukazují
// total, se tím hodnota nezmění, opraví se jen ty ostatní.
//
// Testy jsou nasazené PŘED opravou, aby bylo vidět, že selhávají přesně na tom,
// co se opravuje – commission/points matematika už v projektu dvakrát způsobila
// reálnou chybu v P/L.
//
// Dvě části, protože report CSV nemá `Kontrakty` ani `Komise` (spec §3.3 je
// nařizuje doplnit) a plná identita se z něj spočítat nedá – chybí dva ze čtyř
// členů. CSV proto kontroluje slabší, ale odvoditelnou formu; plnou identitu
// a uloženou konvenci kontroluje JSON deník.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { loadRenderer } = require('./helpers/extract');
const { parseCsvRecords } = require('./helpers/csv');
const { readJournalFile, readTemplates } = require('./helpers/journal');
const { createReport } = require('./helpers/report');
const { REPORT_CSV, SETTINGS_JSON, exists, journalSources } = require('./helpers/paths');

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
// zatímco P/L je za celou pozici o k kontraktech. Vrací null, když řádek na
// žádný celočíselný násobek nesedí – takový případ je jiná chyba a nesmí se
// schovat pod §3.1.
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
    const exact = perContractCommission != null
      && Math.abs(impliedCommission - perContractCommission * k) <= TOLERANCE;
    const withinCeiling = commissionCeiling == null || impliedCommission <= commissionCeiling + TOLERANCE;
    if (exact) {
      return { k, impliedCommission, exact: true, text: `Body × ${pointValue} × ${k} − ${fmt(impliedCommission)} (Body je na kontrakt, P/L za ${k} kontrakty; provize = ${fmt(perContractCommission)} × ${k})` };
    }
    if (withinCeiling) candidates.push({ k, impliedCommission });
  }
  if (!candidates.length) return null;
  const best = candidates[0];
  return {
    ...best,
    exact: false,
    text: `Body × ${pointValue} × ${best.k} − ${fmt(best.impliedCommission)} PŘIBLIŽNĚ (dopočtená provize nesedí na násobek provize za kontrakt – ověřit ručně)`
  };
}

function loadTemplates() {
  if (!exists(SETTINGS_JSON)) return null;
  return readTemplates(SETTINGS_JSON);
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

  const templates = loadTemplates();
  const renderer = loadRenderer(RENDERER_NAMES, { settings: { templates: templates || [] } });
  const { header, records } = parseCsvRecords(fs.readFileSync(REPORT_CSV, 'utf8'));

  const explained = [];
  const approximate = [];
  const unexplained = [];
  const incomplete = [];
  const excluded = [];
  const noPointValue = [];
  const noCeiling = new Set();

  for (const rec of records) {
    const instrument = String(rec['Instrument'] || '').trim();
    const points = num(rec['Body']);
    const pnl = num(rec['P/L']);
    const label = `${rec['Datum'] || '?'} ${rec['Čas vstupu'] || '?'} ${instrument || '?'} ${rec['Výsledek'] || '?'}`;

    if (UNVERIFIABLE_INSTRUMENTS.has(instrument)) { excluded.push(label); continue; }

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
    const belowZero = residual < -TOLERANCE;
    const aboveCeiling = ceiling != null && residual > ceiling + TOLERANCE;
    if (!belowZero && !aboveCeiling) continue;

    // Diagnóza se dělá u OBOU mezí. Když `points` je na kontrakt a kontraktů je
    // víc, zbytek může vyjít jak pod nulou, tak vysoko nad stropem provize –
    // podle znaménka obchodu. Bez téhle diagnózy i u horní meze se stejná chyba
    // tváří jako dvě různé.
    const explanation = explainByContractMultiple(points, pointValue, pnl, perContractCommission, ceiling);
    const where = belowZero ? 'pod nulou' : `nad stropem provize ${fmt(ceiling)}`;
    const base = `${label} · Body=${fmt(points)} × ${pointValue} = ${fmt(points * pointValue)} · P/L=${fmt(pnl)} · zbytek=${fmt(residual)} (${where})`;
    if (explanation && explanation.exact) explained.push(`${base} · sedí na ${explanation.text}`);
    else if (explanation) approximate.push(`${base} · ${explanation.text}`);
    else unexplained.push(`${base} · NEODPOVÍDÁ žádnému celočíselnému násobku kontraktů – jiná chyba než §3.1`);
  }

  report.heading('ČÁST 1 – CSV report');
  report.line(`soubor: ${REPORT_CSV}`);
  report.line(`sloupců: ${header.length}, řádků: ${records.length}`);
  report.line(`má sloupec Kontrakty: ${header.includes('Kontrakty') ? 'ano' : 'NE'} · má sloupec Komise: ${header.includes('Komise') ? 'ano' : 'NE'}`);
  report.line(`šablony instrumentů: ${templates ? `${SETTINGS_JSON}` : 'NEDOSTUPNÉ – jen vestavěná tabulka hodnot bodu'}`);
  if (noCeiling.size) report.line(`instrumenty bez provize v šabloně (horní mez se u nich nekontroluje): ${[...noCeiling].join(', ')}`);
  report.line('');
  report.line(`porušení vysvětlená záměnou jednotek (§3.1): ${explained.length}`);
  explained.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`porušení vysvětlená jen PŘIBLIŽNĚ (provize nesedí – ověřit ručně): ${approximate.length}`);
  approximate.forEach(l => report.line(`  ? ${l}`));
  report.line(`porušení NEVYSVĚTLENÁ (jiná chyba): ${unexplained.length}`);
  unexplained.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`neúplné řádky (chybí cena, Body nebo P/L): ${incomplete.length}`);
  incomplete.forEach(l => report.line(`  ? ${l}`));
  report.line(`vyloučeno rozhodnutím §2.1 (${[...UNVERIFIABLE_INSTRUMENTS].join(', ')}): ${excluded.length}`);
  excluded.forEach(l => report.line(`  – ${l}`));
  report.line(`bez hodnoty bodu (nelze ověřit): ${noPointValue.length}`);
  noPointValue.forEach(l => report.line(`  ? ${l}`));

  assert.equal(
    explained.length + approximate.length + unexplained.length,
    0,
    `Identita neplatí u ${explained.length + approximate.length + unexplained.length} řádků (${explained.length} vysvětleno záměnou jednotek, ${approximate.length} jen přibližně, ${unexplained.length} nevysvětleno). Detail: tests/output/points-identity.txt`
  );
});

test('JSON deník: uložené points odpovídá zvolené konvenci pointsTotal', (t) => {
  const sources = journalSources();
  if (!sources.length) {
    const msg = 'PŘESKOČENO: nenalezen žádný datový soubor deníku (hledá se ai-export v userData / customDataDir, přepsatelné env FJ_JOURNAL). Reálná data se do repozitáře nekopírují – je veřejný.';
    skips.push(msg);
    report.heading('ČÁST 2 – JSON deník').line(msg);
    t.skip(msg);
    return;
  }

  const templates = loadTemplates();
  const identityViolations = [];
  const storedIsPerContract = [];
  const storedUnexplained = [];
  const excluded = [];
  const noPointValue = [];
  let ambiguousSingleContract = 0;
  let storedMatchesTotal = 0;
  let checked = 0;

  report.heading('ČÁST 2 – JSON deník');

  for (const source of sources) {
    report.line(`soubor: ${source}`);
    for (const journal of readJournalFile(source)) {
      // Šablony z odlehčené kopie nechodí – doplní se ze samostatného souboru.
      const settings = journal.settings.templates.length ? journal.settings : { ...journal.settings, templates: templates || [] };
      const renderer = loadRenderer(RENDERER_NAMES, { settings });
      report.line(`  deník: ${journal.name} · obchodů: ${journal.trades.length}`);

      for (const trade of journal.trades) {
        const instrument = String(trade.instrument || '').trim();
        const label = `${journal.name} · ${trade.date || '?'} ${trade.entryTime || '?'} ${instrument || '?'}`;
        if (UNVERIFIABLE_INSTRUMENTS.has(instrument)) { excluded.push(label); continue; }

        const pointValue = renderer.getPointValueForInstrument(instrument);
        if (!pointValue) { noPointValue.push(`${label} · hodnota bodu chybí`); continue; }

        const commission = Math.abs(Number(trade.commission) || 0);
        const net = renderer.signed(trade, 'pnl');   // pnlRaw, jinak odvozeno z result
        const gross = net + commission;              // provize je vždy náklad
        const contracts = Math.abs(Number(trade.contracts)) || 1;
        const storedPoints = Math.abs(Number(trade.points) || 0);
        checked++;

        // (a) Plná identita: hrubý výsledek musí odpovídat celkovým bodům.
        // `tradeTotalPoints()` už váží nohy počtem kontraktů, takže tohle
        // ověřuje matematiku, ne konvenci uloženého pole.
        const pointsTotalByFn = renderer.tradeTotalPoints(trade);
        const identityResidual = Math.abs(gross) - pointsTotalByFn * pointValue;
        if (Math.abs(identityResidual) > TOLERANCE) {
          identityViolations.push([
            label,
            `points=${fmt(storedPoints)} contracts=${contracts} legs=${Array.isArray(trade.legs) ? trade.legs.length : 0}`,
            `tradeTotalPoints=${fmt(pointsTotalByFn)} × ${pointValue} = ${fmt(pointsTotalByFn * pointValue)}`,
            `pnlRaw=${fmt(net)} + provize ${fmt(commission)} = hrubý ${fmt(gross)}`,
            `rozdíl=${fmt(identityResidual)}`,
            trade.sourceEventId ? 'import' : 'ruční záznam'
          ].join(' · '));
          continue;   // nekonzistentní obchod nemá smysl klasifikovat podle konvence
        }

        // (b) Konvence ULOŽENÉHO pole. Tohle je ta kontrola, kterou předchozí
        // verze testu neměla: počítala jen přes `tradeTotalPoints()`, což je už
        // ta správná funkce, takže chybu v uloženém `points` chytit nemohla.
        const expectedTotal = Math.abs(gross) / pointValue;
        const expectedPerContract = expectedTotal / contracts;
        const matchesTotal = Math.abs(storedPoints - expectedTotal) <= TOLERANCE;
        const matchesPerContract = Math.abs(storedPoints - expectedPerContract) <= TOLERANCE;

        if (matchesTotal && matchesPerContract) { ambiguousSingleContract++; continue; }  // contracts = 1, nerozlišitelné
        if (matchesTotal) { storedMatchesTotal++; continue; }
        if (matchesPerContract) {
          storedIsPerContract.push(`${label} · uložené points=${fmt(storedPoints)} je NA KONTRAKT · total má být ${fmt(expectedTotal)} (${contracts} kontrakty) · legs=${Array.isArray(trade.legs) ? trade.legs.length : 0}`);
        } else {
          storedUnexplained.push(`${label} · uložené points=${fmt(storedPoints)} neodpovídá ani total ${fmt(expectedTotal)}, ani na kontrakt ${fmt(expectedPerContract)}`);
        }
      }
    }
  }

  report.line('');
  report.line(`obchodů ověřeno: ${checked}`);
  report.line(`(a) porušení plné identity hrubý = pointsTotal × hodnota bodu: ${identityViolations.length}`);
  identityViolations.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`(b) uložené points je NA KONTRAKT místo total: ${storedIsPerContract.length}`);
  storedIsPerContract.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`(b) uložené points neodpovídá ani jedné konvenci: ${storedUnexplained.length}`);
  storedUnexplained.forEach(l => report.line(`  ✗ ${l}`));
  report.line(`uložené points už odpovídá total (po opravě se nesmí změnit): ${storedMatchesTotal}`);
  report.line(`nerozlišitelné (1 kontrakt, total == na kontrakt): ${ambiguousSingleContract}`);
  report.line(`vyloučeno rozhodnutím §2.1 (${[...UNVERIFIABLE_INSTRUMENTS].join(', ')}): ${excluded.length}`);
  report.line(`bez hodnoty bodu (nelze ověřit): ${noPointValue.length}`);
  noPointValue.forEach(l => report.line(`  ? ${l}`));

  const total = identityViolations.length + storedIsPerContract.length + storedUnexplained.length;
  assert.equal(
    total,
    0,
    `Neplatí u ${total} z ${checked} obchodů: ${identityViolations.length} porušuje identitu, ${storedIsPerContract.length} má points na kontrakt místo total, ${storedUnexplained.length} neodpovídá ničemu. Detail: tests/output/points-identity.txt`
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
