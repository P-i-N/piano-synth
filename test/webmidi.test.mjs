// Live WebMIDI: message decoding, port/channel state, output scheduling and roll recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/song.js';
import { parseMidiMessage, createMidiHub, createMidiRecorder } from '../js/webmidi.js';

function mockPort(id, name, state = 'connected') {
  const sent = [];
  let cleared = 0;
  return {
    id, name, state, sent,
    get cleared() { return cleared; },
    onmidimessage: null,
    send(bytes, ts) { sent.push({ bytes: [...bytes], ts }); },
    clear() { cleared++; },
    emit(bytes, timeStamp = 0) { if (this.onmidimessage) this.onmidimessage({ data: new Uint8Array(bytes), timeStamp }); },
  };
}

function mockAccess(inputs = [], outputs = []) {
  const ins = new Map(inputs.map((p) => [p.id, p]));
  const outs = new Map(outputs.map((p) => [p.id, p]));
  return { inputs: ins, outputs: outs, onstatechange: null };
}

test('WebMIDI messages decode note on/off, velocity 0, sustain pedal, panic and ignore clock/sysex', () => {
  assert.deepEqual(parseMidiMessage(new Uint8Array([0x92, 60, 100])), { type: 'n', ch: 2, m: 60, vel: 100, v: 100 / 127 });
  assert.deepEqual(parseMidiMessage(new Uint8Array([0x90, 60, 0])), { type: 'o', ch: 0, m: 60 });
  assert.deepEqual(parseMidiMessage(new Uint8Array([0x85, 72, 64])), { type: 'o', ch: 5, m: 72 });
  assert.deepEqual(parseMidiMessage(new Uint8Array([0xb0, 64, 127])), { type: 'p', ch: 0, down: true, val: 127 });
  assert.deepEqual(parseMidiMessage(new Uint8Array([0xb0, 64, 63])), { type: 'p', ch: 0, down: false, val: 63 });
  assert.deepEqual(parseMidiMessage(new Uint8Array([0xb1, 123, 0])), { type: 'panic', ch: 1, soundOff: false });
  assert.deepEqual(parseMidiMessage(new Uint8Array([0xb1, 120, 0])), { type: 'panic', ch: 1, soundOff: true });
  assert.deepEqual(parseMidiMessage(new Uint8Array([0xb1, 121, 0])), { type: 'resetControllers', ch: 1 });
  assert.deepEqual(parseMidiMessage(new Uint8Array([0xff])), { type: 'panic', ch: -1, soundOff: true });
  assert.equal(parseMidiMessage(new Uint8Array([0xf8])), null);
  assert.equal(parseMidiMessage(new Uint8Array([0xf0, 0x7e, 0xf7])), null);
  assert.equal(parseMidiMessage(new Uint8Array([0xe0, 0, 64])), null);
  assert.equal(parseMidiMessage(new Uint8Array([0x90, 60])), null);
});

test('MIDI hub tracks held keys across ports/channels and releases cleanly on unplug or filter change', () => {
  const events = [], a = mockPort('in1', 'Key 1'), b = mockPort('in2', 'Key 2');
  const access = mockAccess([a, b]);
  const hub = createMidiHub({ event: (ev) => events.push(ev) });
  hub.attach(access);

  // keys outside A0..C8 are ignored
  a.emit([0x90, 12, 90]);
  a.emit([0x90, 115, 90]);
  assert.equal(events.length, 0);

  // two ports hold C4 and sustain: C4 and pedal stay down until both let go
  a.emit([0x90, 60, 80]);
  b.emit([0x91, 60, 100]);
  a.emit([0xb0, 64, 127]);
  b.emit([0xb1, 64, 127]);
  a.emit([0x80, 60, 0]);
  a.emit([0xb0, 64, 0]);
  assert.deepEqual(events.map((e) => e.type), ['n', 'n', 'p']);

  // port b is unplugged while holding C4 and sustain: both release automatically
  b.state = 'disconnected';
  access.onstatechange({ port: b });
  assert.deepEqual(events.slice(3), [{ type: 'o', m: 60 }, { type: 'p', v: 0 }]);

  // channel filter releases notes held on other channels
  events.length = 0;
  a.emit([0x90, 64, 70]);
  a.emit([0x92, 67, 70]);
  hub.setChannel(0);
  assert.deepEqual(events.slice(2), [{ type: 'o', m: 67 }]);
  a.emit([0x92, 72, 70]); // ignored: channel 3
  assert.equal(events.length, 3);
});

test('MIDI hub schedules output events with WebMIDI timestamps and hushes cleanly', () => {
  const out = mockPort('out1', 'Synth Out');
  const hub = createMidiHub();
  hub.attach(mockAccess([], [out]));
  hub.setOutput('out1');
  hub.send([
    { type: 'n', t: 1.25, m: 60, v: 100 / 127 },
    { type: 'p', t: 1.30, v: 1 },
    { type: 'o', t: 1.50, m: 60 },
  ], 1.0, 500);
  assert.equal(out.sent.length, 3);
  assert.deepEqual(out.sent[0], { bytes: [0x90, 60, 100], ts: 750 });
  assert.deepEqual(out.sent[1], { bytes: [0xb0, 64, 127], ts: 800 });
  assert.deepEqual(out.sent[2], { bytes: [0x80, 60, 0], ts: 1000 });

  hub.hushOut();
  assert.equal(out.cleared, 1);
  assert.deepEqual(out.sent.slice(3).map((x) => x.bytes), [[0xb0, 64, 0], [0xb0, 123, 0]]);
});

test('MIDI recorder writes live notes and pedal, stretches held notes, and wraps loops cleanly', () => {
  const song = S.newSong();
  let befores = 0;
  const rec = createMidiRecorder({ before: () => befores++ });
  rec.start();
  rec.event(song, { type: 'n', m: 60, vel: 92, v: 92 / 127 }, 0);
  rec.event(song, { type: 'p', v: 1 }, 120);
  assert.equal(rec.advance(240), true);
  assert.equal(song.notes[0].d, 240);
  rec.event(song, { type: 'o', m: 60 }, 360);
  assert.equal(song.notes[0].d, 360);

  // held note + pedal across a loop wrap close at loopEnd without spilling into 0
  rec.event(song, { type: 'n', m: 64, vel: 80, v: 80 / 127 }, 1800);
  rec.wrapLoop(song, 1920, 0);
  assert.deepEqual(song.notes, [{ t: 0, d: 360, m: 60, v: 92 }, { t: 1800, d: 120, m: 64, v: 80 }]);
  assert.deepEqual(song.pedal, [[120, 1920]]);

  // pedal was still held across the loop wrap, then released at tick 240 of the new pass
  rec.stop(song, 240);
  assert.deepEqual(song.pedal, [[0, 240], [120, 1920]]);
  assert.equal(befores, 1);
});
