// The soundboard: what two microphones hear when the strings push on the bridge.
//
// The board is one plate with the same stiffness everywhere: spruce and its ribs spread
// evenly, a rectangle of the area of a concert grand's board. Its resonances are known in
// closed form (about 1100 of them up to 10 kHz). Each one moves the air: its motion is summed
// over the surface of the board towards each microphone, once directly and once by way of
// the open lid. The result is a stereo impulse response for each of six places on the
// bridge, bass to treble: the string engine sends each the force it gets there.
//
// What this leaves out: the shape of a real board and its bridges, ribs as separate beams
// (above about 1 kHz the waves of a real board stay between them), the case and the air
// under the board, the sound from the underside. The strings do not feel these resonances:
// what they lose to the bridge is fitted in the string engine.
//
// Building takes a few seconds; it is done once, in a worker, and kept (see js/audio.js).

export const MODEL_VERSION = 1;

// Lengths in metres. x runs along the keyboard from the bass side, y from the keyboard to
// the tail, z up. Sources: Ege, Boutillon and Rebillat (2013) and Boutillon and Ege (2013) for
// stiffness, loss and the spacing of the resonances (measured on uprights and baby grands);
// Conklin (1996) for the lowest resonances of a concert grand. Area and mass are estimates.
export const BOARD = {
  a: 1.4, b: 1.5,               // sides of the rectangle
  mass: 5.5,                    // kg/m², spruce 8 mm thick with its ribs
  // Bending stiffness along x and y and the mixed term, N m. Measured boards behave like an
  // even plate with stiffness / mass of 70 to 100 m⁴/s², a little stiffer one way (1.4 : 1).
  // That gives a resonance every 9 Hz on a board of this size.
  Dx: 400, Dy: 560, H: 470,
  // The arch of the board and the pressure of the strings stiffen it for its lowest
  // resonances: this frequency (Hz) is added in square, which puts the lowest at 49 Hz, where
  // Conklin measured it.
  crown: 38,
  loss: 0.02,                   // share of its energy a resonance loses in one radian
  // Every resonance is at least this many Hz wide: below 1 kHz wider than the loss above
  // makes it. In a piano a string tuned to a board resonance is drained by it within a
  // moment. Here the strings do not feel the board, and a sharp resonance makes the note
  // on it louder than its neighbours for as long as it rings (by up to 8 dB at 3 Hz).
  width: 20,
  top: 10000,                   // Hz: resonances above are not computed
  // where the force of each of the engine's six ranges of keys meets the board: the bass
  // bridge, then along the long bridge to the top
  bridge: [[0.55, 1.2], [0.3, 1.05], [0.5, 0.85], [0.75, 0.62], [1.0, 0.42], [1.2, 0.28]],
  // two microphones inside the open piano, above the strings, towards the bass and the treble
  mics: [[0.4, 0.55, 0.45], [1.0, 0.55, 0.45]],
  // the lid: hinged along the bass side at this height above the board, open by this angle;
  // it throws back this share of the sound
  lid: { height: 0.3, angle: 35, reflect: 0.9 },
  seconds: 1.2,                 // length of the responses
};
const RHO = 1.2, C = 343;       // air: kg/m³, m/s

// THE MICROPHONE CHAIN. Not computed: a response [Hz, dB] matched to recordings, on top of
// what the board model gives the microphones. It stands for everything between the strings
// and the recording that the model leaves out or gets wrong.
// Matched to the eight loud recorded notes of a Steinway B (University of Iowa; third-octave
// spectra of their first two seconds, `node tools/notes.mjs`). Without it the model has 7 to
// 23 dB too much below 200 Hz and 13 to 26 dB too much above 3 kHz, against 250 Hz to 2.5 kHz.
// The lows: a board in the open radiates little below 100 Hz (the air goes round its edge),
// which the model does not know. The highs: not explained.
export const CHAIN = [[40, -24], [63, -25], [80, -15], [125, -16], [160, -13], [220, -7], [300, -6], [400, -5], [500, 0], [800, 4], [1250, 3], [2000, 1], [2500, -3], [3200, -19], [4000, -19], [5000, -17], [6300, -27], [8000, -31], [10000, -33]];
export function chainGain(f, tab = CHAIN) {
  if (!tab.length) return 0;
  if (f <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) if (f <= tab[i][0]) { const [f0, g0] = tab[i - 1], [f1, g1] = tab[i]; return g0 + ((g1 - g0) * Math.log(f / f0)) / Math.log(f1 / f0); }
  return tab[tab.length - 1][1];
}

// Resonances of the plate: [{ m, n, f }] up to `top` Hz, lowest first. The edges of a
// soundboard are glued to the case: the frequencies are those of a plate held at its edges
// (m + 1/2 half waves instead of m). The shapes used
// for the sound are the simpler ones of a plate that is only supported.
export function plateModes(P = BOARD, top = P.top) {
  const out = [], k = Math.PI / 2 / Math.sqrt(P.mass);
  const fOf = (m, n) => { const u = (m + 0.5) / P.a, v = (n + 0.5) / P.b; return Math.sqrt(k * k * (P.Dx * u ** 4 + 2 * P.H * u * u * v * v + P.Dy * v ** 4) + P.crown * P.crown); };
  for (let m = 1; fOf(m, 1) <= top; m++) for (let n = 1; ; n++) {
    const f = fOf(m, n);
    if (f > top) break;
    out.push({ m, n, f });
  }
  return out.sort((x, y) => x.f - y.f);
}

// the microphone as the lid mirrors it
function mirrored(mic, lid) {
  const t = Math.tan((lid.angle * Math.PI) / 180), len = Math.hypot(t, 1), nx = -t / len, nz = 1 / len;
  const d = nx * mic[0] + nz * mic[2] - lid.height / len;
  return [mic[0] - 2 * d * nx, mic[1], mic[2] - 2 * d * nz];
}

// How strongly, and with what delay, a resonance is heard at each listening point: the sum
// over the board of its motion, each patch weighed by 1 / distance and turned by the time
// the sound takes (less the time from `ref`, so the response starts at zero).
// Returns [re, im] for each point.
function radiation(mode, points, refs, P) {
  const k = (2 * Math.PI * mode.f) / C;
  // patches: 0.4 of the wavelength in air, and a quarter of a half wave of the plate
  const nx = Math.ceil(Math.max((2.5 * P.a * mode.f) / C, 4 * mode.m)), ny = Math.ceil(Math.max((2.5 * P.b * mode.f) / C, 4 * mode.n));
  const dx = P.a / nx, dy = P.b / ny, out = points.map(() => [0, 0]);
  const sx = new Float64Array(nx), sy = new Float64Array(ny);
  for (let i = 0; i < nx; i++) sx[i] = Math.sin((mode.m * Math.PI * (i + 0.5)) / nx);
  for (let j = 0; j < ny; j++) sy[j] = Math.sin((mode.n * Math.PI * (j + 0.5)) / ny);
  for (let q = 0; q < points.length; q++) {
    const [px, py, pz] = points[q], r0 = refs[q];
    let re = 0, im = 0;
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) * dy - py, yz = y * y + pz * pz, wy = sy[j];
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) * dx - px, r = Math.sqrt(x * x + yz), ph = k * (r - r0), w = (sx[i] * wy) / r;
        re += w * Math.cos(ph); im -= w * Math.sin(ph);
      }
    }
    out[q][0] = re * dx * dy; out[q][1] = im * dx * dy;
  }
  return out;
}

function fft(re, im) {
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

// The response (N samples) that has the size mag[0 .. N/2] at every frequency and no delay
// it does not need: every resonance rings from the first sample on.
function minimumPhase(mag, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  let top = 0;
  for (let i = 0; i <= N / 2; i++) if (mag[i] > top) top = mag[i];
  for (let i = 0; i <= N / 2; i++) re[i] = Math.log(Math.max(mag[i], 1e-6 * top));
  for (let i = 1; i < N / 2; i++) re[N - i] = re[i];
  fft(re, im);
  // keep the part of the log spectrum that belongs to a causal response
  for (let i = 0; i < N; i++) { re[i] = (re[i] / N) * (i === 0 || i === N / 2 ? 1 : i < N / 2 ? 2 : 0); im[i] = 0; }
  fft(re, im);
  for (let i = 0; i < N; i++) { const g = Math.exp(re[i]), ph = im[i]; re[i] = g * Math.cos(ph); im[i] = -g * Math.sin(ph); }
  fft(re, im);
  for (let i = 0; i < N; i++) re[i] /= N;
  return re;
}

// The board: { version, fs, modes, irs: 12 Float32Arrays }, the response of the left and of
// the right microphone to a force on each of the six places on the bridge (irs[2 z], irs[2 z + 1]).
//
// For every frequency the energies of the resonances are added: what a microphone hears on
// average. Added with their true delays, the resonances add up or cancel at the microphone
// by chance, differently for every pitch: neighbouring keys then differ in loudness by
// 4.5 dB on average and up to 23 dB, which no piano does. (In a real piano the strings feel
// the board, which evens this out; here they do not.)
export function buildBoard(fs, P = BOARD) {
  const modes = plateModes(P, Math.min(P.top, 0.45 * fs));
  const points = [...P.mics, ...P.mics.map((p) => mirrored(p, P.lid))], modal = (P.mass * P.a * P.b) / 4;
  // frequencies at which the energy is summed: close enough for the narrowest resonance
  const grid = [];
  for (let f = 20; f < 0.5 * fs; f += Math.max(0.5, 0.004 * f)) grid.push(f);
  const power = [];
  for (let i = 0; i < 12; i++) power.push(new Float64Array(grid.length));
  const zero = points.map(() => 0);
  let g0 = 0;
  for (const mode of modes) {
    const w = 2 * Math.PI * mode.f, half = 0.5 * Math.max(P.loss, P.width / mode.f) * mode.f;   // half width, Hz
    const R = radiation(mode, points, zero, P);
    while (g0 < grid.length && grid[g0] < mode.f - 100 * half) g0++;
    for (let z = 0; z < 6; z++) {
      const [bx, by] = P.bridge[z], drive = Math.sin((mode.m * Math.PI * bx) / P.a) * Math.sin((mode.n * Math.PI * by) / P.b);
      // pressure for a force of 1 N: rho / 2 pi x the acceleration of the resonance, summed over the board
      const amp = ((RHO / (2 * Math.PI)) * drive * w) / modal;
      for (let q = 0; q < 2; q++) {
        // the microphone, and the lid's copy of it
        const a2 = amp * amp * (R[q][0] ** 2 + R[q][1] ** 2 + P.lid.reflect ** 2 * (R[q + 2][0] ** 2 + R[q + 2][1] ** 2)), out = power[2 * z + q];
        for (let i = g0; i < grid.length && grid[i] < mode.f + 100 * half; i++) { const d = (grid[i] - mode.f) / half; out[i] += a2 / (1 + d * d) / (half * half); }
      }
    }
  }
  let N = 1;
  while (N < 2.5 * fs) N <<= 1;
  const len = Math.floor(P.seconds * fs), fade = Math.floor(0.05 * fs), irs = [];
  let peak = 0;
  for (const pw of power) {
    const mag = new Float64Array(N / 2 + 1);
    let k = 0;
    for (let i = 1; i <= N / 2; i++) {
      const f = (i * fs) / N;
      if (f < grid[0] || f > grid[grid.length - 1]) continue;
      while (k + 2 < grid.length && grid[k + 1] < f) k++;
      const t = (f - grid[k]) / (grid[k + 1] - grid[k]);
      mag[i] = Math.sqrt(pw[k] + t * (pw[k + 1] - pw[k])) * Math.pow(10, chainGain(f) / 20);
    }
    const h = minimumPhase(mag, N).subarray(0, len);
    for (let i = 0; i < fade; i++) h[len - 1 - i] *= i / fade;
    for (let i = 0; i < len; i++) if (Math.abs(h[i]) > peak) peak = Math.abs(h[i]);
    irs.push(h);
  }
  // one scale for all twelve: the loudest of them peaks at 1
  return { version: MODEL_VERSION, fs, modes: modes.length, irs: irs.map((h) => { const o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = h[i] / peak; return o; }) };
}
