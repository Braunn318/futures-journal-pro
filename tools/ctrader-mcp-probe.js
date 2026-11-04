#!/usr/bin/env node
'use strict';
/*
 * cTrader Desktop MCP server – discovery probe (Fáze 0, docs/ZADANI_CTRADER_MCP.md §1).
 * Samostatný skript MIMO appku, nic nezapisuje do dat deníku. Komunikuje jen s 127.0.0.1.
 *
 * JEN ČTE. Volat smí jen nástroje z READ_TOOLS níže; cokoli jiného vyhodí chybu ještě před odesláním.
 * Zápisové nástroje (obchody, grafy, alerty, layout, watchlisty, pluginy…) se nikdy nevolají.
 *
 * Použití (cTrader Desktop běží, Settings → Advanced → MCP server → Enable MCP server):
 *   node tools/ctrader-mcp-probe.js ping                 initialize + počet nástrojů (např. po restartu cTraderu)
 *   node tools/ctrader-mcp-probe.js tools [--tag název]  tools/list → tools.json (+ tools-<tag>.json pro porovnání,
 *                                                        např. s „Allow trading via MCP" zapnutým / vypnutým)
 *   node tools/ctrader-mcp-probe.js fetch [--symbol EURUSD]   čtecí nástroje → surové odpovědi (soukromá složka)
 *   node tools/ctrader-mcp-probe.js anonymize            surové → <DEV>\docs\samples\ctrader-mcp\ (anonymizované)
 *
 *   --url <adresa>   výchozí http://127.0.0.1:9876/mcp/
 *   --out <dir>      cíl vzorků (výchozí ../docs/samples/ctrader-mcp vedle repo_clone)
 *
 * Surové odpovědi (s číslem účtu) jdou do %APPDATA%\ctrader-mcp-probe\raw, mimo repozitář i docs.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_URL = 'http://127.0.0.1:9876/mcp/';
const PROTOCOL = '2025-06-18';

// Čtecí nástroje, které probe smí zavolat. Nic jiného.
const READ_TOOLS = new Set([
  'get_server_time', 'get_accounts_list', 'get_balance', 'get_account_statistics',
  'get_positions', 'get_pending_orders', 'get_deals', 'get_order_history',
  'get_symbol_details', 'get_trendbars', 'list_charts', 'get_active_chart',
]);

const PRIVATE_DIR = process.env.CTRADER_MCP_PROBE_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'ctrader-mcp-probe');
const RAW_DIR = path.join(PRIVATE_DIR, 'raw');
const DEFAULT_OUT = path.resolve(__dirname, '..', '..', 'docs', 'samples', 'ctrader-mcp');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const log = (...a) => console.log('[mcp-probe]', ...a);
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }

function checkLocal(url) {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('Probe smí mluvit jen s 127.0.0.1 (zadáno ' + u.hostname + ').');
}

// ---- minimální MCP klient (Streamable HTTP, JSON-RPC 2.0) ----
class McpClient {
  constructor(url) { checkLocal(url); this.url = url; this.sid = null; this.id = 0; }
  async post(body) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sid) headers['Mcp-Session-Id'] = this.sid;
    if (this.sid) headers['MCP-Protocol-Version'] = PROTOCOL;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const sid = res.headers.get('mcp-session-id'); if (sid) this.sid = sid;
    if (res.status === 202 || body.id === undefined) return null;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (ct.includes('text/event-stream')) {
      // vybrat zprávu s naším id ze SSE
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try { const m = JSON.parse(line.slice(5).trim()); if (m.id === body.id) return m; } catch {}
      }
      throw new Error('SSE bez odpovědi na id ' + body.id);
    }
    return JSON.parse(text);
  }
  async rpc(method, params) {
    const m = await this.post({ jsonrpc: '2.0', id: ++this.id, method, params });
    if (m.error) throw Object.assign(new Error(`${method}: ${m.error.code} ${m.error.message}`), { rpcError: m.error });
    return m.result;
  }
  async initialize() {
    const r = await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'fj-ctrader-mcp-probe', version: '0.1.0' } });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }
  async listTools() {
    const all = []; let cursor;
    do { const r = await this.rpc('tools/list', cursor ? { cursor } : {}); all.push(...(r.tools || [])); cursor = r.nextCursor; } while (cursor);
    return all;
  }
  async call(name, args = {}) {
    if (!READ_TOOLS.has(name)) throw new Error(`Nástroj ${name} není ve whitelistu čtení – probe ho nezavolá.`);
    const r = await this.rpc('tools/call', { name, arguments: args });
    return r;
  }
  async close() {
    if (!this.sid) return;
    try { await fetch(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sid }, signal: AbortSignal.timeout(5000) }); } catch {}
  }
}

// MCP výsledek → data: content[].text bývá JSON
function parseResult(r) {
  if (!r) return r;
  if (r.structuredContent) return r.structuredContent;
  const texts = (r.content || []).filter(c => c.type === 'text').map(c => c.text);
  if (texts.length === 1) { try { return JSON.parse(texts[0]); } catch { return texts[0]; } }
  return texts.map(t => { try { return JSON.parse(t); } catch { return t; } });
}

async function connect() {
  const cl = new McpClient(String(arg('url', DEFAULT_URL)));
  const init = await cl.initialize();
  return { cl, init };
}

async function ping() {
  const t0 = Date.now();
  try {
    const { cl, init } = await connect();
    const tools = await cl.listTools();
    await cl.close();
    log(`OK za ${Date.now() - t0} ms · ${init.serverInfo?.name} ${init.serverInfo?.version} · protokol ${init.protocolVersion} · nástrojů ${tools.length}`);
  } catch (e) {
    log('cTrader MCP nedostupný:', e.cause?.code || e.message);
    process.exitCode = 3;
  }
}

async function tools() {
  const { cl, init } = await connect();
  const list = await cl.listTools();
  await cl.close();
  const out = path.resolve(typeof arg('out') === 'string' ? arg('out') : DEFAULT_OUT);
  const doc = { capturedAt: new Date().toISOString(), serverInfo: init.serverInfo, protocolVersion: init.protocolVersion, capabilities: init.capabilities, tools: list };
  const tag = typeof arg('tag') === 'string' ? arg('tag').replace(/[^\w-]/g, '') : null;
  // seznam nástrojů neobsahuje údaje o účtu → rovnou do vzorků
  writeJson(path.join(out, tag ? `tools-${tag}.json` : 'tools.json'), doc);
  log(`uloženo ${list.length} nástrojů → ${path.join(out, tag ? `tools-${tag}.json` : 'tools.json')}`);
}

async function fetchAll() {
  const { cl, init } = await connect();
  const save = (name, obj) => { writeJson(path.join(RAW_DIR, name), obj); log('raw/' + name); };
  const calls = [];
  const call = async (name, args, file) => {
    const t0 = Date.now();
    let entry;
    try {
      const r = await cl.call(name, args);
      entry = { tool: name, arguments: args, ms: Date.now() - t0, isError: !!r.isError, raw: r, data: parseResult(r) };
    } catch (e) {
      entry = { tool: name, arguments: args, ms: Date.now() - t0, error: e.rpcError || e.message };
    }
    calls.push({ tool: name, arguments: args, ms: entry.ms, ok: !entry.error && !entry.isError });
    save(file, entry);
    return entry.data;
  };
  try {
    save('initialize.json', init);
    await call('get_server_time', {}, 'server-time.json');
    await call('get_accounts_list', {}, 'accounts-list.json');
    await call('get_balance', {}, 'balance.json');
    await call('get_account_statistics', {}, 'account-statistics.json');
    const positions = await call('get_positions', {}, 'positions.json');
    const pending = await call('get_pending_orders', {}, 'pending-orders.json');
    const deals = await call('get_deals', { count: 200 }, 'deals.json');
    const history = await call('get_order_history', {}, 'order-history.json');
    await call('list_charts', {}, 'charts.json');
    await call('get_active_chart', {}, 'active-chart.json');

    // symboly z dat + referenční EURUSD a USDJPY (JPY pár kvůli pipSize 0.01)
    const syms = new Set(['EURUSD', 'USDJPY']);
    const pick = v => {
      if (Array.isArray(v)) return v.forEach(pick);
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
        if (/^symbol(Name)?$/i.test(k) && typeof x === 'string' && x) syms.add(x);
        else pick(x);
      }
    };
    [positions, pending, deals, history].forEach(pick);
    const wanted = typeof arg('symbol') === 'string' ? String(arg('symbol')) : null;
    if (wanted) syms.add(wanted);
    const symDetails = {};
    for (const s of syms) symDetails[s] = await call('get_symbol_details', { symbolName: s }, `symbol-${s.replace(/[^\w.-]/g, '_')}.json`);

    // svíčky D1 a H4: zvolený symbol, jinak první z obchodů, jinak EURUSD; + USDJPY
    const barSym = wanted || [...syms].find(s => s !== 'EURUSD' && s !== 'USDJPY') || 'EURUSD';
    const now = new Date();
    const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const s of [...new Set([barSym, 'USDJPY'])]) {
      await call('get_trendbars', { symbolName: s, timeframe: 'd1', from: iso(new Date(now - 120 * 864e5)), to: iso(now), limit: 1000 }, `trendbars-${s}-D1.json`);
      await call('get_trendbars', { symbolName: s, timeframe: 'h4', from: iso(new Date(now - 30 * 864e5)), to: iso(now), limit: 1000 }, `trendbars-${s}-H4.json`);
    }
    save('_calls.json', calls);
    log(`hotovo (${calls.filter(c => c.ok).length}/${calls.length} OK). Další krok: node tools/ctrader-mcp-probe.js anonymize`);
  } finally { await cl.close(); }
}

// ---- anonymizace ----
// Číslo účtu / login, broker a label/comment se nahradí; positionId / orderId / dealId se přečíslují
// konzistentně (vazby zůstanou). Ceny, objemy, časy a peníze zůstávají – slouží jako testovací data.
function anonymize() {
  if (!fs.existsSync(RAW_DIR)) { console.error('Nic k anonymizaci – nejdřív fetch.'); process.exit(2); }
  const outDir = path.resolve(typeof arg('out') === 'string' ? arg('out') : DEFAULT_OUT);
  const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.json')).sort();
  const raws = files.map(f => [f, readJson(path.join(RAW_DIR, f))]);

  const isAccountKey = k => /^(login|account|accountId|accountNumber|number|traderLogin|traderId|ctidTraderAccountId)$/i.test(k);
  // „id" znamená podle souboru účet, pozici nebo příkaz
  const ID_BY_FILE = f => (/^accounts-list/.test(f) && 'account') || (/^positions/.test(f) && 'position') || (/^pending-orders/.test(f) && 'order') || null;
  let idKind = null;
  const isBrokerKey = k => /broker/i.test(k);
  const isTextKey = k => /^(label|comment|accountName|name|nickname|description)$/i.test(k);
  const KIND = k => (/^positionId$/i.test(k) && 'position') || (/^orderId$/i.test(k) && 'order') || (/^(dealId|closingDealId)$/i.test(k) && 'deal') || null;

  // 1) sesbírat citlivé hodnoty (čísla účtů, brokery) ze všech souborů
  const accountVals = new Set(); const brokerVals = new Set();
  const collect = v => {
    if (Array.isArray(v)) return v.forEach(collect);
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if ((isAccountKey(k) || (k === 'id' && idKind === 'account')) && (typeof x === 'number' || (typeof x === 'string' && /^\d{4,}$/.test(x)))) accountVals.add(String(x));
      else if (isBrokerKey(k) && typeof x === 'string' && x) brokerVals.add(x);
      else if (typeof x === 'string' && /^[\[{]/.test(x.trim())) { try { collect(JSON.parse(x)); } catch {} }
      else collect(x);
    }
  };
  raws.forEach(([f, r]) => { idKind = ID_BY_FILE(f); collect(r); });

  const maps = { account: new Map(), position: new Map(), order: new Map(), deal: new Map(), broker: new Map() };
  const base = { account: 1000001, position: 100001, order: 200001, deal: 300001 };
  const remap = (kind, v) => {
    const k = String(v); const m = maps[kind];
    if (!m.has(k)) m.set(k, kind === 'broker' ? `BROKER_${m.size + 1}` : base[kind] + m.size);
    const n = m.get(k);
    return typeof v === 'number' ? n : String(n);
  };
  const walk = (v, parentKey) => {
    if (Array.isArray(v)) return v.map(x => walk(x, parentKey));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (x == null) { o[k] = x; continue; }
        if ((isAccountKey(k) || (k === 'id' && idKind === 'account')) && accountVals.has(String(x))) { o[k] = remap('account', x); continue; }
        if (k === 'id' && (idKind === 'position' || idKind === 'order') && typeof x === 'number') { o[k] = remap(idKind, x); continue; }
        if (isBrokerKey(k) && typeof x === 'string') { o[k] = remap('broker', x); continue; }
        if (KIND(k) && (typeof x === 'number' || typeof x === 'string')) {
          const pref = typeof x === 'string' && x.startsWith('ctrader-') ? 'ctrader-' : '';
          o[k] = pref ? pref + remap(KIND(k), x.slice(8)) : remap(KIND(k), x); continue;
        }
        if (isTextKey(k) && typeof x === 'string' && x && !['tool'].includes(parentKey) && parentKey !== 'arguments' && !/symbol/i.test(parentKey || '')) {
          // názvy nástrojů a symbolů nechat; volné texty účtu/obchodu nahradit
          if (k.toLowerCase() === 'name' || k.toLowerCase() === 'description') { o[k] = x; continue; }
          o[k] = `${k.toUpperCase()}_TEXT`; continue;
        }
        if (k === 'text' && typeof x === 'string' && /^[\[{]/.test(x.trim())) {
          try { o[k] = JSON.stringify(walk(JSON.parse(x), k)); continue; } catch {}
        }
        o[k] = walk(x, k);
      }
      return o;
    }
    if (typeof v === 'string') {
      let s = v;
      for (const a of accountVals) if (a.length >= 4) s = s.split(a).join(String(remap('account', a)));
      for (const b of brokerVals) s = s.split(b).join(remap('broker', b));
      return s;
    }
    return v;
  };
  // 2) anonymizovat a zkontrolovat vše, zapsat až když je čisté
  const outputs = raws.map(([f, r]) => { idKind = ID_BY_FILE(f); return [f, JSON.stringify(walk(r), null, 2)]; });
  for (const [f, text] of outputs) {
    for (const s of [...accountVals].filter(a => a.length >= 4).concat([...brokerVals])) {
      if (text.includes(s)) { console.error(`STOP: ${f} po anonymizaci pořád obsahuje číslo účtu / brokera. Nic nezapsáno.`); process.exit(1); }
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [f, text] of outputs) fs.writeFileSync(path.join(outDir, f), text + '\n');
  fs.writeFileSync(path.join(outDir, 'README.md'),
    '# cTrader Desktop MCP – anonymizované vzorky (Fáze 0)\n\n' +
    `Vytvořeno ${new Date().toISOString().slice(0, 10)} skriptem \`repo_clone/tools/ctrader-mcp-probe.js\`.\n\n` +
    '- `tools.json` = celý `tools/list` se schématy (bez údajů o účtu).\n' +
    '- Ostatní soubory: jedna odpověď čtecího nástroje (`raw` = MCP výsledek, `data` = rozparsovaný JSON).\n' +
    '- Čísla účtů a loginy, broker, `label` / `comment` nahrazeny; `positionId` / `orderId` / `dealId` přečíslovány konzistentně.\n' +
    '- Ceny, objemy, časy, swap, komise a P/L ponechány – slouží jako testovací data. Do `repo_clone` (veřejné) nepatří.\n');
  log(`anonymizováno ${files.length} souborů → ${outDir} (účtů ${maps.account.size}, brokerů ${maps.broker.size})`);
}

const cmd = process.argv[2];
const run = { ping, tools, fetch: fetchAll, anonymize }[cmd];
if (!run) {
  const src = fs.readFileSync(__filename, 'utf8');
  console.log(src.slice(src.indexOf('/*'), src.indexOf('*/') + 2));
  process.exit(cmd ? 2 : 0);
}
Promise.resolve(run()).then(() => {}, e => { console.error('[mcp-probe] chyba:', e.message); process.exitCode = 1; });

module.exports = { READ_TOOLS };
