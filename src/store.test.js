import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLocalStore, createStore } from './store.js';

const HOUR = 3600_000;

test('local store: dedup window, per-person max score, restart survives', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'viralense-')), 'data.json');
  let t = Date.parse('2026-09-26T12:00:00Z');
  const store = createLocalStore(file, { now: () => t });

  assert.equal(await store.hasRecentRiskEvent('u1', 12), false);
  await store.insertRiskEvent({ userHash: 'u1', lat: 45.423, lng: -75.683, score: 4, source: 'vitals' });
  assert.equal(await store.hasRecentRiskEvent('u1', 12), true);

  t += 13 * HOUR;
  assert.equal(await store.hasRecentRiskEvent('u1', 12), false);
  await store.insertRiskEvent({ userHash: 'u1', lat: 45.423, lng: -75.683, score: 6, source: 'vitals' });

  const rows = await store.riskRows(7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 6);

  await store.flush();
  assert.ok(existsSync(file));
  const reopened = createLocalStore(file, { now: () => t });
  assert.equal((await reopened.riskRows(7)).length, 1);
});

test('local store: sensor rows are summed per device inside the window', async () => {
  let t = Date.parse('2026-09-26T12:00:00Z');
  const store = createLocalStore(null, { now: () => t });
  await store.insertSensorEvent({ deviceId: 'laptop-1', lat: 45.42, lng: -75.68, windowSec: 30, coughs: 2, sneezes: 1, footTraffic: 0, time: t - 30 * HOUR });
  await store.insertSensorEvent({ deviceId: 'laptop-1', lat: 45.42, lng: -75.68, windowSec: 30, coughs: 3, sneezes: 0, footTraffic: 0 });
  await store.insertSensorEvent({ deviceId: 'laptop-1', lat: 45.42, lng: -75.68, windowSec: 30, coughs: 1, sneezes: 2, footTraffic: 0 });
  const rows = await store.sensorRows(24);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coughs, 4);
  assert.equal(rows[0].sneezes, 2);
});

test('local store: clearSeeded only removes demo rows', async () => {
  const store = createLocalStore(null);
  await store.insertRiskEvent({ userHash: 'seed-1', lat: 1, lng: 1, score: 5, source: 'vitals' });
  await store.insertRiskEvent({ userHash: 'real', lat: 1, lng: 1, score: 5, source: 'vitals' });
  await store.clearSeeded();
  const rows = await store.riskRows(7);
  assert.deepEqual(rows.map(r => r.userHash), ['real']);
});

test('createStore uses the local file when no database URL is set', async () => {
  const store = await createStore({ LOCAL_DATA_FILE: join(mkdtempSync(join(tmpdir(), 'viralense-')), 'd.json') });
  assert.equal(store.kind, 'local');
  const placeholder = await createStore({ TIGER_DATABASE_URL: 'postgres://tsdbadmin:YOUR_PASSWORD@host:1/tsdb' });
  assert.equal(placeholder.kind, 'local');
});

test('createStore falls back to the local file when Tiger Data is unreachable', async () => {
  const store = await createStore({
    TIGER_DATABASE_URL: 'postgres://tsdbadmin:wrong@127.0.0.1:1/tsdb',
    LOCAL_DATA_FILE: join(mkdtempSync(join(tmpdir(), 'viralense-')), 'd.json'),
  });
  assert.equal(store.kind, 'local');
});
