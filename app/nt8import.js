'use strict';
// Ruční import z NinjaTraderu (4.8.7) – pro chvíle, kdy automatický import
// selže a je potřeba doplnit víc obchodů najednou.
//
// Dva zdroje, oba z NinjaTraderu 8 (export CSV z mřížky, nebo řádky zkopírované
// z mřížky přes Ctrl+C):
//  - EXEKUCE (okno Executions): stejná data, která posílá konektor. Z nich se
//    obchody NESKLÁDAJÍ tady – převedou se na tvar zprávy konektoru a hlavní
//    proces je přehraje stejným jádrem jako živé exekuce (applyExecution
//    v main.js). Víc cílů, dokupy i komise tak vyjdou stejně jako u
//    automatického importu.
//  - OBCHODY (Trade Performance → Trades): NinjaTrader je už spároval, jeden
//    řádek = jedna noha. Řádky se stejným účtem, instrumentem, směrem a časem
//    vstupu jsou jedna pozice (společné positionId) – deník je při zápisu
//    sloučí jako nohy, stejně jako u konektoru.
//
// Modul jen čte text – nic nezapisuje. Načítá se přes <script src> a jde načíst
// i v Node testech.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJNt8Import = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Hlavičky mřížek (anglické NinjaTrader 8). Porovnává se bez mezer, teček
  // a velikosti písmen, takže „Market pos.“ = „marketpos“.
  const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9/]/g, '');
  const EXEC_REQUIRED = ['instrument', 'action', 'quantity', 'price', 'time'];
  const TRADE_REQUIRED = ['instrument', 'marketpos', 'qty', 'entryprice', 'exitprice', 'entrytime', 'exittime'];

  // Oddělovač podle hlavičky: tab (kopie z mřížky), středník (CSV v české /
  // německé lokalizaci), čárka.
  function detectDelimiter(headerLine) {
    const counts = ['\t', ';', ','].map(d => [d, headerLine.split(d).length - 1]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ';';
  }

  // Jeden řádek CSV s uvozovkami ("a;b" je jedna buňka).
  function splitLine(line, delimiter) {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === delimiter) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  // Číslo z mřížky: „7674,50“, „-21,90 $“, „1 234,5“, „1,234.50“, „(21.90)“.
  // Prázdné nebo „-“ = null, nikdy 0.
  function parseNumber(value) {
    let s = String(value == null ? '' : value).replace(/[\s $€£Kč]/g, '');
    if (!s || s === '-') return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      // Desetinný je ten oddělovač, který je víc vpravo; druhý jsou tisíce.
      s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma >= 0) {
      s = s.replace(',', '.');
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return negative ? -n : n;
  }

  // Čas z mřížky v MÍSTNÍM čase počítače, na kterém běží NinjaTrader:
  // „24082026 17:39:53“ (export CSV), „24.08.2026 17:39:53“, „8/24/2026 5:39:53 PM“,
  // „2026-08-24 17:39:53“. Vrací ISO (UTC) nebo null.
  function parseTime(value) {
    const s = String(value || '').trim();
    let m, y, mo, d, h = 0, mi = 0, sec = 0;
    if ((m = /^(\d{2})(\d{2})(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s))) {
      [, d, mo, y, h, mi, sec] = m;
    } else if ((m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s))) {
      [, d, mo, y, h, mi, sec] = m;
    } else if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s))) {
      [, y, mo, d, h, mi, sec] = m;
    } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(s))) {
      let ap;
      [, mo, d, y, h, mi, sec, ap] = m;
      h = Number(h);
      if (ap) { ap = ap.toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
    } else return null;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec || 0));
    if (isNaN(date) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
    return date.toISOString();
  }

  // „MES 09-26“ → MES (kořen) a celý název kontraktu.
  function splitInstrument(value) {
    const full = String(value || '').trim();
    return { instrument: full.split(/\s+/)[0] || full, instrumentFull: full };
  }

  // Text (soubor nebo schránka) → { format, header, rows: [{ line, cells }] }.
  // Hlavička se hledá v prvních řádcích (kopie z mřížky ji mít nemusí –
  // pak se nepozná formát a vrátí se chyba s návodem).
  function parseTable(text) {
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (!lines[i].trim()) continue;
      const delimiter = detectDelimiter(lines[i]);
      const header = splitLine(lines[i], delimiter).map(norm);
      const has = list => list.every(k => header.includes(k));
      const format = has(TRADE_REQUIRED) ? 'trades' : (has(EXEC_REQUIRED) ? 'executions' : null);
      if (!format) continue;
      const rows = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        const cells = splitLine(lines[j], delimiter);
        const row = {};
        header.forEach((h, k) => { if (h && row[h] === undefined) row[h] = cells[k] ?? ''; });
        rows.push({ line: j + 1, cells: row });
      }
      return { format, rows };
    }
    return { format: null, rows: [] };
  }

  // ------------------------------------------------------------ exekuce

  // Řádky exekucí → zprávy ve tvaru konektoru, seřazené podle času (stejný čas:
  // pořadí v souboru; export NT bývá od nejnovějšího, proto se otáčí).
  // pointValueOf(instrument) dává hodnotu bodu ze šablony deníku – CSV ji nemá.
  function executionPayloads(rows, { pointValueOf, tickSizeOf } = {}) {
    const out = [], errors = [];
    const seen = new Map();
    rows.forEach((r, index) => {
      const c = r.cells;
      const time = parseTime(c.time);
      const price = parseNumber(c.price);
      const quantity = parseNumber(c.quantity);
      const action = String(c.action || '').trim();
      const { instrument, instrumentFull } = splitInstrument(c.instrument);
      if (!time || price == null || !(quantity > 0) || !/buy|sell/i.test(action) || !instrument) {
        errors.push({ line: r.line, error: 'Řádek nejde přečíst (čas, cena, počet nebo akce).' });
        return;
      }
      const ex = String(c['e/x'] || c.ex || '').trim().toLowerCase();
      const csvId = String(c.id || '').trim();
      // Bez ID z NinjaTraderu se ID složí z hodnot řádku a pořadí shody –
      // opakovaný import téhož souboru dá stejná ID (a nic nezdvojí).
      const base = csvId || `${time}|${instrumentFull}|${action}|${quantity}|${price}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      out.push({
        index,
        source: 'ninjatrader',
        type: 'execution',
        account: String(c.account || '').trim(),
        instrument, instrumentFull,
        time, price, quantity,
        commission: Math.abs(parseNumber(c.commission) || 0),
        rate: parseNumber(c.rate) || 1,
        pointValue: (pointValueOf && pointValueOf(instrument)) || null,
        tickSize: (tickSizeOf && tickSizeOf(instrument)) || 0,
        orderAction: action,
        orderName: String(c.name || '').trim(),
        orderId: String(c.orderid || '').trim(),
        executionId: csvId ? (n > 1 ? `${csvId}#${n}` : csvId) : `csv:${base}#${n}`,
        csvExecutionId: csvId,
        entryExit: ex.startsWith('entry') ? 'entry' : (ex.startsWith('exit') ? 'exit' : '')
      });
    });
    out.sort((a, b) => a.time.localeCompare(b.time) || rowOrder(a, b, rows.length));
    return { payloads: out.map(({ index, ...p }) => p), errors };
  }
  // Stejný čas: export z NT jde od nejnovějšího, takže pozdější řádek je dřív.
  // Vstup se ale musí přehrát před výstupem téže sekundy.
  function rowOrder(a, b) {
    const rank = p => (p.entryExit === 'entry' ? 0 : p.entryExit === 'exit' ? 1 : 0.5);
    return rank(a) - rank(b) || b.index - a.index;
  }

  // ------------------------------------------------------------ obchody

  // Řádky mřížky Obchody → uzavřené obchody ve tvaru události trade_closed.
  // Profit z NinjaTraderu je čistý (po všech poplatcích); hrubý výsledek se
  // počítá z cen a hodnoty bodu a komise je jejich rozdíl. MAE / MFE jsou
  // v mřížce v penězích za celý obchod – na ticky jednoho kontraktu se
  // převádějí jen se známou hodnotou bodu i velikostí ticku.
  function tradeEvents(rows, { pointValueOf, tickSizeOf } = {}) {
    const events = [], errors = [];
    const seen = new Map();
    for (const r of rows) {
      const c = r.cells;
      const { instrument, instrumentFull } = splitInstrument(c.instrument);
      const pos = String(c.marketpos || '').toLowerCase();
      const side = pos.startsWith('long') ? 'long' : (pos.startsWith('short') ? 'short' : '');
      const qty = parseNumber(c.qty);
      const entryPrice = parseNumber(c.entryprice), exitPrice = parseNumber(c.exitprice);
      const entryTime = parseTime(c.entrytime), exitTime = parseTime(c.exittime);
      const profit = parseNumber(c.profit);
      if (!instrument || !side || !(qty > 0) || entryPrice == null || exitPrice == null || !entryTime || !exitTime) {
        errors.push({ line: r.line, error: 'Řádek nejde přečíst (instrument, směr, počet, ceny nebo časy).' });
        continue;
      }
      const account = String(c.account || '').trim();
      const direction = side === 'long' ? 1 : -1;
      const pointsSigned = (exitPrice - entryPrice) * direction;
      const pv = (pointValueOf && pointValueOf(instrument)) || null;
      const tick = (tickSizeOf && tickSizeOf(instrument)) || 0;
      const grossPnl = pv ? pointsSigned * pv * qty : null;
      const pnl = profit != null ? profit : grossPnl;
      const commission = grossPnl != null && profit != null ? Math.max(0, Math.round((grossPnl - profit) * 100) / 100) : 0;
      const positionKey = `${account}|${instrumentFull}|${side}|${entryTime}`;
      const base = `${positionKey}|${exitTime}|${exitPrice}|${qty}|${entryPrice}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const excursion = {};
      const perTick = pv && tick > 0 ? pv * tick * qty : 0;
      for (const [key, col] of [['mfeTicks', 'mfe'], ['maeTicks', 'mae']]) {
        const money = parseNumber(c[col]);
        if (perTick && money != null) excursion[key] = Math.round(Math.abs(money) / perTick * 100) / 100;
      }
      events.push({
        id: `nt8t:${base}#${n}`,
        type: 'trade_closed',
        source: 'ninjatrader',
        account, instrument, instrumentFull, side,
        entryTime, exitTime, entryPrice, exitPrice,
        quantity: qty, contracts: qty,
        points: Math.abs(pointsSigned),
        ...(grossPnl != null ? { grossPnl } : {}),
        commission,
        pnl,
        result: (pnl || 0) >= 0 ? 'target' : 'stoploss',
        pointValue: pv,
        strategy: String(c.strategy || c.entryname || '').trim(),
        screenshotPaths: [],
        positionId: `nt8t:${positionKey}`,
        ...excursion
      });
    }
    events.sort((a, b) => a.exitTime.localeCompare(b.exitTime) || a.id.localeCompare(b.id));
    return { events, errors };
  }

  return { parseNumber, parseTime, splitInstrument, detectDelimiter, splitLine, parseTable, executionPayloads, tradeEvents };
}));
