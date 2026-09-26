// Viralense foot-traffic counter
//
// Wiring (IR obstacle / break-beam module from the Arduino kit):
//   VCC -> 5V, GND -> GND, OUT -> D2
// Most kit modules pull OUT LOW while something is in front of the beam.
// If yours is the opposite, set ACTIVE_LOW to false.
//
// Serial protocol (9600 baud) read by devices/pi/sensor_client.py:
//   PASS      one person walked past
//   HB <n>    heartbeat every 5 s with the running total

const int  SENSOR_PIN     = 2;
const bool ACTIVE_LOW     = true;
const unsigned long MIN_BLOCK_MS  = 40;   // ignore flicker shorter than this
const unsigned long REFRACTORY_MS = 350;  // one person can't count twice this fast
const unsigned long HEARTBEAT_MS  = 5000;

bool          blocked      = false;
unsigned long blockStart   = 0;
unsigned long lastPass     = 0;
unsigned long lastBeat     = 0;
unsigned long total        = 0;

bool beamBlocked() {
  int v = digitalRead(SENSOR_PIN);
  return ACTIVE_LOW ? (v == LOW) : (v == HIGH);
}

void setup() {
  pinMode(SENSOR_PIN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("HB 0");
}

void loop() {
  unsigned long now = millis();
  bool b = beamBlocked();
  digitalWrite(LED_BUILTIN, b ? HIGH : LOW);

  if (b && !blocked) {
    blocked = true;
    blockStart = now;
  } else if (!b && blocked) {
    blocked = false;
    // Count on release so someone standing in the beam counts once
    if (now - blockStart >= MIN_BLOCK_MS && now - lastPass >= REFRACTORY_MS) {
      lastPass = now;
      total++;
      Serial.println("PASS");
    }
  }

  if (now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now;
    Serial.print("HB ");
    Serial.println(total);
  }
  delay(5);
}
