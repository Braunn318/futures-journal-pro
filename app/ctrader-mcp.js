'use strict';
// Minimální klient lokálního MCP serveru cTrader Desktop (docs/ZADANI_CTRADER_MCP.md).
// Běží v main procesu. JEN ČTE: tools/call jen pro nástroje z app/ctrader-mcp-allowed-tools.js,
// jen na 127.0.0.1 / localhost. Když cTrader neběží, vrací { available: false } – žádná výjimka.
//
// Zatím jen čekající příkazy pro záložku Pozice/Příkazy. Import obchodů přijde v dalším kroku.

const ALLOWED_TOOLS = require('./ctrader-mcp-allowed-tools.js');

const DEFAULT_URL = 'http://127.0.0.1:9876/mcp/';
const PROTOCOL = '2025-06-18';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function checkUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Neplatná adresa MCP serveru.'); }
  if (u.protocol !== 'http:' || !LOCAL_HOSTS.has(u.hostname)) throw new Error('MCP server cTraderu musí běžet na 127.0.0.1.');
  return u.toString();
}

function assertAllowed(name) {
  if (!ALLOWED_TOOLS.includes(name)) throw new Error(`Nástroj cTraderu „${name}" deník nesmí volat (není ve whitelistu čtení).`);
}

// Výsledek nástroje → data (content[].text bývá JSON).
function parseResult(r) {
  if (!r) return null;
  if (r.structuredContent) return r.structuredContent;
  const texts = (r.content || []).filter(c => c && c.type === 'text').map(c => c.text);
  if (texts.length !== 1) return null;
  try { return JSON.parse(texts[0]); } catch { return null; }
}

function createClient(url, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const endpoint = checkUrl(url || DEFAULT_URL);
  let sid = null, id = 0;
  async function post(body) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (sid) { headers['Mcp-Session-Id'] = sid; headers['MCP-Protocol-Version'] = PROTOCOL; }
    const res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const s = res.headers && res.headers.get && res.headers.get('mcp-session-id');
    if (s) sid = s;
    if (body.id === undefined) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (ct.includes('text/event-stream')) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try { const m = JSON.parse(line.slice(5).trim()); if (m.id === body.id) return m; } catch {}
      }
      throw new Error('MCP: odpověď chybí');
    }
    return JSON.parse(text);
  }
  async function rpc(method, params) {
    const m = await post({ jsonrpc: '2.0', id: ++id, method, params });
    if (m && m.error) throw new Error(`MCP ${method}: ${m.error.message || m.error.code}`);
    return m && m.result;
  }
  let ready = null;
  function init() {
    ready = ready || (async () => {
      await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'futures-journal-pro', version: '1' } });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    return ready;
  }
  return {
    async call(name, args = {}) {
      assertAllowed(name); // ještě před jakýmkoli spojením
      await init();
      const r = await rpc('tools/call', { name, arguments: args });
      if (r && r.isError) throw new Error(`cTrader: ${name} vrátil chybu`);
      return parseResult(r);
    },
    async close() {
      if (!sid) return;
      try { await fetchImpl(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid }, signal: AbortSignal.timeout(2000) }); } catch {}
    }
  };
}

// Čekající příkazy aktivního účtu v cTraderu + údaje, podle kterých se účet pozná
// (odpovědi serveru číslo účtu nenesou). Nedostupný server = { available: false }.
async function fetchPendingOrders(url, opts) {
  let client;
  try { client = createClient(url, opts); } catch (e) { return { available: false, error: e.message }; }
  try {
    const orders = await client.call('get_pending_orders');
    const balance = await client.call('get_balance');
    return {
      available: true,
      fetchedAt: new Date().toISOString(),
      account: balance ? { broker: balance.brokerName || null, currency: balance.depositAsset || null, balance: balance.balance ?? null } : null,
      orders: Array.isArray(orders && orders.orders) ? orders.orders : []
    };
  } catch (e) {
    const offline = /fetch failed|ECONNREFUSED|timeout|aborted/i.test(String(e && (e.cause && e.cause.code) || e.message));
    return { available: false, error: offline ? null : e.message };
  } finally {
    await client.close();
  }
}

// Jedno čtecí volání: { available, data } / { available:false }.
async function readOnce(url, tool, args, opts) {
  let client;
  try { client = createClient(url, opts); } catch (e) { return { available: false, error: e.message }; }
  try { return { available: true, fetchedAt: new Date().toISOString(), data: await client.call(tool, args) }; }
  catch (e) {
    const offline = /fetch failed|ECONNREFUSED|timeout|aborted/i.test(String(e && (e.cause && e.cause.code) || e.message));
    return { available: false, error: offline ? null : e.message };
  } finally { await client.close(); }
}
// Otevřené pozice aktivního účtu (SL / TP) – pro swing deník.
async function fetchPositions(url, opts) {
  const r = await readOnce(url, 'get_positions', {}, opts);
  return r.available ? { available: true, fetchedAt: r.fetchedAt, positions: Array.isArray(r.data && r.data.positions) ? r.data.positions : [] } : r;
}
// Detail symbolu (velikost lotu, pip, digits) – doplní tabulku CFD instrumentů.
async function fetchSymbolDetails(url, symbol, opts) {
  if (!symbol || typeof symbol !== 'string') return { available: false, error: 'chybí symbol' };
  const r = await readOnce(url, 'get_symbol_details', { symbolName: symbol }, opts);
  return r.available ? { available: true, details: r.data || null } : r;
}

module.exports = { DEFAULT_URL, ALLOWED_TOOLS, createClient, fetchPendingOrders, fetchPositions, fetchSymbolDetails, parseResult, checkUrl, assertAllowed };
