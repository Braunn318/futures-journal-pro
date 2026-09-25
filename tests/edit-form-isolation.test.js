'use strict';
// Formulář obchodu a denní poznámka nesmí sahat do uložených dat dřív, než
// uživatel uloží.
//
// PROČ EXISTUJÍ: openModal() přiřazoval do pracovního seznamu obrázků TOTÉŽ
// pole, jaké drží uložený obchod (`editImages=t.images||[]`). Odebrání
// screenshotu ve formuláři volá splice, takže obrázek zmizel z uloženého
// obchodu okamžitě – i když uživatel okno zavřel bez uložení. Viditelné to
// bylo až při nejbližším zápisu deníku, kdy se ztráta stala trvalou.
// Ukládání obchodu přitom kopii dělá správně (`images:[...editImages]`);
// chyběl jen její protějšek na vstupu.
//
// getDayNote() měl tentýž problém o patro níž: rozbalení `{...n}` je mělké,
// takže `images` ukazovalo do uložené poznámky.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadRenderer, inlineScripts, readRepoFile } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');

// Nejmenší DOM, na kterém openModal projde: každý dotaz na prvek vrátí uzel,
// který si pamatuje zapsané hodnoty, a nic nemá potomky.
function stubDocument() {
  const nodes = new Map();
  const makeNode = id => ({
    id, value: '', textContent: '', innerHTML: '', style: {},
    reset() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    classList: { add() {}, remove() {}, contains: () => false }
  });
  return {
    nodes,
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, makeNode(id));
        return nodes.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => []
    }
  };
}

// openModal vyplňuje celý formulář; tady jde jen o obrázky, takže všechno
// ostatní vykreslování je zastoupené prázdnými funkcemi.
function tradeForm() {
  const dom = stubDocument();
  const r = loadRenderer(['$', 'openModal'], {
    document: dom.document,
    window: {},
    FJTaxonomy,
    Date,
    editImages: [],
    tradeFormBaseline: '',
    resetLegRows() {},
    renderSlPriceHint() {},
    fillContextSelect() {},
    renderSingleChipGrid() {},
    renderChipGrid() {},
    updateConfluenceHint() {},
    appendBlankLegRow() { return dom.document.getElementById('legRow'); },
    showPreviews() {},
    updateResultBadge() {},
    updateLegBadge() {},
    tradeFormSnapshot: () => ''
  });

  // `window.removeImg=…` je přiřazení do window, ne deklarace – harness ho
  // neumí vyříznout podle jména, tak se vyhodnotí v tomtéž kontextu, aby test
  // pracoval se skutečnou obsluhou tlačítka "✕", ne s její napodobeninou.
  const source = inlineScripts(readRepoFile('app/index.html'));
  const line = /^window\.removeImg=.*$/m.exec(source);
  assert.ok(line, 'window.removeImg se ve zdrojovém kódu nenašel');
  vm.runInContext(line[0], r.__context);

  return {
    openModal: r.openModal,
    removeImg: (...args) => vm.runInContext('window.removeImg', r.__context)(...args),
    // Pole vzniklá uvnitř vm kontextu mají jiný Array.prototype, takže by na
    // nich deepEqual selhal na prototypu. Pro porovnání obsahu se proto kopírují
    // sem, pro porovnání identity je vedle toho i syrový přístup.
    editImages: () => [...vm.runInContext('editImages', r.__context)],
    editImagesRef: () => vm.runInContext('editImages', r.__context)
  };
}

function storedTrade() {
  return {
    id: 't1', instrument: 'MES', date: '2026-09-25',
    entryTime: '16:00', entryPrice: 7700, exitTime: '16:05', exitPrice: 7703,
    points: 3, contracts: 1, commission: 1.9, pnl: 13.1, pnlRaw: 13.1, result: 'target',
    images: ['fjimg://store/aaa.webp', 'fjimg://store/bbb.webp', 'fjimg://store/ccc.webp']
  };
}

test('otevření obchodu k úpravě nepředá formuláři uložený seznam obrázků', () => {
  const form = tradeForm();
  const trade = storedTrade();

  form.openModal(trade);

  assert.deepEqual(form.editImages(), trade.images, 'formulář ukáže tytéž obrázky');
  assert.notEqual(form.editImagesRef(), trade.images, 'ale nesmí to být totéž pole');
});

test('odebrání screenshotu ve formuláři se bez uložení uloženého obchodu nedotkne', () => {
  const form = tradeForm();
  const trade = storedTrade();

  form.openModal(trade);
  form.removeImg(1);

  // Přesně ten scénář, který mazal data: uživatel odebere obrázek a okno
  // zavře bez uložení.
  assert.deepEqual(form.editImages(), ['fjimg://store/aaa.webp', 'fjimg://store/ccc.webp']);
  assert.deepEqual(trade.images, [
    'fjimg://store/aaa.webp', 'fjimg://store/bbb.webp', 'fjimg://store/ccc.webp'
  ], 'uložený obchod musí mít pořád všechny tři obrázky');
});

test('obchod bez obrázků otevře prázdný formulář a nespadne', () => {
  const form = tradeForm();
  const trade = storedTrade();
  delete trade.images;

  form.openModal(trade);

  assert.deepEqual(form.editImages(), []);
});

// ---------- Denní poznámky ----------

function dayNotes(stored) {
  const r = loadRenderer(
    ['emptyDayNote', 'getDayNote', 'ensureActiveJournalData', 'commitJournal', 'saveDayNote'],
    {
      db: { data: { trades: [], settings: [], dayNotes: stored }, close() {} },
      activeJournalId: 'j1',
      window: { desktopAPI: { writeJournal: async () => ({ ok: true }) } }
    });
  return {
    getDayNote: r.getDayNote,
    saveDayNote: r.saveDayNote,
    // Uložením se `db` nahradí novým objektem (viz commitJournal), takže se
    // uložený stav musí číst z kontextu, ne z reference, se kterou test začínal.
    stored: () => vm.runInContext('db.data.dayNotes', r.__context)
  };
}

test('getDayNote vrací vlastní seznam obrázků, ne ten uložený', () => {
  const stored = { '2026-09-25': { comment: 'den', preview: '', notes: '', images: ['a', 'b', 'c'] } };
  const api = dayNotes(stored);

  const note = api.getDayNote('2026-09-25');
  note.images.splice(1, 1);

  assert.deepEqual(stored['2026-09-25'].images, ['a', 'b', 'c'],
    'uložená poznámka se smí změnit jen uložením, ne čtením');
});

test('odebrání obrázku ze dne se projeví teprve po uložení', async () => {
  const stored = { '2026-09-25': { comment: 'den', preview: '', notes: '', images: ['a', 'b', 'c'] } };
  const api = dayNotes(stored);

  const note = api.getDayNote('2026-09-25');
  note.images.splice(1, 1);
  await api.saveDayNote('2026-09-25', { images: note.images });

  assert.deepEqual([...api.stored()['2026-09-25'].images], ['a', 'c']);
  assert.equal(api.stored()['2026-09-25'].comment, 'den', 'ostatní pole zůstanou');
});

test('poznámka bez textu i obrázků se uložením smaže', async () => {
  const stored = { '2026-09-25': { comment: '', preview: '', notes: '', images: ['a'] } };
  const api = dayNotes(stored);

  const note = api.getDayNote('2026-09-25');
  note.images.splice(0, 1);
  await api.saveDayNote('2026-09-25', { images: note.images });

  assert.equal('2026-09-25' in api.stored(), false);
});
