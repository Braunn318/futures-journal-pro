'use strict';
// Cílová hladina 1 / 2 jako multi-výběr (4.8.99): i výstup může ležet na
// konfluenci hladin. Uloženo { type, types, price } – `types` jsou rovnocenné
// v pořadí číselníku, `type` = první z nich kvůli starším čtenářům (Backtest
// Lab, starší exporty). Starý tvar { type, price } se čte jako [type].

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRenderer } = require('./helpers/extract');
const FJTaxonomy = require('../app/taxonomy.js');
const FJContext = require('../app/context.js');

const eq = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const CFG = { TARGET_LEVEL: { custom: { CUSTOM_FIX_RRR: 'Fix RRR' } } };

test('starý tvar s jedním typem se čte jako seznam s jedním typem', () => {
  eq(FJTaxonomy.sanitizeTargetLevel({ type: 'VAL', price: 7700 }), { type: 'VAL', types: ['VAL'], price: 7700 });
  eq(FJTaxonomy.targetTypesOf({ type: 'VAL' }), ['VAL']);
  eq(FJTaxonomy.targetTypesOf(undefined), []);
});

test('víc typů: pořadí číselníku, type = první, neznámý klíč pryč, skrytý zůstává', () => {
  const tl = FJTaxonomy.sanitizeTargetLevel({ types: ['VAL', 'NEEXISTUJE', 'LIQUIDITY', 'HOD_LOD'], price: '7700.5' });
  eq(tl, { type: 'LIQUIDITY', types: ['LIQUIDITY', 'VAL', 'HOD_LOD'], price: 7700.5 }, 'HOD_LOD je výchozí skrytá, ale uložená se neztratí');
  assert.equal(FJTaxonomy.sanitizeTargetLevel({ types: [], price: '' }), null);
  eq(FJTaxonomy.sanitizeTargetLevel({ types: ['CUSTOM_FIX_RRR'] }, CFG), { type: 'CUSTOM_FIX_RRR', types: ['CUSTOM_FIX_RRR'], price: null });
});

test('export vypíše uložené typy bez kontroly číselníku', () => {
  eq(FJTaxonomy.storedTargetTypes({ type: 'CUSTOM_X', price: 1 }), ['CUSTOM_X']);
  eq(FJTaxonomy.storedTargetTypes({ type: 'VAL', types: ['VAL', 'CUSTOM_X'] }), ['VAL', 'CUSTOM_X']);
  eq(FJTaxonomy.storedTargetTypes(null), []);
});

test('neúplný kontext: cíl s typy a cenou je vyplněný', () => {
  const missing = t => FJTaxonomy.missingContextKeys({ targetLevel1: t }).includes('targetLevel1');
  assert.equal(missing({ types: ['VAL', 'LIQUIDITY'], price: 7700 }), false);
  assert.equal(missing({ types: [], price: 7700 }), true);
  assert.equal(missing({ type: 'VAL', price: 7700 }), false, 'starý tvar');
});

test('cíl na hladině: stačí jeden typ, který je hladinou', () => {
  const on = (types, extra) => FJContext.targetOnLevel({ targetLevel1: { types, price: 7804 }, ...extra }, CFG);
  assert.equal(on(['CUSTOM_FIX_RRR', 'VAL']), true);
  assert.equal(on(['CUSTOM_FIX_RRR', 'MANUAL_EXIT']), false);
  assert.equal(on([]), null);
  assert.equal(on(['VAL'], { targetLevel1PriceDerived: true }), false);
});

test('sloučení nohou: typy se sjednotí, ruční cena z první nohy, která ji má', () => {
  const r = loadRenderer(['mergeContextFields'], {});
  const merged = r.mergeContextFields([
    { targetLevel2: { types: ['VAL'], price: 7710 }, targetLevel2PriceDerived: true },
    { targetLevel2: { types: ['LIQUIDITY', 'VAL'], price: 7712 } }
  ]);
  eq(merged.targetLevel2, { type: 'LIQUIDITY', types: ['LIQUIDITY', 'VAL'], price: 7712 });
});

test('karta obchodu a shrnutí ukážou všechny typy cíle', () => {
  const r = loadRenderer(['targetTypesLabel'], {});
  assert.equal(r.targetTypesLabel(['VAL', 'LIQUIDITY']), 'VAL + Likvidita');
  assert.equal(r.targetTypesLabel([]), '?');
});
