CREATE EXTENSION IF NOT EXISTS postgis;

-- Hypertable via Tiger Data (TimescaleDB) declarative syntax.
-- For older TimescaleDB, swap the WITH clause for:
--   SELECT create_hypertable('risk_events', by_range('time'), if_not_exists => true);
CREATE TABLE IF NOT EXISTS risk_events (
  time           TIMESTAMPTZ            NOT NULL DEFAULT now(),
  user_hash      TEXT                   NOT NULL,
  location       GEOGRAPHY(POINT, 4326) NOT NULL,
  score          SMALLINT               NOT NULL,
  pulse_rate     REAL,
  breathing_rate REAL,
  hrv_ms         REAL
) WITH (tsdb.hypertable);

-- 'vitals' = webcam reading, 'self_report' = symptom checklist only
ALTER TABLE risk_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'vitals';

CREATE INDEX IF NOT EXISTS risk_events_location_gist
  ON risk_events USING GIST (location);

CREATE INDEX IF NOT EXISTS risk_events_user_time
  ON risk_events (user_hash, time DESC);

SELECT add_retention_policy('risk_events', INTERVAL '14 days', if_not_exists => true);

-- One row per batch from a Raspberry Pi room sensor (mic + IR foot-traffic counter).
-- Devices sit at a fixed spot, so plain lat/lng is enough here.
CREATE TABLE IF NOT EXISTS sensor_events (
  time         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  device_id    TEXT             NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  window_sec   REAL             NOT NULL,
  coughs       INTEGER          NOT NULL DEFAULT 0,
  sneezes      INTEGER          NOT NULL DEFAULT 0,
  foot_traffic INTEGER          NOT NULL DEFAULT 0
) WITH (tsdb.hypertable);

CREATE INDEX IF NOT EXISTS sensor_events_device_time
  ON sensor_events (device_id, time DESC);

SELECT add_retention_policy('sensor_events', INTERVAL '14 days', if_not_exists => true);
