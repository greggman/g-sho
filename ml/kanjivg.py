"""Reads KanjiVG stroke data as polylines in [0, 1] coordinates."""
import functools
import pathlib
import re

from svgpathtools import parse_path

KANJIVG_DIR = pathlib.Path(__file__).resolve().parent.parent / '.cache' / 'kanjivg' / 'kanji'
VIEWBOX = 109.0
PATH_RE = re.compile(r'<path[^>]*\sd="([^"]+)"')


def svg_file(char: str) -> pathlib.Path:
    return KANJIVG_DIR / f'{ord(char):05x}.svg'


@functools.lru_cache(maxsize=None)
def strokes(char: str, points_per_unit: float = 0.5) -> list[list[tuple[float, float]]]:
    """The character's strokes, each sampled into points about every 2 units."""
    text = svg_file(char).read_text(encoding='utf-8')
    out = []
    for d in PATH_RE.findall(text):
        path = parse_path(d)
        n = max(2, int(path.length() * points_per_unit))
        pts = [path.point(i / (n - 1)) for i in range(n)]
        out.append([(p.real / VIEWBOX, p.imag / VIEWBOX) for p in pts])
    return out


def available() -> list[str]:
    """Characters that have KanjiVG base files (not variants)."""
    return sorted(chr(int(p.stem, 16)) for p in KANJIVG_DIR.glob('*.svg') if '-' not in p.stem)
