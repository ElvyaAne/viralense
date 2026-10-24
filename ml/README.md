# Cough & sneeze model: how it works and how to improve it

The mic listener in `public/index.html` decides what a sound was in two steps,
entirely inside the browser tab:

1. **Is something happening?** A loudness check finds short bursts that stand
   out from the room's background noise. This is cheap, so it runs all the time.
2. **What was it?** The ~1 s of audio around the burst goes to
   [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet),
   a small model Google trained on millions of YouTube clips
   ([AudioSet](https://research.google.com/audioset/)). It gives a 0–1 score for
   521 sound types; we read two of them, `Cough` (index 42) and `Sneeze` (44).
   If the higher one is at least `MIC.ML_THRESHOLD` (0.3), we count it.

YAMNet runs through [MediaPipe Audio Classifier](https://ai.google.dev/edge/mediapipe/solutions/audio/audio_classifier/web_js),
pinned to 0.10.35 because the 1.x releases send usage logs to Google. If the
model can't load (no internet), the listener falls back to the old
loudness/pitch rules.

## How good is it?

Tested on [ESC-50](https://github.com/karolpiczak/ESC-50) (2,000 five-second
clips in 50 categories, 40 each), counting a clip by its best ~1 s window:

| Real sound | Counted as cough | Counted as sneeze | Ignored |
|---|---|---|---|
| 40 cough clips | **34** | 2 | 4 |
| 40 sneeze clips | 7 | **31** | 2 |
| 1,920 other clips (dogs, rain, knocks, laughing, typing…) | 7 | 12 | **1,901** |

So roughly 85% of coughs and 78% of sneezes are caught, and 1% of other sounds
slip through (mostly breathing and laughing). The old rules, on a recording
of 8 coughs and 8 sneezes played into a browser, called most coughs
"sneezes"; YAMNet got every cough right and 6 of 8 sneezes.

## Try training your own

`extract_features.py` and `train_head.py` are a small transfer-learning
experiment: keep YAMNet as the "ears" and train a logistic regression on its
521 scores to answer cough / sneeze / other.

```bash
pip install -r ml/requirements.txt
git clone https://github.com/karolpiczak/ESC-50 /tmp/ESC-50
curl -L -o /tmp/yamnet.tflite \
  https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite
python ml/extract_features.py --esc50 /tmp/ESC-50 --model /tmp/yamnet.tflite
python ml/train_head.py
```

Result with 5-fold cross-validation: the head catches more sneezes (37/40
instead of 31) but wrongly flags 114 of the 1,920 other clips instead of 19.
That trade isn't worth it, so the app keeps plain YAMNet. The lesson: with only
40 examples per class, a pretrained model's built-in labels beat anything we
can train on top.

## Next steps

- **More data.** [COUGHVID](https://zenodo.org/records/4048312) (~25k cough
  recordings) and [FSD50K](https://zenodo.org/records/4060432) (thousands of
  labelled coughs, sneezes, speech and room sounds) would give the trained
  head enough to learn from.
- **Your own room.** Record a few minutes of normal laptop sounds (typing,
  talking, chair creaks) plus some real coughs, and add them to the test set.
  Real-world mistakes come from sounds the benchmark doesn't have.
- **Tune the threshold.** Raising `MIC.ML_THRESHOLD` means fewer false alarms
  and more missed coughs; lowering it does the opposite.

ESC-50 is licensed CC BY-NC 3.0, so use it for learning and testing, not to
train a model for a commercial product.
