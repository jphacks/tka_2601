import adsk.core, adsk.fusion, traceback, os

OUT = '/Users/oobashion/Documents/ChatGPT/speech-model/vsmge20_print_ready'

def mm(v):
    return v * 0.1  # Fusion internal length is cm.

def run(context):
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        design = adsk.fusion.Design.cast(app.activeProduct)
        if not design:
            raise RuntimeError('Active document is not a Fusion design.')

        front = next((c for c in design.allComponents if c.name == 'PRINT 01 Front guard'), None)
        if not front or front.bRepBodies.count == 0:
            raise RuntimeError('Could not find PRINT 01 Front guard body.')
        body = front.bRepBodies.item(0)
        feature_name = 'Square manual opening over playback scallops 20x20'
        if not any(front.features.item(i).name == feature_name for i in range(front.features.count)):
            plane_input = front.constructionPlanes.createInput()
            plane_input.setByOffset(front.xYConstructionPlane, adsk.core.ValueInput.createByReal(mm(3)))
            plane = front.constructionPlanes.add(plane_input)
            plane.name = 'Playback square opening plane'

            sketch = front.sketches.add(plane)
            sketch.name = 'Playback key square opening 20x20'
            p1 = adsk.core.Point3D.create(mm(-35), mm(-52), 0)
            p2 = adsk.core.Point3D.create(mm(-15), mm(-32), 0)
            sketch.sketchCurves.sketchLines.addTwoPointRectangle(p1, p2)

            profiles = adsk.core.ObjectCollection.create()
            for profile in sketch.profiles:
                profiles.add(profile)
            if profiles.count != 1:
                raise RuntimeError('Expected one square profile; found ' + str(profiles.count))

            ext = front.features.extrudeFeatures
            ext_input = ext.createInput(profiles, adsk.fusion.FeatureOperations.CutFeatureOperation)
            ext_input.participantBodies = [body]
            ext_input.setOneSideExtent(
                adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(mm(14))),
                adsk.fusion.ExtentDirections.NegativeExtentDirection)
            cut = ext.add(ext_input)
            cut.name = feature_name
            sketch.isVisible = False
            plane.isVisible = False

        os.makedirs(os.path.join(OUT, 'PLA_parts'), exist_ok=True)
        stl = os.path.join(OUT, 'PLA_parts', 'PRINT_01_Front_guard_SG90.stl')
        options = design.exportManager.createSTLExportOptions(body, stl)
        options.sendToPrintUtility = False
        if not design.exportManager.execute(options):
            raise RuntimeError('Fusion STL export failed.')
        with open('/tmp/fusion_square_opening_result.txt', 'w') as f:
            f.write('SUCCESS\n')
            f.write('PRINT 01 Front guard: square manual opening added at playback-key location, 20 x 20 mm.\n')
            f.write('Updated STL: ' + stl + '\n')
        ui.messageBox('Square opening added (20 x 20 mm). Updated front guard STL exported. Save the Fusion design to retain the feature.')
    except:
        msg = traceback.format_exc()
        try:
            with open('/tmp/fusion_square_opening_result.txt', 'w') as f:
                f.write(msg)
        except:
            pass
        if ui:
            ui.messageBox(msg)
