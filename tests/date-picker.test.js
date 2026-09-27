'use strict';
// Výběr dne z kalendáře u polí s datem.
//
// Pole jsou nativní <input type="date"> – datum jde napsat ručně i vybrat
// z kalendáře ikonou v poli. Bez `color-scheme` ale Chromium kreslí ikonu
// tmavě i na tmavém motivu, takže nebyla vidět a uživatel hlásil, že výběr
// z kalendáře zmizel (Přehled účtu → Podíl instrumentů, 2026-09-27).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { readRepoFile } = require('./helpers/extract');

const html = readRepoFile(path.join('app', 'index.html'));
const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

test('barevné schéma: tmavé výchozí, světlé u světlého motivu', () => {
  assert.match(style, /:root\{color-scheme:dark\}/);
  assert.match(style, /html\[data-theme="light"\]\{color-scheme:light\}/);
});

test('ikona kalendáře je klikací', () => {
  assert.match(style, /input\[type="date"\]::-webkit-calendar-picker-indicator\{[^}]*cursor:pointer/);
});

test('pole s datem zůstávají nativní (ruční zápis i kalendář)', () => {
  for (const id of ['accountDay', 'accountFrom', 'accountTo', 'instrumentPortfolioFrom', 'instrumentPortfolioTo',
    'filterDate', 'newDayDate', 'reportFrom', 'reportTo', 'sfDate', 'date']) {
    const tag = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
    assert.ok(tag, id);
    assert.match(tag[0], /type="date"/, id);
  }
});
