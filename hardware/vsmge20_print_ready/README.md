# VS-MGE20 / SG90 print package (fast variant)

This package contains the revised Fusion 360 design exports and Bambu Studio slices for an A1 mini (180 × 180 × 180 mm build volume). Four operation buttons are accessible through the front guard; the call and end buttons are actuated by SG90 servos, while the other front-panel controls remain manually accessible. The fast variant omits the separate charger cradle frame and uses the upper/lower bridge slots with removable elastic straps to hold the front assembly in place.

## Print plates and Bambu Studio estimates

| Plate | Contents | Material/profile used for this estimate | Time |
|---|---|---|---:|
| 02 fast | Front guard with manual access openings, bridges, SG90 mounts and related PLA parts; supports disabled | PLA Basic, A1 mini, 0.20 mm layer height | **2 h 07 min (measured in Bambu Studio)** |
| 03 | Remaining small PLA linkage parts | Existing Bambu estimate, 0.12 mm | 8 min 52 sec |
| 04 | Two compliant button pads | Existing Bambu estimate with PLA; TPU is recommended for the actual pads | 7 min 25 sec |

The reduced set is estimated at **about 2 h 23 min** (2 h 07 min measured for the large plate plus the previously measured 16 min 17 sec for plates 03 and 04). The auxiliary plates have not been re-sliced with the faster 0.20 mm setting, so the all-in figure is an estimate rather than one single Bambu Studio total. Plate 04's saved estimate used PLA Basic, not TPU; re-slice `Plate_04_TPU.stl` with a suitable TPU profile before printing those pads. TPU time can differ. The charger cradle frame is intentionally not included in this fast set. No job was sent to the printer.

The 3MF projects retain the plate layouts and process settings:

- `VS-MGE20_SG90_Plate01.3mf` (original cradle frame; excluded from fast set)
- `VS-MGE20_SG90_Plate02_Fast_0p20_no_support.3mf` (new measured fast slice)
- `VS-MGE20_SG90_Plate02.3mf` (original supported version)
- `VS-MGE20_SG90_Plate03.3mf`
- `VS-MGE20_SG90_Plate04_TPU.3mf` (saved in PLA; re-slice with TPU before printing)

The combined plate STLs are `Plate_01.stl`, `Plate_02_SG90.stl`, `Plate_03_SG90.stl`, and `Plate_04_TPU.stl`. Individual part STLs are in `PLA_parts/` and `TPU_parts/`. Use the `_SG90` plate 2 and 3 files rather than the older unsuffixed versions.

## Fusion 360 design

The updated cloud Fusion 360 design is **VS-MGE20 Case SG90 v3 v2 (shion)**, saved with the version description “SG90 mount and manual button access openings”. `fusion_sg90_refit/fusion_sg90_refit.py` contains the Fusion API changes used to add the four manual access apertures and the pair of SG90 mount plates. The plate STL exports are in `PLA_parts/`.

The SG90 mounts include screw clearance holes and a wire exit relief. Use the SG90's supplied output horn with the existing linkage. The horn-to-linkage fit and exact device button centers/required travel have not been verified on the physical hardware; use the adjustment slots and mechanical stops, then test at low servo angles before normal operation. For the fast set, omit the charger cradle frame and route two removable elastic straps through the upper/lower bridge slots; use M3 fasteners for the printed assembly. Keep servo leads away from the pusher travel. See `SG90_placement_concept.svg` for the motor-location concept.

## Assembly and print notes

- Print PLA parts in PLA; print `TPU_parts/TPU_01_Call_button_pad.stl` and `TPU_parts/TPU_02_End_button_pad.stl` in TPU for compliant tips.
- The fast Plate 02 slice disables all supports to save time. Bambu Studio's prior supported slice took 4 h 57 min; the new no-support slice shows a 2 h 07 min total. Inspect the underside of cantilevers after printing; if critical surfaces sag, enable supports for those regions and expect a longer print.
- The two SG90s mount in the left/right pods. Route each three-wire lead through its mount's side relief, leaving slack for the horn sweep; secure leads so they cannot enter the pusher/fork path. Power the servos from a supply appropriate for the SG90 current; do not assume a controller board's GPIO pin can power them.
- Verify manual access to the four-way key, playback, menu and monitor controls after assembly. Verify the display, mic, speaker and status indicators remain unobstructed.
- Start with conservative servo angles and short presses. The push travel and end stop require physical tuning on the actual VS-MGE20 before unattended use.

`layout_sg90.csv` records the revised plate 2/3 placements. `layout.csv` is the original layout mapping.

## PSoC Edge E84 AI Kit + M5Stack Basic carrier

Added an updated Fusion 360 design and a separate electronics carrier for the Infineon KIT_PSE84_AI, alongside the existing VS-MGE20/SG90 package. The carrier retains the M5Stack Basic and leaves connector sides accessible. The carrier plate is 174 × 72 × 2.8 mm (9.8 mm maximum rail height).

**Board-fit limitation:** Infineon's public product page, kit guide and schematic/PCB design-data page do not state the PCB outline dimensions. The E84 bay in this model is a photo-scaled estimate of 98 × 56 mm. Check the actual board and connector/cable clearances before relying on this fit. The nominal modeled gap between the E84 bay and M5Stack fence is about 4 mm.

The Bambu Studio project and G-code in this section contain **the electronics carrier only**, not a complete re-slice of all enclosure and servo parts. The screenshot's separate linkage/bar parts are not in this tray STL. The carrier was sliced for A1 mini, 0.4 mm nozzle, Bambu PLA Basic, 0.12 mm High Quality, supports off: estimated total 1 h 34 min and 30.52 g.

- Fusion design: `VS-MGE20_Case_SG90_v6_PSoC_Edge_E84_AI_M5StackBasic.f3d`
- Carrier STL: `PLA_parts/Electronics_tray_PSoC_Edge_E84_AI_M5Stack_Basic.stl`
- Bambu Studio project: `VS-MGE20_E84_M5StackBasic_A1mini_0p12_PLA.3mf`
- G-code: `Electronics_tray_PSoC_Edge_E84_AI_M5Stack_Basic_PLA_1h34m.gcode`
- Dimension notes and sources: `README_E84.md`

Sources: [Infineon KIT_PSE84_AI](https://www.infineon.com/evaluation-board/kit-pse84-ai), [kit guide](https://documentation.infineon.com/psocedge/docs/cci1762693051052), [schematic and PCB design data](https://www.infineon.com/assets/row/public/documents/30/60/infineon-kit-pse84-ai-schematics-pcbdesigndata-en.pdf).
