#!/usr/bin/env python3
"""Sub2API "human verification" solver (threerouter.com and siblings).

Reads the challenge JSON of `POST /api/v1/auth/captcha/challenge` on stdin and
prints the payload for `POST /api/v1/auth/captcha/verify` on stdout.

  python captcha-solve.py < challenge.json

Two modes are served by this panel (both measured live 2026-10-20, mix ~4/10
slider, ~6/10 image_click):

  slider
      bg_image/piece_image (320x160) + piece_y. The notch in the background is
      the piece content times a constant (Pearson r = 0.9997, ratio CV 0.004),
      so the answer is plain template correlation — no edge heuristics.

  image_click
      an image (320x200), a `prompt` of {shape,color} pairs in click order and a
      click_count. Shapes are painted translucent over a photo, so the fill is
      *not* the palette RGB; inside one shape it is flat though (the red square
      of one challenge is exactly (220,54,54) for all 2179 px) while the
      constant shifts per challenge with the photo. Detection therefore keys on
      the image's own dominant saturated fills, the palette colour comes from
      the fill's hue, and the shape from IoU against rotated ideal templates
      (circle/square/hexagon/triangle/star). Several shapes may share a colour
      (a big square and a small star), so the prompt's shape name is matched,
      with "largest blob of that colour" as the fallback.
"""
import base64
import io
import json
import math
import sys

import cv2
import numpy as np
from PIL import Image

PALETTE = {
    'red': (0xEF, 0x44, 0x44),
    'blue': (0x3B, 0x82, 0xF6),
    'green': (0x22, 0xC5, 0x5E),
    'yellow': (0xEA, 0xB3, 0x08),
    'purple': (0xA8, 0x55, 0xF7),
}
SHAPES = ('circle', 'square', 'hexagon', 'triangle', 'star')
NORM = 64
MIN_PEAK = 250           # a flat fill that carries a shape
MIN_AREA = 350           # shapes are 30-50 px across
MAX_AREA = 4000          # a shape never fills a background-sized region
FILL_TOL = 14            # the fill is flat; only the edges blend
SAT_MIN = 90

_H = cv2.cvtColor(np.uint8([[list(v) for v in PALETTE.values()]]), cv2.COLOR_RGB2HSV)[0]
HUE = {name: int(h) for (name, _), h in zip(PALETTE.items(), _H[:, 0])}


def decode(b64):
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGB')).astype(np.int16)


def hue_of(rgb):
    return int(cv2.cvtColor(np.uint8([[list(rgb)]]), cv2.COLOR_RGB2HSV)[0, 0, 0])


def hue_distance(a, b):
    d = abs(int(a) - int(b))
    return min(d, 180 - d)


def color_of_rgb(rgb):
    h = hue_of(rgb)
    best, score = '?', 1e9
    for name, hh in HUE.items():
        d = hue_distance(h, hh)
        if d < score:
            best, score = name, d
    return best, score


# ---------------------------------------------------------------- slider

def solve_slider(data):
    bg = decode(data['bg_image'])
    piece = np.asarray(Image.open(io.BytesIO(base64.b64decode(data['piece_image']))).convert('RGBA'))
    y = int(data['piece_y'])
    ph, pw = piece.shape[:2]
    mask = piece[..., 3] == 255                      # the opaque body, not the shadow skirt
    if not mask.any():
        mask = piece[..., 3] > 0
    ref = piece[..., :3].astype(np.float64)[mask].ravel()
    if ref.std() < 1e-6:
        return None
    best = (-2.0, 0)
    for x in range(0, bg.shape[1] - pw + 1):
        patch = bg[y:y + ph, x:x + pw]
        if patch.shape[:2] != (ph, pw):
            continue
        cand = patch.astype(np.float64)[mask].ravel()
        if cand.std() * ref.std() < 1e-6:
            continue
        r = float(np.corrcoef(ref, cand)[0, 1])
        if r > best[0]:
            best = (r, x)
    if best[0] < 0.9:
        return None
    drop_x = best[1]
    return {'drop_x': drop_x, 'trajectory': human_track(drop_x, y), '_r': round(best[0], 5)}


def human_track(drop_x, piece_y, steps=26, duration=900):
    """Ease-in/out drag with a small overshoot then settle — monotonic in t."""
    pts = []
    for i in range(steps + 1):
        f = i / steps
        x = drop_x * (0.5 - 0.5 * math.cos(math.pi * min(1.0, f * 0.94)))
        if 0.88 < f < 0.965:
            x = drop_x * (1 + 0.012 * math.sin((f - 0.88) / 0.085 * math.pi))
        x += math.sin(i * 1.7) * 0.6
        pts.append({'x': round(max(0.0, min(x, drop_x + 3)), 2),
                    'y': piece_y + round(math.sin(i * 0.9) * 0.5, 2),
                    't': int(f * duration)})
    if pts:
        pts[-1] = {'x': drop_x, 'y': piece_y, 't': duration}
    return pts


# ------------------------------------------------------------ image_click

def _template(name, size=NORM):
    """Ideal silhouette of `name` filling the whole canvas (bbox-normalised)."""
    c = np.zeros((size, size), np.uint8)
    ctr = (size // 2, size // 2)
    if name == 'square':
        c[:] = 1
    elif name == 'circle':
        cv2.ellipse(c, ctr, (size // 2, size // 2), 0, 0, 360, 1, -1)
    elif name == 'hexagon':
        pts = [[ctr[0] + (size // 2) * math.cos(math.pi / 3 * i),
                ctr[1] + (size // 2) * math.sin(math.pi / 3 * i)] for i in range(6)]
        cv2.fillPoly(c, [np.array(pts, np.int32)], 1)
    elif name == 'triangle':
        cv2.fillPoly(c, [np.array([[size // 2, 0], [0, size - 1], [size - 1, size - 1]], np.int32)], 1)
    elif name == 'star':
        pts = []
        for i in range(10):
            r = (size // 2) if i % 2 == 0 else (size // 2) * 0.42
            a = -math.pi / 2 + math.pi / 5 * i
            pts.append([ctr[0] + r * math.cos(a), ctr[1] + r * math.sin(a)])
        cv2.fillPoly(c, [np.array(pts, np.int32)], 1)
    return c.astype(bool)


TEMPLATES = {name: _template(name) for name in SHAPES}


def _normalise(mask):
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return None
    sub = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8)
    return cv2.resize(sub, (NORM, NORM), interpolation=cv2.INTER_NEAREST).astype(bool)


def classify_shape(mask):
    """Best (shape, iou) over a 15-degree rotation sweep."""
    h, w = mask.shape
    scores = {}
    for angle in range(0, 360, 15):
        M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        rot = cv2.warpAffine(mask.astype(np.uint8), M, (w, h), flags=cv2.INTER_NEAREST).astype(bool)
        cand = _normalise(rot)
        if cand is None:
            continue
        for name, tpl in TEMPLATES.items():
            union = np.logical_or(cand, tpl).sum()
            if not union:
                continue
            iou = float(np.logical_and(cand, tpl).sum()) / union
            if iou > scores.get(name, 0.0):
                scores[name] = iou
    if not scores:
        return '?', 0.0
    return max(scores.items(), key=lambda kv: kv[1])


def dominant_fills(image, min_peak=MIN_PEAK, limit=12):
    """Flat saturated colours carrying a shape, largest first."""
    cols, counts = np.unique(image.reshape(-1, 3), axis=0, return_counts=True)
    out = []
    for i in np.argsort(-counts)[:400]:
        if int(counts[i]) < min_peak:
            break
        rgb = cols[i].astype(int)
        if cv2.cvtColor(np.uint8([[list(rgb)]]), cv2.COLOR_RGB2HSV)[0, 0, 1] < SAT_MIN:
            continue
        if any(int(np.abs(rgb - o['rgb']).max()) <= FILL_TOL for o in out):
            continue
        out.append({'rgb': rgb, 'count': int(counts[i])})
        if len(out) >= limit:
            break
    return out


def shape_blobs(image):
    """Every shape-shaped blob: colour (palette name) + shape + centre."""
    out = []
    for peak in dominant_fills(image):
        rgb = peak['rgb'].astype(np.int16)
        mask = (np.abs(image - rgb).max(axis=2) <= FILL_TOL).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        n, labels, stats, cents = cv2.connectedComponentsWithStats(mask, 8)
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area < MIN_AREA or area > MAX_AREA:
                continue
            comp = (labels == i).astype(np.uint8)
            ff = comp.copy()
            pad = np.zeros((comp.shape[0] + 2, comp.shape[1] + 2), np.uint8)
            cv2.floodFill(ff, pad, (0, 0), 1)
            filled = comp | (1 - ff)                 # occlusion can hole the blob
            shape, iou = classify_shape(filled)
            color, hue_d = color_of_rgb(peak['rgb'])
            out.append({'shape': shape, 'iou': round(iou, 4), 'color': color, 'hue_dist': hue_d,
                        'x': float(cents[i][0]), 'y': float(cents[i][1]), 'area': area,
                        'bbox': [int(stats[i, 0]), int(stats[i, 1]), int(stats[i, 2]), int(stats[i, 3])]})
    return out


def solve_image_click(data):
    img = decode(data['image'])
    prompt = data.get('prompt') or []
    blobs = shape_blobs(img)
    clicks = []
    used = set()
    for want in prompt:
        color = str(want.get('color', '')).lower()
        shape = str(want.get('shape', '')).lower()
        same = [b for b in blobs if b['color'] == color and (round(b['x']), round(b['y'])) not in used]
        if not same:
            return None
        picked = [b for b in same if b['shape'] == shape]
        if not picked:
            picked = same                          # misclassification: take the colour's main blob
        picked.sort(key=lambda b: -b['area'])
        pick = picked[0]
        used.add((round(pick['x']), round(pick['y'])))
        clicks.append({'x': round(pick['x'], 2), 'y': round(pick['y'], 2)})
    if len(clicks) != int(data.get('click_count') or len(prompt)):
        return None
    return {'clicks': clicks, '_blobs': [[b['color'], b['shape'], b['iou'], b['area']] for b in blobs]}


def main():
    try:
        challenge = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'bad input: {e}'}))
        return 1
    if 'data' in challenge and isinstance(challenge['data'], dict):
        challenge = challenge['data']
    mode = str(challenge.get('mode') or '')
    try:
        if mode == 'slider':
            payload = solve_slider(challenge.get('slider') or {})
        elif mode == 'image_click':
            payload = solve_image_click(challenge.get('image_click') or {})
        else:
            payload = None
    except Exception as e:
        print(json.dumps({'ok': False, 'mode': mode, 'error': str(e)[:200]}))
        return 1
    if not payload:
        print(json.dumps({'ok': False, 'mode': mode, 'error': 'no answer'}))
        return 1
    payload['ok'] = True
    payload['mode'] = mode
    print(json.dumps(payload))
    return 0


if __name__ == '__main__':
    sys.exit(main())
