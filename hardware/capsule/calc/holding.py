#!/usr/bin/env python3
"""Does the capsule v4 assembly stay on when a pusher presses a key?

The only thing holding the assembly on the intercom is friction at the two foam pads on its sides.
A press pushes the assembly straight off the face, so:
- the moment about y (press not midway between the paws) decides each pad's share of the force;
- the arm between the press height and the pad centre adds an in-plane twist on each pad.
For one pad, the slip limit integrates mu * p over the pad for a rigid in-plane slip about an
instantaneous centre (same method as kotori's strength_v2.py). Both pads are given the same arm.
This is a lower bound for the force at which the first pad starts to slip.

The clamp force N and the friction coefficient mu are not measured: they are ranges.
Geometry comes from fusion/mount_views.py (results/mount_report.json) and kotori v3's paw_bodies.
"""
import json, math, os
import numpy as np

FOAM_E_PER_STRAIN = 0.40               # compression at the design point
Y_RC = 13.206                          # press point above (below) the rail centre, capsule v4


def pad_resultant(h, d, mu, N, yc, n=50):
    ys = (np.arange(n) + 0.5) / n * h - h / 2
    zs = (np.arange(n) + 0.5) / n * d - d / 2
    Y, Z = np.meshgrid(ys, zs)
    vy, vz = -Z, Y - yc
    L = np.hypot(vy, vz) + 1e-12
    q = mu * N / (n * n)
    return np.sum(-q * vz / L), np.sum(Y * (-q * vz / L) + Z * q * vy / L)


def pad_limit(h, d, mu, N, arm):
    """Largest force one pad holds in z with the load arm from the pad centre."""
    if abs(arm) < 0.05:
        return mu * N
    best = None
    for yc in np.concatenate([-np.logspace(-2, 4, 500), np.logspace(-2, 4, 500)]):
        fz, T = pad_resultant(h, d, mu, N, yc)
        if abs(fz) < 1e-9:
            continue
        err = abs(abs(T / fz) - abs(arm))
        if best is None or err < best[0]:
            best = (err, abs(fz))
    return best[1]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    rep = json.load(open(os.path.join(here, 'results', 'mount_report.json')))
    rows = []
    for r in rep:
        W = r['W']
        two = len({c['flipped'] for c in r['capsules']}) > 1
        h = 16.0
        d = r['paw_reach_mm'] - 1.0
        arm = Y_RC if two else Y_RC - 5.0      # pad centre on the rail for two rows, 5 mm above it for one
        for c in r['capsules']:
            px = c['point'][0]
            share = 0.5 + abs(px) / W
            lim = {}
            for N, mu in ((20, 0.4), (30, 0.4), (20, 0.6), (30, 0.6)):
                lim[(N, mu)] = pad_limit(h, d, mu, N, arm) / share
            rows.append(dict(model=r['model'], key=c['key'], W=W, px=px, pad=(h, d), arm=arm, share=share, lim=lim))
    print('press force at which the first pad slips (N). N = clamp per side, mu = friction')
    print('%-26s %-9s %5s %6s %5s | %7s %7s %7s %7s' % ('model', 'key', 'x', 'pad d', 'share', '20/.4', '30/.4', '20/.6', '30/.6'))
    for w in rows:
        l = w['lim']
        print('%-26s %-9s %5.1f %6.1f %5.2f | %7.1f %7.1f %7.1f %7.1f' % (w['model'][:26], w['key'], w['px'], w['pad'][1], w['share'], l[(20, .4)], l[(30, .4)], l[(20, .6)], l[(30, .6)]))
    print()
    # ---- foam shear: the press point backs off before anything slips
    for h, d, name in ((16.0, 13.0, 'reach 14'), (16.0, 7.8, 'dearis')):
        p = 30.0 / (h * d)
        E = p / FOAM_E_PER_STRAIN
        G = E / 3.0
        for F in (5.0, 10.9, 13.08):
            tau = (F / 2) / (h * d)
            print('foam shear %-9s: pad pressure %.3f MPa, E %.2f, F %5.2f N -> pad moves %.2f mm (3 mm foam, 40 %% squeezed = 1.8 mm)' % (name, p, E, F, tau / G * 1.8))
    print()
    print('other ways to come off (F = 13.08 N, servo at 6 V)')
    print('  rail tunnel closed: the capsule cannot leave the rail; it can only slide along it, and a key force has no component along the rail')
    print('  cap screw: FEM %.0f N on M2 thread, 2.15 mm engaged -> %.1f MPa shear' % (23, 23 / (math.pi * 1.8 * 2.15)))
    print('  tilt on the rail: 2.1 deg, press point backs off 0.39 mm (0.2 mm gap, R0.5)')


if __name__ == '__main__':
    main()
