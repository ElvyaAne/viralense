import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateZones, zoneIndex, cellKey, ZONE_DEFAULTS } from './zones.js';

const T = '2026-09-26T12:00:00Z';

test('cellKey groups nearby points into the same ~500 m zone', () => {
  assert.equal(cellKey(45.4231, -75.6841, 0.005), cellKey(45.4240, -75.6860, 0.005));
  assert.notEqual(cellKey(45.4231, -75.6831, 0.005), cellKey(45.4300, -75.6831, 0.005));
});

test('empty zone has index 0', () => {
  const r = zoneIndex({ people: 0, avgScore: null, coughs: 0, sneezes: 0, footTraffic: 0, hasSensor: false });
  assert.equal(r.index, 0);
  assert.equal(r.level, 'none');
});

test('5+ sick people with high scores is high risk even without a sensor', () => {
  const r = zoneIndex({ people: 5, avgScore: 8, coughs: 0, sneezes: 0, footTraffic: 0, hasSensor: false });
  assert.equal(r.index, 65);
  assert.equal(r.level, 'high');
});

test('acoustic signal is normalized by foot traffic', () => {
  const busy  = zoneIndex({ people: 0, avgScore: null, coughs: 10, sneezes: 0, footTraffic: 500, hasSensor: true });
  const quiet = zoneIndex({ people: 0, avgScore: null, coughs: 10, sneezes: 0, footTraffic: 50,  hasSensor: true });
  assert.ok(quiet.index > busy.index, 'same coughs in fewer people should be riskier');
  assert.equal(quiet.index, 35); // rate 0.2 saturates the acoustic signal
});

test('low traffic floor stops a single cough from maxing out the zone', () => {
  const r = zoneIndex({ people: 0, avgScore: null, coughs: 1, sneezes: 0, footTraffic: 1, hasSensor: true });
  assert.equal(r.acousticRate, 1 / ZONE_DEFAULTS.MIN_TRAFFIC_FLOOR);
  assert.ok(r.index < 15);
});

test('aggregateZones counts each person once per zone and keeps their max score', () => {
  const zones = aggregateZones([
    { lat: 45.423, lng: -75.683, userHash: 'a', score: 4, time: T, source: 'vitals' },
    { lat: 45.424, lng: -75.684, userHash: 'a', score: 6, time: T, source: 'vitals' },
    { lat: 45.423, lng: -75.683, userHash: 'b', score: 4, time: T, source: 'self_report' },
  ], []);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].people, 2);
  assert.equal(zones[0].avgScore, 5);
  assert.deepEqual(zones[0].sources, { vitals: 1, self_report: 1 });
});

test('aggregateZones merges sensor data into the same zone as people', () => {
  const zones = aggregateZones(
    [{ lat: 45.423, lng: -75.683, userHash: 'a', score: 4, time: T, source: 'vitals' }],
    [{ deviceId: 'pi-1', lat: 45.4232, lng: -75.6829, coughs: 8, sneezes: 2, footTraffic: 40, lastSeen: T }],
  );
  assert.equal(zones.length, 1);
  assert.equal(zones[0].devices, 1);
  assert.equal(zones[0].coughs, 8);
  assert.ok(zones[0].signals.acoustic > 0);
  assert.ok(zones[0].signals.people > 0);
});

test('zones under the privacy threshold hide people but still show sensors', () => {
  const zones = aggregateZones(
    [
      { lat: 45.423, lng: -75.683, userHash: 'a', score: 6, time: T, source: 'vitals' },
      { lat: 45.500, lng: -75.700, userHash: 'b', score: 6, time: T, source: 'vitals' },
    ],
    [{ deviceId: 'pi-1', lat: 45.423, lng: -75.683, coughs: 5, sneezes: 0, footTraffic: 50, lastSeen: T }],
    { minPeople: 3 },
  );
  assert.equal(zones.length, 1, 'zone with only a hidden person is dropped entirely');
  assert.equal(zones[0].people, 0);
  assert.equal(zones[0].avgScore, null);
  assert.equal(zones[0].devices, 1);
});

test('zones are sorted riskiest first and carry bounds for drawing', () => {
  const zones = aggregateZones([
    { lat: 45.40, lng: -75.60, userHash: 'a', score: 4, time: T, source: 'vitals' },
    { lat: 45.45, lng: -75.65, userHash: 'b', score: 7, time: T, source: 'vitals' },
    { lat: 45.45, lng: -75.65, userHash: 'c', score: 7, time: T, source: 'vitals' },
  ], []);
  assert.equal(zones[0].people, 2);
  assert.ok(zones[0].index >= zones[1].index);
  const [[s, w], [n, e]] = zones[0].bounds;
  assert.ok(s < zones[0].lat && zones[0].lat < n && w < zones[0].lng && zones[0].lng < e);
});

test('mic dot colour follows recent coughs + sneezes', async () => {
  const { micLevel } = await import('./zones.js');
  assert.equal(micLevel(0), 'green');
  assert.equal(micLevel(2), 'green');
  assert.equal(micLevel(3), 'yellow');
  assert.equal(micLevel(7), 'yellow');
  assert.equal(micLevel(8), 'red');
  assert.equal(micLevel(5, { YELLOW_AT: 10, RED_AT: 20 }), 'green');
});
