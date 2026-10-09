'use strict';
// Přepínače „včetně obchodů, které bych naživo nevzal" / „včetně vědomě
// vynechaných" podle režimu deníku (doplněk ke kroku 2 z docs/ZADANI_KONTEXT.md).
//
// „Naživo bych nevzal" patří jen do backtestu, „vědomě vynechán" jen do živého
// deníku. V deníku, kam skupina nepatří, se přepínač neukazuje – ALE když tam
// takové záznamy přesto jsou (starší data, Kontrola dat), přepínač zůstane
// vidět i s počtem neplatných, aby je šlo započítat. Chování čísel se nemění:
// přepínač dál jen říká, jestli se skupina počítá do výkonu.

const test = require('node:test');
const assert = require('node:assert/strict');

const FJContext = require('../app/context.js');
const { loadRenderer } = require('./helpers/extract');

const LIVE = 'LIVE', BT = 'BACKTEST';
const skipLive = n => Array.from({ length: n }, (_, i) => ({ id: 'sl' + i, wouldSkipLive: true, fillStatus: 'FILLED' }));
const skipped = n => Array.from({ length: n }, (_, i) => ({ id: 'sk' + i, fillStatus: 'SKIPPED' }));
const plain = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, fillStatus: 'FILLED' }));

test('živý deník bez „naživo bych nevzal" – přepínač skipLive se neukazuje', () => {
  assert.deepEqual(FJContext.includeToggleState('skipLive', [{ mode: LIVE, records: plain(5) }]), { show: false, invalidCount: 0 });
});

test('živý deník se 3 záznamy „naživo bych nevzal" – přepínač zůstane, s počtem neplatných', () => {
  assert.deepEqual(FJContext.includeToggleState('skipLive', [{ mode: LIVE, records: [...plain(4), ...skipLive(3)] }]), { show: true, invalidCount: 3 });
});

test('backtest – skipLive vidět vždy (i bez záznamů), vědomě vynechané ne', () => {
  assert.deepEqual(FJContext.includeToggleState('skipLive', [{ mode: BT, records: [] }]), { show: true, invalidCount: 0 });
  assert.deepEqual(FJContext.includeToggleState('skipped', [{ mode: BT, records: plain(3) }]), { show: false, invalidCount: 0 });
  assert.deepEqual(FJContext.includeToggleState('skipped', [{ mode: BT, records: [...plain(3), ...skipped(2)] }]), { show: true, invalidCount: 2 });
});

test('živý deník – vědomě vynechané vidět vždy', () => {
  assert.deepEqual(FJContext.includeToggleState('skipped', [{ mode: LIVE, records: [] }]), { show: true, invalidCount: 0 });
});

test('pohled přes víc deníků – rozhoduje množina; neplatné se sčítají jen z deníků, kam skupina nepatří', () => {
  const journals = [{ mode: LIVE, records: skipLive(3) }, { mode: BT, records: [...skipLive(5), ...skipped(1)] }];
  assert.deepEqual(FJContext.includeToggleState('skipLive', journals), { show: true, invalidCount: 3 });
  assert.deepEqual(FJContext.includeToggleState('skipped', journals), { show: true, invalidCount: 1 });
});

test('no fill se podle režimu neřídí – vidět vždy', () => {
  assert.deepEqual(FJContext.includeToggleState('noFill', [{ mode: LIVE, records: [] }]), { show: true, invalidCount: 0 });
  assert.deepEqual(FJContext.includeToggleState('noFill', [{ mode: BT, records: [] }]), { show: true, invalidCount: 0 });
});

test('popisek neplatného výskytu jmenuje režim a počet', () => {
  assert.equal(FJContext.includeInvalidNote('skipLive', 3), '3× neplatné v živém deníku');
  assert.equal(FJContext.includeInvalidNote('skipped', 1), '1× neplatné v backtest deníku');
  assert.equal(FJContext.includeInvalidNote('skipLive', 0), '');
});

test('výkonová čísla se nemění: performanceRecords filtruje stejně bez ohledu na viditelnost přepínače', () => {
  const r = loadRenderer(['tradeRecords', 'isSetupRecord', 'isSkipLive', 'hypotheticalGroup', 'performanceRecords'], { currentInclude: () => ({ skipLive: false, noFill: false, skipped: false }) });
  const rows = [...plain(4), ...skipLive(3), ...skipped(2)];
  assert.equal(r.performanceRecords(rows).length, 4, 've výchozím stavu jsou obě skupiny mimo výkon');
  assert.equal(r.performanceRecords(rows, { skipLive: true, noFill: false, skipped: false }).length, 7, 'zapnutý přepínač je započítá');
});
