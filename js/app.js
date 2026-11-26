// piano-synth — UI: piano roll, keyboard, transport, settings, sharing.
// After vibetar's js/app.js: the same persistence, sharing, settings and menus.

import { AudioEngine, renderSong, wavBlob } from './audio.js';
import { parseMidi, midiToSong, songToMidi } from './midi.js';
import { createMidiHub, createMidiRecorder } from './webmidi.js';
import * as S from './song.js';
import { createRoll } from './roll.js';
import { createKeys } from './keys.js';
import { perform } from './player.js';
import { DEMOS } from './demos.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const STORE_KEY = 'piano-synth.song';
const MIDI_KEY = 'piano-synth.midi';

const audio = new AudioEngine();
let song = S.newSong();
const undoStack = [], redoStack = [];

// ---- toast -------------------------------------------------------------------

let toastTimer = 0;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- persistence / sharing ---------------------------------------------------

let saveTimer = 0, savePending = false;
function scheduleSave() {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}
async function save(push) {
  clearTimeout(saveTimer);
  savePending = false;
  const data = await S.encodeSong(song);
  try { localStorage.setItem(STORE_KEY, data); } catch (e) { /* private mode */ }
  const url = '#' + data;
  if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
  document.title = `${song.title || 'Untitled'} — piano-synth`;
}

async function share() {
  await save();
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast(url.length > 6000 ? 'Link copied — it is a long one, some apps may shorten it' : 'Link copied to clipboard');
  } catch (e) {
    window.prompt('Copy this link to share your song:', url);
  }
}

async function loadFromHash() {
  const h = location.hash.slice(1);
  if (h.length < 2) return false;
  try {
    setSong(await S.decodeSong(h));
    return true;
  } catch (e) {
    console.warn(e);
    toast('Could not read the song in this link');
    return false;
  }
}

// ---- undo --------------------------------------------------------------------

const snapshot = () => JSON.stringify({ notes: song.notes, pedal: song.pedal, loop: song.loop });
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
function restore(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  Object.assign(song, JSON.parse(from.pop()));
  roll.refresh();
  changed();
}

// ---- roll and keyboard ---------------------------------------------------------

let hoverTick = null, keysStale = true;
const roll = createRoll($('roll'), {
  before: pushUndo,
  change: changed,
  preview: (m, v) => preview(m, v),
  cursor: () => { keysStale = true; updateStatus(); },
  hover: (t) => { hoverTick = t; keysStale = true; updateStatus(); },
  loop: (region) => { if (region && !player.loop) toggleLoop(); },
});
const keys = createKeys($('keysCanvas'), {
  down: async (m, v) => { keys.down(m, v); midi.send([{ type: 'n', m, v }]); await audio.init(); audio.send([{ type: 'n', t: audio.time + 0.005, m, v }]); },
  up: async (m) => { keys.up(m); midi.send([{ type: 'o', m }]); await audio.init(); audio.send([{ type: 'o', t: audio.time + 0.005, m }]); },
});

// while nothing plays, the keyboard shows the notes under the pointer (or at the cursor)
function showOnKeys() {
  keysStale = false;
  if (player.playing) return;
  const t = hoverTick != null ? hoverTick : roll.cursor, list = [];
  for (const n of song.notes) { if (n.t > t) break; if (t < n.t + n.d) list.push(n); }
  keys.show(list);
}

function updateStatus() {
  const t = hoverTick != null ? hoverTick : roll.cursor, bar = S.barTicks(song);
  const n = song.notes.length;
  const extra = rec.active ? ' · Recording' : rec.armed ? ' · Armed (play a MIDI key)' : '';
  $('status').textContent = `Bar ${Math.floor(t / bar) + 1} · beat ${Math.floor((t % bar) / S.PPQ) + 1} · ${n} note${n === 1 ? '' : 's'}${extra}`;
}

// What the keys and the pedal do: as written, or as the player plays it (the same
// performance for as long as the song plays, also when it is edited meanwhile).
function performance_() {
  const h = S.humanOf(song.inst);
  return h > 0 ? perform(song, { seed: player.seed, loop: player.loop, human: h }) : S.compile(song);
}

// notes, pedal or loop changed
function changed() {
  if (player.playing && !rec.active) player.list = performance_();
  keysStale = true;
  updateStatus();
  if (!rec.active) scheduleSave();
}

// ---- audio preview -----------------------------------------------------------

// one note on its own, as the editor plays it when it is drawn or moved
async function preview(m, vel) {
  if (player.playing) return;
  await audio.init();
  const t = audio.time + 0.01;
  const evs = [{ type: 'n', t, m, v: vel / 127 }, { type: 'o', t: t + 0.4, m }];
  audio.send(evs);
  midi.send(evs, audio.time, performance.now());
}

// ---- transport & live MIDI recording -----------------------------------------

// The audio context, and the soundboard (progress is shown in #boardProg / #bodyProg).
async function ready() {
  await audio.init();
  await audio.boardReady;
}

// tick `baseTick` sounds at audio time `baseTime`; events are sent up to tick `tick`
const player = { playing: false, loop: false, list: [], tick: 0, end: 0, baseTick: 0, baseTime: 0, k: 0, timer: 0, queue: [], segs: [], ended: false, endTime: Infinity };
let recStartedPlay = false;

const rec = createMidiRecorder({
  before(s) {
    const wasEmpty = s.notes.length === 0;
    pushUndo();
    // a live performance played by a person is not humanized again
    if (wasEmpty && s.inst.humanOn !== 0) { s.inst.humanOn = 0; syncSongControls(); }
  },
  change(done) {
    roll.refresh();
    keysStale = true;
    updateStatus();
    if (done) {
      if (player.playing) player.list = performance_();
      scheduleSave();
    }
  },
});

function syncRecUi() {
  const b = $('rec');
  b.setAttribute('aria-pressed', rec.active ? 'true' : 'false');
  if (rec.armed) b.dataset.state = 'armed'; else delete b.dataset.state;
  updateStatus();
}

function heardTick() {
  if (!player.playing || !audio.running || !player.segs.length) return roll.cursor;
  const now = audio.time - audio.latency;
  let seg = player.segs[0];
  for (let i = 1; i < player.segs.length && player.segs[i].time <= now; i++) seg = player.segs[i];
  return Math.max(seg.tick, seg.tick + (now - seg.time) / player.k);
}

function playRange() {
  if (player.loop && song.loop) return song.loop;
  if (rec.active) return player.loop ? [0, S.songTicks(song)] : [0, Infinity];
  return [0, S.songEnd(song)];
}

// ticks by which a humanized note may come before its written place (40 ms)
const lead = () => (S.humanOf(song.inst) > 0 ? 0.04 / S.tickSecs(song) : 0);

function beginTransport(fromTop, immediate) {
  const [from, to] = playRange();
  let start = fromTop ? 0 : roll.cursor;
  if (start < from || start >= to) start = from;
  player.seed = (Math.random() * 0x7fffffff) | 0;
  // the player may strike a note a moment before it is written: start that much earlier
  const pre = immediate ? 0 : lead();
  start -= pre;
  const t0 = audio.time + (immediate ? 0 : 0.08);
  Object.assign(player, { playing: true, list: performance_(), tick: start, baseTick: start, baseTime: t0, k: S.tickSecs(song), queue: [], segs: [], ended: false, endTime: Infinity });
  player.segs.push({ time: t0, tick: start });
  keys.show([]);
  if (S.pedalAt(song, start)) sendAt([{ type: 'p', t: t0, v: 1 }]);
  $('play').classList.add('on'); $('playIco').textContent = '■'; $('playLbl').textContent = 'Stop';
  schedule();
  player.timer = setInterval(schedule, 25);
  return start + pre;
}

async function play(fromTop) {
  await ready();
  const wasArmed = rec.armed;
  if (player.playing) stop(true);
  if (wasArmed) { rec.start(); recStartedPlay = true; syncRecUi(); }
  const [from, to] = playRange();
  if (to <= from) { toast('Nothing to play yet — click in the roll to draw a note'); return; }
  beginTransport(fromTop, false);
}

async function toggleRec() {
  if (rec.active) {
    const t = heardTick();
    rec.stop(song, t);
    syncRecUi();
    if (recStartedPlay) stop();
    return;
  }
  if (rec.armed) {
    rec.disarm();
    recStartedPlay = false;
    syncRecUi();
    return;
  }
  if (!(await ensureMidi(true))) return;
  await ready();
  if (player.playing) {
    recStartedPlay = false;
    rec.start();
    syncRecUi();
    toast('Recording — press R or Space to finish');
  } else {
    recStartedPlay = true;
    rec.arm();
    syncRecUi();
    toast('Armed — play your MIDI keyboard to start recording');
  }
}

// to the engine, to MIDI out (if chosen), and to the keyboard when the time comes
function sendAt(events) {
  if (!events.length) return;
  audio.send(events);
  midi.send(events, audio.time, performance.now());
  for (const ev of events) player.queue.push(ev);
}

function schedule() {
  if (!player.playing || player.ended) return;
  // a new tempo: the ticks not yet sent follow it
  const k = S.tickSecs(song);
  if (k !== player.k) {
    player.baseTime += (player.tick - player.baseTick) * player.k; player.baseTick = player.tick; player.k = k;
    player.segs.push({ time: player.baseTime, tick: player.tick });
  }
  const horizon = audio.time + (document.hidden ? 1.6 : 0.2);
  for (let guard = 0; guard < 64; guard++) {
    const [from, to] = playRange();
    const want = player.baseTick + (horizon - player.baseTime) / k, upTo = Math.min(want, to);
    if (upTo > player.tick) {
      sendAt(S.eventsBetween(song, player.list, player.tick, upTo, player.baseTime + (player.tick - player.baseTick) * k));
      player.tick = upTo;
    }
    if (want < to) break;
    const tEnd = player.baseTime + (to - player.baseTick) * k;
    if (!player.loop) { player.ended = true; player.endTime = tEnd; break; }
    // round again: every key and the pedal come up, and the range starts over
    sendAt([{ type: 'O', t: tEnd }]);
    if (rec.active) {
      player.queue.push({ type: 'wrap', t: tEnd, end: to, start: from });
      player.list = performance_();
    }
    const back = lead();
    player.baseTime = tEnd - back * k; player.baseTick = from - back; player.tick = from - back;
    player.segs.push({ time: tEnd, tick: from });
    if (S.pedalAt(song, from)) sendAt([{ type: 'p', t: tEnd, v: 1 }]);
  }
}

function stopUi() {
  const endTick = heardTick();
  clearInterval(player.timer);
  player.playing = false; player.queue = []; player.segs = [];
  if (rec.active || rec.armed) {
    const did = rec.stop(song, endTick);
    if (did && endTick > 0) roll.setCursor(Math.round(endTick / S.gridTicks(song)) * S.gridTicks(song));
  }
  recStartedPlay = false;
  syncRecUi();
  $('play').classList.remove('on'); $('playIco').textContent = '▶'; $('playLbl').textContent = 'Play';
  roll.setPlayhead(-1);
  keys.clear();
  keysStale = true;
}

function stop(silent) {
  if (!player.playing) {
    if (rec.armed) { rec.disarm(); recStartedPlay = false; syncRecUi(); }
    return;
  }
  stopUi();
  midi.hushOut();
  if (silent) audio.flush(); else audio.hush();
}

function toggleLoop() {
  player.loop = !player.loop;
  if (player.playing && !rec.active) player.list = performance_();
  $('loop').setAttribute('aria-pressed', player.loop);
}

let meterLevel = 0;
function frame() {
  requestAnimationFrame(frame);
  if (audio.running && player.playing) {
    const now = audio.time - audio.latency;
    // the keyboard follows what is heard
    let i = 0;
    for (; i < player.queue.length && player.queue[i].t <= now; i++) {
      const ev = player.queue[i];
      if (ev.type === 'n') keys.down(ev.m, ev.v);
      else if (ev.type === 'o') keys.up(ev.m);
      else if (ev.type === 'p') keys.pedal(ev.v > 0);
      else if (ev.type === 'O') keys.clear();
      else if (ev.type === 'wrap') rec.wrapLoop(song, ev.end, ev.start);
    }
    if (i) player.queue.splice(0, i);
    while (player.segs.length > 1 && player.segs[1].time <= now) player.segs.shift();
    const seg = player.segs[0];
    if (seg) {
      const tickNow = Math.max(seg.tick, seg.tick + (now - seg.time) / player.k);
      roll.setPlayhead(tickNow);
      if (rec.active && rec.advance(tickNow)) roll.refresh();
    }
    // the last notes ring out
    if (player.ended && audio.time >= player.endTime) stopUi();
  }
  if (keysStale) showOnKeys();
  roll.draw();
  keys.draw();
  if (!audio.running) return;
  const cv = $('meter');
  if (cv.offsetParent) {
    const lv = audio.level();
    meterLevel = Math.max(lv, meterLevel * 0.92);
    const g = cv.getContext('2d'), w = cv.width, h = cv.height;
    g.clearRect(0, 0, w, h);
    const db = 20 * Math.log10(meterLevel + 1e-6);
    const x = clamp((db + 48) / 48, 0, 1) * (w - 8);
    g.fillStyle = db > -1.5 ? '#e2733c' : '#7dd3a8';
    g.fillRect(4, 8, x, 6);
  }
}

// ---- WebMIDI -----------------------------------------------------------------

let midiFlash = 0, suspendWarned = false;
const knownMidiIn = new Set();

const midi = createMidiHub({
  event(ev) {
    const badge = $('midiState');
    badge.dataset.active = '1';
    clearTimeout(midiFlash);
    midiFlash = setTimeout(() => delete badge.dataset.active, 140);

    if (ev.type === 'n') keys.down(ev.m, ev.v);
    else if (ev.type === 'o') keys.up(ev.m);
    else if (ev.type === 'p') keys.pedal(ev.v > 0);
    else if (ev.type === 'R') keys.clear();

    if (rec.armed && !player.playing && (ev.type === 'n' || (ev.type === 'p' && ev.v > 0))) {
      if (audio.running) {
        rec.start();
        syncRecUi();
        rec.event(song, ev, beginTransport(false, true));
      } else {
        ready().then(() => {
          if (!rec.armed || player.playing) return;
          rec.start();
          syncRecUi();
          rec.event(song, ev, beginTransport(false, true));
        });
      }
    } else if (rec.active) {
      rec.event(song, ev, heardTick());
    }

    if (audio.running) {
      if (audio.ctx && audio.ctx.state === 'suspended') {
        audio.ctx.resume();
        if (!suspendWarned) { suspendWarned = true; toast('Click anywhere on the page once to enable audio for MIDI'); }
      }
      audio.send([ev]);
    } else {
      audio.init().then(() => {
        if (audio.ctx && audio.ctx.state === 'suspended' && !suspendWarned) {
          suspendWarned = true;
          toast('Click anywhere on the page once to enable audio for MIDI');
        }
        audio.send([ev]);
      });
    }
  },
  ports({ inputs, outputs }, changedPort) {
    if (changedPort && changedPort.type === 'input') {
      if (changedPort.state === 'connected' && !knownMidiIn.has(changedPort.id)) {
        knownMidiIn.add(changedPort.id);
        toast(`MIDI connected: ${changedPort.name || 'Keyboard'}`);
      } else if (changedPort.state === 'disconnected') {
        knownMidiIn.delete(changedPort.id);
      }
    } else {
      knownMidiIn.clear();
      for (const p of inputs) knownMidiIn.add(p.id);
    }
    syncMidiControls(inputs, outputs);
  },
});

function saveMidiPrefs() {
  try {
    localStorage.setItem(MIDI_KEY, JSON.stringify({ inputId: midi.inputId, channel: midi.channel, outputId: midi.outputId }));
  } catch (e) { /* ignore */ }
}

function syncMidiControls(inputs = midi.ports().inputs, outputs = midi.ports().outputs) {
  const supported = typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  const inSel = $('midiIn'), chSel = $('midiCh'), outSel = $('midiOut'), badge = $('midiState');
  inSel.innerHTML = '';
  inSel.append(new Option(inputs.length ? `All inputs (${inputs.length})` : 'All inputs', 'all'));
  for (const p of inputs) inSel.append(new Option(p.name, p.id));
  inSel.append(new Option('Off', 'off'));
  if (midi.inputId !== 'all' && midi.inputId !== 'off' && !inputs.some((p) => p.id === midi.inputId)) midi.setInput('all');
  inSel.value = midi.inputId;

  outSel.innerHTML = '';
  outSel.append(new Option('Off', 'off'));
  for (const p of outputs) outSel.append(new Option(p.name, p.id));
  if (midi.outputId !== 'off' && !outputs.some((p) => p.id === midi.outputId)) midi.setOutput('off');
  outSel.value = midi.outputId;

  chSel.value = String(midi.channel);
  inSel.disabled = chSel.disabled = outSel.disabled = !supported;

  if (!supported) {
    badge.textContent = 'Unsupported';
    badge.dataset.state = 'off';
  } else if (!midi.connected) {
    badge.textContent = 'Connect';
    badge.dataset.state = 'off';
  } else if (midi.inputId === 'off' && midi.outputId === 'off') {
    badge.textContent = 'Off';
    badge.dataset.state = 'off';
  } else if (!inputs.length && midi.outputId === 'off') {
    badge.textContent = 'No device';
    badge.dataset.state = 'idle';
  } else {
    const chosen = midi.inputId !== 'all' && midi.inputId !== 'off' ? inputs.find((p) => p.id === midi.inputId) : null;
    badge.textContent = chosen ? chosen.name : inputs.length === 1 ? inputs[0].name : inputs.length ? `${inputs.length} inputs` : 'Out ready';
    badge.dataset.state = 'ready';
  }
}

async function ensureMidi(loud) {
  if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
    if (loud) toast('WebMIDI is not supported in this browser');
    syncMidiControls();
    return false;
  }
  if (midi.connected) return true;
  try {
    await midi.connect();
    syncMidiControls();
    return true;
  } catch (e) {
    syncMidiControls();
    if (loud) toast('MIDI access was blocked by the browser');
    return false;
  }
}

// ---- settings UI -------------------------------------------------------------

const pct = (v) => Math.round(v * 100) + '%';
const signed = (v) => (v > 0 ? '+' : '') + Math.round(v * 100);
const sliders = [];
let humanRow = null;

function mkSlider(parent, get, set, label, min, max, step, fmt) {
  const row = el('label', 'slider');
  const input = el('input');
  Object.assign(input, { type: 'range', min, max, step });
  const out = el('output');
  row.append(el('span', '', label), input, out);
  parent.append(row);
  const refresh = () => {
    const v = get();
    input.value = v;
    out.textContent = fmt(v);
    input.style.setProperty('--p', ((v - min) / (max - min)) * 100 + '%');
  };
  input.addEventListener('input', () => { set(parseFloat(input.value)); refresh(); scheduleSave(); });
  sliders.push(refresh);
  return row;
}

let fxTimer = 0, boardTimer = 0, progHideTimer = 0, lastModes = 0;
function fxChanged(slow) {
  clearTimeout(fxTimer);
  if (slow) fxTimer = setTimeout(() => audio.syncFx(), 140); else audio.syncFx();
}

function setBoardProgress({ active, p = 0, modes = 0, error = false }) {
  const bar = $('boardProg'), lbl = $('boardProgLbl'), fill = $('boardProgFill');
  const pBar = $('bodyProg'), pFill = $('bodyProgFill'), badge = $('bodyState');
  clearTimeout(progHideTimer);
  if (modes) lastModes = modes;
  if (active) {
    const pct = Math.min(99, Math.max(0, Math.round(p * 100)));
    bar.hidden = false; pBar.hidden = false;
    bar.setAttribute('aria-valuenow', String(pct));
    lbl.textContent = `Calculating body · ${pct}%`;
    fill.style.width = pFill.style.width = pct + '%';
    badge.textContent = `Building ${pct}%`;
    badge.dataset.state = 'busy';
    return;
  }
  if (error) {
    bar.hidden = true; pBar.hidden = true;
    badge.textContent = 'Unavailable';
    badge.dataset.state = 'off';
    return;
  }
  badge.textContent = lastModes ? `${lastModes} modes` : 'Ready';
  badge.dataset.state = 'ready';
  if (!bar.hidden) {
    bar.setAttribute('aria-valuenow', '100');
    lbl.textContent = 'Calculating body · 100%';
    fill.style.width = pFill.style.width = '100%';
    progHideTimer = setTimeout(() => { bar.hidden = true; pBar.hidden = true; }, 220);
  } else {
    pBar.hidden = true;
  }
}

function boardChanged(slow) {
  clearTimeout(boardTimer);
  if (slow) {
    $('bodyState').textContent = 'Pending…';
    $('bodyState').dataset.state = 'busy';
    boardTimer = setTimeout(() => audio.syncBoard(), 180);
  } else {
    audio.syncBoard();
  }
}

function syncBodyControls() {
  $('hiFi').checked = Boolean(song.inst.hiFi);
  $('hiFiHint').textContent = song.inst.hiFi ? '2-pol · 4× ODE · 14 kHz' : 'Standard';
  $('bodyPreset').value = S.bodyPreset(song.inst);
}

function buildSettings() {
  const inst = (k) => [() => song.inst[k], (v) => { song.inst[k] = v; audio.syncInstrument(); }];
  $('hiFi').addEventListener('change', (e) => {
    song.inst.hiFi = e.target.checked ? 1 : 0;
    syncBodyControls();
    audio.syncInstrument();
    boardChanged(false);
    scheduleSave();
  });
  mkSlider($('instSliders'), ...inst('hard'), 'Hammer felt', -1, 1, 0.02, signed).title = 'Softer or harder hammer felt: a harder felt gives a brighter note';
  mkSlider($('instSliders'), ...inst('noise'), 'Action noise', 0, 1, 0.01, pct).title = 'The knock of key and hammer, keys coming up, the pedal';

  for (const [k, b] of Object.entries(S.BODIES)) $('bodyPreset').append(new Option(b.name, k));
  $('bodyPreset').append(new Option('Custom', ''));
  $('bodyPreset').lastChild.disabled = true;
  $('bodyPreset').addEventListener('change', (e) => {
    S.setBodyPreset(song.inst, e.target.value);
    syncBodyControls(); for (const r of sliders) r(); boardChanged(false); scheduleSave();
  });
  const body = (k) => [() => song.inst[k], (v) => { song.inst[k] = v; syncBodyControls(); boardChanged(true); }];
  mkSlider($('bodySliders'), ...body('bodySize'), 'Size', 0.65, 1.45, 0.01, pct).title = 'Soundboard and bridge scale (100% = 2.7 m concert grand)';
  mkSlider($('bodySliders'), ...body('bodyStiff'), 'Spruce', -0.6, 0.6, 0.02, signed).title = 'Bending stiffness of the spruce soundboard and ribs';
  mkSlider($('bodySliders'), ...body('bodyCrown'), 'Crown', 20, 58, 1, (v) => Math.round(v) + ' Hz').title = 'Arch and string downbearing stiffness of the lowest resonances';
  mkSlider($('bodySliders'), ...body('bodyRes'), 'Sustain', -0.6, 0.6, 0.02, signed).title = 'How long the soundboard resonances ring';
  mkSlider($('bodySliders'), ...body('bodyLid'), 'Lid', 0, 55, 1, (v) => Math.round(v) + '°').title = 'Grand lid angle (0° closed, 35° open stick)';

  humanRow = mkSlider($('playerSliders'), () => song.inst.human, (v) => { song.inst.human = v; if (player.playing && !rec.active) player.list = performance_(); }, 'Humanize', 0, 1, 0.01, pct);
  $('humanOn').addEventListener('change', (e) => {
    song.inst.humanOn = e.target.checked ? 1 : 0;
    e.target.blur();
    if (player.playing && !rec.active) player.list = performance_();
    syncSongControls(); scheduleSave();
  });

  $('midiCh').append(new Option('All', '-1'));
  for (let c = 0; c < 16; c++) $('midiCh').append(new Option(String(c + 1), String(c)));
  try {
    const mp = JSON.parse(localStorage.getItem(MIDI_KEY) || 'null');
    if (mp && typeof mp === 'object') {
      if (mp.inputId) midi.setInput(mp.inputId);
      if (mp.channel != null) midi.setChannel(mp.channel);
      if (mp.outputId) midi.setOutput(mp.outputId);
    }
  } catch (e) { /* ignore */ }
  syncMidiControls();
  $('midiIn').addEventListener('change', async (e) => { midi.setInput(e.target.value); saveMidiPrefs(); if (e.target.value !== 'off') await ensureMidi(true); else syncMidiControls(); });
  $('midiCh').addEventListener('change', (e) => { midi.setChannel(+e.target.value); saveMidiPrefs(); });
  $('midiOut').addEventListener('change', async (e) => { midi.setOutput(e.target.value); saveMidiPrefs(); if (e.target.value !== 'off') await ensureMidi(true); else syncMidiControls(); });
  $('midiSec').addEventListener('pointerdown', () => { if (!midi.connected) ensureMidi(false); });

  const fx = (k, slow) => [() => song.fx[k], (v) => { song.fx[k] = v; syncFxControls(); fxChanged(slow); }];
  for (const [k, r] of Object.entries(S.REVERBS)) $('revSpace').append(new Option(r.name, k));
  $('revSpace').append(new Option('Custom', ''));
  $('revSpace').lastChild.disabled = true;
  $('revSpace').addEventListener('change', (e) => {
    S.setReverbSpace(song.fx, e.target.value);
    syncFxControls(); for (const r of sliders) r(); fxChanged(); scheduleSave();
  });
  mkSlider($('revSliders'), ...fx('revMix'), 'Mix', 0, 0.8, 0.01, pct);
  mkSlider($('revSliders'), ...fx('revSize', true), 'Decay', 0.3, 8, 0.1, (v) => v.toFixed(1) + ' s');
  mkSlider($('revSliders'), ...fx('revTone', true), 'Tone', 0, 1, 0.02, pct);
  mkSlider($('dlySliders'), ...fx('dlyFb'), 'Feedback', 0, 0.85, 0.01, pct);
  mkSlider($('dlySliders'), ...fx('dlyMix'), 'Mix', 0, 0.8, 0.01, pct);
  mkSlider($('masterSliders'), ...fx('vol'), 'Volume', 0, 1, 0.01, pct);

  for (const id of ['revOn', 'dlyOn']) {
    $(id).addEventListener('change', (e) => { song.fx[id] = e.target.checked; syncFxControls(); fxChanged(); scheduleSave(); });
    $(id).parentElement.addEventListener('click', (e) => e.stopPropagation());
  }
  $('dlyTime').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    song.fx.dlyTime = b.dataset.v; syncFxControls(); fxChanged(); scheduleSave();
  });

  for (let i = 2; i <= 7; i++) $('bpb').append(new Option(i, i));
  for (const [steps, name] of S.GRIDS) $('grid').append(new Option(name, steps));
  $('bpb').addEventListener('change', (e) => { song.bpb = +e.target.value; roll.refresh(); changed(); });
  $('grid').addEventListener('change', (e) => { song.grid = +e.target.value; roll.refresh(); scheduleSave(); });

  $('bpm').addEventListener('change', (e) => {
    song.bpm = clamp(Math.round(+e.target.value) || 100, 30, 300);
    e.target.value = song.bpm; audio.syncFx(); scheduleSave();
  });
  $('title').addEventListener('input', (e) => { song.title = e.target.value; scheduleSave(); });
}

function syncFxControls() {
  $('revOn').checked = song.fx.revOn; $('dlyOn').checked = song.fx.dlyOn;
  $('revSpace').value = S.reverbSpace(song.fx);
  for (const b of $('dlyTime').children) b.classList.toggle('on', b.dataset.v === song.fx.dlyTime);
}
function syncSongControls() {
  $('title').value = song.title;
  $('bpm').value = song.bpm;
  if (![...$('bpb').options].some((o) => +o.value === song.bpb)) $('bpb').append(new Option(song.bpb, song.bpb));
  $('bpb').value = song.bpb;
  $('grid').value = song.grid;
  $('humanOn').checked = song.inst.humanOn !== 0;
  humanRow.classList.toggle('off', song.inst.humanOn === 0);
  syncBodyControls();
  for (const r of sliders) r();
}

function setSong(s) {
  stop();
  clearTimeout(boardTimer);
  song = s;
  undoStack.length = 0; redoStack.length = 0;
  roll.setSong(song);
  syncSongControls(); syncFxControls();
  audio.setSong(song);
  keysStale = true;
  updateStatus();
  document.title = `${song.title || 'Untitled'} — piano-synth`;
}

// ---- input -------------------------------------------------------------------

function handleKey(key, e) {
  const shift = e.shiftKey, mod = e.ctrlKey || e.metaKey, step = S.gridTicks(song);
  if (mod) {
    switch (key.toLowerCase()) {
      case 'z': shift ? restore(redoStack, undoStack) : restore(undoStack, redoStack); return true;
      case 'y': restore(redoStack, undoStack); return true;
      case 'c': if (roll.copy()) toast('Copied', 900); return true;
      case 'x': if (roll.cut()) toast('Cut', 900); return true;
      case 'v': roll.paste(); return true;
      case 'a': roll.selectAll(); return true;
    }
    return false;
  }
  switch (key) {
    case 'ArrowLeft': roll.nudge(-step, 0); return true;
    case 'ArrowRight': roll.nudge(step, 0); return true;
    case 'ArrowUp': roll.nudge(0, shift ? 12 : 1); return true;
    case 'ArrowDown': roll.nudge(0, shift ? -12 : -1); return true;
    case 'Backspace': case 'Delete': roll.deleteSelected(); return true;
    case 'Home': roll.setCursor(0); return true;
    case ' ': player.playing ? stop() : play(false); return true;
    case 'Enter': play(true); return true;
    case 'Escape': if (roll.selected.length) roll.clearSelection(); else if (player.playing || rec.armed) stop(); return true;
    case '+': case '=': roll.zoom(1.25); return true;
    case '-': case '_': roll.zoom(0.8); return true;
    case '?': $('help').showModal(); return true;
  }
  if (key.toLowerCase() === 'l') { toggleLoop(); return true; }
  if (key.toLowerCase() === 'r') { toggleRec(); return true; }
  return false;
}

function bindInput() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if ($('help').open) return;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') {
      if (e.key === 'Escape' || (e.key === 'Enter' && t.type !== 'range')) { t.blur(); $('roll').focus({ preventScroll: true }); e.preventDefault(); }
      return;
    }
    if (e.altKey) return;
    if (handleKey(e.key, e)) e.preventDefault();
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.blur();
    if (!e.target.closest('.menuwrap')) closeMenus();
  });

  $('play').addEventListener('click', () => (player.playing ? stop() : play(false)));
  $('rec').addEventListener('click', toggleRec);
  $('loop').addEventListener('click', toggleLoop);
  $('share').addEventListener('click', share);
  $('zoomIn').addEventListener('click', () => roll.zoom(1.25));
  $('zoomOut').addEventListener('click', () => roll.zoom(0.8));

  for (const [btn, menu] of MENUS) {
    $(btn).addEventListener('click', () => {
      const open = $(menu).hidden;
      closeMenus();
      $(menu).hidden = !open;
      $(btn).setAttribute('aria-expanded', open);
    });
  }
  DEMOS.forEach((d, i) => {
    const b = el('button');
    b.dataset.demo = i;
    b.append(el('b', '', d.name), el('small', '', d.about));
    $('demoMenu').append(b);
  });
  // a demo is chosen to be heard: it starts at once
  $('demoMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenus();
    await save(); setSong(DEMOS[+b.dataset.demo].make()); await save(true);
    play(true);
  });
  $('menu').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenus();
    if (b.dataset.act === 'new') { await save(); setSong(S.newSong()); await save(true); toast('New song — the browser Back button brings the old one back'); }
    else if (b.dataset.act === 'help') $('help').showModal();
    else if (b.dataset.act === 'midiIn') $('midiFile').click();
    else if (b.dataset.act === 'midiOut') download(new Blob([songToMidi(song)], { type: 'audio/midi' }), '.mid');
    else if (b.dataset.act === 'wav') exportWav();
  });

  $('midiFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importMidi(f);
  });
  window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    const f = [...e.dataTransfer.files].find((x) => /\.midi?$/i.test(x.name));
    if (!f) return;
    e.preventDefault();
    importMidi(f);
  });

  window.addEventListener('popstate', () => { if (!savePending) loadFromHash(); });
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { roll.resize(); keys.resize(); }, 120);
  });
  document.addEventListener('visibilitychange', () => { if (player.playing) schedule(); });
}

const MENUS = [['menuBtn', 'menu'], ['demoBtn', 'demoMenu']];
function closeMenus() {
  for (const [btn, menu] of MENUS) { $(menu).hidden = true; $(btn).setAttribute('aria-expanded', 'false'); }
}

function download(blob, ext) {
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = ((song.title || 'piano-synth').replace(/[^\w\- ]+/g, '').trim() || 'piano-synth') + ext;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function importMidi(file) {
  try {
    const { song: s, dropped, truncated, quantised } = midiToSong(parseMidi(await file.arrayBuffer()), { title: file.name.replace(/\.midi?$/i, '') });
    await save();
    setSong(s);
    await save(true);
    const notes = [truncated && `only the first ${S.MAX_NOTES} notes`, dropped && `${dropped} note${dropped > 1 ? 's' : ''} outside the 88 keys left out`, !quantised && 'played by a person: Humanize is off'].filter(Boolean);
    toast(notes.length ? `Imported — ${notes.join(', ')}` : 'Imported — the browser Back button brings the old song back', 4000);
  } catch (e) {
    console.warn(e);
    toast(`Could not import this file: ${e.message}`, 4000);
  }
}

async function exportWav() {
  toast('Rendering audio…', 120000);
  try {
    const h = S.humanOf(song.inst);
    const list = h > 0 ? perform(song, { seed: (Math.random() * 0x7fffffff) | 0, human: h }) : S.compile(song);
    const buf = await renderSong(song, list, 48000, (p) => setBoardProgress({ active: true, p }));
    setBoardProgress({ active: false, p: 1 });
    download(wavBlob(buf), '.wav');
    toast('WAV exported');
  } catch (e) {
    setBoardProgress({ active: false, p: 0 });
    console.error(e);
    toast('Export failed in this browser');
  }
}

// ---- boot ----------------------------------------------------------------------

async function boot() {
  audio.onNotice = (msg) => toast(msg, 5000);
  audio.onBoardProgress = setBoardProgress;
  buildSettings();
  bindInput();
  roll.resize();
  let ok = await loadFromHash();
  if (!ok) {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved) { setSong(await S.decodeSong(saved)); ok = true; }
    } catch (e) { /* ignore */ }
  }
  if (!ok) { setSong(DEMOS[0].make()); toast('Press Play to hear the demo — there are more under Demos', 5000); }
  // a user gesture unlocks audio so a connected MIDI keyboard can sound immediately
  const unlock = () => {
    if (audio.ctx && audio.ctx.state === 'running') return;
    if (midi.connected && midi.ports().inputs.length) audio.init();
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });

  ensureMidi(false);
  requestAnimationFrame(frame);
  // debugging / scripting hook
  window.pianoSynth = { audio, midi, rec, get song() { return song; }, S, player, roll, keys };
}
boot();
