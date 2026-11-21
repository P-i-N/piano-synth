// Live WebMIDI: playing the piano from a MIDI keyboard, recording into the roll, and
// optionally sending playback to a MIDI output.

import { LO, HI, MAX_NOTES, sortNotes, setPedal } from './song.js';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// Decode one WebMIDI message (Uint8Array) into an engine-shaped event, or null.
export function parseMidiMessage(data) {
  if (!data || !data.length) return null;
  const s = data[0];
  if (s === 0xff) return { type: 'panic', ch: -1, soundOff: true };
  if (s >= 0xf0 || s < 0x80) return null;
  const type = s & 0xf0, ch = s & 0x0f;
  if ((type === 0x80 || type === 0x90 || type === 0xb0) && data.length < 3) return null;
  const a = data[1] & 0x7f, b = data[2] & 0x7f;
  if (type === 0x90 && b > 0) return { type: 'n', ch, m: a, vel: b, v: b / 127 };
  if (type === 0x80 || type === 0x90) return { type: 'o', ch, m: a };
  if (type === 0xb0) {
    if (a === 64) return { type: 'p', ch, down: b >= 64, val: b };
    if (a === 120) return { type: 'panic', ch, soundOff: true };
    if (a === 121) return { type: 'resetControllers', ch };
    if (a === 123) return { type: 'panic', ch, soundOff: false };
  }
  return null;
}

// Manage WebMIDI ports, channel/device filtering, held-note reference counting (so unplugging
// a cable or switching channels never strands a note), and optional MIDI output.
export function createMidiHub(on = {}) {
  let access = null, inputId = 'all', outputId = 'off', channel = -1;
  const bound = new Map();                // port.id -> listener
  const held = new Map();                 // "port:ch:m" -> { portId, ch, m }
  const counts = new Uint16Array(128);
  const pedals = new Set();               // portIds holding sustain down
  let pedalDown = false;

  const emit = (ev, meta) => { if (on.event) on.event(ev, meta); };

  function syncPedal(meta) {
    const want = pedals.size > 0;
    if (want !== pedalDown) { pedalDown = want; emit({ type: 'p', v: want ? 1 : 0 }, meta); }
  }

  function releaseWhere(pred, meta) {
    for (const [k, it] of held) {
      if (!pred(it)) continue;
      held.delete(k);
      if (counts[it.m] > 0 && --counts[it.m] === 0) emit({ type: 'o', m: it.m }, meta);
    }
  }

  function releasePort(portId) {
    releaseWhere((it) => it.portId === portId, { portId });
    if (pedals.delete(portId)) syncPedal({ portId });
  }

  function receive(portId, data, timeStamp = 0) {
    if (inputId === 'off' || (inputId !== 'all' && inputId !== portId)) return;
    const msg = parseMidiMessage(data);
    if (!msg) return;
    if (msg.ch >= 0 && channel >= 0 && msg.ch !== channel) return;
    const meta = { portId, timeStamp };
    if (msg.type === 'n') {
      if (msg.m < LO || msg.m > HI) return;
      const k = `${portId}:${msg.ch}:${msg.m}`;
      if (!held.has(k)) { held.set(k, { portId, ch: msg.ch, m: msg.m }); counts[msg.m]++; }
      emit({ type: 'n', m: msg.m, v: msg.v, vel: msg.vel }, meta);
    } else if (msg.type === 'o') {
      const k = `${portId}:${msg.ch}:${msg.m}`;
      if (!held.has(k)) return;
      held.delete(k);
      if (counts[msg.m] > 0 && --counts[msg.m] === 0) emit({ type: 'o', m: msg.m }, meta);
    } else if (msg.type === 'p') {
      if (msg.down) pedals.add(portId); else pedals.delete(portId);
      syncPedal(meta);
    } else if (msg.type === 'resetControllers') {
      if (pedals.delete(portId)) syncPedal(meta);
    } else if (msg.type === 'panic') {
      releaseWhere((it) => it.portId === portId && (msg.ch < 0 || it.ch === msg.ch), meta);
      if (msg.ch < 0 && pedals.delete(portId)) syncPedal(meta);
      if (msg.soundOff) emit({ type: 'R' }, meta);
    }
  }

  function syncPorts(changedPort) {
    if (!access) return;
    const live = new Set();
    for (const input of access.inputs.values()) {
      if (input.state === 'disconnected') continue;
      live.add(input.id);
      if (!bound.has(input.id)) {
        const fn = (e) => receive(input.id, e.data, e.timeStamp);
        input.addEventListener ? input.addEventListener('midimessage', fn) : (input.onmidimessage = fn);
        bound.set(input.id, { input, fn });
      }
    }
    for (const [id, { input, fn }] of bound) {
      if (live.has(id)) continue;
      if (input.removeEventListener) input.removeEventListener('midimessage', fn);
      else if (input.onmidimessage === fn) input.onmidimessage = null;
      bound.delete(id);
      releasePort(id);
    }
    if (on.ports) on.ports(ports(), changedPort || null);
  }

  function ports() {
    if (!access) return { inputs: [], outputs: [] };
    const list = (map) => [...map.values()]
      .filter((p) => p.state !== 'disconnected')
      .map((p) => ({ id: p.id, name: p.name || p.manufacturer || `MIDI port ${p.id}` }));
    return { inputs: list(access.inputs), outputs: list(access.outputs) };
  }

  function outPort() {
    if (!access || outputId === 'off') return null;
    for (const p of access.outputs.values()) if (p.id === outputId && p.state !== 'disconnected') return p;
    return null;
  }

  return {
    get connected() { return !!access; },
    get inputId() { return inputId; },
    get outputId() { return outputId; },
    get channel() { return channel; },
    ports,
    receive,
    attach(midiAccess) {
      access = midiAccess;
      access.onstatechange = (e) => syncPorts(e && e.port);
      syncPorts(null);
      return ports();
    },
    async connect(nav = typeof navigator !== 'undefined' ? navigator : null) {
      if (access) return ports();
      if (!nav || typeof nav.requestMIDIAccess !== 'function') throw new Error('unsupported');
      const a = await nav.requestMIDIAccess({ sysex: false });
      return this.attach(a);
    },
    setInput(id) {
      if (id === inputId) return;
      const prev = inputId;
      inputId = id || 'all';
      if (inputId === 'off') {
        releaseWhere(() => true, {});
        if (pedals.size) { pedals.clear(); syncPedal({}); }
      } else if (prev === 'all' && inputId !== 'all') {
        for (const p of [...pedals]) if (p !== inputId) pedals.delete(p);
        releaseWhere((it) => it.portId !== inputId, {});
        syncPedal({});
      }
    },
    setChannel(ch) {
      const next = ch == null || ch === '' || +ch < 0 ? -1 : clamp(+ch | 0, 0, 15);
      if (next === channel) return;
      channel = next;
      if (channel >= 0) releaseWhere((it) => it.ch !== channel, {});
    },
    setOutput(id) {
      if (id === outputId) return;
      this.hushOut();
      outputId = id || 'off';
    },
    // Forward scheduled engine events to the chosen MIDI output (if any).
    send(events, audioNow = 0, perfNow = 0) {
      const out = outPort();
      if (!out || !events || !events.length) return;
      for (const ev of events) {
        const at = ev.t != null ? perfNow + Math.max(0, (ev.t - audioNow) * 1000) : undefined;
        try {
          if (ev.type === 'n' && ev.m >= 0 && ev.m <= 127) out.send([0x90, ev.m, clamp(Math.round(ev.v * 127), 1, 127)], at);
          else if (ev.type === 'o' && ev.m >= 0 && ev.m <= 127) out.send([0x80, ev.m, 0], at);
          else if (ev.type === 'p') out.send([0xb0, 64, ev.v > 0 ? 127 : 0], at);
          else if (ev.type === 'O' || ev.type === 'R') { out.send([0xb0, 64, 0], at); out.send([0xb0, 123, 0], at); }
        } catch (e) { /* port closed mid-send */ }
      }
    },
    hushOut() {
      const out = outPort();
      if (!out) return;
      try {
        if (typeof out.clear === 'function') out.clear();
        out.send([0xb0, 64, 0]);
        out.send([0xb0, 123, 0]);
      } catch (e) { /* ignore */ }
    },
  };
}

// Record live MIDI events (notes and sustain pedal) into a song as ticks advance.
export function createMidiRecorder(on = {}) {
  let armed = false, active = false, touched = false;
  const open = new Map();                 // midi key -> song note object
  let pedalFrom = null;

  function touch(song) {
    if (touched) return;
    touched = true;
    if (on.before) on.before(song);
  }

  return {
    get armed() { return armed; },
    get active() { return active; },
    get hasOpen() { return open.size > 0 || pedalFrom != null; },
    arm() { armed = true; active = false; touched = false; open.clear(); pedalFrom = null; },
    start() { armed = false; active = true; touched = false; open.clear(); pedalFrom = null; },
    disarm() { armed = false; },
    event(song, ev, tick) {
      if (!active) return false;
      const t = Math.max(0, Math.round(tick));
      if (ev.type === 'n') {
        const prev = open.get(ev.m);
        if (prev) { prev.d = Math.max(1, t - prev.t); open.delete(ev.m); }
        if (song.notes.length >= MAX_NOTES) return false;
        touch(song);
        const vel = clamp(Math.round(ev.vel != null ? ev.vel : ev.v * 127), 1, 127);
        const n = { t, d: 1, m: ev.m, v: vel };
        song.notes.push(n);
        sortNotes(song);
        open.set(ev.m, n);
        if (on.change) on.change(false);
        return true;
      }
      if (ev.type === 'o') {
        const n = open.get(ev.m);
        if (!n) return false;
        n.d = Math.max(1, t - n.t);
        open.delete(ev.m);
        if (on.change) on.change(false);
        return true;
      }
      if (ev.type === 'p') {
        if (ev.v > 0) {
          if (pedalFrom == null) { touch(song); pedalFrom = t; }
        } else if (pedalFrom != null) {
          if (t > pedalFrom) { setPedal(song, pedalFrom, t, true); if (on.change) on.change(false); }
          pedalFrom = null;
        }
        return true;
      }
      if (ev.type === 'R' || ev.type === 'O') {
        this.stop(song, t);
        return true;
      }
      return false;
    },
    // Stretch held notes to the current playhead tick so they grow visibly on the roll.
    advance(tick) {
      if (!active || !open.size) return false;
      const t = Math.max(0, Math.round(tick));
      let moved = false;
      for (const n of open.values()) {
        const d = Math.max(1, t - n.t);
        if (n.d !== d) { n.d = d; moved = true; }
      }
      return moved;
    },
    // Close notes cleanly at the end of a loop pass so held keys do not spill slivers into the start.
    wrapLoop(song, loopEnd, loopStart) {
      if (!active) return;
      const end = Math.max(0, Math.round(loopEnd)), start = Math.max(0, Math.round(loopStart));
      let did = false;
      for (const n of open.values()) { n.d = Math.max(1, end - n.t); did = true; }
      open.clear();
      if (pedalFrom != null) {
        if (end > pedalFrom) { setPedal(song, pedalFrom, end, true); did = true; }
        pedalFrom = start;
      }
      if (did) { sortNotes(song); if (on.change) on.change(true); }
    },
    stop(song, endTick) {
      const wasActive = active;
      armed = false; active = false;
      if (!wasActive) return false;
      const t = Math.max(0, Math.round(endTick));
      let did = touched;
      for (const n of open.values()) { n.d = Math.max(1, t - n.t); did = true; }
      open.clear();
      if (pedalFrom != null) {
        if (t > pedalFrom) { setPedal(song, pedalFrom, t, true); did = true; }
        pedalFrom = null;
      }
      touched = false;
      if (did) { sortNotes(song); if (on.change) on.change(true); }
      return did;
    },
  };
}
