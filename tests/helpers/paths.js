'use strict';
// Cesty ke vstupům testů na jednom místě.
//
// POZOR na rozvržení: `docs/` i `Claude files/` leží NAD repozitářem, v
// F:\Trading\Denik\DEV. Do repozitáře se nekopírují záměrně – repozitář je
// veřejný a jde o reálné obchody včetně P/L. Anonymizovat je nelze, protože
// testy potřebují právě ta vadná čísla.
//
// Každou cestu lze přepsat env proměnnou, ať jde test prohnat i jiným souborem
// (typicky živým deníkem z Electronu: FJ_JOURNAL=%APPDATA%/futures-journal-pro/...).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEV_ROOT = path.resolve(REPO_ROOT, '..');

const REPORT_CSV = process.env.FJ_REPORT_CSV
  || path.join(DEV_ROOT, 'docs', 'samples', 'futures-report_new.csv');

const JOURNAL_JSON = process.env.FJ_JOURNAL
  || path.join(DEV_ROOT, 'Claude files', 'FuturesJournal_AKTUALNI_ZALOHA.json');

const OUTPUT_DIR = path.join(REPO_ROOT, 'tests', 'output');

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

module.exports = { REPO_ROOT, DEV_ROOT, REPORT_CSV, JOURNAL_JSON, OUTPUT_DIR, exists };
