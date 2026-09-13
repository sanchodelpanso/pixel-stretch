"""Align the supplied cutout to the photo; report foreground overlap.
Usage: python scripts/evaluate-pisa.py [source.jpg]
Requires opencv-python-headless. Reference is white-backed, not a pixel-perfect matte.
"""
import cv2
import numpy as np
import json
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
source = cv2.imread(sys.argv[1] if len(sys.argv) > 1 else '/tmp/pixelstretch-piza.jpg')
source = cv2.resize(source, (1013, 1350))
reference = cv2.imread(str(root / 'piza_selected.png'))
sift = cv2.SIFT_create()
k1, d1 = sift.detectAndCompute(cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY), None)
k2, d2 = sift.detectAndCompute(cv2.cvtColor(source, cv2.COLOR_BGR2GRAY), None)
matches = cv2.BFMatcher().knnMatch(d1, d2, k=2)
good = [m for m,n in matches if m.distance < 0.7*n.distance]
assert len(good) > 20, 'Not enough matches to align reference'
h, inliers = cv2.findHomography(np.float32([k1[m.queryIdx].pt for m in good]), np.float32([k2[m.trainIdx].pt for m in good]), cv2.RANSAC, 3)
assert np.count_nonzero(inliers) > 20, 'Reference alignment failed'
# White background extraction is approximate; tiny highlights and feathering differ.
reference_mask = (np.min(reference, axis=2) < 245).astype(np.uint8)*255
reference_mask = cv2.morphologyEx(reference_mask, cv2.MORPH_CLOSE, np.ones((3,3),np.uint8))
aligned = cv2.warpPerspective(reference_mask, h, (1013,1350)) > 127
cv2.imwrite(str(root/'artifacts/segmentation/reference-aligned-mask.png'), aligned.astype(np.uint8)*255)
metrics = {'alignment_inliers': int(np.count_nonzero(inliers)), 'caveat': 'Approximate overlap after SIFT/RANSAC alignment of the white-backed reference; one image, not a general benchmark.', 'models': {}}
names = ['rmbg','birefnet']
if (root/'artifacts/segmentation/pisa-browser-cutout.png').exists():
    names.append('browser')
for name in names:
    predicted = (cv2.imread(str(root/'artifacts/segmentation/pisa-browser-cutout.png'), cv2.IMREAD_UNCHANGED)[:,:,3]
                 if name == 'browser' else cv2.imread(str(root/f'artifacts/segmentation/{name}-mask.png'), 0))
    predicted = cv2.resize(predicted,(1013,1350)) > 127
    intersection = np.count_nonzero(predicted & aligned)
    metrics['models'][name] = {'iou': intersection/np.count_nonzero(predicted | aligned), 'precision': intersection/np.count_nonzero(predicted), 'recall': intersection/np.count_nonzero(aligned)}
(root/'artifacts/segmentation/metrics.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(json.dumps(metrics,indent=2))
