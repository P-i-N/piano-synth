// Reverb: a synthesized impulse response (from vibetar, js/ir.js).
// Pure functions returning Float32Arrays so they can be used with any
// (Offline)AudioContext and tested outside of the browser.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd) {
  let u = 0;
  while (u < 1e-12) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

// Diffuse reverb: early reflections + band-split exponentially decaying noise.
// decay: RT60 (s) at mid frequencies, tone: 0 dark .. 1 bright
export function makeReverbIR(fs, decay, tone) {
  decay = Math.max(0.2, Math.min(12, decay));
  tone = Math.max(0, Math.min(1, tone));
  const len = Math.floor(fs * Math.min(14, decay * 1.3 + 0.25));
  const pre = 0.006 + 0.012 * Math.min(1, decay / 4);
  const out = [];
  const rts = [decay * 1.12, decay, decay * (0.42 + 0.4 * tone), decay * (0.14 + 0.36 * tone)];
  const k = rts.map((rt) => Math.exp(-6.908 / (rt * fs)));
  const cf = [260, 1300, 5200].map((fc) => Math.exp((-2 * Math.PI * fc) / fs));
  const gh = 0.35 + 0.65 * tone;
  const hp = Math.exp((-2 * Math.PI * 140) / fs);
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(1000 + ch * 77);
    const b = new Float32Array(len);
    const n0 = Math.floor(pre * fs);
    let l1 = 0, l2 = 0, l2b = 0, l3 = 0, e0 = 1, e1 = 1, e2 = 1, e3 = 1, energy = 0;
    const build = 1 / (fs * (0.008 + 0.02 * Math.min(1, decay / 3)));
    for (let i = n0; i < len; i++) {
      const x = gaussian(rnd);
      l1 += (1 - cf[0]) * (x - l1);
      l2 += (1 - cf[1]) * (x - l2);
      l2b += (1 - cf[1]) * (l2 - l2b);
      l3 += (1 - cf[2]) * (x - l3);
      const lo = l1 * e0, lm = (l2b - l1) * e1, hm = (l3 - l2b) * e2, hi = (x - l3) * e3 * gh;
      const on = 1 - Math.exp(-(i - n0) * build);
      const mid = (lo * 1.1 + lm + hm) * on;
      energy += mid * mid;
      b[i] = mid + hi * on;
      e0 *= k[0]; e1 *= k[1]; e2 *= k[2]; e3 *= k[3];
    }
    const norm = 0.5 / Math.sqrt(energy);
    for (let i = 0; i < len; i++) b[i] *= norm;
    // early reflections
    const span = 0.02 + 0.07 * Math.min(1, decay / 3);
    const nEarly = 9;
    for (let j = 0; j < nEarly; j++) {
      const tt = pre + span * Math.pow((j + rnd()) / nEarly, 1.4);
      const idx = Math.floor(tt * fs);
      const g = 0.11 * Math.pow(0.82, j) * (rnd() < 0.5 ? -1 : 1) * (0.7 + 0.6 * rnd());
      if (idx + 2 < len) { b[idx] += g * 0.6; b[idx + 1] += g * 0.3; b[idx + 2] += g * 0.1; }
    }
    // remove rumble, fade the very end
    let s = 0, px = 0;
    for (let i = 0; i < len; i++) { const x = b[i]; s = hp * (s + x - px); px = x; b[i] = s; }
    const fade = Math.floor(fs * 0.05);
    for (let i = 0; i < fade; i++) b[len - 1 - i] *= i / fade;
    out.push(b);
  }
  return { L: out[0], R: out[1] };
}
