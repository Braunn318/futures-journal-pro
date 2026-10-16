'use strict';
// Kalendář makro zpráv (4.8.7): tlačítko na ForexFactory a štítky dnů.
//
// Hlídá se:
//  - do shellu jde jen http/https adresa (nic jiného se z rendereru neotevře),
//  - data ze zdroje jsou cizí: platná událost má čas, název a měnu, texty se
//    zkracují a nic dalšího se nepřebírá,
//  - zdroj dává jen aktuální týden – mezipaměť drží staré týdny a nový týden
//    v ní nahradí jen dny, které pokrývá (přesunutá / zrušená událost zmizí),
//  - štítek dne: filtr měn a dopadu, svátek vždy, den podle místního času.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadMain, loadRenderer } = require('./helpers/extract');

const plain = v => JSON.parse(JSON.stringify(v));
const main = () => loadMain(['externalUrl', 'NEWS_TEXT_MAX', 'newsText', 'normalizeNewsEvents', 'mergeNewsEvents'], { URL });

test('odkaz do prohlížeče: jen http a https', () => {
  const { externalUrl } = main();
  assert.equal(externalUrl('https://www.forexfactory.com/calendar'), 'https://www.forexfactory.com/calendar');
  assert.equal(externalUrl('  http://example.com/x  '), 'http://example.com/x');
  for (const bad of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'fjimg://store/a.png', 'www.forexfactory.com', '', null]) {
    assert.equal(externalUrl(bad), null, String(bad));
  }
});

test('zdroj: platné události projdou, cizí a neúplné se zahodí, texty se zkrátí', () => {
  const { normalizeNewsEvents } = main();
  const out = plain(normalizeNewsEvents([
    { title: 'CPI m/m', country: 'usd', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.4%', extra: '<b>x</b>' },
    { title: '', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High' },
    { title: 'Bez času', country: 'USD', date: 'zítra', impact: 'High' },
    { title: 'x'.repeat(500), country: 'EUR', date: '2026-10-15T10:00:00+02:00', impact: 'Medium' },
    null, 'text'
  ]));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { title: 'CPI m/m', country: 'USD', date: '2026-10-14T12:30:00.000Z', impact: 'High', forecast: '0.3%', previous: '0.4%' });
  assert.equal(out[1].title.length, 160);
  assert.equal(normalizeNewsEvents({ events: [] }), null, 'jiný tvar než pole = chyba zdroje, ne prázdný týden');
});

test('mezipaměť: nový týden nahradí jen své dny, starší týdny zůstanou', () => {
  const { mergeNewsEvents } = main();
  const ev = (date, title) => ({ title, country: 'USD', date, impact: 'High', forecast: '', previous: '' });
  const cached = [ev('2026-10-07T12:30:00.000Z', 'CPI minulý týden'), ev('2026-10-14T12:30:00.000Z', 'Přesunutá zpráva'), ev('2026-10-16T14:00:00.000Z', 'Zrušená zpráva')];
  const fresh = [ev('2026-10-13T12:30:00.000Z', 'PPI'), ev('2026-10-16T18:00:00.000Z', 'FOMC')];
  assert.deepEqual(plain(mergeNewsEvents(cached, fresh)).map(e => e.title), ['CPI minulý týden', 'PPI', 'FOMC']);
  assert.deepEqual(plain(mergeNewsEvents(cached, [])).map(e => e.title), cached.map(e => e.title), 'prázdný týden mezipaměť nemaže');
  assert.deepEqual(plain(mergeNewsEvents(undefined, fresh)).map(e => e.title), ['PPI', 'FOMC']);
});

test('štítky dne: měny a dopad z nastavení, svátek vždy, den a čas v místním čase', () => {
  const r = loadRenderer(['NEWS_IMPACT_RANK', 'newsCurrencyList', 'localDateStr', 'newsEventsByDate'], {});
  const local = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();
  const events = [
    { title: 'CPI', country: 'USD', date: local(2026, 10, 14, 14, 30), impact: 'High' },
    { title: 'Retail Sales', country: 'USD', date: local(2026, 10, 14, 14, 30), impact: 'Medium' },
    { title: 'ZEW', country: 'EUR', date: local(2026, 10, 14, 11, 0), impact: 'High' },
    { title: 'Bank Holiday', country: 'USD', date: local(2026, 10, 12, 6, 0), impact: 'Holiday' },
    { title: 'Pozdě večer', country: 'USD', date: local(2026, 10, 15, 23, 50), impact: 'High' }
  ];
  const usdHigh = plain(r.newsEventsByDate(events, { currencies: 'USD', minImpact: 'High' }));
  assert.deepEqual(Object.keys(usdHigh).sort(), ['2026-10-12', '2026-10-14', '2026-10-15']);
  assert.deepEqual(usdHigh['2026-10-14'].map(e => [e.time, e.title]), [['14:30', 'CPI']]);
  assert.deepEqual(usdHigh['2026-10-12'].map(e => [e.time, e.holiday]), [['', true]], 'svátek bez času');
  assert.deepEqual(usdHigh['2026-10-15'].map(e => e.time), ['23:50'], 'den podle místního času');
  const both = plain(r.newsEventsByDate(events, { currencies: 'usd, eur', minImpact: 'Medium' }));
  assert.deepEqual(both['2026-10-14'].map(e => e.title), ['ZEW', 'CPI', 'Retail Sales'], 'seřazeno podle času');
  assert.deepEqual(Object.keys(plain(r.newsEventsByDate(events, { currencies: '', minImpact: 'High' }))).sort(), ['2026-10-12', '2026-10-14', '2026-10-15'], 'bez měn = všechny měny');
  assert.deepEqual(plain(r.newsEventsByDate(null, { currencies: 'USD' })), {});
});
