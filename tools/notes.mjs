// Recorded single notes against the model: what a linear soundboard, room and microphone
// cannot change - pitch, stiffness, decay rates, and the difference between soft and loud.
//
//   node tools/notes.mjs [folder]      default: ref/iowa
//
// The folder holds the C of each octave at three strengths, named as the University of
// Iowa's piano samples are (Steinway B): Piano.pp.C1.aiff ... Piano.ff.C8.aiff, from
// https://theremin.music.uiowa.edu/MISpiano.html
// The recordings are noisy (a soft note is 25 dB over the noise): the noise, taken from the
// last second of each file, is subtracted, and what does not rise 3 dB over it is shown as "-".
import { fileURLToPath } from 'node:url';
import { decode } from './ltas.mjs';
import { inharmonicity, hammerSpeed } from '../js/worklet.js';
import { FS, fft, spectrum, freqNear, rms, note, heardStereo } from '../test/util.mjs';
import { ltas, BANDS } from './ltas.mjs';

// key velocity (0..1) for a hammer speed in m/s
export const vFor = (speed) => { let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (hammerSpeed(m) < speed) lo = m; else hi = m; } return lo; };
export const SPEED = { pp: 0.5, mf: 1.5, ff: 4 }; // m/s, as Chaigne and Askenfelt matched p / mf / f
export const EDGES = [20, 500, 1000, 2000, 4000, 8000, 16000]; // bands, Hz
const N = 16384;

// start of the note: the first 20 ms within 12 dB of the loudest 20 ms
function onset(x) {
  const hop = 960, env = [];
  for (let s = 0; s + hop <= x.length; s += hop) env.push(rms(x, s / FS, (s + hop) / FS));
  const top = Math.max(...env);
  return (env.findIndex((e) => e > 0.25 * top) * hop) / FS;
}
function power(x, start) { const m = spectrum(x, start, N), p = new Float64Array(N / 2); for (let i = 0; i < N / 2; i++) p[i] = m[i] * m[i]; return p; }
function bandsOf(p, noise) {
  const out = [];
  for (let b = 0; b + 1 < EDGES.length; b++) {
    let s = 0, nz = 0;
    for (let i = Math.floor((EDGES[b] * N) / FS); i < (EDGES[b + 1] * N) / FS; i++) { s += p[i]; if (noise) nz += noise[i]; }
    out.push(noise ? (s > 2 * nz ? s - nz : NaN) : s);
  }
  return out;
}
// x: one note, mono at 48 kHz; m: its key; recorded: take the noise of the last second off
export function facts(x, m, recorded) {
  const t0 = onset(x), f0 = 440 * Math.pow(2, (m - 69) / 12), len = x.length / FS;
  let noise = null, nLevel = 0;
  if (recorded) {
    noise = new Float64Array(N / 2);
    let c = 0;
    for (let s = x.length - N; s > x.length - N - FS && s > 0; s -= N / 2) { const p = power(x, s); for (let i = 0; i < N / 2; i++) noise[i] += p[i]; c++; }
    for (let i = 0; i < N / 2; i++) noise[i] /= c;
    nLevel = rms(x, len - 1, len);
  }
  const f1 = freqNear(x, f0, t0 + 0.05, Math.min(1, len - t0 - 0.1), 0.02).f;
  const ks = m <= 36 ? [10, 14, 18] : m <= 48 ? [8, 10, 12] : m <= 60 ? [5, 6, 8] : m <= 72 ? [3, 4, 5] : m <= 84 ? [2, 3] : [2];
  const Bg = inharmonicity(m), Bs = [];
  for (const k of ks) {
    const guess = k * f1 * Math.sqrt((1 + Bg * k * k) / (1 + Bg));
    if (guess > 0.45 * FS) continue;
    const r = freqNear(x, guess, t0 + 0.02, 0.3, Math.min(0.02, 0.3 / k)).f / (k * f1);
    Bs.push((r * r - 1) / (k * k - r * r));
  }
  Bs.sort((a, b) => a - b);
  const bands = bandsOf(power(x, Math.floor((t0 + 0.005) * FS)), noise);
  let total = 0; for (const b of bands) if (b > 0) total += b;
  // level of 0.3 s, the noise taken off; NaN when it is not 6 dB over the noise
  const lv = (t) => { const r = rms(x, t0 + t, t0 + t + 0.3); return r > 2 * nLevel ? 10 * Math.log10(r * r - nLevel * nLevel) : NaN; };
  const e1 = m >= 84 ? 0.5 : 1.1, l0 = m >= 96 ? 0.8 : m >= 84 ? 1.5 : 5, l1 = m >= 96 ? 1.4 : m >= 84 ? 2.5 : 8;
  return {
    cents: 1200 * Math.log2(f1 / f0), B: Bs[Math.floor(Bs.length / 2)],
    share: bands.map((b) => 10 * Math.log10(b / total)), level: lv(0.02),
    early: (lv(0.1) - lv(e1)) / (e1 - 0.1), late: len - t0 > l1 + 0.4 ? (lv(l0) - lv(l1)) / (l1 - l0) : NaN,
  };
}

// How the level of a note falls: dB under its level at 0.1 s, at the times CURVE_T (seconds).
// NaN where the recording is not 4 dB over its noise, or has ended.
export const CURVE_T = [0.5, 1, 2, 3, 5, 8];
export function levelCurve(x, recorded) {
  const t0 = onset(x), len = x.length / FS, nz = recorded ? rms(x, len - 1, len) : 0;
  const lv = (t) => {
    if (t0 + t + 0.3 > len - (recorded ? 1.2 : 0)) return NaN;
    const r = rms(x, t0 + t, t0 + t + 0.3);
    return r > 1.6 * nz ? 10 * Math.log10(r * r - nz * nz) : NaN;
  };
  const a = lv(0.1);
  return CURVE_T.map((t) => lv(t) - a);
}
export const modelCurve = (m, speed) => levelCurve(note(m, vFor(speed), 9), false);

// Third-octave spectrum (dB, each band against the total) of the first two seconds of a note
export function noteSpectrum(x) { const t0 = onset(x); return ltas(x.subarray(Math.floor(t0 * FS), Math.floor((t0 + 2) * FS))).bands; }
// The spectra of many notes are compared band by band: for each band, the mean over the
// notes of (model - recorded), counting a note only where both have the band within `range` dB
// of their strongest. Returns [{ f, diff, n }].
export function spectrumGap(pairs, range = 45) {
  return BANDS.map((f, i) => {
    let s = 0, n = 0;
    for (const [rec, mod] of pairs) if (rec[i] > Math.max(...rec) - range && mod[i] > Math.max(...mod) - range) { s += mod[i] - rec[i]; n++; }
    return { f, diff: n ? s / n : NaN, n };
  });
}

// The knock of key and hammer at the start of a high note: the level (dB) of 100 to 600 Hz in
// the 85 ms around the start, against the note itself (0.6 to 3 times its pitch) in the same time.
export function knockLevel(x, m) {
  // the start to 10 ms: the first 10 ms that reach a quarter of the loudest
  const hop = 480, env = [];
  for (let s = 0; s + hop <= x.length; s += hop) env.push(rms(x, s / FS, (s + hop) / FS));
  const t0 = (env.findIndex((e) => e > 0.25 * Math.max(...env)) * hop) / FS;
  const f0 = 440 * Math.pow(2, (m - 69) / 12), st = Math.max(0, Math.floor((t0 - 0.02) * FS)), n = 4096, N = 8192;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = (x[st + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  const band = (lo, hi) => { let e = 0; for (let i = Math.floor((lo * N) / FS); i < (hi * N) / FS; i++) e += re[i] * re[i] + im[i] * im[i]; return 10 * Math.log10(e + 1e-30); };
  return band(100, 600) - band(0.6 * f0, 3 * f0);
}

// the same note from the model, struck at `speed` m/s
export const modelNote = (m, speed) => facts(note(m, vFor(speed), m >= 84 ? 4 : 10), m, false);
// From a softer note (facts) to a harder one: the level gain (dB), and how much more than the
// band of the fundamental each higher band gains (dB; null for the bands at and below it)
export function toneGain(soft, hard, m) {
  const f0 = 440 * Math.pow(2, (m - 69) / 12), ref = EDGES.findIndex((e, i) => f0 >= e && f0 < EDGES[i + 1]);
  return { level: hard.level - soft.level, bands: hard.share.map((s, i) => (i > ref ? s - soft.share[i] - (hard.share[ref] - soft.share[ref]) : null)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
const DIR = (process.argv[2] || 'ref/iowa').replace(/\/?$/, '/');
const rows = [];
for (let o = 1; o <= 8; o++) {
  const m = 12 * (o + 1), r = {}, md = {};
  for (const d of ['pp', 'mf', 'ff']) {
    r[d] = facts(decode(`${DIR}Piano.${d}.C${o}.aiff`), m, true);
    md[d] = modelNote(m, SPEED[d]);
  }
  rows.push({ o, m, r, md });
}
const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '     -' : x.toFixed(d).padStart(6));
console.log('PITCH, STIFFNESS, DECAY (recorded: the ff note; model: 4 m/s)');
console.log('key   cents from equal temp.   B x 1e-4           first decay dB/s   late decay dB/s');
console.log('      recorded  model          recorded  model    recorded  model    recorded  model');
for (const { o, r, md } of rows) console.log(`C${o}    ${f(r.ff.cents)}  ${f(md.ff.cents)}          ${f(r.ff.B * 1e4, 2)}  ${f(md.ff.B * 1e4, 2)}    ${f(r.ff.early)}  ${f(md.ff.early)}    ${f(r.ff.late)}  ${f(md.ff.late)}`);
console.log('\nSOFT TO LOUD: level (dB) of the first 0.3 s');
console.log('key   mf - pp: recorded  model     ff - mf: recorded  model     ff - pp: recorded  model');
for (const { o, r, md } of rows) console.log(`C${o}             ${f(r.mf.level - r.pp.level)}  ${f(md.mf.level - md.pp.level)}              ${f(r.ff.level - r.mf.level)}  ${f(md.ff.level - md.mf.level)}              ${f(r.ff.level - r.pp.level)}  ${f(md.ff.level - md.pp.level)}`);
console.log('\nDECAY of the loud note: dB under its level at 0.1 s, after ' + CURVE_T.map((t) => t + ' s').join(', '));
for (const { o, m } of rows) {
  console.log(`C${o}   recorded ${levelCurve(decode(`${DIR}Piano.ff.C${o}.aiff`), true).map((x) => f(x)).join(' ')}`);
  console.log(`     model    ${modelCurve(m, SPEED.ff).map((x) => f(x)).join(' ')}`);
}

// the spectrum as heard: the model through its soundboard against the recorded notes
{
  const pairs = [];
  for (const { o, m } of rows) for (const d of ['mf', 'ff']) { const st = heardStereo(m, vFor(SPEED[d]), 2.5), a = noteSpectrum(st.L), b = noteSpectrum(st.R); pairs.push([noteSpectrum(decode(`${DIR}Piano.${d}.C${o}.aiff`)), a.map((x, i) => 0.5 * (x + b[i]))]); }
  console.log('\nSPECTRUM as heard, model - recorded, mean over the 16 mf and ff notes (dB; each note against its own total)');
  console.log('   band    model - recorded   notes');
  for (const g of spectrumGap(pairs)) if (g.n >= 3) console.log(`${g.f >= 1000 ? (g.f / 1000).toFixed(1) + ' k' : g.f.toFixed(0)}`.padStart(7) + `      ${f(g.diff)}          ${g.n}`);
}

// the tone: how much more each band gains than the band the fundamental is in
const show = (g) => g.slice(1).map((x) => (x === null ? '     .' : f(x))).join(' ');
for (const [hard, soft] of [['ff', 'pp'], ['mf', 'pp'], ['ff', 'mf']]) {
  console.log(`\nSOFT TO LOUD: gain of each band over the band of the fundamental, ${hard} - ${soft} (dB)`);
  console.log('key   recorded: 0.5-1k   1-2k   2-4k   4-8k  8-16k   |  model: 0.5-1k   1-2k   2-4k   4-8k  8-16k');
  for (const { o, m, r, md } of rows) console.log(`C${o}             ${show(toneGain(r[soft], r[hard], m).bands)}   |         ${show(toneGain(md[soft], md[hard], m).bands)}`);
}
// the same for each dB the note gets louder: this does not depend on how hard "mf" and "ff" were played
console.log('\nMEDIUM TO LOUD, for each dB of level: gain of the bands 2-4 kHz and 4-8 kHz over the fundamental (dB per dB)');
console.log('key   recorded: 2-4k   4-8k   |  model: 2-4k   4-8k');
for (const { o, m, r, md } of rows) {
  const a = toneGain(r.mf, r.ff, m), b = toneGain(md.mf, md.ff, m), per = (g, i) => (g.bands[i] === null ? '     .' : f(g.bands[i] / g.level, 2));
  console.log(`C${o}             ${per(a, 3)} ${per(a, 4)}   |         ${per(b, 3)} ${per(b, 4)}`);
}
}
