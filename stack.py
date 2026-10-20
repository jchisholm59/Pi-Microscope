"""Focus stacking for Pi-Microscope.

A microscope's depth of field is a fraction of a millimetre, so one frame is never sharp all over. Sweep the focus
through the subject, keep a frame every step, and this merges them into one all-in-focus image:

1. Alignment: focusing changes the magnification a little ("focus breathing") and the stage can creep, so each frame
   is registered to the middle frame with OpenCV's ECC (affine) on a half-size greyscale copy.
2. Fusion: per pixel, each frame's weight is its local contrast (absolute Laplacian, smoothed) raised to a power, so
   the sharpest frame dominates but the transitions stay soft (no hard seams or halos from per-pixel switching).
   Weighted sums are accumulated frame by frame, so memory stays at a few full-size buffers however many frames.
"""
import cv2
import numpy as np


def sharpness_map(gray, blur=5):
    lap = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    return cv2.GaussianBlur(np.abs(lap), (0, 0), blur)


def align(ref_small, img, scale, iterations=60):
    """Affine warp that maps img onto the reference (found at reduced size, applied at full size)."""
    g = cv2.cvtColor(cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, iterations, 1e-5)
        _, warp = cv2.findTransformECC(ref_small, g, warp, cv2.MOTION_AFFINE, crit, None, 5)
    except cv2.error:
        return img, False  # no convergence: use the frame as it is
    warp[:, 2] /= scale
    h, w = img.shape[:2]
    out = cv2.warpAffine(img, warp, (w, h), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT)
    return out, True


def stack(frames, progress=None, power=4.0, do_align=True):
    """frames: list of BGR uint8 images (same size). Returns (result BGR uint8, depth map uint8, info dict)."""
    n = len(frames)
    if n == 0:
        raise ValueError('no frames')
    h, w = frames[0].shape[:2]
    scale = min(1.0, 640.0 / max(w, h))  # alignment at ~640 px wide: ECC is sub-pixel, so this is plenty
    ref = frames[n // 2]
    ref_small = cv2.cvtColor(cv2.resize(ref, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    acc = np.zeros((h, w, 3), np.float32)
    wsum = np.zeros((h, w), np.float32)
    best = np.zeros((h, w), np.float32)
    depth = np.zeros((h, w), np.uint8)
    aligned_ok = 0
    for i, f in enumerate(frames):
        if do_align and i != n // 2:
            f, ok = align(ref_small, f, scale)
            aligned_ok += ok
        gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        s = sharpness_map(gray)
        wgt = (s + 1e-3) ** power
        acc += f.astype(np.float32) * wgt[..., None]
        wsum += wgt
        better = s > best
        best[better] = s[better]
        depth[better] = int(255 * i / max(1, n - 1))
        if progress:
            progress(i + 1, n)
    out = (acc / wsum[..., None]).clip(0, 255).astype(np.uint8)
    return out, depth, {'frames': n, 'aligned': aligned_ok + 1 if do_align else 0}


def frame_sharpness(gray):
    """One number for how sharp a frame is (variance of the Laplacian)."""
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())
