'use strict';
// Cesty ke vstupům testů na jednom místě.
//
// POZOR na rozvržení: `docs/` i `Claude files/` leží NAD repozitářem, v
// F:\Trading\Denik\DEV. Do repozitáře se nekopírují záměrně – repozitář je
// veřejný a jde o reálné obchody včetně P/L. Anonymizovat je nelze, protože
// testy potřebují právě ta vadná čísla.
//
// Deník se bere ze ŽIVÝCH dat, ne ze zálohy: záloha v `Claude files/` má jen
// 46 obchodů z 10.–27. 8., zatímco živý deník má 86 obchodů do 11. 9. Použije se
// odlehčená kopie z `ai-export/`, kterou aplikace udržuje při každém uložení
// (`writeAiExportMirror`, main.js:327) – je to tentýž obsah bez base64 obrázků,
// tedy 100 kB místo 100 MB.
//
// Každou cestu lze přepsat env proměnnou:
//   FJ_REPORT_CSV  – export z Reportů (futures-report.csv)
//   FJ_JOURNAL     – konkrétní datový soubor deníku (i plný journal-data/<id>.json)
//   FJ_SETTINGS    – soubor, ze kterého se berou šablony instrumentů

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEV_ROOT = path.resolve(REPO_ROOT, '..');

const REPORT_CSV = process.env.FJ_REPORT_CSV
  || path.join(DEV_ROOT, 'docs', 'samples', 'futures-report_new.csv');

// Odlehčená kopie deníku nenese `settings`, takže šablony instrumentů (hodnota
// bodu, provize za kontrakt) se berou odsud. Šablony se mění zřídka.
const SETTINGS_JSON = process.env.FJ_SETTINGS
  || path.join(DEV_ROOT, 'Claude files', 'FuturesJournal_AKTUALNI_ZALOHA.json');

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isDir(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

// Kde aplikace opravdu drží data. `data-location.json` může ukazovat na
// přenesenou složku; když ta neexistuje (přesunutý disk, jiný stroj), spadne se
// na výchozí userData.
function dataRoots() {
  const roots = [];
  const userData = process.env.APPDATA ? path.join(process.env.APPDATA, 'futures-journal-pro') : null;
  if (userData) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'data-location.json'), 'utf8'));
      if (cfg?.customDataDir && isDir(cfg.customDataDir)) roots.push(cfg.customDataDir);
    } catch { /* konfigurace umístění nemusí existovat */ }
    roots.push(userData);
  }
  return roots.filter(isDir);
}

// Seznam datových souborů deníku k otestování.
function journalSources() {
  if (process.env.FJ_JOURNAL) return [process.env.FJ_JOURNAL];
  for (const root of dataRoots()) {
    const mirror = path.join(root, 'ai-export');
    if (!isDir(mirror)) continue;
    const files = fs.readdirSync(mirror)
      .filter(f => f.endsWith('.json') && f !== 'index.json')
      .map(f => path.join(mirror, f));
    if (files.length) return files;
  }
  return [];
}

const OUTPUT_DIR = path.join(REPO_ROOT, 'tests', 'output');

module.exports = { REPO_ROOT, DEV_ROOT, REPORT_CSV, SETTINGS_JSON, OUTPUT_DIR, exists, isDir, dataRoots, journalSources };
