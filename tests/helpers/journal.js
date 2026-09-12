'use strict';
// Načtení deníku pro testy. Zvládne oba tvary, které aplikace produkuje:
//  - jeden deník:      journal-data/<id>.json  → { trades, settings, dayNotes }
//  - záloha všech:     collectAllJournalsBackup() → { profiles, journals:[{profile,trades,settings}] }

const fs = require('fs');

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
    name: 'deník',
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

module.exports = { readJournalFile, mainSettings };
