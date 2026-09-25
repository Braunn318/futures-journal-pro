'use strict';
// Zápis deníku: paměť se smí změnit teprve po úspěšném zápisu na disk.
//
// PROČ EXISTUJÍ: do 4.6.3 se data v paměti měnila PŘED zápisem
// (persistDB = "zapiš, co už jsem změnil"). Když zápis selhal – plný disk,
// zamčený soubor, cokoli – aplikace dál ukazovala změnu, která nikde nebyla,
// a uživatel se to dozvěděl jen z jedné hlášky. Ta změna pak při nejbližším
// úspěšném uložení čehokoli jiného buď tiše prošla, nebo naopak zmizela,
// podle toho, co se zapisovalo dřív. commitJournal to obrací: úprava se dělá
// na kopii a do paměti se propíše až po potvrzeném zápisu.
//
// Testy schválně sahají na tu nejnižší vrstvu (commitJournal, put, del,
// clearStore) – přes ni jde v rendereru každý zápis deníku.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { loadRenderer } = require('./helpers/extract');

// Pořadí je významné: `const` se vyhodnocují shora dolů.
const NAMES = [
  'SCHEMA_VERSION', 'ensureActiveJournalData', 'commitJournal', 'getAll',
  'put', 'del', 'clearStore', 'migrateTradePointsFields', 'runPointsMigration'
];

// Pole a objekty vzniklé uvnitř vm kontextu mají jiné prototypy, takže by na
// nich deepEqual selhal na prototypu; pro porovnání se převádějí přes JSON.
const plain = value => JSON.parse(JSON.stringify(value));

function journal(initial, { writeFails = false, onBackup } = {}) {
  const writes = [];
  const r = loadRenderer(NAMES, {
    db: { data: initial, close() {} },
    activeJournalId: 'j1',
    window: {
      desktopAPI: {
        writeJournal: async (id, data) => {
          writes.push(plain(data));
          return writeFails ? { ok: false, error: 'disk je plný' } : { ok: true };
        },
        backupJournal: async () => { if (onBackup) await onBackup(); return { ok: true }; }
      }
    }
  });
  return {
    ...r,
    writes,
    // commitJournal nahradí `db` novým objektem, takže se aktuální stav musí
    // číst z kontextu.
    data: () => vm.runInContext('db.data', r.__context)
  };
}

function withOneTrade() {
  return {
    trades: [{ id: 't1', instrument: 'MES', date: '2026-09-25', pnlRaw: 13.1 }],
    settings: [{ key: 'main', value: { startingBalance: 1000 } }],
    dayNotes: {}
  };
}

test('úspěšný zápis se propíše do paměti i na disk', async () => {
  const j = journal(withOneTrade());

  await j.put('trades', { id: 't2', instrument: 'NQ' });

  assert.equal(j.data().trades.length, 2);
  assert.equal(j.writes.length, 1);
  assert.deepEqual(plain(j.writes[0].trades).map(t => t.id), ['t1', 't2'],
    'na disk jde nový stav, ne ten před úpravou');
});

test('neúspěšný zápis nezmění nic v paměti', async () => {
  const j = journal(withOneTrade(), { writeFails: true });
  const before = plain(j.data());

  await assert.rejects(() => j.put('trades', { id: 't2', instrument: 'NQ' }), /disk je plný/);

  // Tohle je celý smysl téhle vrstvy: po neúspěšném uložení musí aplikace
  // ukazovat přesně to, co v deníku na disku opravdu je.
  assert.deepEqual(plain(j.data()), before);
});

test('neúspěšné smazání obchod nezahodí', async () => {
  const j = journal(withOneTrade(), { writeFails: true });

  await assert.rejects(() => j.del('trades', 't1'), /disk je plný/);

  assert.deepEqual(plain(j.data().trades).map(t => t.id), ['t1']);
});

test('neúspěšné vyprázdnění deník nevyprázdní', async () => {
  const j = journal(withOneTrade(), { writeFails: true });

  await assert.rejects(() => j.clearStore('trades'), /disk je plný/);

  assert.equal(j.data().trades.length, 1);
});

test('commitJournal dostane ke zpracování kopii, ne živá data', async () => {
  const j = journal(withOneTrade());
  const before = j.data();

  await j.commitJournal(journalData => { journalData.trades[0].instrument = 'NQ'; });

  assert.equal(before.trades[0].instrument, 'MES', 'původní data se neupravují na místě');
  assert.equal(j.data().trades[0].instrument, 'NQ', 'po uložení platí nový stav');
});

test('když úprava vyhodí výjimku, nezapisuje se a nic se nemění', async () => {
  const j = journal(withOneTrade());
  const before = plain(j.data());

  await assert.rejects(() => j.commitJournal(() => { throw new Error('chyba v úpravě') }), /chyba v úpravě/);

  assert.equal(j.writes.length, 0);
  assert.deepEqual(plain(j.data()), before);
});

test('commitJournal vrací hodnotu z úpravy až po potvrzeném zápisu', async () => {
  const j = journal(withOneTrade());

  const added = await j.commitJournal(journalData => {
    journalData.trades.push({ id: 't2' });
    return journalData.trades.length;
  });

  assert.equal(added, 2);
});

test('označení starých bodů nespadne na obchod, který přibyl během zálohy', async () => {
  // Mezi průchodem obchody a zápisem se čeká na zálohu deníku a do té mezery
  // se vejde automatický import z konektoru. Dokud se úpravy přiřazovaly podle
  // pořadí v poli, dostal nově zařazený obchod cizí úpravu – tady by se úplně
  // nový obchod označil jako "stará bodová konvence" a vypadl by ze statistik
  // postavených na R.
  let ctx = null;
  const j = journal(
    { trades: [{ id: 'a' }, { id: 'b' }], settings: [], dayNotes: {}, schemaVersion: 0 },
    { onBackup: () => vm.runInContext("db.data.trades.unshift({id:'c',pointsTotal:5})", ctx) }
  );
  ctx = j.__context;

  const result = await j.runPointsMigration();

  assert.equal(result.changed, 2);
  const byId = Object.fromEntries(plain(j.data().trades).map(t => [t.id, t]));
  assert.equal(byId.a.legacyPointsConvention, true);
  assert.equal(byId.b.legacyPointsConvention, true);
  assert.equal(byId.c.legacyPointsConvention, undefined, 'nově naimportovaný obchod se označit nesmí');
  assert.equal(j.data().schemaVersion, 1);
});

test('getAll vrací kopii, takže úpravy mimo uložení nikam neprosáknou', async () => {
  const j = journal(withOneTrade());

  const rows = await j.getAll('trades');
  rows[0].instrument = 'ZMĚNĚNO';
  rows.push({ id: 'duch' });

  assert.equal(j.data().trades.length, 1);
  assert.equal(j.data().trades[0].instrument, 'MES');
});
