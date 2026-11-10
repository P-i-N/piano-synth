// Stereo width: how strong the difference of the two channels is against their sum, in
// octave bands (dB). 0 dB: the channels have nothing in common; very negative: the same
// signal in both, a point between the speakers.
//
//   node tools/width.mjs recording.flac        a stereo file (decoded with ffmpeg)

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fft } from '../test/util.mjs';

export const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

// L, R: the two channels. Returns the side / mid level (dB) for each octave.
export function width(L, R, fs = 48000) {
  const N = 16384, win = new Float64Array(N), mid = OCTAVES.map(() => 0), side = OCTAVES.map(() => 0);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (let s = 0; s + N <= L.length; s += N / 2) {
    for (let i = 0; i < N; i++) { ar[i] = (L[s + i] + R[s + i]) * win[i]; ai[i] = 0; br[i] = (L[s + i] - R[s + i]) * win[i]; bi[i] = 0; }
    fft(ar, ai); fft(br, bi);
    OCTAVES.forEach((f, k) => {
      for (let i = Math.floor(((f / Math.SQRT2) * N) / fs); i < ((f * Math.SQRT2) * N) / fs; i++) { mid[k] += ar[i] * ar[i] + ai[i] * ai[i]; side[k] += br[i] * br[i] + bi[i] * bi[i]; }
    });
  }
  return OCTAVES.map((_, k) => 10 * Math.log10(side[k] / mid[k] + 1e-30));
}

export function decodeStereo(file, fs = 48000) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '2', '-ar', String(fs), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2), n = x.length >> 1, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = x[2 * i]; R[i] = x[2 * i + 1]; }
  return { L, R };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { L, R } = decodeStereo(process.argv[2]);
  console.log('octave   difference against sum (dB)');
  width(L, R).forEach((w, k) => console.log(`${String(OCTAVES[k]).padStart(6)}   ${w.toFixed(1).padStart(6)}`));
}
