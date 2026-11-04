#!/usr/bin/env python3
"""生成扩展图标（纯标准库，无 PIL 依赖）。深色底 + 红色上升折线。"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "icons")
os.makedirs(ICON_DIR, exist_ok=True)

BG = (16, 19, 28, 255)          # 深蓝黑
LINE = (240, 85, 60, 255)       # 金十红
GREEN = (43, 182, 115, 255)     # 点缀绿
KEY = (255, 255, 255, 255)


def _chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, size, inside):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            raw += bytes(inside(x, y))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def dist_to_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def make_inside(size):
    s = float(size)
    r = max(2.0, s / 14.0)                 # 线宽
    pad = s * 0.14
    # 折线控制点（相对坐标）
    pts = [
        (pad, s * 0.62),
        (s * 0.34, s * 0.72),
        (s * 0.58, s * 0.42),
        (s * 0.78, s * 0.55),
        (s - pad, s * 0.26),
    ]
    segs = [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    # 箭头（末端小三角）
    tip = pts[-1]
    arrow_pts = [
        (tip[0] - s * 0.16, tip[1] - s * 0.04),
        (tip[0] - s * 0.02, tip[1] - s * 0.16),
        (tip[0] - s * 0.015, tip[1] + s * 0.11),
    ]

    def in_tri(px, py, a, b, c):
        def sign(p, q, r2):
            return (p[0] - r2[0]) * (q[1] - r2[1]) - (q[0] - r2[0]) * (p[1] - r2[1])
        d1, d2, d3 = sign((px, py), a, b), sign((px, py), b, c), sign((px, py), c, a)
        neg = d1 < 0 or d2 < 0 or d3 < 0
        pos = d1 > 0 or d2 > 0 or d3 > 0
        return not (neg and pos)

    def inside(x, y):
        px, py = x + 0.5, y + 0.5
        # 圆角背景：距边角 < r 的部分裁圆角
        cx, cy = max(r - pad, 0.0), max(r - pad, 0.0)
        corners = [
            (cx, cy), (s - cx, cy), (cx, s - cy), (s - cx, s - cy)
        ]
        near_corner = any(
            (px - c[0]) ** 2 + (py - c[1]) ** 2 < (r * 0.9) ** 2 and
            (px < c[0] + r or px > s - c[0] - r) and
            (py < c[1] + r or py > s - c[1] - r)
            for c in corners
        )
        # 简化：非圆角区域即背景，圆角用 r 半径判定
        for c in corners:
            if (px - c[0]) ** 2 + (py - c[1]) ** 2 < r * r:
                return BG
        for i, ((ax, ay), (bx, by)) in enumerate(segs):
            if dist_to_seg(px, py, ax, ay, bx, by) <= r:
                return LINE
        if in_tri(px, py, *arrow_pts):
            return LINE
        return BG

    return inside


if __name__ == "__main__":
    for sz in (16, 32, 48, 128):
        write_png(os.path.join(ICON_DIR, f"icon{sz}.png"), sz, make_inside(sz))
        print(f"generated icon{sz}.png")