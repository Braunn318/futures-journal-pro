#!/usr/bin/env node
'use strict';
// Příjemce zpráv testovacího pluginu FJProbePlugin (discovery). Jen 127.0.0.1:17699.
// Každou zprávu připíše do %APPDATA%\ctrader-mcp-probe\plugin\events.jsonl (obsahuje číslo účtu → mimo repo)
// a vypíše krátký souhrn. Deník ani jeho data se nepoužívají.
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.CTRADER_MCP_PROBE_DIR || path.join(process.env.APPDATA, 'ctrader-mcp-probe'), 'plugin');
const FILE = path.join(DIR, 'events.jsonl');
fs.mkdirSync(DIR, { recursive: true });

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/plugin-probe') { res.writeHead(404).end(); return; }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 50e6) req.destroy(); });
  req.on('end', () => {
    const receivedAt = new Date().toISOString();
    let m; try { m = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    fs.appendFileSync(FILE, JSON.stringify({ receivedAt, ...m }) + '\n');
    const d = m.data || {};
    console.log(`${receivedAt} ${m.type} run=${m.runId} #${m.seq}` +
      (d.historyCount !== undefined ? ` history=${d.historyCount} histOrders=${d.historicalOrdersCount} pos=${d.positionsCount} pend=${d.pendingCount}` : ''));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
}).listen(17699, '127.0.0.1', () => console.log('listener 127.0.0.1:17699 →', FILE));
