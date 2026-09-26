import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createHash } from 'crypto';
import { createStore } from './src/store.js';
import { scoreReading } from './src/score.js';
import { validateSymptomReport, scoreSymptoms, SYMPTOM_LABELS } from './src/symptoms.js';
import { validateSensorEvent } from './src/sensors.js';
import { aggregateZones, ZONE_DEFAULTS } from './src/zones.js';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT          = Number(process.env.PORT ?? 3000);
const CELL_DEG      = Number(process.env.ZONE_CELL_DEG ?? ZONE_DEFAULTS.CELL_DEG);
const MIN_PEOPLE    = Number(process.env.MIN_PEOPLE_PER_ZONE ?? 1);
const VITALS_DAYS   = Number(process.env.VITALS_WINDOW_DAYS ?? 7);
const SENSOR_HOURS  = Number(process.env.SENSOR_WINDOW_HOURS ?? 24);
const DEDUP_HOURS   = 12;

const store = await createStore();
console.log(`Storing data in: ${store.describe}`);

// ── Express + WebSocket ───────────────────────────────────────────────────────

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ── Live webcam vitals (optional) ─────────────────────────────────────────────
// The SmartSpectra SDK reads the webcam attached to the machine running this
// server. On a cloud host (Vultr) there is no webcam, so the app runs in
// "self-report + mic" mode instead of crashing.

let latestStatus = 'Camera offline — self-report mode';
let vitalsEnabled = false;
let sdk = null;

async function startVitals() {
  const apiKey = process.env.SMARTSPECTRA_API_KEY;
  if (!apiKey || process.env.DISABLE_CAMERA === '1') {
    console.log('Webcam vitals disabled (no SMARTSPECTRA_API_KEY or DISABLE_CAMERA=1). Running in self-report + mic mode.');
    return;
  }

  let S, sharp;
  try {
    S     = await import('@smartspectra/node-sdk');
    sharp = (await import('sharp')).default;
  } catch (e) {
    console.warn('Could not load SmartSpectra SDK / sharp — running without webcam vitals:', e.message);
    return;
  }

  const {
    SmartSpectraSDK, breathingMetrics, cardioMetrics, faceMetrics, edaMetrics,
    decodeMetrics, ProcessingStatus, ValidationCode, PixelFormat,
  } = S;

  sdk = new SmartSpectraSDK({
    apiKey,
    requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...faceMetrics, ...edaMetrics],
  });

  const EXPRESSION_NAMES        = ['unspecified','angry','contempt','disgust','fear','happy','neutral','sad','surprise'];
  const PROCESSING_STATUS_NAMES = Object.fromEntries(Object.entries(ProcessingStatus ?? {}).map(([k,v]) => [v,k]));
  const VALIDATION_CODE_NAMES   = Object.fromEntries(Object.entries(ValidationCode   ?? {}).map(([k,v]) => [v,k]));

  sdk.on('processingStatus', (status) => {
    const name = PROCESSING_STATUS_NAMES[status] ?? status;
    latestStatus = name;
    console.log(`\n[processingStatus] ${name}`);
    broadcast({ type: 'status', status: name, vitals: true });
  });

  sdk.on('validationStatus', (code, _ts, hint) => {
    const name = VALIDATION_CODE_NAMES[code] ?? code;
    console.log(`\n[validationStatus] ${name} — hint: "${hint}"`);
    broadcast({ type: 'validation', code: name, hint });
  });

  let metricsCount = 0;

  sdk.on('metrics', (buf) => {
    const d = decodeMetrics(buf);
    if (Buffer.isBuffer(d)) return;
    metricsCount++;

    const pr    = d.cardio?.pulseRate?.at(-1);
    const apt   = d.cardio?.arterialPressureTrace?.at(-1);
    const hrv   = d.cardio?.hrv?.at(-1);
    const br    = d.breathing?.rate?.at(-1);
    const amp   = d.breathing?.amplitude?.at(-1);
    const ier   = d.breathing?.inhaleExhaleRatio?.at(-1);
    const apnea = d.breathing?.apnea?.at(-1);
    const blink = d.face?.blinking?.at(-1);
    const talk  = d.face?.talking?.at(-1);
    const expr  = d.face?.expression?.at(-1);
    const eda   = d.eda?.trace?.at(-1);

    let dominantExpression = null;
    if (expr?.scores?.length) {
      const top = [...expr.scores].sort((a,b) => b.confidence - a.confidence)[0];
      dominantExpression = { name: EXPRESSION_NAMES[top.type] ?? 'unknown', confidence: top.confidence };
    }

    const aptSamples   = d.cardio?.arterialPressureTrace ?? [];
    const upperSamples = d.breathing?.upperTrace ?? [];
    const traceWindow  = aptSamples.length
      ? aptSamples.slice(-60).map(s => s.value)
      : upperSamples.slice(-60).map(s => s.value);
    const traceLabel = aptSamples.length ? 'arterial-pressure' : 'chest-movement';

    const line = [
      pr  ? `pulse=${pr.value.toFixed(1)}bpm(${pr.confidence.toFixed(0)}%)`  : 'pulse=--',
      hrv ? `rmssd=${hrv.rmssd.toFixed(1)}`                                   : 'rmssd=--',
      br  ? `breath=${br.value.toFixed(1)}rpm(${br.confidence.toFixed(0)}%)` : 'breath=--',
    ].join('  ');
    process.stdout.write(`\r[#${String(metricsCount).padStart(4)}] ${line}   `);

    broadcast({
      type: 'metrics',
      ts: Date.now(),
      cardio: {
        pulseRate:             pr  ? { value: pr.value,  confidence: pr.confidence,  stable: pr.stable  } : null,
        arterialPressureTrace: apt ? { value: apt.value }                                                   : null,
        hrv: hrv ? { rmssd: hrv.rmssd, sdnn: hrv.sdnn, baevsky: hrv.baevsky, meanNn: hrv.meanNn,
                     confidence: hrv.confidence, stable: hrv.stable } : null,
      },
      breathing: {
        rate:              br    ? { value: br.value,    confidence: br.confidence, stable: br.stable } : null,
        amplitude:         amp   ? { value: amp.value }                                                  : null,
        inhaleExhaleRatio: ier   ? { value: ier.value }                                                  : null,
        apnea:             apnea ? { detected: apnea.detected }                                          : null,
      },
      face: {
        blinking:   blink ? { detected: blink.detected } : null,
        talking:    talk  ? { detected: talk.detected  } : null,
        expression: dominantExpression,
      },
      eda: eda ? { value: eda.value } : null,
      traceWindow,
      traceLabel,
    });
  });

  sdk.on('error', (code, message, retryable) => {
    console.error(`\nSDK error [${code}]: ${message} (retryable=${retryable})`);
    broadcast({ type: 'error', code, message, retryable });
  });

  let lastFrameMs = 0;
  sdk.on('videoOutput', async (buf, width, height, _stride, pixelFormat) => {
    const now = Date.now();
    if (now - lastFrameMs < 100) return; // 10 fps cap
    lastFrameMs = now;

    const fmtMap = {
      [PixelFormat.kRGB]:  { channels: 3 },
      [PixelFormat.kBGR]:  { channels: 3, swap: true },
      [PixelFormat.kRGBA]: { channels: 4 },
      [PixelFormat.kBGRA]: { channels: 4, swap: true },
    };
    const fmt = fmtMap[pixelFormat] ?? { channels: 3 };

    try {
      let s = sharp(buf, { raw: { width, height, channels: fmt.channels } });
      if (fmt.swap) s = s.toColorspace('srgb');
      const jpeg = await s.jpeg({ quality: 70 }).toBuffer();
      broadcast({ type: 'frame', data: jpeg.toString('base64') });
    } catch { /* skip frame on conversion error */ }
  });

  sdk.useCamera({ fps: 30, width: 1280, height: 720 });
  sdk.start();
  vitalsEnabled = true;
  latestStatus  = 'Initializing...';
  console.log('SmartSpectra SDK started — measuring from webcam.');
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', status: latestStatus, vitals: vitalsEnabled }));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashUser(userId) {
  const salt = process.env.HASH_SALT ?? '';
  return createHash('sha256').update(userId + salt).digest('hex');
}

// Round to ~100 m before storing so exact home locations never hit the DB.
const roundCoord = (x) => Math.round(x * 1000) / 1000;

function validateReading(body) {
  const { userId, lat, lng, pulseRate, breathingRate, confidence, durationSec,
          exercisedRecently, symptoms } = body ?? {};
  if (!userId || typeof userId !== 'string')
    return 'userId must be a non-empty string';
  if (typeof lat !== 'number' || lat < -90 || lat > 90)
    return 'lat must be a number in [-90, 90]';
  if (typeof lng !== 'number' || lng < -180 || lng > 180)
    return 'lng must be a number in [-180, 180]';
  if (typeof pulseRate !== 'number' || pulseRate <= 0)
    return 'pulseRate must be a positive number';
  if (typeof breathingRate !== 'number' || breathingRate <= 0)
    return 'breathingRate must be a positive number';
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1)
    return 'confidence must be a number in [0, 1]';
  if (typeof durationSec !== 'number' || durationSec < 0)
    return 'durationSec must be a non-negative number';
  if (typeof exercisedRecently !== 'boolean')
    return 'exercisedRecently must be a boolean';
  if (typeof symptoms !== 'boolean')
    return 'symptoms must be a boolean';
  return null;
}

// Stores one risk event per person per DEDUP_HOURS. Returns true if a row was written.
async function storeRiskEvent({ userId, lat, lng, score, pulseRate = null, breathingRate = null, hrvMs = null, source }) {
  const userHash = hashUser(userId);
  if (await store.hasRecentRiskEvent(userHash, DEDUP_HOURS)) return false;
  await store.insertRiskEvent({
    userHash, lat: roundCoord(lat), lng: roundCoord(lng), score,
    pulseRate, breathingRate, hrvMs, source,
  });
  broadcast({ type: 'zones-updated' });
  return true;
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  let db = false;
  try { db = await store.ping(); } catch { /* db down */ }
  res.json({ ok: true, db, storage: store.kind, vitals: vitalsEnabled });
});

// Webcam vitals reading (from the SmartSpectra measurement)
app.post('/readings', async (req, res) => {
  const validErr = validateReading(req.body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { userId, lat, lng, pulseRate, breathingRate, confidence, durationSec,
          exercisedRecently, symptoms, hrvMs, baselinePulse } = req.body;

  const result = scoreReading({
    pulseRate, breathingRate, confidence, durationSec,
    exercisedRecently, symptoms,
    hrvMs:         hrvMs        ?? null,
    baselinePulse: baselinePulse ?? null,
  });

  if (!result.highRisk) {
    return res.json({ highRisk: false, stored: false, score: result.score, reasons: result.reasons });
  }

  try {
    const stored = await storeRiskEvent({
      userId, lat, lng, score: result.score,
      pulseRate, breathingRate, hrvMs: hrvMs ?? null, source: 'vitals',
    });
    return res.json({ highRisk: true, stored, score: result.score, reasons: result.reasons });
  } catch (e) {
    console.error('[db] insert error:', e.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Symptom checklist — works on any phone, no camera needed
app.get('/symptoms', (_req, res) => {
  res.json(Object.entries(SYMPTOM_LABELS).map(([id, label]) => ({ id, label })));
});

app.post('/symptom-reports', async (req, res) => {
  const validErr = validateSymptomReport(req.body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { userId, lat, lng, symptoms } = req.body;
  const result = scoreSymptoms(symptoms);

  if (!result.store) {
    return res.json({ ...result, stored: false });
  }
  try {
    const stored = await storeRiskEvent({ userId, lat, lng, score: result.score, source: 'self_report' });
    return res.json({ ...result, stored });
  } catch (e) {
    console.error('[db] symptom insert error:', e.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Batches of cough/sneeze counts from the in-browser laptop mic listener
app.post('/sensor-events', async (req, res) => {
  const validErr = validateSensorEvent(req.body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic } = req.body;
  try {
    await store.insertSensorEvent({ deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic });
    broadcast({ type: 'zones-updated' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[db] sensor insert error:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Combined zone heatmap: vitals + self-reports + mic cough counts
app.get('/zones', async (_req, res) => {
  try {
    const [riskRows, sensorRows] = await Promise.all([store.riskRows(VITALS_DAYS), store.sensorRows(SENSOR_HOURS)]);
    const zones = aggregateZones(riskRows, sensorRows, { cellDeg: CELL_DEG, minPeople: MIN_PEOPLE });
    res.json({
      cellDeg:     CELL_DEG,
      minPeople:   MIN_PEOPLE,
      vitalsDays:  VITALS_DAYS,
      sensorHours: SENSOR_HOURS,
      zones,
      devices: sensorRows.map(s => ({
        deviceId:    s.deviceId,
        lat:         Number(s.lat),
        lng:         Number(s.lng),
        coughs:      Number(s.coughs),
        sneezes:     Number(s.sneezes),
        footTraffic: Number(s.footTraffic),
        lastSeen:    s.lastSeen,
      })),
    });
  } catch (e) {
    console.error('[db] zones error:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Original people-only endpoint, kept for anything already using it
app.get('/risk-areas', async (_req, res) => {
  try {
    const zones = aggregateZones(await store.riskRows(VITALS_DAYS), [], { cellDeg: CELL_DEG, minPeople: MIN_PEOPLE });
    res.json(zones.map(z => ({ lat: z.lat, lng: z.lng, people: z.people, avgScore: z.avgScore, lastSeen: z.lastSeen })));
  } catch (e) {
    console.error('[db] risk-areas error:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

await startVitals();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is Viralense already running in another window? Close it, or set PORT=3001 in .env.`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, () => console.log(`\nViralense running at http://localhost:${PORT}  ← open this in Chrome or Edge`));

process.on('uncaughtException', (err) => {
  console.error('\n[crash] Uncaught exception:', err.message);
  if (vitalsEnabled) console.error('[crash] This is usually a native SDK frame-size mismatch. Restart the server.');
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\nStopping...');
  await store.flush().catch(() => {});
  if (sdk) {
    await sdk.stopAsync();
    await sdk.destroy();
  }
  process.exit(0);
});
