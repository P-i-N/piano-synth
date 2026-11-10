// The keyboard under the roll: 88 keys. It shows which keys sound (how hard, and whether a
// finger or only the pedal holds them) and plays a note when a key is clicked.
// It only draws and reports clicks; what sounds is decided elsewhere. (In place of vibetar's
// fretboard, js/neck.js.)

import { LO, HI, isBlack } from './song.js';

// createKeys(canvas, { down(m, v), up(m) }) -> {
//   down(m, v)     a key goes down, v 0..1
//   up(m)          a key comes up; with the pedal down its strings ring on
//   pedal(on)      the sustain pedal
//   show(notes)    keys looked at, not played: [{ m, v }] (v 1..127); nothing else stays lit
//   clear()        all keys and the pedal up
//   resize()       the canvas changed size
//   draw()         paint, if anything changed
// }
export function createKeys(canvas, on = {}) {
  const g = canvas.getContext('2d');
  const finger = new Float32Array(128);  // velocity of a key held by a finger, 0 = up
  const ring = new Uint8Array(128);      // strings held by the pedal only
  const still = new Float32Array(128);   // keys shown, not played
  let pedal = false, dirty = true, colors = null, rects = null, W = 0, H = 0;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const palette = () => colors || (colors = { ink: css('--ink'), dark: '#15110e', line: css('--line'), accent: css('--accent'), green: css('--green'), dim: css('--dim') });

  // key rectangles: white keys side by side, black keys on top between them
  function layout() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    let whites = 0;
    for (let m = LO; m <= HI; m++) if (!isBlack(m)) whites++;
    const ww = W / whites, bw = ww * 0.6, bh = H * 0.62;
    rects = new Array(128).fill(null);
    let i = 0;
    for (let m = LO; m <= HI; m++) {
      if (isBlack(m)) rects[m] = { x: i * ww - bw / 2, y: 0, w: bw, h: bh, black: true };
      else { rects[m] = { x: i * ww, y: 0, w: ww, h: H, black: false }; i++; }
    }
  }

  function keyAt(x, y) {
    if (!rects) return null;
    for (let m = LO; m <= HI; m++) { const r = rects[m]; if (r.black && x >= r.x && x < r.x + r.w && y < r.h) return m; }
    for (let m = LO; m <= HI; m++) { const r = rects[m]; if (!r.black && x >= r.x && x < r.x + r.w) return m; }
    return null;
  }

  function draw() {
    if (!dirty) return;
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    dirty = false;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr) || !rects) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); layout(); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const c = palette();
    const paint = (m) => {
      const r = rects[m];
      g.fillStyle = r.black ? c.dark : c.ink;
      g.fillRect(r.x + 0.5, r.y, r.w - 1, r.h - 1);
      // a finger: the harder, the stronger the colour; the pedal alone: green; looked at: faint
      let col = null, a = 0;
      if (finger[m] > 0) { col = c.accent; a = 0.45 + 0.55 * finger[m]; }
      else if (ring[m]) { col = c.green; a = 0.6; }
      else if (still[m] > 0) { col = c.accent; a = 0.25 + 0.3 * still[m]; }
      if (col) { g.globalAlpha = a; g.fillStyle = col; g.fillRect(r.x + 0.5, r.y, r.w - 1, r.h - 1); g.globalAlpha = 1; }
      if (!r.black && m % 12 === 0 && r.w > 9) {
        g.fillStyle = '#6b5b4b'; g.font = '9px system-ui, sans-serif'; g.textAlign = 'center';
        g.fillText('C' + (m / 12 - 1), r.x + r.w / 2, r.h - 5);
      }
    };
    for (let m = LO; m <= HI; m++) if (!rects[m].black) paint(m);
    for (let m = LO; m <= HI; m++) if (rects[m].black) paint(m);
  }

  // ---- playing with the pointer ----
  const held = new Map(); // pointer id -> key
  const press = (e) => {
    const b = canvas.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    const m = keyAt(x, y);
    if (m == null) return null;
    // lower on the key is louder
    return { m, v: Math.min(1, Math.max(0.15, 0.25 + (0.75 * y) / rects[m].h)) };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const p = press(e);
    if (!p) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* a pointer that is already gone */ }
    held.set(e.pointerId, p.m);
    if (on.down) on.down(p.m, p.v);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!held.has(e.pointerId)) return;
    const p = press(e), was = held.get(e.pointerId);
    if (!p || p.m === was) return;
    if (on.up) on.up(was);
    held.set(e.pointerId, p.m);
    if (on.down) on.down(p.m, p.v);
  });
  const release = (e) => {
    if (!held.has(e.pointerId)) return;
    if (on.up) on.up(held.get(e.pointerId));
    held.delete(e.pointerId);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  return {
    down(m, v) { finger[m] = Math.max(0.01, v); ring[m] = 0; dirty = true; },
    up(m) { if (finger[m] > 0 && pedal) ring[m] = 1; finger[m] = 0; dirty = true; },
    pedal(down) { pedal = down; if (!down) ring.fill(0); dirty = true; },
    show(notes) { still.fill(0); for (const n of notes) still[n.m] = n.v / 127; dirty = true; },
    clear() { finger.fill(0); ring.fill(0); pedal = false; dirty = true; },
    resize() { rects = null; dirty = true; },
    draw,
  };
}
