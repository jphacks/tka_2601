# MONBAN capsule v1: a plain pill-shaped alternative to the birds, for shops.
# Same rail (6 x 6 x 1), paws and pusher mechanism (FS0307 + pinion m0.75 + rack) as kotori v3.1,
# same XIAO stack as oyadori v3.3. No face, no trims, two printed shells per capsule.
#
# Frames (mm): x along the rail, y up, z out of the intercom; the capsule back is z = 0.
#   pusher: origin at the press point (as kotori). main: x = 0 on the centre line, y = 0 at the bottom.
# Run from Fusion through run_capsule.py. The script needs its own open design document.
import math, os
import adsk.core, adsk.fusion

app = adsk.core.Application.get()
tbm = adsk.fusion.TemporaryBRepManager.get()
UNION = adsk.fusion.BooleanTypes.UnionBooleanType
DIFF = adsk.fusion.BooleanTypes.DifferenceBooleanType
INTER = adsk.fusion.BooleanTypes.IntersectionBooleanType
DOC = {}


def design():
    return DOC['des']


def cm(v):
    return v / 10.0


def P(x, y, z):
    return adsk.core.Point3D.create(cm(x), cm(y), cm(z))


def V(x, y, z):
    return adsk.core.Vector3D.create(x, y, z)


def tbox(x0, y0, z0, x1, y1, z1):
    xa, xb = sorted((x0, x1)); ya, yb = sorted((y0, y1)); za, zb = sorted((z0, z1))
    o = adsk.core.OrientedBoundingBox3D.create(P((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2), V(1, 0, 0), V(0, 1, 0),
                                               cm(xb - xa), cm(yb - ya), cm(zb - za))
    return tbm.createBox(o)


def tcyl(p1, p2, r, r2=None):
    return tbm.createCylinderOrCone(P(*p1), cm(r), P(*p2), cm(r if r2 is None else r2))


def uni(a, *bs):
    for b in bs:
        tbm.booleanOperation(a, b, UNION)
    return a


def sub(a, *bs):
    for b in bs:
        tbm.booleanOperation(a, b, DIFF)
    return a


def copyb(b):
    return tbm.copy(b)


def inter(a, *bs):
    for b in bs:
        tbm.booleanOperation(a, b, INTER)
    return a


def rbox(x0, y0, z0, x1, y1, z1, r):
    b = uni(tbox(x0 + r, y0, z0, x1 - r, y1, z1), tbox(x0, y0 + r, z0, x1, y1 - r, z1))
    for cx in (x0 + r, x1 - r):
        for cy in (y0 + r, y1 - r):
            uni(b, tcyl((cx, cy, z0), (cx, cy, z1), r))
    return b


def rbar_x(x0, x1, y0, z0, y1, z1, r):
    """Bar along x with its long edges rounded."""
    if r <= 0:
        return tbox(x0, y0, z0, x1, y1, z1)
    b = uni(tbox(x0, y0 + r, z0, x1, y1 - r, z1), tbox(x0, y0, z0 + r, x1, y1, z1 - r))
    for cy in (y0 + r, y1 - r):
        for cz in (z0 + r, z1 - r):
            uni(b, tcyl((x0, cy, cz), (x1, cy, cz), r))
    return b


def rail_bar(x0, x1, y0, z0, y1, z1, r):
    """The rail as drawn in the assembly: long edges rounded, both ends rounded the same way."""
    if r <= 0:
        return tbox(x0, y0, z0, x1, y1, z1)
    occ = new_occ(design().rootComponent, 'scratch')
    c = occ.component
    body = c.bRepBodies.add(tbox(x0, y0, z0, x1, y1, z1))
    col = adsk.core.ObjectCollection.create()
    for e in body.edges:
        col.add(e)
    fi = c.features.filletFeatures.createInput()
    fi.edgeSetInputs.addConstantRadiusEdgeSet(col, adsk.core.ValueInput.createByReal(cm(r)), True)
    c.features.filletFeatures.add(fi)
    out = tbm.copy(c.bRepBodies.item(0))
    occ.deleteMe()
    return out


def new_occ(parent, name):
    occ = parent.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    occ.component.name = name
    return occ


def add(comp, temp, name, ap=None):
    body = comp.bRepBodies.add(temp)
    body.name = name
    if ap is not None:
        body.appearance = ap
    return body


def mtx(tx=0.0, ty=0.0, tz=0.0, rz180=False):
    m = adsk.core.Matrix3D.create()
    if rz180:
        m.setCell(0, 0, -1.0)
        m.setCell(1, 1, -1.0)
    m.translation = V(cm(tx), cm(ty), cm(tz))
    return m


def moved(b, m):
    c = copyb(b)
    tbm.transform(c, m)
    return c


def pill(xc, y0, y1, w, z0, z1, rb, rf):
    """Stadium seen from the front, rounded back (rb) and front (rf) edges. Built with real
    features (tangent torus/cylinder unions in temporary BRep are fragile), then copied out."""
    root = design().rootComponent
    occ = new_occ(root, 'scratch')
    c = occ.component
    pl = c.constructionPlanes.createInput()
    pl.setByOffset(c.xYConstructionPlane, adsk.core.ValueInput.createByReal(cm(z0)))
    sk = c.sketches.add(c.constructionPlanes.add(pl))
    r = w / 2.0
    ya, yb = y0 + r, y1 - r
    L, A = sk.sketchCurves.sketchLines, sk.sketchCurves.sketchArcs
    q = lambda x, y: sk.modelToSketchSpace(P(x, y, z0))
    A.addByThreePoints(q(xc - r, ya), q(xc, y0), q(xc + r, ya))
    A.addByThreePoints(q(xc + r, yb), q(xc, y1), q(xc - r, yb))
    L.addByTwoPoints(q(xc + r, ya), q(xc + r, yb))
    L.addByTwoPoints(q(xc - r, yb), q(xc - r, ya))
    ext = c.features.extrudeFeatures.addSimple(sk.profiles.item(0), adsk.core.ValueInput.createByReal(cm(z1 - z0)),
                                               adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    body = ext.bodies.item(0)
    for rad, zz in ((rb, z0), (rf, z1)):
        if rad <= 0.02:
            continue
        col = adsk.core.ObjectCollection.create()
        for e in body.edges:
            bb = e.boundingBox
            if abs(bb.minPoint.z - cm(zz)) < 1e-5 and abs(bb.maxPoint.z - cm(zz)) < 1e-5:
                col.add(e)
        fi = c.features.filletFeatures.createInput()
        fi.edgeSetInputs.addConstantRadiusEdgeSet(col, adsk.core.ValueInput.createByReal(cm(rad)), True)
        c.features.filletFeatures.add(fi)
        body = c.bRepBodies.item(0)
    out = tbm.copy(body)
    occ.deleteMe()
    return out


def _profile(sk, pts_fn, path):
    """Closed sketch path. path = [('L', p) | ('A', mid, p)], first entry ('M', p)."""
    L, A = sk.sketchCurves.sketchLines, sk.sketchCurves.sketchArcs
    first = cur = pts_fn(*path[0][1])
    first_pt = None
    for seg in path[1:]:
        tgt = pts_fn(*seg[-1])
        if seg[0] == 'L':
            c = L.addByTwoPoints(cur, tgt)
            a, b = c.startSketchPoint, c.endSketchPoint
        else:
            c = A.addByThreePoints(cur, pts_fn(*seg[1]), tgt)
            a, b = (c.startSketchPoint, c.endSketchPoint)
            if a.geometry.distanceTo(cur.geometry if hasattr(cur, 'geometry') else cur) > b.geometry.distanceTo(cur.geometry if hasattr(cur, 'geometry') else cur):
                a, b = b, a
        first_pt = first_pt or a
        cur = b
    L.addByTwoPoints(cur, first_pt)


def _half_path(r, R, zc, z0, rb, rf):
    """Half section, x >= 0: flat back, side wall, crease fillet rf, then the front arc of radius R
    about (0, zc) up to the crown. Returned as outer path from the back centre to the crown."""
    p = [('M', (0.0, z0))]
    if rb > 0.02:
        p.append(('L', (r - rb, z0)))
        m = math.radians(45)
        p.append(('A', (r - rb + rb * math.sin(m), z0 + rb - rb * math.cos(m)), (r, z0 + rb)))
    else:
        p.append(('L', (r, z0)))
    if rf > 0.02:
        zf = zc + math.sqrt((R - rf) ** 2 - (r - rf) ** 2)
        p.append(('L', (r, zf)))
        tx, tz = (r - rf) * R / (R - rf), zc + (zf - zc) * R / (R - rf)
        a0, a1 = 0.0, math.atan2(tz - zf, tx - (r - rf))
        am = (a0 + a1) / 2
        p.append(('A', (r - rf + rf * math.cos(am), zf + rf * math.sin(am)), (tx, tz)))
    else:
        tx, tz = r, zc + math.sqrt(R * R - r * r)
        p.append(('L', (tx, tz)))
    a = math.asin(tx / R) / 2
    p.append(('A', (R * math.sin(a), zc + R * math.cos(a)), (0.0, zc + R)))
    return p


def dome(xc, y0, y1, w, R, zc, z0=0.0, rb=0.0, rf=0.0):
    """Half capsule: flat back at z0, front a cylinder of radius R along y, closed by spheres of
    the same radius at both ends. Tangent everywhere, so it reads as one soft surface."""
    root = design().rootComponent
    occ = new_occ(root, 'scratch')
    c = occ.component
    r = w / 2.0
    ya, yb = y0 + r, y1 - r
    half = _half_path(r, R, zc, z0, rb, rf)

    def plane():
        pl = c.constructionPlanes.createInput()
        pl.setByOffset(c.xZConstructionPlane, adsk.core.ValueInput.createByReal(cm(ya)))
        return c.constructionPlanes.add(pl)

    # end caps: revolve the half section about the z axis through the end centre
    sk = c.sketches.add(plane())
    q = lambda x, z: sk.modelToSketchSpace(P(xc + x, ya, z))
    _profile(sk, q, half)
    prof = max(sk.profiles, key=lambda p: p.areaProperties().area)
    ax = None
    for ln in sk.sketchCurves.sketchLines:
        g0, g1 = ln.worldGeometry.startPoint, ln.worldGeometry.endPoint
        if abs(g0.x - cm(xc)) < 1e-6 and abs(g1.x - cm(xc)) < 1e-6:
            ax = ln
    ri = c.features.revolveFeatures.createInput(prof, ax, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    ri.setAngleExtent(False, adsk.core.ValueInput.createByReal(2 * math.pi))
    ball = c.features.revolveFeatures.add(ri).bodies.item(0)
    ball_t = tbm.copy(ball)
    # middle: the full section, extruded between the end centres
    sk2 = c.sketches.add(plane())
    q2 = lambda x, z: sk2.modelToSketchSpace(P(xc + x, ya, z))
    full = list(half)
    mirrored = []
    pts = [half[0][1]]
    for seg in half[1:]:
        pts.append(seg[-1])
    for i in range(len(half) - 1, 0, -1):
        seg = half[i]
        back = pts[i - 1]
        if seg[0] == 'L':
            mirrored.append(('L', (-back[0], back[1])))
        else:
            mirrored.append(('A', (-seg[1][0], seg[1][1]), (-back[0], back[1])))
    # the path ends on the axis, so drop the axis closure by going round
    _profile(sk2, q2, full + mirrored[:-1] if False else full + mirrored)
    prof2 = max(sk2.profiles, key=lambda p: p.areaProperties().area)
    dist = adsk.core.ValueInput.createByReal(cm(yb - ya))
    ext = c.features.extrudeFeatures.addSimple(prof2, dist, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    mid = ext.bodies.item(0)
    if mid.boundingBox.maxPoint.y < cm(ya) + 1e-4:
        ext.deleteMe()
        ext = c.features.extrudeFeatures.addSimple(prof2, adsk.core.ValueInput.createByReal(-cm(yb - ya)),
                                                   adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
        mid = ext.bodies.item(0)
    out = tbm.copy(mid)
    occ.deleteMe()
    lo = inter(copyb(ball_t), tbox(xc - w, y0 - 5, z0 - 1, xc + w, ya, zc + R + 1))
    hi = inter(copyb(ball_t), tbox(xc - w, ya, z0 - 1, xc + w, y1 + 5, zc + R + 1))
    tbm.transform(hi, mtx(ty=yb - ya))
    uni(out, lo, hi)
    return out


def round_pod(xc, yc, r, R, zc, rb, rf):
    """Round in plan, flat back at z = 0, spherical front of radius R about z = zc: one revolved section."""
    occ = new_occ(design().rootComponent, 'scratch')
    c = occ.component
    pl = c.constructionPlanes.createInput()
    pl.setByOffset(c.xZConstructionPlane, adsk.core.ValueInput.createByReal(cm(yc)))
    sk = c.sketches.add(c.constructionPlanes.add(pl))
    q = lambda x, z: sk.modelToSketchSpace(P(xc + x, yc, z))
    _profile(sk, q, _half_path(r, R, zc, 0.0, rb, rf))
    prof = max(sk.profiles, key=lambda p: p.areaProperties().area)
    ax = None
    for ln in sk.sketchCurves.sketchLines:
        g0, g1 = ln.worldGeometry.startPoint, ln.worldGeometry.endPoint
        if abs(g0.x - cm(xc)) < 1e-6 and abs(g1.x - cm(xc)) < 1e-6:
            ax = ln
    ri = c.features.revolveFeatures.createInput(prof, ax, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    ri.setAngleExtent(False, adsk.core.ValueInput.createByReal(2 * math.pi))
    out = tbm.copy(c.features.revolveFeatures.add(ri).bodies.item(0))
    occ.deleteMe()
    return out


def arch(cx, yc, R, y0, rc, D, Rs, rb, rf):
    """A semicircle (R at cx, yc) on a rectangle of the same width down to y0, the lower corners rounded (rc),
    a spherical front (Rs) and rounded front and back edges. Sides stay parallel down to the rail."""
    occ = new_occ(design().rootComponent, 'scratch')
    c = occ.component
    sk = c.sketches.add(c.xYConstructionPlane)
    q = lambda x, y: sk.modelToSketchSpace(P(cx + x, y, 0))
    L, A = sk.sketchCurves.sketchLines, sk.sketchCurves.sketchArcs
    k = rc * (1 - math.sqrt(0.5))
    A.addByThreePoints(q(R, yc), q(0.0, yc + R), q(-R, yc))
    L.addByTwoPoints(q(-R, yc), q(-R, y0 + rc))
    A.addByThreePoints(q(-R, y0 + rc), q(-R + k, y0 + k), q(-R + rc, y0))
    L.addByTwoPoints(q(-R + rc, y0), q(R - rc, y0))
    A.addByThreePoints(q(R - rc, y0), q(R - k, y0 + k), q(R, y0 + rc))
    L.addByTwoPoints(q(R, y0 + rc), q(R, yc))
    prof = max(sk.profiles, key=lambda p_: p_.areaProperties().area)
    ext = c.features.extrudeFeatures.addSimple(prof, adsk.core.ValueInput.createByReal(cm(D + 1.0)),
                                               adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    prism = tbm.copy(ext.bodies.item(0))
    ext.bodies.item(0).deleteMe()
    inter(prism, tbm.createSphere(P(cx, (yc + R + y0) / 2.0, D - Rs), cm(Rs)))
    body = c.bRepBodies.add(prism)
    for rad, want_back in ((rf, False), (rb, True)):
        col = adsk.core.ObjectCollection.create()
        for e in body.edges:
            bb = e.boundingBox
            xyspan = max(bb.maxPoint.x - bb.minPoint.x, bb.maxPoint.y - bb.minPoint.y)
            if xyspan < 1e-4 or (bb.maxPoint.z < 1e-5) != want_back:
                continue
            col.add(e)
        fi = c.features.filletFeatures.createInput()
        fi.edgeSetInputs.addConstantRadiusEdgeSet(col, adsk.core.ValueInput.createByReal(cm(rad)), True)
        c.features.filletFeatures.add(fi)
        body = c.bRepBodies.item(0)
    out = tbm.copy(body)
    occ.deleteMe()
    return out


def gumdrop(cx, cy, R, ax, by, r, D, Rs, rb, rf):
    """One smooth outline around the round part and the rail: the convex hull of the circle (R at cx, cy)
    and two small circles (r at cx +- ax, by), tangent everywhere, with a spherical front (Rs) falling
    towards the rail, and rounded front and back edges. There is no step between round part and rail."""
    occ = new_occ(design().rootComponent, 'scratch')
    c = occ.component
    sk = c.sketches.add(c.xYConstructionPlane)
    q = lambda x, y: sk.modelToSketchSpace(P(cx + x, cy + y, 0))
    L, A = sk.sketchCurves.sketchLines, sk.sketchCurves.sketchArcs
    b = by - cy
    d = math.hypot(ax, b)
    n = math.atan2(b, ax) + math.acos((R - r) / d)     # outward normal of the right tangent line
    nx, ny = math.cos(n), math.sin(n)
    t0 = (R * nx, R * ny)
    t1 = (ax + r * nx, b + r * ny)
    a_low = -math.pi / 2
    amid = (n + a_low) / 2
    mid1 = (ax + r * math.cos(amid), b + r * math.sin(amid))
    bot = (ax, b - r)
    a_top = (n + math.pi / 2) / 2
    A.addByThreePoints(q(t0[0], t0[1]), q(R * math.cos(a_top), R * math.sin(a_top)), q(0.0, R))
    A.addByThreePoints(q(0.0, R), q(-R * math.cos(a_top), R * math.sin(a_top)), q(-t0[0], t0[1]))
    L.addByTwoPoints(q(-t0[0], t0[1]), q(-t1[0], t1[1]))
    A.addByThreePoints(q(-t1[0], t1[1]), q(-mid1[0], mid1[1]), q(-bot[0], bot[1]))
    L.addByTwoPoints(q(-bot[0], bot[1]), q(bot[0], bot[1]))
    A.addByThreePoints(q(bot[0], bot[1]), q(mid1[0], mid1[1]), q(t1[0], t1[1]))
    L.addByTwoPoints(q(t1[0], t1[1]), q(t0[0], t0[1]))
    prof = max(sk.profiles, key=lambda p_: p_.areaProperties().area)
    ext = c.features.extrudeFeatures.addSimple(prof, adsk.core.ValueInput.createByReal(cm(D + 1.0)),
                                               adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    prism = tbm.copy(ext.bodies.item(0))
    ext.bodies.item(0).deleteMe()
    inter(prism, tbm.createSphere(P(cx, cy, D - Rs), cm(Rs)))
    body = c.bRepBodies.add(prism)
    for rad, want_back in ((rf, False), (rb, True)):
        col = adsk.core.ObjectCollection.create()
        for e in body.edges:
            bb = e.boundingBox
            xyspan = max(bb.maxPoint.x - bb.minPoint.x, bb.maxPoint.y - bb.minPoint.y)
            if xyspan < 1e-4 or (bb.maxPoint.z < 1e-5) != want_back:
                continue
            col.add(e)
        fi = c.features.filletFeatures.createInput()
        fi.edgeSetInputs.addConstantRadiusEdgeSet(col, adsk.core.ValueInput.createByReal(cm(rad)), True)
        c.features.filletFeatures.add(fi)
        body = c.bRepBodies.item(0)
    out = tbm.copy(body)
    occ.deleteMe()
    return out


def pebble(x0, x1, y0, y1, rc, D, R, rb, rf):
    """Rounded rectangle with a flat back at z = 0 and a spherical front, crown at z = D over the
    centre. Back and front edges rounded with real fillets. The smallest soft shape around a square servo."""
    root = design().rootComponent
    occ = new_occ(root, 'scratch')
    c = occ.component
    sk = c.sketches.add(c.xYConstructionPlane)
    q = lambda x, y: sk.modelToSketchSpace(P(x, y, 0))
    L, A = sk.sketchCurves.sketchLines, sk.sketchCurves.sketchArcs
    k = rc * (1 - math.sqrt(0.5))
    L.addByTwoPoints(q(x0 + rc, y0), q(x1 - rc, y0))
    A.addByThreePoints(q(x1 - rc, y0), q(x1 - k, y0 + k), q(x1, y0 + rc))
    L.addByTwoPoints(q(x1, y0 + rc), q(x1, y1 - rc))
    A.addByThreePoints(q(x1, y1 - rc), q(x1 - k, y1 - k), q(x1 - rc, y1))
    L.addByTwoPoints(q(x1 - rc, y1), q(x0 + rc, y1))
    A.addByThreePoints(q(x0 + rc, y1), q(x0 + k, y1 - k), q(x0, y1 - rc))
    L.addByTwoPoints(q(x0, y1 - rc), q(x0, y0 + rc))
    A.addByThreePoints(q(x0, y0 + rc), q(x0 + k, y0 + k), q(x0 + rc, y0))
    ext = c.features.extrudeFeatures.addSimple(sk.profiles.item(0), adsk.core.ValueInput.createByReal(cm(D + 1.0)),
                                               adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    prism = tbm.copy(ext.bodies.item(0))
    ext.bodies.item(0).deleteMe()
    xc, yc = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    inter(prism, tbm.createSphere(P(xc, yc, D - R), cm(R)))
    body = c.bRepBodies.add(prism)
    for rad, want_back in ((rf, False), (rb, True)):
        if rad <= 0.02:
            continue
        col = adsk.core.ObjectCollection.create()
        for e in body.edges:
            bb = e.boundingBox
            zspan = bb.maxPoint.z - bb.minPoint.z
            xyspan = max(bb.maxPoint.x - bb.minPoint.x, bb.maxPoint.y - bb.minPoint.y)
            on_back = bb.maxPoint.z < 1e-5
            if xyspan < 1e-4 or on_back != want_back:
                continue                     # the vertical seams of the side wall, or the other edge loop
            col.add(e)
        fi = c.features.filletFeatures.createInput()
        fi.edgeSetInputs.addConstantRadiusEdgeSet(col, adsk.core.ValueInput.createByReal(cm(rad)), True)
        c.features.filletFeatures.add(fi)
        body = c.bRepBodies.item(0)
    out = tbm.copy(body)
    occ.deleteMe()
    return out


def prism_x(pts, x0, x1):
    """Extrude a (y, z) outline along x. Returns a temporary body."""
    root = design().rootComponent
    occ = new_occ(root, 'scratch')
    c = occ.component
    pl = c.constructionPlanes.createInput()
    pl.setByOffset(c.yZConstructionPlane, adsk.core.ValueInput.createByReal(cm(x0)))
    sk = c.sketches.add(c.constructionPlanes.add(pl))
    sk.isComputeDeferred = True
    L = sk.sketchCurves.sketchLines
    sp = [sk.modelToSketchSpace(P(x0, y, z)) for y, z in pts]
    for a, b in zip(sp, sp[1:] + sp[:1]):
        L.addByTwoPoints(a, b)
    sk.isComputeDeferred = False
    prof = max(sk.profiles, key=lambda p: p.areaProperties().area)
    ext = c.features.extrudeFeatures.addSimple(prof, adsk.core.ValueInput.createByReal(cm(x1 - x0)),
                                               adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    out = tbm.copy(ext.bodies.item(0))
    occ.deleteMe()
    return out


def involute_pinion(m, n, pa_deg, backlash, cy, cz, steps=7, add_m=0.85):
    pa = math.radians(pa_deg)
    rp = m * n / 2.0
    rb = rp * math.cos(pa)
    ra = rp + add_m * m
    rf = rp - 1.25 * m
    inv = lambda a: math.tan(a) - a
    half = (math.pi * m / 2.0 - backlash) / (2.0 * rp) + inv(pa)
    pts = []
    for k in range(n):
        th0 = 2 * math.pi * k / n
        r0 = max(rb, rf)
        flank = []
        for i in range(steps + 1):
            r = r0 + (ra - r0) * i / steps
            flank.append((r, half - inv(math.acos(min(1.0, rb / r)))))
        if rf < rb:
            pts.append((rf, th0 - half))
        pts += [(r, th0 - a) for r, a in flank]
        pts += [(r, th0 + a) for r, a in reversed(flank)]
        if rf < rb:
            pts.append((rf, th0 + half))
    return [(cy + r * math.cos(t), cz + r * math.sin(t)) for r, t in pts]


def rack_outline(m, pa_deg, backlash, y_pitch, y_bottom, z0, z1, zt0, zt1, phase):
    t = math.tan(math.radians(pa_deg))
    p = math.pi * m
    ha, hf = m, 1.25 * m
    top, root = y_pitch + ha, y_pitch - hf
    w = p / 2.0 - backlash
    lo, hi = w / 2 + hf * t, w / 2 - ha * t
    k = math.ceil((zt0 + 0.2 - phase + lo) / p)
    teeth = []
    while phase + k * p + lo <= zt1:
        teeth.append(phase + k * p)
        k += 1
    pts = [(y_bottom, z0), (y_bottom, z1), (root, z1)]
    for c in reversed(teeth):
        pts += [(root, c + lo), (top, c + hi), (top, c - hi), (root, c - lo)]
    pts += [(root, zt0), (top, zt0), (top, z0)]
    return pts


# ---------------------------------------------------------------- pusher (numbers from kotori v3.1)
CLR, BACK_T = 0.25, 1.6
SV_L, SV_W, SV_H, SV_SH = 20.0, 8.3, 17.3, 5.0
GM, GN, GT, GGAP, HUB_D, HUB_DEP, RK_B, STROKE = 0.75, 12, 3.0, 2.0, 5.0, 2.0, 3.0, 4.0
RP = GM * GN / 2
RO = RP + 0.85 * GM
YS = RP + (0.25 * GM + RK_B) / 2
HR = 1.125 * GM + RK_B / 2
ZS = max(BACK_T + 0.3 + RO, BACK_T + CLR + 1 + SV_W / 2)
X_CT = -(GT / 2 + GGAP)
X_CB = X_CT - SV_H
Y_ST = YS + SV_SH
Y_SB = Y_ST - SV_L
Z_SB, Z_SF = ZS - SV_W / 2, ZS + SV_W / 2
RAIL = 6.0
RAIL_R = 0.5                               # corner radius of the rail; the tunnels follow it
Y_T1 = Y_SB - CLR - 0.8
Y_T0 = Y_T1 - RAIL - 2 * CLR
Y_RC = (Y_T0 + Y_T1) / 2
Z_T0, Z_T1 = BACK_T, BACK_T + RAIL + 0.2   # 0.2 mm in front of the rail keeps the tilt under a key load small
Z_RK = ZS + STROKE + 1.5
Z_CAP = Z_SF + 0.06                       # the cap's flat seam rests on the servo; rack and pinion run up into it
Z_RK_TOP = Z_RK + 0.4
KPAD_L, KPAD_H, KPAD_T = 8.0, 5.0, 3.0
Z_KPAD = BACK_T + RAIL + 0.6 * KPAD_T

# capsule outer shape
# a semicircle on a rectangle: same width and top radius as the main capsule, sides parallel down past the rail
PXC, PR, PD = -9.65, 15.0, 15.8
P_ARCH = (3.2, Y_T0 - 2.4, 4.0)            # semicircle centre y, bottom y, lower corner radius
PYC = P_ARCH[0]
PW = 2 * PR
PX0, PX1, PY0, PY1 = PXC - PR, PXC + PR, P_ARCH[1], P_ARCH[0] + PR
P_R, P_ZC = 40.0, PD - 40.0                # front sphere
P_RB, P_RF = 4.0, 3.5
P_GUM = None                               # (end circle offset from the centre line, its y, its radius)
P_COLLAR = None                            # (half length, wall above and below the tunnel, depth, edge radius)
# one M2 x 10 from the back (hidden on the intercom side), threads straight into the cap
SCR_X, SCR_Y = -0.4, Y_T1 + 3.7
SCR_HEAD_R, SCR_HEAD_Z, SCR_CLR_R, SCR_PILOT_R, SCR_PILOT_Z = 2.1, 3.4, 1.2, 0.8, 13.6
PEG_X, PEG_Y, PEG_R = PXC, -11.3, 1.5      # locates the cap on the base, in front of the rail tunnel


def pusher_parts():
    if P_ARCH:
        sh = arch(PXC, P_ARCH[0], PR, P_ARCH[1], P_ARCH[2], PD, P_R, P_RB, P_RF)
    elif P_GUM:
        sh = gumdrop(PXC, PYC, PR, *P_GUM, PD, P_R, P_RB, P_RF)
    else:
        sh = round_pod(PXC, PYC, PR, P_R, P_ZC, P_RB, P_RF)
    body = copyb(sh)
    if P_COLLAR:                               # a thicker bar around the rail; the round part only has to clear the servo
        uni(body, rail_bar(PXC - P_COLLAR[0], PXC + P_COLLAR[0], Y_T0 - P_COLLAR[1], 0.0, Y_T1 + P_COLLAR[1], P_COLLAR[2], P_COLLAR[3]))
    base = inter(body, tbox(-60, -60, -1, 60, 60, Z_CAP))
    ypc = (Y_T0 + Y_T1) / 2
    for b in (
        tbox(X_CB - CLR, Y_SB - CLR, Z_SB - CLR, X_CT + CLR, Y_ST + CLR, 30),          # servo pocket
        tbox(X_CT, YS - HUB_D / 2 - 0.6, ZS - HUB_D / 2 - 0.6, -(GT / 2 + 0.3), YS + HUB_D / 2 + 0.6, 30),
        tcyl((-(GT / 2 + 0.3), YS, ZS), (GT / 2 + CLR, YS, ZS), RO + 0.3),
        tbox(-(GT / 2 + CLR), -HR - CLR, -1, GT / 2 + CLR, HR + CLR, 30),                 # rack guide
        rbar_x(-60, 60, Y_T0, Z_T0, Y_T1, Z_T1, RAIL_R + CLR if RAIL_R else 0.0),         # rail tunnel
        tbox(PXC - KPAD_L / 2, ypc - KPAD_H / 2, Z_T0 + RAIL, PXC + KPAD_L / 2, ypc + KPAD_H / 2, Z_KPAD),  # pad pocket
        tbox(X_CB + 0.5, Y_SB - CLR - 0.6, Z_SB - CLR, X_CB + 3.25, Y_SB, 30),            # lead relief
        tbox(X_CB + 2.0, Y_ST, Z_SB - CLR, X_CB + 4.75, Y_ST + CLR + 0.6, 30),
        tbox(X_CB - CLR, Y_SB - CLR, -1, X_CB + 3.25, Y_SB + 3.0, Z_SB),                  # lead out the back
        tcyl((SCR_X, SCR_Y, -1), (SCR_X, SCR_Y, SCR_HEAD_Z), SCR_HEAD_R),                 # M2 head
        tcyl((SCR_X, SCR_Y, -1), (SCR_X, SCR_Y, 30), SCR_CLR_R),
    ):
        sub(base, b)
    uni(base, tcyl((PEG_X, PEG_Y, Z_CAP - 0.05), (PEG_X, PEG_Y, Z_CAP + 0.9), PEG_R))        # locating peg
    cap = inter(copyb(sh), tbox(-60, -60, Z_CAP, 60, 60, 40))
    for b in (
        tcyl((PEG_X, PEG_Y, Z_CAP - 1), (PEG_X, PEG_Y, Z_CAP + 1.1), PEG_R + 0.15),           # peg socket
        tbox(-(GT / 2 + CLR), -HR - CLR, Z_CAP - 1, GT / 2 + CLR, HR + CLR, Z_RK_TOP),        # rack
        tcyl((-(GT / 2 + 0.3), YS, ZS), (GT / 2 + CLR, YS, ZS), RO + 0.3),                    # pinion, round so the dome clears it
        tcyl((SCR_X, SCR_Y, Z_CAP - 1), (SCR_X, SCR_Y, SCR_PILOT_Z), SCR_PILOT_R),
    ):
        sub(cap, b)
    rk = prism_x(rack_outline(GM, 25.0, 0.08, YS - RP, -HR, 0.3, Z_RK, BACK_T, Z_RK, ZS + math.pi * GM / 2), -GT / 2, GT / 2)
    pn = prism_x(involute_pinion(GM, GN, 25.0, 0.08, YS, ZS), -GT / 2, GT / 2)
    sub(pn, tcyl((-GT / 2 - 1, YS, ZS), (-GT / 2 + HUB_DEP, YS, ZS), HUB_D / 2 + 0.05))  # glued on the servo's horn hub
    return {'base': base, 'cap': cap}, {'rack': rk, 'pinion': pn}


def pusher_refs():
    ypc = (Y_T0 + Y_T1) / 2
    r = {}
    r['FS0307 20 x 8.3 x 17.3'] = uni(tbox(X_CB, Y_SB, Z_SB, X_CT, Y_ST, Z_SF),
                                      tcyl((X_CT, YS, ZS), (-GT / 2 + HUB_DEP, YS, ZS), HUB_D / 2))
    r['rail 6 x 6'] = rbar_x(-60, 60, ypc - RAIL / 2, Z_T0, ypc + RAIL / 2, Z_T0 + RAIL, RAIL_R)
    r['PU pad compressed'] = tbox(PXC - KPAD_L / 2 + 0.1, ypc - KPAD_H / 2 + 0.1, Z_T0 + RAIL, PXC + KPAD_L / 2 - 0.1, ypc + KPAD_H / 2 - 0.1, Z_KPAD)
    r['M2 x 10 screw'] = uni(tcyl((SCR_X, SCR_Y, SCR_HEAD_Z - 1.6), (SCR_X, SCR_Y, SCR_HEAD_Z), 1.9),
                             tcyl((SCR_X, SCR_Y, SCR_HEAD_Z), (SCR_X, SCR_Y, SCR_HEAD_Z + 10.0), 1.0))
    return r


# ---------------------------------------------------------------- main capsule (XIAO stack, oyadori v3.3 numbers)
MW, MH, MD = 30.0, 57.0, 19.8
M_R, M_ZC = 19.0, 19.8 - 19.0
M_RB, M_RF, M_T = 5.0, 6.0, 1.5
S_W, S_H, S_R = 17.78, 21.135, 1.905
S_Y0, S_ZO = 5.8, 5.3
ADD_T, SPACER = 1.0, 0.1
X_PCB, X_SHIELD, X_USB = 1.25, 3.25, 4.46
ADD_PARTS, USB_T, USB_W, USB_D = 1.25, 3.2, 8.94, 7.35
XUSB_W, XUSB_D, XUSB_OVER = 8.94, 7.35, 1.5
ZSPLIT = 10.96                                # the flat seam rests on the XIAO USB-C through the front's arms
BAY_TOP = 31.0
SPK_Y, SPK_R, SPK_T_MAX = 42.0, 10.0, 4.0     # listing says 3.6 and 4; both are checked
SPK_Z1 = 15.1                                 # speaker face, under the dome at r = 10
SPK_RING_ID, SPK_RING_OD = 20.3, 22.0
FPC_L, FPC_W, FPC_T = 37.4, 17.5, 0.2
FPC_Y0 = 13.0
RAIL_Y = SPK_Y
M_SCR = ((-10.0, 33.5), (10.0, 33.5))
ZO = S_ZO
ZX0 = ZO + ADD_T + SPACER
ZX1 = ZX0 + X_USB
Y1 = S_Y0 + S_H
YC = S_Y0 + S_H / 2


def outline(z0, z1, grow=0.0):
    return rbox(-S_W / 2 - grow, S_Y0 - grow, z0, S_W / 2 + grow, Y1 + grow, z1, S_R + max(grow, 0.0))


def fpc_sheet(grow=0.0):
    """The A-02 sheet glued along the inside of the dome (it bends about y only), its ends running
    down the side walls. Section polygon extruded along y."""
    ro = M_R - M_T - 0.05 + grow
    ri = ro - FPC_T - 2 * grow
    x_side = 11.6 + grow                       # the sheet leaves the dome before the inner edge radius starts
    th = math.asin(min(x_side, ro * 0.999) / ro)
    arc = (M_R - M_T - 0.05) * th
    leg = FPC_L / 2.0 - arc
    n = 16
    outer = [(ro * math.sin(th * i / n), M_ZC + ro * math.cos(th * i / n)) for i in range(-n, n + 1)]
    inner = [(ri * math.sin(th * i / n), M_ZC + ri * math.cos(th * i / n)) for i in range(n, -n - 1, -1)]
    z_end = M_ZC + ro * math.cos(th) - leg - grow
    t = FPC_T + 2 * grow
    xo, zo = outer[-1]
    pts = [(-xo, z_end), (-xo, zo)] + outer[1:-1] + [(xo, zo), (xo, z_end), (xo - t, z_end)]
    pts += [inner[0]] + inner[1:-1] + [inner[-1], (-xo + t, z_end)]
    # prism_x gives (X = along, Y = section u, Z = z); turn it so the section lies in x, z
    b = prism_x([(u, z) for u, z in pts], FPC_Y0 - grow, FPC_Y0 + FPC_W + grow)
    m = adsk.core.Matrix3D.create()
    m.setToRotation(math.pi / 2, V(0, 0, 1), P(0, 0, 0))
    tbm.transform(b, m)
    return b, dict(leg=leg, z_leg_end=z_end, arc_half=arc)


def main_parts():
    sh = dome(0.0, 0.0, MH, MW, M_R, M_ZC, 0.0, M_RB, M_RF)
    inside = dome(0.0, M_T, MH - M_T, MW - 2 * M_T, M_R - M_T, M_ZC, M_T, M_RB - M_T, M_RF - M_T)
    # ---- back shell: bay for the stack, solid block with the rail tunnel behind the speaker
    back = inter(copyb(sh), tbox(-60, -60, -1, 60, 80, ZSPLIT))
    sub(back, inter(copyb(inside), tbox(-60, -60, -1, 60, BAY_TOP, ZSPLIT + 1)))
    feats = []
    w = S_W / 2
    zt = ZX0 + X_PCB
    hole = outline(ZO - 1, zt + 1)
    for sx in (-1, 1):
        for gy in (S_Y0 + 2.4, Y1 - 3.2):
            feats.append(tbox(sx * (w + 0.15), gy - 0.45, 1.0, sx * 10.9, gy + 0.45, zt))      # side guides on the back wall
        feats.append(sub(tbox(sx * 6.6, 0.0, ZO, sx * 9.6, S_Y0 + 1.35, zt), copyb(hole)))     # bottom corner cradles
        feats.append(sub(tbox(sx * 5.8, Y1 - 1.35, ZO, sx * 9.6, BAY_TOP + 0.1, zt), copyb(hole)))  # top corner cradles
        feats.append(tcyl((sx * 7.7, YC + 9.6, 1.0), (sx * 7.7, YC + 9.6, ZO), 0.75))           # back posts (free corners)
    feats.append(tbox(-3.5, S_Y0 + 1.0, 1.0, 3.5, S_Y0 + USB_D - 1.0, ZO - USB_T))              # pad under the USB-C
    mic = (-4.4, YC + 0.87)
    feats.append(tcyl((mic[0], mic[1], 1.0), (mic[0], mic[1], ZO - ADD_PARTS - 0.1), 1.8))      # mic tube
    for f in feats:
        uni(back, inter(f, copyb(inside)))
    sub(back, tcyl((mic[0], mic[1], -1), (mic[0], mic[1], ZO), 0.8))
    sub(back, tbox(-6.5, -1, -1, 6.5, S_Y0, 7.25), tbox(-6.5, S_Y0 - 0.1, -1, 6.5, S_Y0 + 0.5, 2.0))  # USB-C plug opening
    sub(back, tbox(-6.0, 26.9, -1, 6.0, 28.7, 2.5))                                             # servo leads out the back
    ty0, ty1 = RAIL_Y - RAIL / 2 - CLR, RAIL_Y + RAIL / 2 + CLR
    sub(back, rbar_x(-60, 60, ty0, Z_T0, ty1, Z_T1, RAIL_R + CLR if RAIL_R else 0.0))
    sub(back, tbox(-KPAD_L / 2, RAIL_Y - KPAD_H / 2, Z_T0 + RAIL, KPAD_L / 2, RAIL_Y + KPAD_H / 2, Z_KPAD))
    sub(back, tcyl((0, SPK_Y, 9.7), (0, SPK_Y, ZSPLIT + 1), 9.0))                               # speaker back volume
    for (sx, sy) in M_SCR:
        sub(back, tcyl((sx, sy, -1), (sx, sy, SCR_HEAD_Z), SCR_HEAD_R), tcyl((sx, sy, -1), (sx, sy, 20), SCR_CLR_R))
    press = sub(tcyl((0, SPK_Y, ZSPLIT - 0.2), (0, SPK_Y, SPK_Z1 - SPK_T_MAX), SPK_RING_ID / 2 - 0.25), tcyl((0, SPK_Y, ZSPLIT - 1), (0, SPK_Y, SPK_Z1), 9.0))
    sub(press, tbox(-1.5, SPK_Y - 12, ZSPLIT - 1, 1.5, SPK_Y, SPK_Z1))                          # speaker wires
    uni(back, press)
    # ---- front shell: dome, speaker ring + grille, posts, stack pressers, lip
    front = inter(copyb(sh), tbox(-60, -60, ZSPLIT, 60, 80, 40))
    sub(front, inter(copyb(inside), tbox(-60, -60, ZSPLIT - 1, 60, 80, 40)))
    ring = sub(tcyl((0, SPK_Y, ZSPLIT), (0, SPK_Y, MD - M_T + 0.2), SPK_RING_OD / 2), tcyl((0, SPK_Y, ZSPLIT - 1), (0, SPK_Y, MD), SPK_RING_ID / 2))
    sub(ring, tbox(-1.5, SPK_Y - 12, ZSPLIT - 1, 1.5, SPK_Y, ZSPLIT + 1.2))
    uni(front, inter(ring, copyb(inside)))
    for (sx, sy) in M_SCR:
        uni(front, inter(tcyl((sx, sy, ZSPLIT), (sx, sy, MD), 2.5), copyb(sh)))
        sub(front, tcyl((sx, sy, ZSPLIT - 1), (sx, sy, 15.4), SCR_PILOT_R))
    for sx in (-1, 1):                                                                          # two arms from the ring onto the XIAO USB-C
        uni(front, tbox(sx * 2.0, 23.0, ZSPLIT, sx * 6.0, 33.8, ZSPLIT + 1.0))
    sub(front, tcyl((0, SPK_Y, ZSPLIT - 1), (0, SPK_Y, ZSPLIT + 1.01), SPK_RING_ID / 2))
    # the back shell carries the lip (below the FPC) and a hook over the XIAO's lower edge, so the
    # front shell's seam stays flat and it prints dome up without supports
    lip_o = pill(0.0, M_T + 0.4, MH - M_T - 0.4, MW - 2 * M_T - 0.8, ZSPLIT - 0.5, ZSPLIT + 0.6, 0.0, 0.0)
    lip_i = pill(0.0, M_T + 1.2, MH - M_T - 1.2, MW - 2 * M_T - 2.4, ZSPLIT - 1.0, ZSPLIT + 1.0, 0.0, 0.0)
    lip = sub(lip_o, copyb(lip_i))
    inter(lip, tbox(-60, -60, ZSPLIT - 0.5, 60, FPC_Y0 - 0.3, ZSPLIT + 0.6))
    uni(lip, sub(inter(copyb(sh), tbox(-60, -60, ZSPLIT - 0.5, 60, FPC_Y0 - 0.3, ZSPLIT)), lip_i))   # ties the lip to the wall
    sub(lip, tbox(-6.6, -1, 0, 6.6, S_Y0, 12))
    uni(back, lip)
    uni(back, inter(tbox(-2.0, 0.5, ZX0 + X_SHIELD + 0.1, 6.5, S_Y0 + 1.2, ZSPLIT - 0.06), copyb(sh)))
    # the sheet is straight along y, the dome falls away at the lower end: a shallow pocket keeps it flat
    sub(front, fpc_sheet(0.05)[0])
    # grille in the front wall
    for row in range(-2, 3):
        n = 5 - abs(row)
        for i in range(n):
            x = (i - (n - 1) / 2.0) * 3.0
            y = SPK_Y + row * 2.6
            sub(front, tcyl((x, y, SPK_Z1 + 0.15), (x, y, MD + 1), 0.7))
    return {'back': back, 'front': front}


def main_refs():
    r = {}
    pcb = outline(ZO, ZO + ADD_T)
    r['add-on board 1.0'] = pcb
    r['add-on USB-C'] = tbox(-USB_W / 2, S_Y0, ZO - USB_T, USB_W / 2, S_Y0 + USB_D, ZO)
    parts = outline(ZO - ADD_PARTS, ZO, -0.3)
    sub(parts, tbox(-USB_W / 2 - 0.3, S_Y0 - 1, ZO - 5, USB_W / 2 + 0.3, S_Y0 + USB_D + 0.3, ZO + 1))
    for s in (-1, 1):
        sub(parts, tbox(s * 6.4, YC + 8.0, ZO - 5, s * 12, Y1 + 1, ZO + 1))
    r['add-on parts zone 1.25'] = parts
    r['solder bumps'] = None
    b = None
    for s in (-1, 1):
        for i in range(7):
            c = tcyl((s * 7.62, YC + 7.65 - 2.54 * i, ZO - 0.5), (s * 7.62, YC + 7.65 - 2.54 * i, ZO), 0.85)
            b = c if b is None else uni(b, c)
    r['solder bumps'] = b
    r['wires on pads 3 mm'] = tbox(-6.75, YC + 8.7, ZO - 3.0, 6.75, Y1, ZO)
    r['XIAO PCB'] = outline(ZX0, ZX0 + X_PCB)
    r['XIAO shield'] = outline(ZX0 + X_PCB, ZX0 + X_SHIELD, -0.2)
    r['XIAO USB-C'] = tbox(-XUSB_W / 2, Y1 + XUSB_OVER - XUSB_D, ZX0 + X_PCB, XUSB_W / 2, Y1 + XUSB_OVER, ZX1)
    r['XIAO U.FL'] = tbox(-4.85 - 1.5, YC - 8.84 - 1.5, ZX0 + X_PCB, -4.85 + 1.5, YC - 8.84 + 1.5, ZX0 + X_PCB + 1.25)
    r['speaker 20 x 4'] = tcyl((0, SPK_Y, SPK_Z1 - SPK_T_MAX), (0, SPK_Y, SPK_Z1), SPK_R)
    r['FPC antenna A-02'] = fpc_sheet()[0]
    r['rail 6 x 6'] = rbar_x(-60, 60, RAIL_Y - RAIL / 2, Z_T0, RAIL_Y + RAIL / 2, Z_T0 + RAIL, RAIL_R)
    r['PU pad compressed'] = tbox(-KPAD_L / 2 + 0.1, RAIL_Y - KPAD_H / 2 + 0.1, Z_T0 + RAIL, KPAD_L / 2 - 0.1, RAIL_Y + KPAD_H / 2 - 0.1, Z_KPAD)
    plug = tbox(-6.2, -20.0, 0.45, 6.2, S_Y0, 6.95)
    r['USB-C plug 12.4 x 6.5'] = plug
    for k, (sx, sy) in enumerate(M_SCR):
        r['M2 x 10 screw %d' % k] = uni(tcyl((sx, sy, SCR_HEAD_Z - 1.6), (sx, sy, SCR_HEAD_Z), 1.9), tcyl((sx, sy, SCR_HEAD_Z), (sx, sy, SCR_HEAD_Z + 10.0), 1.0))
    return r


# ---------------------------------------------------------------- checks
def vol(b):
    """mm3 of a temporary body (cm3 x 1000)."""
    return b.volume * 1000.0 if b is not None else 0.0


def overlap(a, b):
    ba, bb = a.boundingBox, b.boundingBox
    if not ba.intersects(bb):
        return 0.0
    c = copyb(a)
    if not tbm.booleanOperation(c, copyb(b), INTER) or c.faces.count == 0:
        return 0.0
    return vol(c)


def grown_box(b, g):
    bb = b.boundingBox
    return tbox(bb.minPoint.x * 10 - g, bb.minPoint.y * 10 - g, bb.minPoint.z * 10 - g, bb.maxPoint.x * 10 + g, bb.maxPoint.y * 10 + g, bb.maxPoint.z * 10 + g)


def bbox_mm(b):
    bb = b.boundingBox
    return tuple(round(v * 10, 2) for v in (bb.minPoint.x, bb.minPoint.y, bb.minPoint.z, bb.maxPoint.x, bb.maxPoint.y, bb.maxPoint.z))


def check_pusher():
    parts, mech = pusher_parts()
    refs = pusher_refs()
    res = []
    printed = {'base': parts['base'], 'cap': parts['cap']}
    # rack at rest, half stroke and full stroke; pinion swept as its tip cylinder
    rack_states = {}
    for dz in (0.0, -STROKE / 2, -STROKE):
        rack_states[dz] = moved(mech['rack'], mtx(tz=dz))
    pin_env = tcyl((-GT / 2, YS, ZS), (GT / 2, YS, ZS), RO)
    for pn, pb in printed.items():
        for rn, rb in refs.items():
            res.append((pn + ' / ' + rn, overlap(pb, rb)))
        for dz, rb in rack_states.items():
            res.append(('%s / rack dz %g' % (pn, dz), overlap(pb, rb)))
        res.append((pn + ' / pinion sweep', overlap(pb, pin_env)))
    res.append(('base / cap', overlap(parts['base'], parts['cap'])))
    res.append(('FS0307 / rail', overlap(refs['FS0307 20 x 8.3 x 17.3'], refs['rail 6 x 6'])))
    res.append(('FS0307 / rack', overlap(refs['FS0307 20 x 8.3 x 17.3'], mech['rack'])))
    res.append(('FS0307 / pinion sweep', overlap(tbox(X_CB, Y_SB, Z_SB, X_CT, Y_ST, Z_SF), pin_env)))
    res.append(('rack / rail', overlap(mech['rack'], refs['rail 6 x 6'])))
    res.append(('rack full / rail', overlap(rack_states[-STROKE], refs['rail 6 x 6'])))
    res.append(('rack / screw', overlap(mech['rack'], refs['M2 x 10 screw'])))
    return parts, mech, refs, res


def check_main():
    parts = main_parts()
    refs = main_refs()
    res = []
    for pn, pb in parts.items():
        for rn, rb in refs.items():
            res.append((pn + ' / ' + rn, overlap(pb, rb)))
    res.append(('back / front', overlap(parts['back'], parts['front'])))
    names = list(refs)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            res.append((a + ' / ' + b, overlap(refs[a], refs[b])))
    return parts, refs, res


def lumps(parts):
    return dict((k, v.lumps.count) for k, v in parts.items())


def report(title, res, allow=()):
    print('== ' + title)
    bad = 0
    for n, v in res:
        if v > 0.0005:
            mark = 'allowed' if any(a in n for a in allow) else 'HIT'
            if mark == 'HIT':
                bad += 1
            print('  %-58s %9.3f mm3 %s' % (n, v, mark))
    print('  pairs checked: %d, unexpected hits: %d' % (len(res), bad))
    return bad


# ---------------------------------------------------------------- final document
COLOURS = {'shell': (244, 240, 230), 'mech': (250, 250, 250), 'servo': (70, 80, 95), 'rail': (214, 208, 190),
           'pcb': (30, 90, 60), 'metal': (175, 178, 182), 'pad': (120, 170, 190), 'fpc': (205, 150, 60)}


def appearance(name, rgb):
    des = design()
    ap = des.appearances.itemByName(name)
    if ap:
        return ap
    lib = app.materialLibraries.itemByName('Fusion Appearance Library')
    base = lib.appearances.itemByName('Plastic - Matte (White)') or lib.appearances.itemByName('Paint - Enamel Glossy (White)')
    ap = des.appearances.addByCopy(base, name)
    for p in ap.appearanceProperties:
        if p.objectType == adsk.core.ColorProperty.classType() and p.id in ('opaque_albedo', 'transparent_color', 'metal_f0', 'layered_diffuse', 'layered_bottom_f0'):
            p.value = adsk.core.Color.create(rgb[0], rgb[1], rgb[2], 255)
    return ap


def put(parent, name, body, ap):
    o = new_occ(parent, name)
    add(o.component, body, name, ap)
    return o


def stack_ref_appearance(n):
    if 'PCB' in n or 'board' in n:
        return 'pcb'
    if 'FPC' in n:
        return 'fpc'
    if 'pad' in n:
        return 'pad'
    if 'rail' in n:
        return 'rail'
    return 'metal'


def build_doc(pa, me, rp, pm, rm, x_main=70.0, x_push=(0.0, 38.0), y_rail=0.0, refs_on=True):
    """Assembled scene on one rail: two pushers (second turned 180 degrees for a lower key row)
    and the main capsule. Printed bodies stay at the frame the checks ran in."""
    root = design().rootComponent
    aps = dict((k, appearance('capsule ' + k, v)) for k, v in COLOURS.items())
    out = {}
    m_main = mtx(tx=x_main, ty=y_rail - RAIL_Y)
    o = new_occ(root, 'MAIN capsule')
    put(o.component, 'main_back', moved(pm['back'], m_main), aps['shell'])
    put(o.component, 'main_front', moved(pm['front'], m_main), aps['shell'])
    for n, b in rm.items():
        if refs_on and b is not None and 'rail' not in n:
            put(o.component, 'ref ' + n, moved(b, m_main), aps[stack_ref_appearance(n)])
    out['main'] = o
    for k, (xp, flip) in enumerate(((x_push[0], False), (x_push[1], True))):
        m = mtx(tx=xp, ty=(y_rail + Y_RC) if flip else (y_rail - Y_RC), rz180=flip)
        o = new_occ(root, 'PUSHER capsule %d' % (k + 1))
        put(o.component, 'pusher_base', moved(pa['base'], m), aps['shell'])
        put(o.component, 'pusher_cap', moved(pa['cap'], m), aps['shell'])
        put(o.component, 'rack', moved(me['rack'], m), aps['mech'])
        put(o.component, 'pinion', moved(me['pinion'], m), aps['mech'])
        for n, b in rp.items():
            if refs_on and 'rail' not in n:
                put(o.component, 'ref ' + n, moved(b, m), aps['servo' if 'FS0307' in n else ('pad' if 'pad' in n else 'metal')])
        out['pusher%d' % k] = o
    r = new_occ(root, 'rail 6 x 6 x 1 (ref)')
    put(r.component, 'rail', rail_bar(-27.0, x_main + 21.0, y_rail - RAIL / 2, Z_T0, y_rail + RAIL / 2, Z_T0 + RAIL, RAIL_R), aps['rail'])
    out['rail'] = r
    return out


def export_stl(bodies, outdir):
    os.makedirs(outdir, exist_ok=True)
    root = design().rootComponent
    em = design().exportManager
    done = []
    tmp = new_occ(root, 'export')
    for name, b in bodies.items():
        body = tmp.component.bRepBodies.add(copyb(b))
        path = os.path.join(outdir, name + '.stl')
        opt = em.createSTLExportOptions(body, path)
        opt.meshRefinement = adsk.fusion.MeshRefinementSettings.MeshRefinementHigh
        em.execute(opt)
        done.append(name + '.stl')
    tmp.deleteMe()
    return done


def shoot(path, eye, target, up=(0, 1, 0), w=1600, h=1000, pad=1.1):
    vp = app.activeViewport
    vp.visualStyle = adsk.core.VisualStyles.ShadedVisualStyle
    cam = vp.camera
    cam.isSmoothTransition = False
    cam.cameraType = adsk.core.CameraTypes.PerspectiveCameraType
    cam.eye = P(*eye)
    cam.target = P(*target)
    cam.upVector = V(*up)
    cam.isFitView = True
    vp.camera = cam
    adsk.doEvents()
    cam = vp.camera
    cam.isSmoothTransition = False
    e, t = cam.eye, cam.target
    cam.eye = adsk.core.Point3D.create(t.x + (e.x - t.x) * pad, t.y + (e.y - t.y) * pad, t.z + (e.z - t.z) * pad)
    vp.camera = cam
    vp.refresh()
    o = adsk.core.SaveImageFileOptions.create(path)
    o.width, o.height, o.isAntiAliased, o.isBackgroundTransparent = w, h, True, False
    return vp.saveAsImageFileWithOptions(o)


def section_scene(bodies, plane):
    """Half-cut copies for a section picture: plane = ('x', value), keeps the +x side, etc."""
    root = design().rootComponent
    occ = new_occ(root, 'section')
    axis, v = plane
    for n, (b, ap) in bodies.items():
        bb = b.boundingBox
        k = {'x': 0, 'z': 2}[axis]
        lo = [bb.minPoint.x * 10 - 1, bb.minPoint.y * 10 - 1, bb.minPoint.z * 10 - 1]
        hi = [bb.maxPoint.x * 10 + 1, bb.maxPoint.y * 10 + 1, bb.maxPoint.z * 10 + 1]
        lo[k] = v
        if hi[k] <= lo[k]:
            continue
        c = copyb(b)
        if tbm.booleanOperation(c, tbox(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]), INTER) and c.faces.count:
            add(occ.component, c, n, ap)
    return occ


def hide_all(except_=()):
    root = design().rootComponent
    for i in range(root.occurrences.count):
        o = root.occurrences.item(i)
        o.isLightBulbOn = o.component.name in except_
