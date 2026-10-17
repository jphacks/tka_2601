import adsk.core, adsk.fusion, traceback, os

OUT = '/Users/oobashion/Documents/ChatGPT/speech-model/vsmge20_print_ready'

def mm(v):
    return v * 0.1  # Fusion internal length is cm.

def component_named(design, target):
    for c in design.allComponents:
        if c.name == target:
            return c
    return None

def create_offset_plane(comp, z_mm):
    planes = comp.constructionPlanes
    inp = planes.createInput()
    inp.setByOffset(comp.xYConstructionPlane, adsk.core.ValueInput.createByReal(mm(z_mm)))
    return planes.add(inp)

def rect(sketch, x1, y1, x2, y2):
    p1 = adsk.core.Point3D.create(mm(x1), mm(y1), 0)
    p2 = adsk.core.Point3D.create(mm(x2), mm(y2), 0)
    sketch.sketchCurves.sketchLines.addTwoPointRectangle(p1, p2)

def circle(sketch, x, y, r):
    p = adsk.core.Point3D.create(mm(x), mm(y), 0)
    sketch.sketchCurves.sketchCircles.addByCenterRadius(p, mm(r))

def cut_profiles(comp, body, label):
    # Starts 3 mm above the guard and cuts 14 mm through it.
    plane = create_offset_plane(comp, 3.0)
    sk = comp.sketches.add(plane)
    sk.name = 'Manual access openings: monitor, 4-way, playback, menu'
    # Button centers follow the photographed VS-MGE20 control layout. 2 mm
    # clearance is added around the actual keys; the D-pad gets a broad window.
    circle(sk, 25, -20, 7.0)                 # monitor
    rect(sk, -10, -30, 10, -10)             # 4-way key, 20 x 20
    circle(sk, -25, -42, 7.0)               # playback
    circle(sk, 0, -42, 7.0)                 # menu
    profiles = adsk.core.ObjectCollection.create()
    for p in sk.profiles:
        profiles.add(p)
    if profiles.count == 0:
        raise RuntimeError('No cut profiles created for ' + label)
    ext = comp.features.extrudeFeatures
    ei = ext.createInput(profiles, adsk.fusion.FeatureOperations.CutFeatureOperation)
    ei.participantBodies = [body]
    ei.setOneSideExtent(
        adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(mm(14))),
        adsk.fusion.ExtentDirections.NegativeExtentDirection)
    feat = ext.add(ei)
    feat.name = 'Manual button access openings'
    sk.isVisible = False

def cut_square_playback(comp, body):
    # The existing playback aperture has scalloped rails from the legacy
    # profile. A square through-cut at the same location clears the full
    # opening and its side rails without changing the neighboring controls.
    feature_name = 'Square manual opening over playback scallops 20x20'
    if any(comp.features.item(i).name == feature_name for i in range(comp.features.count)):
        return
    plane = create_offset_plane(comp, 3.0)
    plane.name = 'Playback square opening plane'
    sk = comp.sketches.add(plane)
    sk.name = 'Playback key square opening 20x20'
    rect(sk, -35, -52, -15, -32)
    profiles = adsk.core.ObjectCollection.create()
    for p in sk.profiles:
        profiles.add(p)
    if profiles.count != 1:
        raise RuntimeError('Expected one square opening profile; found ' + str(profiles.count))
    ei = comp.features.extrudeFeatures.createInput(
        profiles, adsk.fusion.FeatureOperations.CutFeatureOperation)
    ei.participantBodies = [body]
    ei.setOneSideExtent(
        adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(mm(14))),
        adsk.fusion.ExtentDirections.NegativeExtentDirection)
    cut = comp.features.extrudeFeatures.add(ei)
    cut.name = feature_name
    sk.isVisible = False

def make_sg90_mounts(root):
    # Two independent annular mount plates, 36 x 18 x 2 mm. The 25.5 x 13.5
    # opening clears the SG90 case; 2.6 mm holes accept M2 screws, and the
    # side notch provides a 6 mm servo-wire exit. Stock SG90 horns are used.
    plane = create_offset_plane(root, -5.0)
    sk = root.sketches.add(plane)
    sk.name = 'SG90 mounts - paired, M2 adjustment and wire relief'
    centers = [(-58, -18), (58, -40.5)]
    for cx, cy in centers:
        rect(sk, cx-18, cy-9, cx+18, cy+9)
        # Case relief window
        rect(sk, cx-12.75, cy-6.75, cx+12.75, cy+6.75)
        # SG90 ear fasteners, M2 screw clearance
        circle(sk, cx-14, cy, 1.3)
        circle(sk, cx+14, cy, 1.3)
        # Connector/wire exit on the outer edge, 6 x 4.5 mm
        rect(sk, cx-3, cy+5, cx+3, cy+11)
    profiles = adsk.core.ObjectCollection.create()
    for p in sk.profiles:
        profiles.add(p)
    ext = root.features.extrudeFeatures
    ei = ext.createInput(profiles, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    ei.setOneSideExtent(
        adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(mm(2))),
        adsk.fusion.ExtentDirections.PositiveExtentDirection)
    feat = ext.add(ei)
    feat.name = 'SG90 paired mounting plates, M2 clearance and cable notches'
    made = []
    for i in range(feat.bodies.count):
        b = feat.bodies.item(i)
        b.name = 'SG90 mount ' + ('Call' if i == 0 else 'End')
        made.append(b)
    sk.isVisible = False
    return made

def export_stl(design, body, path):
    options = design.exportManager.createSTLExportOptions(body, path)
    options.sendToPrintUtility = False
    return design.exportManager.execute(options)

def run(context):
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        design = adsk.fusion.Design.cast(app.activeProduct)
        if not design:
            raise RuntimeError('Active document is not a Fusion design.')
        front = component_named(design, 'PRINT 01 Front guard')
        if not front:
            raise RuntimeError('Could not find component PRINT 01 Front guard')
        guard = front.bRepBodies.item(0)
        has_access = any(front.features.item(i).name == 'Manual button access openings'
                         for i in range(front.features.count))
        if not has_access:
            cut_profiles(front, guard, 'front guard')
        cut_square_playback(front, guard)
        mounts = []
        for i in range(design.rootComponent.bRepBodies.count):
            b = design.rootComponent.bRepBodies.item(i)
            if b.name in ('SG90 mount Call', 'SG90 mount End'):
                mounts.append(b)
        if len(mounts) < 2:
            mounts = make_sg90_mounts(design.rootComponent)
        mounts.sort(key=lambda b: b.name)
        os.makedirs(os.path.join(OUT, 'PLA_parts'), exist_ok=True)
        export_stl(design, guard, os.path.join(OUT, 'PLA_parts', 'PRINT_01_Front_guard_SG90.stl'))
        for i, body in enumerate(mounts):
            side = 'Call' if i == 0 else 'End'
            export_stl(design, body, os.path.join(OUT, 'PLA_parts', 'SG90_mount_' + side + '.stl'))
        with open('/tmp/fusion_sg90_refit_result.txt', 'w') as f:
            f.write('SUCCESS\n')
            f.write('Front guard: manual access windows plus square 20 x 20 mm playback opening.\n')
            f.write('Two 36x18x2 mm SG90 annular mounts added with case relief, M2 holes and 6 mm wire exits.\n')
            f.write('STL exports written to ' + os.path.join(OUT, 'PLA_parts') + '\n')
        ui.messageBox('SG90 refit complete. Square playback opening, front-button access and paired SG90 mounts are present. STL files exported to vsmge20_print_ready/PLA_parts.')
    except:
        msg = traceback.format_exc()
        try:
            with open('/tmp/fusion_sg90_refit_result.txt', 'w') as f: f.write(msg)
        except: pass
        if ui: ui.messageBox(msg)
