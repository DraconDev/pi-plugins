#!/usr/bin/env python3
"""Rasterise a review-dialog frame into a terminal screenshot.

The frame comes from the real wizard (`review-shot.mjs`); this only draws it:
a monospace font on a terminal background, the real inline image pasted at the
cell box the Kitty escape asked for. Nothing here invents UI - if a line is in
the screenshot, the dialog rendered it.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BG = (18, 20, 26)
FG = (208, 214, 224)
DIM = (128, 136, 150)
ACCENT = (126, 214, 190)
WARN = (232, 176, 108)
HEADER = (176, 186, 202)
PAD = 18
TITLEBAR = 34


def find_font(size):
    candidates = [
        "/nix/store/dbr99aycxmaddpa5ciqk724g59rqkgyg-dejavu-fonts-2.37/share/fonts/truetype/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def line_role(text):
    """Colour a line by what it is, so a screenshot reads like a terminal."""
    stripped = text.strip()
    if not stripped:
        return "empty"
    if stripped.startswith(">"):
        return "selected"
    if "↑↓" in stripped or "Enter to submit" in stripped or "Esc to cancel" in stripped:
        return "help"
    if stripped.startswith("Preview:") or stripped.startswith("Current answer"):
        return "accent"
    if "•" in stripped and len(stripped) < 90 and not stripped.startswith(" "):
        return "muted"
    return "normal"


def main():
    shot = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    font_size = 17
    font = find_font(font_size)
    bold = font
    advance = font.getlength("M")
    cell_h = font_size + 6
    columns = shot.get("columns", 110)
    lines = shot.get("lines", [])
    images = shot.get("images", [])

    width_px = int(PAD * 2 + advance * columns)
    height_px = TITLEBAR + PAD * 2 + cell_h * len(lines)
    canvas = Image.new("RGB", (width_px, height_px), BG)
    draw = ImageDraw.Draw(canvas)

    # Title bar, so a screenshot dropped into a document says what it is.
    draw.rectangle([0, 0, width_px, TITLEBAR], fill=(28, 31, 39))
    for index, colour in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        cx = 16 + index * 16
        draw.ellipse([cx, 11, cx + 10, 21], fill=colour)
    title_font = find_font(13)
    draw.text((72, 9), shot.get("title", ""), font=title_font, fill=HEADER)
    subtitle = shot.get("subtitle", "")
    if subtitle:
        draw.text((width_px - 8 - title_font.getlength(subtitle), 9), subtitle, font=title_font, fill=DIM)

    colours = {"normal": FG, "selected": ACCENT, "help": DIM, "accent": WARN, "muted": DIM, "empty": FG}
    y = TITLEBAR + PAD
    for row, text in enumerate(lines):
        role = line_role(text)
        if role != "empty":
            draw.text((PAD, y), text, font=bold if role == "selected" else font, fill=colours[role])
        y += cell_h

    # The inline images, at the cell box the terminal was asked to reserve.
    for image in images:
        path = Path(image.get("path", ""))
        if not path.exists():
            continue
        art = Image.open(path).convert("RGB")
        cell_w = int(advance)
        box_w = max(1, int(image.get("columns", 31))) * cell_w
        box_h = max(1, int(image.get("rows", 16))) * cell_h
        scale = min(box_w / art.width, box_h / art.height)
        size = (max(1, int(art.width * scale)), max(1, int(art.height * scale)))
        art = art.resize(size, Image.LANCZOS)
        x = PAD + int(image.get("column", 0)) * cell_w
        top = TITLEBAR + PAD + int(image.get("row", 0)) * cell_h
        canvas.paste(art, (x, top))

    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(json.dumps({"out": str(out), "width": width_px, "height": height_px, "images": len(images)}))


if __name__ == "__main__":
    main()
