"""Render the molexMedia app and tray icon from the design tokens.

A walnut squircle with a lighter walnut rim holds seven brass equalizer bars
whose cream tops form an M. Colors come from src/renderer/src/styles/tokens.css.

Writes build/icon.png and resources/icon.png at 512 px, and build/icon.ico with
every Windows shell size. Frames up to 64 px are drawn on whole pixels so the
taskbar and Explorer renders stay sharp.

Usage: python generate-icon.py (requires Pillow)
"""

import math
import os
import re

import PIL
from PIL import Image, ImageChops, ImageDraw, PngImagePlugin

ROOT = os.path.dirname(os.path.abspath(__file__))
TOKENS = os.path.join(ROOT, 'src', 'renderer', 'src', 'styles', 'tokens.css')
PNG_OUTPUTS = [
    os.path.join(ROOT, 'build', 'icon.png'),
    os.path.join(ROOT, 'resources', 'icon.png'),
]
ICO_OUTPUT = os.path.join(ROOT, 'build', 'icon.ico')

PNG_SIZE = 512
ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]
SUPERSAMPLED = 2048

DESIGN = 1024
PLATE = 944
SQUIRCLE_EXPONENT = 5
RIM = 20
BAR_COUNT = 7
BAR_WIDTH = 76
BAR_GAP = 22
BAR_BOTTOM = 794
BAR_TALLEST = 580
PROFILE = [0.22, 0.42, 0.75, 1.0]
CUT_OUTER = 0.45
CUT_CENTER = 0.55

# Plate, bar count, bar width, and gap in whole pixels. An odd glyph width
# needs an odd plate, or the glyph cannot sit centered on the pixel grid.
HINTS = {
    16: (16, 5, 2, 1),
    20: (18, 5, 2, 1),
    24: (24, 7, 2, 1),
    30: (28, 7, 2, 1),
    32: (30, 7, 2, 1),
    36: (33, 7, 3, 1),
    40: (37, 7, 3, 1),
    48: (44, 7, 4, 1),
    60: (55, 7, 5, 1),
    64: (59, 7, 5, 1),
}


def read_colors(path):
    """Read the plate, rim, bar, and top colors from the token stylesheet."""
    with open(path, encoding='utf-8') as handle:
        declared = dict(re.findall(r'--(color-[\w-]+)\s*:\s*([^;]+);', handle.read()))

    def resolve(name):
        if name not in declared:
            raise SystemExit(f'{path} does not declare --{name}')
        value = declared[name].strip()
        reference = re.fullmatch(r'var\(--(color-[\w-]+)\)', value)
        if reference:
            return resolve(reference.group(1))
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
            raise SystemExit(f'--{name} is not a six-digit hex color: {value}')
        return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))

    return {
        'plate': resolve('color-rail'),
        'rim': resolve('color-walnut-500'),
        'bar': resolve('color-brass'),
        'top': resolve('color-ink'),
    }


def bar_heights(count):
    """Sample the M profile, edge to center to edge, at count evenly spaced bars."""
    half = count // 2
    steps = len(PROFILE) - 1
    heights = []
    for index in range(count):
        position = abs(index - half) / half * steps
        low = math.floor(position)
        high = min(steps, low + 1)
        blend = position - low
        heights.append(PROFILE[low] * (1 - blend) + PROFILE[high] * blend)
    return heights


def top_regions(bars, size, stepped):
    """Return the area above the M cut, as one V or as a whole-pixel step per bar."""
    first, last, middle = bars[0], bars[-1], bars[len(bars) // 2]
    start = first[1] + (first[3] - first[1]) * CUT_OUTER
    vertex_x = (middle[0] + middle[2]) / 2
    vertex_y = middle[1] + (middle[3] - middle[1]) * CUT_CENTER

    def cut(x):
        if x <= vertex_x:
            return start + (x - first[0]) * (vertex_y - start) / (vertex_x - first[0])
        return start + (last[2] - x) * (vertex_y - start) / (last[2] - vertex_x)

    if not stepped:
        return [[(0, 0), (size, 0), (size, cut(size)), (vertex_x, vertex_y), (0, cut(0))]]
    regions = []
    for x0, _, x1, _ in bars:
        y = math.floor(cut((x0 + x1) / 2) + 0.5)
        regions.append([(x0, 0), (x1, 0), (x1, y), (x0, y)])
    return regions


def layout(size):
    """Return the plate box, rim width, bar boxes, cap radius, and top regions in pixels."""
    hint = HINTS.get(size)
    if hint:
        plate, count, width, gap = hint
        rim = 1
        radius = width / 2 if width > 3 else 0
        origin = (size - plate) // 2
        span = count * width + (count - 1) * gap
        left = origin + (plate - span) // 2
        scale = plate / PLATE
        bottom = origin + round(BAR_BOTTOM * scale)
        tallest = round(BAR_TALLEST * scale)
        heights = [max(1, round(tallest * share)) for share in bar_heights(count)]
    else:
        scale = size / DESIGN
        plate = PLATE * scale
        count = BAR_COUNT
        width = BAR_WIDTH * scale
        gap = BAR_GAP * scale
        rim = RIM * scale
        radius = width / 2
        origin = (size - plate) / 2
        left = (size - (count * width + (count - 1) * gap)) / 2
        bottom = origin + BAR_BOTTOM * scale
        heights = [BAR_TALLEST * scale * share for share in bar_heights(count)]
    bars = []
    for index, height in enumerate(heights):
        x0 = left + index * (width + gap)
        bars.append((x0, bottom - height, x0 + width, bottom))
    return {
        'plate': (origin, origin, origin + plate, origin + plate),
        'rim': rim,
        'bars': bars,
        'radius': radius,
        'tops': top_regions(bars, size, stepped=bool(hint)),
    }


def squircle(box, factor, points=1024):
    """Return the outline of the superellipse inscribed in box, scaled by factor."""
    x0, y0, x1, y1 = (value * factor for value in box)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
    power = 2 / SQUIRCLE_EXPONENT
    outline = []
    for step in range(points):
        angle = 2 * math.pi * step / points
        c, s = math.cos(angle), math.sin(angle)
        outline.append((cx + rx * math.copysign(abs(c) ** power, c), cy + ry * math.copysign(abs(s) ** power, s)))
    return outline


def render(size, colors):
    """Rasterize the icon at one size; each shape's coverage comes from a supersampled mask."""
    shape = layout(size)
    factor = max(1, SUPERSAMPLED // size)
    full = (size * factor, size * factor)
    x0, y0, x1, y1 = shape['plate']
    rim = shape['rim']

    outer = Image.new('L', full, 0)
    ImageDraw.Draw(outer).polygon(squircle(shape['plate'], factor), fill=255)
    inner = Image.new('L', full, 0)
    ImageDraw.Draw(inner).polygon(squircle((x0 + rim, y0 + rim, x1 - rim, y1 - rim), factor), fill=255)

    bars = Image.new('L', full, 0)
    draw = ImageDraw.Draw(bars)
    radius = round(shape['radius'] * factor)
    for bx0, by0, bx1, by1 in shape['bars']:
        box = (round(bx0 * factor), round(by0 * factor), round(bx1 * factor) - 1, round(by1 * factor) - 1)
        if radius:
            draw.rounded_rectangle(box, radius=radius, fill=255)
        else:
            draw.rectangle(box, fill=255)

    above = Image.new('L', full, 0)
    draw = ImageDraw.Draw(above)
    for region in shape['tops']:
        draw.polygon([(x * factor, y * factor) for x, y in region], fill=255)
    tops = ImageChops.multiply(bars, above)

    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    for color, mask in ((colors['rim'], outer), (colors['plate'], inner), (colors['bar'], bars), (colors['top'], tops)):
        layer = Image.new('RGBA', (size, size), color + (255,))
        layer.putalpha(mask.resize((size, size), Image.Resampling.BOX))
        image = Image.alpha_composite(image, layer)
    return image


def main():
    colors = read_colors(TOKENS)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text('Software', f'generate-icon.py, Pillow {PIL.__version__}')
    metadata.add_text('Comment', 'Colors from src/renderer/src/styles/tokens.css')

    icon = render(PNG_SIZE, colors)
    for path in PNG_OUTPUTS:
        icon.save(path, 'PNG', optimize=True, pnginfo=metadata)
        print(f'Saved {os.path.relpath(path, ROOT)} ({PNG_SIZE} px)')

    frames = [render(size, colors) for size in ICO_SIZES]
    frames[-1].save(ICO_OUTPUT, format='ICO', sizes=[(size, size) for size in ICO_SIZES], append_images=frames[:-1])
    print(f'Saved {os.path.relpath(ICO_OUTPUT, ROOT)} ({", ".join(str(size) for size in ICO_SIZES)} px)')


if __name__ == '__main__':
    main()
