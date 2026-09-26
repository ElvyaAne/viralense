// Seeds demo data around a location so the map isn't empty during judging.
//   npm run db:seed                       # around uOttawa
//   npm run db:seed -- 45.4215 -75.6972   # around a custom lat/lng
//   npm run db:seed -- --clear            # remove previously seeded rows first
import 'dotenv/config';
import { createStore } from '../src/store.js';

const args  = process.argv.slice(2);
const clear = args.includes('--clear');
const nums  = args.filter(a => !a.startsWith('--')).map(Number);
const [centerLat, centerLng] = nums.length === 2 ? nums : [45.4231, -75.6831];
// Put hotspots in the middle of a map zone so each one lands in a single zone
const ZONE = 0.005;
const baseLat = Math.round(centerLat / ZONE) * ZONE;
const baseLng = Math.round(centerLng / ZONE) * ZONE;

const store = await createStore();
console.log(`Seeding into: ${store.describe}`);

if (clear) {
  await store.clearSeeded();
  console.log('Cleared previously seeded rows.');
}

// Deterministic pseudo-random so every seed run looks the same
let s = 42;
const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;

// A few "hotspots" with different intensity
const hotspots = [
  { dLat:  0.000, dLng:  0.000, people: 8, sick: 0.9 },
  { dLat:  0.005, dLng: -0.010, people: 4, sick: 0.6 },
  { dLat: -0.010, dLng:  0.005, people: 3, sick: 0.4 },
  { dLat:  0.010, dLng:  0.010, people: 2, sick: 0.3 },
];

let n = 0;
for (const [h, spot] of hotspots.entries()) {
  for (let p = 0; p < spot.people; p++) {
    const lat    = +(baseLat + spot.dLat + (rand() - 0.5) * 0.002).toFixed(3);
    const lng    = +(baseLng + spot.dLng + (rand() - 0.5) * 0.002).toFixed(3);
    const score  = 4 + Math.floor(rand() * 4 * spot.sick);
    const source = rand() < 0.5 ? 'vitals' : 'self_report';
    const hoursAgo = Math.floor(rand() * 72);
    await store.insertRiskEvent({
      time: Date.now() - hoursAgo * 3600_000,
      userHash: `seed-${h}-${p}`, lat, lng, score, source,
      pulseRate:     source === 'vitals' ? 95 + rand() * 20 : null,
      breathingRate: source === 'vitals' ? 20 + rand() * 6  : null,
      hrvMs: null,
    });
    n++;
  }
}

// Two mic listeners: a busy coughing cafeteria and a quiet library
const devices = [
  { id: 'seed-cafeteria-mic', dLat:  0.001, dLng:  0.001, traffic: 60, coughRate: 0.12 },
  { id: 'seed-library-mic',      dLat: -0.010, dLng:  0.005, traffic: 25, coughRate: 0.03 },
];
let m = 0;
for (const d of devices) {
  for (let hr = 23; hr >= 0; hr--) {
    const footTraffic = Math.round(d.traffic * (0.5 + rand()));
    const events      = Math.round(footTraffic * d.coughRate * (0.5 + rand()));
    const sneezes     = Math.round(events * 0.3);
    await store.insertSensorEvent({
      time: Date.now() - hr * 3600_000,
      deviceId: d.id, lat: baseLat + d.dLat, lng: baseLng + d.dLng,
      windowSec: 3600, coughs: events - sneezes, sneezes, footTraffic,
    });
    m++;
  }
}

await store.flush();
console.log(`Seeded ${n} risk events and ${m} sensor batches around ${centerLat}, ${centerLng}.`);
