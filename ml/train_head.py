# Trains a logistic regression on YAMNet scores (cough / sneeze / other) and
# compares it to plain YAMNet with ESC-50's 5 folds. Not used by the app yet.
# usage: python ml/train_head.py
import argparse, json, os
import numpy as np
from sklearn.linear_model import LogisticRegression

CLASSES = ['other', 'cough', 'sneeze']
COUGH, SNEEZE = 42, 44

ap = argparse.ArgumentParser()
here = os.path.dirname(__file__)
ap.add_argument('--features', default=os.path.join(here, 'features.npz'))
ap.add_argument('--out', default=os.path.join(here, 'cough-head.json'))
ap.add_argument('--threshold', type=float, default=0.5)
args = ap.parse_args()

d = np.load(args.features)
X, clip, cat, fold = d['X'], d['clip'], d['cat'], d['fold']
y = np.select([cat == 'coughing', cat == 'sneezing'], [1, 2], 0)

def train(Xtr, ytr):
    # way more "other" windows than coughs/sneezes
    return LogisticRegression(C=0.5, class_weight='balanced', max_iter=3000).fit(Xtr, ytr)

def clip_verdicts(p_cough, p_sneeze, clips, t):
    out = {}
    for c in np.unique(clips):
        m = clips == c
        pc, ps = p_cough[m].max(), p_sneeze[m].max()
        out[c] = 0 if max(pc, ps) < t else (1 if pc >= ps else 2)
    return out

def report(name, verdicts):
    truth = {c: y[clip == c][0] for c in verdicts}
    print(f'\n{name}')
    for k, label in [(1, 'coughs'), (2, 'sneezes'), (0, 'other sounds')]:
        clips = [c for c in verdicts if truth[c] == k]
        got = np.bincount([verdicts[c] for c in clips], minlength=3)
        print(f'  {label:13s} ({len(clips):4d} clips) -> other {got[0]:4d}  cough {got[1]:3d}  sneeze {got[2]:3d}')

base = clip_verdicts(X[:, COUGH], X[:, SNEEZE], clip, 0.3)
report('YAMNet alone (threshold 0.3), all 2000 clips:', base)

cv = {}
for f in range(1, 6):
    m = train(X[fold != f], y[fold != f])
    p = m.predict_proba(X[fold == f])
    cv.update(clip_verdicts(p[:, 1], p[:, 2], clip[fold == f], args.threshold))
report(f'YAMNet + trained head (threshold {args.threshold}), each fold tested unseen:', cv)

m = train(X, y)
json.dump({
    'about': 'Logistic regression on YAMNet scores. Trained by ml/train_head.py on ESC-50.',
    'classes': CLASSES,
    'threshold': args.threshold,
    'weights': np.round(m.coef_, 5).tolist(),
    'bias': np.round(m.intercept_, 5).tolist(),
}, open(args.out, 'w'))
print(f'\nsaved {args.out}')
