#!/usr/bin/env python3
"""Rasterize the checked-in TUI text snapshot for native visual inspection."""
from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / "tests" / "fixtures" / "tui-smoke.txt"
DEFAULT_OUTPUT = ROOT / "tests" / "fixtures" / "tui-smoke.png"
DEFAULT_FONT = Path("/nix/store/b7ybgcl00ak8q66bc0w15vfnyly4g13k-hack-font-3.003/share/fonts/truetype/Hack-Regular.ttf")
WIDTH = 1800
MARGIN = 48
LINE_HEIGHT = 28
BACKGROUND = (15, 20, 31)
FOREGROUND = (222, 230, 240)
ACCENT = (126, 211, 255)
BORDER = (71, 85, 105)
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")


def font(size: int = 21) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if DEFAULT_FONT.exists():
        return ImageFont.truetype(str(DEFAULT_FONT), size)
    return ImageFont.load_default()


def render(input_path: Path, output_path: Path) -> tuple[int, int, int]:
    text = ANSI.sub("", input_path.read_text(encoding="utf-8"))
    lines = text.splitlines() or [""]
    chosen_font = font()
    line_height = LINE_HEIGHT
    height = MARGIN * 2 + line_height * len(lines)
    image = Image.new("RGB", (WIDTH, height), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((12, 12, WIDTH - 12, height - 12), radius=18, outline=BORDER, width=2)
    y = MARGIN
    for line in lines:
        color = ACCENT if line.startswith(("TUI evidence", "Visual evidence")) else FOREGROUND
        draw.text((MARGIN, y), line, font=chosen_font, fill=color)
        y += line_height
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, format="PNG", optimize=True)
    return image.width, image.height, output_path.stat().st_size


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    width, height, size = render(args.input.resolve(), args.output.resolve())
    print({"width": width, "height": height, "bytes": size, "output": str(args.output.resolve())})


if __name__ == "__main__":
    main()
