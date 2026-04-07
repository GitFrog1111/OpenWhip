#!/usr/bin/env python3
# ABOUTME: Generates app icons for goodclaude — golden halo with sparkles on a warm gradient
# ABOUTME: Creates macOS .icns, Windows .ico, and tray Template.png
from PIL import Image, ImageDraw, ImageFilter
import math, os, subprocess, shutil

ICON_DIR = os.path.join(os.path.dirname(__file__), '..', 'icon')

def lerp(a, b, t):
    return a + (b - a) * t

def draw_sparkle(draw, cx, cy, size, color=(255, 255, 230, 255)):
    """Draw a 4-pointed sparkle star."""
    for i in range(4):
        angle = i * math.pi / 2
        ex = cx + math.cos(angle) * size
        ey = cy + math.sin(angle) * size
        perp = angle + math.pi / 2
        w = size * 0.18
        px, py = math.cos(perp) * w, math.sin(perp) * w
        draw.polygon([(cx + px, cy + py), (ex, ey), (cx - px, cy - py)], fill=color)


def create_app_icon(size):
    """Golden halo + sparkles on warm gradient background."""
    s = size * 4  # supersampled
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx, cy = s // 2, s // 2
    radius = int(s * 0.47)

    # Radial gradient background: warm peach center -> soft lavender edge
    for i in range(radius, 0, -2):
        t = i / radius
        r = int(lerp(255, 110, t))
        g = int(lerp(210, 90, t))
        b = int(lerp(230, 175, t))
        draw.ellipse([cx - i, cy - i, cx + i, cy + i], fill=(r, g, b, 255))

    # -- Halo glow (blurred golden ellipse beneath the ring) --
    glow = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    halo_rx = int(s * 0.30)
    halo_ry = int(s * 0.11)
    halo_cy = cy - int(s * 0.04)
    glow_pad = int(s * 0.04)
    gd.ellipse(
        [cx - halo_rx - glow_pad, halo_cy - halo_ry - glow_pad,
         cx + halo_rx + glow_pad, halo_cy + halo_ry + glow_pad],
        fill=(255, 225, 50, 120)
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=int(s * 0.04)))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # -- Halo ring --
    thick = max(int(s * 0.032), 3)
    draw.ellipse(
        [cx - halo_rx, halo_cy - halo_ry, cx + halo_rx, halo_cy + halo_ry],
        outline=(255, 200, 0, 255), width=thick
    )
    # Bright highlight on inner edge
    inner_t = max(thick // 3, 1)
    shrink = thick // 3
    draw.ellipse(
        [cx - halo_rx + shrink, halo_cy - halo_ry + shrink,
         cx + halo_rx - shrink, halo_cy + halo_ry - shrink],
        outline=(255, 245, 180, 220), width=inner_t
    )

    # -- Sparkle stars --
    sparkles = [
        (cx - int(s * 0.25), cy - int(s * 0.27), int(s * 0.065)),
        (cx + int(s * 0.28), cy - int(s * 0.20), int(s * 0.050)),
        (cx + int(s * 0.15), cy + int(s * 0.28), int(s * 0.045)),
        (cx - int(s * 0.20), cy + int(s * 0.26), int(s * 0.038)),
        (cx + int(s * 0.02), cy - int(s * 0.36), int(s * 0.055)),
    ]
    for sx, sy, ss in sparkles:
        draw_sparkle(draw, sx, sy, ss, (255, 255, 220, 240))
        # Bright center dot
        dot_r = max(int(ss * 0.3), 1)
        draw.ellipse([sx - dot_r, sy - dot_r, sx + dot_r, sy + dot_r],
                     fill=(255, 255, 255, 220))

    # Clip to circle (rounded app icon mask)
    mask = Image.new('L', (s, s), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=255)
    img.putalpha(mask)

    return img.resize((size, size), Image.LANCZOS)


def create_template_icon(size):
    """macOS tray template icon — black silhouette with alpha."""
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx, cy = s // 2, s // 2

    # Halo ring (bold for visibility)
    halo_rx = int(s * 0.38)
    halo_ry = int(s * 0.14)
    halo_cy = cy - int(s * 0.04)
    thick = max(int(s * 0.055), 2)
    draw.ellipse(
        [cx - halo_rx, halo_cy - halo_ry, cx + halo_rx, halo_cy + halo_ry],
        outline=(0, 0, 0, 255), width=thick
    )

    # Sparkles
    sparkles = [
        (cx - int(s * 0.28), cy - int(s * 0.26), int(s * 0.09)),
        (cx + int(s * 0.30), cy - int(s * 0.18), int(s * 0.07)),
        (cx, cy + int(s * 0.28), int(s * 0.07)),
    ]
    for sx, sy, ss in sparkles:
        draw_sparkle(draw, sx, sy, ss, (0, 0, 0, 255))

    return img.resize((size, size), Image.LANCZOS)


def build_icns(master):
    """Create .icns via iconutil from a master RGBA image."""
    iconset = os.path.join(ICON_DIR, 'AppIcon.iconset')
    os.makedirs(iconset, exist_ok=True)
    sizes = [16, 32, 128, 256, 512]
    for sz in sizes:
        master.resize((sz, sz), Image.LANCZOS).save(
            os.path.join(iconset, f'icon_{sz}x{sz}.png'))
        master.resize((sz * 2, sz * 2), Image.LANCZOS).save(
            os.path.join(iconset, f'icon_{sz}x{sz}@2x.png'))
    subprocess.run(
        ['iconutil', '-c', 'icns', iconset, '-o', os.path.join(ICON_DIR, 'AppIcon.icns')],
        check=True)
    shutil.rmtree(iconset)
    print('  -> AppIcon.icns')


def build_ico(master):
    """Create Windows .ico with multiple sizes."""
    sizes = [(16, 16), (32, 32), (48, 48), (256, 256)]
    imgs = [master.resize(s, Image.LANCZOS) for s in sizes]
    imgs[0].save(os.path.join(ICON_DIR, 'icon.ico'), format='ICO',
                 append_images=imgs[1:], sizes=sizes)
    print('  -> icon.ico')


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    print('Generating goodclaude icons...')

    # App icon master at 1024x1024
    master = create_app_icon(1024)
    master.save(os.path.join(ICON_DIR, 'AppIcon.png'))
    print('  -> AppIcon.png (1024x1024 master)')

    # macOS .icns
    build_icns(master)

    # Windows .ico
    build_ico(master)

    # Tray template icon (22px is standard macOS menu bar height)
    template = create_template_icon(22)
    template.save(os.path.join(ICON_DIR, 'Template.png'))
    # Also save @2x for retina
    template_2x = create_template_icon(44)
    template_2x.save(os.path.join(ICON_DIR, 'Template@2x.png'))
    print('  -> Template.png + Template@2x.png')

    print('Done!')


if __name__ == '__main__':
    main()
