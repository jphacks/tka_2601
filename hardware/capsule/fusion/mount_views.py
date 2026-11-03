# Capsule v2 on the intercom stand-ins from the universal-mount study (specs.py): real capsule bodies,
# the kotori v3.1 paws and rail, placed on the same press points. Every part is checked against the
# intercom, and the keys, screen and other front features under a capsule or the rail are listed.
# Intercom outlines are published sizes; key positions are estimates (specs.py says about +/-10 mm).
#
# Run from run_mount.py inside your own open design document.
import json, math, os


def body_rect(px, py, sx, sy, C):
    """Capsule outline in the face plane as (centre line x, y0, y1, half width)."""
    return px, py, sx, sy, C


def in_stadium(x, y, px, py, sx, sy, C):
    """Inside the pusher's arch outline (the lower corner radius is ignored: slightly generous)."""
    lx, ly = (x - px) / sx - C['PXC'], (y - py) / sy
    if abs(lx) > C['PR'] or ly < C['P_ARCH'][1]:
        return False
    yc = C['P_ARCH'][0]
    return ly <= yc or math.hypot(lx, ly - yc) <= C['PR']


def rect_hits(cx, cy, w, h, shape):
    n = 13
    pts = []
    for i in range(n):
        for j in range(n):
            u, v = (i / (n - 1.0) - 0.5) * w, (j / (n - 1.0) - 0.5) * h
            if shape == 'round' and math.hypot(u, v) > w / 2.0:
                continue
            pts.append((cx + u, cy + v))
    return pts


def covered(spec, pressed, capsules, ry, x_rail, C):
    """Fraction of each front feature hidden by a capsule or the rail."""
    feats = []
    for b in spec['buttons']:
        if b['label'] in pressed:
            continue
        feats.append((b['label'], rect_hits(b['cx'], b['cy'], b['w'], b.get('h', b['w']), b.get('shape', 'rect'))))
    if 'screen' in spec:
        sx, sy, sw, sh = spec['screen']
        feats.append(('screen', rect_hits(sx, sy, sw, sh, 'rect')))
    if 'panel' in spec:
        sx, sy, sw, sh = spec['panel']
    if 'grille' in spec:
        g = spec['grille']
        feats.append(('speaker grille', rect_hits(g[0], g[1], g[2], g[3], 'rect')))
    if 'camera' in spec:
        c = spec['camera']
        feats.append(('camera', rect_hits(c[0], c[1], 2 * c[2], 2 * c[2], 'round')))
    if 'mic' in spec:
        feats.append(('mic', rect_hits(spec['mic'][0], spec['mic'][1], 3, 3, 'round')))
    for i, l in enumerate(spec.get('leds', [])):
        feats.append(('LED %d' % (i + 1), rect_hits(l[0], l[1], 3, 3, 'round')))
    out = {}
    for name, pts in feats:
        hit = 0
        for x, y in pts:
            if any(in_stadium(x, y, *c) for c in capsules) or (x_rail[0] <= x <= x_rail[1] and abs(y - ry) <= C['RAIL'] / 2.0):
                hit += 1
        if hit:
            out[name] = round(100.0 * hit / len(pts))
    return out


def place_capsules(spec, H, C):
    """Press points, as in concept_S3: one rail, a capsule per pressed key; the rail runs between two rows."""
    W = spec['W']
    rows = H['key_rows'](spec)
    Y_RC = C['Y_RC']
    if len(rows) == 1:
        ry = sum(H['press_pt'](b)[1] for b in rows[0]) / len(rows[0]) + Y_RC
        y_off = 5.0
    else:
        ys = [sum(H['press_pt'](b)[1] for b in r) / len(r) for r in rows]
        ry = (ys[0] + ys[1]) / 2.0
        y_off = 0.0
    out = []
    for r in rows:
        for b in r:
            qx, qy = H['press_pt'](b)
            hang = qy < ry
            sy = -1.0 if hang else 1.0
            py = ry + sy * (-Y_RC)
            kw = b.get('w', 10)
            best = None
            for sx in (1.0, -1.0):
                # body as central on the key as the key allows; keep it off the paws
                shift = min(abs(C['PXC']), max(kw / 2.0 - 3.0, 0.0))
                px = qx + sx * shift
                xc = px + sx * C['PXC']
                over = max(abs(xc) + C['PW'] / 2.0 - (W / 2.0 - 0.5), 0.0)
                cost = over * 100 + abs(xc)
                if best is None or cost < best[0]:
                    best = (cost, px, sx, over)
            _, px, sx, over = best
            out.append(dict(key=b['label'], key_xy=(qx, qy), px=px, py=py, sx=sx, sy=sy, overhang=over, part='N' if sx * sy > 0 else 'M',
                            press_off_key_y=py - qy, key_h=b.get('h', b['w'])))
    return out, ry, y_off


def press_margins(spec, c, z0, C):
    """Does the rack tip land on the key, and how far can it push? Press point in the face plane."""
    b = [k for k in spec['buttons'] if k['label'] == c['key']][0]
    top = b.get('h_up', 1.6)
    gap = z0 + 0.3 - top                       # rack tip at rest (0.3 above the capsule back) to the key top
    depth = C['STROKE'] - gap                  # how far past the key's rest position the full stroke goes
    hw, hh = C['GT'] / 2.0, C['HR']
    n, inside = 15, 0
    w, h = b['w'], b.get('h', b['w'])
    round_key = b.get('shape') == 'round'
    for i in range(n):
        for j in range(n):
            x = c['px'] + (i / (n - 1.0) * 2 - 1) * hw - b['cx']
            y = c['py'] + (j / (n - 1.0) * 2 - 1) * hh - b['cy']
            on = math.hypot(x, y) <= w / 2.0 if round_key else (abs(x) <= w / 2.0 and abs(y) <= h / 2.0)
            inside += on
    return dict(key_top=round(top, 2), rest_gap=round(gap, 2), depth_past_top=round(depth, 2), tip_on_key_percent=round(100.0 * inside / n ** 2),
                tilt_loss=0.39, depth_after_tilt=round(depth - 0.39, 2))


def press_section(key, H, C, parts, pal, outdir, spec, caps, z0, ry, root, solids):
    """Cut through the first capsule's rack, rack at the point it reaches the key."""
    tbm, copyb = C['tbm'], C['copyb']
    out = []
    for i, c in enumerate(caps):
        m = press_margins(spec, c, z0, C)
        for j in range(root.occurrences.count):
            root.occurrences.item(j).isLightBulbOn = False
        occ = C['new_occ'](root, 'section %d' % i)
        comp = occ.component
        lo_x, hi_x = c['px'] - 60, c['px']
        y0, y1 = c['py'] - 45, c['py'] + 45
        cut = lambda b: (tbm.booleanOperation(b, C['tbox'](lo_x, y0, -60, hi_x, y1, 40), C['INTER']) and b.faces.count) and b
        t = transform(C, c['sx'], c['sy'], c['px'], c['py'], z0)
        t_rack = transform(C, c['sx'], c['sy'], c['px'], c['py'], z0 - m['rest_gap'])
        items = []
        for sn, s_ in solids.items():
            if 'wall' in sn:
                continue
            items.append((copyb(s_), pal['cream']))
        for nm, b, ap, tt in (('base', parts['pusher']['base'], pal['matte black'], t), ('cap', parts['pusher']['cap'], pal['matte black'], t),
                              ('rack', parts['mech']['rack'], pal['orange'], t_rack), ('pinion', parts['mech']['pinion'], pal['white2'], t),
                              ('servo', parts['servo'], pal['m5'], t)):
            bb = copyb(b)
            tbm.transform(bb, tt)
            items.append((bb, ap))
        rail = C['rail_bar'](lo_x - 5, hi_x + 5, ry - C['RAIL'] / 2.0, z0 + C['Z_T0'], ry + C['RAIL'] / 2.0, z0 + C['Z_T0'] + C['RAIL'], C['RAIL_R'])
        items.append((rail, pal['pad grey']))
        for b, ap in items:
            r = cut(b)
            if r:
                C['add'](comp, r, 'part', ap)
        path = os.path.join(outdir, 'press_%s_%d.png' % (key, i + 1))
        C['shoot'](path, (c['px'] + 150, c['py'], z0 + 6), (c['px'], c['py'], z0 + 4), (0, 1, 0), 1100, 1100, 1.0)
        occ.deleteMe()
        for j in range(root.occurrences.count):
            root.occurrences.item(j).isLightBulbOn = True
        out.append(os.path.basename(path))
    return out


def transform(C, sx, sy, tx, ty, tz):
    import adsk.core
    m = adsk.core.Matrix3D.create()
    m.setCell(0, 0, sx)
    m.setCell(1, 1, sy)
    # a mirrored placement stays a valid solid: only the determinant's sign tells the part (N or M)
    m.setCell(2, 2, 1.0)
    m.translation = adsk.core.Vector3D.create(C['cm'](tx), C['cm'](ty), C['cm'](tz))
    return m


def build(key, H, C, parts, pal, outdir, views=True, check=True):
    tbm, overlap = C['tbm'], C['overlap']
    copyb = C['copyb']
    des = C['design']()
    root = des.rootComponent
    for i in range(root.occurrences.count - 1, -1, -1):
        root.occurrences.item(i).deleteMe()
    spec = H['SPECS'][key]
    W, h_, D = spec['W'], spec['H'], spec['D']
    H['intercom'](root, spec, pal)
    wall_ok = not spec.get('hub_on_desk')
    if wall_ok:
        H['wall'](root, pal, -W / 2 - 110, -h_ / 2 - 120, W / 2 + 130, h_ / 2 + 60, -D)
    # all intercom solids, for the checks
    solids = {}
    for i in range(root.allOccurrences.count):
        o = root.allOccurrences.item(i)
        for b in o.bRepBodies:
            solids[o.component.name + '/' + b.name] = tbm.copy(b)
    for b in root.bRepBodies:
        solids['root/' + b.name] = tbm.copy(b)
    z0 = max(b.get('h_up', 1.6) for b in spec['buttons']) + 1.2
    caps, ry, y_off = place_capsules(spec, H, C)
    black = pal['matte black']
    rep = dict(model=spec['name'], W=W, H=h_, D=D, z0=round(z0, 2), rail_y=round(ry, 2), capsules=[], hits=[])
    printed = {}

    log = open(os.path.join(outdir, '..', 'calc', 'results', 'mount_check.log'), 'a')

    def safe_overlap(a_name, a_body, b_name, b_body):
        log.write('%s %s | %s\n' % (key, a_name, b_name))
        log.flush()
        return overlap(a_body, b_body)

    def add(name, body):
        o = C['new_occ'](root, name)
        C['add'](o.component, body, name, black)
        printed[name] = body

    capsules_xy = []
    for i, c in enumerate(caps):
        m = transform(C, c['sx'], c['sy'], c['px'], c['py'], z0)
        for nm in ('base', 'cap'):
            b = copyb(parts['pusher'][nm])
            tbm.transform(b, m)
            add('pusher %d %s' % (i + 1, nm), b)
        capsules_xy.append(body_rect(c['px'], c['py'], c['sx'], c['sy'], C))
        rep['capsules'].append(dict(key=c['key'], point=[round(c['px'], 1), round(c['py'], 1)], key_centre=[round(v, 1) for v in c['key_xy']],
                                    part=c['part'], flipped=c['sy'] < 0, overhang_mm=round(c['overhang'], 1), press_off_key_y=round(c['press_off_key_y'], 1), key_h=c['key_h'],
                                    press=press_margins(spec, c, z0, C)))
    # paws: reach as concept_S3, one each side
    reach = min(14.0, D - 6.0)
    for s, nm, thr in ((-1, 'paw L', False), (1, 'paw R', True)):
        body, pad, head = H['paw_bodies'](W, ry, z0, s, reach, y_off, thr)
        add(nm, body)
        o = C['new_occ'](root, nm + ' pad')
        C['add'](o.component, pad, 'pad', pal['pad grey'])
        o = C['new_occ'](root, nm + ' screw')
        C['add'](o.component, head, 'screw', black)
        printed[nm + ' pad'] = pad
    # main capsule at the rail's right end, hanging below the rail; USB-C straight down
    xb = W / 2.0 + 13.0 + 1.5 + C['MW'] / 2.0
    m = transform(C, 1.0, 1.0, xb, ry - C['RAIL_Y'], z0)
    for nm in ('back', 'front'):
        b = copyb(parts['main'][nm])
        tbm.transform(b, m)
        add('main ' + nm, b)
    x0, x1 = -W / 2.0 - 11.4, xb + C['MW'] / 2.0 - 1.5
    rail = C['rail_bar'](x0, x1, ry - C['RAIL'] / 2.0, z0 + C['Z_T0'], ry + C['RAIL'] / 2.0, z0 + C['Z_T0'] + C['RAIL'], C['RAIL_R'])
    add('rail', rail)
    y_bot = ry - C['RAIL_Y']
    plug = C['tbox'](xb - 6.2, y_bot - 18, z0 + 0.45, xb + 6.2, y_bot + C['S_Y0'] - 0.1, z0 + 6.95)
    cable = C['tcyl']((xb, y_bot - 18, z0 + 3.7), (xb, y_bot - 95, z0 + 3.7), 2.0)
    add('USB-C plug', plug)
    add('USB-C cable', cable)
    # ---- checks: printed parts against the intercom, the wall and each other
    names = list(printed) if check else []
    for n in names:
        for sn, s in solids.items():
            if n.endswith(' pad'):
                continue
            v = safe_overlap(n, printed[n], sn, s)
            if v > 0.01:
                rep['hits'].append([n, sn, round(v, 2)])
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if a.split()[0] == b.split()[0] and a.split()[:2] == b.split()[:2]:
                continue
            if a == 'rail' or b == 'rail':
                if 'paw' in a or 'paw' in b or 'pusher' in a or 'pusher' in b or 'main' in a or 'main' in b:
                    continue
            if 'paw' in a and 'paw' in b and a.split()[1] == b.split()[1]:
                continue
            v = safe_overlap(a, printed[a], b, printed[b])
            if v > 0.01:
                rep['hits'].append([a, b, round(v, 2)])
    pressed = [c['key'] for c in caps]
    rep['covered_percent'] = covered(spec, pressed, capsules_xy, ry, (x0, x1), C)
    rep['paw_reach_mm'] = reach
    rep['paw_y'] = [round(ry + y_off - 8, 1), round(ry + y_off + 8, 1)]
    rep['main_below_intercom_mm'] = round(-h_ / 2.0 - (ry - C['RAIL_Y']), 1)
    rep['rail_length_mm'] = round(x1 - x0, 1)
    if views:
        C['app'].activeViewport.visualStyle = C['adsk'].core.VisualStyles.ShadedVisualStyle
        tgt = ((x0 + x1) / 2.0 * 0.4, -h_ * 0.12, 0)
        C['shoot'](os.path.join(outdir, 'mount_%s_iso.png' % key), (tgt[0] + 220, tgt[1] + 90, 400), tgt, (0, 1, 0), 1500, 1100, 1.05)
        C['shoot'](os.path.join(outdir, 'mount_%s_front.png' % key), (tgt[0], tgt[1], 520), tgt, (0, 1, 0), 1500, 1100, 1.05)
        rep['press_images'] = press_section(key, H, C, parts, pal, outdir, spec, caps, z0, ry, root, solids)
    return rep
