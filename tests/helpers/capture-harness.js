'use strict';
// Společný harness pro testy sestavování obchodů z exekucí NinjaTraderu
// (processExecution / processPositionSnapshot z main.js). Stav, protokol
// i hodiny jsou v paměti – na disk ani do sítě se nesahá.

const { loadMain } = require('./extract');

// Funkce a konstanty z main.js, které processExecution potřebuje.
const CAPTURE_NAMES = [
  'POSITION_MISSING_GRACE_MS', 'SNAPSHOT_RACE_WINDOW_MS', 'positionIsMissing', 'openCapturePositions',
  'signedExecutionQuantity', 'positionKey', 'lotKeyOf', 'positionLots', 'applyLots', 'takeFromLots', 'openPositionFromExecution', 'excursionTicks', 'processExecution',
  'normalizeSnapshotPosition', 'processPositionSnapshot'
];

function captureHarness({
  account = 'PPNTF50030698000001',
  instrument = 'MES',
  instrumentFull = 'MES 12-26',
  pointValue = 5,
  tickSize = 0.25,
  startTime = '2026-10-12T14:28:00.000Z'
} = {}) {
  const base = { source: 'ninjatrader', type: 'execution', account, instrument, instrumentFull, pointValue, rate: 1, tickSize };
  const events = [];
  const info = [];
  const state = { positions: {}, executionIds: [] };
  const clock = { t: Date.parse(startTime) };
  class FakeDate extends Date { static now() { return clock.t; } }
  let ids = 0;
  const main = loadMain(CAPTURE_NAMES, {
    readCaptureState: () => state,
    writeCaptureState: () => {},
    takeScreenshots: async label => [`${label}.png`],
    appendCaptureEvent: payload => { const e = { id: 'ev' + events.length, ...payload }; events.push(e); return e; },
    crypto: { randomUUID: () => 'pos-' + (++ids) },
    logInfo: (context, message) => info.push(message),
    Date: FakeDate
  });
  const snapshot = positions => main.processPositionSnapshot({ type: 'position_snapshot', account, time: new Date(clock.t).toISOString(), positions });
  const flat = () => snapshot([]);
  const holding = (quantity, marketPosition, avgPrice) => snapshot([{ instrument, instrumentFull, quantity, marketPosition, avgPrice, pointValue }]);
  const exec = fields => main.processExecution({ ...base, ...fields });
  const closed = () => events.filter(e => e.type === 'trade_closed');
  const opened = () => events.filter(e => e.type === 'trade_opened');
  const open = () => Array.from(main.openCapturePositions(state));
  return { main, state, events, info, clock, snapshot, flat, holding, exec, closed, opened, open, account, key: `${account}|${instrumentFull}` };
}

module.exports = { captureHarness, CAPTURE_NAMES };
