#!/usr/bin/env python3
"""
Viralense room sensor client for the Raspberry Pi.

Counts, in fixed time windows, and posts to the Viralense server:
  * foot traffic   -- "PASS" lines from the Arduino IR counter over USB serial
  * coughs/sneezes -- short loud sound bursts from a USB microphone, classified
                      with YAMNet if the model is present, otherwise a simple
                      loudness/pitch heuristic

Nothing but the counts ever leaves the Pi: no audio is recorded or uploaded.

Quick start (no hardware needed, fake events):
    python3 sensor_client.py --simulate --server http://localhost:3000

Real hardware:
    python3 sensor_client.py --server https://your-vultr-host \
        --device-id lecture-hall-1 --lat 45.4231 --lng -75.6831 \
        --serial /dev/ttyACM0 --token $SENSOR_TOKEN
"""

import argparse
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request


# ── Shared counters ──────────────────────────────────────────────────────────

class Counts:
    def __init__(self):
        self._lock = threading.Lock()
        self.coughs = 0
        self.sneezes = 0
        self.foot_traffic = 0

    def add(self, coughs=0, sneezes=0, foot_traffic=0):
        with self._lock:
            self.coughs += coughs
            self.sneezes += sneezes
            self.foot_traffic += foot_traffic

    def take(self):
        """Return current counts and reset them."""
        with self._lock:
            snap = (self.coughs, self.sneezes, self.foot_traffic)
            self.coughs = self.sneezes = self.foot_traffic = 0
            return snap


def log(*args):
    print(time.strftime("[%H:%M:%S]"), *args, flush=True)


# ── Foot traffic: Arduino over serial ────────────────────────────────────────

def serial_loop(port, baud, counts, stop):
    try:
        import serial  # pyserial
    except ImportError:
        log("pyserial not installed (pip install pyserial) — foot traffic disabled")
        return

    while not stop.is_set():
        try:
            with serial.Serial(port, baud, timeout=1) as ser:
                log(f"serial: connected to {port}")
                while not stop.is_set():
                    line = ser.readline().decode("ascii", errors="ignore").strip()
                    if line == "PASS":
                        counts.add(foot_traffic=1)
        except Exception as e:  # unplugged, wrong port, permissions...
            log(f"serial: {e} — retrying in 5 s")
            stop.wait(5)


# ── Coughs/sneezes: microphone ───────────────────────────────────────────────

SAMPLE_RATE = 16000
FRAME = 512  # 32 ms


class YamnetClassifier:
    """Optional: uses Google's YAMNet (AudioSet classes 'Cough' and 'Sneeze')."""

    def __init__(self, model_path, class_map_path, threshold):
        Interpreter = None
        for mod, attr in (("ai_edge_litert.interpreter", "Interpreter"),
                          ("tflite_runtime.interpreter", "Interpreter"),
                          ("tensorflow.lite", "Interpreter")):
            try:
                Interpreter = getattr(__import__(mod, fromlist=[attr]), attr)
                break
            except ImportError:
                continue
        if Interpreter is None:
            raise RuntimeError("no TFLite runtime (pip install ai-edge-litert or tflite-runtime)")

        import csv
        with open(class_map_path, newline="") as f:
            names = [row["display_name"] for row in csv.DictReader(f)]
        self.cough_idx = names.index("Cough")
        self.sneeze_idx = names.index("Sneeze")

        self.interp = Interpreter(model_path=model_path)
        self.interp.allocate_tensors()
        self.inp = self.interp.get_input_details()[0]
        self.out = next(o for o in self.interp.get_output_details() if o["shape"][-1] == len(names))
        self.threshold = threshold

    def classify(self, audio):
        import numpy as np
        shape = self.inp["shape"]
        n = int(np.prod(shape))
        clip = np.zeros(n, dtype=np.float32)
        clip[: min(n, len(audio))] = audio[:n]
        self.interp.set_tensor(self.inp["index"], clip.reshape(shape))
        self.interp.invoke()
        scores = self.interp.get_tensor(self.out["index"]).reshape(-1, self.out["shape"][-1]).max(axis=0)
        cough, sneeze = float(scores[self.cough_idx]), float(scores[self.sneeze_idx])
        if max(cough, sneeze) < self.threshold:
            return None
        return "sneeze" if sneeze > cough else "cough"


def heuristic_classify(audio, duration, peak_over_floor_db):
    """
    Very rough fallback: a cough is a short, loud, broadband burst; a sneeze is
    a bit longer with more high-frequency energy. Door slams and claps can fool
    it — use YAMNet for anything beyond a demo.
    """
    import numpy as np
    if peak_over_floor_db < 15 or not (0.12 <= duration <= 1.0):
        return None
    spectrum = np.abs(np.fft.rfft(audio * np.hanning(len(audio))))
    freqs = np.fft.rfftfreq(len(audio), 1 / SAMPLE_RATE)
    centroid = float((spectrum * freqs).sum() / (spectrum.sum() + 1e-9))
    if centroid < 400:          # low thud, not a cough
        return None
    if centroid > 2500 and duration >= 0.3:
        return "sneeze"
    return "cough"


def audio_loop(counts, stop, classifier, onset_db, device):
    try:
        import numpy as np
        import sounddevice as sd
    except ImportError:
        log("numpy/sounddevice not installed (pip install numpy sounddevice) — mic disabled")
        return

    noise_db = -60.0
    in_event = False
    event_frames = []
    peak_db = -120.0
    quiet_frames = 0

    def finish_event():
        audio = np.concatenate(event_frames)
        duration = len(audio) / SAMPLE_RATE
        if classifier is not None:
            kind = classifier.classify(audio) if 0.1 <= duration <= 2.0 else None
        else:
            kind = heuristic_classify(audio, duration, peak_db - noise_db)
        if kind == "cough":
            counts.add(coughs=1)
        elif kind == "sneeze":
            counts.add(sneezes=1)
        if kind:
            log(f"mic: {kind} ({duration:.2f} s, +{peak_db - noise_db:.0f} dB)")

    log(f"mic: listening ({'YAMNet' if classifier else 'heuristic'} classifier)")
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, blocksize=FRAME,
                        dtype="float32", device=device) as stream:
        while not stop.is_set():
            block, _ = stream.read(FRAME)
            x = block[:, 0]
            db = 20 * np.log10(np.sqrt(np.mean(x * x)) + 1e-10)

            if not in_event:
                if db > noise_db + onset_db:
                    in_event, event_frames, peak_db, quiet_frames = True, [x.copy()], db, 0
                else:
                    noise_db = 0.98 * noise_db + 0.02 * db  # slow adaptive floor
            else:
                event_frames.append(x.copy())
                peak_db = max(peak_db, db)
                quiet_frames = quiet_frames + 1 if db < noise_db + onset_db / 2 else 0
                too_long = len(event_frames) * FRAME / SAMPLE_RATE > 2.5
                if quiet_frames >= 4 or too_long:  # ~130 ms of quiet ends the event
                    if not too_long:
                        finish_event()
                    in_event = False


# ── Simulation (no hardware) ─────────────────────────────────────────────────

def simulate_loop(counts, stop, busy):
    log("simulate: generating fake foot traffic and coughs")
    while not stop.wait(1.0):
        if random.random() < (0.9 if busy else 0.3):
            counts.add(foot_traffic=1)
        if random.random() < (0.12 if busy else 0.02):
            counts.add(coughs=1)
        if random.random() < (0.04 if busy else 0.01):
            counts.add(sneezes=1)


# ── Upload ───────────────────────────────────────────────────────────────────

def post(server, token, payload):
    req = urllib.request.Request(
        server.rstrip("/") + "/sensor-events",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **({"x-device-token": token} if token else {})},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return res.status


def main():
    env = os.environ.get
    p = argparse.ArgumentParser(description="Viralense Raspberry Pi room sensor")
    p.add_argument("--server",    default=env("VIRALENSE_SERVER", "http://localhost:3000"))
    p.add_argument("--device-id", default=env("DEVICE_ID", "pi-" + os.uname().nodename))
    p.add_argument("--lat",       type=float, default=float(env("DEVICE_LAT", "45.4231")))
    p.add_argument("--lng",       type=float, default=float(env("DEVICE_LNG", "-75.6831")))
    p.add_argument("--token",     default=env("SENSOR_TOKEN", ""))
    p.add_argument("--interval",  type=float, default=float(env("UPLOAD_INTERVAL", "60")),
                   help="seconds per batch (default 60)")
    p.add_argument("--serial",    default=env("SERIAL_PORT", "/dev/ttyACM0"),
                   help="Arduino port, or 'none' to disable")
    p.add_argument("--baud",      type=int, default=9600)
    p.add_argument("--no-mic",    action="store_true", help="disable microphone")
    p.add_argument("--mic-device", default=env("MIC_DEVICE"), help="sounddevice input name/index")
    p.add_argument("--onset-db",  type=float, default=12.0, help="loudness jump above noise floor that starts an event")
    p.add_argument("--yamnet-model",     default=env("YAMNET_MODEL", "yamnet.tflite"))
    p.add_argument("--yamnet-class-map", default=env("YAMNET_CLASS_MAP", "yamnet_class_map.csv"))
    p.add_argument("--yamnet-threshold", type=float, default=0.3)
    p.add_argument("--simulate",  action="store_true", help="fake events, no hardware needed")
    p.add_argument("--busy",      action="store_true", help="with --simulate: a crowded, coughing room")
    args = p.parse_args()

    counts = Counts()
    stop = threading.Event()
    threads = []

    if args.simulate:
        threads.append(threading.Thread(target=simulate_loop, args=(counts, stop, args.busy), daemon=True))
    else:
        if args.serial.lower() != "none":
            threads.append(threading.Thread(target=serial_loop, args=(args.serial, args.baud, counts, stop), daemon=True))
        if not args.no_mic:
            classifier = None
            if os.path.exists(args.yamnet_model) and os.path.exists(args.yamnet_class_map):
                try:
                    classifier = YamnetClassifier(args.yamnet_model, args.yamnet_class_map, args.yamnet_threshold)
                except Exception as e:
                    log(f"YAMNet unavailable ({e}) — using heuristic")
            device = int(args.mic_device) if args.mic_device and args.mic_device.isdigit() else args.mic_device
            threads.append(threading.Thread(target=audio_loop, args=(counts, stop, classifier, args.onset_db, device), daemon=True))

    for t in threads:
        t.start()

    log(f"device {args.device_id} at {args.lat}, {args.lng} → {args.server} every {args.interval:.0f} s")
    window_start = time.time()
    try:
        while not stop.wait(args.interval):
            now = time.time()
            coughs, sneezes, traffic = counts.take()
            payload = {
                "deviceId": args.device_id, "lat": args.lat, "lng": args.lng,
                "windowSec": round(now - window_start, 1),
                "coughs": coughs, "sneezes": sneezes, "footTraffic": traffic,
            }
            try:
                post(args.server, args.token, payload)
                log(f"sent: {traffic} passers-by, {coughs} coughs, {sneezes} sneezes")
                window_start = now
            except (urllib.error.URLError, OSError) as e:
                detail = e.read().decode(errors="ignore") if isinstance(e, urllib.error.HTTPError) else e
                log(f"upload failed ({detail}) — keeping counts for next try")
                counts.add(coughs=coughs, sneezes=sneezes, foot_traffic=traffic)
                if now - window_start > 3000:  # stay under the server's 1 h window cap
                    window_start = now - args.interval
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        log("stopped")


if __name__ == "__main__":
    sys.exit(main())
