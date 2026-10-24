# Runs YAMNet over ESC-50 and saves the 521 scores per window to ml/features.npz
# usage: python ml/extract_features.py --esc50 path/to/ESC-50 --model yamnet.tflite
import argparse, csv, os
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from ai_edge_litert.interpreter import Interpreter

WIN, HOP, SR = 15600, 7680, 16000

ap = argparse.ArgumentParser()
ap.add_argument('--esc50', required=True, help='folder with esc50.csv and audio/')
ap.add_argument('--model', required=True, help='yamnet.tflite (the classification model)')
ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'features.npz'))
args = ap.parse_args()

yamnet = Interpreter(args.model)
yamnet.allocate_tensors()
inp = yamnet.get_input_details()[0]['index']
out = yamnet.get_output_details()[0]['index']

X, clip, cat, fold = [], [], [], []
meta = list(csv.DictReader(open(os.path.join(args.esc50, 'esc50.csv'))))
for i, row in enumerate(meta):
    x, sr = sf.read(os.path.join(args.esc50, 'audio', row['filename']), dtype='float32')
    x = resample_poly(x, SR, sr).astype(np.float32)
    starts = range(0, len(x) - WIN + 1, HOP)
    loud = np.array([np.sqrt(np.mean(x[s:s + WIN] ** 2)) for s in starts])
    for s, rms in zip(starts, loud):
        # skip the silent padding
        if rms < 0.25 * loud.max():
            continue
        yamnet.set_tensor(inp, x[s:s + WIN])
        yamnet.invoke()
        X.append(yamnet.get_tensor(out)[0].copy())
        clip.append(i); cat.append(row['category']); fold.append(int(row['fold']))
    if i % 200 == 0:
        print(f'{i}/{len(meta)} clips')

np.savez_compressed(args.out, X=np.array(X, np.float32), clip=np.array(clip),
                    cat=np.array(cat), fold=np.array(fold))
print(f'saved {len(X)} windows to {args.out}')
