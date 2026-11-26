// The soundboard: what two microphones hear when the strings push on the bridge.
//
// The board is one plate with the same stiffness everywhere: spruce and its ribs spread
// evenly, a rectangle of the area of a concert grand's board. Its resonances are known in
// closed form (about 1100 of them up to 10 kHz, or ~1500 up to 14 kHz in high-fidelity mode).
// Each one moves the air: its motion is summed over the surface of the board towards each
// microphone, once directly and once by way of the open lid. The result is a stereo impulse
// response for each of six places on the bridge, bass to treble: the string engine sends each
// the force it gets there.
//
// What this leaves out: the shape of a real board and its bridges, ribs as separate beams
// (above about 1 kHz the waves of a real board stay between them), the case and the air
// under the board, the sound from the underside. The strings do not feel these resonances:
// what they lose to the bridge is fitted in the string engine.
//
// Building takes a second or two; it is done in a worker with progress updates and cached in
// IndexedDB per configuration (see js/audio.js).

export const MODEL_VERSION = 11;

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
const REF_PEAK_48K = 0.089788;  // raw peak of the default Concert Grand board at 48 kHz

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

// Map instrument fidelity & body controls onto a BOARD configuration. Returns BOARD itself
// when every setting is at its default.
export function boardConfig(inst) {
  if (!inst) return BOARD;
  const hiFi = Boolean(inst.hiFi);
  const size = clamp(num(inst.bodySize, 1), 0.65, 1.45);
  const stiff = clamp(num(inst.bodyStiff, 0), -0.6, 0.6);
  const crown = clamp(num(inst.bodyCrown, 38), 20, 58);
  const res = clamp(num(inst.bodyRes, 0), -0.6, 0.6);
  const lidDeg = clamp(num(inst.bodyLid, 35), 0, 55);
  if (
    !hiFi &&
    Math.abs(size - 1) < 1e-4 &&
    Math.abs(stiff) < 1e-4 &&
    Math.abs(crown - 38) < 1e-3 &&
    Math.abs(res) < 1e-4 &&
    Math.abs(lidDeg - 35) < 1e-3
  ) return BOARD;
  const sk = Math.pow(2, stiff), rk = Math.pow(2, res);
  const openShare = clamp(lidDeg / 25, 0, 1);
  const a = BOARD.a * size, b = BOARD.b * size;
  return {
    a, b,
    mass: BOARD.mass,
    Dx: BOARD.Dx * sk, Dy: BOARD.Dy * sk, H: BOARD.H * sk,
    crown,
    loss: BOARD.loss / rk,
    width: BOARD.width / Math.sqrt(rk),
    top: hiFi ? 14000 : BOARD.top,
    bridge: BOARD.bridge.map(([x, y]) => [x * size, y * size]),
    mics: [[a + 0.7, 1.25 * size, 1.0], [a + 0.7, 0.35 * size, 1.0]],
    lid: { height: 0.3, angle: lidDeg, reflect: 0.9 * (0.2 + 0.8 * openShare) },
    seconds: Math.min(2.4, (hiFi ? 1.8 : 1.2) * Math.sqrt(rk)),
    same: BOARD.same,
    hiFi,
    lidShade: 9 * (1 - openShare),
    sig: `${hiFi ? 1 : 0}:${size.toFixed(3)}:${stiff.toFixed(3)}:${crown.toFixed(1)}:${res.toFixed(3)}:${lidDeg.toFixed(1)}`,
  };
}

export function boardSignature(P = BOARD) {
  if (!P || P === BOARD) return 'default';
  if (P.sig) return P.sig;
  return `${P.hiFi ? 1 : 0}:${P.a.toFixed(3)}:${P.b.toFixed(3)}:${P.Dx.toFixed(1)}:${P.crown.toFixed(1)}:${P.loss.toFixed(5)}:${P.lid.angle.toFixed(1)}`;
}

// THE MICROPHONE CHAIN. Not computed: a response [Hz, dB] matched to a recording, on top of
// what the board model gives the microphones. It stands for everything between the strings
// and a finished recording that the model leaves out or gets wrong.
// Matched to the long-term third-octave spectrum of a studio recording of a grand (Bach,
// Goldberg Variations, variation 22, Kimiko Ishizaka, CC0): the mean of six demos against it,
// `node tools/song.mjs` and test/tone.test.mjs. With it the demos are within 5 dB of the
// recording from 80 Hz to 10 kHz.
export const CHAIN = [[50, -10], [100, -9], [125, -4], [160, -6], [250, -2], [400, -1], [500, -4], [630, -3], [800, 0], [1000, 0], [1250, -2], [1600, -3], [2000, -6], [2500, -11], [3200, -15], [4000, -14], [5000, -14], [6300, -19], [8000, -20], [10000, -20], [16000, -22]];
export function chainGain(f, tab = CHAIN) {
  if (!tab.length) return 0;
  if (f <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) if (f <= tab[i][0]) { const [f0, g0] = tab[i - 1], [f1, g1] = tab[i]; return g0 + ((g1 - g0) * Math.log(f / f0)) / Math.log(f1 / f0); }
  return tab[tab.length - 1][1];
}

// Closed-lid high-frequency acoustic shade (0 dB when open >= 25°, up to -9 dB above 4.5 kHz at 0°).
function lidGainDb(f, shade) {
  if (!(shade > 0) || f <= 350) return 0;
  const u = Math.min(1, Math.log(f / 350) / Math.log(4500 / 350));
  return -shade * u * u * (3 - 2 * u);
}

// Glued-rim clamped beam mode shape normalized so mean(phi²) = 1/2 (matching sin²).
function clampedShape(m, u) {
  const s2 = Math.SQRT1_2;
  if (m === 1) {
    const b = 4.730040744862704, lam = (Math.cosh(b) - Math.cos(b)) / (Math.sinh(b) - Math.sin(b));
    return (Math.cosh(b * u) - Math.cos(b * u) - lam * (Math.sinh(b * u) - Math.sin(b * u))) * s2;
  }
  const b = (m + 0.5) * Math.PI;
  return Math.sin(b * u - 0.25 * Math.PI) + Math.exp(-b * u) * s2 - ((m & 1 ? -1 : 1) * Math.exp(-b * (1 - u)) * s2);
}

// Resonances of the plate: [{ m, n, f }] up to `top` Hz, lowest first. The edges of a
// soundboard are glued to the case: the frequencies are those of a plate held at its edges
// (m + 1/2 half waves instead of m).
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
  const k = (2 * Math.PI * mode.f) / C, hiFi = Boolean(P.hiFi);
  const dens = hiFi ? 3.2 : 2.5, per = hiFi ? 5 : 4;
  const nx = Math.ceil(Math.max((dens * P.a * mode.f) / C, per * mode.m)), ny = Math.ceil(Math.max((dens * P.b * mode.f) / C, per * mode.n));
  const dx = P.a / nx, dy = P.b / ny, out = points.map(() => [0, 0]);
  const sx = new Float64Array(nx), sy = new Float64Array(ny);
  if (hiFi) {
    for (let i = 0; i < nx; i++) sx[i] = clampedShape(mode.m, (i + 0.5) / nx);
    for (let j = 0; j < ny; j++) sy[j] = clampedShape(mode.n, (j + 0.5) / ny);
  } else {
    for (let i = 0; i < nx; i++) sx[i] = Math.sin((mode.m * Math.PI * (i + 0.5)) / nx);
    for (let j = 0; j < ny; j++) sy[j] = Math.sin((mode.n * Math.PI * (j + 0.5)) / ny);
  }
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

// The board: { version, fs, modes, gain, irs: 14 Float32Arrays }, the response of the left
// and of the right microphone to a force on each of the six places on the bridge (irs[2 z],
// irs[2 z + 1]), and to a knock of the action (irs[12], irs[13]).
export function buildBoard(fs, P = BOARD, onProgress = null) {
  const hiFi = Boolean(P.hiFi), shade = P.lidShade || 0;
  const top = Math.min(P.top, 0.45 * fs), modes = plateModes(P, top);
  const points = [...P.mics, ...P.mics.map((p) => mirrored(p, P.lid))], modal = (P.mass * P.a * P.b) / 4;
  // frequencies at which the energy is summed: close enough for the narrowest resonance
  const grid = [];
  for (let f = 20; f < 0.5 * fs; f += Math.max(0.5, 0.004 * f)) grid.push(f);
  const power = [], coherent = [];
  let N = 1;
  while (N < Math.max(2.5, P.seconds * 1.5) * fs) N <<= 1;
  for (let i = 0; i < 2; i++) coherent.push(new Float64Array(N));
  for (let i = 0; i < 12; i++) power.push(new Float64Array(grid.length));
  const zero = points.map(() => 0);
  const cohWeights = hiFi ? [0, 0.2, 0.35, 0.3, 0.15, 0] : [0, 0, 1, 0, 0, 0];
  if (onProgress) onProgress(0);
  let g0 = 0;
  for (let idx = 0; idx < modes.length; idx++) {
    if (onProgress && (idx & 23) === 0) onProgress(0.82 * (idx / Math.max(1, modes.length)));
    const mode = modes[idx];
    const w = 2 * Math.PI * mode.f, half = 0.5 * Math.max(P.loss, P.width / mode.f) * mode.f;   // half width, Hz
    // for the delays each resonance rings as long as its loss lets it, not widened
    const sigma = Math.PI * P.loss * mode.f, ring = Math.min(N, Math.ceil((9.2 / sigma) * fs));   // until it is 80 dB down
    const g = Math.exp(-sigma / fs), cr = g * Math.cos(w / fs), ci = g * Math.sin(w / fs);
    const R = radiation(mode, points, zero, P);
    while (g0 < grid.length && grid[g0] < mode.f - 100 * half) g0++;
    let c0r = 0, c0i = 0, c1r = 0, c1i = 0, hasCoh = false;
    for (let z = 0; z < 6; z++) {
      const [bx, by] = P.bridge[z];
      const drive = hiFi
        ? clampedShape(mode.m, bx / P.a) * clampedShape(mode.n, by / P.b)
        : Math.sin((mode.m * Math.PI * bx) / P.a) * Math.sin((mode.n * Math.PI * by) / P.b);
      // pressure for a force of 1 N: rho / 2 pi x the acceleration of the resonance, summed over the board
      const amp = ((RHO / (2 * Math.PI)) * drive * w) / modal;
      // time runs from when the sound of this place on the bridge reaches the nearer microphone
      const near = Math.min(Math.hypot(P.mics[0][0] - bx, P.mics[0][1] - by, P.mics[0][2]), Math.hypot(P.mics[1][0] - bx, P.mics[1][1] - by, P.mics[1][2]));
      const turn = (w / C) * near, tc = Math.cos(turn), ts = Math.sin(turn), cw = cohWeights[z];
      for (let q = 0; q < 2; q++) {
        // the microphone, and the lid's copy of it; below the resonance the plate is held by
        // its stiffness, so its acceleration falls with f² (its power with f⁴)
        const a2 = amp * amp * (R[q][0] ** 2 + R[q][1] ** 2 + P.lid.reflect ** 2 * (R[q + 2][0] ** 2 + R[q + 2][1] ** 2)), out = power[2 * z + q];
        for (let i = g0; i < grid.length && grid[i] < mode.f + 100 * half; i++) {
          const gf = grid[i], d = (gf - mode.f) / half, low = gf < mode.f ? (gf / mode.f) ** 4 : 1;
          out[i] += (a2 * low) / (1 + d * d) / (half * half);
        }
        if (cw === 0 || drive * drive < 1e-8) continue;
        const sr = R[q][0] + P.lid.reflect * R[q + 2][0], si = R[q][1] + P.lid.reflect * R[q + 2][1];
        const re = sr * tc - si * ts, im = sr * ts + si * tc;
        if (q === 0) { c0r += cw * (-im * amp); c0i += cw * (re * amp); }
        else { c1r += cw * (-im * amp); c1i += cw * (re * amp); }
        hasCoh = true;
      }
    }
    if (hasCoh) {
      for (let q = 0; q < 2; q++) {
        let ur = q === 0 ? c0r : c1r, ui = q === 0 ? c0i : c1i;
        if (ur * ur + ui * ui < 1e-30) continue;
        const coh = coherent[q];
        for (let t = 0; t < ring; t++) { coh[t] += ur; const v = ur * cr - ui * ci; ui = ur * ci + ui * cr; ur = v; }
      }
    }
  }
  // An open grand has no baffle: below the frequency where a wave wraps round the board
  // (k * radius = 1, about 67 Hz here), the air moved by the underside cancels the top.
  const fDip2 = (C / (2 * Math.sqrt(Math.PI * P.a * P.b))) ** 2;
  for (const pw of power) for (let i = 0; i < grid.length; i++) pw[i] *= (grid[i] * grid[i]) / (grid[i] * grid[i] + fDip2);
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
  for (let idx = 0; idx < power.length; idx++) {
    const pw = power[idx], z = idx >> 1, q = idx & 1;
    const [bx, by] = P.bridge[z];
    const dMic = Math.hypot(P.mics[q][0] - bx, P.mics[q][1] - by, P.mics[q][2]);
    const near = Math.min(Math.hypot(P.mics[0][0] - bx, P.mics[0][1] - by, P.mics[0][2]), Math.hypot(P.mics[1][0] - bx, P.mics[1][1] - by, P.mics[1][2]));
    const haasLag = hiFi ? (dMic - near) / C : 0;
    const mag = new Float64Array(N / 2 + 1);
    // above the computed resonances the board goes on as it is on average just below them
    let above = 0, cnt = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > 0.6 * top && grid[i] < 0.9 * top) { above += pw[i]; cnt++; }
    above /= Math.max(1, cnt);
    let k = 0;
    for (let i = 1; i <= N / 2; i++) {
      const f = (i * fs) / N;
      if (f < grid[0] || f > grid[grid.length - 1]) continue;
      while (k + 2 < grid.length && grid[k + 1] < f) k++;
      const t = (f - grid[k]) / (grid[k + 1] - grid[k]);
      mag[i] = Math.sqrt(f > 0.9 * top ? above : pw[k] + t * (pw[k + 1] - pw[k])) * Math.pow(10, (chainGain(f) + lidGainDb(f, shade)) / 20);
    }
    // the size from the energy sum; the delays from the sum with true delays
    const cr = Float64Array.from(coherent[q]), ci = new Float64Array(N);
    fft(cr, ci);
    const size = new Float64Array(N / 2 + 1);
    for (let i = 0; i <= N / 2; i++) size[i] = Math.hypot(cr[i], ci[i]);
    const short = minimumPhase(mag, N), shortOwn = minimumPhase(size, N), re = new Float64Array(N), im = new Float64Array(N);
    let was = 0, turns = 0;
    for (let i = 0; i <= N / 2; i++) {
      // the extra delay, followed from one frequency to the next so that it can be scaled
      const raw = Math.atan2(ci[i], cr[i]) - shortOwn[i];
      turns += Math.round((was - raw) / (2 * Math.PI)); was = raw;
      const f = (i * fs) / N, u = Math.min(1, Math.max(0, (f - P.same[0]) / (P.same[1] - P.same[0])), Math.max(0, (0.9 * top - f) / (0.1 * top)));
      const su = u * u * (3 - 2 * u);
      const uHaas = su * clamp((1200 - f) / 500, 0, 1);
      const ph = short[i] + su * (raw + 2 * Math.PI * turns) - 2 * Math.PI * f * haasLag * uHaas;
      re[i] = mag[i] * Math.cos(ph); im[i] = -mag[i] * Math.sin(ph);
      if (i > 0 && i < N / 2) { re[N - i] = re[i]; im[N - i] = -im[i]; }
    }
    fft(re, im);
    const h = new Float64Array(len);
    for (let i = 0; i < len; i++) h[i] = re[i] / N;
    for (let i = 0; i < fade; i++) h[len - 1 - i] *= i / fade;
    for (let i = 0; i < len; i++) if (Math.abs(h[i]) > peak) peak = Math.abs(h[i]);
    irs.push(h);
    if (onProgress) onProgress(0.82 + 0.18 * ((idx + 1) / 14));
  }
  // The knocks of the action get a response of their own (13th and 14th): the sum with true
  // delays and true loss as it is, so that it rings as long as a board does.
  for (let q = 0; q < 2; q++) {
    const re = coherent[q], im = new Float64Array(N);
    fft(re, im);
    let e = 0;
    for (let i = 0; i <= N / 2; i++) {
      const f = (i * fs) / N, g = f < 20 ? 0 : Math.pow(10, (chainGain(f) + lidGainDb(f, shade)) / 20);
      re[i] *= g; im[i] *= -g;
      if (f > 200 && f < 2000) e += re[i] * re[i] + im[i] * im[i];
      if (i > 0 && i < N / 2) { re[N - i] = re[i]; im[N - i] = -im[i]; }
    }
    fft(re, im);
    const even = irs[4 + q], ere = new Float64Array(N), eim = new Float64Array(N);
    ere.set(even); fft(ere, eim);
    let want = 0;
    for (let i = 0; i <= N / 2; i++) { const f = (i * fs) / N; if (f > 200 && f < 2000) want += ere[i] * ere[i] + eim[i] * eim[i]; }
    const scale = Math.sqrt(want / Math.max(e, 1e-30)), h = new Float64Array(len);
    for (let i = 0; i < len; i++) h[i] = (re[i] / N) * scale;
    for (let i = 0; i < fade; i++) h[len - 1 - i] *= i / fade;
    for (let i = 0; i < len; i++) if (Math.abs(h[i]) > peak) peak = Math.abs(h[i]);
    irs.push(h);
    if (onProgress) onProgress(0.82 + 0.18 * ((12 + q + 1) / 14));
  }
  const gain = P === BOARD ? 1 : clamp((peak / (REF_PEAK_48K * (48000 / fs))) * (hiFi ? 0.854 : 1), 0.2, 1.8);
  // one scale for all of them: the loudest peaks at 1; `gain` preserves relative loudness across bodies
  return {
    version: MODEL_VERSION, fs, modes: modes.length, gain,
    irs: irs.map((h) => { const o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = h[i] / peak; return o; }),
  };
}
