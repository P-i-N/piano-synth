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

export const MODEL_VERSION = 8;

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
  // (This is for the size of the response. How long the board rings is not shortened by it.)
  width: 20,
  top: 10000,                   // Hz: resonances above are not computed
  // where the force of each of the engine's six ranges of keys meets the board: the bass
  // bridge, then along the long bridge to the top
  bridge: [[0.55, 1.2], [0.3, 1.05], [0.5, 0.85], [0.75, 0.62], [1.0, 0.42], [1.2, 0.28]],
  // Two microphones at the open side of the piano, 0.7 m from its edge and a metre above the
  // board, 0.9 m apart: the left one towards the tail, where the bass strings end, the right
  // one towards the keyboard. (Close above the strings, 0.45 m from the board, neighbouring
  // parts of the board reach the two with opposite sign: the lows then cancel in the sum.)
  mics: [[2.1, 1.25, 1.0], [2.1, 0.35, 1.0]],
  // the lid: hinged along the bass side at this height above the board, open by this angle;
  // it throws back this share of the sound
  lid: { height: 0.3, angle: 35, reflect: 0.9 },
  seconds: 1.2,                 // length of the responses
  same: [150, 800],             // Hz: below, both microphones hear the same; above, each its own delays
};
const RHO = 1.2, C = 343;       // air: kg/m³, m/s

// THE MICROPHONE CHAIN. Not computed: a response [Hz, dB] matched to a recording, on top of
// what the board model gives the microphones. It stands for everything between the strings
// and a finished recording that the model leaves out or gets wrong.
// Matched to the long-term third-octave spectrum of a studio recording of a grand (Bach,
// Goldberg Variations, variation 22, Kimiko Ishizaka, CC0): the mean of six demos against it,
// `node tools/song.mjs` and test/tone.test.mjs. With it the demos are within 5 dB of the
// recording from 80 Hz to 10 kHz.
// (A first chain was matched to single recorded notes of another piano, close microphones.
// It left the demos 11 to 16 dB thin at 125 to 160 Hz, 5 to 7 dB too strong from 1 to 2.5 kHz
// and without anything above 10 kHz: heard as muffled and cheap.)
// Most of it is the cut above 2 kHz: the model's strings push on the bridge with far more
// highs than a recorded piano has. Why is not known.
export const CHAIN = [[50, -10], [100, -9], [125, -4], [160, -6], [250, -2], [400, -1], [500, -4], [630, -3], [800, 0], [1000, 0], [1250, -2], [1600, -3], [2000, -6], [2500, -11], [3200, -15], [4000, -14], [5000, -14], [6300, -19], [8000, -20], [10000, -20], [16000, -22]];
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

// The phase (for each of N frequencies) of the response that has the size mag[0 .. N/2] and
// no delay it does not need: every resonance rings from the first sample on.
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
  return im;
}

// The board: { version, fs, modes, irs: 14 Float32Arrays }, the response of the left and of
// the right microphone to a force on each of the six places on the bridge (irs[2 z],
// irs[2 z + 1]), and to a knock of the action (irs[12], irs[13]).
//
// The size of a response at every frequency is the energy sum of the resonances: what a
// microphone hears on average. Added with their true delays, the resonances add up or cancel
// at the microphone by chance, differently for every pitch: neighbouring keys then differ in
// loudness by 4.5 dB on average and up to 23 dB, which no piano does. (In a real piano the
// strings feel the board, which evens this out; here they do not.)
// The delays are true ones all the same: for each microphone the sum with true delays is
// made as well (for the middle of the bridge), and what it has more than the shortest
// response of its own size (its delays, and with them what differs between the two
// microphones) is kept. Without that both microphones would hear nearly the same, and the
// piano would be a point between the speakers. All six places on the bridge get the same
// delays: a key lies between two places, and with different delays the two would cancel
// at some pitches.
export function buildBoard(fs, P = BOARD) {
  const top = Math.min(P.top, 0.45 * fs), modes = plateModes(P, top);
  const points = [...P.mics, ...P.mics.map((p) => mirrored(p, P.lid))], modal = (P.mass * P.a * P.b) / 4;
  // frequencies at which the energy is summed: close enough for the narrowest resonance
  const grid = [];
  for (let f = 20; f < 0.5 * fs; f += Math.max(0.5, 0.004 * f)) grid.push(f);
  const power = [], coherent = [];
  let N = 1;
  while (N < 2.5 * fs) N <<= 1;
  for (let i = 0; i < 2; i++) coherent.push(new Float64Array(N));
  for (let i = 0; i < 12; i++) power.push(new Float64Array(grid.length));
  const zero = points.map(() => 0);
  let g0 = 0;
  for (const mode of modes) {
    const w = 2 * Math.PI * mode.f, half = 0.5 * Math.max(P.loss, P.width / mode.f) * mode.f;   // half width, Hz
    // for the delays each resonance rings as long as its loss lets it, not widened
    const sigma = Math.PI * P.loss * mode.f, ring = Math.min(N, Math.ceil((9.2 / sigma) * fs));   // until it is 80 dB down
    const g = Math.exp(-sigma / fs), cr = g * Math.cos(w / fs), ci = g * Math.sin(w / fs);
    const R = radiation(mode, points, zero, P);
    while (g0 < grid.length && grid[g0] < mode.f - 100 * half) g0++;
    for (let z = 0; z < 6; z++) {
      const [bx, by] = P.bridge[z], drive = Math.sin((mode.m * Math.PI * bx) / P.a) * Math.sin((mode.n * Math.PI * by) / P.b);
      // pressure for a force of 1 N: rho / 2 pi x the acceleration of the resonance, summed over the board
      const amp = ((RHO / (2 * Math.PI)) * drive * w) / modal;
      // time runs from when the sound of this place on the bridge reaches the nearer microphone
      const near = Math.min(Math.hypot(P.mics[0][0] - bx, P.mics[0][1] - by, P.mics[0][2]), Math.hypot(P.mics[1][0] - bx, P.mics[1][1] - by, P.mics[1][2]));
      const turn = (w / C) * near, tc = Math.cos(turn), ts = Math.sin(turn);
      for (let q = 0; q < 2; q++) {
        // the microphone, and the lid's copy of it
        const a2 = amp * amp * (R[q][0] ** 2 + R[q][1] ** 2 + P.lid.reflect ** 2 * (R[q + 2][0] ** 2 + R[q + 2][1] ** 2)), out = power[2 * z + q];
        for (let i = g0; i < grid.length && grid[i] < mode.f + 100 * half; i++) { const d = (grid[i] - mode.f) / half; out[i] += a2 / (1 + d * d) / (half * half); }
        // the same resonance with its true delays: amp x e^(-sigma t) x Re((re + j im) x j e^(j w t))
        if (z !== 2 || drive * drive < 1e-8) continue;
        const sr = R[q][0] + P.lid.reflect * R[q + 2][0], si = R[q][1] + P.lid.reflect * R[q + 2][1];
        const re = sr * tc - si * ts, im = sr * ts + si * tc, coh = coherent[q];
        let ur = -im * amp, ui = re * amp;
        for (let t = 0; t < ring; t++) { coh[t] += ur; const v = ur * cr - ui * ci; ui = ur * ci + ui * cr; ur = v; }
      }
    }
  }
  const len = Math.floor(P.seconds * fs), fade = Math.floor(0.05 * fs), irs = [];
  let peak = 0;
  // Above 200 Hz the energy is averaged over a semitone: a resonance narrower than the step
  // from one key to the next makes one key louder than its neighbours (by up to 9 dB).
  const from = grid.findIndex((f) => f > 200), span = Math.round(Math.log(Math.pow(2, 1 / 24)) / Math.log(1.004));
  for (const pw of power) {
    const raw = Float64Array.from(pw);
    for (let i = from; i < grid.length; i++) {
      let sum = 0, cnt = 0;
      for (let k = Math.max(from, i - span); k <= Math.min(grid.length - 1, i + span); k++) { sum += raw[k]; cnt++; }
      pw[i] = sum / cnt;
    }
  }
  for (const pw of power) {
    const mag = new Float64Array(N / 2 + 1);
    // above the computed resonances the board goes on as it is on average just below them
    let above = 0, cnt = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > 0.6 * top && grid[i] < 0.9 * top) { above += pw[i]; cnt++; }
    above /= cnt;
    let k = 0;
    for (let i = 1; i <= N / 2; i++) {
      const f = (i * fs) / N;
      if (f < grid[0] || f > grid[grid.length - 1]) continue;
      while (k + 2 < grid.length && grid[k + 1] < f) k++;
      const t = (f - grid[k]) / (grid[k + 1] - grid[k]);
      mag[i] = Math.sqrt(f > 0.9 * top ? above : pw[k] + t * (pw[k + 1] - pw[k])) * Math.pow(10, chainGain(f) / 20);
    }
    // the size from the energy sum; the delays from the sum with true delays
    const cr = Float64Array.from(coherent[irs.length % 2]), ci = new Float64Array(N);
    fft(cr, ci);
    const size = new Float64Array(N / 2 + 1);
    for (let i = 0; i <= N / 2; i++) size[i] = Math.hypot(cr[i], ci[i]);
    const short = minimumPhase(mag, N), shortOwn = minimumPhase(size, N), re = new Float64Array(N), im = new Float64Array(N);
    let was = 0, turns = 0;
    for (let i = 0; i <= N / 2; i++) {
      // the extra delay, followed from one frequency to the next so that it can be scaled
      const raw = Math.atan2(ci[i], cr[i]) - shortOwn[i];
      turns += Math.round((was - raw) / (2 * Math.PI)); was = raw;
      // In the lows both microphones get the shortest response, and so the same: the board's
      // parts that move against each other reach them with opposite sign, and the bass would
      // cancel when the channels are added. (A recorded piano's lows are the same in both.)
      // (and above the computed resonances, where there are no delays to take)
      const f = (i * fs) / N, u = Math.min(1, Math.max(0, (f - P.same[0]) / (P.same[1] - P.same[0])), Math.max(0, (0.9 * top - f) / (0.1 * top)));
      const ph = short[i] + u * u * (3 - 2 * u) * (raw + 2 * Math.PI * turns);
      re[i] = mag[i] * Math.cos(ph); im[i] = -mag[i] * Math.sin(ph);
      if (i > 0 && i < N / 2) { re[N - i] = re[i]; im[N - i] = -im[i]; }
    }
    fft(re, im);
    const h = new Float64Array(len);
    for (let i = 0; i < len; i++) h[i] = re[i] / N;
    for (let i = 0; i < fade; i++) h[len - 1 - i] *= i / fade;
    for (let i = 0; i < len; i++) if (Math.abs(h[i]) > peak) peak = Math.abs(h[i]);
    irs.push(h);
  }
  // The knocks of the action get a response of their own (13th and 14th): the sum with true
  // delays and true loss as it is, so that it rings as long as a board does (a resonance at
  // 350 Hz falls by 20 dB in 100 ms). A knock is over in a moment: it does not matter that
  // this response is louder at some pitches than at others. As loud, from 200 Hz to 2 kHz,
  // as the even response of the middle of the bridge.
  for (let q = 0; q < 2; q++) {
    const re = coherent[q], im = new Float64Array(N);
    fft(re, im);
    let e = 0;
    for (let i = 0; i <= N / 2; i++) {
      const f = (i * fs) / N, g = f < 20 ? 0 : Math.pow(10, chainGain(f) / 20);
      re[i] *= g; im[i] *= -g;
      if (f > 200 && f < 2000) e += re[i] * re[i] + im[i] * im[i];
      if (i > 0 && i < N / 2) { re[N - i] = re[i]; im[N - i] = -im[i]; }
    }
    fft(re, im);
    const even = irs[4 + q], ere = new Float64Array(N), eim = new Float64Array(N);
    ere.set(even); fft(ere, eim);
    let want = 0;
    for (let i = 0; i <= N / 2; i++) { const f = (i * fs) / N; if (f > 200 && f < 2000) want += ere[i] * ere[i] + eim[i] * eim[i]; }
    const scale = Math.sqrt(want / e), h = new Float64Array(len);
    for (let i = 0; i < len; i++) h[i] = (re[i] / N) * scale;
    for (let i = 0; i < fade; i++) h[len - 1 - i] *= i / fade;
    for (let i = 0; i < len; i++) if (Math.abs(h[i]) > peak) peak = Math.abs(h[i]);
    irs.push(h);
  }
  // one scale for all of them: the loudest peaks at 1
  return { version: MODEL_VERSION, fs, modes: modes.length, irs: irs.map((h) => { const o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = h[i] / peak; return o; }) };
}
