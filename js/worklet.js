// piano-synth string engine: a physically modelled grand piano.
//
//   * every string is a digital waveguide: a delay loop with a loss filter, a chain of
//     allpass filters for stiffness (stretched partials) and one more allpass for the
//     fraction of a sample the pitch needs
//   * a note has one, two or three strings, a little out of tune with each other. They meet
//     at the bridge, which moves with the sum of their forces: what the strings do together
//     is drained quickly (the prompt sound), what they do against each other stays (the
//     aftersound). That is the beating and the two-stage decay of a piano note.
//   * the hammer is a mass thrown at the strings. Its felt is a nonlinear spring with
//     hysteresis: force = K (u + a du/dt), u = compression^p. A harder blow compresses the
//     felt further, where it is stiffer: a shorter contact and a brighter note.
//   * a damper is a loss switched on when the key comes up (the top notes have none);
//     the sustain pedal keeps all dampers up
// The engine computes the force of the strings on the bridge, in six parts along the bridge
// (bass to treble). The soundboard is applied outside of the worklet.
//
// Designed for, not built yet: every bridge force also goes to one shared bus. Sympathetic
// resonance (pedal down) will be a small bank of resonators fed from that bus, not 230
// waveguides: those cannot run in real time in JavaScript.
//
// The filter design functions come from vibetar's string engine (js/worklet.js there).
//
// This file is loaded both as an AudioWorklet module and (for offline tests) as a plain
// ES module.

const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- filter helpers (from vibetar) ---------------------------------------------

// The loss filter: a first-order shelf  H(z) = (1-m) + m (1-a) / (1 - a z^-1).
// m = 1 is a one-pole lowpass; a smaller m stops the loss from growing above the corner.
function shelf(a, m, w) {
  const c = Math.cos(w), d = 1 - 2 * a * c + a * a;
  return { re: 1 - m + (m * (1 - a) * (1 - a * c)) / d, im: (-m * (1 - a) * a * Math.sin(w)) / d };
}
function lpMag(a, m, w) { const h = shelf(a, m, w); return Math.hypot(h.re, h.im); }
function lpDelay(a, m, w) { const h = shelf(a, m, w); return -Math.atan2(h.im, h.re) / w; } // phase delay in samples
// first-order allpass  H(z) = (c + z^-1) / (1 + c z^-1), phase delay in samples
function apDelay(c, w) {
  const s = Math.sin(w), co = Math.cos(w);
  return -(Math.atan2(-s, c + co) - Math.atan2(-c * s, 1 + c * co)) / w;
}

// The pitch needs a loop that is not a whole number of samples long. The fraction is a
// first-order allpass: it delays without taking anything away. (vibetar reads its loop with a
// fifth-order Lagrange interpolator, because its pitches glide. That one takes up to 0.5 % of
// a partial at 8 kHz on each trip round the string, by an amount that changes from note to
// note; a piano string's highs last long enough for that to be heard, and its pitch stays.)
// Returns the coefficient that delays by d samples (0.1 .. 1.1) at the frequency w.
function fractionalDelay(d, w) {
  let lo = -0.3, hi = 0.95;
  for (let i = 0; i < 40; i++) { const c = 0.5 * (lo + hi); if (apDelay(c, w) > d) lo = c; else hi = c; }
  return 0.5 * (lo + hi);
}

// Fit the loss filter (pole a, depth m) and the loop gain g so that a string at f0 decays
// with rate sigma(f) = b1 + b3 f^2 / (1 + (f / flat)^2)  (amplitude ~ exp(-sigma t)).
// flat = 0: the loss grows with the square of the frequency throughout (a one-pole lowpass).
function designDamping(f0, b1, b3, fs, flat = 0) {
  const w0 = (TAU * f0) / fs;
  const fh = Math.min(0.42 * fs, Math.max(5 * f0, 3500));
  const wh = (TAU * fh) / fs;
  const sigma = (f) => b1 + (b3 * f * f) / (flat ? 1 + (f / flat) ** 2 : 1);
  const s0 = sigma(f0), sh = sigma(fh);
  const G0 = Math.exp(-s0 / f0);
  const ratio = Math.exp(-(sh - s0) / f0);
  const drop = (a, m) => lpMag(a, m, wh) / lpMag(a, m, w0);
  let a = flat ? Math.exp((-TAU * flat) / fs) : 0, m = 1;
  if (flat && drop(a, 1) < ratio) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) {
      m = 0.5 * (lo + hi);
      if (drop(a, m) > ratio) lo = m; else hi = m;
    }
  } else {
    let lo = 0, hi = 0.995;
    for (let i = 0; i < 30; i++) {
      a = 0.5 * (lo + hi);
      if (drop(a, 1) > ratio) lo = a; else hi = a;
    }
  }
  return { a, m, g: Math.min(0.99999, G0 / lpMag(a, m, w0)) };
}

// Stiffness: M equal first-order allpass sections in the loop delay the low partials more
// than the high ones. Returns the section coefficient c that puts partials 2..K closest to
// f_k = k f sqrt((1 + B k²) / (1 + B)), the fundamental being tuned exactly by the delay line.
const MAX_SECTIONS = 16;
const partialsFitted = (f) => Math.max(2, Math.min(40, Math.floor(6000 / f)));
function sectionsFor(f, B, fs) {
  const N = fs / f, K = partialsFitted(f);
  return clamp(Math.ceil((N * (1 - 1 / Math.sqrt(1 + B * K * K))) / 3), 1, MAX_SECTIONS);
}
function designDispersion(f, B, M, a, m, fs) {
  const N = fs / f, K = partialsFitted(f);
  const w1 = (TAU * f) / fs;
  const err = (c) => {
    const at1 = lpDelay(a, m, w1) + M * apDelay(c, w1);
    let e = 0;
    for (let k = 2; k <= K; k++) {
      const fk = k * f * Math.sqrt((1 + B * k * k) / (1 + B)), w = (TAU * fk) / fs;
      if (w > 0.9 * Math.PI) break;
      const need = N - (k * fs) / fk, r = (N + lpDelay(a, m, w) + M * apDelay(c, w) - at1 - (k * fs) / fk) / need;
      e += (r * r) / k;
    }
    return e;
  };
  // golden-section search; stiffness only ever needs a negative coefficient
  let lo = -0.97, hi = 0;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), e1 = err(x1), e2 = err(x2);
  for (let i = 0; i < 40; i++) {
    if (e1 < e2) { hi = x2; x2 = x1; e2 = e1; x1 = hi - g * (hi - lo); e1 = err(x1); }
    else { lo = x1; x1 = x2; e1 = e2; x2 = lo + g * (hi - lo); e2 = err(x2); }
  }
  const c = 0.5 * (lo + hi);
  return err(c) < err(0) ? c : 0;
}

// ---- the piano ---------------------------------------------------------------------
// Keys are MIDI numbers, 21 (A0) to 108 (C8). Tables are [key, value], read by straight
// lines between the entries. They describe the whole note: a note's strings share its
// impedance, hammer mass and felt stiffness equally, so nothing jumps where the number of
// strings changes. Where the values come from (checked against the papers; the entries at
// A0 and C8 are estimates, no source gives them):
//   C+A    Chaigne and Askenfelt, "Numerical simulations of piano strings II" (JASA 1994),
//          table I: strings and hammers of C2, C4 and C7, there for one string of the note
//   Bensa  Bensa, Bilbao, Kronland-Martinet and Smith (JASA 2003), table I: loss of the same
//          notes, and the length of the C2 string (C+A print 1.90 m, which does not give its pitch)
//   Stulov the felt's hysteresis (Stulov and Kartofelev 2009, after Stulov 2005)
//   Rigaud Rigaud, David and Daudet (DAFx 2011): inharmonicity of the plain strings

const LO = 21, HI = 108;
const PIANO = {
  // a Steinway D, as quoted second hand: one string up to E1, two up to A1, three above;
  // wound up to E2
  strings: (m) => (m <= 28 ? 1 : m <= 33 ? 2 : 3),
  wound: 40,          // highest key with copper-wound strings
  lastDamper: 89,     // highest key with a damper (an estimate: grands end between D#6 and G6)
  // wave impedance (tension / wave speed) of all strings of the note, kg/s (C+A; C2 with Bensa's length)
  Z: [[21, 10], [36, 9.3], [60, 6.2], [96, 5.9], [108, 5.7]],
  // hammer mass, kg (C+A)
  hammer: [[21, 0.0106], [36, 0.0098], [60, 0.0089], [96, 0.0066], [108, 0.0058]],
  // Felt: force (N) at half a millimetre of compression, and the exponent p of
  // force ~ compression^p. FITTED, up to C5, to recorded notes of a Steinway B (University of
  // Iowa; `node tools/notes.mjs`): how much more the bands 2-4 and 4-8 kHz gain than the
  // fundamental when a note is played louder. What is fitted is the softness of the felt
  // together with how hard "mf" and "ff" were played: the two cannot be told apart. C+A's
  // felt (20, 76 and 375 N at C2, C4 and C7, p 2.3 to 3.0) gives half of that gain or less
  // below C6, and none at C5. C7 and C8 keep C+A's values: no recording says otherwise.
  feltF: [[21, 15], [72, 15], [96, 375], [108, 600]],
  feltP: [[21, 3], [108, 3]],
  // Felt hysteresis, seconds: the force is K (u + a du/dt), u = compression^p. Stulov's felt
  // remembers its compression for a few microseconds; over a contact a thousand times longer
  // that is this form, with a = (hysteresis x relaxation time) / (1 - hysteresis) = 2.5e-4 s
  // from his numbers. That much makes soft notes nearly as bright as loud ones (it halves the
  // gain above) and the contact longer than measured: a fifth of it is used.
  feltA: 5e-5,
  // where the hammer strikes, as a share of the string's length from the far end (the agraffe)
  strike: [[21, 0.12], [60, 0.12], [96, 0.0625], [108, 0.055]],
  // Loss. FITTED to how the level of recorded loud notes falls in their first eight seconds
  // (a Steinway B, the C of each octave; `node tools/notes.mjs`): about 20 dB quickly, then
  // slowly. The published loss of C2, C4 and C7 (Bensa: 0.25, 1.1 and 9.17 /s) is half as
  // fast as recorded up to C4 and two to three times too fast above.
  // t60: seconds in which the first, quick part of a note would fall by 60 dB
  t60: [[21, 24], [24, 20], [36, 12], [48, 7.5], [60, 3.3], [72, 3.3], [84, 5], [96, 2.4], [108, 1.2]],
  // share of that loss that is the strings' own: what is left for the aftersound
  own: [[21, 0.06], [72, 0.06], [84, 0.12], [108, 0.12]],
  // High-frequency loss: rate = b1 + b3 f² / (1 + (f / flat)²), in 1/s. It stops growing above
  // `flat`: the partials of the recorded notes do not die with the square of their frequency
  // (C4: 20 to 45 dB/s from 260 Hz to 6.5 kHz). Read off scattered data, not fitted key by key.
  b3: 2.9e-7,
  flat: 4000,
  // LEVEL TRIM, dB by key. Not physics: matched to the recorded loud notes (the C of each
  // octave, a Steinway B). Heard through the soundboard, the model's notes from C6 up are about
  // 10 dB louder against C4 than recorded (the felt does not explain it: tried from 15 to
  // 375 N), and its bass notes 3 to 5 dB louder.
  // Only what the engine reports is trimmed, not the strings.
  trim: [[21, -3], [36, -5], [48, -3], [60, 0], [72, -1], [84, -10], [96, -10.5], [108, -14]],
  // a damper on the strings: loss rate, 1/s
  damper: [[21, 12], [60, 35], [89, 60]],
  // The strings of a note are up to this many cents from its pitch (Kirk 1959: one to two
  // cents). Fitted with the loss: more mistuning leaves a louder aftersound.
  detune: [[21, 1.5], [60, 2], [72, 2], [84, 0.8], [108, 0.8]],
  // Sympathetic resonance: how much of the bridge's give at a string is passed on from one
  // place on the bridge to another. An estimate; no recording with the pedal to check it.
  sympathy: 0.5,
  // The strings that ring along (see Sympathy below): the keys up to this one stand for all
  // damped strings; the keys above lastDamper ring along always.
  sympathyBass: 44,
  // THE NOISES OF THE ACTION, as forces on the bridge (N), not modelled parts. The knock of key
  // and hammer when a note is struck is a push and pull of `knockMs` milliseconds: `knock` newtons at
  // a hammer speed of 1 m/s, growing with speed to the power `knockGrow`. Matched to the knock
  // in recorded high notes (C6 to C8, soft to loud), with its noise (vary.knockNoise).
  // A key coming up and the pedal going down or up are softer pushes; the dampers leaving
  // the strings make them whisper for a moment. Those three are estimates.
  knock: 2.1, knockGrow: 1.1, knockMs: 6, keyUp: 0.3, pedalThump: 0.9, damperHiss: 0.3,
  uneven: 0.06,       // and the hammer does not strike them equally hard
  // and they are not equally stiff: B of each string within +- this share of the key's. With
  // equal strings the beat of partial k is k times the fundamental's, and the notches between
  // the beating partials sweep evenly over the spectrum: a flanger. An estimate: at the same
  // pitch B grows with the square of the wire's diameter, made to about 1 %.
  stiff: 0.02,
  // NO TWO STRIKES THE SAME. Each strike draws, evenly within +- these shares: the hammer's
  // speed, the felt's stiffness, the share of the blow each string takes, the knock's size and
  // length. While the felt is on the strings its stiffness has noise of +- feltNoise, below
  // feltNoiseHz. (Above about 1 kHz, even +-3 % adds highs that do not grow with the blow:
  // a soft note is then as bright as a loud one.) knockNoise: noise in the knock against its
  // push and pull.
  // Estimates set by ear: the recordings have one take of each note and strength.
  vary: { speed: 0.03, felt: 0.05, share: 0.06, feltNoise: 0.1, feltNoiseHz: 500, knock: 0.2, knockLen: 0.2, knockNoise: 0.5 },
};
const REF = 5e-4;     // the compression (m) at which feltF is given

function interp(tab, m, log) {
  const y = (v) => (log ? Math.log(v) : v);
  let r;
  if (m <= tab[0][0]) r = y(tab[0][1]);
  else if (m >= tab[tab.length - 1][0]) r = y(tab[tab.length - 1][1]);
  else for (let i = 1; i < tab.length; i++) if (m <= tab[i][0]) {
    const [m0, v0] = tab[i - 1], [m1, v1] = tab[i];
    r = y(v0) + ((y(v1) - y(v0)) * (m - m0)) / (m1 - m0);
    break;
  }
  return log ? Math.exp(r) : r;
}

// a value that is one number for all keys, or a table
const val = (x, m) => (typeof x === 'number' ? x : interp(x, m, true));

// Inharmonicity B of a key: partial k lies at k f sqrt((1 + B k²) / (1 + B)). On the plain
// strings B doubles every seven and a half semitones (Rigaud: exp(0.0926 m - 13.64)); the
// short, thick wound strings raise it again at the bottom. That second part is fitted to
// the recorded C1, C2 and C3 of a Steinway B (2.5, 1.4 and 1.1 x 1e-4).
const inharmonicity = (m) => Math.exp(0.0926 * m - 13.64) + 3.1e-4 * Math.pow(2, -(m - 21) / 8);

// Stretched tuning, in cents from equal temperament at A4 = 440 Hz. Stiff strings have
// sharp partials, so an octave is tuned wide: partial n of the lower note meets partial n/2
// of the upper one: 2:1 from A3 up, 6:3 from E2, 8:4 below. With these the bass comes out as
// on the recorded Steinway B (C1 19 cents under C4, C2 7 cents).
const STRETCH = (() => {
  const octave = (j) => {
    const n = j >= 57 ? 2 : j >= 40 ? 6 : 8, Bj = inharmonicity(j), Bu = inharmonicity(j + 12);
    return 600 * Math.log2(((1 + Bj * n * n) / (1 + Bj)) / ((1 + (Bu * n * n) / 4) / (1 + Bu)));
  };
  const slope = (m) => octave(clamp(m - 6, LO, HI - 12)) / 12; // cents from key m to m + 1
  const c = new Float64Array(128);
  for (let m = 69; m < 127; m++) c[m + 1] = c[m] + slope(m);
  for (let m = 69; m > 0; m--) c[m - 1] = c[m] - slope(m - 1);
  return c;
})();
const keyHz = (m) => 440 * Math.pow(2, (m - 69) / 12 + STRETCH[m] / 1200);

// hammer speed (m/s) for a key velocity 0..1
const hammerSpeed = (v) => 0.25 + 4.75 * Math.pow(clamp(v, 0, 1), 1.6);

// ---- one string ------------------------------------------------------------------

class PString {
  constructor(size) {
    this.b = new Float64Array(size); this.mask = size - 1; this.w = 0;
    this.n0 = 8; this.fc = 0; this.fx = 0; this.fy = 0; // whole samples of delay, and the allpass for the fraction
    this.a = 0; this.a1 = 1; this.m = 1; this.g = 1; this.lp = 0; // loss filter
    this.apN = 0; this.c = 0; this.ax = new Float64Array(MAX_SECTIONS); this.ay = new Float64Array(MAX_SECTIONS);
    this.ha = 1; this.hb = 2;                          // where the hammer strikes: two taps into the loop
    this.share = 1; this.share0 = 1;                   // of the hammer's force: this strike, and the key's own
    this.f = 440;
  }

  // the wave arriving at the bridge
  read() {
    const x = this.b[(this.w - this.n0) & this.mask];
    let r = this.fc * x + this.fx - this.fc * this.fy;
    this.fx = x; this.fy = r;
    const lp = (this.lp = this.a1 * r + this.a * this.lp);
    r = (r + this.m * (lp - r)) * this.g;
    const c = this.c, ax = this.ax, ay = this.ay;
    for (let k = 0, n = this.apN; k < n; k++) {
      const y = c * r + ax[k] - c * ay[k];
      ax[k] = r; ay[k] = y; r = y;
    }
    return r;
  }

  clear() { this.b.fill(0); this.ax.fill(0); this.ay.fill(0); this.lp = 0; this.fx = 0; this.fy = 0; }
}

// ---- one key: its strings, hammer and damper ---------------------------------------

class Voice {
  constructor(m, fs) {
    this.m = m; this.fs = fs;
    this.n = PIANO.strings(m);
    // where on the bridge: between two of the six places the engine reports, a share to each
    const place = ((m - LO) * 5) / (HI - LO);
    this.zone = Math.min(4, Math.floor(place)); this.zoneUp = place - this.zone;
    this.f = keyHz(m);
    this.B = inharmonicity(m);
    const size = 1 << Math.ceil(Math.log2(fs / this.f + 16));
    this.strings = [];
    for (let i = 0; i < this.n; i++) this.strings.push(new PString(size));
    this.hasDamper = m <= PIANO.lastDamper;
    this.active = false; this.keyDown = false; this.dropped = false; this.peak = 0; this.quiet = 0;
    this.dg = 1; this.dgT = 1; this.dgStep = 0; this.dampOn = 1;
    this.kb = 0; this.zs = 1; this.fb = 1;
    // hammer
    this.fresh = 0;
    this.contact = false; this.hv = 0; this.hy = 0; this.sy = 0; this.hu = 0; this.hF = 0; this.hN = 0;
    this.hM = 1; this.hK = 1; this.hP = 2.5; this.hA = 0; this.contactFrames = 0;
    this.design();
  }

  design() {
    const fs = this.fs, m = this.m, n = this.n, f = this.f, B = this.B;
    const rnd = mulberry32(0x9e37 + m * 7919);
    const rate = 6.91 / interp(PIANO.t60, m, true);    // 1/s: the note's first, quick decay
    const own = val(PIANO.own, m), detune = val(PIANO.detune, m);
    // the strings of the note: detuned around its pitch, struck not quite equally
    const det = [], share = [];
    for (let i = 0; i < n; i++) { det.push(n > 1 ? 2 * rnd() - 1 : 0); share.push(1 + PIANO.uneven * (2 * rnd() - 1)); }
    const stiff = [];
    for (let i = 0; i < n; i++) stiff.push(1 + PIANO.stiff * (2 * rnd() - 1));
    const mean = det.reduce((a, x) => a + x, 0) / n, sum = share.reduce((a, x) => a + x, 0) / n;
    const stiffMean = stiff.reduce((a, x) => a + x, 0) / n;
    const apN = sectionsFor(f, B, fs);
    this.strings.forEach((s, i) => {
      s.f = f * Math.pow(2, (detune * (det[i] - mean)) / 1200);
      s.share = s.share0 = share[i] / sum;
      const d = designDamping(s.f, own * rate, PIANO.b3, fs, PIANO.flat);
      s.a = d.a; s.a1 = 1 - d.a; s.m = d.m; s.g = d.g;
      const c = designDispersion(f, (B * stiff[i]) / stiffMean, apN, d.a, d.m, fs);
      s.apN = c ? apN : 0; s.c = c;
      const w = (TAU * s.f) / fs, N = fs / s.f;
      const D = Math.max(2.2, N - lpDelay(s.a, s.m, w) - s.apN * apDelay(c, w));
      s.n0 = Math.floor(D - 0.1);
      s.fc = fractionalDelay(D - s.n0, w);
      // The loop is the string unrolled: bridge -> far end -> bridge. A point x samples (there
      // and back) from the bridge is passed after a and after b samples; the loop filters
      // (delay tau) sit at the bridge. The hammer strikes close to the far end.
      const x = N * (1 - interp(PIANO.strike, m)), tau = N - s.n0;
      let a = Math.max(1, Math.round((x - tau) / 2)), b = a + Math.max(1, Math.round(N - x));
      if (b > s.n0 - 1) { b = s.n0 - 1; if (a >= b) a = b - 1; }
      s.ha = a; s.hb = b;
    });
    // The bridge gives way to the sum of the string forces: with g = (bridge mobility x string
    // impedance), its velocity is 2 g sum(u) / (1 + n g), which every string's reflection
    // loses. What the strings do together loses 1 - (1 - n g) / (1 + n g) for each trip.
    const rho = Math.exp((-(1 - own) * rate) / f), ng = (1 - rho) / (1 + rho);
    this.kb = (2 * ng) / n / (1 + ng);
    this.zs = interp(PIANO.Z, m, true) / n;            // each string's impedance
    this.fb = this.zs * Math.pow(10, interp(PIANO.trim, m) / 20); // bridge force = zs (2 sum(u) - n vb), trimmed
    this.hM = interp(PIANO.hammer, m, true) / n;       // each string's share of the hammer
    this.hP = interp(PIANO.feltP, m);
    this.hK = interp(PIANO.feltF, m, true) / n / Math.pow(REF, this.hP);
    this.hA = val(PIANO.feltA, m) * fs;
    this.dampOn = this.hasDamper ? Math.exp(-interp(PIANO.damper, m, true) / f) : 1;
  }

  // the hammer is thrown at the strings; v: key velocity 0..1, hard: felt hardness -1..1,
  // rnd: random source 0..1 for what differs from strike to strike
  strike(v, hard, rnd) {
    const vary = PIANO.vary, u = () => 2 * rnd() - 1;
    this.hv = hammerSpeed(v) * (1 + vary.speed * u()); this.hy = 0; this.sy = 0; this.hu = 0; this.hF = 0; this.hN = 0;
    this.hard = Math.pow(3, hard || 0) * (1 + vary.felt * u());
    let sum = 0;
    for (const s of this.strings) { s.share = s.share0 * (1 + vary.share * u()); sum += s.share; }
    for (const s of this.strings) s.share *= this.n / sum;
    this.rnd = rnd; this.fn = 0; this.fnA = Math.exp((-TAU * vary.feltNoiseHz) / this.fs);
    this.contact = true;
    this.keyDown = true; this.dropped = false;
    this.dg = this.dgT = 1;                            // the damper is up before the hammer arrives
    this.quiet = 0;
    this.fresh = Math.ceil((2 * this.fs) / this.f);    // samples until the blow has been round the string
  }

  // the key comes up (or the pedal, with the key already up): the damper falls on the strings
  damp() {
    if (!this.hasDamper) return;
    this.dgT = this.dampOn;
    this.dgStep = (1 - this.dampOn) / (0.03 * this.fs);
  }
  lift() { this.dgT = 1; this.dgStep = (1 - this.dampOn) / (0.01 * this.fs); }
  // a voice taken for another note fades in a few trips round the string
  drop() { this.dropped = true; this.keyDown = false; this.contact = false; this.dgT = Math.min(this.dampOn, 0.5); this.dgStep = 1; }

  // One sample of the hammer on the strings. The felt force F depends on the compression,
  // which depends on F in the same sample (the string gives way by F / 2Z at once): solved
  // for F by bisection, so the stiff felt of the top notes cannot blow up.
  hammerTick() {
    const ss = this.strings, n = this.n, T = 1 / this.fs;
    let vin = 0;
    for (let i = 0; i < n; i++) {
      const s = ss[i], b = s.b, m = s.mask, w = s.w - 1;
      vin += b[(w - s.ha) & m] - b[(w - s.hb) & m];
    }
    vin /= n;
    // the felt's noise: white noise through a one-pole lowpass, within +-1
    this.fn = this.fnA * this.fn + (1 - this.fnA) * (2 * this.rnd() - 1);
    const K = this.hK * this.hard * (1 + PIANO.vary.feltNoise * this.fn), p = this.hP, A = 1 + this.hA, Bc = this.hA * this.hu;
    const xi0 = this.hy + this.hv * T - this.sy - vin * T;   // compression if there were no force
    const c = (T * T) / this.hM + T / (2 * this.zs);         // how far a force opens the gap in one sample
    let F = 0;
    if (xi0 > 0) {
      let lo = 0, hi = K * (A * Math.pow(xi0, p) - Bc);
      if (hi > 0) {
        for (let i = 0; i < 32; i++) {
          F = 0.5 * (lo + hi);
          const xi = xi0 - c * F;
          if (F > (xi > 0 ? K * (A * Math.pow(xi, p) - Bc) : 0)) hi = F; else lo = F;
        }
        F = 0.5 * (lo + hi);
      }
    }
    const dv = F / (2 * this.zs);
    this.hv -= (F * T) / this.hM;
    this.hy += this.hv * T;
    this.sy += (vin + dv) * T;
    const xi = this.hy - this.sy;
    this.hu = xi > 0 ? Math.pow(xi, p) : 0;
    this.hF = F;
    if (dv !== 0) for (let i = 0; i < n; i++) {
      const s = ss[i], b = s.b, m = s.mask, w = s.w - 1, d = dv * s.share;
      b[(w - s.ha) & m] += d; b[(w - s.hb) & m] -= d;
    }
    this.hN++;
    // the hammer has left the strings and falls back
    if ((xi <= 0 && this.hv < 0) || this.hN > 0.03 * this.fs) { this.contact = false; this.contactFrames = this.hN; }
  }

  // add the force on the bridge for samples [from, to) to acc
  run(acc, up, from, to) {
    const ss = this.strings, n = this.n, kb = this.kb, fb = this.fb;
    const s0 = ss[0], s1 = n > 1 ? ss[1] : null, s2 = n > 2 ? ss[2] : null;
    const wUp = this.zoneUp, wLo = 1 - wUp;
    let pk = this.peak, dg = this.dg;
    for (let i = from; i < to; i++) {
      const u0 = s0.read(), u1 = s1 ? s1.read() : 0, u2 = s2 ? s2.read() : 0;
      const sum = u0 + u1 + u2, vb = kb * sum;
      if (dg !== this.dgT) {
        if (dg > this.dgT) { dg -= this.dgStep; if (dg < this.dgT) dg = this.dgT; }
        else { dg += this.dgStep; if (dg > this.dgT) dg = this.dgT; }
      }
      let y = (u0 - vb) * dg;
      if (y < 1e-18 && y > -1e-18) y = 0;
      s0.b[s0.w] = y; s0.w = (s0.w + 1) & s0.mask;
      if (s1) { y = (u1 - vb) * dg; if (y < 1e-18 && y > -1e-18) y = 0; s1.b[s1.w] = y; s1.w = (s1.w + 1) & s1.mask; }
      if (s2) { y = (u2 - vb) * dg; if (y < 1e-18 && y > -1e-18) y = 0; s2.b[s2.w] = y; s2.w = (s2.w + 1) & s2.mask; }
      if (this.contact) this.hammerTick();
      const a = sum < 0 ? -sum : sum;
      if (a > pk) pk = a;
      const force = fb * (2 * sum - n * vb);
      acc[i] += wLo * force; up[i] += wUp * force;
    }
    this.peak = pk; this.dg = dg;
  }

  clear() {
    for (const s of this.strings) s.clear();
    this.contact = false; this.dropped = false; this.peak = 0; this.quiet = 0; this.dg = this.dgT = 1;
  }
}

// ---- engine ----------------------------------------------------------------------

// ---- sympathetic resonance -----------------------------------------------------------
// With the pedal down every string of the piano is free and rings with what the bridge does.
// About 230 strings cannot run in real time here. Instead one string of each of the 24
// lowest keys rings along: their many partials lie close to every pitch above them (after
// Lehtonen and others, 2007, who use the twelve lowest). The top strings, which have no
// dampers, ring along always: one string for each of those keys.
// The bridge moves under the force of the played notes; a share of that motion (PIANO.sympathy)
// reaches every string here. What these strings send back to the bridge is heard, but does
// not drive the others: the bank cannot feed itself.
class Sympathy {
  constructor(fs) {
    this.list = [];
    for (let m = LO; m <= HI; m++) {
      if (m > PIANO.sympathyBass && m <= PIANO.lastDamper) continue;
      const v = new Voice(m, fs), s = v.strings[0];
      // the bridge's give at this string for a force elsewhere on the bridge: kb / (2 zs) is
      // its give for the string's own force
      this.list.push({ v, s, damped: v.hasDamper, gx: (PIANO.sympathy * v.kb) / (2 * v.zs), dg: v.hasDamper ? v.dampOn : 1, peak: 0, idle: true });
    }
  }

  // bus: the force of the played notes on the bridge; acc: the engine's six channels
  run(bus, acc, n, pedal, busPeak) {
    for (const r of this.list) {
      const s = r.s, v = r.v, target = r.damped && !pedal ? v.dampOn : 1;
      // a string under its damper, or one that nothing reaches, is left alone
      if (r.idle && (target < 1 || busPeak < 1e-7)) continue;
      if (r.gx === 0) continue;
      r.idle = false;
      const lo = acc[v.zone], up = acc[v.zone + 1], wUp = v.zoneUp, wLo = 1 - wUp, kb = v.kb, fb = v.fb, gx = r.gx, step = (1 - v.dampOn) / (0.03 * v.fs);
      let dg = r.dg, pk = 0;
      for (let i = 0; i < n; i++) {
        const u = s.read(), vb = kb * u;
        if (dg !== target) { if (dg > target) { dg -= step; if (dg < target) dg = target; } else { dg += step; if (dg > target) dg = target; } }
        let y = (u - vb - gx * bus[i]) * dg;
        if (y < 1e-18 && y > -1e-18) y = 0;
        s.b[s.w] = y; s.w = (s.w + 1) & s.mask;
        const a = u < 0 ? -u : u;
        if (a > pk) pk = a;
        const force = fb * (2 * u - vb);
        lo[i] += wLo * force; up[i] += wUp * force;
      }
      r.dg = dg; r.peak = pk;
      if (pk < SILENT * 0.01 && busPeak < 1e-7) { s.clear(); r.idle = true; }
    }
  }

  clear() { for (const r of this.list) { r.s.clear(); r.idle = true; r.dg = r.damped ? r.v.dampOn : 1; } }
}

const MAX_VOICES = 48;  // notes ringing at once; beyond that the quietest released note goes
const SILENT = 3e-6;    // string velocity (m/s) below which a note is over: 110 dB under mf

class PianoEngine {
  // rnd: random source 0..1 (Math.random; a seeded one for renders that repeat)
  constructor(fs, rnd = Math.random) {
    this.fs = fs;
    this.queue = []; this.qh = 0;
    this.voices = new Array(128).fill(null);
    for (let m = LO; m <= HI; m++) this.voices[m] = new Voice(m, fs);
    this.live = [];
    this.pedal = false;
    this.P = { hard: 0, noise: 1 };
    this.thumps = []; this.hiss = 0; this.rnd = rnd;
    // the knocks' noise: white noise through two one-pole lowpasses at 1 kHz (one lets too much
    // through at 8 kHz), scaled to the RMS of their push and pull
    const ka = (this.knA = Math.exp((-TAU * 1000) / fs));
    this.knS = Math.sqrt((1.5 * (1 - ka * ka) ** 3) / ((1 - ka) ** 4 * (1 + ka * ka)));
    this.acc = [0, 1, 2, 3, 4, 5, 6].map(() => new Float64Array(128));
    this.bus = new Float64Array(128);
    this.sympathy = new Sympathy(fs);
    this.dcx = new Float64Array(7); this.dcy = new Float64Array(7);
    this.dcR = 1 - (TAU * 12) / fs;
    this.outGain = 0.0054;
  }

  // c: { hard: felt hardness -1 .. 1 }
  configure(c) {
    if (c.hard != null) this.P.hard = clamp(c.hard, -1, 1);
    if (c.noise != null) this.P.noise = clamp(c.noise, 0, 1);
  }

  // events: n key down { m, v }, o key up { m }, p sustain pedal { v: 0 | 1 },
  //         O all keys and the pedal up, R silence at once
  post(ev) {
    const q = this.queue;
    if (ev.t != null) ev.frame = Math.round(ev.t * this.fs);
    else if (ev.frame == null) ev.frame = 0;
    let i = q.length;
    while (i > this.qh && q[i - 1].frame > ev.frame) i--;
    if (i === q.length) q.push(ev); else q.splice(i, 0, ev);
  }

  flush() { this.queue.length = 0; this.qh = 0; }

  // a push of `amp` newtons lasting `ms`, with noise: a knock of the action
  thump(v, amp, ms) {
    if (!v || !(this.P.noise > 0) || this.thumps.length > 64) return;
    const vary = PIANO.vary, u = () => 2 * this.rnd() - 1;
    amp *= 1 + vary.knock * u(); ms *= 1 + vary.knockLen * u();
    this.thumps.push({ amp: amp * this.P.noise, i: 0, n: Math.max(8, Math.round((ms * this.fs) / 1000)), lp: 0, lp2: 0 });
  }

  wake(v) {
    if (v.active) return;
    let ringing = 0;
    for (const x of this.live) if (!x.dropped) ringing++;
    if (ringing >= MAX_VOICES) {
      // the quietest note whose key is up; if every key is down, the quietest
      let victim = null;
      for (const x of this.live) if (!x.dropped && !x.keyDown && (!victim || x.peak < victim.peak)) victim = x;
      if (!victim) for (const x of this.live) if (!x.dropped && (!victim || x.peak < victim.peak)) victim = x;
      victim.drop();
    }
    v.active = true; v.peak = 1;
    this.live.push(v);
  }

  handle(ev) {
    const v = this.voices[ev.m];
    switch (ev.type) {
      case 'n':
        if (!v) break;
        this.wake(v);
        v.strike(ev.v, this.P.hard, this.rnd);
        this.thump(v, PIANO.knock * Math.pow(hammerSpeed(ev.v), PIANO.knockGrow), PIANO.knockMs);
        break;
      case 'o':
        if (!v) break;
        if (v.keyDown) this.thump(v, PIANO.keyUp, PIANO.knockMs);
        v.keyDown = false;
        if (!this.pedal && !v.dropped) v.damp();
        break;
      case 'p':
        if (this.pedal !== ev.v > 0) {
          // the pedal's own thump, low on the bridge; going down, the dampers leave the strings
          this.thump(this.voices[LO + 6], PIANO.pedalThump, 3 * PIANO.knockMs);
          if (ev.v > 0) this.hiss = Math.round(0.04 * this.fs);
        }
        this.pedal = ev.v > 0;
        for (const x of this.live) if (!x.keyDown && !x.dropped) { if (this.pedal) x.lift(); else x.damp(); }
        break;
      case 'O':
        this.pedal = false;
        for (const x of this.live) { x.keyDown = false; if (!x.dropped) x.damp(); }
        break;
      case 'R':
        this.pedal = false;
        for (const x of this.live) { x.clear(); x.active = false; x.keyDown = false; }
        this.live.length = 0;
        this.sympathy.clear();
        break;
    }
  }

  // Output: seven channels. Six are the force on the bridge at six places along it, bass to
  // treble (a key lies between two of them and gives each its share); the seventh is the
  // knocks of the action. A single Float32Array instead gets their sum.
  render(out, n, frame0) {
    const q = this.queue, live = this.live, acc = this.acc;
    const multi = Array.isArray(out);
    if (acc[0].length < n) for (let c = 0; c < 7; c++) acc[c] = new Float64Array(n);
    for (let c = 0; c < 7; c++) acc[c].fill(0, 0, n);
    for (const v of live) v.peak = 0;
    let i = 0;
    while (i < n) {
      while (this.qh < q.length && q[this.qh].frame <= frame0 + i) this.handle(q[this.qh++]);
      if (this.qh > 512 && this.qh * 2 > q.length) { q.splice(0, this.qh); this.qh = 0; }
      let end = n;
      if (this.qh < q.length) { const e = q[this.qh].frame - frame0; if (e < end) end = e; }
      for (let k = 0; k < live.length; k++) { const v = live[k]; v.run(acc[v.zone], acc[v.zone + 1], i, end); }
      i = end;
    }
    // the strings that ring along hear the sum of what the played notes do to the bridge
    {
      if (this.bus.length < n) this.bus = new Float64Array(n);
      const bus = this.bus;
      let pk = 0;
      for (let j = 0; j < n; j++) { const x = acc[0][j] + acc[1][j] + acc[2][j] + acc[3][j] + acc[4][j] + acc[5][j]; bus[j] = x; if (x > pk) pk = x; else if (-x > pk) pk = -x; }
      // dampers leaving the strings: a whisper into the strings that ring along
      if (this.hiss > 0) {
        const a = PIANO.damperHiss * this.P.noise;
        for (let j = 0; j < n && this.hiss > 0; j++, this.hiss--) bus[j] += a * (2 * this.rnd() - 1);
        if (a > pk) pk = a;
      }
      this.sympathy.run(bus, acc, n, this.pedal, pk);
      // the knocks of the action
      const ka = this.knA, kn = PIANO.vary.knockNoise * this.knS;
      for (let k = this.thumps.length - 1; k >= 0; k--) {
        const t = this.thumps[k], to = acc[6];
        for (let j = Math.max(0, -t.i); j < n && t.i + j < t.n; j++) {
          const x = (TAU * (t.i + j)) / t.n;
          t.lp = ka * t.lp + (1 - ka) * (2 * this.rnd() - 1);
          t.lp2 = ka * t.lp2 + (1 - ka) * t.lp;
          to[j] += t.amp * (Math.sin(x) + kn * t.lp2) * (0.5 - 0.5 * Math.cos(x));
        }
        t.i += n;
        if (t.i >= t.n) this.thumps.splice(k, 1);
      }
    }
    // notes that have died away give their place back
    for (let k = live.length - 1; k >= 0; k--) {
      const v = live[k];
      // nothing is heard at the bridge until the blow has travelled there: not silence yet
      if (v.fresh > 0) { v.fresh -= n; v.quiet = 0; continue; }
      if (v.contact || v.peak >= SILENT) { v.quiet = 0; continue; }
      if (++v.quiet >= 4) { v.clear(); v.active = false; live.splice(k, 1); }
    }
    const dx = this.dcx, dy = this.dcy, R = this.dcR, g = this.outGain;
    if (!multi) out.fill(0, 0, n);
    for (let c = 0; c < 7; c++) {
      const a = acc[c], o = multi ? out[c] : out;
      let x1 = dx[c], y1 = dy[c];
      for (let j = 0; j < n; j++) {
        const x = a[j], y = x - x1 + R * y1;
        x1 = x; y1 = y;
        if (multi) o[j] = y * g; else o[j] += y * g;
      }
      if (y1 < 1e-20 && y1 > -1e-20) y1 = 0;
      dx[c] = x1; dy[c] = y1;
    }
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('piano-strings', class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.engine = new PianoEngine(sampleRate);
      const po = (options && options.processorOptions) || {};
      if (po.cfg) this.engine.configure(po.cfg);
      if (po.events) for (const ev of po.events) this.engine.post(ev);
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'cfg') this.engine.configure(m);
        else if (m.type === 'flush') this.engine.flush();
        else if (m.type === 'batch') for (const ev of m.events) this.engine.post(ev);
        else this.engine.post(m);
      };
    }
    process(inputs, outputs) {
      const ch = outputs[0];
      if (ch.length >= 7) this.engine.render(ch, ch[0].length, currentFrame);
      else this.engine.render(ch[0], ch[0].length, currentFrame);
      return true;
    }
  });
}

export { PianoEngine, PIANO, mulberry32, LO, HI, keyHz, inharmonicity, hammerSpeed, interp, STRETCH };
