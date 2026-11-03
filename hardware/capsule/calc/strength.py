#!/usr/bin/env python3
"""Hand calculations for the capsule pusher at servo stall, plus a 2-D FEM of one pinion tooth.

Force chain: FS0307 stall torque -> pinion (r = 4.5 mm) -> rack -> key. The stall torque is the
0.6 kgf cm (6 V) datasheet figure; the product runs at 5 V, so this is above the working case.
Material strengths are the Bambu PLA Basic data sheet where stated, otherwise assumptions (ASSUMED).
"""
import math
import numpy as np

G = 9.80665
T_6V = 0.6 * G / 100 * 1000            # N mm
RP, M, Z, B, PA = 4.5, 0.75, 12, 3.0, math.radians(25)
F_STALL = T_6V / RP
F_5V = F_STALL * 5 / 6                 # torque taken as proportional to voltage (ASSUMED)
KEY_FORCE = (2.0, 5.0)                 # usual key range used in kotori v3.1 (ASSUMED, not measured)
DYN = 2.0                              # hitting a stop at speed (ASSUMED)

# PLA Basic data sheet: tensile X-Y 35 MPa is the lower of the two published copies.
STR_XY, STR_FATIGUE, STR_LAYER = 35.0, 12.0, 15.0   # fatigue and across-layer: ASSUMED, conservative
E_PLA, E_AL, G_AL = 2750.0, 70000.0, 26000.0


def line(name, value, unit, note=''):
    print('%-44s %9.2f %-6s %s' % (name, value, unit, note))


def lewis():
    Y = 0.277                          # Lewis form factor, 12 teeth, 25 deg (table value, full depth, m-based)
    return F_STALL / (B * M * Y)


def tooth_fem(h=0.02):
    """Plane stress, one tooth loaded at the tip along the line of action; the bore edge is fixed."""
    E, nu, t = E_PLA, 0.35, B
    pa = PA
    rp, rb, ra, rf = RP, RP * math.cos(pa), RP + 0.85 * M, RP - 1.25 * M
    inv = lambda a: math.tan(a) - a
    half = (math.pi * M / 2 - 0.08) / (2 * rp) + inv(pa)
    # sector around the tooth at angle 0: radius >= 2.55 (bore), one pitch wide
    size = ra + 0.1
    xs = np.arange(2.3, size, h)
    ys = np.arange(-1.6, 1.6, h)
    X, Y = np.meshgrid(xs + h / 2, ys + h / 2, indexing='ij')
    R, A = np.hypot(X, Y), np.arctan2(Y, X)
    def half_angle(r):
        rr = np.maximum(r, rb)
        return half - (np.tan(np.arccos(np.minimum(1, rb / rr))) - np.arccos(np.minimum(1, rb / rr)))
    solid = (R >= 2.55) & (R <= ra) & ((R <= rf) | (np.abs(A) <= half_angle(R)))
    solid &= np.abs(A) <= math.pi / Z
    cells = np.argwhere(solid)
    nn = np.array([[0, 0], [1, 0], [1, 1], [0, 1]])
    idx = cells[:, None, :] + nn[None]
    flat = np.ravel_multi_index(idx.reshape(-1, 2).T, (len(xs) + 1, len(ys) + 1))
    uniq, inv_ = np.unique(flat, return_inverse=True)
    conn = inv_.reshape(-1, 4)
    gi, gj = np.unravel_index(uniq, (len(xs) + 1, len(ys) + 1))
    nx, ny = xs[0] + gi * h, ys[0] + gj * h
    D = E / (1 - nu ** 2) * np.array([[1, nu, 0], [nu, 1, 0], [0, 0, (1 - nu) / 2]])
    s = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], float)
    gp = 1 / math.sqrt(3)
    Ke = np.zeros((8, 8))
    def Bm(a, b):
        dN = np.array([[s[i, 0] * (1 + s[i, 1] * b) / 4, s[i, 1] * (1 + s[i, 0] * a) / 4] for i in range(4)]) * 2 / h
        B_ = np.zeros((3, 8))
        for i in range(4):
            B_[0, 2 * i] = dN[i, 0]
            B_[1, 2 * i + 1] = dN[i, 1]
            B_[2, 2 * i], B_[2, 2 * i + 1] = dN[i, 1], dN[i, 0]
        return B_
    for a in (-gp, gp):
        for b in (-gp, gp):
            B_ = Bm(a, b)
            Ke += B_.T @ D @ B_ * (h / 2) ** 2 * t
    dofs = (conn[:, :, None] * 2 + np.arange(2)).reshape(-1, 8)
    n = len(nx) * 2
    diag = np.bincount(dofs.ravel(), weights=np.tile(np.diag(Ke), len(conn)), minlength=n)
    fix_nodes = np.nonzero(np.hypot(nx, ny) < 2.55 + 1.5 * h)[0]
    free = np.ones(n, bool)
    free[fix_nodes * 2] = False
    free[fix_nodes * 2 + 1] = False
    # tip load, along the line of action
    rn = np.hypot(nx, ny)
    an = np.arctan2(ny, nx)
    tip = np.nonzero((rn > ra - 2 * h) & (an > half_angle(np.array([ra]))[0] - 3 * h / ra))[0]
    if len(tip) == 0:
        tip = np.array([np.argmax(rn)])
    Fn = F_STALL / math.cos(pa)
    f = np.zeros(n)
    f[tip * 2] += -Fn * math.sin(pa) / len(tip)
    f[tip * 2 + 1] += -Fn * math.cos(pa) / len(tip)
    def mul(u):
        return np.bincount(dofs.ravel(), weights=(u[dofs] @ Ke).ravel(), minlength=n)
    x = np.zeros(n)
    r = f * free
    Mi = 1 / diag
    z = Mi * r
    p = z.copy()
    rz = r @ z
    n0 = math.sqrt(r @ r)
    for it in range(60000):
        Ap = mul(p) * free
        al = rz / (p @ Ap)
        x += al * p
        r -= al * Ap
        if math.sqrt(r @ r) < 1e-6 * n0:
            break
        z = Mi * r
        rz2 = r @ z
        p = z + rz2 / rz * p
        rz = rz2
    B0 = Bm(0, 0)
    sig = (x[dofs] @ B0.T) @ D
    vm = np.sqrt(sig[:, 0] ** 2 - sig[:, 0] * sig[:, 1] + sig[:, 1] ** 2 + 3 * sig[:, 2] ** 2)
    p1 = (sig[:, 0] + sig[:, 1]) / 2 + np.sqrt(((sig[:, 0] - sig[:, 1]) / 2) ** 2 + sig[:, 2] ** 2)
    keep = np.sqrt(((xs[0] + (cells[:, 0] + .5) * h) ** 2 + (ys[0] + (cells[:, 1] + .5) * h) ** 2)) < ra - 0.25   # drop the load patch
    return dict(elements=len(conn), iterations=it + 1, vm_max=float(vm[keep].max()), p1_max=float(p1[keep].max()), p1_p999=float(np.percentile(p1[keep], 99.9)))


def main():
    print('--- force chain')
    line('stall torque 6 V', T_6V, 'N mm', '0.6 kgf cm datasheet')
    line('rack force at stall, 6 V', F_STALL, 'N')
    line('rack force at stall, 5 V', F_5V, 'N', 'proportional, ASSUMED')
    line('side force on rack (tan 25)', F_STALL * math.tan(PA), 'N')
    print('--- pinion tooth')
    s = lewis()
    line('Lewis root bending, stall', s, 'MPa', 'limit %.0f static, %.0f repeated' % (STR_XY, STR_FATIGUE))
    line('  safety factor, static', STR_XY / s, '')
    line('  same at a 5 N key', s * 5 / F_STALL, 'MPa', 'repeated limit %.0f' % STR_FATIGUE)
    fem = tooth_fem()
    line('2-D FEM root tension, stall', fem['p1_max'], 'MPa', '%d elements, 99.9%% = %.1f' % (fem['elements'], fem['p1_p999']))
    print('--- pinion on the servo hub (glue)')
    r, L = 2.5, 2.0
    line('glue shear on phi 5 x 2 mm', T_6V / (2 * math.pi * r * r * L), 'MPa', 'adhesion to the hub material is unknown')
    print('--- rack')
    I = 4.69 * 3 ** 3 / 12
    Le = 2 * 4.0
    line('Euler buckling, 4 mm free tip', math.pi ** 2 * E_PLA * I / Le ** 2, 'N', 'load %.0f N' % F_STALL)
    line('tip pressure on the key, 3 x 4.7 mm', F_STALL / (3 * 4.69), 'MPa')
    print('--- capsule on the rail (two contact bands, rail centre 13.6 mm below the press point)')
    gap = 0.2
    span = 5.5
    lever = 13.6 - span / 2
    R_front = F_STALL * lever / span
    line('rail tilt until the second contact', math.degrees(gap / span), 'deg', 'R0.5 corners; 0.2 mm clearance')
    line('press point moves back by the tilt', lever * gap / span, 'mm', 'of the 4 mm stroke')
    line('contact force, front band (rigid)', R_front, 'N', 'FEM: fem_results.json')
    print('--- rail corner radius: tilt of the capsule on the rail at the working clearance and at 0.2 mm')
    for R_c in (0.0, 0.5, 1.0, 1.5, 2.0, 2.5):
        sp = 6.0 - 2 * R_c + (0.5 if R_c else 0.0)
        lv = 13.6 - sp / 2
        print('    R%.1f: flat %.1f mm, gap 0.5: %.1f deg, press point -%.2f mm, contact %.0f N | gap 0.2: %.1f deg, -%.2f mm'
              % (R_c, 6 - 2 * R_c, math.degrees(0.5 / sp), lv * 0.5 / sp, F_STALL * lv / sp, math.degrees(0.2 / sp), lv * 0.2 / sp))
    print('--- M2 x 10 into PLA')
    area = math.pi * 1.8 * 2.15
    T = 28.0
    line('thread shear, 2.15 mm engagement', T / area, 'MPa', 'limit %.0f across layers' % STR_LAYER)
    line('head on the seat', T / (math.pi * (2.1 ** 2 - 1.2 ** 2)), 'MPa')
    print('--- rail 6 x 6 x 1 aluminium (span = W + 2 x 11 mm)')
    Itube = (6 ** 4 - 4 ** 4) / 12
    J = 4 * 25 ** 2 * 1 / 20
    for name, W in (('VS-MGE20', 80), ('VL-ME30', 129), ('dearis', 180)):
        Ls = W + 22
        d_pin = F_STALL * Ls ** 3 / (48 * E_AL * Itube)
        sig = F_STALL * Ls / 4 * 3 / Itube
        th = F_STALL * 13.6 * (Ls / 2) / (G_AL * J)
        line('%s: bending, centre load' % name, d_pin, 'mm', 'stress %.1f MPa' % sig)
        line('  twist, moment split to two paws', math.degrees(th) / 2, 'deg', 'moves the press point %.2f mm' % (13.6 * th / 2))
        Ipla = 100.0
        line('  same rail printed in PLA', F_STALL * Ls ** 3 / (48 * E_PLA * Ipla), 'mm', 'not recommended')
    print('--- paws: friction only (kotori v3.1 strength_v3.py, same geometry)')
    print('    single row 12.5-18.7 N, VS-MGE20 two rows 9.0-13.5 N (clamp 20-30 N, mu 0.4-0.6). None of these is measured.')
    line('stall force against the two-row low case', F_STALL / 9.0, 'x', '> 1 means the paws slip before anything breaks')
    print('--- with a dynamic factor of %.1f on the tooth' % DYN)
    line('Lewis root bending', s * DYN, 'MPa', 'limit %.0f' % STR_XY)


if __name__ == '__main__':
    main()
