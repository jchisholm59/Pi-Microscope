// Pi-Microscope client. One viewer for the live stream and for gallery pictures, with an overlay for measuring.
// Coordinates: live shapes are kept in sensor-normalised units (0..1 across the whole IMX477), so they stay on the
// specimen while you zoom; gallery shapes are in image-normalised units. A calibration is micrometres per sensor
// pixel, so it's right at any zoom and any capture size.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SENSOR = [4056, 3040];
const store = {
  get(k, d) { try { const v = localStorage.getItem('pimicro:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pimicro:' + k, JSON.stringify(v)); } catch (e) {} },
};
function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3500);
}

// ---- state ----------------------------------------------------------------------------------------------------------
let S = null, stats = {}, cals = [], cal = null, presets = [], jobs = {};
let images = [];
let mode = 'live';            // 'live' | 'still'
let still = null;             // gallery image meta when mode === 'still'
let stillView = { x: 0, y: 0, z: 1 };
let tool = 'pan';
const ov = store.get('ov', { cross: false, grid: false, scale: true, peak: false });
let liveShapes = store.get('liveShapes', []); // sensor-normalised
let shapes = liveShapes;                        // the set being shown (live or the still's)
let draft = null;                               // shape being drawn
let frozen = false;

// ---- websocket ----------------------------------------------------------------------------------------------------
let ws = null;
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    $('conn').textContent = 'connected';
    $('conn').className = 'pill';
    if (mode === 'live' && !frozen) startStream();
    loadImages();
  };
  ws.onclose = () => {
    $('conn').textContent = 'reconnecting…';
    $('conn').className = 'pill bad';
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
}
const cmd = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
let setTimer = null, setPending = {};
function setLater(o) {
  Object.assign(setPending, o);
  Object.assign(S, o);
  clearTimeout(setTimer);
  setTimer = setTimeout(() => {
    cmd({ cmd: 'set', ...setPending });
    setPending = {};
  }, 90);
}
function onMsg(m) {
  switch (m.type) {
    case 'state':
      S = { ...m.settings, ...setPending };
      cals = m.calibrations;
      cal = m.calibration;
      presets = m.presets;
      jobs = m.jobs;
      renderControls();
      renderJobs();
      renderMeas();
      draw();
      break;
    case 'stats':
      stats = { ...stats, ...m };
      renderStats();
      break;
    case 'job':
      onJob(m);
      break;
    case 'image':
      upsertImage(m.image);
      break;
    case 'deleted':
      images = images.filter((i) => i.id !== m.id);
      if (still?.id === m.id) backToLive();
      renderGallery();
      break;
    case 'captured':
      toast(`Saved ${m.image.w}×${m.image.h}`);
      break;
    case 'toast':
      toast(m.msg, m.error);
      break;
  }
}

// ---- viewer geometry -------------------------------------------------------------------------------------------------
const viewer = $('viewer'), live = $('live'), cOv = $('ov'), gOv = cOv.getContext('2d'), cPeak = $('peak'), gPeak = cPeak.getContext('2d');
let dpr = 1;
function sizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const r = viewer.getBoundingClientRect();
  for (const c of [cOv, cPeak]) {
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
  }
  if (mode === 'still') applyStillView();
  draw();
}
new ResizeObserver(sizeCanvas).observe(viewer);
// The frame's rectangle on the canvas (object-fit: contain of a 4:3 picture).
function frameRect() {
  const W = cOv.width, H = cOv.height, ar = still ? still.w / still.h : 4 / 3;
  let w = W, h = W / ar;
  if (h > H) (h = H), (w = H * ar);
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
// Visible region in shape coordinates: live = the sensor crop; still = the client zoom.
function visible() {
  if (mode === 'live') {
    const c = S?.crop || [0, 0, 1, 1];
    return { x: c[0], y: c[1], w: c[2], h: c[3] };
  }
  return { x: stillView.x, y: stillView.y, w: stillView.z, h: stillView.z };
}
function toCanvas(p) {
  const r = frameRect(), v = visible();
  return [r.x + ((p[0] - v.x) / v.w) * r.w, r.y + ((p[1] - v.y) / v.h) * r.h];
}
function fromCanvas(cx, cy) {
  const r = frameRect(), v = visible();
  return [v.x + ((cx - r.x) / r.w) * v.w, v.y + ((cy - r.y) / r.h) * v.h];
}
function evCanvas(e) {
  const b = cOv.getBoundingClientRect();
  return [(e.clientX - b.left) * dpr, (e.clientY - b.top) * dpr];
}
// Physical scale of one shape unit: [x, y] in µm (calibrated) or px (not), plus the unit name.
function scale() {
  if (mode === 'live') {
    if (cal) return { sx: cal.umPerPx * SENSOR[0], sy: cal.umPerPx * SENSOR[1], um: true };
    return { sx: SENSOR[0], sy: SENSOR[1], um: false };
  }
  if (still.umPerPx) return { sx: still.umPerPx * still.w, sy: still.umPerPx * still.h, um: true };
  return { sx: still.w, sy: still.h, um: false };
}
// sensor pixels per shape unit (for calibrating)
function sensorPx() {
  if (mode === 'live') return [SENSOR[0], SENSOR[1]];
  return [still.crop?.[2] || still.w, still.crop?.[3] || still.h];
}
function fmtLen(v, um) {
  if (!um) return `${v.toFixed(v < 100 ? 1 : 0)} px`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 2 : 3)} mm`;
  return `${v.toFixed(v < 10 ? 2 : 1)} µm`;
}
function fmtArea(v, um) {
  if (!um) return `${Math.round(v)} px²`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(3)} mm²`;
  return `${v.toFixed(0)} µm²`;
}

// ---- measurements -----------------------------------------------------------------------------------------------------
function measure(s) {
  const k = scale(), P = (p) => [p[0] * k.sx, p[1] * k.sy];
  const d = (a, b) => Math.hypot((b[0] - a[0]) * k.sx, (b[1] - a[1]) * k.sy);
  const p = s.pts;
  switch (s.type) {
    case 'line': return fmtLen(d(p[0], p[1]), k.um);
    case 'poly': { let L = 0; for (let i = 1; i < p.length; i++) L += d(p[i - 1], p[i]); return `${fmtLen(L, k.um)} (${p.length - 1} segments)`; }
    case 'rect': { const w = Math.abs(p[1][0] - p[0][0]) * k.sx, h = Math.abs(p[1][1] - p[0][1]) * k.sy; return `${fmtLen(w, k.um)} × ${fmtLen(h, k.um)} · ${fmtArea(w * h, k.um)}`; }
    case 'circle': { const r = d(p[0], p[1]); return `⌀ ${fmtLen(2 * r, k.um)} · ${fmtArea(Math.PI * r * r, k.um)}`; }
    case 'angle': {
      if (p.length < 3) return '…';
      const a = P(p[0]), b = P(p[1]), c = P(p[2]);
      let ang = Math.abs(Math.atan2(a[1] - b[1], a[0] - b[0]) - Math.atan2(c[1] - b[1], c[0] - b[0])) * 180 / Math.PI;
      if (ang > 180) ang = 360 - ang;
      return `${ang.toFixed(1)}°`;
    }
    case 'count': return `${p.length}`;
    case 'text': return s.text || '';
  }
  return '';
}
const NAMES = { line: 'Length', poly: 'Path', rect: 'Rectangle', circle: 'Circle', angle: 'Angle', count: 'Count', text: 'Label' };
function saveShapes() {
  if (mode === 'live') store.set('liveShapes', liveShapes);
  renderMeas();
  draw();
}
function renderMeas() {
  $('measCount').textContent = shapes.length ? `${shapes.length}` : '';
  $('measList').innerHTML = shapes.length
    ? shapes.map((s, i) => `<div class="m"><i>${i + 1}</i><span>${NAMES[s.type]} <b>${esc(measure(s))}</b></span><button data-del="${i}">✕</button></div>`).join('')
    : `<div class="muted small">Pick a tool (📏 ▭ ◯ ∠ ✚) and draw on the picture.${cal || still?.umPerPx ? '' : ' Calibrate first for micrometres.'}</div>`;
}
$('measList').onclick = (e) => {
  const i = e.target.dataset.del;
  if (i == null) return;
  shapes.splice(Number(i), 1);
  if (still) persistStill();
  saveShapes();
};
$('clearShapes').onclick = () => {
  shapes.length = 0;
  if (still) persistStill();
  saveShapes();
};
$('measCsv').onclick = () => {
  const rows = [['#', 'type', 'value']].concat(shapes.map((s, i) => [i + 1, NAMES[s.type], measure(s)]));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }));
  a.download = `measurements-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
};

// ---- drawing ----------------------------------------------------------------------------------------------------------
const COLORS = ['#ffca28', '#4dd0e1', '#ff7043', '#9ccc65', '#ce93d8', '#f06292'];
function niceStep(target) {
  const p = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (p * m >= target) return p * m;
  return p * 10;
}
// Draws shapes + overlays onto a 2D context; map(p) gives canvas coords; s is the line-width scale.
function render(g, map, rect, opts) {
  const { s = 1, shapesList, k, overlays = {}, roi } = opts;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // grid
  if (overlays.grid) {
    g.strokeStyle = 'rgba(255,255,255,.28)';
    g.lineWidth = 1 * s;
    const vis = opts.vis;
    let stepU, label = '';
    if (k.um) {
      const um = niceStep((vis.w * k.sx) / 10);
      stepU = um / k.sx;
      label = fmtLen(um, true);
    } else stepU = vis.w / 10;
    const stepV = (stepU * k.sx) / k.sy; // square cells
    for (let x = Math.ceil(vis.x / stepU) * stepU; x <= vis.x + vis.w; x += stepU) {
      const [cx] = map([x, 0]);
      g.beginPath(); g.moveTo(cx, rect.y); g.lineTo(cx, rect.y + rect.h); g.stroke();
    }
    for (let y = Math.ceil(vis.y / stepV) * stepV; y <= vis.y + vis.h; y += stepV) {
      const [, cy] = map([0, y]);
      g.beginPath(); g.moveTo(rect.x, cy); g.lineTo(rect.x + rect.w, cy); g.stroke();
    }
    if (label) {
      g.font = `${12 * s}px system-ui`;
      g.fillStyle = 'rgba(255,255,255,.75)';
      g.fillText(`grid ${label}`, rect.x + 8 * s, rect.y + rect.h - 8 * s);
    }
  }
  if (overlays.cross) {
    g.strokeStyle = 'rgba(255,82,82,.85)';
    g.lineWidth = 1.2 * s;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    g.beginPath(); g.moveTo(cx, rect.y); g.lineTo(cx, rect.y + rect.h); g.moveTo(rect.x, cy); g.lineTo(rect.x + rect.w, cy); g.stroke();
    g.beginPath(); g.arc(cx, cy, Math.min(rect.w, rect.h) * 0.08, 0, 2 * Math.PI); g.stroke();
  }
  if (roi) {
    g.setLineDash([6 * s, 5 * s]);
    g.strokeStyle = 'rgba(77,208,225,.7)';
    g.lineWidth = 1.2 * s;
    g.strokeRect(rect.x + roi[0] * rect.w, rect.y + roi[1] * rect.h, roi[2] * rect.w, roi[3] * rect.h);
    g.setLineDash([]);
  }
  // shapes
  g.font = `600 ${13 * s}px system-ui`;
  shapesList.forEach((sh, i) => {
    const col = sh.draft ? '#ffffff' : COLORS[i % COLORS.length];
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineWidth = 2 * s;
    const P = sh.pts.map(map);
    const label = (t, x, y) => {
      if (!t) return;
      g.font = `600 ${13 * s}px system-ui`;
      const w = g.measureText(t).width;
      g.fillStyle = 'rgba(0,0,0,.65)';
      g.fillRect(x - 3 * s, y - 14 * s, w + 6 * s, 18 * s);
      g.fillStyle = col;
      g.fillText(t, x, y);
    };
    const tag = sh.draft ? '' : `${i + 1}: `;
    switch (sh.type) {
      case 'line':
      case 'poly':
        g.beginPath();
        P.forEach((p, j) => (j ? g.lineTo(...p) : g.moveTo(...p)));
        g.stroke();
        for (const p of P) { g.beginPath(); g.arc(p[0], p[1], 3 * s, 0, 2 * Math.PI); g.fill(); }
        if (P.length > 1) label(tag + measure(sh), P[P.length - 1][0] + 8 * s, P[P.length - 1][1] - 6 * s);
        break;
      case 'rect':
        if (P.length > 1) {
          g.strokeRect(P[0][0], P[0][1], P[1][0] - P[0][0], P[1][1] - P[0][1]);
          label(tag + measure(sh), Math.min(P[0][0], P[1][0]), Math.min(P[0][1], P[1][1]) - 6 * s);
        }
        break;
      case 'circle':
        if (P.length > 1) {
          // a circle in physical units: radius from the scale, drawn as an ellipse if the axes differ
          const rx = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
          g.beginPath(); g.arc(P[0][0], P[0][1], rx, 0, 2 * Math.PI); g.stroke();
          g.beginPath(); g.arc(P[0][0], P[0][1], 2.5 * s, 0, 2 * Math.PI); g.fill();
          label(tag + measure(sh), P[0][0] + rx * 0.72, P[0][1] - rx * 0.72);
        }
        break;
      case 'angle':
        g.beginPath();
        P.forEach((p, j) => (j ? g.lineTo(...p) : g.moveTo(...p)));
        g.stroke();
        if (P.length === 3) label(tag + measure(sh), P[1][0] + 10 * s, P[1][1] + 18 * s);
        break;
      case 'count':
        P.forEach((p, j) => {
          g.beginPath(); g.arc(p[0], p[1], 7 * s, 0, 2 * Math.PI); g.stroke();
          g.font = `700 ${11 * s}px system-ui`;
          g.fillText(String(j + 1), p[0] + 9 * s, p[1] - 6 * s);
        });
        if (P.length) label(`${tag}count ${P.length}`, P[P.length - 1][0] + 12 * s, P[P.length - 1][1] + 20 * s);
        break;
      case 'text':
        if (P.length) label(sh.text, P[0][0], P[0][1]);
        break;
    }
  });
  // scale bar
  if (overlays.scale && k.um) {
    const vis = opts.vis, um = niceStep((vis.w * k.sx) / 5), len = (um / k.sx / vis.w) * rect.w;
    const x1 = rect.x + rect.w - 20 * s, x0 = x1 - len, y = rect.y + rect.h - 22 * s;
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(x0 - 10 * s, y - 24 * s, len + 20 * s, 36 * s);
    g.fillStyle = '#fff';
    g.fillRect(x0, y, len, 5 * s);
    g.font = `600 ${13 * s}px system-ui`;
    const t = fmtLen(um, true), tw = g.measureText(t).width;
    g.fillText(t, x0 + len / 2 - tw / 2, y - 6 * s);
  }
}
function draw() {
  if (!S || !cOv.width) return;
  gOv.clearRect(0, 0, cOv.width, cOv.height);
  const rect = frameRect(), k = scale();
  const list = draft ? [...shapes, { ...draft, draft: true }] : shapes;
  render(gOv, toCanvas, rect, { s: dpr, shapesList: list, k, overlays: ov, vis: visible(), roi: mode === 'live' && (tool === 'roi' || showRoi) ? S.roi : null });
  if (dragRect) {
    gOv.setLineDash([5 * dpr, 4 * dpr]);
    gOv.strokeStyle = tool === 'wb' ? '#fff' : '#4dd0e1';
    gOv.lineWidth = 1.5 * dpr;
    gOv.strokeRect(dragRect[0], dragRect[1], dragRect[2] - dragRect[0], dragRect[3] - dragRect[1]);
    gOv.setLineDash([]);
  }
  const v = visible();
  $('viewInfo').textContent = mode === 'live'
    ? `${(1 / v.w).toFixed(1)}× digital${cal ? ` · field ${fmtLen(v.w * k.sx, true)} wide` : ''}`
    : `${still.w}×${still.h} · ${(1 / stillView.z).toFixed(1)}×${still.umPerPx ? ` · field ${fmtLen(v.w * k.sx, true)}` : ''}`;
  $('vbadge').textContent = mode === 'still' ? `📁 ${still.kind.toUpperCase()} · ${new Date(still.t * 1000).toLocaleString()}` : frozen ? '❄ FROZEN' : '';
}
let showRoi = false;

// ---- live stream / still display -----------------------------------------------------------------------------------
function startStream() {
  live.src = 'stream.mjpg?t=' + Date.now();
  resetImgStyle();
}
function resetImgStyle() {
  Object.assign(live.style, { width: '100%', height: '100%', left: '0', top: '0' });
}
function applyStillView() {
  const z = stillView.z;
  if (z >= 0.999) {
    resetImgStyle(); // whole picture: let object-fit do it
    return draw();
  }
  // zoomed: the img is scaled up and shifted so the visible part fills the frame (CSS pixels from the canvas ratio)
  const r = frameRect(), k = viewer.clientWidth / cOv.width;
  Object.assign(live.style, {
    width: `${(r.w * k) / z}px`, height: `${(r.h * k) / z}px`,
    left: `${r.x * k - (stillView.x / z) * r.w * k}px`, top: `${r.y * k - (stillView.y / z) * r.h * k}px`,
  });
  draw();
}
$('freeze').onclick = async () => {
  if (mode !== 'live') return;
  if (frozen) {
    frozen = false;
    $('freeze').classList.remove('on');
    startStream();
  } else {
    const b = await fetch('snapshot.jpg').then((r) => r.blob());
    live.src = URL.createObjectURL(b);
    frozen = true;
    $('freeze').classList.add('on');
  }
  draw();
};
$('zoomReset').onclick = () => {
  if (mode === 'live') setLater({ crop: [0, 0, 1, 1] });
  else (stillView = { x: 0, y: 0, z: 1 }), applyStillView();
  draw();
};
$('fullscreen').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : viewer.requestFullscreen());

// ---- tools ------------------------------------------------------------------------------------------------------------
const HINTS = {
  pan: 'Wheel to zoom, drag to move around, double-click to zoom in, right-click to zoom out',
  line: 'Drag from one end to the other', poly: 'Click each point, double-click to finish', rect: 'Drag a rectangle',
  circle: 'Drag from the centre to the edge', angle: 'Click one arm, the vertex, then the other arm', count: 'Click each thing to count; switch tool when done',
  text: 'Click where the label goes', cal: 'Draw a line along the ruler scale (or across a known distance)',
  wb: 'Drag over something white or grey', roi: 'Drag the area the focus meter should judge',
};
function setTool(t) {
  if (draft && draft.type === 'poly' && draft.pts.length > 2) shapes.push(finishDraft());
  draft = null;
  tool = t;
  for (const b of $('toolBtns').children) b.classList.toggle('on', b.dataset.tool === t);
  viewer.classList.toggle('pan', t === 'pan');
  $('hint').textContent = HINTS[t] || '';
  clearTimeout(setTool.h);
  setTool.h = setTimeout(() => ($('hint').textContent = ''), 4000);
  draw();
}
$('toolBtns').onclick = (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
};
$('wbPick').onclick = () => setTool('wb');
for (const b of document.querySelectorAll('[data-ov]')) {
  b.classList.toggle('on', !!ov[b.dataset.ov]);
  b.onclick = () => {
    ov[b.dataset.ov] = !ov[b.dataset.ov];
    b.classList.toggle('on', ov[b.dataset.ov]);
    store.set('ov', ov);
    if (b.dataset.ov === 'peak') togglePeak();
    draw();
  };
}
function finishDraft() {
  const d = { type: draft.type, pts: draft.pts.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]) };
  if (draft.text) d.text = draft.text;
  return d;
}

let drag = null, dragRect = null;
cOv.addEventListener('pointerdown', (e) => {
  cOv.setPointerCapture(e.pointerId);
  const c = evCanvas(e), p = fromCanvas(...c);
  drag = { c0: c, p0: p, moved: false, crop: S.crop.slice(), sv: { ...stillView } };
  if (tool === 'line' || tool === 'rect' || tool === 'circle' || tool === 'cal') draft = { type: tool === 'cal' ? 'line' : tool, pts: [p, p] };
  if (tool === 'wb' || tool === 'roi') dragRect = [c[0], c[1], c[0], c[1]];
});
cOv.addEventListener('pointermove', (e) => {
  const c = evCanvas(e);
  if (draft && (draft.type === 'poly' || draft.type === 'angle') && draft.pts.length) {
    draft.pts[draft.pts.length - 1] = fromCanvas(...c);
    draw();
  }
  if (!drag) return;
  if (Math.hypot(c[0] - drag.c0[0], c[1] - drag.c0[1]) > 3 * dpr) drag.moved = true;
  if (tool === 'pan' && drag.moved) {
    const r = frameRect(), dx = (c[0] - drag.c0[0]) / r.w, dy = (c[1] - drag.c0[1]) / r.h;
    if (mode === 'live') {
      const [x, y, w, h] = drag.crop;
      setLater({ crop: [clamp(x - dx * w, 0, 1 - w), clamp(y - dy * h, 0, 1 - h), w, h] });
    } else {
      stillView.x = clamp(drag.sv.x - dx * drag.sv.z, 0, 1 - drag.sv.z);
      stillView.y = clamp(drag.sv.y - dy * drag.sv.z, 0, 1 - drag.sv.z);
      applyStillView();
    }
    draw();
  } else if (draft && (tool === 'line' || tool === 'rect' || tool === 'circle' || tool === 'cal')) {
    draft.pts[1] = fromCanvas(...c);
    draw();
  } else if (dragRect) {
    dragRect[2] = c[0];
    dragRect[3] = c[1];
    draw();
  }
});
cOv.addEventListener('pointerup', (e) => {
  const c = evCanvas(e), p = fromCanvas(...c);
  const d = drag;
  drag = null;
  if (!d) return;
  if (tool === 'line' || tool === 'rect' || tool === 'circle') {
    if (d.moved) shapes.push(finishDraft());
    draft = null;
    afterEdit();
  } else if (tool === 'cal') {
    const line = draft;
    draft = null;
    if (d.moved) calibrateFrom(line.pts);
    draw();
  } else if (tool === 'poly' || tool === 'angle') {
    if (!draft) draft = { type: tool, pts: [p, p] };
    else draft.pts.push(p);
    if (tool === 'angle' && draft.pts.length > 3) {
      draft.pts.pop();
      shapes.push(finishDraft());
      draft = null;
      afterEdit();
    }
    draw();
  } else if (tool === 'count') {
    let last = shapes[shapes.length - 1];
    if (!last || last.type !== 'count' || last.done) {
      last = { type: 'count', pts: [] };
      shapes.push(last);
    }
    last.pts.push(p);
    afterEdit();
  } else if (tool === 'text') {
    const t = prompt('Label:');
    if (t) shapes.push({ type: 'text', pts: [p], text: t.slice(0, 80) });
    afterEdit();
  } else if (tool === 'wb' || tool === 'roi') {
    const r = frameRect();
    const a = [(Math.min(dragRect[0], dragRect[2]) - r.x) / r.w, (Math.min(dragRect[1], dragRect[3]) - r.y) / r.h];
    const b = [(Math.max(dragRect[0], dragRect[2]) - r.x) / r.w, (Math.max(dragRect[1], dragRect[3]) - r.y) / r.h];
    dragRect = null;
    const rect = [clamp(a[0], 0, 1), clamp(a[1], 0, 1), clamp(b[0] - a[0], 0.01, 1), clamp(b[1] - a[1], 0.01, 1)];
    if (mode !== 'live') return toast('White balance and the focus area work on the live picture', true);
    if (tool === 'wb') {
      cmd({ cmd: 'wb', rect });
      toast('Balancing…');
    } else {
      setLater({ roi: rect });
      showRoi = true;
      setTimeout(() => ((showRoi = false), draw()), 2500);
      peakFocus = 0;
    }
    setTool('pan');
  }
});
cOv.addEventListener('dblclick', (e) => {
  if (tool === 'poly' && draft) {
    draft.pts.pop();
    if (draft.pts.length > 2) draft.pts.pop(); // the double-click added one more
    if (draft.pts.length > 1) shapes.push(finishDraft());
    draft = null;
    afterEdit();
  } else if (tool === 'pan') zoomAt(evCanvas(e), 0.5);
});
// right-click zooms out (any tool), like double-click zooms in
cOv.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  zoomAt(evCanvas(e), 2);
});
const centre = () => {
  const r = frameRect();
  return [r.x + r.w / 2, r.y + r.h / 2];
};
$('zoomIn').onclick = () => zoomAt(centre(), 0.5);
$('zoomOut').onclick = () => zoomAt(centre(), 2);
cOv.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(evCanvas(e), e.deltaY < 0 ? 0.8 : 1.25);
}, { passive: false });
function zoomAt(c, f) {
  const r = frameRect(), fx = (c[0] - r.x) / r.w, fy = (c[1] - r.y) / r.h;
  if (mode === 'live') {
    const [x, y, w] = S.crop, nz = clamp(w * f, 0.04, 1);
    const px = x + fx * w, py = y + fy * w;
    setLater({ crop: [clamp(px - fx * nz, 0, 1 - nz), clamp(py - fy * nz, 0, 1 - nz), nz, nz] });
    draw();
  } else {
    const { x, y, z } = stillView, nz = clamp(z * f, 0.02, 1);
    const px = x + fx * z, py = y + fy * z;
    stillView = { x: clamp(px - fx * nz, 0, 1 - nz), y: clamp(py - fy * nz, 0, 1 - nz), z: nz };
    applyStillView();
  }
}
function afterEdit() {
  if (still) persistStill();
  saveShapes();
}
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') setTool('pan');
  if (e.key === 'Enter' && draft?.type === 'poly' && draft.pts.length > 2) (draft.pts.pop(), shapes.push(finishDraft()), (draft = null), afterEdit());
  if (e.key === 'f') $('fullscreen').click();
  if (e.key === '+' || e.key === '=') zoomAt(centre(), 0.5);
  if (e.key === '-') zoomAt(centre(), 2);
  if (e.key === '0') $('zoomReset').click();
  if (e.key === ' ') (e.preventDefault(), $('snap').click());
  if (e.key === 'z' && (e.ctrlKey || e.metaKey) && shapes.length) (shapes.pop(), afterEdit());
});

// ---- calibration --------------------------------------------------------------------------------------------------------
async function calibrateFrom(pts) {
  const [Sx, Sy] = sensorPx();
  const spx = Math.hypot((pts[1][0] - pts[0][0]) * Sx, (pts[1][1] - pts[0][1]) * Sy);
  if (spx < 30) return toast('Draw a longer line', true);
  const tickMm = Number($('tickMm').value);
  let um = null;
  // automatic: find the tick spacing along the line
  const p = mode === 'live' ? { cmd: 'autocal', pts, tickMm } : { cmd: 'autocal', pts, tickMm, id: still.id };
  const res = await request(p);
  if (res?.ok) {
    const ok = confirm(`Found ${res.ticks.toFixed(1)} ticks of ${tickMm} mm along the line (period ${res.periodPx.toFixed(1)} px, confidence ${res.confidence.toFixed(1)}).\n\n= ${res.umPerPx.toFixed(4)} µm per sensor pixel.\n\nUse it? (Cancel to type the length instead)`);
    if (ok) um = res.umPerPx;
  } else if (res) toast(res.msg || 'No regular ticks found: type the length instead', true);
  if (um == null) {
    const t = prompt(`Length of the line you drew, in mm (e.g. 1, 0.5, 10):`);
    const mm = parseFloat(String(t || '').replace(',', '.'));
    if (!(mm > 0)) return;
    um = (mm * 1000) / spx;
  }
  const name = prompt('Name this calibration (e.g. the zoom ring setting: "Zoom 2x"):', cal?.name || 'Zoom 1x');
  if (!name) return;
  cmd({ cmd: 'calSave', name, umPerPx: um });
  toast(`Calibrated: ${(um * 1000).toFixed(1)} nm per sensor pixel`);
  setTool('pan');
}
let reqId = 0;
const pending = new Map();
function request(o) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    cmd({ ...o, reqId: id });
    setTimeout(() => pending.has(id) && (pending.delete(id), resolve(null)), 15000);
  });
}
const _onMsg = onMsg;
onMsg = function (m) { // eslint-disable-line no-func-assign
  if (m.type === 'reply' && pending.has(m.reqId)) {
    pending.get(m.reqId)(m);
    pending.delete(m.reqId);
    return;
  }
  _onMsg(m);
};
$('calSel').onchange = (e) => cmd({ cmd: 'calSelect', id: e.target.value || null });
$('calDel').onclick = () => cal && confirm(`Delete calibration "${cal.name}"?`) && cmd({ cmd: 'calDelete', id: cal.id });

// ---- focus peaking (client side, from the displayed picture) -----------------------------------------------------------
let peakTimer = null;
const off = document.createElement('canvas'), gOff = off.getContext('2d', { willReadFrequently: true });
function togglePeak() {
  clearInterval(peakTimer);
  gPeak.clearRect(0, 0, cPeak.width, cPeak.height);
  if (ov.peak) peakTimer = setInterval(peakFrame, 160);
}
function peakFrame() {
  if (!live.naturalWidth) return;
  const W = 400, H = 300;
  off.width = W;
  off.height = H;
  try {
    if (mode === 'live') gOff.drawImage(live, 0, 0, W, H);
    else gOff.drawImage(live, stillView.x * live.naturalWidth, stillView.y * live.naturalHeight, stillView.z * live.naturalWidth, stillView.z * live.naturalHeight, 0, 0, W, H);
  } catch (e) {
    return;
  }
  const d = gOff.getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
  const mag = new Float32Array(W * H);
  let max = 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = gray[i + 1] - gray[i - 1] + 0.5 * (gray[i - W + 1] - gray[i - W - 1] + gray[i + W + 1] - gray[i + W - 1]);
      const gy = gray[i + W] - gray[i - W] + 0.5 * (gray[i + W - 1] - gray[i - W - 1] + gray[i + W + 1] - gray[i - W + 1]);
      const m = gx * gx + gy * gy;
      mag[i] = m;
      if (m > max) max = m;
    }
  const thr = max * 0.18;
  const img = gOff.createImageData(W, H), o = img.data;
  for (let i = 0; i < W * H; i++)
    if (mag[i] > thr) (o[i * 4] = 255), (o[i * 4 + 1] = 40), (o[i * 4 + 2] = 200), (o[i * 4 + 3] = 255);
  gOff.putImageData(img, 0, 0);
  gPeak.clearRect(0, 0, cPeak.width, cPeak.height);
  const r = frameRect();
  gPeak.imageSmoothingEnabled = false;
  gPeak.drawImage(off, r.x, r.y, r.w, r.h);
}

// ---- stats: focus meter, histogram, header ---------------------------------------------------------------------------
let peakFocus = 0, focusHist = [], peakT = 0;
const cSpark = $('fSpark'), gSpark = cSpark.getContext('2d'), cHist = $('hist'), gHist = cHist.getContext('2d');
$('fFill').parentElement.onclick = () => (peakFocus = 0);
function renderStats() {
  const s = stats;
  const exp = s.exposure ? (s.exposure >= 1e6 ? `${(s.exposure / 1e6).toFixed(1)} s` : `1/${Math.round(1e6 / s.exposure)} s`) : '–';
  $('hExp').textContent = `${exp} · ×${s.gain}${s.temp != null ? ` · ${s.temp}°C` : ''}`;
  $('hWb').textContent = `${s.ct ?? '–'} K · R${s.gains?.[0]} B${s.gains?.[1]}`;
  $('expInfo').textContent = `Now: ${exp}, gain ×${s.gain} (digital ×${s.dgain}), ${s.lux} lux${s.clip > 0.5 ? ` · ${s.clip}% blown out` : ''}${s.dark > 5 ? ` · ${s.dark}% black` : ''}`;
  // focus
  const f = s.focus || 0;
  if (f > peakFocus || Date.now() - peakT > 20000) (peakFocus = Math.max(f, peakFocus * (Date.now() - peakT > 20000 ? 0 : 1))), (peakT = Date.now());
  const top = Math.max(peakFocus * 1.15, 10), pos = (v) => (Math.log10(1 + v) / Math.log10(1 + top)) * 100;
  $('fVal').textContent = f.toFixed(0);
  $('fPeak').textContent = `peak ${peakFocus.toFixed(0)}${f >= peakFocus * 0.97 ? ' ✓ sharpest' : ''}`;
  $('fFill').style.width = `${pos(f)}%`;
  $('fPeakMark').style.left = `${pos(peakFocus)}%`;
  focusHist.push(f);
  focusHist = focusHist.slice(-90);
  const w = (cSpark.width = cSpark.clientWidth * dpr), h = (cSpark.height = cSpark.clientHeight * dpr);
  gSpark.clearRect(0, 0, w, h);
  gSpark.strokeStyle = '#4dd0e1';
  gSpark.lineWidth = 1.5 * dpr;
  gSpark.beginPath();
  const mx = Math.max(...focusHist, 1);
  focusHist.forEach((v, i) => {
    const x = (i / 89) * w, y = h - (v / mx) * (h - 3) - 1;
    i ? gSpark.lineTo(x, y) : gSpark.moveTo(x, y);
  });
  gSpark.stroke();
  if (s.hist) {
    const W = (cHist.width = cHist.clientWidth * dpr), H = (cHist.height = cHist.clientHeight * dpr), m = Math.max(...s.hist);
    gHist.clearRect(0, 0, W, H);
    s.hist.forEach((v, i) => {
      gHist.fillStyle = i >= 62 ? '#ef5350' : i <= 1 ? '#5c6bc0' : '#90a4ae';
      const bh = (Math.sqrt(v / m) || 0) * (H - 2);
      gHist.fillRect((i / 64) * W, H - bh, W / 64 - 1, bh);
    });
  }
  // keep the sliders showing what auto is doing
  if (S?.ae && document.activeElement !== $('exposure')) setExpSlider(s.exposure), ($('gain').value = s.gain), ($('gainV').textContent = `×${s.gain}`);
  if (S?.awb && s.gains) ($('gR').value = s.gains[0]), ($('gB').value = s.gains[1]), ($('gRV').textContent = s.gains[0]), ($('gBV').textContent = s.gains[1]);
  $('recInfo').textContent = s.video ? `● ${s.videoSec.toFixed(0)} s` : '';
  for (const id of ['rec', 'rec2']) {
    $(id).classList.toggle('rec', !!s.video);
    $(id).textContent = s.video ? `■ Stop ${s.videoSec.toFixed(0)} s` : id === 'rec' ? '⏺ Video' : '⏺ Record video';
  }
}

// ---- camera controls ------------------------------------------------------------------------------------------------------
const EXP_MIN = 100, EXP_MAX = 2e6;
const expFromSlider = (v) => Math.round(EXP_MIN * (EXP_MAX / EXP_MIN) ** (v / 1000));
const setExpSlider = (us) => {
  if (!us) return;
  $('exposure').value = String(Math.round((Math.log(us / EXP_MIN) / Math.log(EXP_MAX / EXP_MIN)) * 1000));
  $('exposureV').textContent = us >= 1e6 ? `${(us / 1e6).toFixed(1)} s` : `1/${Math.round(1e6 / us)}`;
};
function renderControls() {
  if (!S) return;
  const act = document.activeElement;
  const setV = (id, v, txt) => {
    if (act !== $(id)) $(id).value = v;
    if ($(id + 'V')) $(id + 'V').textContent = txt ?? v;
  };
  $('ae').checked = S.ae;
  $('metering').value = String(S.metering);
  setV('ev', S.ev, `${S.ev > 0 ? '+' : ''}${S.ev} EV`);
  if (!S.ae) setExpSlider(S.exposure), setV('gain', S.gain, `×${S.gain}`);
  $('exposure').disabled = $('gain').disabled = S.ae;
  $('ev').disabled = !S.ae;
  $('awb').checked = S.awb;
  $('awbMode').value = String(S.awbMode);
  $('awbMode').disabled = !S.awb;
  if (!S.awb) setV('gR', S.gains[0]), setV('gB', S.gains[1]);
  $('gR').disabled = $('gB').disabled = S.awb;
  for (const k of ['brightness', 'contrast', 'saturation', 'sharpness']) setV(k, S[k], Number(S[k]).toFixed(2));
  $('denoise').value = String(S.denoise);
  $('hflip').checked = S.hflip;
  $('vflip').checked = S.vflip;
  $('quality').value = S.quality;
  $('fps').value = String(S.fps);
  $('presetSel').innerHTML = presets.length ? presets.map((p) => `<option>${esc(p.name)}</option>`).join('') : '<option value="">(no presets)</option>';
  $('calSel').innerHTML = `<option value="">Not calibrated (pixels)</option>` + cals.map((c) => `<option value="${c.id}" ${cal?.id === c.id ? 'selected' : ''}>${esc(c.name)} · ${(c.umPerPx * 1000).toFixed(1)} nm/px</option>`).join('');
  $('hCal').textContent = cal ? `⚖ ${cal.name}` : '⚖ not calibrated';
}
$('ae').onchange = (e) => {
  const o = { ae: e.target.checked };
  if (!e.target.checked && stats.exposure) Object.assign(o, { exposure: stats.exposure, gain: stats.gain }); // start manual from where auto was
  setLater(o);
  renderControls();
};
$('metering').onchange = (e) => setLater({ metering: Number(e.target.value) });
$('ev').oninput = (e) => (setLater({ ev: Number(e.target.value) }), renderControls());
$('exposure').oninput = (e) => {
  const us = expFromSlider(Number(e.target.value));
  setExpSlider(us);
  setLater({ exposure: us });
};
$('gain').oninput = (e) => (setLater({ gain: Number(e.target.value) }), ($('gainV').textContent = `×${e.target.value}`));
$('awb').onchange = (e) => {
  const o = { awb: e.target.checked };
  if (!e.target.checked && stats.gains) o.gains = stats.gains;
  setLater(o);
  renderControls();
};
$('awbMode').onchange = (e) => setLater({ awbMode: Number(e.target.value) });
$('gR').oninput = () => (setLater({ gains: [Number($('gR').value), Number($('gB').value)] }), ($('gRV').textContent = $('gR').value));
$('gB').oninput = () => (setLater({ gains: [Number($('gR').value), Number($('gB').value)] }), ($('gBV').textContent = $('gB').value));
for (const k of ['brightness', 'contrast', 'saturation', 'sharpness']) $(k).oninput = (e) => (setLater({ [k]: Number(e.target.value) }), ($(k + 'V').textContent = Number(e.target.value).toFixed(2)));
$('denoise').onchange = (e) => setLater({ denoise: Number(e.target.value) });
for (const k of ['hflip', 'vflip']) $(k).onchange = (e) => setLater({ [k]: e.target.checked });
$('quality').onchange = (e) => setLater({ quality: e.target.value });
$('fps').onchange = (e) => setLater({ fps: Number(e.target.value) });
$('reset').onclick = () => confirm('Reset the camera settings to defaults?') && cmd({ cmd: 'reset' });
$('presetSave').onclick = () => {
  const n = prompt('Preset name (e.g. "PCB, ring light"):');
  if (n) cmd({ cmd: 'presetSave', name: n });
};
$('presetLoad').onclick = () => $('presetSel').value && cmd({ cmd: 'presetLoad', name: $('presetSel').value });
$('presetDel').onclick = () => $('presetSel').value && confirm(`Delete preset "${$('presetSel').value}"?`) && cmd({ cmd: 'presetDelete', name: $('presetSel').value });

// ---- capture ----------------------------------------------------------------------------------------------------------------
const snap = () => cmd({ cmd: 'capture' });
const full = () => {
  cmd({ cmd: 'capture', full: true, dng: $('dng').checked });
  toast('Capturing 12 MP… (live view pauses a moment)');
};
$('snap').onclick = $('snap2').onclick = snap;
$('full').onclick = $('full2').onclick = full;
const rec = () => cmd({ cmd: stats.video ? 'videoStop' : 'videoStart' });
$('rec').onclick = $('rec2').onclick = rec;
$('tlGo').onclick = () => cmd(jobs.timelapse ? { cmd: 'tlStop' } : { cmd: 'tlStart', interval: Number($('tlInt').value), count: Number($('tlCount').value), full: $('tlFull').checked });
$('stackGo').onclick = () => cmd({ cmd: 'stackStart' });
$('stackFuse').onclick = () => cmd({ cmd: 'stackFinish' });
$('stackCancel').onclick = () => cmd({ cmd: 'stackCancel' });
$('measSnap').onclick = async () => {
  if (mode !== 'live') return saveAnnotated(still);
  toast('Capturing 12 MP with the measurements…');
  const res = await request({ cmd: 'capture', full: true, dng: false });
  const meta = res?.image;
  if (!meta) return;
  // live shapes (sensor-normalised) into this picture's coordinates
  const cx = meta.crop[0] / SENSOR[0], cy = meta.crop[1] / SENSOR[1], cw = meta.crop[2] / SENSOR[0], ch = meta.crop[3] / SENSOR[1];
  meta.measurements = liveShapes.map((s) => ({ ...s, pts: s.pts.map((p) => [(p[0] - cx) / cw, (p[1] - cy) / ch]) }));
  cmd({ cmd: 'imgUpdate', id: meta.id, measurements: meta.measurements });
  await saveAnnotated(meta);
};
// Render a picture with its measurements at full resolution and store it as "<id>-annotated.jpg".
async function saveAnnotated(meta) {
  const img = new Image();
  img.src = `images/${meta.file}?t=${Date.now()}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const rect = { x: 0, y: 0, w: c.width, h: c.height }, s = c.width / 1000;
  const k = meta.umPerPx ? { sx: meta.umPerPx * meta.w, sy: meta.umPerPx * meta.h, um: true } : { sx: meta.w, sy: meta.h, um: false };
  const saveMode = mode, saveStill = still;
  mode = 'still';
  still = meta; // measure() reads the scale from the current picture
  render(g, (p) => [p[0] * c.width, p[1] * c.height], rect, { s, shapesList: meta.measurements || [], k, overlays: { scale: true }, vis: { x: 0, y: 0, w: 1, h: 1 } });
  mode = saveMode;
  still = saveStill;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  await fetch(`api/images/${meta.id}/annotated`, { method: 'POST', body: blob });
  toast('Saved the picture with its measurements (Gallery)');
}

function onJob(m) {
  if (m.job === 'stack') {
    $('hJob').hidden = m.state === 'idle' || m.state === 'done' || m.state === 'error';
    if (m.state === 'capturing') {
      $('stackInfo').textContent = `${m.frames} frames kept`;
      $('hJob').textContent = `⧉ stack ${m.frames}`;
      $('stackProg').style.width = `${(m.frames / m.max) * 100}%`;
    } else if (m.state === 'processing') {
      $('stackInfo').textContent = `Fusing ${m.i} / ${m.n}…`;
      $('hJob').textContent = `⧉ fusing ${m.i}/${m.n}`;
      $('stackProg').style.width = `${(m.i / m.n) * 100}%`;
    } else if (m.state === 'done') {
      $('stackInfo').textContent = `Done: ${m.image.frames} frames in ${m.image.took} s`;
      $('stackProg').style.width = '0';
      toast('Focus stack ready (opened from the gallery)');
      openImage(m.image);
    } else {
      $('stackInfo').textContent = m.msg || '';
      $('stackProg').style.width = '0';
    }
  } else if (m.job === 'timelapse') {
    jobs.timelapse = m.state === 'running';
    $('tlInfo').textContent = m.state === 'running' ? `${m.n}${m.count ? ' / ' + m.count : ''} frames` : m.state === 'encoding' ? `Making the video from ${m.n} frames…` : m.state === 'done' ? `Done: ${m.n} frames` : m.msg || '';
    $('hJob').hidden = m.state !== 'running' && m.state !== 'encoding';
    $('hJob').textContent = `⏱ time-lapse ${m.n}`;
    renderJobs();
  }
}
function renderJobs() {
  $('tlGo').textContent = jobs.timelapse ? '■ Stop time-lapse' : '▶ Start time-lapse';
  $('tlGo').classList.toggle('rec', !!jobs.timelapse);
  const cap = jobs.stack === 'capturing';
  $('stackGo').disabled = cap || jobs.stack === 'processing';
  $('stackFuse').disabled = !cap;
}

// ---- gallery ----------------------------------------------------------------------------------------------------------------
async function loadImages() {
  images = await fetch('api/images').then((r) => r.json()).catch(() => images);
  renderGallery();
}
function upsertImage(m) {
  const i = images.findIndex((x) => x.id === m.id);
  if (i >= 0) images[i] = { ...images[i], ...m };
  else images.unshift(m);
  if (still?.id === m.id) (still = { ...still, ...m }), renderDetail();
  renderGallery();
}
$('galKind').onchange = renderGallery;
function renderGallery() {
  const k = $('galKind').value, list = images.filter((i) => !k || i.kind === k);
  $('galInfo').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
  $('gallery').innerHTML = list.map((i) => `<div class="g${still?.id === i.id ? ' cur' : ''}" data-id="${i.id}" title="${esc(i.note || '')}"><img loading="lazy" src="thumbs/${i.id}.jpg"><span>${i.kind}${i.kind === 'stack' ? ` ×${i.frames}` : ''}${i.measurements?.length ? ' 📏' : ''}</span></div>`).join('') || '<div class="muted">Nothing yet: press 📷 Snap.</div>';
}
$('gallery').onclick = (e) => {
  const g = e.target.closest('[data-id]');
  if (g) openImage(images.find((i) => i.id === g.dataset.id));
};
function openImage(meta) {
  if (!meta) return;
  setTab('gal');
  if (meta.kind === 'video' || meta.kind === 'timelapse') {
    still = null;
    backToLive();
    showDetail(meta);
    return;
  }
  mode = 'still';
  still = { ...meta, measurements: (meta.measurements || []).map((s) => ({ ...s })) };
  shapes = still.measurements;
  stillView = { x: 0, y: 0, z: 1 };
  live.src = `images/${meta.file}`;
  live.onload = () => (applyStillView(), (live.onload = null));
  showDetail(still);
  renderMeas();
  renderGallery();
  draw();
}
function backToLive() {
  mode = 'live';
  still = null;
  shapes = liveShapes;
  frozen = false;
  $('freeze').classList.remove('on');
  startStream();
  $('galDetail').hidden = true;
  renderMeas();
  renderGallery();
  draw();
}
let detailMeta = null;
function showDetail(m) {
  detailMeta = m;
  renderDetail();
}
function renderDetail() {
  const m = still || detailMeta;
  if (!m) return;
  const d = $('galDetail');
  d.hidden = false;
  const kv = [['Taken', new Date(m.t * 1000).toLocaleString()], ['Kind', m.kind + (m.frames ? `, ${m.frames} frames` : '') + (m.took ? `, fused in ${m.took} s` : '')],
    ['Size', `${m.w}×${m.h}`], m.exposure ? ['Exposure', `1/${Math.round(1e6 / m.exposure)} s, gain ×${m.gain}`] : null,
    ['Scale', m.umPerPx ? `${m.calibration} · ${(m.umPerPx).toFixed(3)} µm/px · field ${fmtLen(m.umPerPx * m.w, true)}` : 'not calibrated'],
    m.dur ? ['Length', `${m.dur} s`] : null].filter(Boolean);
  d.innerHTML = `${m.kind === 'video' || m.kind === 'timelapse' ? `<video controls src="images/${m.file}"></video>` : ''}
    <div class="kv">${kv.map(([a, b]) => `<span>${a}</span><b>${esc(b)}</b>`).join('')}</div>
    <textarea id="note" placeholder="Notes about this picture…">${esc(m.note || '')}</textarea>
    <div class="row" style="margin-top:6px">
      ${mode === 'still' ? '<button id="back" class="pri">◀ Live</button>' : ''}
      <a class="btn" href="images/${m.file}" download>⬇ ${m.kind === 'video' || m.kind === 'timelapse' ? 'Video' : 'Picture'}</a>
      ${m.annotated ? `<a class="btn" href="images/${m.id}-annotated.jpg" download>⬇ With measurements</a>` : ''}
      ${m.dng ? `<a class="btn" href="images/${m.dng}" download>⬇ Raw DNG</a>` : ''}
      ${m.depth ? `<a class="btn" href="images/${m.depth}" target="_blank">Depth map</a>` : ''}
      ${mode === 'still' ? '<button id="saveAnn">💾 Save measurements</button>' : ''}
      <button id="delImg">🗑 Delete</button>
    </div>`;
  $('note').onchange = (e) => cmd({ cmd: 'imgUpdate', id: m.id, note: e.target.value });
  if ($('back')) $('back').onclick = backToLive;
  if ($('saveAnn')) $('saveAnn').onclick = () => (persistStill(), saveAnnotated(still));
  $('delImg').onclick = () => confirm('Delete this item?') && cmd({ cmd: 'imgDelete', id: m.id });
}
function persistStill() {
  if (still) cmd({ cmd: 'imgUpdate', id: still.id, measurements: still.measurements });
}

// ---- tabs ---------------------------------------------------------------------------------------------------------------------
function setTab(t) {
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === t);
  for (const d of document.querySelectorAll('.tab')) d.classList.toggle('on', d.dataset.tab === t);
  store.set('tab', t);
}
$('tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) setTab(b.dataset.tab);
};
setTab(store.get('tab', 'cam'));
setTool('pan');
togglePeak();
renderMeas();
connect();
