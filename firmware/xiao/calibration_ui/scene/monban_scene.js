// MONBAN on an intercom, in the CAD frame: millimetres, x right, y up, z out of the intercom
// face. The printed parts are the real CAD meshes (window.MONBAN_MESHES). Placement follows
// dango_proto/fusion/v3.py (birds) and capsule/fusion/mount_views.py (capsules). Intercom
// outlines are published sizes; key positions are estimates (specs.py says about +/-10 mm).
(() => {
  const T = window.THREE;
  const COLORS = {
    orange: 0xfa843a, deep: 0xe26826, cream: 0xfdf4e4, cheek: 0xffac92, ink: 0x2e2826, shine: 0xffffff,
    ivory: 0xe2ded2, housing: 0xf1eee6, btn: 0xc8cacd, screen: 0x12161c, bezel: 0x3a3d42, glass: 0x1b1e23,
    gear: 0xf2f2ee, servo: 0x2b3440, cable: 0xa9a59a, wall: 0xfafafb, wave: 0x5e6ad2,
  };
  // ---- exterior designs; add a line here to add one to the menu
  const DESIGNS = {
    bird: { name: '小鳥', shape: 'bird', swatch: '#FA843A' },
    matte: { name: 'カプセル マット黒', shape: 'capsule', swatch: '#2A2A28', color: 0x2a2a28, rough: 0.9, cable: 0x262624 },
  };
  // ---- intercom table, from universal_mount_concepts/fusion_scripts/specs.py and coverage.md.
  // rough: coverage.md gives the outline and says where the keys are, but no dimensions, so
  // the screen and keys are placed from that sentence alone.
  const key = (label, role, cx, cy, w, h, extra) => ({ label, role, cx, cy, w, h: h ?? w, shape: h ? 'rect' : 'round', ...extra });
  const INTERCOMS = {
    vlme30: { group: '戸建て', name: 'Panasonic VL-ME30 / ME25 / ME31 / MGZ30', W: 129, H: 169, D: 29, rc: 7, edge: 3,
      screen: [0, 40, 74, 56], grille: [-44, -12, 22, 12, 4], leds: [[-14, -12]], press: ['talk'],
      buttons: [key('再生', 'other', 4, -12, 7), key('モニター', 'other', 18, -12, 7), key('室内通話', 'other', 32, -12, 7), key('メニュー', 'other', 46, -12, 7),
        key('通話／終了', 'talk', 0, -62, 119, 40, { r: 6, h_up: 0.8, px: 0, py: -52 })] },
    vlmwd302: { group: '戸建て', name: 'Panasonic VL-MWD302 / MWE210 / MWZ200 / ME35 / MV38 / MN35A', W: 143, H: 186, D: 23.5, rc: 8, edge: 3,
      screen: [0, 45, 76, 57], grille: [-50, -22, 20, 10, 3], press: ['talk', 'end'],
      buttons: [key('4 方向キー', 'other', 0, -18, 22), key('F1', 'other', -30, -12, 12, 7, { r: 3 }), key('F2', 'other', -30, -26, 12, 7, { r: 3 }),
        key('室内通話', 'other', 30, -12, 12, 7, { r: 3 }), key('メニュー', 'other', 30, -26, 12, 7, { r: 3 }), key('モニター', 'other', 52, -19, 12, 7, { r: 3 }),
        key('通話', 'talk', -35, -72, 66, 28, { r: 5, h_up: 0.9 }), key('終了', 'end', 35, -72, 66, 28, { r: 5, h_up: 0.9 })] },
    vlmwd505: { group: '戸建て', name: 'Panasonic VL-MWD505 / X50AHF', W: 165, H: 192, D: 27, rc: 8, edge: 3,
      screen: [0, 30, 112, 64], grille: [-56, -36, 22, 10, 3], camera: [0, -78, 5], press: ['talk', 'end'],
      buttons: [key('通話', 'talk', -44, -78, 62, 26, { r: 5, h_up: 0.9 }), key('終了', 'end', 44, -78, 62, 26, { r: 5, h_up: 0.9 })] },
    vlx70: { group: '戸建て', name: 'Panasonic VL-X70AHF / MX70A（画面キーのみ）', W: 192, H: 135, D: 29, rc: 8, edge: 3, touch: true,
      screen: [0, 6, 160, 104], press: ['talk', 'end'],
      buttons: [key('画面の通話', 'talk', -14, -27.5, 30, 12, { r: 3, h_up: 0.5 }), key('画面のロック', 'other', 17, -27.5, 30, 12, { r: 3, h_up: 0.5 }), key('画面の終了', 'end', 49, -27.5, 30, 12, { r: 3, h_up: 0.5 })] },
    vlme50: { group: '戸建て', name: 'Panasonic VL-ME50', W: 161, H: 186, D: 23, rc: 8, edge: 3, rough: true,
      screen: [0, 35, 110, 70], press: ['talk', 'end'],
      buttons: [key('通話', 'talk', -40, -72, 70, 28, { r: 5, h_up: 0.9 }), key('終了', 'end', 40, -72, 70, 28, { r: 5, h_up: 0.9 })] },
    vlmwh705: { group: '戸建て', name: 'Panasonic VL-MWH705 / SWZ700 / SWE710', W: 210, H: 183.5, D: 29, rc: 8, edge: 3, rough: true,
      screen: [0, 22, 160, 100], press: ['talk', 'end'],
      buttons: [key('通話', 'talk', -65, -62, 70, 24, { r: 5, h_up: 0.9 }), key('終了', 'end', 65, -62, 70, 24, { r: 5, h_up: 0.9 })] },
    js1me: { group: '戸建て', name: 'Aiphone JS-1ME-T', W: 129, H: 169, D: 28, rc: 9, edge: 3,
      panel: [0, 23, 110, 114, 6], screen: [0, 45, 71, 53], leds: [[0, -42]], press: ['talk'],
      buttons: [key('モニター', 'other', 40, -22, 9), key('通話／終了', 'talk', 0, -68, 112, 26, { r: 6, h_up: 0.8, px: 0, py: -62 })] },
    jl1m: { group: '戸建て', name: 'Aiphone JL-1M-T', W: 130, H: 170, D: 26, rc: 8, edge: 3, rough: true,
      screen: [0, 28, 90, 68], press: ['talk'],
      buttons: [key('通話／終了', 'talk', 38, -62, 40, 26, { r: 5, h_up: 0.9 })] },
    jq1me: { group: '戸建て', name: 'Aiphone JQ-1ME-T', W: 130, H: 170, D: 26, rc: 8, edge: 3, rough: true,
      screen: [0, 28, 90, 68], press: ['talk'],
      buttons: [key('通話／終了', 'talk', 0, -62, 100, 26, { r: 5, h_up: 0.9 })] },
    ws2med: { group: '戸建て', name: 'Aiphone WS-2MED-T / WS-1ME-T / JT-2ME-T / JU-1MEK', W: 135, H: 180, D: 22, rc: 8, edge: 3, rough: true,
      screen: [0, 30, 95, 72], press: ['talk'],
      buttons: [key('通話／終了', 'talk', 0, -73, 100, 16, { r: 5, h_up: 0.9 })] },
    wk2me: { group: '戸建て', name: 'Aiphone WK-2ME-T（静電キー）', W: 150, H: 186, D: 27.5, rc: 8, edge: 3, rough: true, touch: true,
      screen: [0, 30, 110, 80], press: ['talk', 'end'],
      buttons: [key('静電の通話', 'talk', -40, -68, 50, 20, { r: 4, h_up: 0.5 }), key('静電の終了', 'end', 40, -68, 50, 20, { r: 4, h_up: 0.5 })] },
    vsmge20: { group: '子機', name: 'Panasonic VS-MGE20 / VL-MGE20（充電台）', W: 80, H: 123, D: 24.5, rc: 14, edge: 4,
      screen: [0, 25, 60, 45], mic: [30, 56], press: ['talk', 'end'], stand: { W: 95, H: 66.2, D: 64.2, lift: 15 },
      buttons: [key('通話', 'talk', -25, -20, 14, 8, { r: 4 }), key('終了', 'end', 26, -42, 9), key('モニター', 'other', 25, -20, 14, 8, { r: 4 }),
        key('4 方向キー', 'other', 0, -20, 17), key('再生', 'other', -25, -42, 9), key('メニュー', 'other', 0, -42, 9)] },
    vlwd623: { group: '子機', name: 'Panasonic VL-WD623 / WD616', W: 52, H: 173, D: 30, rc: 12, edge: 4,
      screen: [0, 50, 44, 34], press: ['talk', 'end'],
      buttons: [key('通話', 'talk', -12, -23.5, 14, 8, { r: 3 }), key('終了', 'end', 12, -23.5, 14, 8, { r: 3 }), key('ダイヤルカバー', 'other', 0, -55, 42, 40, { r: 4, h_up: 0.6 })] },
    ws2wd: { group: '子機', name: 'Aiphone WS-2WD', W: 55, H: 160, D: 27.5, rc: 12, edge: 4, rough: true,
      screen: [0, 45, 46, 36], press: ['talk', 'end'],
      buttons: [key('通話', 'talk', 0, -15, 30, 10, { r: 3 }), key('終了', 'end', 0, -35, 30, 10, { r: 3 })] },
    wl1me: { group: '子機', name: 'Aiphone WL-1ME', W: 57, H: 149, D: 27, rc: 12, edge: 4, rough: true,
      screen: [0, 40, 48, 36], press: ['talk', 'end'],
      buttons: [key('通話', 'talk', 0, -18, 38, 10, { r: 3 }), key('終了', 'end', 0, -42, 20, 10, { r: 3 })] },
    dearis: { group: '集合', name: 'Aiphone dearis VM-RMVU', W: 180, H: 240, D: 14.8, rc: 6, edge: 2.5,
      screen: [0, 28, 155, 87], grille: [0, -52, 46, 10, 4], leds: [[-70, -24], [-62, -24], [-54, -24]], press: ['talk', 'end'],
      buttons: [key('非常', 'other', 68, 100, 18, 10, { r: 3 }), key('ホーム', 'other', 0, -28, 12), key('警報停止', 'other', 60, -28, 22, 9, { r: 3 }),
        key('解錠', 'unlock', -52, -92, 40, 17, { r: 4 }), key('通話', 'talk', 0, -92, 40, 17, { r: 4 }), key('終了', 'end', 52, -92, 40, 17, { r: 4 })] },
  };
  Object.assign(INTERCOMS, {
    gbm2mka: { group: '集合', name: 'Aiphone PATMOα GBM-2MKA', W: 122, H: 217, D: 23.5, rc: 6, edge: 2.5, rough: true,
      screen: [0, 40, 100, 75], press: ['talk', 'end'],
      buttons: [key('解錠', 'unlock', -40, -85, 30, 16, { r: 4 }), key('通話', 'talk', 0, -85, 30, 16, { r: 4 }), key('終了', 'end', 40, -85, 30, 16, { r: 4 })] },
    gbm2ms: { group: '集合', name: 'Aiphone GBM-2MS（埋込）', W: 135, H: 120, D: 18.5, rc: 6, edge: 2.5, rough: true,
      screen: [0, 18, 100, 62], press: ['talk', 'end'],
      buttons: [key('解錠', 'unlock', -45, -38, 34, 14, { r: 4 }), key('通話', 'talk', 0, -38, 34, 14, { r: 4 }), key('終了', 'end', 45, -38, 34, 14, { r: 4 })] },
    gbm2m7: { group: '集合', name: 'Aiphone GBM-2M7（画面キーのみ）', W: 210, H: 155, D: 26.8, rc: 6, edge: 3, rough: true, touch: true,
      screen: [0, 0, 185, 130], press: ['talk'],
      buttons: [key('画面の解錠', 'unlock', -72, 50, 34, 14, { r: 3, h_up: 0.5 }), key('画面の話す', 'talk', 72, 50, 34, 14, { r: 3, h_up: 0.5 })] },
  });
  // ---- the numbers the CAD scripts share
  const RP = 4.5, YS = 6.09375, ZS = 7.0375, KEY_TRAVEL = 1.0, MAIN_W = 30, RAIL_Y = 42, GT = 3, HR = 2.34375;
  const SHAPES = {
    bird: { xc: -9.65, w: 30, y0: -18.46, y1: 14.1, rc: 7.5, railEnd: 21, stroke: 5, tilt: 0, yRc: -13.60625, railZ: 1.85 },
    // capsule/fusion/capsule.py; tilt is its loss at 0.2 mm tunnel clearance, not measured on a part
    capsule: { xc: -9.65, w: 30, y0: -18.85625, y1: 18.2, archY: 3.2, railEnd: 13.5, stroke: 4, tilt: 0.39, yRc: -13.20625, railZ: 1.6 },
  };

  const pressPoint = b => [b.px ?? b.cx, b.py ?? b.cy];
  function keyRows(spec) {
    const targets = spec.buttons.filter(b => spec.press.includes(b.role)).sort((a, b) => pressPoint(a)[1] - pressPoint(b)[1]);
    const rows = [];
    for (const b of targets) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(pressPoint(b)[1] - pressPoint(row[0])[1]) <= 16) row.push(b);
      else rows.push([b]);
    }
    return rows;
  }
  // Where every printed part goes on this intercom.
  function layout(spec, shapeName) {
    const S = SHAPES[shapeName], W = spec.W;
    const z0 = Math.max(...spec.buttons.map(b => b.h_up ?? 1.6)) + 1.2;
    const rows = keyRows(spec);
    const mean = r => r.reduce((a, b) => a + pressPoint(b)[1], 0) / r.length;
    const ry = rows.length === 1 ? mean(rows[0]) + S.yRc : (mean(rows[0]) + mean(rows[1])) / 2;
    const pushers = [];
    rows.flat().forEach((b, index) => {
      const [qx, qy] = pressPoint(b);
      const hang = qy < ry, sy = hang ? -1 : 1, shift = Math.min(Math.abs(S.xc), Math.max(b.w / 2 - 3, 0));
      let sx;
      if (shapeName === 'bird') sx = !hang && qx + S.xc < -W / 2 + 20 ? -1 : 1; // v3.py; there is no mirrored hanging bird
      else {
        const cost = s => { const xc = qx + s * shift + s * S.xc; return Math.max(Math.abs(xc) + S.w / 2 - (W / 2 - 0.5), 0) * 100 + Math.abs(xc); };
        sx = cost(1) <= cost(-1) ? 1 : -1;
      }
      pushers.push({ button: b, role: b.role, index, qx, qy, hang, sx, sy, px: qx + sx * shift, py: ry + sy * -S.yRc, gap: z0 + 0.3 - (b.h_up ?? 1.6) });
    });
    const xb = W / 2 + 13 + 1.5 + MAIN_W / 2;
    return { z0, ry, rows: rows.length, pushers, xb, x0: -W / 2 - 11.4, x1: xb + S.railEnd, mainBottom: shapeName === 'bird' ? ry - 7.7 : ry - RAIL_Y };
  }
  const STAND_LIP = 21; // height of the stand's front lip above its base: estimated, not measured
  function standLipTop(spec) { return -spec.H / 2 - spec.stand.lift + STAND_LIP; }
  // What the chosen parts run into, by the checks in mount_views.py.
  function fit(spec, shapeName) {
    const S = SHAPES[shapeName], L = layout(spec, shapeName), notes = [];
    const body = p => {
      const a = p.py + p.sy * S.y0, b = p.py + p.sy * S.y1;
      return { xc: p.px + p.sx * S.xc, y0: Math.min(a, b), y1: Math.max(a, b), r: S.w / 2 };
    };
    const bodies = L.pushers.map(body);
    // The outline in the part's own frame: an arch for the capsule, a rounded box for the bird.
    const inPart = (x, y, p) => {
      const lx = (x - p.px) / p.sx - S.xc, ly = (y - p.py) / p.sy, half = S.w / 2;
      if (Math.abs(lx) > half || ly < S.y0 || ly > S.y1) return false;
      if (S.archY !== undefined) return ly <= S.archY || Math.hypot(lx, ly - S.archY) <= half;
      const dx = Math.abs(lx) - (half - S.rc), dy = Math.max(ly - (S.y1 - S.rc), S.y0 + S.rc - ly);
      return dx <= 0 || dy <= 0 || Math.hypot(dx, dy) <= S.rc;
    };
    const hidden = (cx, cy, w, h, round) => {
      let total = 0, hit = 0;
      for (let i = 0; i < 13; ++i) for (let j = 0; j < 13; ++j) {
        const u = (i / 12 - 0.5) * w, v = (j / 12 - 0.5) * h;
        if (round && Math.hypot(u, v) > w / 2) continue;
        const x = cx + u, y = cy + v;
        total++;
        if (L.pushers.some(p => inPart(x, y, p)) || (x >= L.x0 && x <= L.x1 && Math.abs(y - L.ry) <= 3)) hit++;
      }
      return Math.round(100 * hit / total);
    };
    if (bodies.length === 2 && Math.abs(bodies[0].xc - bodies[1].xc) < S.w && bodies[0].y0 < bodies[1].y1 && bodies[1].y0 < bodies[0].y1)
      notes.push(`2 つの押す部品が ${(S.w - Math.abs(bodies[0].xc - bodies[1].xc)).toFixed(1)} mm 重なります`);
    if (spec.stand) {
      const over = standLipTop(spec) - Math.min(...bodies.map(c => c.y0));
      if (over > 0) notes.push(`下の部品が充電台に約 ${over.toFixed(1)} mm 当たります`);
    }
    for (const p of L.pushers) {
      const b = p.button;
      let on = 0;
      for (let i = 0; i < 15; ++i) for (let j = 0; j < 15; ++j) {
        const x = p.px + (i / 14 * 2 - 1) * GT / 2 - b.cx, y = p.py + (j / 14 * 2 - 1) * HR - b.cy;
        if (b.shape === 'round' ? Math.hypot(x, y) <= b.w / 2 : Math.abs(x) <= b.w / 2 && Math.abs(y) <= b.h / 2) on++;
      }
      const percent = Math.round(100 * on / 225);
      if (percent < 100) notes.push(`${b.label}キーに載るラックは ${percent}%`);
    }
    const features = spec.buttons.filter(b => !spec.press.includes(b.role)).map(b => [b.label, hidden(b.cx, b.cy, b.w, b.h, b.shape === 'round')]);
    if (spec.screen) features.push(['画面', hidden(spec.screen[0], spec.screen[1], spec.screen[2], spec.screen[3])]);
    if (spec.grille) features.push(['スピーカー', hidden(spec.grille[0], spec.grille[1], spec.grille[2], spec.grille[3])]);
    if (spec.camera) features.push(['カメラ', hidden(spec.camera[0], spec.camera[1], spec.camera[2] * 2, spec.camera[2] * 2, true)]);
    if (spec.mic) features.push(['マイク', hidden(spec.mic[0], spec.mic[1], 3, 3, true)]);
    (spec.leds || []).forEach(l => features.push(['LED', hidden(l[0], l[1], 3, 3, true)]));
    const covered = features.filter(f => f[1] > 0).map(f => `${f[0]} ${f[1]}%`);
    if (covered.length) notes.push(`隠れるもの: ${covered.join('、')}`);
    if (spec.touch) notes.push('画面のキーなので導電チップが要ります');
    return notes;
  }
  // A copy of a table entry with measured size and press points. Everything else on the face scales with the outline.
  function customize(id, change = {}) {
    const base = INTERCOMS[id], spec = JSON.parse(JSON.stringify(base));
    const fx = (change.W ?? base.W) / base.W, fy = (change.H ?? base.H) / base.H;
    Object.assign(spec, { W: base.W * fx, H: base.H * fy, D: change.D ?? base.D });
    const box = a => { if (a) { a[0] *= fx; a[1] *= fy; if (a.length > 2) { a[2] *= fx; a[3] *= fy; } } };
    [spec.screen, spec.panel, spec.grille].forEach(box);
    [spec.mic, spec.camera, ...(spec.leds || [])].forEach(a => { if (a) { a[0] *= fx; a[1] *= fy; } });
    for (const b of spec.buttons) {
      b.cx *= fx; b.cy *= fy; b.w *= fx; b.h *= b.shape === 'round' ? fx : fy;
      if (b.px !== undefined) { b.px *= fx; b.py *= fy; }
      const at = change[b.role];
      if (at) {
        if (b.px !== undefined) { b.px = at.x; b.py = at.y; }
        else { b.cx = at.x; b.cy = at.y; }
      }
    }
    return spec;
  }

  function b64(text, Type) {
    const raw = atob(text), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) bytes[i] = raw.charCodeAt(i);
    return new Type(bytes.buffer);
  }
  const geometries = {};
  function cadGeometry(name) {
    if (geometries[name]) return geometries[name];
    const part = window.MONBAN_MESHES[name];
    const q = b64(part.p, Int16Array), pos = new Float32Array(q.length);
    for (let i = 0; i < q.length; ++i) pos[i] = q[i] / 50;
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(pos, 3));
    geometry.setIndex(new T.BufferAttribute(b64(part.i, part.w === 2 ? Uint16Array : Uint32Array), 1));
    geometry.computeVertexNormals();
    geometry.userData.cad = true;
    return geometries[name] = geometry;
  }
  function material(color, rough = 0.62) {
    return new T.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
  }
  function mesh(geometry, mat, cast = true) {
    const m = new T.Mesh(geometry, mat);
    m.castShadow = cast; m.receiveShadow = true;
    return m;
  }
  function roundedRect(w, h, r) {
    const s = new T.Shape(), x = -w / 2, y = -h / 2;
    r = Math.min(r, w / 2, h / 2);
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
    s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    return s;
  }
  function slab(x0, y0, z0, x1, y1, z1, r, edge, mat) {
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    edge = Math.min(edge, d / 2 - 0.01, w / 2 - 0.01, h / 2 - 0.01);
    const geometry = new T.ExtrudeGeometry(roundedRect(w - 2 * edge, h - 2 * edge, Math.max(r - edge, 0.2)), {
      depth: d - 2 * edge, bevelEnabled: true, bevelThickness: edge, bevelSize: edge, bevelSegments: 5, curveSegments: 14,
    });
    const m = mesh(geometry, mat);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, z0 + edge);
    return m;
  }

  function drawScreen(ctx, state, seconds) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.fillStyle = '#0d1116'; ctx.fillRect(0, 0, w, h);
    if (state === 'off') return;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#6e7f91'); sky.addColorStop(1, '#3d4957');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#566473'; ctx.fillRect(w * 0.1, h * 0.12, w * 0.8, h);
    ctx.fillStyle = '#232c36';
    ctx.beginPath(); ctx.arc(w / 2, h * 0.42, h * 0.15, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(w / 2, h * 1.02, h * 0.38, h * 0.44, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, w, h * 0.15);
    ctx.fillStyle = '#fff'; ctx.font = `600 ${h * 0.08}px -apple-system, "Hiragino Sans", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(state === 'ringing' ? '玄関 呼び出し中' : '玄関 通話中', w * 0.04, h * 0.075);
    if (state === 'call') {
      const text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`;
      ctx.textAlign = 'right'; ctx.fillText(text, w * 0.96, h * 0.075); ctx.textAlign = 'left';
    }
  }

  function buildIntercom(group, mats, spec) {
    const { W, H, D } = spec, keys = {};
    group.add(slab(-W / 2, -H / 2, -D, W / 2, H / 2, 0, spec.rc, spec.edge, mats.housing));
    if (spec.stand) {
      const yb = -H / 2 - spec.stand.lift, zb = -D - 12, zf = zb + spec.stand.D, hw = spec.stand.W / 2;
      group.add(slab(-hw, yb, zb, hw, yb + spec.stand.lift, zf, 10, 4, mats.ivory));
      group.add(slab(-hw, yb, zb, hw, yb + spec.stand.H, -D - 0.2, 10, 4, mats.ivory));
      group.add(slab(-hw, yb + 4, 0.4, hw, yb + STAND_LIP, zf, 6, 2, mats.ivory));
    }
    if (spec.panel) {
      const [x, y, w, h, r] = spec.panel;
      group.add(slab(x - w / 2, y - h / 2, -0.5, x + w / 2, y + h / 2, 0.15, r, 0.05, mats.glass));
    }
    const [sx, sy, sw, sh] = spec.screen;
    group.add(slab(sx - sw / 2 - 3, sy - sh / 2 - 3, -0.5, sx + sw / 2 + 3, sy + sh / 2 + 3, 0.25, 3, 0.1, mats.bezel));
    const canvas = document.createElement('canvas');
    canvas.width = 480; canvas.height = Math.round(480 * sh / sw);
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    const screen = new T.Mesh(new T.PlaneGeometry(sw, sh), new T.MeshBasicMaterial({ map: texture }));
    screen.position.set(sx, sy, 0.3);
    group.add(screen);
    const dot = (x, y, r, mat) => { const m = mesh(new T.CircleGeometry(r, 20), mat, false); m.position.set(x, y, 0.05); group.add(m); };
    if (spec.mic) dot(spec.mic[0], spec.mic[1], 0.9, mats.ink);
    (spec.leds || []).forEach(l => dot(l[0], l[1], 1.2, mats.bezel));
    if (spec.camera) { dot(spec.camera[0], spec.camera[1], spec.camera[2], mats.btn); const c = mesh(new T.CircleGeometry(spec.camera[2] * 0.62, 24), mats.ink, false); c.position.set(spec.camera[0], spec.camera[1], 0.1); group.add(c); }
    if (spec.grille) {
      const [gx, gy, gw, gh, n] = spec.grille;
      for (let i = 0; i < n; ++i) {
        const y = gy - gh / 2 + (i + 0.5) * gh / n, m = mesh(new T.PlaneGeometry(gw, Math.min(1.2, gh / n * 0.5)), mats.ink, false);
        m.position.set(gx, y, 0.05); group.add(m);
      }
    }
    for (const b of spec.buttons) {
      const top = b.h_up ?? 1.6, r = b.shape === 'round' ? b.w / 2 : (b.r ?? 3);
      const m = slab(b.cx - b.w / 2, b.cy - b.h / 2, -0.5, b.cx + b.w / 2, b.cy + b.h / 2, top, r, Math.min(0.5, top / 2), mats.btn.clone());
      keys[b.role + b.label] = { mesh: m, rest: m.position.z };
      group.add(m);
    }
    return { keys, canvas, texture, ctx: canvas.getContext('2d') };
  }

  function pusher(mats, shellNames, base, p, z0) {
    // One press mechanism in its own frame: origin on the press point, z = 0 on the back plane.
    const root = new T.Group();
    root.position.set(p.px, p.py, z0);
    const fade = [];
    base.forEach(([name, mat]) => root.add(mesh(cadGeometry(name), mat)));
    shellNames.forEach(([name, mat]) => {
      const faded = mat.clone(); faded.transparent = true;
      root.add(mesh(cadGeometry(name), faded));
      fade.push(faded);
    });
    const mech = new T.Group();
    root.add(mech);
    const rack = mesh(cadGeometry('rack'), mats.gear); mech.add(rack);
    const pinionPivot = new T.Group();
    pinionPivot.position.set(0, YS, ZS);
    const pinion = mesh(cadGeometry('pinion'), mats.gear);
    pinion.position.set(0, -YS, -ZS);
    pinionPivot.add(pinion); mech.add(pinionPivot);
    mech.add(slab(-20.8, -8.90625, 2.8875, -3.5, 11.09375, 11.1875, 1, 0.5, mats.servo));
    return { root, mech, rack, pinionPivot, fade };
  }

  function paws(group, spec, L, mat) {
    const kind = L.rows === 1 ? 'std' : 'rows2';
    [['L', -1], ['R', 1]].forEach(([side, s]) => {
      const m = mesh(cadGeometry(`paw_${side}_${kind}`), mat);
      m.position.set(s * spec.W / 2, L.ry, L.z0 - 2.8);
      group.add(m);
    });
  }
  function buildBirds(mats, spec) {
    const group = new T.Group(), L = layout(spec, 'bird'), mechs = {};
    L.pushers.forEach(p => {
      const tag = p.hang ? 'hang_N' : p.sx < 0 ? 'sit_M' : 'sit_N';
      const shell = p.index % 2 ? mats.cream : mats.orange, hl = p.index % 2 ? mats.shine : mats.cream;
      const trims = [[`${tag}_cap`, shell], [`${tag}_beak`, mats.deep], [`${tag}_cheeks`, mats.cheek], [`${tag}_eyes`, mats.ink],
        [`${tag}_eyeshine`, mats.shine], [`${tag}_highlight`, hl], [`${tag}_${p.hang ? 'ribbon' : 'tuft'}`, mats.deep]];
      const m = pusher(mats, trims, [[`${tag}_base`, shell]], p, L.z0);
      m.mech.scale.set(p.sx, p.sy, 1);
      group.add(m.root);
      mechs[p.role] = { ...m, p };
    });
    group.add(slab(L.x0, L.ry - 3, L.z0 + SHAPES.bird.railZ, L.x1, L.ry + 3, L.z0 + SHAPES.bird.railZ + 6, 0.8, 0.6, mats.cream));
    paws(group, spec, L, mats.orange);
    const parent = new T.Group(); parent.position.set(L.xb, L.ry, L.z0 - 2.8);
    [['back', mats.orange], ['front', mats.orange], ['belly', mats.cream], ['beak', mats.deep], ['cheeks', mats.cheek],
     ['eyes', mats.ink], ['eyeshine', mats.shine], ['tuft', mats.orange], ['wings', mats.deep]]
      .forEach(([n, m]) => parent.add(mesh(cadGeometry('oya_' + n), m)));
    group.add(parent);
    return { group, L, mechs, speaker: new T.Vector3(L.xb, L.ry + 14, L.z0 + 21), mic: new T.Vector3(L.xb, L.ry + 14, L.z0 + 21),
      usbFrom: new T.Vector3(L.xb, L.ry - 7.7, L.z0 + 5) };
  }
  function buildCapsules(mats, spec) {
    const group = new T.Group(), L = layout(spec, 'capsule'), mechs = {};
    L.pushers.forEach(p => {
      const m = pusher(mats, [['cap_shell', mats.shell]], [['cap_base', mats.shell]], p, L.z0);
      m.root.scale.set(p.sx, p.sy, 1);
      group.add(m.root);
      mechs[p.role] = { ...m, p };
    });
    group.add(slab(L.x0, L.ry - 3, L.z0 + SHAPES.capsule.railZ, L.x1, L.ry + 3, L.z0 + SHAPES.capsule.railZ + 6, 0.5, 0.4, mats.shell));
    paws(group, spec, L, mats.shell);
    const main = new T.Group(); main.position.set(L.xb, L.ry - RAIL_Y, L.z0);
    main.add(mesh(cadGeometry('main_back'), mats.shell), mesh(cadGeometry('main_front'), mats.shell));
    group.add(main);
    return { group, L, mechs, speaker: new T.Vector3(L.xb, L.ry, L.z0 + 20), mic: new T.Vector3(L.xb, L.ry - 30, L.z0 + 20),
      usbFrom: new T.Vector3(L.xb, L.ry - RAIL_Y, L.z0 + 3.7) };
  }
  function disposeTree(root) {
    root.traverse(o => {
      if (o.geometry && !o.geometry.userData.cad) o.geometry.dispose();
      if (o.material && o.material.map) o.material.map.dispose();
    });
  }

  function mount(canvas, options = {}) {
    const renderer = new T.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.NoToneMapping; // printed colours stay as in the CAD palette
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const scene = new T.Scene();
    scene.background = new T.Color(0xffffff);
    const camera = new T.PerspectiveCamera(32, 1, 10, 3000);
    scene.add(new T.HemisphereLight(0xffffff, 0xd8d2c6, 1.55));
    const sun = new T.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-160, 260, 300);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -220, right: 220, top: 220, bottom: -220, near: 50, far: 900 });
    sun.shadow.bias = -0.0006;
    sun.shadow.radius = 5;
    scene.add(sun);
    const mats = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, material(v)]));
    mats.btn.roughness = 0.4; mats.bezel.roughness = 0.3; mats.housing.roughness = 0.5; mats.glass.roughness = 0.2;
    mats.shell = material(0xffffff);
    mats.usb = material(COLORS.cable);
    // Shadow only, on the page's own background, so there is no horizon line.
    const table = new T.Mesh(new T.PlaneGeometry(3000, 3000), new T.ShadowMaterial({ opacity: 0.16 }));
    table.receiveShadow = true;
    table.rotation.x = -Math.PI / 2;
    scene.add(table);
    // The wall hides whatever reaches past a thin intercom; its colour stays flat, with only the shadow on it.
    const wall = new T.Group();
    wall.add(new T.Mesh(new T.PlaneGeometry(3000, 3000), new T.MeshBasicMaterial({ color: COLORS.wall })));
    const wallShadow = new T.Mesh(new T.PlaneGeometry(3000, 3000), new T.ShadowMaterial({ opacity: 0.16 }));
    wallShadow.receiveShadow = true; wallShadow.position.z = 0.05;
    wall.add(wallShadow);
    scene.add(wall);

    let intercomId = options.intercom || 'vsmge20', change = options.change || null, designId = options.design || 'bird';
    let spec, intercom, product, intercomGroup = null;
    const press = { talk: 0, end: 0 }, pressTarget = { talk: 0, end: 0 }, reach = { talk: null, end: null }, pace = { talk: 0.2, end: 0.2 }, unshown = { talk: false, end: false };
    let xray = false, xrayAmount = 0, screenState = 'off', callStart = 0, lastScreen = -1;
    // ---- camera
    const view = { az: -0.42, el: 0.22, dist: 420, target: new T.Vector3() };
    const goal = { az: view.az, el: view.el, dist: view.dist, target: new T.Vector3() };
    const home = { az: view.az, el: view.el, dist: view.dist, target: new T.Vector3() };
    let cameraReady = false;
    function rebuild() {
      if (intercomGroup) { scene.remove(intercomGroup); disposeTree(intercomGroup); }
      if (product) { scene.remove(product.group); disposeTree(product.group); }
      spec = customize(intercomId, change || {});
      for (const role of Object.keys(press)) { press[role] = pressTarget[role] = 0; reach[role] = null; unshown[role] = false; }
      const design = DESIGNS[designId];
      if (design.shape === 'capsule') {
        Object.assign(mats.shell.color, new T.Color(design.color));
        mats.shell.roughness = design.rough;
      }
      mats.usb.color.set(design.cable ?? COLORS.cable);
      intercomGroup = new T.Group();
      scene.add(intercomGroup);
      intercom = buildIntercom(intercomGroup, mats, spec);
      product = (design.shape === 'bird' ? buildBirds : buildCapsules)(mats, spec);
      scene.add(product.group);
      const onStand = !!spec.stand, floor = onStand ? -spec.H / 2 - spec.stand.lift : -spec.H / 2 - 110;
            table.visible = onStand; table.position.y = floor;
      wall.visible = !onStand; wall.position.z = -spec.D;
      const u = product.usbFrom;
      const curve = onStand
        ? new T.CatmullRomCurve3([u, u.clone().add(new T.Vector3(0, -18, 0)), new T.Vector3(u.x + 18, floor + 3, u.z + 22), new T.Vector3(u.x + 150, floor + 2, u.z + 40)])
        : new T.CatmullRomCurve3([u, u.clone().add(new T.Vector3(0, -22, 0)), new T.Vector3(u.x + 1, u.y - 70, -spec.D + 6), new T.Vector3(u.x, u.y - 400, -spec.D + 2.2)]);
      product.group.add(mesh(new T.TubeGeometry(curve, 60, 1.8, 10), mats.usb));
      lastScreen = -1;
      drawScreen(intercom.ctx, screenState, 0); intercom.texture.needsUpdate = true;
      for (const m of Object.values(product.mechs)) pose(m, 0);
      // frame the whole rig
      const L = product.L, bottom = Math.min(-spec.H / 2, L.mainBottom - 12), span = Math.max((L.x1 - L.x0) / 1.25, spec.H / 2 - bottom + 26);
      home.dist = span * 1.42 / (2 * Math.tan(T.MathUtils.degToRad(16)));
      home.target.set((L.x0 + L.x1) / 2, (spec.H / 2 + bottom) / 2, 0);
      Object.assign(goal, { az: home.az, el: home.el, dist: home.dist }); goal.target.copy(home.target);
      if (!cameraReady) { view.dist = home.dist; view.target.copy(home.target); cameraReady = true; }
      if (source) source = { ...sources()[source.name], name: source.name };
    }
    // ---- sound rings
    const rings = [];
    const ringGeometry = new T.RingGeometry(0.93, 1, 56);
    let source = null, emitAt = 0;
    const emit = (now) => {
      const mat = new T.MeshBasicMaterial({ color: COLORS.wave, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false });
      const m = new T.Mesh(ringGeometry, mat);
      m.position.copy(source.position);
      scene.add(m);
      rings.push({ mesh: m, born: now, inward: source.inward, size: source.size });
    };
    const sources = () => ({
      intercom: { position: spec.grille ? new T.Vector3(spec.grille[0], spec.grille[1], 2.2) : new T.Vector3(-spec.W * 0.42, -spec.H * 0.44, 2.2), inward: false, size: 55 },
      device: { position: product.speaker.clone(), inward: false, size: 42 },
      visitor: { position: product.mic.clone(), inward: true, size: 44 },
    });
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let follow = !options.noFollow && !reduce, userUntil = 0;
    const focus = (key) => {
      if (!follow || performance.now() < userUntil) return;
      if (!key) { Object.assign(goal, { az: home.az, el: home.el, dist: home.dist }); goal.target.copy(home.target); return; }
      const p = product.mechs[key].p;
      Object.assign(goal, { az: p.qx < 0 ? -0.75 : 0.75, el: 0.28, dist: 200 });
      goal.target.set(p.qx, p.qy, 4);
    };
    let dragging = false, px = 0, py = 0;
    const el = renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', e => { dragging = true; px = e.clientX; py = e.clientY; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => { dragging = false; });
    el.addEventListener('pointermove', e => {
      if (!dragging) return;
      userUntil = performance.now() + 6000;
      goal.az -= (e.clientX - px) * 0.006;
      goal.el = Math.max(-0.05, Math.min(1.1, goal.el + (e.clientY - py) * 0.005));
      px = e.clientX; py = e.clientY;
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      userUntil = performance.now() + 6000;
      goal.dist = Math.max(120, Math.min(1400, goal.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });

    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    let running = true, last = performance.now();
    function pose(mech, s) {
      mech.rack.position.z = -s;
      mech.pinionPivot.rotation.x = s / RP;
    }
    rebuild();
    function frame(now) {
      if (!running) return;
      requestAnimationFrame(frame);
      if (document.hidden) { last = now; return; }
      const elapsed = (now - last) / 1000; // presses follow real time, however few frames there are
      const dt = Math.min(elapsed, 0.1);
      last = now;
      let moving = false;
      for (const role of Object.keys(press)) {
        // The real servo: about 0.2 s over the stroke at 60 deg per 0.1 s; the key follows after contact.
        // A press is drawn all the way in before it returns, even if its release came first.
        const delta = (unshown[role] ? 1 : pressTarget[role]) - press[role];
        press[role] += Math.sign(delta) * Math.min(Math.abs(delta), elapsed / pace[role]);
        if (press[role] >= 1) unshown[role] = false;
        const m = product.mechs[role];
        if (!m) continue;
        const full = m.p.gap + KEY_TRAVEL; // the key's bottom stops the rack
        const s = press[role] * Math.min(reach[role] ?? full, full);
        pose(m, s);
        const k = intercom.keys[m.p.role + m.p.button.label];
        k.mesh.position.z = k.rest - Math.max(0, s - m.p.gap);
        if (press[role] > 0.001) moving = true;
      }
      const wantX = xray || moving ? 1 : 0;
      xrayAmount += (wantX - xrayAmount) * Math.min(1, dt * 8);
      for (const mech of Object.values(product.mechs))
        mech.fade.forEach(m => { m.opacity = 1 - 0.72 * xrayAmount; m.depthWrite = xrayAmount < 0.5; });
      if (source && now >= emitAt) { emit(now); emitAt = now + 360; }
      for (let i = rings.length - 1; i >= 0; --i) {
        const r = rings[i], age = (now - r.born) / 1400;
        if (age >= 1) { scene.remove(r.mesh); r.mesh.material.dispose(); rings.splice(i, 1); continue; }
        const t = r.inward ? 1 - age : age;
        r.mesh.scale.setScalar(4 + t * r.size);
        r.mesh.material.opacity = 0.55 * (1 - age) * Math.min(1, age * 8);
        r.mesh.quaternion.copy(camera.quaternion);
      }
      const seconds = screenState === 'call' ? (now - callStart) / 1000 : 0;
      const stamp = screenState === 'call' ? Math.floor(seconds) : -2;
      if (stamp !== lastScreen) {
        lastScreen = stamp;
        drawScreen(intercom.ctx, screenState, seconds);
        intercom.texture.needsUpdate = true;
      }
      const ease = 1 - Math.exp(-dt * (dragging ? 18 : 3.2));
      view.az += (goal.az - view.az) * ease;
      view.el += (goal.el - view.el) * ease;
      view.dist += (goal.dist - view.dist) * ease;
      view.target.lerp(goal.target, ease);
      camera.position.set(
        view.target.x + view.dist * Math.sin(view.az) * Math.cos(view.el),
        view.target.y + view.dist * Math.sin(view.el),
        view.target.z + view.dist * Math.cos(view.az) * Math.cos(view.el));
      camera.lookAt(view.target);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);

    // 通話 and 終了 share one mechanism on a single-bar intercom; 解錠 has none on these kits.
    const roleOf = name => {
      if (name === 'unlock') return null;
      const role = name === 'call' ? 'talk' : name;
      return product.mechs[role] ? role : 'talk';
    };
    return {
      setIntercom(id, measured) { intercomId = id; change = measured || null; rebuild(); },
      setDesign(id) { designId = id; rebuild(); },
      fit() { return fit(spec, DESIGNS[designId].shape); },
      setPress(name, on, how = {}) {
        const role = roleOf(name);
        if (!role) return false;
        if (on) { reach[role] = how.mm ?? null; unshown[role] = true; }
        pace[role] = how.seconds ?? 0.2;
        pressTarget[role] = on ? 1 : 0;
        if (how.focus !== false) focus(on ? role : null);
        return true;
      },
      look(name) { const role = roleOf(name); focus(role); },
      gap(name) { const role = roleOf(name); return role ? product.mechs[role].p.gap : null; },
      // What the model is showing now, as drawn in the last frame.
      pose() {
        const rack = role => product.mechs[role] ? -product.mechs[role].rack.position.z : 0;
        return { talk: rack('talk'), end: rack('end'), screen: screenState, sound: source ? source.name : null };
      },
      setXray(on) { xray = on; },
      setScreen(state) {
        if (state === 'call' && screenState !== 'call') callStart = performance.now();
        screenState = state; lastScreen = -1;
      },
      sound(name) {
        if (!name) { source = null; return; }
        source = { ...sources()[name], name };
        emitAt = 0;
      },
      setFollow(on) { follow = on && !reduce; },
      dispose() { running = false; observer.disconnect(); renderer.dispose(); },
    };
  }
  window.MonbanScene = { mount, INTERCOMS, DESIGNS, SHAPES, RP, layout, fit, customize, pressPoint };
})();
