"""Render a before/after preview of the brand triangle (build helper, not shipped)."""
import os
from PIL import Image, ImageDraw

BG = (11, 11, 13)
ACCENT2 = (229, 57, 53)      # --accent-2, the .brand colour
MUTE = (163, 160, 154)
DIM = (111, 109, 105)
HI = (240, 196, 25)
PANEL = (20, 20, 24)

VIEW = 32        # svg viewBox is 0 0 32 32
SCALE = 9        # logical px -> render px
PAD = 18
DOWN = 4         # downscale factor, gives antialiased edges


def render(up):
    """Draw the mark exactly as the SVG path describes it."""
    size = VIEW * SCALE + PAD * 2
    im = Image.new('RGB', (size, size), PANEL)
    d = ImageDraw.Draw(im)

    def X(v):
        return PAD + v * SCALE

    def Y(v):
        return PAD + v * SCALE

    if up:
        # <path d="M16 4 L28 28 H4 Z">  apex on top
        pts = [(X(16), Y(4)), (X(28), Y(28)), (X(4), Y(28))]
        circle_cy = 19
    else:
        # <path d="M16 28 L28 4 H4 Z">  apex at the bottom
        pts = [(X(16), Y(28)), (X(28), Y(4)), (X(4), Y(4))]
        circle_cy = 13

    d.line(pts + [pts[0]], fill=ACCENT2, width=int(2.4 * SCALE), joint='curve')
    r = 3 * SCALE
    d.ellipse([X(16) - r, Y(circle_cy) - r, X(16) + r, Y(circle_cy) + r], fill=ACCENT2)

    return im.resize((size // DOWN, size // DOWN), Image.LANCZOS)


old, new = render(True), render(False)

gap = 26
W = old.width + new.width + gap * 3
H = max(old.height, new.height) + 76
out = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(out)
out.paste(old, (gap, 52))
out.paste(new, (gap * 2 + old.width, 52))

d.text((gap + old.width // 2 - 44, 22), 'BEFORE apex up', fill=MUTE)
d.text((gap * 2 + old.width + new.width // 2 - 50, 22), 'AFTER inverted', fill=HI)
d.text((gap + old.width // 2 - 30, 52 + old.height + 12), 'circle low', fill=DIM)
d.text((gap * 2 + old.width + new.width // 2 - 34, 52 + new.height + 12), 'circle high', fill=DIM)

os.makedirs('docs-preview', exist_ok=True)
path = os.path.join('docs-preview', 'brand-triangle.png')
out.save(path)
print('wrote', path, out.size)
