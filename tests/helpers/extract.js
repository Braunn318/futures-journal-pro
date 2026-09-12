'use strict';
// Extrakce SKUTEČNÝCH funkcí z produkčního kódu.
//
// Testovaná logika žije v inline <script> bloku uvnitř app/index.html a v main.js,
// není to modul a načíst ji celou nejde – top-level kód sahá na DOM a localStorage.
// Tenhle harness proto vyřízne ze zdrojáku konkrétní deklaraci a vyhodnotí ji
// v izolovaném kontextu (node:vm). Testuje se tak produkční kód, ne jeho kopie.
//
// Stejným způsobem byly headlessně verifikované opravy ve v4.5.1
// (capture-tests.js / map-tests.js, 32 kontrol) – tam to byly scratch soubory
// mimo repozitář, takže se ta práce ztratila. Tohle je totéž, jen commitnuté.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const FJPoints = require('../../app/points.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// Inline <script> bloky (bez atributu src), spojené v pořadí dokumentu.
function inlineScripts(html) {
  const blocks = [];
  const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks.join('\n');
}

function endOfString(src, start, quote) {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === quote) return i;
  }
  throw new Error('extract: neuzavřený řetězec');
}

function endOfRegex(src, start) {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '[') inClass = true;
    else if (src[i] === ']') inClass = false;
    else if (src[i] === '/' && !inClass) return i;
    else if (src[i] === '\n') break;
  }
  throw new Error('extract: neuzavřený regex literál');
}

// Lomítko je začátek regexu jen tam, kde se čeká hodnota. Po identifikátoru,
// čísle nebo `)` jde o dělení – bez téhle kontroly by se `pointsTotal / contracts`
// spolklo jako regex.
const REGEX_ALLOWED_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
function regexAllowed(prevSignificant) {
  return REGEX_ALLOWED_AFTER.has(prevSignificant);
}

function endOfTemplate(src, start) {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '$' && src[i + 1] === '{') { i = matchBracket(src, i + 1); continue; }
    if (src[i] === '`') return i;
  }
  throw new Error('extract: neuzavřený template literál');
}

// Vrátí index závorky uzavírající tu na pozici `open`. Přeskakuje komentáře,
// řetězce, template literály (včetně vnořených ${}) a regex literály, aby
// závorka uvnitř textu neukončila blok předčasně.
function matchBracket(src, open) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const openChar = src[open];
  const closeChar = pairs[openChar];
  if (!closeChar) throw new Error('extract: na pozici ' + open + ' není otevírací závorka');
  let depth = 0;
  let prev = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && next === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; continue; }
    if (c === '"' || c === "'") { i = endOfString(src, i, c); prev = 'x'; continue; }
    if (c === '`') { i = endOfTemplate(src, i); prev = 'x'; continue; }
    if (c === '/' && regexAllowed(prev)) { i = endOfRegex(src, i); prev = 'x'; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) { depth--; if (depth === 0) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error('extract: nenalezena uzavírací závorka k pozici ' + open);
}

// Vyřízne zdrojový text jedné deklarace: `function NAME(...) {...}`
// nebo `const|let|var NAME = ...`.
function extractDeclaration(src, name) {
  const fnRe = new RegExp('(^|[\\n;])[ \\t]*(?:async[ \\t]+)?function[ \\t]+' + name + '[ \\t]*\\(');
  let m = fnRe.exec(src);
  if (m) {
    const start = m.index + m[1].length;
    const paren = m.index + m[0].length - 1;
    const brace = src.indexOf('{', matchBracket(src, paren));
    if (brace < 0) throw new Error('extract: tělo funkce "' + name + '" nenalezeno');
    return src.slice(start, matchBracket(src, brace) + 1);
  }
  const varRe = new RegExp('(^|[\\n;])[ \\t]*(?:const|let|var)[ \\t]+' + name + '[ \\t]*=');
  m = varRe.exec(src);
  if (m) {
    const start = m.index + m[1].length;
    let i = m.index + m[0].length;
    while (/\s/.test(src[i])) i++;
    if (src[i] === '{' || src[i] === '[' || src[i] === '(') {
      return src.slice(start, matchBracket(src, i) + 1) + ';';
    }
    const nl = src.indexOf('\n', i);
    return src.slice(start, nl < 0 ? src.length : nl);
  }
  throw new Error('extract: deklarace "' + name + '" nenalezena');
}

// Vyhodnotí vyříznuté deklarace v izolovaném kontextu a vrátí je pojmenované.
// `globals` doplní to, co funkce potřebují zvenčí (typicky `settings`).
function loadFromSource(source, names, globals = {}) {
  const code = names.map(n => extractDeclaration(source, n)).join('\n\n');
  const context = vm.createContext({
    console,
    crypto: { randomUUID: () => nodeCrypto.randomUUID() },
    structuredClone,
    // Produkční kód sahá na globální FJPoints (app/points.js, načtený přes
    // <script src>), takže ho kontext musí mít taky.
    FJPoints,
    ...globals
  });
  vm.runInContext(code, context, { filename: 'extracted-from-source.js' });
  const out = {};
  for (const n of names) {
    const value = vm.runInContext(n, context);
    if (value === undefined) throw new Error('extract: "' + n + '" se po vyhodnocení nenaplnilo');
    out[n] = value;
  }
  out.__context = context;
  return out;
}

// Načte funkce z rendereru (inline script v app/index.html).
function loadRenderer(names, globals = {}) {
  return loadFromSource(inlineScripts(readRepoFile(path.join('app', 'index.html'))), names, globals);
}

// Načte funkce z main procesu (main.js).
function loadMain(names, globals = {}) {
  return loadFromSource(readRepoFile('main.js'), names, globals);
}

module.exports = { REPO_ROOT, readRepoFile, inlineScripts, extractDeclaration, loadFromSource, loadRenderer, loadMain };
