#!/usr/bin/env python3
"""Linear static FEM of the capsule pusher, numpy only.

The STL is voxelised into cubes (8-node hexahedra, one constant element matrix) and solved with
Jacobi-preconditioned conjugate gradients, matrix-free. Stair-stepped surfaces make the very last
peak values depend on the mesh, so the report gives the 99.9th percentile as well and every case is
run at two mesh sizes.

Usage: fem.py <stl dir> <out dir> [h mm ...]
Frame (mm): x along the rail, y up, z out of the intercom; press point at x = y = 0, back at z = 0.
Load path at stall, F = rack force (see strength.py):
  servo body -> cap: R1 near the shaft end; servo body -> pocket floor: R2 at the far end
  cap -> M2 screw -> base seat (T); cap -> base seam on the far side (P)
  base -> rail: two contact bands, on the tunnel's back wall above the rail centre and on its front
  wall below it (the rail tilts inside its 0.5 mm clearance before both touch).
"""
import json, os, struct, sys, time, zlib
import numpy as np

E_MPA, NU = 2750.0, 0.35          # Bambu PLA Basic bending modulus (X-Y); nu assumed

# geometry (from fusion/capsule.py, arch pusher, RAIL_R = 0.5)
PXC, Y_T0, Y_T1, Z_T0, Z_T1 = -9.65, -16.456, -9.956, 1.6, 7.8
X_CB, X_CT, Y_SB, Y_ST, Z_SB, Z_SF, Z_CAP = -20.8, -3.5, -8.906, 11.094, 2.888, 11.188, 11.248
YS, ZS, RP, HR, GT = 6.094, 7.038, 4.5, 2.344, 3.0
SCR_X, SCR_Y, SEAT_Z, PILOT_R, HEAD_R, CLR_R = -0.4, -6.256, 3.4, 0.8, 2.1, 1.2
CLR = 0.25
Y_PITCH = YS - RP                 # the rack force acts here
Y_RC = (Y_T0 + Y_T1) / 2


def statics(F):
    """Forces on the servo and the cap, N. See the module docstring."""
    x_edge, x_far = X_CT, X_CB + 1.0
    r2 = F * (0.0 - x_edge) / (x_edge - x_far)
    r1 = F + r2
    y_pivot = -15.5
    t = r1 * (Y_PITCH - y_pivot) / (SCR_Y - y_pivot)
    p = t - r1
    fr = F * np.tan(np.radians(25.0))
    return dict(F=F, R1=r1, R2=r2, T=t, P=p, Fr=fr, y_pivot=y_pivot)


# ---------------------------------------------------------------- voxels
def read_stl(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[80:84])[0]
    a = np.frombuffer(b, dtype=np.dtype([('n', '<3f4'), ('v', '<9f4'), ('a', '<u2')]), count=n, offset=84)
    return a['v'].reshape(-1, 3, 3).astype(float)


def voxelise(tri, h):
    lo = tri.min(axis=(0, 1)) - h
    hi = tri.max(axis=(0, 1)) + h
    nx, ny, nz = np.ceil((hi - lo) / h).astype(int)
    xs, ys = lo[0] + (np.arange(nx) + 0.5) * h, lo[1] + (np.arange(ny) + 0.5) * h
    hits = [[[] for _ in range(ny)] for _ in range(nx)]
    for t in tri:
        x0, x1 = t[:, 0].min(), t[:, 0].max()
        y0, y1 = t[:, 1].min(), t[:, 1].max()
        ia, ib = np.searchsorted(xs, [x0, x1])
        ja, jb = np.searchsorted(ys, [y0, y1])
        if ia >= ib or ja >= jb:
            continue
        a, b, c = t
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        X, Y = np.meshgrid(xs[ia:ib], ys[ja:jb], indexing='ij')
        l1 = ((b[1] - c[1]) * (X - c[0]) + (c[0] - b[0]) * (Y - c[1])) / d
        l2 = ((c[1] - a[1]) * (X - c[0]) + (a[0] - c[0]) * (Y - c[1])) / d
        l3 = 1 - l1 - l2
        m = (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
        Z = l1 * a[2] + l2 * b[2] + l3 * c[2]
        for i, j in zip(*np.nonzero(m)):
            hits[ia + i][ja + j].append(Z[i, j])
    solid = np.zeros((nx, ny, nz), bool)
    zs = lo[2] + (np.arange(nz) + 0.5) * h
    for i in range(nx):
        for j in range(ny):
            z = np.sort(np.array(hits[i][j]))
            if len(z) < 2:
                continue
            for k in range(0, len(z) - 1, 2):
                solid[i, j, (zs >= z[k]) & (zs < z[k + 1])] = True
    return solid, lo


def largest_component(solid):
    """Keep the largest face-connected part, so a loose voxel cannot make K singular."""
    label = -np.ones(solid.shape, int)
    best, best_n, cur = -1, 0, 0
    for seed in np.argwhere(solid):
        if label[tuple(seed)] >= 0:
            continue
        stack, n = [tuple(seed)], 0
        label[tuple(seed)] = cur
        while stack:
            i, j, k = stack.pop()
            n += 1
            for di, dj, dk in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
                a, b, c = i + di, j + dj, k + dk
                if 0 <= a < solid.shape[0] and 0 <= b < solid.shape[1] and 0 <= c < solid.shape[2] and solid[a, b, c] and label[a, b, c] < 0:
                    label[a, b, c] = cur
                    stack.append((a, b, c))
        if n > best_n:
            best, best_n = cur, n
        cur += 1
    return label == best, cur


# ---------------------------------------------------------------- element
GP = np.array([-1, 1]) / np.sqrt(3)
NODE = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], float)


def dmat():
    l = E_MPA * NU / ((1 + NU) * (1 - 2 * NU))
    m = E_MPA / (2 * (1 + NU))
    D = np.zeros((6, 6))
    D[:3, :3] = l
    D[range(3), range(3)] = l + 2 * m
    D[range(3, 6), range(3, 6)] = m
    return D


def bmat(xi, eta, zeta, h):
    s = 2 * NODE - 1
    dN = np.zeros((8, 3))
    for a in range(8):
        dN[a, 0] = s[a, 0] * (1 + s[a, 1] * eta) * (1 + s[a, 2] * zeta) / 8
        dN[a, 1] = s[a, 1] * (1 + s[a, 0] * xi) * (1 + s[a, 2] * zeta) / 8
        dN[a, 2] = s[a, 2] * (1 + s[a, 0] * xi) * (1 + s[a, 1] * eta) / 8
    dN *= 2 / h
    B = np.zeros((6, 24))
    for a in range(8):
        B[0, 3 * a] = dN[a, 0]
        B[1, 3 * a + 1] = dN[a, 1]
        B[2, 3 * a + 2] = dN[a, 2]
        B[3, 3 * a], B[3, 3 * a + 1] = dN[a, 1], dN[a, 0]
        B[4, 3 * a + 1], B[4, 3 * a + 2] = dN[a, 2], dN[a, 1]
        B[5, 3 * a], B[5, 3 * a + 2] = dN[a, 2], dN[a, 0]
    return B


def kmat(h):
    D = dmat()
    K = np.zeros((24, 24))
    w = (h / 2) ** 3
    for a in GP:
        for b in GP:
            for c in GP:
                B = bmat(a, b, c, h)
                K += B.T @ D @ B * w
    return K


class Model:
    def __init__(self, solid, lo, h):
        self.h, self.lo = h, lo
        self.cells = np.argwhere(solid)
        nx, ny, nz = solid.shape
        grid = -np.ones((nx + 1, ny + 1, nz + 1), int)
        conn = np.zeros((len(self.cells), 8), int)
        idx = (self.cells[:, None, :] + NODE.astype(int)[None, :, :])
        flat = np.ravel_multi_index(idx.reshape(-1, 3).T, grid.shape)
        uniq, inv = np.unique(flat, return_inverse=True)
        conn = inv.reshape(-1, 8)
        self.nodes = np.column_stack(np.unravel_index(uniq, grid.shape)) * h + lo
        self.conn = conn
        self.dofs = (conn[:, :, None] * 3 + np.arange(3)).reshape(-1, 24)
        self.n = len(self.nodes) * 3
        self.Ke = kmat(h)
        self.diag = np.bincount(self.dofs.ravel(), weights=np.tile(np.diag(self.Ke), len(conn)), minlength=self.n)

    def mul(self, u):
        fe = u[self.dofs] @ self.Ke
        return np.bincount(self.dofs.ravel(), weights=fe.ravel(), minlength=self.n)

    def solve(self, f, fixed, tol=1e-6, maxit=40000):
        free = np.ones(self.n, bool)
        free[fixed] = False
        M = 1 / self.diag
        x = np.zeros(self.n)
        r = f.copy()
        r[~free] = 0
        z = M * r
        p = z.copy()
        rz = r @ z
        n0 = np.sqrt(r @ r)
        for it in range(maxit):
            Ap = self.mul(p)
            Ap[~free] = 0
            a = rz / (p @ Ap)
            x += a * p
            r -= a * Ap
            if np.sqrt(r @ r) < tol * n0:
                break
            z = M * r
            rz2 = r @ z
            p = z + rz2 / rz * p
            rz = rz2
        return x, it + 1, np.sqrt(r @ r) / n0

    def stresses(self, u):
        B = bmat(0, 0, 0, self.h)
        return (u[self.dofs] @ B.T) @ dmat()

    def centers(self):
        return self.lo + (self.cells + 0.5) * self.h


def von_mises(s):
    return np.sqrt(0.5 * ((s[:, 0] - s[:, 1]) ** 2 + (s[:, 1] - s[:, 2]) ** 2 + (s[:, 2] - s[:, 0]) ** 2) + 3 * (s[:, 3] ** 2 + s[:, 4] ** 2 + s[:, 5] ** 2))


def max_principal(s):
    A = np.zeros((len(s), 3, 3))
    A[:, 0, 0], A[:, 1, 1], A[:, 2, 2] = s[:, 0], s[:, 1], s[:, 2]
    A[:, 0, 1] = A[:, 1, 0] = s[:, 3]
    A[:, 1, 2] = A[:, 2, 1] = s[:, 4]
    A[:, 0, 2] = A[:, 2, 0] = s[:, 5]
    return np.linalg.eigvalsh(A)[:, -1]


def distribute(f, nodes_mask, axis, force):
    idx = np.nonzero(nodes_mask)[0]
    if len(idx) == 0:
        raise RuntimeError('empty load patch')
    f[idx * 3 + axis] += force / len(idx)
    return len(idx)


# ---------------------------------------------------------------- pictures, no plotting library
def png(path, rgb):
    h, w, _ = rgb.shape
    raw = b''.join(b'\0' + rgb[i].tobytes() for i in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def colour(v):
    """White (low) through blue-green-yellow to red (high), v in 0..1."""
    stops = np.array([[235, 238, 242], [60, 120, 200], [60, 180, 120], [240, 200, 60], [200, 40, 40]], float)
    t = np.clip(v, 0, 1) * (len(stops) - 1)
    i = np.minimum(t.astype(int), len(stops) - 2)
    return (stops[i] + (stops[i + 1] - stops[i]) * (t - i)[:, None]).astype(np.uint8)


def section(path, m, val, axis, plane, vmax, scale=6):
    c = m.centers()
    keep = np.abs(c[:, axis] - plane) <= m.h / 2 + 1e-9
    a, b = [i for i in range(3) if i != axis]
    ca, cb = m.cells[keep, a], m.cells[keep, b]
    if len(ca) == 0:
        return
    W, H = ca.max() - ca.min() + 1, cb.max() - cb.min() + 1
    img = np.full((H, W, 3), 255, np.uint8)
    img[H - 1 - (cb - cb.min()), ca - ca.min()] = colour(val[keep] / vmax)
    png(path, np.repeat(np.repeat(img, scale, 0), scale, 1))


# ---------------------------------------------------------------- cases
def near(c, v, h):
    return np.abs(c - v) <= h * 0.75


def pin_rigid(m, band):
    """Stop x and y rigid motion and the spin about z through a few band nodes; no net x/y load exists."""
    idx = np.nonzero(band)[0]
    n = m.nodes[idx]
    a = idx[np.argmin(n[:, 0])]
    b = idx[np.argmax(n[:, 0])]
    return [a * 3, a * 3 + 1, b * 3 + 1]


def case_base(stl, h, F, out):
    tri = read_stl(os.path.join(stl, 'base.stl'))
    solid, lo = voxelise(tri, h)
    solid, parts = largest_component(solid)
    m = Model(solid, lo, h)
    n = m.nodes
    x, y, z = n[:, 0], n[:, 1], n[:, 2]
    s = statics(F)
    f = np.zeros(m.n)
    r = {}
    rad = np.hypot(x - SCR_X, y - SCR_Y)
    r['seat'] = distribute(f, near(z, SEAT_Z, h) & (rad >= CLR_R - h) & (rad <= HEAD_R + h), 2, s['T'])
    r['seam'] = distribute(f, near(z, Z_CAP, h) & (y > -17.4) & (y < s['y_pivot'] + 1.5), 2, -s['P'])
    r['floor'] = distribute(f, near(z, Z_SB - CLR, h) & (x > X_CB - CLR) & (x < X_CB + 1.5) & (y > Y_SB) & (y < Y_ST), 2, -s['R2'])
    r['guide'] = distribute(f, near(y, -HR - CLR, h) & (np.abs(x) < GT / 2 + CLR) & (z > 1.0) & (z < 8.0), 1, -s['Fr'])
    r['pocket top'] = distribute(f, near(y, Y_ST + CLR, h) & (x > -8.0) & (x < X_CT) & (z > 4.0) & (z < 10.0), 1, s['Fr'])
    # rail contact: flats end 2.5 mm from the rail centre (R0.5 corners); the pad pocket interrupts the front wall
    back = near(z, Z_T0, h) & (y > Y_RC + 1.9) & (y < Y_RC + 3.1)
    front = near(z, Z_T1, h) & (y > Y_RC - 3.1) & (y < Y_RC - 1.9) & (np.abs(x - PXC) > 4.2)
    fixed = list(np.nonzero(back)[0] * 3 + 2) + list(np.nonzero(front)[0] * 3 + 2) + pin_rigid(m, back)
    t0 = time.time()
    u, it, res = m.solve(f, np.array(fixed))
    react = m.mul(u) - f
    Rb, Rf = react[np.nonzero(back)[0] * 3 + 2].sum(), react[np.nonzero(front)[0] * 3 + 2].sum()
    sig = m.stresses(u)
    return report('base', m, sig, u, it, res, time.time() - t0, s, out, dict(load_nodes=r, parts=int(parts), R_back=float(Rb), R_front=float(Rf)),
                  sections=[(0, 0.0), (2, 1.0), (0, PXC)], press=(0.0, 0.0, 0.3))


def case_cap(stl, h, F, out):
    tri = read_stl(os.path.join(stl, 'cap.stl'))
    solid, lo = voxelise(tri, h)
    solid, parts = largest_component(solid)
    m = Model(solid, lo, h)
    n = m.nodes
    x, y, z = n[:, 0], n[:, 1], n[:, 2]
    s = statics(F)
    f = np.zeros(m.n)
    r = {}
    r['servo'] = distribute(f, near(z, Z_CAP, h) & (x > X_CT - 3.0) & (x < X_CT) & (y > Y_PITCH - 4.0) & (y < Y_PITCH + 4.0), 2, s['R1'])
    rad = np.hypot(x - SCR_X, y - SCR_Y)
    thread = (rad < PILOT_R + h) & (z > Z_CAP + 0.2) & (z < 13.4)
    seam = near(z, Z_CAP, h) & (y > -17.1) & (y < s['y_pivot'] + 1.5)
    fixed = list(np.nonzero(thread)[0] * 3 + 2) + list(np.nonzero(seam)[0] * 3 + 2) + pin_rigid(m, seam)
    t0 = time.time()
    u, it, res = m.solve(f, np.array(fixed))
    react = m.mul(u) - f
    Rt, Rs = react[np.nonzero(thread)[0] * 3 + 2].sum(), react[np.nonzero(seam)[0] * 3 + 2].sum()
    sig = m.stresses(u)
    return report('cap', m, sig, u, it, res, time.time() - t0, s, out, dict(load_nodes=r, parts=int(parts), R_thread=float(Rt), R_seam=float(Rs)),
                  sections=[(0, X_CT - 1.0), (2, 11.5)], press=None)


def report(name, m, sig, u, it, res, secs, s, out, extra, sections, press):
    vm = von_mises(sig)
    p1 = max_principal(sig)
    szz = sig[:, 2]
    c = m.centers()
    # values next to the load and support patches are artefacts of the patches: list them, but judge on percentiles
    res_d = dict(part=name, h=m.h, elements=len(m.cells), dof=m.n, iterations=it, residual=float(res), seconds=round(secs, 1), F=s['F'], statics={k: float(v) for k, v in s.items()},
                 vm_max=float(vm.max()), vm_p999=float(np.percentile(vm, 99.9)), vm_p99=float(np.percentile(vm, 99)),
                 p1_max=float(p1.max()), p1_p999=float(np.percentile(p1, 99.9)),
                 szz_max=float(szz.max()), szz_p999=float(np.percentile(szz, 99.9)),
                 where_vm=[round(float(v), 2) for v in c[int(np.argmax(vm))]], where_szz=[round(float(v), 2) for v in c[int(np.argmax(szz))]],
                 u_max_mm=float(np.abs(u.reshape(-1, 3)).max()), **extra)
    if press is not None:
        d = np.linalg.norm(m.nodes - np.array(press), axis=1)
        res_d['uz_at_guide_mm'] = float(u.reshape(-1, 3)[int(np.argmin(d)), 2])
    vmax = max(res_d['vm_p999'], 0.5)
    for axis, plane in sections:
        section(os.path.join(out, 'fem_%s_%s%g_h%g.png' % (name, 'xyz'[axis], plane, m.h)), m, vm, axis, plane, vmax)
    return res_d


def main():
    stl, out = sys.argv[1], sys.argv[2]
    hs = [float(v) for v in sys.argv[3:]] or [0.4, 0.3]
    os.makedirs(out, exist_ok=True)
    F = float(os.environ.get('FEM_F', 13.07))
    results = []
    for h in hs:
        for fn in (case_base, case_cap):
            r = fn(stl, h, F, out)
            results.append(r)
            print(json.dumps({k: v for k, v in r.items() if k != 'statics'}), flush=True)
    json.dump(results, open(os.path.join(out, 'fem_results.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
