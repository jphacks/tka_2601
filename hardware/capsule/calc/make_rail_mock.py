#!/usr/bin/env python3
"""Printed stand-in for the 6 x 6 mm aluminium rail, to try the fit and slide of the printed parts.
Not for measuring press force: PLA bends far more than the aluminium rail."""
import math, os, struct, sys

RAIL = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
RAIL_R, CHAMFER = 0.5, 0.5
ARC = 6


def section(inset):
    h, r = RAIL / 2.0 - inset, max(RAIL_R - inset, 0.0)
    pts = []
    for cy, cz, a0 in ((h - r, h - r, 0), (-h + r, h - r, 90), (-h + r, -h + r, 180), (h - r, -h + r, 270)):
        for i in range(ARC + 1):
            a = math.radians(a0 + 90.0 * i / ARC)
            pts.append((cy + r * math.cos(a), cz + r * math.sin(a) + RAIL / 2.0))
    return pts


def tris(length):
    stations = [(0.0, CHAMFER), (CHAMFER, 0.0), (length - CHAMFER, 0.0), (length, CHAMFER)]
    rings = [[(x, y, z) for y, z in section(inset)] for x, inset in stations]
    n = len(rings[0])
    out = []
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            out += [(a[i], b[j], b[i]), (a[i], a[j], b[j])]
    for ring, flip in ((rings[0], False), (rings[-1], True)):
        c = (ring[0][0], 0.0, RAIL / 2.0)
        for i in range(n):
            p, q = ring[i], ring[(i + 1) % n]
            out.append((c, p, q) if flip else (c, q, p))
    return out


def normal(t):
    u = [t[1][k] - t[0][k] for k in range(3)]
    v = [t[2][k] - t[0][k] for k in range(3)]
    w = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    s = math.sqrt(sum(c * c for c in w)) or 1.0
    return tuple(c / s for c in w)


def main():
    length = float(sys.argv[1]) if len(sys.argv) > 1 else 134.4
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, '..', 'stl', 'rail_mock_%.1fmm_%.2f_PLA.stl' % (length, RAIL))
    ts = tris(length)
    with open(path, 'wb') as f:
        f.write(b'MONBAN rail mock'.ljust(80, b' '))
        f.write(struct.pack('<I', len(ts)))
        for t in ts:
            f.write(struct.pack('<3f', *normal(t)))
            for p in t:
                f.write(struct.pack('<3f', *p))
            f.write(struct.pack('<H', 0))
    vol = sum(t[0][0] * (t[1][1] * t[2][2] - t[1][2] * t[2][1]) - t[0][1] * (t[1][0] * t[2][2] - t[1][2] * t[2][0]) + t[0][2] * (t[1][0] * t[2][1] - t[1][1] * t[2][0]) for t in ts) / 6.0
    print(os.path.normpath(path), len(ts), 'triangles, volume %.0f mm3' % vol)


if __name__ == '__main__':
    main()
