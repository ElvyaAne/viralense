#### Hack The Hill III Project
# Viralense

Viralense maps **sickness risk by city zone** so people can see where illness is spreading right now. It combines three signals:

1. **Webcam vitals**: a 30-second face scan in the browser measures pulse and breathing rate from tiny colour and brightness changes in the webcam image, then scores them together with a couple of quick questions. (The Presage SmartSpectra SDK is still supported as an optional upgrade.)
2. **Self-reported symptoms**: a checklist anyone can fill in on their phone, no camera needed.
3. **Cough & sneeze listener**: the laptop's built-in microphone listens in the browser and counts **coughs and sneezes** nearby.

Everything runs on one laptop: its webcam for vitals and its mic for coughs. No extra hardware.

The server splits the map into ~500 m zones and gives each one a **risk index from 0 to 100**, shown as a heatmap and as coloured zones.

## Privacy

- Users are identified only by a salted SHA-256 hash of a random browser ID.
- Locations are rounded to ~100 m before they're stored.
- Only people with symptoms or a high-risk score are stored, at most once per person every 12 hours.
- The mic listener runs in the browser tab and only uploads counts. Audio is never recorded or sent.
- Data is deleted automatically after 14 days (TimescaleDB retention policy).
- `MIN_PEOPLE_PER_ZONE` hides the people count in zones with too few reports.

## How the zone risk index works

| Signal | Weight | Maxes out at |
|---|---|---|
| People flagged in the zone | 50% | 5 people |
| How severe their scores were | 15% | average score 8 |
| Coughs + sneezes heard by the mic | 35% | 4 in the last 24 h |

60+ is **high**, 30–59 **elevated**, anything above 0 **low**. The logic is in [`src/zones.js`](src/zones.js).

Vitals scoring (`src/score.js`) and symptom scoring (`src/symptoms.js`) use the same scale; 4 or more counts as high risk.

## Project layout

```
server.mjs                  Express + WebSocket server, API, optional webcam SDK
public/index.html           Web app (Leaflet map, heatmap, forms)
public/vitals.js            In-browser pulse + breathing estimation from the webcam
src/score.js                Vitals → risk score
src/symptoms.js             Symptom checklist → risk score
src/sensors.js              Validation for mic cough/sneeze batches
src/zones.js                Combines everything into per-zone risk
src/store.js                Storage: Tiger Data or local JSON file
db/schema.sql               TimescaleDB + PostGIS schema
db/seed.js                  Demo data generator
```

## Running it on your laptop

Run it **on the laptop whose webcam and mic you want to use**. You only need Node 20+.

```bash
npm install
npm run db:seed    # optional: demo hotspots around uOttawa
npm start          # then open http://localhost:3000 in Chrome or Edge
npm test
```

**No database needed.** Without a `TIGER_DATABASE_URL`, everything is saved to `data/viralense-data.json` on your laptop and kept between restarts. To use Tiger Data (TimescaleDB) instead, add the URL to `.env` and run `npm run db:init` once. If the database can't be reached, the app falls back to the local file instead of crashing.

`.env` settings:

| Variable | Needed? | What it does |
|---|---|---|
| `TIGER_DATABASE_URL` | optional | Tiger Data connection string. Leave out to use the local file |
| `HASH_SALT` | recommended | Salt for hashing user IDs |
| `SMARTSPECTRA_API_KEY` | optional | Uses Presage's SDK for vitals instead of the built-in browser scan (Linux/macOS) |
| `MIN_PEOPLE_PER_ZONE` | optional | Hide people counts in zones with fewer reports (default 1) |
| `VITALS_WINDOW_DAYS` | optional | How far back people reports count (default 7) |
| `SENSOR_WINDOW_HOURS` | optional | How far back mic counts count (default 24) |
| `ZONE_CELL_DEG` | optional | Zone size in degrees (default 0.005 ≈ 500 m) |
| `DISABLE_CAMERA` | optional | Set to `1` to skip the webcam SDK even if a key is set |
| `PORT` | optional | Default 3000 |

Open the page at **http://localhost:3000**: browsers only allow the mic and location on `localhost` or HTTPS. Close other apps that use the webcam (Zoom, FaceTime, etc.) before starting, or the SDK can't open it.

If you later host it over HTTPS, live updates automatically use `wss://`.

## Face scan (webcam)

Press **Start 30-second face scan**, allow the camera, and keep your face in the oval. The page:

1. Averages the skin colour in the dashed box on every frame. Each heartbeat changes it very slightly, and the POS method (Wang et al., 2017) turns that into a pulse signal.
2. Tracks brightness below your face, which shifts slightly as your shoulders and chest move when you breathe.
3. Finds the strongest rhythm in each signal, showing pulse after ~8 s and breathing after ~15 s, plus a signal-quality score.

The video never leaves the page. Best results: steady light on your face (a window or lamp in front of you), no backlight, hold still, don't talk. It's a prototype estimate, not a medical measurement.

## Cough & sneeze listener

Press **Start listening** and allow the microphone. The page:

1. Calibrates to the room's background noise for about a second.
2. Watches for short, loud, isolated bursts (0.1–1 s, well above the background).
3. Calls longer, brighter bursts **sneezes** and the rest **coughs**; low thuds are ignored.
4. Ignores bursts while the webcam sees you talking, and bursts that are part of continuous speech.
5. Sends the counts to the server every 30 seconds (and when you stop).

It's a simple loudness-and-pitch detector, good enough for a demo but a clap or a door slam can fool it. The level bar turns red whenever it hears something loud, which helps show judges it's live.

## API

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/readings` | Webcam vitals: `userId, lat, lng, pulseRate, breathingRate, confidence (0–1), durationSec, exercisedRecently, symptoms, hrvMs?` |
| `GET` | `/symptoms` | Symptom checklist options |
| `POST` | `/symptom-reports` | `userId, lat, lng, symptoms: ["fever", "cough", ...]` |
| `POST` | `/sensor-events` | Mic counts: `deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic` (always 0 for now) |
| `GET` | `/zones` | Combined zones with risk index, signals and mic listeners |
| `GET` | `/risk-areas` | Original people-only endpoint (kept for compatibility) |
| `GET` | `/health` | `{ ok, db, storage, vitals }` |

The WebSocket on the same port streams camera frames and vitals, and sends `zones-updated` whenever new data arrives so every open map refreshes live.

## Demo script

1. `npm run db:seed` so the map has hotspots.
2. `npm start`, open http://localhost:3000 and allow location.
3. Press **Start 30-second face scan**, hold still facing a light, then submit the reading.
4. Press **Start listening** and cough a few times; watch the counter go up and your zone pick up a mic pin.
5. Tick a couple of symptoms and press **Report symptoms**.
6. Press **Add fake sick person nearby** a few times and watch your zone turn red.

If the room is too noisy for the mic, **Pretend the mic heard 3 coughs** does the same thing on demand.

## Disclaimer

Viralense is a hackathon prototype, not a medical device. Risk scores are rough indicators, not diagnoses.
