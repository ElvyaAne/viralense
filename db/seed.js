// Seeds demo data around a location so the map isn't empty during judging.
//   npm run db:seed                       # around uOttawa
//   npm run db:seed -- 45.4215 -75.6972   # around a custom lat/lng
//   npm run db:seed -- --clear            # remove previously seeded rows first
import 'dotenv/config';
import pg from 'pg';

const args  = process.argv.slice(2);
const clear = args.includes('--clear');
const nums  = args.filter(a => !a.startsWith('--')).map(Number);
const [centerLat, centerLng] = nums.length === 2 ? nums : [45.4231, -75.6831];

if (!process.env.TIGER_DATABASE_URL) {
  console.error('Error: TIGER_DATABASE_URL environment variable not set.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.TIGER_DATABASE_URL });
await client.connect();

if (clear) {
  await client.query(`DELETE FROM risk_events   WHERE user_hash LIKE 'seed-%'`);
  await client.query(`DELETE FROM sensor_events WHERE device_id LIKE 'seed-%'`);
  console.log('Cleared previously seeded rows.');
}

// Deterministic pseudo-random so every seed run looks the same
let s = 42;
const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;

// A few "hotspots" with different intensity
const hotspots = [
  { dLat:  0.000, dLng:  0.000, people: 7, sick: 0.8 },
  { dLat:  0.006, dLng: -0.008, people: 4, sick: 0.6 },
  { dLat: -0.007, dLng:  0.005, people: 3, sick: 0.4 },
  { dLat:  0.012, dLng:  0.010, people: 2, sick: 0.3 },
];

let n = 0;
for (const [h, spot] of hotspots.entries()) {
  for (let p = 0; p < spot.people; p++) {
    const lat    = +(centerLat + spot.dLat + (rand() - 0.5) * 0.003).toFixed(3);
    const lng    = +(centerLng + spot.dLng + (rand() - 0.5) * 0.003).toFixed(3);
    const score  = 4 + Math.floor(rand() * 4 * spot.sick);
    const source = rand() < 0.5 ? 'vitals' : 'self_report';
    const hoursAgo = Math.floor(rand() * 72);
    await client.query(
      `INSERT INTO risk_events (time, user_hash, location, score, pulse_rate, breathing_rate, source)
       VALUES (NOW() - make_interval(hours => $1::int), $2,
               ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, $6, $7, $8)`,
      [hoursAgo, `seed-${h}-${p}`, lat, lng, score,
       source === 'vitals' ? 95 + rand() * 20 : null,
       source === 'vitals' ? 20 + rand() * 6  : null,
       source],
    );
    n++;
  }
}

// Two room sensors: a busy coughing lecture hall and a quiet library
const devices = [
  { id: 'seed-lecture-hall', dLat:  0.001, dLng:  0.001, traffic: 60, coughRate: 0.12 },
  { id: 'seed-library',      dLat: -0.007, dLng:  0.004, traffic: 25, coughRate: 0.03 },
];
let m = 0;
for (const d of devices) {
  for (let hr = 23; hr >= 0; hr--) {
    const footTraffic = Math.round(d.traffic * (0.5 + rand()));
    const events      = Math.round(footTraffic * d.coughRate * (0.5 + rand()));
    const sneezes     = Math.round(events * 0.3);
    await client.query(
      `INSERT INTO sensor_events (time, device_id, lat, lng, window_sec, coughs, sneezes, foot_traffic)
       VALUES (NOW() - make_interval(hours => $1::int), $2, $3, $4, 3600, $5, $6, $7)`,
      [hr, d.id, centerLat + d.dLat, centerLng + d.dLng, events - sneezes, sneezes, footTraffic],
    );
    m++;
  }
}

await client.end();
console.log(`Seeded ${n} risk events and ${m} sensor batches around ${centerLat}, ${centerLng}.`);
