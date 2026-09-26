import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSymptoms, validateSymptomReport } from './symptoms.js';
import { validateSensorEvent, checkDeviceToken } from './sensors.js';

test('no symptoms — score 0, not stored', () => {
  const r = scoreSymptoms([]);
  assert.equal(r.score, 0);
  assert.equal(r.store, false);
  assert.equal(r.highRisk, false);
});

test('fever + cough + sore throat — high risk and stored', () => {
  const r = scoreSymptoms(['fever', 'cough', 'sore_throat']);
  assert.equal(r.score, 4);
  assert.equal(r.store, true);
  assert.equal(r.highRisk, true);
  assert.equal(r.reasons.length, 3);
});

test('duplicate symptoms are only counted once', () => {
  assert.equal(scoreSymptoms(['cough', 'cough', 'cough']).score, 1);
});

test('symptom report validation rejects unknown symptoms', () => {
  const base = { userId: 'u', lat: 45, lng: -75 };
  assert.equal(validateSymptomReport({ ...base, symptoms: ['cough'] }), null);
  assert.match(validateSymptomReport({ ...base, symptoms: ['zombie'] }), /unknown/);
  assert.match(validateSymptomReport({ ...base, symptoms: 'cough' }), /array/);
});

test('sensor event validation', () => {
  const ok = { deviceId: 'pi-1', lat: 45.42, lng: -75.68, windowSec: 60, coughs: 2, sneezes: 0, footTraffic: 14 };
  assert.equal(validateSensorEvent(ok), null);
  assert.match(validateSensorEvent({ ...ok, coughs: -1 }), /coughs/);
  assert.match(validateSensorEvent({ ...ok, footTraffic: 1.5 }), /footTraffic/);
  assert.match(validateSensorEvent({ ...ok, windowSec: 0 }), /windowSec/);
  assert.match(validateSensorEvent({ ...ok, deviceId: '' }), /deviceId/);
});

test('device token is only enforced when configured', () => {
  assert.equal(checkDeviceToken(undefined, ''), true);
  assert.equal(checkDeviceToken('secret', 'secret'), true);
  assert.equal(checkDeviceToken('nope', 'secret'), false);
  assert.equal(checkDeviceToken(undefined, 'secret'), false);
});
