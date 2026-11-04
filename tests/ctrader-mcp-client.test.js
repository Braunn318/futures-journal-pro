'use strict';
// cTrader Desktop MCP klient (docs/ZADANI_CTRADER_MCP.md §3, §6 testy 1–2).
// Deník smí volat jen čtecí nástroje z whitelistu; zápisový nástroj se nesmí
// v kódu appky objevit ani jako text. Nedostupný server = tichý stav, žádná výjimka.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mcp = require('../app/ctrader-mcp.js');
const FJSwing = require('../app/swing.js');

// Zápisové nástroje serveru ctrader-desktop 2.0.0 (tools/list 4. 11. 2026, discovery §2).
const WRITE_TOOLS = [
  'place_market_order', 'place_limit_order', 'place_stop_order', 'place_stop_limit_order', 'amend_order', 'amend_position',
  'cancel_order', 'cancel_all_pending_orders', 'close_position', 'close_position_partial', 'close_all_positions',
  'startPlugin', 'stopPlugin', 'create_price_alert', 'delete_price_alert',
  'add_chart_object', 'update_chart_object', 'delete_chart_object', 'clear_chart_objects', 'apply_chart_template', 'save_chart_template',
  'delete_chart_template', 'change_chart_symbol', 'change_chart_timeframe', 'open_chart', 'close_chart', 'focus_chart', 'scroll_chart',
  'zoom_chart', 'addChartIndicator', 'removeChartIndicator', 'update_indicator_parameters',
  'load_workspace', 'save_workspace', 'delete_workspace', 'set_asp_tab', 'set_layout_mode', 'set_market_watch_panel',
  'set_trade_watch_tab', 'switch_app', 'show_notification',
  'add_symbol_to_watchlist', 'create_watchlist', 'delete_watchlist', 'remove_symbol_from_watchlist', 'rename_watchlist'
];

function fakeServer(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    calls.push(body.method === 'tools/call' ? body.params.name : body.method);
    const reply = (result) => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json'], ['mcp-session-id', 'S1']]), text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ctrader-desktop' } });
    if (!body.id) return { ok: true, status: 202, headers: new Map(), text: async () => '' };
    if (body.method === 'tools/call') return reply({ content: [{ type: 'text', text: JSON.stringify(handlers[body.params.name]()) }] });
    return reply({});
  };
  return { fetchImpl, calls };
}

test('whitelist: jen tři čtecí nástroje, žádný zápisový', () => {
  assert.deepEqual([...mcp.ALLOWED_TOOLS].sort(), ['get_accounts_list', 'get_balance', 'get_pending_orders']);
  for (const w of WRITE_TOOLS) assert.ok(!mcp.ALLOWED_TOOLS.includes(w), w);
});

test('nástroj mimo whitelist se odmítne ještě před odesláním', async () => {
  const { fetchImpl, calls } = fakeServer({});
  const client = mcp.createClient(mcp.DEFAULT_URL, { fetchImpl });
  for (const w of ['place_market_order', 'close_position', 'amend_position', 'get_positions']) {
    await assert.rejects(client.call(w), /nesmí volat/);
  }
  assert.equal(calls.length, 0, 'nic se neposlalo');
});

test('jen lokální adresa', () => {
  assert.throws(() => mcp.checkUrl('http://example.com:9876/mcp/'), /127\.0\.0\.1/);
  assert.throws(() => mcp.checkUrl('https://127.0.0.1:9876/mcp/'), /127\.0\.0\.1/);
  assert.equal(mcp.checkUrl('http://127.0.0.1:9876/mcp/'), 'http://127.0.0.1:9876/mcp/');
});

test('server nedostupný → { available:false }, žádná výjimka', async () => {
  const refused = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  const r = await mcp.fetchPendingOrders(mcp.DEFAULT_URL, { fetchImpl: refused });
  assert.equal(r.available, false);
  assert.equal(r.error, null);
  const bad = await mcp.fetchPendingOrders('http://evil.example/mcp/');
  assert.equal(bad.available, false);
});

test('čekající příkazy: tvar jako get_pending_orders z discovery (vymyšlená čísla)', async () => {
  const { fetchImpl, calls } = fakeServer({
    get_pending_orders: () => ({ orders: [
      { id: 501, symbolName: 'EURJPY', tradeSide: 'Buy', orderType: 'Limit', volumeInUnits: 20000, volumeInLots: 0.2, lotSize: 100000,
        targetPrice: 170.5, currentPrice: 171.2, stopLossPrice: 170.1, stopLossPips: null, takeProfitPrice: 171.4, takeProfitPips: 90,
        expiration: null, label: '', comment: '' },
      { id: 502, symbolName: 'AUDNZD', tradeSide: 'Sell', orderType: 'Stop', volumeInUnits: 9000, volumeInLots: 0.09, lotSize: 100000,
        targetPrice: 1.2, currentPrice: 1.21, stopLossPrice: 1.21, stopLossPips: null, takeProfitPrice: 1.18, takeProfitPips: 200,
        expiration: '2026-11-10T21:00:00Z', label: '', comment: '' }
    ] }),
    get_balance: () => ({ balance: 10000, depositAsset: 'USD', brokerName: 'Broker X', connectionState: 'Authenticated' })
  });
  const r = await mcp.fetchPendingOrders(mcp.DEFAULT_URL, { fetchImpl });
  assert.equal(r.available, true);
  assert.deepEqual(r.account, { broker: 'Broker X', currency: 'USD', balance: 10000 });
  assert.equal(r.orders.length, 2);
  assert.ok(calls.every(c => !WRITE_TOOLS.includes(c)));
  const rows = r.orders.map(FJSwing.pendingFromMcp);
  assert.deepEqual(
    { symbol: rows[0].symbol, direction: rows[0].direction, orderType: rows[0].orderType, price: rows[0].price, sl: rows[0].sl, tp: rows[0].tp, volume: rows[0].volume, source: rows[0].source },
    { symbol: 'EURJPY', direction: 'long', orderType: 'LIMIT', price: 170.5, sl: 170.1, tp: 171.4, volume: 0.2, source: 'CTRADER' });
  assert.equal(rows[1].direction, 'short');
  assert.equal(rows[1].orderType, 'STOP');
  assert.equal(rows[1].expiresAt, '2026-11-10T22:00', 'expirace v berlínském čase');
});

test('v kódu appky se neobjeví žádný zápisový nástroj cTraderu', () => {
  const root = path.join(__dirname, '..');
  const files = ['main.js', 'preload.js', ...fs.readdirSync(path.join(root, 'app')).filter(f => /\.(js|html)$/.test(f)).map(f => 'app/' + f)];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const w of WRITE_TOOLS) assert.ok(!new RegExp(`['"\`]${w}['"\`]`).test(src), `${f} obsahuje ${w}`);
  }
  // tools/call jen v klientovi
  for (const f of files.filter(f => f !== 'app/ctrader-mcp.js')) {
    assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes("'tools/call'"), `${f} volá tools/call mimo klienta`);
  }
});
