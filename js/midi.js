// Standard MIDI files: reading one into a song, and writing a song as one.
// (vibetar's js/midi.js lays notes out on strings and a grid; a piano roll takes them as they are.)

import { PPQ, LO, HI, MAX_NOTES, newSong, sortNotes, setPedal } from './song.js';

// Read a MIDI file (ArrayBuffer). Returns { ppq, notes: [{ tick, dur, m, v, ch }],
// pedal: [{ tick, down }], tempos: [{ tick, us }] (microseconds per quarter), bpb }.
export function parseMidi(buffer) {
  const d = new DataView(buffer);
  let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p++)); return s; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; }, u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const varlen = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  if (str(4) !== 'MThd') throw new Error('not a MIDI file');
  const hl = u32(), format = u16(), ntracks = u16(), div = u16();
  p = 8 + hl;
  if (div & 0x8000) throw new Error('MIDI files timed in frames are not supported');
  if (format > 1) throw new Error('MIDI format 2 is not supported');
  const out = { ppq: div, notes: [], pedal: [], tempos: [], bpb: 4 };
  for (let t = 0; t < ntracks && p + 8 <= d.byteLength; t++) {
    const id = str(4), len = u32(), end = p + len;
    if (id !== 'MTrk') { p = end; continue; }
    let tick = 0, status = 0;
    const open = new Map(); // channel * 128 + key -> note
    while (p < end) {
      tick += varlen();
      let b = d.getUint8(p);
      if (b & 0x80) { status = b; p++; } // otherwise: running status
      const type = status & 0xf0, ch = status & 0x0f;
      if (status === 0xff) {
        const meta = d.getUint8(p++), n = varlen();
        if (meta === 0x51 && n === 3) out.tempos.push({ tick, us: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
        else if (meta === 0x58 && n >= 2 && !out.sig) { out.sig = true; out.bpb = (d.getUint8(p) * 4) / (1 << d.getUint8(p + 1)); }
        p += n;
      } else if (status === 0xf0 || status === 0xf7) { p += varlen(); }
      else if (type === 0x90 || type === 0x80) {
        const key = d.getUint8(p++), vel = d.getUint8(p++), id2 = ch * 128 + key, was = open.get(id2);
        if (was) { was.dur = Math.max(1, tick - was.tick); open.delete(id2); }
        if (type === 0x90 && vel > 0) { const n = { tick, dur: 0, m: key, v: vel, ch }; open.set(id2, n); out.notes.push(n); }
      } else if (type === 0xb0) {
        const cc = d.getUint8(p++), val = d.getUint8(p++);
        if (cc === 64) out.pedal.push({ tick, down: val >= 64 });
      } else if (type === 0xc0 || type === 0xd0) p += 1;
      else p += 2;
    }
    for (const n of open.values()) n.dur = Math.max(1, tick - n.tick);
    p = end;
  }
  out.tempos.sort((a, b) => a.tick - b.tick);
  out.pedal.sort((a, b) => a.tick - b.tick);
  return out;
}

// A song from a parsed file: every channel but the drums (10). The song has one tempo, the
// file's first; where the file changes tempo, the notes keep their place in time.
// Returns { song, dropped: notes outside the 88 keys, truncated, quantised }.
export function midiToSong(midi, opts = {}) {
  const song = newSong();
  song.title = String(opts.title || 'Imported').slice(0, 80);
  const tempos = midi.tempos.length && midi.tempos[0].tick === 0 ? midi.tempos : [{ tick: 0, us: 500000 }, ...midi.tempos];
  song.bpm = Math.max(30, Math.min(300, Math.round(6e7 / tempos[0].us)));
  song.bpb = Math.max(1, Math.min(12, Math.round(midi.bpb) || 4));
  // file tick -> seconds through the tempo map -> song tick at the song's tempo
  const at = (tick) => {
    let secs = 0, last = 0, us = tempos[0].us;
    for (const t of tempos) { if (t.tick >= tick) break; secs += ((t.tick - last) * us) / 1e6 / midi.ppq; last = t.tick; us = t.us; }
    secs += ((tick - last) * us) / 1e6 / midi.ppq;
    return Math.round((secs * song.bpm * PPQ) / 60);
  };
  let dropped = 0, truncated = false, onGrid = 0;
  for (const n of midi.notes) {
    if (n.ch === 9) continue;
    if (n.m < LO || n.m > HI) { dropped++; continue; }
    if (song.notes.length >= MAX_NOTES) { truncated = true; break; }
    const t = at(n.tick);
    song.notes.push({ t, d: Math.max(1, at(n.tick + n.dur) - t), m: n.m, v: Math.max(1, Math.min(127, n.v)) });
    if (Math.abs(t - Math.round(t / 60) * 60) <= 3) onGrid++;
  }
  sortNotes(song);
  let downAt = null;
  for (const e of midi.pedal) {
    if (e.down && downAt == null) downAt = at(e.tick);
    else if (!e.down && downAt != null) { if (at(e.tick) > downAt) setPedal(song, downAt, at(e.tick), true); downAt = null; }
  }
  // a file played by a person is not humanized again
  const quantised = song.notes.length === 0 || onGrid / song.notes.length > 0.9;
  if (!quantised) song.inst.humanOn = 0;
  return { song, dropped, truncated, quantised };
}

// The song as a MIDI file (format 0, one track): Uint8Array. As written: the player and
// Humanize are not in it.
export function songToMidi(song) {
  const ev = [];
  for (const n of song.notes) ev.push([n.t, 1, 0x90, n.m, n.v], [n.t + n.d, 0, 0x80, n.m, 0]);
  for (const [s, e] of song.pedal) ev.push([s, 1, 0xb0, 64, 127], [e, 0, 0xb0, 64, 0]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const bytes = [];
  const varlen = (v) => { const out = [v & 0x7f]; while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80); bytes.push(...out); };
  const us = Math.round(6e7 / song.bpm);
  varlen(0); bytes.push(0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
  varlen(0); bytes.push(0xff, 0x58, 4, song.bpb, 2, 24, 8);
  let last = 0;
  for (const [tick, , status, a, b] of ev) { varlen(tick - last); bytes.push(status, a, b); last = tick; }
  varlen(0); bytes.push(0xff, 0x2f, 0);
  const out = new Uint8Array(22 + bytes.length), d = new DataView(out.buffer);
  out.set([0x4d, 0x54, 0x68, 0x64]); d.setUint32(4, 6); d.setUint16(8, 0); d.setUint16(10, 1); d.setUint16(12, PPQ);
  out.set([0x4d, 0x54, 0x72, 0x6b], 14); d.setUint32(18, bytes.length);
  out.set(bytes, 22);
  return out;
}
