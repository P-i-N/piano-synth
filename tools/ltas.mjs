// Long-term average spectrum in third-octave bands: the measure for comparing the model
// with a recording of a real piano.
//
//   node tools/ltas.mjs reference.flac                 one file
//   node tools/ltas.mjs reference.flac model.wav       two files and their difference
//
// Files are decoded with ffmpeg (any format it reads), mixed to mono at 48 kHz. Each
// spectrum is given relative to the file's own total level, so only the tone is compared;
// the A-weighted level of each file is printed apart from it. Silent passages do not count.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fft } from '../test/util.mjs';

export const BANDS = [];
for (let k = -16; k <= 12; k++) BANDS.push(1000 * Math.pow(2, k / 3)); // 25 Hz .. 16 kHz

const aWeight = (f) => { const f2 = f * f; return ((12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))) * 1.2589; };

// x: mono samples. Returns { bands: dB per third-octave band relative to the total, aLevel: dB }
export function ltas(x, fs = 48000) {
  const N = 32768, hop = N / 2, win = new Float64Array(N), pow = new Float64Array(N / 2);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  // frames more than 50 dB under the loudest are silence
  const frames = [];
  let loudest = 0;
  for (let s = 0; s + N <= x.length; s += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) e += x[s + i] * x[s + i];
    frames.push([s, e]); if (e > loudest) loudest = e;
  }
  let used = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (const [s, e] of frames) {
    if (e < loudest * 1e-5) continue;
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) pow[i] += re[i] * re[i] + im[i] * im[i];
    used++;
  }
  let total = 0, a = 0;
  const sums = BANDS.map(() => 0);
  for (let i = 1; i < N / 2; i++) {
    const f = (i * fs) / N, p = pow[i] / Math.max(1, used);
    a += p * aWeight(f) ** 2;
    const b = Math.round(3 * Math.log2(f / 1000)) + 16;
    if (b >= 0 && b < BANDS.length) { sums[b] += p; total += p; }
  }
  // power of a full-scale sine reads 0 dB
  const scale = 4 / (N * N * 0.375) / 2;
  return { bands: sums.map((s) => 10 * Math.log10(s / total + 1e-30)), aLevel: 10 * Math.log10(a * scale * 2 + 1e-30), seconds: (used * hop) / fs };
}

export function decode(file, fs = 48000) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(fs), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length || files.length > 2) { console.error('usage: node tools/ltas.mjs reference [model]'); process.exit(1); }
  const r = files.map((f) => ltas(decode(f)));
  const hz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' k' : f.toFixed(0)).padStart(7);
  console.log(files.map((f, i) => `${i ? 'model    ' : 'reference'}: ${f}  (${r[i].seconds.toFixed(1)} s of sound, A-weighted ${r[i].aLevel.toFixed(1)} dB, 0 = a full-scale sine)`).join('\n'));
  console.log(`\n   band   reference${r[1] ? '     model   model - reference' : ''}`);
  BANDS.forEach((f, i) => {
    let line = `${hz(f)}    ${r[0].bands[i].toFixed(1).padStart(6)}`;
    if (r[1]) line += `    ${r[1].bands[i].toFixed(1).padStart(6)}    ${(r[1].bands[i] - r[0].bands[i]).toFixed(1).padStart(6)}`;
    console.log(line);
  });
}
