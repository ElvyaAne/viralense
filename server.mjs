import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createHash } from 'crypto';
import { createStore } from './src/store.js';
import { validateSymptomReport, scoreSymptoms, SYMPTOM_LABELS } from './src/symptoms.js';
import { validateSensorEvent } from './src/sensors.js';
import { aggregateZones, micLevel, ZONE_DEFAULTS, MIC_LEVELS } from './src/zones.js';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT         = Number(process.env.PORT ?? 3000);
const HOST         = process.env.HOST ?? '0.0.0.0';
const CELL_DEG     = Number(process.env.ZONE_CELL_DEG ?? ZONE_DEFAULTS.CELL_DEG);
const MIN_PEOPLE   = Number(process.env.MIN_PEOPLE_PER_ZONE ?? 1);
const REPORT_DAYS  = Number(process.env.REPORT_WINDOW_DAYS ?? 7);
const SENSOR_HOURS = Number(process.env.SENSOR_WINDOW_HOURS ?? 24);
// Where the map starts, and the location used when a browser won't share one
const DEFAULT_LAT  = Number(process.env.DEFAULT_LAT ?? 45.4231);   // uOttawa
const DEFAULT_LNG  = Number(process.env.DEFAULT_LNG ?? -75.6831);
const DEDUP_HOURS  = 12;
// Mic dots: coughs + sneezes in the last MIC_WINDOW_MIN minutes decide the colour
const MIC_CFG = {
  WINDOW_MIN: Number(process.env.MIC_WINDOW_MIN ?? MIC_LEVELS.WINDOW_MIN),
  YELLOW_AT:  Number(process.env.MIC_YELLOW_AT  ?? MIC_LEVELS.YELLOW_AT),
  RED_AT:     Number(process.env.MIC_RED_AT     ?? MIC_LEVELS.RED_AT),
};

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashUser(userId) {
  const salt = process.env.HASH_SALT ?? '';
  return createHash('sha256').update(userId + salt).digest('hex');
}

// Round to ~100 m before storing so exact home locations never hit the DB.
const roundCoord = (x) => Math.round(x * 1000) / 1000;

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  let db = false;
  try { db = await store.ping(); } catch { /* db down */ }
  res.json({ ok: true, db, storage: store.kind });
});

app.get('/config', (_req, res) => {
  res.json({ defaultLat: DEFAULT_LAT, defaultLng: DEFAULT_LNG });
});

// Symptom checklist
app.get('/symptoms', (_req, res) => {
  res.json(Object.entries(SYMPTOM_LABELS).map(([id, label]) => ({ id, label })));
});

app.post('/symptom-reports', async (req, res) => {
  const validErr = validateSymptomReport(req.body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { userId, lat, lng, symptoms } = req.body;
  const result = scoreSymptoms(symptoms);
  if (!result.store) return res.json({ ...result, stored: false });

  try {
    const userHash = hashUser(userId);
    if (await store.hasRecentRiskEvent(userHash, DEDUP_HOURS)) {
      return res.json({ ...result, stored: false });
    }
    await store.insertRiskEvent({
      userHash, lat: roundCoord(lat), lng: roundCoord(lng), score: result.score, source: 'self_report',
    });
    broadcast({ type: 'zones-updated' });
    res.json({ ...result, stored: true });
  } catch (e) {
    console.error('[db] symptom insert error:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Cough/sneeze counts from the in-browser mic listener
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

// Combined zone heatmap: symptom reports + mic cough counts
app.get('/zones', async (_req, res) => {
  try {
    const [riskRows, sensorRows, recentRows] = await Promise.all([
      store.riskRows(REPORT_DAYS),
      store.sensorRows(SENSOR_HOURS),
      store.sensorRows(MIC_CFG.WINDOW_MIN / 60),
    ]);
    const zones  = aggregateZones(riskRows, sensorRows, { cellDeg: CELL_DEG, minPeople: MIN_PEOPLE });
    const recent = new Map(recentRows.map(r => [r.deviceId, r]));
    res.json({
      cellDeg:     CELL_DEG,
      minPeople:   MIN_PEOPLE,
      reportDays:  REPORT_DAYS,
      sensorHours: SENSOR_HOURS,
      mic:         { windowMin: MIC_CFG.WINDOW_MIN, yellowAt: MIC_CFG.YELLOW_AT, redAt: MIC_CFG.RED_AT },
      zones,
      devices: sensorRows.map(s => {
        const r = recent.get(s.deviceId);
        const recentCoughs  = r ? Number(r.coughs)  : 0;
        const recentSneezes = r ? Number(r.sneezes) : 0;
        return {
          deviceId: s.deviceId,
          lat:      Number(s.lat),
          lng:      Number(s.lng),
          coughs:   Number(s.coughs),
          sneezes:  Number(s.sneezes),
          recentCoughs,
          recentSneezes,
          level:    micLevel(recentCoughs + recentSneezes, MIC_CFG),
          lastSeen: s.lastSeen,
        };
      }),
    });
  } catch (e) {
    console.error('[db] zones error:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is Viralense already running in another window? Close it, or set PORT=3001 in .env.`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, HOST, () => console.log(`\nViralense running at http://localhost:${PORT}  ← open this in Chrome or Edge`));

async function shutdown() {
  console.log('\nStopping...');
  await store.flush().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown); // systemd / Docker stop
