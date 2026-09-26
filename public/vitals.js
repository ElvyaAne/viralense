// Webcam vitals estimation that runs entirely in the browser.
//
// Pulse:     remote photoplethysmography (rPPG). Each heartbeat changes skin
//            colour very slightly; we average the face pixels every frame and
//            use the POS method (Wang et al., 2017) to pull the pulse out of
//            the red/green/blue signal, then find the dominant frequency.
// Breathing: breathing moves the shoulders/chest and changes the brightness
//            below the face slightly; we find the dominant slow frequency.
//
// Prototype-grade: works best with steady light on the face and holding still.
(function (root) {
  'use strict';

  const FS = 30; // resample everything to 30 samples/second

  // Linear-interpolate irregular camera samples onto a uniform grid
  function resample(ts, xs, fs = FS) {
    const n = Math.floor((ts[ts.length - 1] - ts[0]) * fs);
    const out = new Float64Array(Math.max(n, 0));
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = ts[0] + i / fs;
      while (j < ts.length - 2 && ts[j + 1] < t) j++;
      const span = ts[j + 1] - ts[j] || 1;
      const a = Math.max(0, Math.min(1, (t - ts[j]) / span));
      out[i] = xs[j] + (xs[j + 1] - xs[j]) * a;
    }
    return out;
  }

  // Remove slow drift (lighting changes, auto-exposure) with a moving average
  function detrend(x, winSamples) {
    const n = x.length, out = new Float64Array(n);
    const half = Math.max(1, Math.floor(winSamples / 2));
    let sum = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
      while (hi < b) sum += x[++hi];
      while (lo < a) sum -= x[lo++];
      out[i] = x[i] - sum / (hi - lo + 1);
    }
    return out;
  }

  const mean = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i]; return s / (b - a); };
  const std  = (x) => { const m = mean(x); let s = 0; for (let i = 0; i < x.length; i++) s += (x[i] - m) ** 2; return Math.sqrt(s / x.length); };

  // POS: Plane-Orthogonal-to-Skin projection with overlap-add
  function pos(r, g, b, fs = FS) {
    const n = r.length, L = Math.round(1.6 * fs);
    const H = new Float64Array(n);
    const s1 = new Float64Array(L), s2 = new Float64Array(L);
    for (let t = 0; t + L <= n; t++) {
      const mr = mean(r, t, t + L) || 1, mg = mean(g, t, t + L) || 1, mb = mean(b, t, t + L) || 1;
      for (let k = 0; k < L; k++) {
        const cr = r[t + k] / mr, cg = g[t + k] / mg, cb = b[t + k] / mb;
        s1[k] = cg - cb;
        s2[k] = cg + cb - 2 * cr;
      }
      const alpha = std(s1) / (std(s2) || 1);
      let hm = 0;
      const h = new Float64Array(L);
      for (let k = 0; k < L; k++) { h[k] = s1[k] + alpha * s2[k]; hm += h[k]; }
      hm /= L;
      for (let k = 0; k < L; k++) H[t + k] += h[k] - hm;
    }
    return H;
  }

  // Power spectrum over a band (Hann window, direct DFT at fine resolution).
  // Returns the peak frequency and how much of the band's power sits at the
  // peak (0–1), which we use as a quality score.
  function bandPeak(x, fs, fmin, fmax, step = 0.01, peakHalfWidth = 0.08) {
    const n = x.length;
    if (n < fs * 4) return { freq: null, snr: 0 };
    const w = new Float64Array(n);
    const m = mean(x);
    for (let i = 0; i < n; i++) w[i] = (x[i] - m) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));

    const freqs = [], power = [];
    for (let f = fmin; f <= fmax + 1e-9; f += step) {
      const wstep = 2 * Math.PI * f / fs;
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) { re += w[i] * Math.cos(wstep * i); im -= w[i] * Math.sin(wstep * i); }
      freqs.push(f); power.push(re * re + im * im);
    }
    let best = 0;
    for (let i = 1; i < power.length; i++) if (power[i] > power[best]) best = i;
    let total = 0, peak = 0;
    for (let i = 0; i < power.length; i++) {
      total += power[i];
      if (Math.abs(freqs[i] - freqs[best]) <= peakHalfWidth) peak += power[i];
    }
    return { freq: freqs[best], snr: total ? peak / total : 0 };
  }

  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  // samples: [{ t (seconds), r, g, b, body }] — means of the face box (r,g,b)
  // and brightness of the area below the face (body), one per video frame.
  function estimate(samples) {
    if (samples.length < 2) return null;
    const ts = samples.map(s => s.t);
    const dur = ts[ts.length - 1] - ts[0];
    if (dur < 6) return null;

    const r = resample(ts, samples.map(s => s.r));
    const g = resample(ts, samples.map(s => s.g));
    const b = resample(ts, samples.map(s => s.b));
    const body = resample(ts, samples.map(s => s.body));

    // Pulse: 45–180 bpm
    const pulseSig = detrend(pos(r, g, b), FS * 2);
    const p = bandPeak(pulseSig, FS, 0.75, 3.0);

    // Breathing: 8–36 breaths/min; needs a longer recording to be meaningful
    let br = { freq: null, snr: 0 };
    if (dur >= 15) {
      const bodySig = detrend(body, FS * 12);
      br = bandPeak(bodySig, FS, 0.13, 0.6, 0.005, 0.03);
    }

    return {
      durationSec:   dur,
      pulseRate:     p.freq ? p.freq * 60 : null,
      pulseConf:     clamp01((p.snr - 0.12) / 0.4),
      breathingRate: br.freq ? br.freq * 60 : null,
      breathConf:    clamp01((br.snr - 0.2) / 0.4),
    };
  }

  root.ViralenseVitals = { estimate, _internal: { resample, detrend, pos, bandPeak } };
})(typeof window !== 'undefined' ? window : globalThis);
