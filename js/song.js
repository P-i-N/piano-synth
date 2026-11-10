// Song model, link (de)serialisation and playback compilation.
//
// A song is a list of notes, as in a piano roll: { t: start, d: length, m: key, v: velocity }.
// Times are in ticks, 480 to a quarter note; keys are MIDI numbers 21 (A0) .. 108 (C8);
// velocities 1 .. 127. (vibetar's song is a grid of columns; a piano roll needs free lengths,
// and a MIDI file maps onto this one to one.)

export const PPQ = 480;
export const LO = 21, HI = 108;
export const MAX_NOTES = 20000;

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
export const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

// Snap grids: steps to a quarter note.
export const GRIDS = [[1, '1/4'], [2, '1/8'], [3, '1/8 triplets'], [4, '1/16'], [6, '1/16 triplets'], [8, '1/32']];

export const INSTRUMENT = { hard: 0, human: 1, humanOn: 1, noise: 1 };
// Order of the settings in a link. New settings go at the end; a retired setting keeps its
// place (null), so old links still load.
const INST_KEYS = ['hard', 'human', 'humanOn', 'noise'];
// How much of the player's feel is played: `human` is the amount, `humanOn` (1 or 0) the
// switch next to the tempo. Switched off, the song is played exactly as written.
export const humanOf = (inst) => (inst.humanOn === 0 ? 0 : inst.human);

// Reverb spaces: mix, decay (RT60 in seconds) and tone. "Room" is the default.
export const REVERBS = {
  none: { name: 'None', revOn: false },
  room: { name: 'Room', revOn: true, revMix: 0.16, revSize: 0.6, revTone: 0.45 },
  studio: { name: 'Studio', revOn: true, revMix: 0.2, revSize: 1.2, revTone: 0.6 },
  stage: { name: 'Stage', revOn: true, revMix: 0.26, revSize: 2.2, revTone: 0.5 },
  hall: { name: 'Concert hall', revOn: true, revMix: 0.32, revSize: 3.2, revTone: 0.48 },
  church: { name: 'Church', revOn: true, revMix: 0.38, revSize: 4.8, revTone: 0.4 },
  cathedral: { name: 'Cathedral', revOn: true, revMix: 0.44, revSize: 7.5, revTone: 0.34 },
};
export const FX_DEFAULTS = {
  revOn: true, revMix: 0.16, revSize: 0.6, revTone: 0.45,
  dlyOn: false, dlyTime: '8d', dlyFb: 0.35, dlyMix: 0.22, vol: 0.8,
};
const FX_KEYS = ['revOn', 'revMix', 'revSize', 'revTone', 'dlyOn', 'dlyTime', 'dlyFb', 'dlyMix', 'vol'];
// the reverb space these settings are, or '' when they have been changed by hand
export function reverbSpace(fx) {
  if (!fx.revOn) return 'none';
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  return Object.keys(REVERBS).find((k) => {
    const r = REVERBS[k];
    return r.revOn && near(r.revMix, fx.revMix) && near(r.revSize, fx.revSize) && near(r.revTone, fx.revTone);
  }) || '';
}
// set the reverb to a space; "none" only turns it off, so the last settings come back
export function setReverbSpace(fx, key) {
  const r = REVERBS[key];
  if (!r) return;
  fx.revOn = r.revOn;
  if (r.revOn) Object.assign(fx, { revMix: r.revMix, revSize: r.revSize, revTone: r.revTone });
}
export const DELAY_TIMES = { '4': 1, '4d': 1.5, '8': 0.5, '8d': 0.75, '8t': 1 / 3, '16': 0.25 };

export function newSong() {
  return {
    title: 'Untitled', bpm: 100, bpb: 4, grid: 4,
    notes: [],        // sorted by start
    pedal: [],        // sustain pedal down: [start, end] in ticks, sorted, not overlapping
    loop: null,       // loop region [start, end] in ticks, or null: the whole song
    inst: { ...INSTRUMENT },
    fx: { ...FX_DEFAULTS },
  };
}

export const barTicks = (song) => song.bpb * PPQ;
export const gridTicks = (song) => PPQ / song.grid;
export const tickSecs = (song) => 60 / song.bpm / PPQ;
export function sortNotes(song) { song.notes.sort((a, b) => a.t - b.t || a.m - b.m); }
// the tick at which the last note or pedal ends
export function songEnd(song) {
  let end = 0;
  for (const n of song.notes) if (n.t + n.d > end) end = n.t + n.d;
  for (const p of song.pedal) if (p[1] > end) end = p[1];
  return end;
}
// length of the song in ticks: whole bars, at least four
export function songTicks(song) {
  const bar = barTicks(song);
  return Math.max(4, Math.ceil(songEnd(song) / bar)) * bar;
}

// ---- the sustain pedal lane -----------------------------------------------------

// press (down = true) or release the pedal from tick a to tick b
export function setPedal(song, a, b, down) {
  if (b < a) [a, b] = [b, a];
  const out = [];
  for (const [s, e] of song.pedal) {
    if (e < a || s > b) { out.push([s, e]); continue; }
    if (down) { a = Math.min(a, s); b = Math.max(b, e); }
    else { if (s < a) out.push([s, a]); if (e > b) out.push([b, e]); }
  }
  if (down && b > a) out.push([a, b]);
  song.pedal = out.sort((x, y) => x[0] - y[0]);
}
export const pedalAt = (song, t) => song.pedal.some(([s, e]) => t >= s && t < e);

// ---- link encoding -----------------------------------------------------------

const r3 = (x) => Math.round(x * 1000) / 1000;
const num = (x, lo, hi, d) => (typeof x === 'number' && isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
const int = (x, lo, hi, d) => Math.round(num(x, lo, hi, d));

// notes as one flat list: start (ticks after the note before), length, key, velocity
export function packSong(song) {
  const n = [];
  let last = 0;
  for (const x of song.notes) { n.push(x.t - last, x.d, x.m, x.v); last = x.t; }
  return {
    v: 1, t: song.title, b: song.bpm, g: [song.grid, song.bpb], n,
    p: song.pedal.flat(), l: song.loop || 0,
    i: INST_KEYS.map((k) => (k ? r3(song.inst[k]) : 0)),
    x: FX_KEYS.map((k) => (typeof song.fx[k] === 'number' ? r3(song.fx[k]) : typeof song.fx[k] === 'boolean' ? +song.fx[k] : song.fx[k])),
  };
}

export function unpackSong(p) {
  const song = newSong();
  if (!p || typeof p !== 'object') throw new Error('bad song data');
  song.title = String(p.t ?? 'Untitled').slice(0, 80);
  song.bpm = num(p.b, 30, 300, 100);
  const g = Array.isArray(p.g) ? p.g : [];
  song.grid = GRIDS.some(([s]) => s === g[0]) ? g[0] : 4;
  song.bpb = int(g[1], 1, 12, 4);
  const n = Array.isArray(p.n) ? p.n : [];
  let t = 0;
  for (let i = 0; i + 3 < n.length && song.notes.length < MAX_NOTES; i += 4) {
    t += int(n[i], 0, 1e9, 0);
    song.notes.push({ t, d: int(n[i + 1], 1, 1e7, PPQ), m: int(n[i + 2], LO, HI, 60), v: int(n[i + 3], 1, 127, 80) });
  }
  sortNotes(song);
  const pd = Array.isArray(p.p) ? p.p : [];
  for (let i = 0; i + 1 < pd.length; i += 2) {
    const a = int(pd[i], 0, 1e9, 0), b = int(pd[i + 1], 0, 1e9, 0);
    if (b > a) setPedal(song, a, b, true);
  }
  if (Array.isArray(p.l) && p.l.length === 2) {
    const a = int(p.l[0], 0, 1e9, 0), b = int(p.l[1], 0, 1e9, 0);
    if (b > a) song.loop = [a, b];
  }
  if (Array.isArray(p.i)) INST_KEYS.forEach((k, j) => { if (k) song.inst[k] = num(p.i[j], -1, 60, INSTRUMENT[k]); });
  if (Array.isArray(p.x)) {
    FX_KEYS.forEach((k, j) => {
      const d = FX_DEFAULTS[k], v = p.x[j];
      if (typeof d === 'boolean') song.fx[k] = v == null ? d : !!v;
      else if (typeof d === 'number') song.fx[k] = num(v, 0, 12, d);
      else song.fx[k] = DELAY_TIMES[v] ? v : d;
    });
  }
  return song;
}

const b64u = {
  enc(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

// "z…" = deflate-raw + base64url, "j…" = plain JSON + base64url
export async function encodeSong(song) {
  const bytes = new TextEncoder().encode(JSON.stringify(packSong(song)));
  if (typeof CompressionStream === 'function') {
    try { return 'z' + b64u.enc(await pipe(bytes, new CompressionStream('deflate-raw'))); } catch (e) { /* fall through */ }
  }
  return 'j' + b64u.enc(bytes);
}

export async function decodeSong(str) {
  const kind = str[0];
  let bytes = b64u.dec(str.slice(1));
  if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  else if (kind !== 'j') throw new Error('unknown link format');
  return unpackSong(JSON.parse(new TextDecoder().decode(bytes)));
}

// ---- playback compilation ----------------------------------------------------

// What the keys and the pedal do, in order: { tick, type, m, v } with the engine's event
// types (n key down, o key up, p pedal). A key comes up when its note ends, or just before
// the same key is struck again. At one tick: keys up, then the pedal, then keys down.
const ORDER = { o: 0, p: 1, n: 2 };
export function compile(song) {
  const out = [], open = new Map();
  for (const n of song.notes) {
    const prev = open.get(n.m);
    if (prev && prev.tick > n.t) prev.tick = n.t;
    out.push({ tick: n.t, type: 'n', m: n.m, v: n.v / 127 });
    const up = { tick: n.t + n.d, type: 'o', m: n.m };
    out.push(up); open.set(n.m, up);
  }
  for (const [s, e] of song.pedal) out.push({ tick: s, type: 'p', v: 1 }, { tick: e, type: 'p', v: 0 });
  out.sort((a, b) => a.tick - b.tick || ORDER[a.type] - ORDER[b.type]);
  return out;
}

// Engine events for the compiled list between two ticks; tick `from` sounds at time t0 (seconds).
export function eventsBetween(song, list, from, to, t0) {
  const k = tickSecs(song), out = [];
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].tick < from) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < list.length && list[i].tick < to; i++) {
    const e = list[i], ev = { type: e.type, t: t0 + (e.tick - from) * k };
    if (e.m != null) ev.m = e.m;
    if (e.v != null) ev.v = e.v;
    out.push(ev);
  }
  return out;
}

// the whole song as engine events, starting at t0 seconds (offline rendering, tests)
export function songEvents(song, t0 = 0) {
  return eventsBetween(song, compile(song), 0, Infinity, t0);
}
