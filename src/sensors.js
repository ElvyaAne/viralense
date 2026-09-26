// Validation for batches posted by the Raspberry Pi sensor client.

const MAX_WINDOW_SEC = 3600;
const MAX_COUNT      = 100_000;

function isCount(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;
}

export function validateSensorEvent(body) {
  const { deviceId, lat, lng, windowSec, coughs, sneezes, footTraffic } = body ?? {};
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 64)
    return 'deviceId must be a non-empty string (max 64 chars)';
  if (typeof lat !== 'number' || lat < -90 || lat > 90) return 'lat must be a number in [-90, 90]';
  if (typeof lng !== 'number' || lng < -180 || lng > 180) return 'lng must be a number in [-180, 180]';
  if (typeof windowSec !== 'number' || windowSec <= 0 || windowSec > MAX_WINDOW_SEC)
    return `windowSec must be a number in (0, ${MAX_WINDOW_SEC}]`;
  if (!isCount(coughs))      return 'coughs must be a non-negative integer';
  if (!isCount(sneezes))     return 'sneezes must be a non-negative integer';
  if (!isCount(footTraffic)) return 'footTraffic must be a non-negative integer';
  return null;
}

// If SENSOR_TOKEN is set, devices must send it in the x-device-token header.
export function checkDeviceToken(headerValue, expected) {
  if (!expected) return true;
  return typeof headerValue === 'string' && headerValue === expected;
}
