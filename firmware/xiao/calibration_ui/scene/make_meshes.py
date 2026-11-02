#!/usr/bin/env python3
"""Exact CAD STLs -> small web meshes: weld and cluster vertices on a size-dependent grid, then base64.

python3 make_meshes.py hardware/dango_proto/stl hardware/capsule monban_meshes.js
Run again when the printed parts change, then update SHAPES in monban_scene.js from the CAD scripts.
tests/ui_test.mjs fails while the meshes and SHAPES disagree.
"""
import base64, json, pathlib, struct, sys
import numpy as np
H, C, out = map(pathlib.Path, sys.argv[1:4])
def load(path):
    b = path.read_bytes(); n = struct.unpack('<I', b[80:84])[0]
    a = np.frombuffer(b, dtype=np.dtype([('n','<3f4'),('v','<9f4'),('a','<u2')]), count=n, offset=84)
    return a['v'].reshape(-1, 3).astype(np.float64)
def decimate(v, fine=False):
    size = v.max(0) - v.min(0)
    grid = 0.12 if fine else float(np.clip(np.linalg.norm(size) / 90.0, 0.06, 0.6))
    key = np.round(v / grid).astype(np.int64)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    pos = np.zeros((len(uniq), 3)); count = np.bincount(inv, minlength=len(uniq))
    for k in range(3):
        pos[:, k] = np.bincount(inv, weights=v[:, k], minlength=len(uniq)) / count
    tri = inv.reshape(-1, 3)
    ok = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])
    return pos, tri[ok]
parts = {}
stls = {f'sit_M_{n}': H/f'kotori_sit_M_{n}_{c}.stl' for n, c in [('base','PLA-body'),('cap','PLA-body'),('beak','PLA-deeporange'),('cheeks','PLA-pink'),('eyes','PLA-black'),('eyeshine','PLA-white'),('highlight','PLA-cream'),('tuft','PLA-deeporange')]}
stls |= {f'sit_N_{n}': H/f'kotori_sit_N_{n}_{c}.stl' for n, c in [('base','PLA-body'),('cap','PLA-body'),('beak','PLA-deeporange'),('cheeks','PLA-pink'),('eyes','PLA-black'),('eyeshine','PLA-white'),('highlight','PLA-cream'),('tuft','PLA-deeporange')]}
stls |= {f'hang_N_{n}': H/f'kotori_hang_N_{n}_{c}.stl' for n, c in [('base','PLA-body'),('cap','PLA-body'),('beak','PLA-deeporange'),('cheeks','PLA-pink'),('eyes','PLA-black'),('eyeshine','PLA-white'),('highlight','PLA-cream'),('ribbon','PLA-deeporange')]}
stls |= {f'oya_{n}': H/f'oyadori_{n}_PLA-{c}.stl' for n, c in [('back','orange'),('front','orange'),('belly','cream'),('beak','deeporange'),('cheeks','pink'),('eyes','black'),('eyeshine','white'),('tuft','orange'),('wings','deeporange')]}
stls |= {'rack': H/'rack_PLA.stl', 'pinion': H/'pinion_PLA.stl', 'paw_L_rows2': H/'paw_L_two-rows_PETG-orange.stl', 'paw_R_rows2': H/'paw_R_two-rows_PETG-orange.stl', 'paw_L_std': H/'paw_L_std_PETG-orange.stl', 'paw_R_std': H/'paw_R_std_PETG-orange.stl'}
stls |= {'cap_base': C/'stl/capsule_pusher_base_PLA.stl', 'cap_shell': C/'stl/capsule_pusher_cap_PLA.stl', 'main_back': C/'stl/capsule_main_back_PLA.stl', 'main_front': C/'stl/capsule_main_front_PLA.stl'}
total = 0
for name, path in stls.items():
    pos, tri = decimate(load(path), name == 'main_front')  # keeps the speaker holes
    q = np.round(pos * 50).astype('<i2')  # 0.02 mm
    idx = tri.astype('<u2' if len(pos) < 65536 else '<u4')
    parts[name] = dict(p=base64.b64encode(q.tobytes()).decode(), i=base64.b64encode(idx.tobytes()).decode(), w=idx.dtype.itemsize)
    total += len(tri)
    print(f'{name:18} {len(load(path))//3:7} -> {len(tri):6} tris')
text = 'window.MONBAN_MESHES=' + json.dumps(parts, separators=(',', ':')) + ';\n'
out.write_text(text)
print('total tris', total, 'file KB', len(text) // 1024)
