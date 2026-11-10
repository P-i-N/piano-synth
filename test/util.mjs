// Small signal-analysis helpers for the offline engine tests (after vibetar's test/util.mjs).
import { PianoEngine, keyHz } from '../js/worklet.js';

export const FS = 48000;
export { keyHz };

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Hann-windowed magnitude spectrum of n samples starting at `start`
export function spectrum(x, start, n) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[start + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

export function bandEnergy(mag, n, f0, f1, fs = FS) {
  let s = 0;
  for (let i = Math.floor((f0 * n) / fs); i < Math.ceil((f1 * n) / fs); i++) s += mag[i] * mag[i];
  return s;
}

// frequency and size of the strongest component within +-width of f, in a Hann window of
// `secs` starting at t, zero-padded for a fine estimate
export function freqNear(x, f, t, secs = 0.5, width = 0.015, fs = FS) {
  const n = 1 << 18, len = Math.floor(secs * fs), st = Math.floor(t * fs);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < len; i++) re[i] = (x[st + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
  fft(re, im);
  const mag = (i) => Math.hypot(re[i], im[i]);
  let bi = Math.floor((f * (1 - width) * n) / fs);
  for (let i = bi; i <= Math.ceil((f * (1 + width) * n) / fs); i++) if (mag(i) > mag(bi)) bi = i;
  const a = Math.log(mag(bi - 1) + 1e-300), b = Math.log(mag(bi) + 1e-300), c = Math.log(mag(bi + 1) + 1e-300);
  return { f: ((bi + (0.5 * (a - c)) / (a - 2 * b + c)) * fs) / n, mag: mag(bi) };
}

export const db = (x) => 20 * Math.log10(x + 1e-30);
export const cents = (f, ref) => 1200 * Math.log2(f / ref);
export function rms(x, t0, t1, fs = FS) {
  let s = 0;
  const a = Math.floor(t0 * fs), b = Math.floor(t1 * fs);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}
export function peak(x, t0 = 0, t1 = x.length / FS, fs = FS) {
  let p = 0;
  for (let i = Math.floor(t0 * fs); i < Math.floor(t1 * fs); i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

export function engine(cfg = {}, fs = FS) {
  const e = new PianoEngine(fs);
  e.configure(cfg);
  return e;
}
// the sum of the six channels
export function render(e, secs, fs = FS) {
  const n = Math.floor((secs * fs) / 128) * 128, out = new Float32Array(n);
  for (let i = 0; i < n; i += 128) e.render(out.subarray(i, i + 128), 128, i);
  return out;
}
// one note on an otherwise silent piano: key m, velocity v (0..1), released after `hold` seconds (0: never)
export function note(m, v = 0.5, secs = 2.5, hold = 0, cfg = {}) {
  const e = engine(cfg);
  e.post({ type: 'n', t: 0.01, m, v });
  if (hold) e.post({ type: 'o', t: 0.01 + hold, m });
  return render(e, secs);
}

// decay rate (1/s, of the amplitude) of the component near f between two windows
export function decayRate(x, f, t0, t1, secs = 0.1, width = 0.015) {
  const a = freqNear(x, f, t0, secs, width), b = freqNear(x, a.f, t1, secs, 0.004);
  return Math.log(a.mag / b.mag) / (t1 - t0);
}

const aWeight = (f) => { const f2 = f * f; return ((12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))) * 1.2589; };
// A-weighted level (dB) of n samples of x starting at `start`
export function aLevel(x, start, n, fs = FS) {
  const m = spectrum(x, start, n);
  let s = 0;
  for (let i = 1; i < n / 2; i++) { const a = aWeight((i * fs) / n) * m[i]; s += a * a; }
  return db((Math.sqrt(s) / n) * 4);
}

// ---- the soundboard ----------------------------------------------------------------
import { buildBoard } from '../js/board/model.js';

const boards = new Map();
// the soundboard, built once per test process
export function cachedBoard(fs = FS) {
  if (!boards.has(fs)) boards.set(fs, buildBoard(fs));
  return boards.get(fs);
}

// What the two microphones hear: the engine's seven channels, each through its two responses.
// Returns { L, R } (Float64Array), as long as the rendering plus the responses.
export function throughBoard(e, secs, board = cachedBoard(), fs = FS) {
  const n = Math.floor((secs * fs) / 128) * 128, ch = [0, 1, 2, 3, 4, 5, 6].map(() => new Float32Array(n));
  for (let i = 0; i < n; i += 128) e.render(ch.map((c) => c.subarray(i, i + 128)), 128, i);
  const len = n + board.irs[0].length;
  let N = 1;
  while (N < len) N <<= 1;
  const out = [new Float64Array(len), new Float64Array(len)];
  if (!board.spec || board.specN !== N) {
    board.specN = N;
    board.spec = board.irs.map((h) => { const re = new Float64Array(N), im = new Float64Array(N); re.set(h); fft(re, im); return { re, im }; });
  }
  for (let z = 0; z < 7; z++) {
    if (peak(ch[z], 0, n / fs, fs) === 0) continue;
    const xr = new Float64Array(N), xi = new Float64Array(N);
    xr.set(ch[z]); fft(xr, xi);
    for (let q = 0; q < 2; q++) {
      const h = board.spec[2 * z + q], yr = new Float64Array(N), yi = new Float64Array(N);
      // multiply, then transform back (the conjugate trick: one forward transform does it)
      for (let i = 0; i < N; i++) { yr[i] = xr[i] * h.re[i] - xi[i] * h.im[i]; yi[i] = -(xr[i] * h.im[i] + xi[i] * h.re[i]); }
      fft(yr, yi);
      for (let i = 0; i < len; i++) out[q][i] += yr[i] / N;
    }
  }
  return { L: out[0], R: out[1] };
}
// one note as the two microphones hear it: { L, R }
export function heardStereo(m, v = 0.5, secs = 2.5, hold = 0) {
  const e = engine();
  e.post({ type: 'n', t: 0.01, m, v });
  if (hold) e.post({ type: 'o', t: 0.01 + hold, m });
  const { L, R } = throughBoard(e, secs);
  return { L: Float32Array.from(L), R: Float32Array.from(R) };
}
// A level (dB) measured on each microphone and averaged as power. (The two hear a note with
// different delays: added to one signal they add up or cancel by chance. Two ears, or two
// speakers in a room, do not add them that way.)
export const both = (st, level) => 10 * Math.log10((Math.pow(10, level(st.L) / 10) + Math.pow(10, level(st.R) / 10)) / 2);
// the two mixed to one
export function heardNote(m, v = 0.5, secs = 2.5, hold = 0) {
  const { L, R } = heardStereo(m, v, secs, hold), out = new Float32Array(L.length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (L[i] + R[i]);
  return out;
}
