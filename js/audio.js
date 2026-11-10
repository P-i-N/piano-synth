// Audio graph: string engine worklet -> soundboard -> delay / reverb -> master.
// After vibetar's js/audio.js; the delay, reverb and master sections are the same.

import { makeReverbIR } from './ir.js';
import { DELAY_TIMES, eventsBetween, songEnd, tickSecs } from './song.js';
import { MODEL_VERSION } from './board/model.js';

// (the version in the address makes a browser fetch the engine again when the model changes:
// an old engine with a new page would send six channels where seven are expected)
const WORKLET_URL = new URL(`./worklet.js?v=${MODEL_VERSION}`, import.meta.url).href;
const irCache = new Map();
// level of the instrument on the bus
export const LEVEL = 1.5;
// The soundboard's responses peak at 1; this brings a medium note through them to the
// A-weighted loudness it had without them (measured: 13.1 dB less, mean of C2 to C6).
export const BOARD_LEVEL = 0.221;
// Until the soundboard is built (about a second, the first time): the force on the bridge
// as it is, each of the six places only set between the speakers, bass left.
export const DIRECT = { pan: [-0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0] };

// ---- the soundboard: built once in a worker, kept in IndexedDB ---------------------

export const cacheKey = (fs) => `board:${MODEL_VERSION}:${fs}`;

// is this (possibly cached) record a usable soundboard for this sample rate?
export function validBoard(rec, fs) {
  if (!rec || typeof rec !== 'object' || rec.version !== MODEL_VERSION || rec.fs !== fs) return false;
  if (!Array.isArray(rec.irs) || rec.irs.length !== 14) return false;
  const len = rec.irs[0] && rec.irs[0].length;
  if (!len) return false;
  for (const h of rec.irs) {
    if (!(h instanceof Float32Array) || h.length !== len) return false;
    for (let k = 0; k < 16; k++) if (!Number.isFinite(h[Math.floor((k * (len - 1)) / 15)])) return false;
  }
  return true;
}

function idb(op, key, value) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const open = indexedDB.open('piano-synth', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('boards');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const store = db.transaction('boards', op === 'get' ? 'readonly' : 'readwrite').objectStore('boards');
        const rq = op === 'get' ? store.get(key) : op === 'put' ? store.put(value, key) : store.delete(key);
        rq.onsuccess = () => { resolve(rq.result); db.close(); };
        rq.onerror = () => { reject(rq.error); db.close(); };
      } catch (e) { reject(e); db.close(); }
    };
  });
}

function buildInWorker(fs) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./board/worker.js', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
    w.onmessage = (e) => { w.terminate(); if (e.data && e.data.ok) resolve(e.data.board); else reject(new Error((e.data && e.data.error) || 'soundboard model failed')); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'soundboard worker failed')); };
    w.postMessage({ fs });
  });
}

async function loadBoard(fs) {
  const key = cacheKey(fs), cached = await idb('get', key).catch(() => null);
  if (validBoard(cached, fs)) return cached;
  if (cached) idb('delete', key).catch(() => {}); // stale or damaged: never used
  // without module workers the board is built here, which blocks the page for a moment
  const board = await buildInWorker(fs).catch(async () => (await import('./board/model.js')).buildBoard(fs));
  if (!validBoard(board, fs)) throw new Error('the soundboard model returned an unusable result');
  idb('put', key, board).catch(() => {});
  return board;
}

const boards = new Map();
// The soundboard (a promise; built or fetched once per page).
export function getBoard(fs) {
  if (!boards.has(fs)) { const p = loadBoard(fs); p.catch(() => {}); boards.set(fs, p); }
  return boards.get(fs);
}

function toBuffer(ctx, ir) {
  const buf = ctx.createBuffer(2, ir.L.length, ctx.sampleRate);
  buf.copyToChannel(ir.L, 0); buf.copyToChannel(ir.R, 1);
  return buf;
}
function reverbBuffer(ctx, size, tone) {
  const key = `rev:${size.toFixed(2)}:${tone.toFixed(2)}:${ctx.sampleRate}`;
  if (!irCache.has(key)) {
    for (const k of irCache.keys()) if (k.startsWith('rev:')) irCache.delete(k);
    irCache.set(key, makeReverbIR(ctx.sampleRate, size, tone));
  }
  return toBuffer(ctx, irCache.get(key));
}

const engineCfg = (inst) => ({ type: 'cfg', hard: inst.hard, noise: inst.noise });

class Graph {
  constructor(ctx, node) {
    const c = ctx;
    this.ctx = c; this.node = node;
    const gain = (v) => { const g = c.createGain(); g.gain.value = v; return g; };
    // The engine sends seven channels: the force on the bridge at six places, bass to treble,
    // and the knocks of the action. Each goes through its response of the soundboard (two
    // microphones).
    const split = c.createChannelSplitter(7);
    node.connect(split);
    this.direct = gain(1); this.board = gain(0);
    this.zones = [];
    for (let z = 0; z < 7; z++) {
      const pan = c.createStereoPanner(); pan.pan.value = DIRECT.pan[z];
      split.connect(pan, z); pan.connect(this.direct);
      const conv = c.createConvolver(); conv.normalize = false;
      split.connect(conv, z); conv.connect(this.board);
      this.zones.push(conv);
    }
    this.inst = gain(LEVEL);
    this.direct.connect(this.inst); this.board.connect(this.inst);
    this.master = gain(1);
    this.inst.connect(this.master);

    // ping-pong delay
    this.dlySend = gain(0); this.dlySend.channelCount = 1; this.dlySend.channelCountMode = 'explicit';
    this.dL = c.createDelay(3); this.dR = c.createDelay(3);
    this.fbA = gain(0.35); this.fbB = gain(0.35);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3600; lp.Q.value = 0.5;
    const hp2 = c.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 220; hp2.Q.value = 0.5;
    const merge = c.createChannelMerger(2);
    this.dlyOut = gain(1);
    this.inst.connect(this.dlySend); this.dlySend.connect(lp); lp.connect(hp2); hp2.connect(this.dL);
    this.dL.connect(this.fbA); this.fbA.connect(this.dR);
    this.dR.connect(this.fbB); this.fbB.connect(lp);
    this.dL.connect(merge, 0, 0); this.dR.connect(merge, 0, 1);
    merge.connect(this.dlyOut); this.dlyOut.connect(this.master);

    // convolution reverb (two slots for click-free impulse swaps)
    this.revSend = gain(0);
    this.inst.connect(this.revSend);
    const dlyToRev = gain(0.6); this.dlyOut.connect(dlyToRev); dlyToRev.connect(this.revSend);
    this.revSlots = [0, 1].map(() => {
      const conv = c.createConvolver(); conv.normalize = false;
      const g = gain(0);
      this.revSend.connect(conv); conv.connect(g); g.connect(this.master);
      return { conv, g };
    });
    this.revSlot = 0; this.revKey = '';

    // master: volume, then a transparent soft clipper as a safety net
    // (linear below -4 dBFS, smoothly saturating above)
    this.vol = gain(0.8);
    const pre = gain(0.5);
    const clip = c.createWaveShaper();
    const curve = new Float32Array(4097);
    for (let i = 0; i < curve.length; i++) {
      const x = ((i / 4096) * 2 - 1) * 2, a = Math.abs(x);
      curve[i] = Math.sign(x) * (a < 0.62 ? a : 0.62 + 0.36 * Math.tanh((a - 0.62) / 0.36));
    }
    clip.curve = curve; clip.oversample = '2x';
    this.out = clip;
    this.master.connect(this.vol); this.vol.connect(pre); pre.connect(clip); clip.connect(c.destination);
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 2048;
    clip.connect(this.analyser);
  }

  setInstrument(inst) { this.node.port.postMessage(engineCfg(inst)); }

  // the soundboard is heard from now on, in place of the bare force on the bridge
  loadBoard(board, now) {
    for (let z = 0; z < 7; z++) this.zones[z].buffer = toBuffer(this.ctx, { L: board.irs[2 * z], R: board.irs[2 * z + 1] });
    const t = this.ctx.currentTime;
    if (now) { this.board.gain.setTargetAtTime(BOARD_LEVEL, t, 0.03); this.direct.gain.setTargetAtTime(0, t, 0.03); }
    else { this.board.gain.setValueAtTime(BOARD_LEVEL, 0); this.direct.gain.setValueAtTime(0, 0); }
  }

  setFx(fx, bpm, now) {
    const t = now ? this.ctx.currentTime : 0;
    const set = (p, v, tc = 0.03) => (now ? p.setTargetAtTime(v, t, tc) : p.setValueAtTime(v, 0));
    set(this.vol.gain, fx.vol * fx.vol * 1.25);
    set(this.dlySend.gain, fx.dlyOn ? fx.dlyMix * 1.4 : 0);
    const fb = Math.min(0.9, fx.dlyFb);
    set(this.fbA.gain, fb); set(this.fbB.gain, fb);
    const dt = Math.min(2.9, (60 / bpm) * (DELAY_TIMES[fx.dlyTime] || 0.75));
    set(this.dL.delayTime, dt, 0.08); set(this.dR.delayTime, dt, 0.08);
    set(this.revSend.gain, fx.revOn ? fx.revMix * 1.15 : 0);
    const key = `${fx.revSize.toFixed(2)}:${fx.revTone.toFixed(2)}`;
    if (key !== this.revKey) {
      this.revKey = key;
      const buf = reverbBuffer(this.ctx, fx.revSize, fx.revTone);
      if (!now) {
        this.revSlots[0].conv.buffer = buf; this.revSlots[0].g.gain.setValueAtTime(1, 0);
      } else {
        const old = this.revSlots[this.revSlot];
        this.revSlot ^= 1;
        const cur = this.revSlots[this.revSlot];
        cur.conv.buffer = buf;
        cur.g.gain.cancelScheduledValues(t); cur.g.gain.setTargetAtTime(1, t, 0.06);
        old.g.gain.cancelScheduledValues(t); old.g.gain.setTargetAtTime(0, t, 0.06);
      }
    }
  }
}

export class AudioEngine {
  constructor() { this.ctx = null; this.graph = null; this.ready = null; this.song = null; this.boardReady = Promise.resolve(); this.onNotice = null; }

  // must first be called from a user gesture
  init() {
    if (!this.ready) {
      this.ready = (async () => {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new Ctx({ latencyHint: 'interactive' });
        await this.ctx.audioWorklet.addModule(WORKLET_URL);
        const node = new AudioWorkletNode(this.ctx, 'piano-strings', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [7] });
        this.graph = new Graph(this.ctx, node);
        if (this.song) { this.graph.setInstrument(this.song.inst); this.graph.setFx(this.song.fx, this.song.bpm, false); }
        this.boardReady = getBoard(this.ctx.sampleRate).then((b) => this.graph.loadBoard(b, true), (err) => {
          console.warn('soundboard unavailable:', err);
          if (this.onNotice) this.onNotice('The soundboard could not be built in this browser');
        });
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ready;
  }

  get running() { return !!this.graph; }
  get time() { return this.ctx ? this.ctx.currentTime : 0; }
  get latency() { return this.ctx ? (this.ctx.outputLatency || this.ctx.baseLatency || 0) : 0; }

  setSong(song) { this.song = song; this.syncInstrument(); this.syncFx(); }
  syncInstrument() { if (this.graph && this.song) this.graph.setInstrument(this.song.inst); }
  syncFx() { if (this.graph && this.song) this.graph.setFx(this.song.fx, this.song.bpm, true); }

  send(events) { if (this.graph && events.length) this.graph.node.port.postMessage({ type: 'batch', events }); }
  // drop everything scheduled
  flush() { if (this.graph) this.graph.node.port.postMessage({ type: 'flush' }); }
  // silence: drop everything scheduled, all keys and the pedal up
  hush() {
    if (!this.graph) return;
    this.flush();
    this.graph.node.port.postMessage({ type: 'O' });
  }

  level() {
    if (!this.graph) return 0;
    const a = this.graph.analyser;
    if (!this.buf) this.buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (let i = 0; i < this.buf.length; i++) { const v = Math.abs(this.buf[i]); if (v > p) p = v; }
    return p;
  }
}

// Render the whole song to an AudioBuffer (for WAV export). list: what the keys and the pedal
// do, from compile() or perform().
export async function renderSong(song, list, sampleRate = 48000) {
  const lead = 0.05, tail = Math.min(14, (song.fx.revOn ? song.fx.revSize : 0) + 6);
  const dur = lead + songEnd(song) * tickSecs(song) + tail;
  // the soundboard must be there before rendering starts
  const board = await getBoard(sampleRate);
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
  await ctx.audioWorklet.addModule(WORKLET_URL);
  const events = eventsBetween(song, list, 0, Infinity, lead);
  // at the end every key and the pedal come up
  events.push({ type: 'O', t: dur - tail + 0.5 });
  const node = new AudioWorkletNode(ctx, 'piano-strings', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [7],
    processorOptions: { cfg: engineCfg(song.inst), events },
  });
  const graph = new Graph(ctx, node);
  graph.loadBoard(board, false);
  graph.setFx(song.fx, song.bpm, false);
  // fade the ring-out at the very end
  const v = graph.vol.gain.value;
  graph.vol.gain.setValueAtTime(v, dur - 2);
  graph.vol.gain.linearRampToValueAtTime(0, dur);
  return ctx.startRendering();
}

export function wavBlob(buffer) {
  const nc = buffer.numberOfChannels, n = buffer.length, fs = buffer.sampleRate;
  const chans = [];
  let peak = 0;
  for (let c = 0; c < nc; c++) {
    const d = buffer.getChannelData(c); chans.push(d);
    for (let i = 0; i < n; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  }
  const g = peak > 0.98 ? 0.98 / peak : 1;
  const view = new DataView(new ArrayBuffer(44 + n * nc * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * nc * 2, true); str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nc, true);
  view.setUint32(24, fs, true); view.setUint32(28, fs * nc * 2, true);
  view.setUint16(32, nc * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    view.setInt16(o, Math.round(Math.max(-1, Math.min(1, chans[c][i] * g)) * 32767), true); o += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}
