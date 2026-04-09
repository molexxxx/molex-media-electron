from PIL import Image, ImageDraw, ImageFilter, ImageChops
import math
import os

SIZE = 1024
FINAL = 512
PAD = 40


def make_gradient(size, c1, c2):
    img = Image.new('RGBA', (size, size))
    pixels = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2.0 * size)
            r = int(c1[0] * (1 - t) + c2[0] * t)
            g = int(c1[1] * (1 - t) + c2[1] * t)
            b = int(c1[2] * (1 - t) + c2[2] * t)
            pixels[x, y] = (r, g, b, 255)
    return img


def superellipse_mask(size, pad, n=5):
    mask = Image.new('L', (size, size), 0)
    pixels = mask.load()
    cx, cy = size / 2.0, size / 2.0
    a = (size - 2 * pad) / 2.0
    b = a
    for y in range(size):
        for x in range(size):
            dx = abs(x - cx) / a
            dy = abs(y - cy) / b
            if dx == 0 and dy == 0:
                pixels[x, y] = 255
                continue
            val = dx ** n + dy ** n
            if val <= 1.0:
                edge_dist = 1.0 - val
                alpha = min(255, int(edge_dist * a * 2))
                pixels[x, y] = min(255, alpha)
    return mask


def draw_rounded_bar(draw, x, y, w, h, radius, color):
    if h < radius * 2:
        radius = h // 2
    draw.ellipse([x, y, x + w, y + radius * 2], fill=color)
    draw.ellipse([x, y + h - radius * 2, x + w, y + h], fill=color)
    if h > radius * 2:
        draw.rectangle([x, y + radius, x + w, y + h - radius], fill=color)


def main():
    print("Generating gradient...")
    color_tl = (139, 50, 255)
    color_br = (30, 110, 255)
    gradient = make_gradient(SIZE, color_tl, color_br)

    print("Creating squircle mask...")
    mask = superellipse_mask(SIZE, PAD, n=5)

    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas = Image.composite(gradient, canvas, mask)

    # Subtle top highlight
    highlight = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    hl_draw = ImageDraw.Draw(highlight)
    for i in range(40):
        alpha = int(35 * (1 - i / 40))
        hl_draw.ellipse(
            [PAD + 60, PAD + i - 20, SIZE - PAD - 60, PAD + 200 + i],
            fill=(255, 255, 255, alpha)
        )
    canvas = Image.alpha_composite(canvas, Image.composite(
        highlight, Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0)), mask))

    draw = ImageDraw.Draw(canvas)

    # ! --- M-shaped equalizer bars ---
    bar_count = 7
    bar_width = 76
    bar_gap = 22
    total_w = bar_count * bar_width + (bar_count - 1) * bar_gap
    start_x = (SIZE - total_w) // 2

    bottom_y = SIZE - 190
    max_height = 580

    # ! bars
    m_heights = [1.0, 0.75, 0.42, 0.22, 0.42, 0.75, 1.0]

    bar_radius = bar_width // 2

    bar_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    bar_draw = ImageDraw.Draw(bar_layer)

    for i, h in enumerate(m_heights):
        bx = start_x + i * (bar_width + bar_gap)
        bh = int(max_height * h)
        by = bottom_y - bh
        draw_rounded_bar(bar_draw, bx + 5, by + 5, bar_width, bh, bar_radius, (0, 0, 0, 22))

    for i, h in enumerate(m_heights):
        bx = start_x + i * (bar_width + bar_gap)
        bh = int(max_height * h)
        by = bottom_y - bh
        draw_rounded_bar(bar_draw, bx, by, bar_width, bh, bar_radius, (190, 200, 255, 220))

    canvas = Image.alpha_composite(canvas, bar_layer)

    center = len(m_heights) // 2  # index 3

    outer_by = bottom_y - int(max_height * m_heights[0])
    center_bx = start_x + center * (bar_width + bar_gap)
    center_by = bottom_y - int(max_height * m_heights[center])

    center_cap_bottom = center_by + int((bottom_y - center_by) * 0.55)

    # ! -------------------------------

    # Left diagonal
    left_start_x = start_x
    left_start_y = outer_by + int(max_height * m_heights[0] * 0.45)
    left_end_x = center_bx + bar_width // 2
    left_end_y = center_cap_bottom

    # Right diagonal (mirror)
    right_start_x = start_x + 6 * (bar_width + bar_gap) + bar_width
    right_start_y = outer_by + int(max_height * m_heights[0] * 0.45)
    right_end_x = center_bx + bar_width // 2
    right_end_y = center_cap_bottom

    def line_y_at_x(x, x0, y0, x1, y1):
        """Get y coordinate on line at given x."""
        if x1 == x0:
            return y0
        t = (x - x0) / (x1 - x0)
        return y0 + t * (y1 - y0)

    for i, h in enumerate(m_heights):
        bx = start_x + i * (bar_width + bar_gap)
        bh = int(max_height * h)
        by = bottom_y - bh

        bar_mask = Image.new('L', (SIZE, SIZE), 0)
        bm_draw = ImageDraw.Draw(bar_mask)
        draw_rounded_bar(bm_draw, bx, by, bar_width, bh, bar_radius, 255)

        hi_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
        hi_draw = ImageDraw.Draw(hi_layer)

        if i < center:
            cut_left_y = line_y_at_x(bx, left_start_x, left_start_y, left_end_x, left_end_y)
            cut_right_y = line_y_at_x(bx + bar_width, left_start_x, left_start_y, left_end_x, left_end_y)
        elif i > center:
            cut_left_y = line_y_at_x(bx, right_start_x, right_start_y, right_end_x, right_end_y)
            cut_right_y = line_y_at_x(bx + bar_width, right_start_x, right_start_y, right_end_x, right_end_y)
        else:
            cut_left_y = line_y_at_x(bx, left_start_x, left_start_y, left_end_x, left_end_y)
            cut_right_y = line_y_at_x(bx + bar_width, right_start_x, right_start_y, right_end_x, right_end_y)
            cut_center_y = line_y_at_x(bx + bar_width // 2, left_start_x, left_start_y, left_end_x, left_end_y)

        if i == center:
            fill_pts = [
                (bx - 2, by - 2),
                (bx + bar_width + 2, by - 2),
                (bx + bar_width + 2, int(cut_right_y)),
                (bx + bar_width // 2, int(cut_center_y)),
                (bx - 2, int(cut_left_y)),
            ]
        else:
            fill_pts = [
                (bx - 2, by - 2),
                (bx + bar_width + 2, by - 2),
                (bx + bar_width + 2, int(cut_right_y)),
                (bx - 2, int(cut_left_y)),
            ]
        hi_draw.polygon(fill_pts, fill=(255, 255, 255, 140))

        hi_layer.putalpha(ImageChops.multiply(hi_layer.split()[3], bar_mask.convert('L')))
        canvas = Image.alpha_composite(canvas, hi_layer)

    draw = ImageDraw.Draw(canvas)

    #! -----

    print("Downscaling...")
    final = canvas.resize((FINAL, FINAL), Image.LANCZOS)
    
    out_dir = os.path.dirname(os.path.abspath(__file__))

    build_png = os.path.join(out_dir, 'build', 'icon.png')
    res_png = os.path.join(out_dir, 'resources', 'icon.png')
    final.save(build_png, 'PNG')
    final.save(res_png, 'PNG')
    print(f"Saved {build_png}")
    print(f"Saved {res_png}")

    ico_path = os.path.join(out_dir, 'build', 'icon.ico')
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = [canvas.resize((s, s), Image.LANCZOS) for s in ico_sizes]
    ico_images[-1].save(
        ico_path,
        format='ICO',
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_images[:-1]
    )
    print(f"Saved {ico_path}")
    print("Done!")


if __name__ == '__main__':
    main()
