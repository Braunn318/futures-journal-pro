'use strict';
// Minimální CSV parser pro exporty aplikace: oddělovač `;`, hodnoty v `"`,
// zdvojené `""` jako escape, BOM na začátku. Řádek smí obsahovat konce řádků
// uvnitř hodnoty – komentáře a poznámky ke dni je běžně obsahují, takže
// naivní split podle `\n` by rozsekal data.

function parseCsv(text, delimiter = ';') {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// Vrátí řádky jako objekty podle hlavičky.
function parseCsvRecords(text, delimiter = ';') {
  const rows = parseCsv(text, delimiter);
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0];
  const records = rows.slice(1).map(cols => {
    const rec = {};
    header.forEach((name, idx) => { rec[name] = cols[idx] ?? ''; });
    return rec;
  });
  return { header, records };
}

module.exports = { parseCsv, parseCsvRecords };
