'use strict';
// Úložiště screenshotů mimo JSON deníku.
//
// Proč to existuje: base64 obrázky uložené přímo v deníku z něj udělaly
// 144 MB soubor (120 obchodů, 342 screenshotů – z toho 136 MB byly obrázky
// a 0,1 MB vlastní obchodní data). Ten soubor se při KAŽDÉM uložení obchodu
// celý posílal mezi rendererem a hlavním procesem, celý znovu serializoval
// a celý znovu vykresloval. Renderer na to dojel na paměť a Electron ho
// ukončil – uživatel viděl "Aplikace se neočekávaně ukončila", typicky právě
// při ukládání uzavřeného obchodu.
//
// Testy níž hlídají obě strany té opravy: že se obrázky z deníku opravdu
// dostanou pryč (a deník zůstane malý) a že se přitom žádný z nich neztratí
// ani nepoškodí – migrace přepisuje reálná, nenahraditelná data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { loadMain } = require('./helpers/extract');

// Pořadí je významné: `const` se vyhodnocují shora dolů, takže IMAGE_SCHEME
// musí být dřív než IMAGE_REF_PREFIX, který ho používá.
const NAMES = [
  'IMAGE_SCHEME', 'IMAGE_REF_PREFIX', 'IMAGE_NAME_RE', 'IMAGE_CONTENT_TYPES',
  'imagesRoot', 'isImageRef', 'imageRefName', 'imageRefPath', 'imageExtension',
  'dataUrlToBuffer', 'storeImageBuffer', 'storeImageDataUrl',
  'imageToBuffer', 'imageToDataUrl', 'mapImageStrings',
  'deflateJournalImages', 'inflateJournalImages'
];

// Každý test si dělá vlastní datovou složku, ať si navzájem nepřepisují
// úložiště a ať se nikdy nesáhne na skutečná data aplikace.
function imageStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-images-'));
  const api = loadMain(NAMES, { fs, path, crypto, Buffer, dataRoot: () => root, URL });
  return { root, ...api };
}

// Obrázek s hlavičkou PNG. Je záměrně o pár kB, ne o pár bajtech: odkaz do
// úložiště má kolem 80 znaků, takže na nesmyslně malé „fotce“ by se úspora
// místa nedala poznat.
function pngDataUrl(seed) {
  const body = Buffer.alloc(4096);
  body.write(String(seed));
  const buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body]);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function journalWithImages() {
  return {
    trades: [
      {
        id: 't1', instrument: 'MES', comment: 'vstup na M2',
        images: [pngDataUrl('one'), pngDataUrl('two')],
        legs: [{ label: 'TP1', images: [pngDataUrl('three')] }]
      },
      { id: 't2', instrument: 'NQ', images: [] }
    ],
    settings: [{ key: 'main', value: { startingBalance: 1000 } }],
    dayNotes: { '2026-09-25': { comment: 'den', images: [pngDataUrl('four')] } },
    schemaVersion: 3
  };
}

test('obrázky se z deníku přesunou do souborů a zůstanou po nich jen odkazy', () => {
  const store = imageStore();
  const journal = journalWithImages();
  const before = JSON.stringify(journal).length;

  const moved = store.deflateJournalImages(journal);

  assert.equal(moved, 4, 'převedou se obrázky obchodu, cíle i denní poznámky');
  const refs = [
    ...journal.trades[0].images,
    ...journal.trades[0].legs[0].images,
    ...journal.dayNotes['2026-09-25'].images
  ];
  assert.equal(refs.length, 4);
  for (const ref of refs) {
    assert.ok(store.isImageRef(ref), `"${ref}" není platný odkaz na obrázek`);
    assert.ok(fs.existsSync(store.imageRefPath(ref)), 'soubor s obrázkem musí na disku existovat');
  }
  assert.ok(JSON.stringify(journal).length < before, 'deník se musí zmenšit');
});

test('v datech deníku nezůstane ani jeden base64 obrázek', () => {
  const store = imageStore();
  const journal = journalWithImages();
  store.deflateJournalImages(journal);
  // Tohle je to, co uživatel poznal jako pád aplikace: jediné base64 pole,
  // které migrace přehlédne, se při každém uložení obchodu znovu posílá
  // a znovu vykresluje.
  assert.equal(JSON.stringify(journal).includes('data:image/'), false);
});

test('migrace proběhne jen jednou – podruhé už není co převádět', () => {
  const store = imageStore();
  const journal = journalWithImages();
  assert.equal(store.deflateJournalImages(journal), 4);
  assert.equal(store.deflateJournalImages(journal), 0);
});

test('obrázek se převodem tam a zpět nezmění', () => {
  const store = imageStore();
  const original = journalWithImages();
  const journal = journalWithImages();

  store.deflateJournalImages(journal);
  const restored = store.inflateJournalImages(journal);

  assert.equal(restored, 4);
  assert.deepEqual(journal, original, 'záloha musí obsahovat přesně původní obrázky');
});

test('stejný obrázek se na disk uloží jen jednou', () => {
  const store = imageStore();
  const journal = {
    trades: [
      { id: 'a', images: [pngDataUrl('same')] },
      { id: 'b', images: [pngDataUrl('same')] }
    ]
  };
  store.deflateJournalImages(journal);
  assert.equal(journal.trades[0].images[0], journal.trades[1].images[0]);
  assert.equal(fs.readdirSync(store.imagesRoot()).length, 1);
});

test('texty obchodu převod obrázků nepřepisuje', () => {
  const store = imageStore();
  const journal = {
    trades: [{
      id: 'a',
      comment: 'zmínka o data:image/png v komentáři',
      strategy: 'fjimg://store/necopodivneho',
      images: [pngDataUrl('x')]
    }]
  };
  store.deflateJournalImages(journal);
  assert.equal(journal.trades[0].comment, 'zmínka o data:image/png v komentáři');
  assert.equal(journal.trades[0].strategy, 'fjimg://store/necopodivneho');
  assert.ok(store.isImageRef(journal.trades[0].images[0]));
});

test('odkaz nemůže ukázat mimo složku s obrázky', () => {
  const store = imageStore();
  for (const bogus of [
    'fjimg://store/../../backup-settings.json',
    'fjimg://store/..%2F..%2Fbackup-settings.json',
    'fjimg://store/nejaky-soubor.png',
    'fjimg://jiny-host/aaaa.png',
    'file:///C:/Windows/win.ini'
  ]) {
    assert.equal(store.isImageRef(bogus), false, `"${bogus}" se nesmí brát jako odkaz`);
    assert.equal(store.imageRefPath(bogus), null);
  }
});

test('chybějící soubor obrázku se v deníku nesmaže', () => {
  const store = imageStore();
  const journal = journalWithImages();
  store.deflateJournalImages(journal);
  const ref = journal.trades[0].images[0];
  fs.rmSync(store.imageRefPath(ref));

  assert.equal(store.imageToBuffer(ref), null);
  store.inflateJournalImages(journal);
  // Odkaz zůstane, jak byl – kdyby se místo toho zapsalo null nebo prázdný
  // řetězec, jedna chybějící miniatura by při tvorbě zálohy tiše poškodila
  // celý deník.
  assert.equal(journal.trades[0].images[0], ref);
});

test('přípona souboru odpovídá formátu obrázku', () => {
  const store = imageStore();
  assert.equal(store.imageExtension('image/png'), 'png');
  assert.equal(store.imageExtension('image/jpeg'), 'jpg');
  assert.equal(store.imageExtension('image/webp'), 'webp');
  assert.equal(store.imageExtension('image/svg+xml'), 'svg');
  assert.equal(store.imageExtension(''), 'png');

  const ref = store.storeImageDataUrl('data:image/webp;base64,' + Buffer.from('webp-data').toString('base64'));
  assert.ok(ref.endsWith('.webp'));
  assert.equal(store.imageToDataUrl(ref).startsWith('data:image/webp;base64,'), true);
});

test('skutečný deník se po migraci vejde do stovek kB místo stovek MB', () => {
  const store = imageStore();
  // Rozměry odpovídají tomu, co měl uživatel na disku: 120 obchodů,
  // 342 screenshotů po ~400 kB.
  const journal = { trades: [] };
  for (let i = 0; i < 120; i++) {
    const images = [];
    for (let j = 0; j < 3 && i * 3 + j < 342; j++) {
      images.push(`data:image/png;base64,${Buffer.alloc(400 * 1024, i * 3 + j + 1).toString('base64')}`);
    }
    journal.trades.push({ id: `t${i}`, instrument: 'MES', date: '2026-09-25', images });
  }
  assert.ok(JSON.stringify(journal).length > 100 * 1024 * 1024, 'výchozí deník musí být opravdu velký');

  store.deflateJournalImages(journal);

  assert.ok(JSON.stringify(journal).length < 500 * 1024,
    'po migraci musí deník klesnout z >100 MB na stovky kB – právě jeho velikost renderer ukončovala');
});
