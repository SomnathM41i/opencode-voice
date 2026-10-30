#!/usr/bin/env python3
"""Draws the OpenCode Voice app icons. No external assets, only Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "public" / "icons"
ICONS.mkdir(parents=True, exist_ok=True)

S = 1024


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def background() -> Image.Image:
    """Deep navy gradient with a soft blue glow, full-bleed."""
    img = Image.new("RGBA", (S, S))
    draw = ImageDraw.Draw(img)

    for y in range(S):
        t = y / (S - 1)
        draw.line(
            [(0, y), (S, y)],
            fill=(
                lerp(13, 6, t),
                lerp(22, 9, t),
                lerp(38, 14, t),
                255,
            ),
        )

    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        [S * 0.16, S * 0.02, S * 0.84, S * 0.68],
        fill=(47, 107, 214, 175),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.17))
    img = Image.alpha_composite(img, glow)

    teal = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(teal)
    td.ellipse(
        [S * 0.45, S * 0.62, S * 1.12, S * 1.15],
        fill=(32, 190, 140, 55),
    )
    teal = teal.filter(ImageFilter.GaussianBlur(S * 0.2))
    return Image.alpha_composite(img, teal)


def draw_mark(img: Image.Image, scale: float) -> Image.Image:
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = S / 2, S / 2

    # Concentric sound rings, kept inside the maskable safe zone.
    for radius, alpha, width in ((S * 0.30, 26, 9), (S * 0.37, 13, 7)):
        d.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=(235, 244, 255, alpha),
            width=width,
        )

    m = scale
    cap_w = 150 * m
    cap_h = 260 * m
    top = cy - 215 * m
    bottom = top + cap_h
    d.rounded_rectangle(
        [cx - cap_w / 2, top, cx + cap_w / 2, bottom],
        radius=cap_w / 2,
        fill=(247, 250, 255, 255),
    )

    arc_w = 36 * m
    arc_box = [
        cx - 190 * m,
        cy - 150 * m,
        cx + 190 * m,
        cy + 145 * m,
    ]
    d.arc(arc_box, start=0, end=180, fill=(247, 250, 255, 255), width=round(arc_w))

    stem_y = cy + 145 * m
    d.line(
        [(cx, stem_y), (cx, stem_y + 85 * m)],
        fill=(247, 250, 255, 255),
        width=round(arc_w),
    )
    d.line(
        [(cx - 105 * m, stem_y + 92 * m), (cx + 105 * m, stem_y + 92 * m)],
        fill=(247, 250, 255, 255),
        width=round(arc_w),
    )

    # Soft drop shadow under the mark.
    shadow = layer.filter(ImageFilter.GaussianBlur(18 * m))
    shadow.putalpha(shadow.getchannel("A").point(lambda v: int(v * 0.35)))
    img = Image.alpha_composite(img, shadow)
    return Image.alpha_composite(img, layer)


def main() -> None:
    base = background()

    standard = draw_mark(base.copy(), 1.0)
    maskable = draw_mark(base.copy(), 0.8)

    standard.resize((512, 512), Image.LANCZOS).save(ICONS / "icon-512.png")
    standard.resize((192, 192), Image.LANCZOS).save(ICONS / "icon-192.png")
    standard.resize((96, 96), Image.LANCZOS).save(ICONS / "icon-96.png")
    maskable.resize((512, 512), Image.LANCZOS).save(ICONS / "icon-maskable-512.png")
    standard.resize((180, 180), Image.LANCZOS).save(ICONS / "apple-touch-icon.png")

    # Next.js picks these up automatically as the favicon and app icon.
    standard.resize((512, 512), Image.LANCZOS).save(ROOT / "src" / "app" / "icon.png")
    standard.resize((64, 64), Image.LANCZOS).save(
        ROOT / "src" / "app" / "favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )

    print("wrote icons to", ICONS)


if __name__ == "__main__":
    main()
