// Storage for Viralense. Two interchangeable backends:
//   * Tiger Data / TimescaleDB (when TIGER_DATABASE_URL is set)
//   * A local JSON file (data/viralense-data.json) when it isn't, so the app
//     works on a laptop with zero setup.
// Both expose the same methods, so server.mjs doesn't care which one it has.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { dirname } from 'path';

const HOUR = 3600_000;
const DAY  = 24 * HOUR;
const RETENTION_MS = 14 * DAY;

// ── Local JSON file ───────────────────────────────────────────────────────────

export function createLocalStore(file = 'data/viralense-data.json', { now = () => Date.now() } = {}) {
  let data = { riskEvents: [], sensorEvents: [] };
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      data.riskEvents   = parsed.riskEvents   ?? [];
      data.sensorEvents = parsed.sensorEvents ?? [];
    } catch (e) {
      console.warn(`[store] Could not read ${file} (${e.message}) — starting empty.`);
    }
  }

  let saveTimer = null;
  const save = () => {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify(data));
        renameSync(file + '.tmp', file); // atomic-ish: never leaves a half-written file
      } catch (e) {
        console.error('[store] save failed:', e.message);
      }
    }, 200);
  };

  const prune = () => {
    const cutoff = now() - RETENTION_MS;
    data.riskEvents   = data.riskEvents.filter(e => e.time >= cutoff);
    data.sensorEvents = data.sensorEvents.filter(e => e.time >= cutoff);
  };

  return {
    kind: 'local',
    describe: `local file ${file}`,
    async ping() { return true; },

    async hasRecentRiskEvent(userHash, hours) {
      const cutoff = now() - hours * HOUR;
      return data.riskEvents.some(e => e.userHash === userHash && e.time > cutoff);
    },

    async insertRiskEvent({ userHash, lat, lng, score, pulseRate, breathingRate, hrvMs, source, time }) {
      prune();
      data.riskEvents.push({ time: time ?? now(), userHash, lat, lng, score,
                             pulseRate, breathingRate, hrvMs, source });
      save();
    },

    async insertSensorEvent({ deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic, time }) {
      prune();
      data.sensorEvents.push({ time: time ?? now(), deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic });
      save();
    },

    // One row per (point, person) with their max score — same shape as the SQL version
    async riskRows(days) {
      const cutoff = now() - days * DAY;
      const byKey = new Map();
      for (const e of data.riskEvents) {
        if (e.time <= cutoff) continue;
        const key = `${e.lat}|${e.lng}|${e.userHash}`;
        const prev = byKey.get(key);
        if (!prev) {
          byKey.set(key, { lat: e.lat, lng: e.lng, userHash: e.userHash, score: e.score,
                           time: new Date(e.time), source: e.source });
        } else {
          prev.score = Math.max(prev.score, e.score);
          if (e.time > prev.time.getTime()) prev.time = new Date(e.time);
        }
      }
      return [...byKey.values()];
    },

    // One row per device, summed over the window, at its latest location
    async sensorRows(hours) {
      const cutoff = now() - hours * HOUR;
      const byDevice = new Map();
      for (const e of data.sensorEvents) {
        if (e.time <= cutoff) continue;
        const d = byDevice.get(e.deviceId);
        if (!d) {
          byDevice.set(e.deviceId, { deviceId: e.deviceId, lat: e.lat, lng: e.lng, coughs: e.coughs,
                                     sneezes: e.sneezes, footTraffic: e.footTraffic, lastSeen: new Date(e.time) });
        } else {
          d.coughs += e.coughs; d.sneezes += e.sneezes; d.footTraffic += e.footTraffic;
          if (e.time >= d.lastSeen.getTime()) { d.lastSeen = new Date(e.time); d.lat = e.lat; d.lng = e.lng; }
        }
      }
      return [...byDevice.values()];
    },

    async clearSeeded() {
      data.riskEvents   = data.riskEvents.filter(e => !e.userHash.startsWith('seed-'));
      data.sensorEvents = data.sensorEvents.filter(e => !e.deviceId.startsWith('seed-'));
      save();
    },

    async flush() {
      if (!file) return;
      clearTimeout(saveTimer);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data));
    },
  };
}

// ── Tiger Data / TimescaleDB ──────────────────────────────────────────────────

export async function createPgStore(connectionString) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 8000 });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message)); // don't crash on network blips

  return {
    kind: 'tiger',
    describe: 'Tiger Data (TimescaleDB)',
    pool,
    async ping() { await pool.query('SELECT 1'); return true; },

    async hasRecentRiskEvent(userHash, hours) {
      const { rows } = await pool.query(
        `SELECT 1 FROM risk_events
         WHERE user_hash = $1 AND time > NOW() - make_interval(hours => $2::int)
         LIMIT 1`,
        [userHash, hours],
      );
      return rows.length > 0;
    },

    async insertRiskEvent({ userHash, lat, lng, score, pulseRate = null, breathingRate = null, hrvMs = null, source, time }) {
      await pool.query(
        `INSERT INTO risk_events (time, user_hash, location, score, pulse_rate, breathing_rate, hrv_ms, source)
         VALUES (COALESCE($9::timestamptz, NOW()), $1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography,
                 $4, $5, $6, $7, $8)`,
        [userHash, lat, lng, score, pulseRate, breathingRate, hrvMs, source,
         time ? new Date(time).toISOString() : null],
      );
    },

    async insertSensorEvent({ deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic, time }) {
      await pool.query(
        `INSERT INTO sensor_events (time, device_id, lat, lng, window_sec, coughs, sneezes, foot_traffic)
         VALUES (COALESCE($8::timestamptz, NOW()), $1, $2, $3, $4, $5, $6, $7)`,
        [deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic,
         time ? new Date(time).toISOString() : null],
      );
    },

    async riskRows(days) {
      const { rows } = await pool.query(`
        SELECT
          ST_Y(location::geometry) AS lat,
          ST_X(location::geometry) AS lng,
          user_hash                AS "userHash",
          MAX(score)               AS score,
          MAX(time)                AS time,
          MIN(source)              AS source
        FROM risk_events
        WHERE time > NOW() - make_interval(days => $1::int)
        GROUP BY ST_Y(location::geometry), ST_X(location::geometry), user_hash
      `, [days]);
      return rows;
    },

    async sensorRows(hours) {
      const { rows } = await pool.query(`
        SELECT
          device_id                              AS "deviceId",
          (array_agg(lat ORDER BY time DESC))[1] AS lat,
          (array_agg(lng ORDER BY time DESC))[1] AS lng,
          SUM(coughs)::int                       AS coughs,
          SUM(sneezes)::int                      AS sneezes,
          SUM(foot_traffic)::int                 AS "footTraffic",
          MAX(time)                              AS "lastSeen"
        FROM sensor_events
        WHERE time > NOW() - make_interval(secs => $1::double precision)
        GROUP BY device_id
      `, [hours * 3600]);
      return rows;
    },

    async clearSeeded() {
      await pool.query(`DELETE FROM risk_events   WHERE user_hash LIKE 'seed-%'`);
      await pool.query(`DELETE FROM sensor_events WHERE device_id LIKE 'seed-%'`);
    },

    async flush() { await pool.end(); },
  };
}

// Picks the backend from the environment. If the Tiger Data connection fails
// (wrong password, no internet), it falls back to the local file instead of
// taking the whole app down.
export async function createStore(env = process.env) {
  const url = env.TIGER_DATABASE_URL;
  const localFile = env.LOCAL_DATA_FILE || 'data/viralense-data.json';
  if (!url || url.includes('YOUR_PASSWORD')) return createLocalStore(localFile);

  let store;
  try {
    store = await createPgStore(url);
    await Promise.race([
      store.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 8 s')), 8000)),
    ]);
    return store;
  } catch (e) {
    console.warn(`[store] Could not connect to Tiger Data (${e.message}). Using the local file instead.`);
    store?.pool.end().catch(() => {});
    return createLocalStore(localFile);
  }
}
