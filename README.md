#### Hack The Hill III Project
# Viralense

Viralense maps **sickness risk by city zone** so people can see where illness is spreading right now. It combines three signals:

1. **Webcam vitals**: a 30-second face scan (Presage SmartSpectra) measures pulse, breathing rate and HRV, and scores them together with a couple of quick questions.
2. **Self-reported symptoms**: a checklist anyone can fill in on their phone, no camera needed.
3. **Room sensors**: a Raspberry Pi with a microphone counts **coughs and sneezes**, and an Arduino IR sensor counts **foot traffic**, so a room's cough rate is measured per person walking through.

The server splits the map into ~500 m zones and gives each one a **risk index from 0 to 100**, shown as a heatmap and as coloured zones.

## Privacy

- Users are identified only by a salted SHA-256 hash of a random browser ID.
- Locations are rounded to ~100 m before they're stored.
- Only people with symptoms or a high-risk score are stored, at most once per person every 12 hours.
- The Pi only uploads counts. Audio is never recorded or sent.
- Data is deleted automatically after 14 days (TimescaleDB retention policy).
- `MIN_PEOPLE_PER_ZONE` hides the people count in zones with too few reports.

## How the zone risk index works

| Signal | Weight | Maxes out at |
|---|---|---|
| People flagged in the zone | 50% | 5 people |
| How severe their scores were | 15% | average score 8 |
| Coughs + sneezes per passer-by | 35% | 1 per 5 people |

Low traffic is floored at 20 people, so one cough in an empty room doesn't max out the zone. 60+ is **high**, 30–59 **elevated**, anything above 0 **low**. The logic is in [`src/zones.js`](src/zones.js).

Vitals scoring (`src/score.js`) and symptom scoring (`src/symptoms.js`) use the same scale; 4 or more counts as high risk.

## Project layout

```
server.mjs                  Express + WebSocket server, API, optional webcam SDK
public/index.html           Web app (Leaflet map, heatmap, forms)
src/score.js                Vitals → risk score
src/symptoms.js             Symptom checklist → risk score
src/sensors.js              Validation for Pi sensor batches
src/zones.js                Combines everything into per-zone risk
db/schema.sql               TimescaleDB + PostGIS schema
db/seed.js                  Demo data generator
devices/arduino/            IR foot-traffic counter sketch
devices/pi/                 Raspberry Pi mic + serial client
```

## Running the server

Requires Node 20+ and a Tiger Data (TimescaleDB) database with PostGIS.

```bash
npm install
# create a .env file first (see the table below)
npm run db:init             # create tables (safe to re-run; also upgrades old DBs)
npm run db:seed             # optional: demo data around uOttawa
npm start                   # http://localhost:3000
npm test
```

`.env` settings:

| Variable | Needed? | What it does |
|---|---|---|
| `TIGER_DATABASE_URL` | yes | Postgres connection string |
| `HASH_SALT` | recommended | Salt for hashing user IDs |
| `SMARTSPECTRA_API_KEY` | optional | Turns on webcam vitals. Without it the app runs in self-report + sensor mode |
| `SENSOR_TOKEN` | recommended | Shared secret the Pi must send; leave empty to accept any device |
| `MIN_PEOPLE_PER_ZONE` | optional | Hide people counts in zones with fewer reports (default 1) |
| `VITALS_WINDOW_DAYS` | optional | How far back people reports count (default 7) |
| `SENSOR_WINDOW_HOURS` | optional | How far back sensor counts count (default 24) |
| `ZONE_CELL_DEG` | optional | Zone size in degrees (default 0.005 ≈ 500 m) |
| `DISABLE_CAMERA` | optional | Set to `1` to skip the webcam SDK even if a key is set |
| `PORT` | optional | Default 3000 |

**Webcam vs. cloud:** the SmartSpectra SDK reads the webcam plugged into the machine running the server. On a cloud host like Vultr there is no webcam, so leave `SMARTSPECTRA_API_KEY` unset there; the app still works for symptom reports and room sensors. Run a second copy on a laptop with a webcam and the same database URL for the face-scan demo. Both write to the same map.

If the site is served over HTTPS, the live updates automatically use `wss://`.

## Room sensor (Raspberry Pi + Arduino)

### Arduino: foot traffic

1. Wire the IR obstacle/break-beam module: `VCC → 5V`, `GND → GND`, `OUT → D2`.
2. Flash `devices/arduino/foot_traffic/foot_traffic.ino`.
3. Open the Serial Monitor at 9600 baud and wave a hand through the beam; you should see `PASS`. If it counts the wrong way round, set `ACTIVE_LOW = false`.
4. Plug the Arduino into the Pi over USB.

### Raspberry Pi: microphone + upload

```bash
cd devices/pi
sudo apt install -y libportaudio2
pip install -r requirements.txt

python3 sensor_client.py \
  --server https://YOUR-SERVER \
  --device-id lecture-hall-1 \
  --lat 45.4231 --lng -75.6831 \
  --serial /dev/ttyACM0 \
  --token YOUR_SENSOR_TOKEN
```

It posts a batch every 60 s (`--interval`). If an upload fails, counts are kept and sent with the next batch.

No hardware on hand? Test the whole pipeline with fake events:

```bash
python3 sensor_client.py --simulate --busy --interval 10 --server http://localhost:3000
```

**Better cough detection (optional):** by default the Pi uses a simple loudness and pitch heuristic, which works for a demo but can be fooled by claps or door slams. For real detection, put Google's YAMNet model next to the script as `yamnet.tflite` and `yamnet_class_map.csv` (from TensorFlow Hub / Kaggle Models) and `pip install ai-edge-litert`. The client picks it up automatically and uses YAMNet's "Cough" and "Sneeze" classes.

## API

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/readings` | Webcam vitals: `userId, lat, lng, pulseRate, breathingRate, confidence (0–1), durationSec, exercisedRecently, symptoms, hrvMs?` |
| `GET` | `/symptoms` | Symptom checklist options |
| `POST` | `/symptom-reports` | `userId, lat, lng, symptoms: ["fever", "cough", ...]` |
| `POST` | `/sensor-events` | Header `x-device-token`. Body `deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic` |
| `GET` | `/zones` | Combined zones with risk index, signals and sensor list |
| `GET` | `/risk-areas` | Original people-only endpoint (kept for compatibility) |
| `GET` | `/health` | `{ ok, db, vitals }` |

The WebSocket on the same port streams camera frames and vitals, and sends `zones-updated` whenever new data arrives so every open map refreshes live.

## Demo script

1. `npm run db:seed` so the map has hotspots.
2. Open the site and allow location.
3. Tick a couple of symptoms and press **Report symptoms**.
4. Press **Add fake sick person nearby** a few times and watch your zone turn red.
5. Start the Pi (or `--simulate --busy`) and watch the room sensor appear with its cough count.
6. On the webcam laptop, do a 30-second face scan.

## Disclaimer

Viralense is a hackathon prototype, not a medical device. Risk scores are rough indicators, not diagnoses.
