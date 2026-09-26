// Scoring for self-reported symptoms (no camera needed).
// Weights are on the same scale as score.js so both sources can share a map.

export const SYMPTOM_WEIGHTS = Object.freeze({
  fever:               2,
  shortness_of_breath: 2,
  cough:               1,
  sore_throat:         1,
  sneezing:            1,
  runny_nose:          1,
  fatigue:             1,
  body_aches:          1,
  headache:            1,
  loss_of_taste_smell: 2,
});

export const SYMPTOM_LABELS = Object.freeze({
  fever:               'Fever or chills',
  shortness_of_breath: 'Shortness of breath',
  cough:               'Cough',
  sore_throat:         'Sore throat',
  sneezing:            'Sneezing',
  runny_nose:          'Runny or stuffy nose',
  fatigue:             'Unusual fatigue',
  body_aches:          'Body aches',
  headache:            'Headache',
  loss_of_taste_smell: 'Loss of taste or smell',
});

// A report at or above this score is stored on the map.
export const STORE_MIN_SCORE = 2;
// Score at which a report counts as high risk.
export const HIGH_RISK_SCORE = 4;

export function validateSymptomReport(body) {
  const { userId, lat, lng, symptoms } = body ?? {};
  if (!userId || typeof userId !== 'string') return 'userId must be a non-empty string';
  if (typeof lat !== 'number' || lat < -90 || lat > 90) return 'lat must be a number in [-90, 90]';
  if (typeof lng !== 'number' || lng < -180 || lng > 180) return 'lng must be a number in [-180, 180]';
  if (!Array.isArray(symptoms)) return 'symptoms must be an array';
  const unknown = symptoms.filter(s => !(s in SYMPTOM_WEIGHTS));
  if (unknown.length) return `unknown symptoms: ${unknown.join(', ')}`;
  return null;
}

export function scoreSymptoms(symptoms) {
  const unique = [...new Set(symptoms)];
  const score = unique.reduce((sum, s) => sum + (SYMPTOM_WEIGHTS[s] ?? 0), 0);
  return {
    score,
    store:    score >= STORE_MIN_SCORE,
    highRisk: score >= HIGH_RISK_SCORE,
    reasons:  unique.map(s => SYMPTOM_LABELS[s]),
  };
}
