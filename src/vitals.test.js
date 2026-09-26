import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/vitals.js';
const { estimate } = globalThis.ViralenseVitals;

// Deterministic noise
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;

function synth({ bpm, rpm, secs = 30, fps = 28, pulseAmp = 0.004, noise = 0.004, drift = 0.03 }) {
  const out = [];
  let t = 0;
  while (t < secs) {
    const beat   = Math.sin(2 * Math.PI * (bpm / 60) * t);
    const breath = Math.sin(2 * Math.PI * (rpm / 60) * t);
    const light  = 1 + drift * (t / secs);             // slow lighting drift
    // Blood volume changes green the most, then blue/red slightly (skin model)
    out.push({
      t,
      r: 180 * light * (1 + 0.33 * pulseAmp * beat + noise * rnd()),
      g: 130 * light * (1 + 1.00 * pulseAmp * beat + noise * rnd()),
      b: 110 * light * (1 + 0.50 * pulseAmp * beat + noise * rnd()),
      body: 90 * light * (1 + 0.01 * breath + 0.004 * rnd()),
    });
    t += 1 / fps + (rnd() * 0.008);                   // uneven frame timing
  }
  return out;
}

for (const [bpm, rpm] of [[62, 12], [78, 16], [110, 26]]) {
  test(`recovers ${bpm} bpm / ${rpm} rpm from a noisy webcam-like signal`, () => {
    const est = estimate(synth({ bpm, rpm }));
    assert.ok(Math.abs(est.pulseRate - bpm) <= 3, `pulse ${est.pulseRate}`);
    assert.ok(Math.abs(est.breathingRate - rpm) <= 2, `breathing ${est.breathingRate}`);
    assert.ok(est.pulseConf > 0.7, `pulse confidence ${est.pulseConf}`);
  });
}

test('pure noise gives low pulse confidence', () => {
  const est = estimate(synth({ bpm: 70, rpm: 14, pulseAmp: 0 }));
  assert.ok(est.pulseConf < 0.5, `confidence ${est.pulseConf}`);
});

test('too short a recording returns nothing', () => {
  assert.equal(estimate(synth({ bpm: 70, rpm: 14, secs: 3 })), null);
});
