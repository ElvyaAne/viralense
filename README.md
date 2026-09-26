#### Hack The Hill III Project
# Viralense

Viralense is a **live sickness-risk map**. It listens for **coughs and sneezes** through a computer's microphone and combines that with **self-reported symptoms**, so you can see which parts of a city are getting sick right now.

- **Cough & sneeze listener**: open the page, press *Start listening*, and it counts coughs and sneezes from the mic, sending the counts to the map every few seconds.
- **Symptom checklist**: anyone can tick what they're feeling, on a laptop or phone.
- **Zone map**: the city is split into ~500 m zones, each with a **risk index from 0 to 100**, shown as a heatmap and coloured zones that update live.

## Privacy

- Audio is analysed inside the browser tab. It's never recorded or uploaded, only the counts.
- People are identified by a salted hash of a random browser ID, never by name.
- Locations are rounded to ~100 m, and only people who actually have symptoms are stored, at most once per 12 hours.
- Data older than 14 days is deleted automatically.

## How the risk index works

| Signal | Weight | Maxes out at |
|---|---|---|
| People reporting symptoms in the zone | 50% | 5 people |
| How severe their symptoms are | 15% | average score 8 |
| Coughs + sneezes heard by mics | 35% | 4 in the last 24 h |

60+ is **high**, 30–59 **elevated**, anything above 0 **low**. Symptom scores: fever, shortness of breath, and loss of taste/smell count 2; other symptoms count 1. See [`src/zones.js`](src/zones.js) and [`src/symptoms.js`](src/symptoms.js).

## How cough detection works

The listener learns the room's background noise for a second, then looks for **short, loud, isolated bursts** (0.1–1 s, well above background). Longer, brighter bursts count as sneezes, the rest as coughs; low thuds and continuous speech are ignored. It's a simple loudness-and-pitch detector: good for a demo, but a clap or a door slam can fool it.

## Run it on your laptop

You need [Node.js 20+](https://nodejs.org). No database or API keys.

```bash
npm install
npm run db:seed    # optional: demo hotspots around uOttawa
npm start          # then open http://localhost:3000 in Chrome or Edge
```

Data is saved to `data/viralense-data.json` and kept between restarts. If your browser won't share your location, the page uses a default spot (uOttawa); click **Pick my location on the map** to change it.

## Deploy to Vultr

1. Create a Vultr **Cloud Compute** server with **Ubuntu 24.04** (the smallest size is plenty).
2. SSH in (`ssh root@YOUR_SERVER_IP`) and run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/ElvyaAne/viralense/finish-viralense/deploy/setup-vultr.sh | bash
   ```

3. It prints your site's address, something like `https://45-76-1-2.sslip.io`. Open it.

The script installs Node.js and Caddy, runs the app as a service that restarts automatically, and sets up **HTTPS**, which browsers require before they'll allow the microphone. With no domain it uses a free `sslip.io` address; to use your own, point the domain's A record at the server and run with `DOMAIN=yourdomain.com` before `bash`. Re-run the same command to update.

If the page doesn't load, check that the Vultr firewall group allows ports 80 and 443.

## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3000 | Port the app listens on |
| `HASH_SALT` | *(empty)* | Salt for hashing browser IDs; the deploy script sets a random one |
| `DEFAULT_LAT`, `DEFAULT_LNG` | uOttawa | Where the map starts, and the location used when a browser won't share one |
| `TIGER_DATABASE_URL` | *(none)* | Optional: store data in Tiger Data (TimescaleDB + PostGIS) instead of the local file. Run `npm run db:init` once after setting it. If it can't connect, the app falls back to the local file |
| `MIN_PEOPLE_PER_ZONE` | 1 | Hide people counts in zones with fewer reports than this |
| `REPORT_WINDOW_DAYS` | 7 | How far back symptom reports count |
| `SENSOR_WINDOW_HOURS` | 24 | How far back cough counts count |
| `ZONE_CELL_DEG` | 0.005 | Zone size in degrees (≈500 m) |

## API

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/symptoms` | Symptom checklist options |
| `POST` | `/symptom-reports` | `userId, lat, lng, symptoms: ["fever", "cough", ...]` |
| `POST` | `/sensor-events` | Mic counts: `deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic` (0) |
| `GET` | `/zones` | Zones with risk index and mic listeners |
| `GET` | `/config` | Default map location |
| `GET` | `/health` | `{ ok, db, storage }` |

A WebSocket on the same port sends `zones-updated` whenever new data arrives, so every open map refreshes live.

## Project layout

```
server.mjs              Express + WebSocket server and API
public/index.html       The web app (map, mic listener, symptom form)
src/zones.js            Combines everything into per-zone risk
src/symptoms.js         Symptom checklist → score
src/sensors.js          Validation for mic count batches
src/store.js            Storage: local JSON file or Tiger Data
db/                     Tiger Data schema, init and demo seed scripts
deploy/setup-vultr.sh   One-command server setup
```

`npm test` runs the tests.

## Demo script

1. `npm run db:seed` so the map has hotspots.
2. Open the site, press **Start listening**, and cough a few times. Watch the counter go up, then "✓ Sent … to the map" a few seconds later, with your zone lighting up.
3. Tick a couple of symptoms and press **Report symptoms**.
4. Press **Add a fake sick person nearby** a few times and watch your zone turn red.
5. If the room is too noisy, **Pretend the mic heard 3 coughs** does the same thing on demand.

## Disclaimer

Viralense is a hackathon prototype, not a medical device. Risk scores are rough indicators, not diagnoses.
