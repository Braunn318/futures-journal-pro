'use strict';
// Automatické screenshoty: výběr oken podle názvu a druhá sekce „Po obchodu“
// (plánovač s frontou, která přežije restart). Fs, hodiny i časovače jsou
// v paměti, na disk ani do sítě se nesahá.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');

const { loadMain } = require('./helpers/extract');

const NAMES = [
  'captureWindowRules', 'pickCaptureWindows', 'normalizeScreenshotSettings', 'screenshotSettingsView',
  'afterShotPath', 'afterShotTimers', 'readAfterShotJobs', 'writeAfterShotJobs', 'armAfterShot', 'scheduleAfterShot', 'runAfterShot', 'resumeAfterShotJobs'
];

function harness({ settings = {}, shots = ['after_1.png'] } = {}) {
  const files = {};
  const events = [];
  const info = [];
  const timers = new Map();
  let timerSeq = 0;
  const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
  class FakeDate extends Date { static now() { return clock.t; } }
  const fakeFs = {
    readFileSync: p => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p]; },
    writeFileSync: (p, data) => { files[p] = data; }
  };
  let ids = 0;
  const main = loadMain(NAMES, {
    fs: fakeFs,
    path: nodePath,
    captureRoot: () => 'root',
    ensureCaptureRoot: () => {},
    readCaptureSettings: () => ({
      screenshotMode: 'windows', afterShotEnabled: true, afterShotMinutes: 15, afterShotMax: 3, ...settings
    }),
    takeScreenshots: async () => shots,
    appendCaptureEvent: (payload, source) => { events.push({ ...payload, source }); },
    crypto: { randomUUID: () => 'job-' + (++ids) },
    logInfo: (context, message) => info.push(message),
    logError: () => {},
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    Date: FakeDate
  });
  return { main, files, events, info, timers, clock };
}

test('pravidla oken: jen zapnutá, bez prázdných, bez ohledu na velikost písmen', () => {
  const { main } = harness();
  const rules = main.captureWindowRules({ screenshotWindows: [
    { match: ' Chart - ', enabled: true }, { match: 'SuperDOM', enabled: false }, { match: '  ' }, null, { match: 'Control Center' }
  ] });
  assert.deepEqual(Array.from(rules), ['chart -', 'control center']);
});

test('výběr oken: fotí se jen okna, jejichž název obsahuje pravidlo', () => {
  const { main } = harness();
  const sources = [
    { id: 'a', name: 'Chart - MES 12-26' }, { id: 'b', name: 'Slack | general' },
    { id: 'c', name: 'Control Center' }, { id: 'd', name: '' }
  ];
  const picked = main.pickCaptureWindows(sources, ['chart -', 'control center']);
  assert.deepEqual(picked.map(s => s.id), ['a', 'c']);
});

test('nastavení: pravidla se čistí od duplicit, minuty a počet se ořežou do mezí', () => {
  const { main } = harness();
  const next = main.normalizeScreenshotSettings({
    screenshotMode: 'neexistuje', screenshotMissing: 'x',
    screenshotWindows: [{ match: 'Chart' }, { match: 'chart' }, { match: '' }, { match: 'DOM', enabled: false }],
    afterShotMinutes: 9999, afterShotMax: 0
  }, { afterShotMinutes: 15, afterShotMax: 3 });
  assert.equal(next.screenshotMode, 'primary');
  assert.equal(next.screenshotMissing, 'skip');
  assert.deepEqual(JSON.parse(JSON.stringify(next.screenshotWindows)), [{ match: 'Chart', enabled: true }, { match: 'DOM', enabled: false }]);
  assert.equal(next.afterShotMinutes, 240);
  assert.equal(next.afterShotMax, 1);
});

test('po obchodu: job se naplánuje za N minut a uloží do fronty', () => {
  const h = harness({ settings: { afterShotMinutes: 20 } });
  const job = h.main.scheduleAfterShot({ positionId: 'pos-1', account: 'ACC', instrument: 'MES', source: 'ninjatrader' });
  assert.equal(job.dueAt, h.clock.t + 20 * 60000);
  assert.equal(h.main.readAfterShotJobs().length, 1);
  assert.equal([...h.timers.values()][0].ms, 20 * 60000);
});

test('po obchodu: vypnuto nebo bez positionId se nic neplánuje', () => {
  assert.equal(harness({ settings: { afterShotEnabled: false } }).main.scheduleAfterShot({ positionId: 'p' }), null);
  assert.equal(harness({ settings: { screenshotMode: 'none' } }).main.scheduleAfterShot({ positionId: 'p' }), null);
  assert.equal(harness().main.scheduleAfterShot({ positionId: '' }), null);
});

test('po obchodu: splatný job vyfotí, vyhodí se z fronty a vyšle událost s positionId', async () => {
  const h = harness({ shots: ['a.png', 'b.png', 'c.png', 'd.png'] });
  const job = h.main.scheduleAfterShot({ positionId: 'pos-9', account: 'ACC', instrument: 'MES', source: 'ctrader' });
  await h.main.runAfterShot(job.id);
  assert.equal(h.main.readAfterShotJobs().length, 0);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, 'trade_after_screenshot');
  assert.equal(h.events[0].positionId, 'pos-9');
  assert.equal(h.events[0].source, 'ctrader');
  assert.deepEqual(Array.from(h.events[0].screenshotPaths), ['a.png', 'b.png', 'c.png']); // limit afterShotMax
});

test('po obchodu: bez pořízeného snímku se událost nevyšle', async () => {
  const h = harness({ shots: [] });
  const job = h.main.scheduleAfterShot({ positionId: 'pos-1' });
  await h.main.runAfterShot(job.id);
  assert.equal(h.events.length, 0);
});

test('po restartu: splatné se naplánují hned, příliš staré se zahodí', () => {
  const h = harness();
  const fresh = h.main.scheduleAfterShot({ positionId: 'fresh' });
  const stale = h.main.scheduleAfterShot({ positionId: 'stale' });
  h.timers.clear();
  // „fresh“ měl být splatný před 5 min, „stale“ před 3 hodinami (limit 2×15, min. 10 min).
  const jobs = h.main.readAfterShotJobs();
  jobs.find(j => j.id === fresh.id).dueAt = h.clock.t - 5 * 60000;
  jobs.find(j => j.id === stale.id).dueAt = h.clock.t - 180 * 60000;
  h.main.writeAfterShotJobs(jobs);
  h.main.resumeAfterShotJobs();
  assert.deepEqual(Array.from(h.main.readAfterShotJobs(), j => j.positionId), ['fresh']);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 0);
});
