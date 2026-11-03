"""One A1 mini plate for the v6 set: parent, 2 pushers, 2 racks, 2 pinions, the grooved rail on the diagonal, groove up."""
import os, numpy as np, trimesh
T = trimesh.transformations
stl = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'stl')
Ry = lambda a: T.rotation_matrix(np.radians(a), (0, 1, 0))
Rx = lambda a: T.rotation_matrix(np.radians(a), (1, 0, 0))
Rz = lambda a: T.rotation_matrix(np.radians(a), (0, 0, 1))
parts = []


def put(name, x, y, rot=None):
    m = trimesh.load(os.path.join(stl, name))
    if rot is not None:
        m.apply_transform(rot)
    m.apply_translation((x - m.bounds[0][0], y - m.bounds[0][1], -m.bounds[0][2]))
    parts.append(m)


put('capsule_v6_main_back_PLA.stl', 6, 118)
put('capsule_v6_main_front_PLA.stl', 41, 118)
put('capsule_v6_pusher_base_PLA.stl', 6, 72)
put('capsule_v6_pusher_cap_PLA.stl', 76, 134)
put('capsule_v6_pusher_base_PLA.stl', 144, 6)
put('capsule_v6_pusher_cap_PLA.stl', 109, 6)
for i in range(2):
    put('capsule_v6_rack_PLA.stl', 8 + 16 * i, 50, Ry(90))
    put('capsule_v6_pinion_PLA.stl', 146 + 14 * i, 54, Ry(90))
r = trimesh.load(os.path.join(stl, 'rail_grooved_200mm_5.88_PLA.stl'))
r.apply_transform(Rx(180))
r.apply_translation(-r.bounds.mean(axis=0))
r.apply_transform(Rz(45))
r.apply_translation((90, 90, -r.bounds[0][2]))
parts.append(r)
for i, a in enumerate(parts):
    for b in parts[i + 1:]:
        if a is not r and b is not r:
            lo, hi = np.maximum(a.bounds[0], b.bounds[0]), np.minimum(a.bounds[1], b.bounds[1])
            assert not (hi[:2] > lo[:2]).all(), 'overlap'
out = trimesh.util.concatenate(parts)
print('plate', out.bounds.round(1).tolist(), 'watertight parts', [p.is_watertight for p in parts].count(True), '/', len(parts))
# distance of each part from the rail's centre line
for p in parts[:-1]:
    c = p.bounds[[0, 1]][:, :2]
    corners = [(c[i][0], c[j][1]) for i in (0, 1) for j in (0, 1)]
    d = [(y - x) / np.sqrt(2) for x, y in corners]
    if min(d) < 6 and max(d) > -6:
        raise SystemExit('touches the rail band: %s' % (p.bounds.round(1).tolist(),))
out.export(os.path.join(stl, 'plate_v6_set_rail200_PLA.stl'))
