// MIDI files: reading and writing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/song.js';
import { parseMidi, midiToSong, songToMidi } from '../js/midi.js';

function sample() {
  const s = S.newSong();
  s.bpm = 132; s.bpb = 3;
  s.notes = [{ t: 0, d: 480, m: 60, v: 80 }, { t: 0, d: 960, m: 64, v: 33 }, { t: 240, d: 120, m: 21, v: 1 }, { t: 480, d: 480, m: 60, v: 100 }, { t: 5040, d: 60, m: 108, v: 127 }];
  S.sortNotes(s);
  s.pedal = [[0, 480], [960, 2040]];
  return s;
}
// a file by hand: [delta, ...bytes] events in one track
function file(ppq, events) {
  const body = [];
  for (const [delta, ...b] of events) { const v = [delta & 0x7f]; let x = delta; while ((x >>= 7)) v.unshift((x & 0x7f) | 0x80); body.push(...v, ...b); }
  body.push(0, 0xff, 0x2f, 0);
  const out = new Uint8Array(22 + body.length), d = new DataView(out.buffer);
  out.set([0x4d, 0x54, 0x68, 0x64]); d.setUint32(4, 6); d.setUint16(8, 0); d.setUint16(10, 1); d.setUint16(12, ppq);
  out.set([0x4d, 0x54, 0x72, 0x6b], 14); d.setUint32(18, body.length); out.set(body, 22);
  return out.buffer;
}

test('a song written as a MIDI file reads back the same', () => {
  const s = sample(), { song, dropped, truncated, quantised } = midiToSong(parseMidi(songToMidi(s).buffer), { title: 'Back' });
  assert.deepEqual(song.notes, s.notes);
  assert.deepEqual(song.pedal, s.pedal);
  assert.equal(song.bpm, 132); assert.equal(song.bpb, 3); assert.equal(song.title, 'Back');
  assert.deepEqual([dropped, truncated, quantised], [0, false, true]);
  assert.equal(song.inst.humanOn, 1);
});

test('running status, note-on with velocity 0, another resolution, drums and keys outside the piano', () => {
  const midi = parseMidi(file(96, [
    [0, 0x90, 60, 90], [96, 60, 0],          // running status; velocity 0 ends the note
    [0, 0x99, 36, 100], [10, 0x89, 36, 0],   // channel 10: drums
    [0, 0x90, 12, 80], [96, 0x80, 12, 0],    // below A0
    [0, 0xc0, 5], [0, 0xe0, 0, 64],          // program change, pitch bend: skipped
    [0, 0x91, 72, 70], [48, 0x81, 72, 64],
  ]));
  const { song, dropped } = midiToSong(midi);
  assert.deepEqual(song.notes, [{ t: 0, d: 480, m: 60, v: 90 }, { t: 1010, d: 240, m: 72, v: 70 }]);
  assert.equal(dropped, 1);
});

test('a change of tempo in the file moves the notes, not the song\'s tempo', () => {
  // a quarter at 120 bpm, then the tempo halves: the second note starts after 0.5 s, the third after 1.5 s
  const midi = parseMidi(file(480, [
    [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], [0, 0x90, 60, 80], [480, 0x80, 60, 0],
    [0, 0xff, 0x51, 3, 0x0f, 0x42, 0x40], [0, 0x90, 62, 80], [480, 0x80, 62, 0], [0, 0x90, 64, 80], [480, 0x80, 64, 0],
  ]));
  const { song } = midiToSong(midi);
  assert.equal(song.bpm, 120);
  assert.deepEqual(song.notes.map((n) => [n.t, n.d]), [[0, 480], [480, 960], [1440, 960]]);
});

test('a file played by a person is not humanized again', () => {
  const ev = [];
  let seed = 5;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 40; i++) ev.push([Math.round(400 + 160 * rnd()), 0x90, 60 + (i % 12), 80], [100, 0x80, 60 + (i % 12), 0]);
  const { song, quantised } = midiToSong(parseMidi(file(480, ev)));
  assert.equal(quantised, false);
  assert.equal(S.humanOf(song.inst), 0);
});

test('what is not a MIDI file is refused', () => {
  assert.throws(() => parseMidi(new TextEncoder().encode('RIFF....WAVE').buffer), /not a MIDI file/);
});
