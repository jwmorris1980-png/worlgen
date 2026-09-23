"""Equirectangular seam tools.

    python seamfix.py measure pano.png
    python seamfix.py roll    pano.png rolled.png     # seam -> centre of frame
    python seamfix.py unroll  healed.png final.png    # centre -> back to the edge

Why roll instead of blending
----------------------------
An equirectangular panorama is a cylinder: column 0 and column W-1 are
physically adjacent. An image model that was never told this leaves the two
edges unrelated, and MoGe reconstructs that mismatch as a seam through the
world.

The obvious fix - spreading the edge difference across the image as a gradient -
was tried and FAILED, badly. It assumes the mismatch is tonal. On a real
generated panorama the edges differ structurally (blown-out sky against blue sky
and a hillside), so forcing them to match numerically just washes the whole
image out and leaves the structure as wrong as before.

So: no arithmetic. Roll the image by half its width, which moves the seam from
the frame edge to the middle where a diffusion pass can actually see it as one
incoherent region, let the model repaint it, then roll back. The model invents
plausible content across the join, which arithmetic cannot do.

Rolling is exact and lossless - it is a column permutation, and rolling twice by
half the width returns the original image.
"""

import sys
import numpy as np
from PIL import Image


def load(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float32)


def seam_error(a):
    """Mean absolute difference between the wrap-around edges, 0-255 levels."""
    return float(np.abs(a[:, 0, :] - a[:, -1, :]).mean())


def centre_error(a):
    """Same measure taken at the middle of the frame - where a rolled seam sits."""
    w = a.shape[1]
    m = w // 2
    return float(np.abs(a[:, m - 1, :] - a[:, m, :]).mean())


def roll_half(a):
    return np.roll(a, a.shape[1] // 2, axis=1)


def report(a, label):
    print(f"{label:<10} {a.shape[1]} x {a.shape[0]}   "
          f"edge seam {seam_error(a):6.2f}   centre join {centre_error(a):6.2f}")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    cmd, src = sys.argv[1], sys.argv[2]
    dst = sys.argv[3] if len(sys.argv) > 3 else None
    a = load(src)

    if cmd == "measure":
        report(a, "image")
        return 0

    if cmd not in ("roll", "unroll"):
        print(f"unknown command '{cmd}'")
        return 1
    if not dst:
        print("need an output path")
        return 1

    report(a, "in")
    b = roll_half(a)          # roll and unroll are the same operation
    report(b, "out")
    Image.fromarray(np.clip(b, 0, 255).astype(np.uint8)).save(dst)
    print(f"wrote      {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
