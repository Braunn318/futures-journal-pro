'use strict';
// Sběr výstupu testu do souboru. Selhání assertem řekne jen "neplatí" – k
// diagnóze je potřeba vidět KAŽDÝ porušující řádek a vzorec, na který sedí.
// Soubor je v tests/output/, které je v .gitignore: obsahuje reálná čísla
// obchodů a repozitář je veřejný.

const fs = require('fs');
const path = require('path');
const { OUTPUT_DIR } = require('./paths');

function createReport(name) {
  const lines = [];
  const api = {
    line(text = '') { lines.push(String(text)); return api; },
    heading(text) { lines.push('', text, '-'.repeat(text.length)); return api; },
    write() {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const file = path.join(OUTPUT_DIR, name);
      const header = [
        `# ${name}`,
        `# vygenerováno: ${new Date().toISOString()}`,
        '# Obsahuje reálná čísla obchodů – tests/output/ je v .gitignore.',
        ''
      ];
      fs.writeFileSync(file, header.concat(lines).join('\n') + '\n', 'utf8');
      return file;
    }
  };
  return api;
}

module.exports = { createReport };
