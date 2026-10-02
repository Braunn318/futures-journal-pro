'use strict';
// Skrývání a mazání deníků (4.7.2).
//
// Hlídá tři věci, na kterých to stojí:
// 1. Skrytý deník nikdy nezůstane aktivní – aplikace by v něm pracovala, a
//    přitom by ho uživatel neviděl ve výběru. Náhradou je naposledy použitý
//    viditelný deník, jinak první viditelný.
// 2. Přehled účtu ukáže při startu jen poslední aktivní deník (výchozí), nebo
//    všechny – podle Nastavení → Deníky.
// 3. Smazání deníku odstraní jeho soubor, AI export i screenshoty, ale nikdy
//    ne screenshot, který používá jiný deník (úložiště je společné).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FJJournals = require('../app/journals.js');
const { loadMain, loadRenderer } = require('./helpers/extract');

const A = { id: 'a', name: 'Live' };
const B = { id: 'b', name: 'Backtest' };
const C = { id: 'c', name: 'Demo' };
const hidden = p => ({ ...p, hidden: true });

// ---------- FJJournals ----------

test('viditelné jsou jen deníky bez příznaku hidden:true', () => {
  const list = FJJournals.visibleJournals([A, hidden(B), C, { id: 'd', name: 'x', hidden: false }]);
  assert.deepEqual(list.map(p => p.id), ['a', 'c', 'd']);
  assert.deepEqual(FJJournals.visibleJournals(null), []);
});

test('viditelný aktivní deník zůstává aktivní', () => {
  assert.equal(FJJournals.resolveActiveJournal([A, B, C], 'b', 'a'), 'b');
});

test('skrytý aktivní deník se nahradí naposledy použitým viditelným', () => {
  assert.equal(FJJournals.resolveActiveJournal([A, hidden(B), C], 'b', 'c'), 'c');
});

test('bez použitelného předchozího deníku se vezme první viditelný', () => {
  assert.equal(FJJournals.resolveActiveJournal([hidden(A), hidden(B), C], 'b', 'a'), 'c', 'předchozí je skrytý');
  assert.equal(FJJournals.resolveActiveJournal([A, hidden(B)], 'b', 'smazany'), 'a', 'předchozí neexistuje');
  assert.equal(FJJournals.resolveActiveJournal([A, B], 'smazany', null), 'a', 'aktivní neexistuje');
});

test('bez viditelného deníku je aktivní prázdný', () => {
  assert.equal(FJJournals.resolveActiveJournal([hidden(A)], 'a', 'a'), '');
  assert.equal(FJJournals.resolveActiveJournal([], 'a', 'a'), '');
});

test('poslední viditelný deník skrýt nejde', () => {
  assert.equal(FJJournals.canHide([A, B], 'a'), true);
  assert.equal(FJJournals.canHide([A, hidden(B)], 'a'), false);
  assert.equal(FJJournals.canHide([A], 'a'), false);
  assert.equal(FJJournals.canHide([A, hidden(B)], 'b'), false, 'už skrytý se znovu neskrývá');
});

test('Přehled účtu při startu: výchozí je poslední aktivní deník', () => {
  assert.equal(FJJournals.overviewStartJournal('active', 'b', [A, B]), 'b');
  assert.equal(FJJournals.overviewStartJournal(undefined, 'b', [A, B]), 'b', 'neznámý režim = aktivní');
  assert.equal(FJJournals.overviewStartJournal('all', 'b', [A, B]), '');
});

test('Přehled účtu při startu: skrytý nebo neexistující aktivní deník → všechny viditelné', () => {
  assert.equal(FJJournals.overviewStartJournal('active', 'b', [A, hidden(B)]), '');
  assert.equal(FJJournals.overviewStartJournal('active', 'x', [A, B]), '');
});

// ---------- výběr v Přiřazení účtů ----------

function makeDom(ids) {
  const nodes = {};
  for (const id of ids) nodes[id] = { id, innerHTML: '', value: '' };
  return { nodes, document: { getElementById: id => nodes[id] || null, querySelectorAll: () => [] } };
}

test('přiřazení účtů nenabízí skrytý deník, kromě toho, ke kterému je účet už přiřazený', () => {
  const dom = makeDom(['captureMappingRows', 'captureHiddenAccountsBox']);
  const r = loadRenderer(['$', 'esc', 'renderCaptureMappings'], {
    document: dom.document,
    journalProfiles: [A, hidden(B), hidden(C)],
    captureSnapshot: null
  });
  r.renderCaptureMappings(['Sim101', 'Playback'], { Playback: 'b' }, []);
  const html = dom.nodes.captureMappingRows.innerHTML;
  const [sim, playback] = html.split('<div class="mapping-row">').slice(1);

  assert.ok(sim.includes('value="a"'), 'viditelný deník se nabízí');
  assert.ok(!sim.includes('value="b"') && !sim.includes('value="c"'), 'skryté deníky se nenabízejí');
  assert.match(playback, /value="b" selected>Backtest \(skrytý\)/, 'přiřazený skrytý deník zůstane vybraný a označený');
  assert.ok(!playback.includes('value="c"'));
  assert.match(html, /import obchodů z něj nezastaví/, 'tlačítko Skrýt vysvětluje, co dělá');
});

// ---------- úplné smazání deníku (main.js) ----------

const MAIN_NAMES = [
  'IMAGE_SCHEME', 'IMAGE_REF_PREFIX', 'IMAGE_NAME_RE',
  'imagesRoot', 'isImageRef', 'imageRefName', 'mapImageStrings',
  'safeJournalId', 'journalPath', 'aiExportPath',
  'journalImageNames', 'deleteJournalCompletely'
];

function storage() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-delete-'));
  const root = path.join(base, 'journal-data');
  const ai = path.join(base, 'ai-export');
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.mkdirSync(ai, { recursive: true });
  const errors = [];
  const api = loadMain(MAIN_NAMES, {
    fs, path, URL,
    dataRoot: () => root,
    aiExportRoot: () => ai,
    logError: (where, error) => errors.push(where + ': ' + error.message)
  });
  const image = seed => {
    const name = crypto.createHash('sha256').update(String(seed)).digest('hex') + '.png';
    fs.writeFileSync(path.join(root, 'images', name), 'png ' + seed);
    return { name, ref: api.IMAGE_REF_PREFIX + name };
  };
  const writeJournal = (id, data) => fs.writeFileSync(path.join(root, id + '.json'), JSON.stringify(data));
  const imageExists = img => fs.existsSync(path.join(root, 'images', img.name));
  return { root, ai, errors, api, image, writeJournal, imageExists };
}

test('smazání odstraní deník, jeho AI export a jen jeho vlastní screenshoty', () => {
  const s = storage();
  const own = s.image('own'), shared = s.image('shared'), note = s.image('note'), other = s.image('other');
  s.writeJournal('a', {
    trades: [{ id: 't1', images: [own.ref, shared.ref], legs: [{ images: [] }] }],
    dayNotes: { '2026-10-01': { images: [note.ref] } }
  });
  s.writeJournal('b', { trades: [{ id: 't2', images: [shared.ref, other.ref] }] });
  fs.writeFileSync(path.join(s.ai, 'a.json'), '{}');
  fs.writeFileSync(path.join(s.ai, 'b.json'), '{}');

  const result = s.api.deleteJournalCompletely('a');

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(s.root, 'a.json')), false, 'soubor deníku je pryč');
  assert.equal(fs.existsSync(path.join(s.ai, 'a.json')), false, 'AI export deníku je pryč');
  assert.equal(fs.existsSync(path.join(s.ai, 'b.json')), true, 'AI export jiného deníku zůstal');
  assert.equal(s.imageExists(own), false, 'vlastní screenshot obchodu smazán');
  assert.equal(s.imageExists(note), false, 'screenshot denní poznámky smazán');
  assert.equal(s.imageExists(shared), true, 'sdílený screenshot zůstal');
  assert.equal(s.imageExists(other), true, 'screenshot jiného deníku zůstal');
  assert.equal(fs.existsSync(path.join(s.root, 'b.json')), true);
  assert.equal(result.removedImages, 2);
  assert.equal(result.keptImages, 1);
});

test('když jiný deník nejde přečíst, nesmaže se žádný screenshot', () => {
  const s = storage();
  const own = s.image('own');
  s.writeJournal('a', { trades: [{ id: 't1', images: [own.ref] }] });
  fs.writeFileSync(path.join(s.root, 'b.json'), '{ rozbitý json');

  const result = s.api.deleteJournalCompletely('a');

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(s.root, 'a.json')), false, 'deník se smazal');
  assert.equal(s.imageExists(own), true, 'obrázek zůstal, protože nevíme, co používá b');
  assert.equal(result.removedImages, 0);
  assert.equal(s.errors.length, 1);
});

test('smazání neexistujícího deníku nic nerozbije', () => {
  const s = storage();
  const other = s.image('other');
  s.writeJournal('b', { trades: [{ id: 't2', images: [other.ref] }] });

  const result = s.api.deleteJournalCompletely('neni');

  assert.equal(result.ok, true);
  assert.equal(result.removedImages, 0);
  assert.equal(s.imageExists(other), true);
});
