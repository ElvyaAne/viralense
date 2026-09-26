// Combines the three signals into one risk index (0–100) per map zone:
//   1. people reporting symptoms in the zone
//   2. how severe those flags were (average score)
//   3. coughs + sneezes heard by room sensors, relative to foot traffic

export const ZONE_DEFAULTS = Object.freeze({
  CELL_DEG:           0.005, // ~500 m zones
  PEOPLE_SATURATION:  5,     // this many sick people in one zone = max "people" signal
  SCORE_SATURATION:   8,     // avg score at which severity maxes out
  ACOUSTIC_RATE_HIGH: 0.2,   // 1 cough/sneeze per 5 passers-by = max acoustic signal
  MIN_TRAFFIC_FLOOR:  20,    // avoid 1 cough / 1 visitor blowing the rate up
  WEIGHT_PEOPLE:      0.5,
  WEIGHT_SEVERITY:    0.15,
  WEIGHT_ACOUSTIC:    0.35,
  LEVEL_HIGH:         60,
  LEVEL_ELEVATED:     30,
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function cellKey(lat, lng, cellDeg) {
  return `${Math.round(lat / cellDeg)}:${Math.round(lng / cellDeg)}`;
}

export function riskLevel(index, cfg = ZONE_DEFAULTS) {
  if (index >= cfg.LEVEL_HIGH)     return 'high';
  if (index >= cfg.LEVEL_ELEVATED) return 'elevated';
  if (index > 0)                   return 'low';
  return 'none';
}

export function zoneIndex({ people, avgScore, coughs, sneezes, footTraffic, hasSensor }, cfg = ZONE_DEFAULTS) {
  const peopleSignal   = clamp01(people / cfg.PEOPLE_SATURATION);
  const severitySignal = people > 0 ? clamp01((avgScore ?? 0) / cfg.SCORE_SATURATION) : 0;
  const acousticRate   = hasSensor
    ? (coughs + sneezes) / Math.max(footTraffic, cfg.MIN_TRAFFIC_FLOOR)
    : 0;
  const acousticSignal = clamp01(acousticRate / cfg.ACOUSTIC_RATE_HIGH);

  const index = Math.round(100 * (
    cfg.WEIGHT_PEOPLE   * peopleSignal +
    cfg.WEIGHT_SEVERITY * severitySignal +
    cfg.WEIGHT_ACOUSTIC * acousticSignal
  ));
  return {
    index,
    level: riskLevel(index, cfg),
    signals: {
      people:   +peopleSignal.toFixed(3),
      severity: +severitySignal.toFixed(3),
      acoustic: +acousticSignal.toFixed(3),
    },
    acousticRate: +acousticRate.toFixed(4),
  };
}

// riskRows:   [{ lat, lng, userHash, score, time, source }]
// sensorRows: [{ deviceId, lat, lng, coughs, sneezes, footTraffic, lastSeen }] (already summed per device)
export function aggregateZones(riskRows, sensorRows, { cellDeg = ZONE_DEFAULTS.CELL_DEG, minPeople = 1, cfg = ZONE_DEFAULTS } = {}) {
  const cells = new Map();
  const get = (lat, lng) => {
    const key = cellKey(lat, lng, cellDeg);
    if (!cells.has(key)) {
      const [i, j] = key.split(':').map(Number);
      cells.set(key, {
        key,
        lat: +(i * cellDeg).toFixed(6),
        lng: +(j * cellDeg).toFixed(6),
        users: new Map(),     // userHash -> max score
        sources: { vitals: 0, self_report: 0 },
        coughs: 0, sneezes: 0, footTraffic: 0,
        devices: 0,
        lastSeen: null,
      });
    }
    return cells.get(key);
  };
  const bump = (cell, t) => {
    if (!t) return;
    const d = new Date(t);
    if (!cell.lastSeen || d > cell.lastSeen) cell.lastSeen = d;
  };

  for (const r of riskRows) {
    const cell = get(Number(r.lat), Number(r.lng));
    const prev = cell.users.get(r.userHash);
    if (prev == null) cell.sources[r.source === 'self_report' ? 'self_report' : 'vitals']++;
    cell.users.set(r.userHash, Math.max(prev ?? 0, Number(r.score)));
    bump(cell, r.time);
  }

  for (const s of sensorRows) {
    const cell = get(Number(s.lat), Number(s.lng));
    cell.coughs      += Number(s.coughs);
    cell.sneezes     += Number(s.sneezes);
    cell.footTraffic += Number(s.footTraffic);
    cell.devices++;
    bump(cell, s.lastSeen);
  }

  const zones = [];
  for (const cell of cells.values()) {
    const peopleRaw  = cell.users.size;
    const showPeople = peopleRaw >= minPeople;
    const people     = showPeople ? peopleRaw : 0;
    const scores     = [...cell.users.values()];
    const avgScore   = showPeople && scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const hasSensor  = cell.devices > 0;

    if (!showPeople && !hasSensor) continue; // nothing we're allowed to show

    const risk = zoneIndex({ people, avgScore, coughs: cell.coughs, sneezes: cell.sneezes,
                             footTraffic: cell.footTraffic, hasSensor }, cfg);
    zones.push({
      lat: cell.lat,
      lng: cell.lng,
      bounds: [[cell.lat - cellDeg / 2, cell.lng - cellDeg / 2], [cell.lat + cellDeg / 2, cell.lng + cellDeg / 2]],
      people,
      avgScore: avgScore != null ? +avgScore.toFixed(2) : null,
      sources:  showPeople ? cell.sources : { vitals: 0, self_report: 0 },
      coughs: cell.coughs,
      sneezes: cell.sneezes,
      footTraffic: cell.footTraffic,
      devices: cell.devices,
      lastSeen: cell.lastSeen ? cell.lastSeen.toISOString() : null,
      ...risk,
    });
  }
  zones.sort((a, b) => b.index - a.index);
  return zones;
}
