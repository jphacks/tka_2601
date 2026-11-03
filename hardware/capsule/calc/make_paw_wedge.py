#!/usr/bin/env python3
"""Screwless paws: a printed wedge between the rail's front face and a sloped slot replaces the M3 thumb screw.
Any rail length and pad thickness works, because the wedge locks the paw anywhere along the rail.
The inner side of the knob is cut flat with the cheek, so a paw prints with no support, rail axis vertical.
Needs trimesh and manifold3d. Paw frame: x outward along the rail, y along the intercom side, z out of its face."""
import os, sys
import numpy as np, trimesh

X0, X1 = 3.65, 9.35                # slot width, the wedge is 0.5 mm narrower
Z_FLOOR, Z_CEIL, SLOPE = 10.2, 12.6, 0.1    # slot floor below the rail's front face (10.28 to 10.4); ceiling at y = 0
Y_MIN, Y_MAX = -12.0, 14.0
W_TIP, W_LEN, W_WIDTH = 1.8, 15.0, 5.2
X_FLAT = 3.0                       # cheek's inner face
KNOB_C, KNOB_R = (6.5, 0.0, 7.8), (6.5, 7.5, 7.5)    # the knob as in paw_bodies(), to fill the old nut pocket and screw hole
TUNNEL_Y, TUNNEL_Z = 3.25, (4.4, 10.9)


def prism_yz(pts, x0, x1):
    """Extrude a y-z polygon along x."""
    n = len(pts)
    v = [(x0, y, z) for y, z in pts] + [(x1, y, z) for y, z in pts]
    f = [(0, i, i + 1) for i in range(1, n - 1)] + [(n, n + i + 1, n + i) for i in range(1, n - 1)]
    for i in range(n):
        j = (i + 1) % n
        f += [(i, n + i, n + j), (i, n + j, j)]
    m = trimesh.Trimesh(v, f, process=True)
    if m.volume < 0:
        m.invert()
    return m


def slot():
    c = lambda y: Z_CEIL + SLOPE * y
    return prism_yz([(Y_MIN, Z_FLOOR), (Y_MAX, Z_FLOOR), (Y_MAX, c(Y_MAX)), (Y_MIN, c(Y_MIN))], X0, X1)


def wedge():
    """Laid flat for printing: the taper is in the x-y plane, 5.2 mm tall."""
    t = W_TIP + SLOPE * W_LEN
    return prism_yz([(0, 0), (W_LEN, 0), (W_LEN, t), (0, W_TIP)], 0, W_WIDTH)


def paw(path, mirror):
    m = trimesh.load(path)
    if mirror:                     # the L paw's x runs the other way
        m.vertices[:, 0] *= -1
        m.invert()
    knob = trimesh.creation.icosphere(subdivisions=5, radius=1.0)
    knob.apply_scale(KNOB_R)
    knob.apply_translation(KNOB_C)
    m = trimesh.boolean.union([m, knob], engine='manifold')
    x_end = 11.4 if mirror else 14.0
    tunnel = trimesh.creation.box(extents=(x_end + 1, 2 * TUNNEL_Y, TUNNEL_Z[1] - TUNNEL_Z[0]))
    tunnel.apply_translation(((x_end - 1) / 2.0, 0, sum(TUNNEL_Z) / 2.0))
    m = trimesh.boolean.difference([m, tunnel], engine='manifold')
    keep = trimesh.creation.box(extents=(40, 80, 80))
    keep.apply_translation((X_FLAT + 20, 0, 0))
    out = trimesh.boolean.intersection([m, keep], engine='manifold')
    out = trimesh.boolean.difference([out, slot()], engine='manifold')
    assert out.is_watertight
    if mirror:
        out.vertices[:, 0] *= -1
        out.invert()
    return out


def plate(stl):
    """One object for a 180 mm bed: the rail on the diagonal, a paw in each free corner, four wedges (two spare)."""
    Ry = lambda a: trimesh.transformations.rotation_matrix(np.radians(a), (0, 1, 0))
    parts = []
    for nm, a, xy in (('R', -90, (40, 145)), ('L', 90, (140, 35))):
        p = trimesh.load(os.path.join(stl, 'paw_%s_std_wedge_PLA.stl' % nm))
        p.apply_transform(Ry(a))
        p.apply_translation((xy[0] - p.centroid[0], xy[1] - p.centroid[1], -p.bounds[0][2]))
        parts.append(p)
    r = trimesh.load(os.path.join(stl, 'rail_mock_200.0mm_5.88_PLA.stl'))
    r.apply_translation(-r.bounds.mean(axis=0))
    r.apply_transform(trimesh.transformations.rotation_matrix(np.radians(45), (0, 0, 1)))
    r.apply_translation((90, 90, -r.bounds[0][2]))
    parts.append(r)
    for i in range(4):
        w = wedge()
        w.apply_translation((20 + 8 * i, 100, 0))
        parts.append(w)
    out = trimesh.util.concatenate(parts)
    print('plate', out.bounds.round(1).tolist())
    out.export(os.path.join(stl, 'plate_paws_rail200_wedges_PLA.stl'))


def main():
    stl = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'stl')
    for nm, mirror in (('L', True), ('R', False)):
        p = paw(os.path.join(stl, 'paw_%s_std_PETG-orange.stl' % nm), mirror)
        print(nm, p.bounds.round(2).tolist(), 'vol', round(p.volume), 'parts', len(p.split(only_watertight=False)))
        p.export(os.path.join(stl, 'paw_%s_std_wedge_PLA.stl' % nm))
    w = wedge()
    print('wedge', w.bounds.round(2).tolist(), 'vol', round(w.volume))
    w.export(os.path.join(stl, 'paw_wedge_PLA.stl'))
    plate(stl)


if __name__ == '__main__':
    main()
