'use strict';
// Načtení deníku pro testy. Zvládne tři tvary, které aplikace produkuje:
//  - jeden deník:   journal-data/<id>.json          → { trades, settings, dayNotes }
//  - odlehčená kopie: ai-export/<id>.json           → { journalId, trades, dayNotes }  (bez settings!)
//  - záloha všech:  collectAllJournalsBackup()      → { profiles, journals:[{profile,trades,settings}] }

const fs = require('fs');
const path = require('path');

function readJournalFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed.journals)) {
    return parsed.journals.map(j => ({
      name: j?.profile?.name || j?.profile?.id || 'bez názvu',
      trades: Array.isArray(j?.trades) ? j.trades : [],
      settings: mainSettings(j?.settings)
    }));
  }
  return [{
    name: parsed.journalId || path.basename(file, '.json'),
    trades: Array.isArray(parsed.trades) ? parsed.trades : [],
    settings: mainSettings(parsed.settings)
  }];
}

function mainSettings(settingsArray) {
  const entry = (Array.isArray(settingsArray) ? settingsArray : []).find(s => s?.key === 'main');
  const value = entry?.value || {};
  return {
    templates: Array.isArray(value.templates) ? value.templates : [],
    breakEvenEnabled: value.breakEvenEnabled === true,
    breakEvenThreshold: Number(value.breakEvenThreshold) || 0,
    useConnectorCommission: value.useConnectorCommission === true
  };
}

// Šablony instrumentů ze samostatného souboru – odlehčená kopie deníku je nenese.
function readTemplates(file) {
  const journals = readJournalFile(file);
  return journals.flatMap(j => j.settings.templates);
}

module.exports = { readJournalFile, mainSettings, readTemplates };
