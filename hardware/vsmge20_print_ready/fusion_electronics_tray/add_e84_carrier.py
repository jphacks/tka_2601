import adsk.core, adsk.fusion, traceback, os

OUT = '/Users/oobashion/Documents/ChatGPT/speech-model/vsmge20_print_ready'
STL = os.path.join(OUT, 'PLA_parts', 'Electronics_tray_PSoC_Edge_E84_AI_M5Stack_Basic.stl')
F3D = os.path.join(OUT, 'fusion_electronics_tray', 'VS-MGE20_Case_SG90_v6_PSoC_Edge_E84_AI_M5StackBasic.f3d')

def mm(v): return v * 0.1  # Fusion internal length is cm.

def rect(sk, x1, y1, x2, y2):
    sk.sketchCurves.sketchLines.addTwoPointRectangle(
        adsk.core.Point3D.create(mm(x1), mm(y1), 0),
        adsk.core.Point3D.create(mm(x2), mm(y2), 0))

def plane_at(comp, z):
    inp = comp.constructionPlanes.createInput()
    inp.setByOffset(comp.xYConstructionPlane, adsk.core.ValueInput.createByReal(mm(z)))
    return comp.constructionPlanes.add(inp)

def extrude(comp, sk, height, op, name):
    profiles = adsk.core.ObjectCollection.create()
    for p in sk.profiles: profiles.add(p)
    if not profiles.count: raise RuntimeError('No profiles for ' + name)
    ei = comp.features.extrudeFeatures.createInput(profiles, op)
    ei.setOneSideExtent(adsk.fusion.DistanceExtentDefinition.create(
        adsk.core.ValueInput.createByReal(mm(abs(height)))),
        adsk.fusion.ExtentDirections.PositiveExtentDirection if height >= 0 else adsk.fusion.ExtentDirections.NegativeExtentDirection)
    f = comp.features.extrudeFeatures.add(ei); f.name = name
    sk.isVisible = False
    return f

def run(context):
    ui = None
    try:
        app = adsk.core.Application.get(); ui = app.userInterface
        design = adsk.fusion.Design.cast(app.activeProduct)
        if not design: raise RuntimeError('Active document is not a Fusion design.')
        root = design.rootComponent
        oldnames = {'Electronics tray - PSoC6 AI + M5Stack Basic', 'Electronics carrier - PSoC Edge E84 AI + M5Stack Basic'}
        for i in range(root.occurrences.count - 1, -1, -1):
            occ = root.occurrences.item(i)
            if occ.component.name in oldnames: occ.deleteMe()

        # Manufactuer's guide/schematic identify the KIT_PSE84_AI, but do not
        # publish the PCB outline dimensions. The board bay uses a photo-scaled
        # 98 x 56 mm envelope (2.54 mm header pitch as scale), with strap fit.
        # Confirm on the actual PCB before final print.
        nm = 'Electronics carrier - PSoC Edge E84 AI + M5Stack Basic'
        mat = adsk.core.Matrix3D.create()
        mat.translation = adsk.core.Vector3D.create(mm(0), mm(0), mm(-27.2))
        occ = root.occurrences.addNewComponent(mat); comp = occ.component; comp.name = nm

        # 174 x 72 x 2.8 mm open plate; within A1 mini build area.
        sk = comp.sketches.add(comp.xYConstructionPlane); sk.name = '174x72 light carrier plate'
        rect(sk, -87, -36, 87, 36)
        base = extrude(comp, sk, 2.8, adsk.fusion.FeatureOperations.NewBodyFeatureOperation, 'E84 and M5Stack carrier base')
        body = base.bodies.item(0); body.name = 'E84 AI plus M5Stack carrier'

        # Four elongated external strap slots for removable 4 mm ties around E84 board.
        slots = comp.sketches.add(plane_at(comp, 2.8)); slots.name = 'Adjustable E84 strap slots and shared cable pass'
        for x in (-81, 15):
            for y in (-32, 32): rect(slots, x-2.0, y-1.5, x+2.0, y+1.5)
        rect(slots, 14, -8, 20, 8)  # wire route between bays
        extrude(comp, slots, -3.3, adsk.fusion.FeatureOperations.CutFeatureOperation, 'E84 strap slots and cable transfer')

        # PSoC board bay: board laid landscape, photo-scaled 98 x 56 mm envelope.
        # Four 7 x 7 mm pads touch near corners; leave the component underside clear.
        bx, by = -33, 0
        supports = comp.sketches.add(plane_at(comp, 2.8)); supports.name = 'E84 AI board corner supports - 98x56 envelope'
        for x in (bx-41, bx+41):
            for y in (-21, 21): rect(supports, x-3.5, y-3.5, x+3.5, y+3.5)
        extrude(comp, supports, 4.2, adsk.fusion.FeatureOperations.JoinFeatureOperation, 'E84 PCB stand-off pads - 4.2mm underside clearance')

        # Low retaining rails along the long sides with 12 mm openings at both ends.
        rails = comp.sketches.add(plane_at(comp, 2.8)); rails.name = 'E84 low side guides - end ports remain open'
        for y in (-29, 29):
            rect(rails, bx-37, y-1.0, bx-6, y+1.0)
            rect(rails, bx+6, y-1.0, bx+37, y+1.0)
        extrude(comp, rails, 3.5, adsk.fusion.FeatureOperations.JoinFeatureOperation, 'E84 side guides with open USB and header ends')

        # M5Stack Basic 60 x 60 mm pocket to the right. Split fences leave the USB/button edge open.
        mx = 50
        fences = comp.sketches.add(plane_at(comp, 2.8)); fences.name = 'M5Stack Basic 60mm open-sided fence'
        for x in (mx-31, mx+31):
            for y1, y2 in ((-29, -12), (12, 29)): rect(fences, x-1.0, y1, x+1.0, y2)
        for y in (-31, 31):
            rect(fences, mx-30, y-1.0, mx-12, y+1.0)
            rect(fences, mx+12, y-1.0, mx+30, y+1.0)
        extrude(comp, fences, 7.0, adsk.fusion.FeatureOperations.JoinFeatureOperation, 'M5Stack Basic retaining fence - connectors accessible')

        comp.attributes.add('Board fit', 'KIT_PSE84_AI / PSOC Edge E84 AI Kit', 'PSoC PCB bay is photo-scaled to 98 x 56 mm; Infineon schematic/user guide do not state the PCB outline. Adjustable straps and open ends allow fit tuning; verify actual board and connector access before print.')
        comp.attributes.add('M5Stack fit', 'M5Stack Basic', '60 x 60 mm retaining fence; open sides for USB and controls.')
        os.makedirs(os.path.dirname(STL), exist_ok=True)
        opts = design.exportManager.createSTLExportOptions(body, STL)
        opts.sendToPrintUtility = False
        design.exportManager.execute(opts)
        archive = design.exportManager.createFusionArchiveExportOptions(F3D, root)
        if not archive: raise RuntimeError('Could not create F3D export options.')
        design.exportManager.execute(archive)
        with open('/tmp/vsmge20_e84_carrier_result.txt', 'w', encoding='utf-8') as f:
            f.write('SUCCESS\n')
            f.write('Updated carrier: PSoC Edge E84 AI + M5Stack Basic.\n')
            f.write('Plate: 174x72x2.8 mm; overall rail height 9.8 mm; STL: '+STL+'\n')
            f.write('F3D: '+F3D+'\n')
            f.write('E84 bay: estimated 98x56 mm (photo-scaled; must check the real board).\n')
        ui.messageBox('Updated carrier for PSoC Edge E84 AI + M5Stack Basic. STL exported. Save As a new Fusion file to preserve this revision.')
    except:
        msg = traceback.format_exc()
        try: open('/tmp/vsmge20_e84_carrier_result.txt','w',encoding='utf-8').write(msg)
        except: pass
        if ui: ui.messageBox(msg)
