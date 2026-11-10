// The piano roll: notes over time, a velocity lane and a sustain-pedal lane, on a canvas.
//
// Two canvases lie on top of each other. The lower one holds the grid, the notes and the
// lanes and is painted again only after an edit, a scroll or a zoom, and then only the notes
// in view. The upper one holds what moves on its own: the playhead, the cursor and the
// selection frame; of those only the strip that changed is painted.
//
// The roll edits the song it is given and reports through `on`:
//   before()        something is about to change (the app keeps an undo step)
//   change()        notes, pedal or loop changed
//   preview(m, v)   a note should be heard (key, velocity 1..127)
//   cursor(tick)    the cursor moved
//   hover(tick)     the pointer is over this time (null: it left)
//   loop(region)    the loop region was set ([start, end] or null)

import * as S from './song.js';

const KEYW = 44, RULER = 22, VEL = 62, PED = 26, ROW = 12, EDGE = 6;
const ROWS = S.HI - S.LO + 1;

export function createRoll(root, on = {}) {
  const base = document.createElement('canvas'), over = document.createElement('canvas');
  base.className = 'rollbase'; over.className = 'rollover';
  root.append(base, over);
  const g = base.getContext('2d'), og = over.getContext('2d');

  let song = S.newSong();
  let W = 0, H = 0, dpr = 1;
  let ppt = 0.1;              // pixels per tick
  let sx = 0, sy = 0;         // scroll: ticks at the left edge, pixels at the top
  let dirty = true, odirty = true, colors = null;
  let cursor = 0, playhead = -1, marquee = null, lastOver = [];
  let lastLen = S.PPQ, lastVel = 80, maxDur = 0;
  const sel = new Set();
  let clip = null, fit = false;
  let drawMs = 0;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const palette = () => colors || (colors = {
    bg: css('--bg'), bg2: css('--bg2'), card: css('--card'), card2: css('--card2'), line: css('--line'),
    ink: css('--ink'), dim: css('--dim'), accent: css('--accent'), green: css('--green'), string: css('--string'),
  });

  // ---- geometry ----
  const gridH = () => H - RULER - VEL - PED;
  const tx = (t) => KEYW + (t - sx) * ppt;
  const xt = (x) => sx + (x - KEYW) / ppt;
  const my = (m) => RULER + (S.HI - m) * ROW - sy;
  const ym = (y) => S.HI - Math.floor((y - RULER + sy) / ROW);
  const snapTicks = () => S.gridTicks(song);
  const snap = (t, free) => (free ? Math.round(t) : Math.round(t / snapTicks()) * snapTicks());
  const snapDown = (t, free) => (free ? Math.round(t) : Math.floor(t / snapTicks()) * snapTicks());
  const viewTicks = () => S.songTicks(song) + 4 * S.barTicks(song);

  function clampScroll() {
    const span = (W - KEYW) / ppt;
    sx = Math.max(0, Math.min(sx, Math.max(0, viewTicks() - span)));
    sy = Math.max(0, Math.min(sy, Math.max(0, ROWS * ROW - gridH())));
  }
  function measure() { maxDur = 0; for (const n of song.notes) if (n.d > maxDur) maxDur = n.d; }
  // index of the first note that can reach into the view
  function firstVisible(t) {
    const from = t - maxDur;
    let lo = 0, hi = song.notes.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (song.notes[mid].t < from) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = root.clientWidth; H = root.clientHeight;
    for (const c of [base, over]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; }
    clampScroll();
    dirty = odirty = true; lastOver = [];
  }

  // ---- the lower canvas ----
  function paint() {
    const t0 = performance.now();
    const c = palette(), gh = gridH(), bar = S.barTicks(song), beat = S.PPQ, step = snapTicks();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = c.bg; g.fillRect(0, 0, W, H);
    const tl = xt(KEYW), tr = xt(W);

    // rows
    g.save(); g.beginPath(); g.rect(KEYW, RULER, W - KEYW, gh); g.clip();
    for (let m = S.LO; m <= S.HI; m++) {
      const y = my(m);
      if (y + ROW < RULER || y > RULER + gh) continue;
      g.fillStyle = S.isBlack(m) ? c.bg : c.bg2;
      g.fillRect(KEYW, y, W - KEYW, ROW);
      if (m % 12 === 0) { g.fillStyle = c.line; g.fillRect(KEYW, y + ROW - 1, W - KEYW, 1); }
    }
    // loop region
    if (song.loop) { g.fillStyle = 'rgba(125, 211, 168, 0.06)'; g.fillRect(tx(song.loop[0]), RULER, (song.loop[1] - song.loop[0]) * ppt, gh); }
    g.restore();

    // time lines through the grid and the lanes
    g.save(); g.beginPath(); g.rect(KEYW, RULER, W - KEYW, H - RULER); g.clip();
    const lines = (every, colour, alpha) => {
      if (every * ppt < 5) return;
      g.globalAlpha = alpha; g.fillStyle = colour;
      for (let t = Math.ceil(tl / every) * every; t <= tr; t += every) g.fillRect(Math.round(tx(t)), RULER, 1, H - RULER);
      g.globalAlpha = 1;
    };
    lines(step, c.line, 0.45); lines(beat, c.line, 0.9); lines(bar, c.string, 0.9);
    g.restore();

    // notes
    g.save(); g.beginPath(); g.rect(KEYW, RULER, W - KEYW, gh); g.clip();
    for (let i = firstVisible(tl); i < song.notes.length; i++) {
      const n = song.notes[i];
      if (n.t > tr) break;
      if (n.t + n.d < tl) continue;
      const y = my(n.m);
      if (y + ROW < RULER || y > RULER + gh) continue;
      const x = tx(n.t), w = Math.max(2, n.d * ppt - 1), on = sel.has(n);
      g.globalAlpha = 0.4 + (0.6 * n.v) / 127;
      g.fillStyle = on ? c.ink : c.accent;
      g.fillRect(x, y + 1, w, ROW - 2);
      g.globalAlpha = 1;
      if (on) { g.strokeStyle = c.accent; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 1.5, w - 1, ROW - 3); }
    }
    g.restore();

    // velocity lane: a stem for every note, at its start
    const vy = RULER + gh, py = vy + VEL;
    g.fillStyle = c.bg2; g.fillRect(KEYW, vy, W - KEYW, VEL);
    g.fillStyle = c.line; g.fillRect(0, vy, W, 1); g.fillRect(0, py, W, 1);
    g.save(); g.beginPath(); g.rect(KEYW, vy, W - KEYW, VEL); g.clip();
    for (let pass = 0; pass < 2; pass++) for (let i = firstVisible(tl); i < song.notes.length; i++) {
      const n = song.notes[i];
      if (n.t > tr) break;
      const on = sel.has(n);
      if ((pass === 1) !== on || n.t < tl - 10 / ppt) continue;
      const x = Math.round(tx(n.t)), hgt = ((VEL - 8) * n.v) / 127;
      g.fillStyle = on ? c.ink : c.accent;
      g.fillRect(x, py - hgt, 2, hgt); g.fillRect(x - 1, py - hgt - 2, 4, 3);
    }
    g.restore();

    // pedal lane
    g.fillStyle = c.bg; g.fillRect(KEYW, py + 1, W - KEYW, PED - 1);
    g.save(); g.beginPath(); g.rect(KEYW, py, W - KEYW, PED); g.clip();
    g.fillStyle = c.green; g.globalAlpha = 0.75;
    for (const [s, e] of song.pedal) if (e > tl && s < tr) g.fillRect(tx(s), py + 6, Math.max(2, (e - s) * ppt), PED - 11);
    g.globalAlpha = 1;
    g.restore();

    // ruler: bar numbers, loop region
    g.fillStyle = c.card; g.fillRect(0, 0, W, RULER);
    g.fillStyle = c.line; g.fillRect(0, RULER - 1, W, 1);
    g.save(); g.beginPath(); g.rect(KEYW, 0, W - KEYW, RULER); g.clip();
    if (song.loop) { g.fillStyle = 'rgba(125, 211, 168, 0.35)'; g.fillRect(tx(song.loop[0]), 0, (song.loop[1] - song.loop[0]) * ppt, RULER - 1); }
    g.font = '11px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    const every = Math.max(1, Math.ceil(34 / (bar * ppt)));
    for (let b = Math.floor(tl / bar); b * bar <= tr; b++) {
      if (b < 0) continue;
      const x = Math.round(tx(b * bar));
      g.fillStyle = c.string; g.fillRect(x, RULER - 7, 1, 6);
      if (b % every === 0) { g.fillStyle = c.dim; g.fillText(String(b + 1), x + 4, RULER / 2); }
    }
    g.restore();

    // key strip
    g.fillStyle = c.card; g.fillRect(0, RULER, KEYW, H - RULER);
    g.save(); g.beginPath(); g.rect(0, RULER, KEYW, gh); g.clip();
    g.font = '9px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let m = S.LO; m <= S.HI; m++) {
      const y = my(m);
      if (y + ROW < RULER || y > RULER + gh) continue;
      g.fillStyle = S.isBlack(m) ? '#15110e' : c.ink;
      g.fillRect(0, y, S.isBlack(m) ? KEYW * 0.62 : KEYW - 1, ROW - 1);
      if (m % 12 === 0) { g.fillStyle = '#6b5b4b'; g.fillText(S.noteName(m), KEYW - 4, y + ROW / 2); }
    }
    g.restore();
    g.fillStyle = c.dim; g.font = '10px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText('Velocity', 4, vy + 12); g.fillText('Pedal', 4, py + PED / 2 + 1);
    g.fillStyle = c.line; g.fillRect(KEYW - 1, 0, 1, H);
    drawMs = performance.now() - t0;
  }

  // ---- the upper canvas: only the strips that changed ----
  function paintOver() {
    og.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const r of lastOver) og.clearRect(r[0], r[1], r[2], r[3]);
    lastOver = [];
    const c = palette();
    const line = (t, colour, w) => {
      const x = Math.round(tx(t));
      if (x < KEYW || x > W) return;
      og.fillStyle = colour; og.fillRect(x, 0, w, H);
      lastOver.push([x - 1, 0, w + 2, H]);
    };
    line(cursor, c.dim, 1);
    if (playhead >= 0) line(playhead, c.green, 2);
    if (marquee) {
      const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1), w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
      og.fillStyle = 'rgba(240, 164, 93, 0.14)'; og.fillRect(x, y, w, h);
      og.strokeStyle = c.accent; og.lineWidth = 1; og.strokeRect(x + 0.5, y + 0.5, w, h);
      lastOver.push([x - 2, y - 2, w + 4, h + 4]);
    }
  }

  // show the first bars of a new song, with its notes in the middle
  function fitView() {
    fit = false;
    ppt = Math.max(0.02, Math.min(0.25, (W - KEYW) / Math.min(S.songTicks(song), 8 * S.barTicks(song))));
    sx = 0;
    let lo = 72, hi = 48;
    for (const n of song.notes) { if (n.m < lo) lo = n.m; if (n.m > hi) hi = n.m; }
    if (lo > hi) { lo = 48; hi = 72; }
    sy = (S.HI - (lo + hi) / 2) * ROW - gridH() / 2;
    clampScroll();
  }

  function draw() {
    if (!W || !H) { if (root.clientWidth && root.clientHeight) resize(); else return; }
    if (fit) fitView();
    if (dirty) { dirty = false; paint(); odirty = true; }
    if (odirty) { odirty = false; paintOver(); }
  }

  // ---- hit testing ----
  function noteAt(x, y) {
    if (x < KEYW || y < RULER || y >= RULER + gridH()) return null;
    const t = xt(x), m = ym(y);
    let hit = null;
    for (let i = firstVisible(t); i < song.notes.length; i++) {
      const n = song.notes[i];
      if (n.t > t) break;
      if (n.m === m && t < n.t + Math.max(n.d, 2 / ppt)) hit = n; // the later one lies on top
    }
    return hit;
  }
  const zone = (x, y) => (y < RULER ? 'ruler' : x < KEYW ? (y < RULER + gridH() ? 'keys' : 'none') : y < RULER + gridH() ? 'grid' : y < RULER + gridH() + VEL ? 'vel' : 'ped');

  // ---- editing ----
  let changedInDrag = false;
  const touch = () => { if (!changedInDrag) { changedInDrag = true; if (on.before) on.before(); } };
  function commit() {
    S.sortNotes(song); measure(); clampScroll();
    dirty = true;
    if (on.change) on.change();
  }
  const setCursor = (t) => { cursor = Math.max(0, t); odirty = true; if (on.cursor) on.cursor(cursor); };
  const play = (n) => { if (on.preview) on.preview(n.m, n.v); };

  let drag = null;
  const pos = (e) => { const b = over.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };

  over.addEventListener('contextmenu', (e) => e.preventDefault());
  over.addEventListener('pointerdown', (e) => {
    const { x, y } = pos(e), z = zone(x, y), erase = e.button === 2;
    if (e.button === 1) return;
    try { over.setPointerCapture(e.pointerId); } catch (err) { /* a pointer that is already gone */ }
    root.focus({ preventScroll: true });
    changedInDrag = false;
    if (z === 'ruler') {
      drag = { kind: 'ruler', x0: x, t0: snap(Math.max(0, xt(Math.max(KEYW, x))), e.altKey), moved: false };
      setCursor(drag.t0);
    } else if (z === 'keys') {
      const m = ym(y);
      if (m >= S.LO && m <= S.HI && on.preview) on.preview(m, lastVel);
    } else if (z === 'grid') {
      const n = noteAt(x, y);
      if (erase) { drag = { kind: 'erase' }; if (n) { touch(); removeNotes([n]); } return; }
      if (n) {
        if (e.shiftKey) { if (sel.has(n)) sel.delete(n); else sel.add(n); }
        else if (!sel.has(n)) { sel.clear(); sel.add(n); }
        const right = tx(n.t + n.d), resize = x > right - Math.min(EDGE, (n.d * ppt) / 3);
        drag = { kind: resize ? 'size' : 'move', x0: x, y0: y, n, orig: [...sel].map((s) => ({ n: s, t: s.t, d: s.d, m: s.m })), m: n.m };
        lastLen = n.d; lastVel = n.v;
        play(n);
        dirty = true;
      } else if (e.shiftKey) {
        drag = { kind: 'marquee', keep: new Set(sel) };
        marquee = { x0: x, y0: y, x1: x, y1: y }; odirty = true;
      } else {
        const m = ym(y);
        if (m < S.LO || m > S.HI) return;
        touch();
        const note = { t: snapDown(xt(x), e.altKey), d: lastLen, m, v: lastVel };
        song.notes.push(note);
        sel.clear(); sel.add(note);
        setCursor(note.t);
        drag = { kind: 'size', x0: x, y0: y, n: note, orig: [{ n: note, t: note.t, d: note.d, m: note.m }], fresh: true, m };
        play(note);
        commit();
      }
    } else if (z === 'vel') {
      drag = { kind: 'vel', x: x };
      setVelocity(x, x, y);
    } else if (z === 'ped') {
      drag = { kind: 'ped', t0: xt(x), down: !(erase || e.shiftKey), orig: song.pedal.map((p) => [...p]) };
      setPedalDrag(xt(x), e.altKey);
    }
  });

  function removeNotes(list) {
    const gone = new Set(list);
    song.notes = song.notes.filter((n) => !gone.has(n));
    for (const n of list) sel.delete(n);
    commit();
  }

  // set the velocity of the notes whose stems lie between two pointer positions
  function setVelocity(xa, xb, y) {
    const py = RULER + gridH() + VEL, v = Math.max(1, Math.min(127, Math.round(((py - y) / (VEL - 8)) * 127)));
    const a = xt(Math.min(xa, xb) - 4), b = xt(Math.max(xa, xb) + 4);
    let hit = [];
    for (let i = firstVisible(a); i < song.notes.length; i++) { const n = song.notes[i]; if (n.t > b) break; if (n.t >= a) hit.push(n); }
    // with a selection among them, only the selected notes change
    if (hit.some((n) => sel.has(n))) hit = hit.filter((n) => sel.has(n));
    if (!hit.length) return;
    touch();
    for (const n of hit) n.v = v;
    lastVel = v;
    dirty = true;
    if (on.change) on.change();
  }

  function setPedalDrag(t, free) {
    touch();
    song.pedal = drag.orig.map((p) => [...p]);
    const a = Math.min(drag.t0, t), b = Math.max(drag.t0, t);
    S.setPedal(song, Math.max(0, snapDown(a, free)), free ? Math.round(b) + 1 : (Math.floor(b / snapTicks()) + 1) * snapTicks(), drag.down);
    clampScroll();
    dirty = true;
    if (on.change) on.change();
  }

  over.addEventListener('pointermove', (e) => {
    const { x, y } = pos(e);
    if (!drag) {
      const z = zone(x, y), n = z === 'grid' ? noteAt(x, y) : null;
      over.style.cursor = n ? (x > tx(n.t + n.d) - Math.min(EDGE, (n.d * ppt) / 3) ? 'ew-resize' : 'move') : z === 'ruler' ? 'col-resize' : 'default';
      if (on.hover) on.hover(x >= KEYW ? Math.max(0, xt(x)) : null);
      return;
    }
    if (drag.kind === 'move') {
      const free = e.altKey;
      let dt = snap((x - drag.x0) / ppt, free), dm = Math.round((drag.y0 - y) / ROW);
      for (const o of drag.orig) { dt = Math.max(dt, -o.t); dm = Math.max(S.LO - o.m, Math.min(S.HI - o.m, dm)); }
      if (drag.orig.every((o) => o.n.t === o.t + dt && o.n.m === o.m + dm)) return;
      touch();
      for (const o of drag.orig) { o.n.t = o.t + dt; o.n.m = o.m + dm; }
      if (drag.n.m !== drag.m) { drag.m = drag.n.m; play(drag.n); }
      dirty = true;
    } else if (drag.kind === 'size') {
      const o0 = drag.orig.find((o) => o.n === drag.n), min = Math.min(snapTicks(), 60);
      const end = e.altKey ? Math.round(xt(x)) : Math.ceil(xt(x) / snapTicks()) * snapTicks();
      const dd = Math.max(end, o0.t + min) - (o0.t + o0.d);
      if (drag.fresh && Math.abs(x - drag.x0) < 4) return;
      if (drag.n.d === o0.d + dd) return;
      touch();
      for (const o of drag.orig) o.n.d = Math.max(min, o.d + dd);
      lastLen = drag.n.d;
      dirty = true;
    } else if (drag.kind === 'erase') {
      const n = noteAt(x, y);
      if (n) { touch(); removeNotes([n]); }
    } else if (drag.kind === 'marquee') {
      marquee.x1 = x; marquee.y1 = y;
      const ta = xt(Math.min(marquee.x0, x)), tb = xt(Math.max(marquee.x0, x)), ma = ym(Math.max(marquee.y0, y)), mb = ym(Math.min(marquee.y0, y));
      sel.clear();
      for (const n of drag.keep) sel.add(n);
      for (const n of song.notes) if (n.t < tb && n.t + n.d > ta && n.m >= ma && n.m <= mb) sel.add(n);
      dirty = true;
    } else if (drag.kind === 'vel') {
      setVelocity(drag.x, x, y); drag.x = x;
    } else if (drag.kind === 'ped') {
      setPedalDrag(xt(x), e.altKey);
    } else if (drag.kind === 'ruler') {
      if (Math.abs(x - drag.x0) < 4 && !drag.moved) return;
      drag.moved = true;
      const t = snap(Math.max(0, xt(Math.max(KEYW, x))), e.altKey);
      const region = t === drag.t0 ? null : [Math.min(t, drag.t0), Math.max(t, drag.t0)];
      song.loop = region; dirty = true;
    }
  });

  const finish = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'marquee') { marquee = null; odirty = true; }
    if (d.kind === 'ruler' && d.moved) { if (on.loop) on.loop(song.loop); if (on.change) on.change(); }
    if ((d.kind === 'move' || d.kind === 'size') && changedInDrag) commit();
  };
  over.addEventListener('pointerup', finish);
  over.addEventListener('pointercancel', finish);
  over.addEventListener('pointerleave', () => { if (!drag && on.hover) on.hover(null); });
  over.addEventListener('dblclick', (e) => {
    const { x, y } = pos(e);
    if (zone(x, y) === 'ruler' && song.loop) { song.loop = null; dirty = true; if (on.loop) on.loop(null); if (on.change) on.change(); }
  });

  // wheel: up and down; with Shift (or a sideways wheel) along the time; with Ctrl it zooms the time
  over.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x } = pos(e);
    if (e.ctrlKey || e.metaKey) zoom(Math.exp(-e.deltaY * 0.0022), x);
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { sx += (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) / ppt; clampScroll(); dirty = true; }
    else { sy += e.deltaY; clampScroll(); dirty = true; }
  }, { passive: false });

  function zoom(f, x = (W + KEYW) / 2) {
    const t = xt(x);
    ppt = Math.max(0.004, Math.min(1.2, ppt * f));
    sx = t - (x - KEYW) / ppt;
    clampScroll(); dirty = true;
  }

  // ---- what the app asks for ----
  const api = {
    setSong(s) { song = s; sel.clear(); measure(); cursor = 0; playhead = -1; fit = true; dirty = true; },
    refresh() { measure(); const live = new Set(song.notes); for (const n of [...sel]) if (!live.has(n)) sel.delete(n); clampScroll(); dirty = true; },
    resize, draw,
    zoom,
    get cursor() { return cursor; },
    setCursor,
    get selected() { return [...sel]; },
    get drawMs() { return drawMs; },
    // tick of the playhead, or -1 for none; the view turns the page when it runs out
    setPlayhead(t) {
      if (t === playhead) return;
      playhead = t; odirty = true;
      if (t >= 0 && !drag) {
        const span = (W - KEYW) / ppt;
        if (t > sx + span * 0.97 || t < sx) { sx = t - span * 0.05; clampScroll(); dirty = true; }
      }
    },
    selectAll() { for (const n of song.notes) sel.add(n); dirty = true; },
    clearSelection() { if (sel.size) { sel.clear(); dirty = true; } },
    deleteSelected() {
      if (!sel.size) return;
      if (on.before) on.before();
      removeNotes([...sel]);
    },
    // move the selected notes by ticks and by keys
    nudge(dt, dm) {
      if (!sel.size) return;
      for (const n of sel) if (n.t + dt < 0 || n.m + dm < S.LO || n.m + dm > S.HI) return;
      if (on.before) on.before();
      for (const n of sel) { n.t += dt; n.m += dm; }
      if (dm && sel.size === 1) play([...sel][0]);
      commit();
    },
    copy() {
      if (!sel.size) return false;
      const list = [...sel].sort((a, b) => a.t - b.t), t0 = list[0].t;
      clip = list.map((n) => ({ t: n.t - t0, d: n.d, m: n.m, v: n.v }));
      return true;
    },
    cut() { if (!api.copy()) return false; api.deleteSelected(); return true; },
    // the copied notes go in at the cursor, which then moves past them
    paste() {
      if (!clip) return false;
      if (on.before) on.before();
      sel.clear();
      let end = cursor;
      for (const c of clip) {
        const n = { t: cursor + c.t, d: c.d, m: c.m, v: c.v };
        song.notes.push(n); sel.add(n);
        end = Math.max(end, n.t + n.d);
      }
      commit();
      setCursor(Math.ceil(end / snapTicks()) * snapTicks());
      return true;
    },
  };
  return api;
}
