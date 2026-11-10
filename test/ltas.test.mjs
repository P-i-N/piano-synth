// The comparison tool is checked on signals whose spectrum is known.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ltas, BANDS } from '../tools/ltas.mjs';

const FS = 48000;
function noise(secs, pink) {
  let a = 11;
  const rnd = () => { // mulberry32
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  };
  const x = new Float32Array(secs * FS), b = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < x.length; i++) {
    const w = rnd();
    if (!pink) { x[i] = w; continue; }
    // Paul Kellet's pink filter
    b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898;
    x[i] = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11; b[6] = w * 0.115926;
  }
  return x;
}
const band = (hz) => BANDS.findIndex((f) => Math.abs(f / hz - 1) < 0.05);

test('white noise rises by 1 dB per third octave, pink noise is level', () => {
  const w = ltas(noise(20, false)).bands, p = ltas(noise(20, true)).bands;
  const slope = (b) => (b[band(8000)] - b[band(250)]) / 15;
  assert.ok(Math.abs(slope(w) - 1.003) < 0.05, `white: ${slope(w).toFixed(3)} dB per band`);
  assert.ok(Math.abs(slope(p)) < 0.06, `pink: ${slope(p).toFixed(3)} dB per band`);
});

test('a tone lands in its band, at its level; silence around it does not count', () => {
  const tone = (from, to) => { const x = new Float32Array(10 * FS); for (let i = from * FS; i < to * FS; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS); return x; };
  const whole = ltas(tone(0, 10)), part = ltas(tone(2, 4));
  assert.ok(whole.bands[band(1000)] > -0.1, `1 kHz band ${whole.bands[band(1000)].toFixed(2)} dB`);
  // a sine of amplitude 0.5 is 6 dB under a full-scale sine; A-weighting is 0 dB at 1 kHz
  assert.ok(Math.abs(whole.aLevel - -6.02) < 0.2, `${whole.aLevel.toFixed(2)} dB against a full-scale sine`);
  assert.ok(part.seconds > 1.8 && part.seconds < 3.1, `${part.seconds.toFixed(2)} s of 10 counted`);
});
