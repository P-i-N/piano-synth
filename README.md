# piano-synth

A small piano roll with a physically modelled grand piano, running entirely in the browser. The piano counterpart of [vibetar](https://github.com/P-i-N/vibetar).

Draw notes, press play, copy the page address to share it: the whole song (notes, pedal and settings) lives in the link.

**Status: work in progress.** The roll, the keyboard and the link work. The strings, the hammer and a first soundboard are matched to recorded notes of a Steinway B. Wound strings, the una corda pedal and key and pedal noises are not built yet.

## Features

- A piano roll on a canvas: draw, move and resize notes, select several, copy / paste, undo, snap to a grid, zoom and scroll
- A velocity lane, a sustain-pedal lane, a loop region in the bar ruler, a playhead
- A keyboard under the roll: it shows the keys that sound while the song plays (stronger colour for a harder blow, green for strings held by the pedal alone), the notes under the pointer while nothing plays, and plays a note when a key is clicked
- **Humanize** (the switch next to the tempo, the amount in the Player panel): two hands and their fingers play the notes; timing and loudness drift, phrases breathe, the melody is brought out, the song slows into its last note. Off: the notes are played exactly as written
- Convolution reverb with spaces from a small room to a cathedral, and tempo-synced ping-pong delay
- MIDI file import (menu, or drop a `.mid` on the page): every track but the drums, with its sustain pedal ([js/midi.js](js/midi.js)). The song has one tempo: where the file changes tempo, the notes keep their place in time. A file that was played by a person is not humanized again
- MIDI export (the notes and the pedal as written) and WAV export (what is heard, with Humanize, reverb and delay)
- Twelve demo songs ([js/demos.js](js/demos.js)) in the Demos menu: openings of Bach, Beethoven, Satie and Petzold, a canon after Pachelbel, and originals that each show one thing (soft to loud, the pedal, rolled chords, repeated notes, the lowest and highest strings). A demo starts to play when it is chosen; all play in the same room
- Share by link, no account, no server

## How the sound is made

Nothing is sampled. Everything is computed live in an `AudioWorklet` ([js/worklet.js](js/worklet.js)). The strings, hammers and losses of C2, C4 and C7 are published values (Chaigne and Askenfelt 1994; Bensa et al. 2003), the inharmonicity of the plain strings is Rigaud's fit (2011), and the values for A0 and C8 are estimates. The sources are named in [js/worklet.js](js/worklet.js). Nothing has been tuned against a recording yet.

- **Strings** are digital waveguides: a delay loop for each string, with a loss filter and a chain of allpass filters. The fraction of a sample that the pitch needs is one more allpass, which delays without taking anything away. (vibetar uses a fifth-order Lagrange interpolator. Here, with the fitted loss, that one made partial 12 of eight pitches around E5 decay at 6.5 to 10.6 /s; with the allpass it is 5.9 to 6.1 /s.)
- **One, two or three strings for each note** (one up to E1, two up to A1, three above, as on a Steinway D), up to 2 cents from the note's pitch. They meet at the bridge, which gives way to the sum of their forces. What the strings do together is drained quickly through the bridge; what they do against each other stays. That gives the beating and the two decays of a piano note: a loud C4 falls by 20 dB in its first second and by 12 dB in the next four.
- **The hammer** is a mass thrown at the strings at 0.25 m/s (softest) to 5 m/s (hardest). Its felt is a nonlinear spring with a little hysteresis: force = K (u + a du/dt), with u = compression³. A harder blow compresses the felt further, where it is stiffer: the contact is shorter (C4: 3.4 ms at 0.5 m/s, 2.6 ms at 1.5 m/s, 2.3 ms at 4 m/s) and the note much brighter. The force is solved together with the string's give in every sample, so the stiff felt of the top notes stays stable. The hammer strikes at 12 % of the string's length in the bass and middle, closer to the end in the treble.
- **The felt is fitted to a recording** up to C5: recorded notes of a Steinway B, soft, medium and loud (`node tools/notes.mjs`). From medium to loud, for each dB the note gets louder, the band 2–4 kHz gains 1.2 to 1.8 dB more than the fundamental and the band 4–8 kHz 1.8 to 2.1 dB. The published felt (Chaigne and Askenfelt: 20, 76 and 375 N at half a millimetre of compression for C2, C4 and C7, exponent 2.3 to 3.0) gives half of that or less, and nothing at C5. The fitted felt is softer and the same from A0 to C5 (15 N at half a millimetre, exponent 3) and gives 1.1 to 1.5 and 1.6 to 2.6 dB. What is fitted is the softness of the felt together with how hard "medium" and "loud" were played: the two cannot be told apart. C7 and C8 keep the published felt. With the fitted felt the hammer stays on the strings for 3.7, 2.6 and 0.8 ms at C2, C4 and C7 (1.5 m/s); measured on another piano: 3.1, 2.0 and 0.6 ms.
- **Hysteresis** is a fifth of the published strength (Stulov). At full strength soft notes come out nearly as bright as loud ones (it halves the gain above), and the contact gets longer still.
- **Stiffness** stretches the partials: partial k lies at k f sqrt((1 + B k²) / (1 + B)). B doubles every seven and a half semitones on the plain strings (3.1·10⁻⁴ at C4, 8.7·10⁻³ at C7) and rises again on the short wound strings at the bottom (1.2·10⁻⁴ at C2, 2.5·10⁻⁴ at C1). That rise is fitted to the recorded C1, C2 and C3 (2.5, 1.4 and 1.1·10⁻⁴); from C1 to C6 the model is within 20 % of the recorded strings. For each note a chain of 1 to 16 first-order allpass filters is fitted to the partials up to 6 kHz (at most 40).
- **Tuning** is stretched for that stiffness: an octave is tuned so that partials of its two notes meet (2:1 from A3 up, 6:3 from E2, 8:4 below). C8 comes out 29 cents sharp of equal temperament, A0 24 cents flat. Against C4, the model's C1 is 19.0 cents flat and its C2 6.7; recorded: 19.4 and 6.7. From C3 to C7 model and recording agree within 2 cents.
- **Loss is fitted to a recording**: how the level of the recorded loud notes (the C of each octave) falls in their first eight seconds. They fall by about 20 dB quickly and slowly after that; the model follows within about 2 dB on average from C1 to C4 and at C6, and within 4 dB at C5 and C7. Three things are fitted for each range: the first decay (2.5 dB/s at A0, 8 at C3, 18 at C4 and C5, 12 at C6, 25 at C7), the strings' own share of it (6 %, 12 % from C6: the rest goes through the bridge), and the mistuning of the strings (1.5 to 2 cents, 0.8 from C6), which sets how loud the aftersound is. The published loss of C2, C4 and C7 was half as fast as recorded up to C4 and two to three times too fast above.
- **High partials** lose `b3·f² / (1 + (f / 4 kHz)²)` more: a loss that stops growing above 4 kHz. The partials of the recorded notes do not die with the square of their frequency (C4: 20 to 45 dB/s from 260 Hz to 6.5 kHz). This law is read off scattered data, not fitted key by key.
- **Dampers**: when a key comes up, a loss is switched on in its strings (set to about 100 dB/s at A0, 300 dB/s at C4). Keys above F6 have no damper. The **sustain pedal** keeps all dampers up.
- **Sympathetic resonance**: with the pedal down every string of a piano is free and rings with what the bridge does. About 230 strings cannot run in real time here. Instead one string of each of the 24 lowest keys rings along: their many partials lie close to every pitch above them (after Lehtonen and others, 2007). The top strings, which have no dampers, ring along always, pedal or not: one string for each of those 19 keys. The bridge moves under the force of the played notes, and half of that motion is taken to reach each of these strings: an estimate, there is no recording with the pedal to check it. A short loud note under the pedal leaves the other strings ringing 20 dB (C2) to 36 dB (C6) under the note; after three seconds they are 5 to 7 dB under what the note's own strings still do.
- **Voices**: at most 48 notes ring at once; beyond that the quietest note whose key is up fades out. Ten seconds of 40 notes ringing under the pedal, with the 43 strings that ring along, take about 1.5 s to compute on the development machine (0.9 s without those strings).
- **The soundboard** ([js/board/model.js](js/board/model.js)) is one even plate: spruce and its ribs spread evenly over a rectangle of 2.1 m², with the stiffness measured on real boards (stiffness / mass 70 to 100 m⁴/s², a resonance every 9 Hz, 2 % loss). Its lowest resonances are at 49, 70 and 95 Hz; Conklin measured 49, 67 and 89 Hz on a concert grand. Each of its 1100 resonances up to 10 kHz moves the air: its motion is summed over the board towards two microphones above the strings, once directly and once by way of the open lid. The engine sends the force on the bridge at six places, bass to treble (a key lies between two of them); each has its stereo response.
- **What a microphone hears is the energy sum of the resonances**, made into a filter in which every resonance rings from the first sample. Added with their true delays, the resonances add up or cancel at the microphone by chance, differently for every pitch: neighbouring keys then differ in loudness by 4.5 dB on average and up to 23 dB. In a real piano the strings feel the board, which evens this out; here they do not. For the same reason every resonance is at least 20 Hz wide (wider than its loss makes it below 1 kHz). Neighbouring keys now differ by 1.8 dB on average and 6.9 dB at most.
- **The microphone chain is not computed**: it is a response matched to the recording (`CHAIN` in the board model). Against the loud recorded notes, the board model alone has 7 to 23 dB too much below 200 Hz and 13 to 26 dB too much above 3 kHz. The lows are expected (a board in the open radiates little below 100 Hz, which the model does not know); the highs are not explained. With the chain the third-octave spectrum of the eight loud notes is within 3.5 dB of the recording from 63 Hz to 5 kHz.
- **A level trim by key is matched too** (`trim` in the string engine): heard through the board, the model's C6 and C7 came out 11 and 13 dB louder against C4 than recorded, and the felt does not explain it. With the trim the loud notes from C1 to C8 are within 1.5 dB of the recorded balance.
- The soundboard takes about a second to compute the first time, in a background worker; it is then kept in the browser (IndexedDB). Until it is ready the bare force on the bridge is heard.
- **The player** ([js/player.js](js/player.js)) reads the notes before they are played. Each hand takes the notes near where it is and spans a ninth; the split between the hands is the one that moves and stretches them least. Fingers go by pitch in a chord and by where a note lies under the hand in a line; the fourth finger plays 6 % softer, the fifth 12 %. A chord too wide for its hand is rolled from the bottom, 40 ms from note to note. In a line a finger leaves its key 30 ms after the next one is down. The pedal goes down 70 ms after the keys it is meant to catch.
- **Humanize** scales the rest (the sizes are the ones found for vibetar): timing drifts slowly by about 11 ms and loudness by about 10 %, with up to 4 ms and 10 % of scatter from note to note; a phrase of four bars moves on towards its middle, eases off towards its end and swells by 12 %; of notes struck together the top one is 12 % louder and 12 ms early, the ones between top and bass 6 % softer; the last bar slows down (the last note up to 7 % of a bar late) and softens, unless the song is looped. At 0 % or switched off, the notes are played exactly as written.
- **Reverb** is a synthesized impulse response: early reflections and band-split decaying noise (from vibetar).

### Known limits of the model

- At 48 kHz the top two octaves are too coarse: a string loop is 9 to 40 samples long there, and the hammer's striking point is a whole number of samples. (Measured before the felt and the loss were fitted; not measured again since.) From C6 up the levels of the upper partials change by up to 10 dB when the same note is computed at 96 kHz; the fundamental changes by less than 1 dB up to C7, and by 6 dB at C8. From C4 down, 48 and 192 kHz agree within 0.2 dB.
- Against the recorded notes of a Steinway B (`node tools/notes.mjs`), nothing fitted yet:
  - From C6 up the change of tone with a harder blow is not matched (C6, 2–4 kHz: 0.4 dB for each dB of level, recorded 0.1), and the felt there is not fitted.
  - The decay is fitted to one take of one note in each octave; from 5 s on, C5 and C6 fall faster than the little that the recordings show above their noise.
- No copper-wound string model, no longitudinal (phantom) partials, no second direction of string motion. A single bass string therefore has one decay, not two.
- The soundboard is a rectangle with even stiffness: no real outline, no bridges or ribs as parts, no case, no air under the board. The strings do not feel it.
- The chain is matched to the loud notes only. The medium recorded notes are darker above 3 kHz than the model's (the mean gap over medium and loud notes there was 10 to 12 dB when the loud ones alone were within 6 dB). Either they were played softer than the 1.5 m/s assumed, or the felt is still too hard for soft playing.

## Comparing with a recording

```bash
node tools/ltas.mjs reference.flac model.wav
```

prints the long-term spectrum of both files in third-octave bands (decoded with `ffmpeg`), each relative to its own total level, and their difference.

```bash
node tools/notes.mjs
```

compares recorded single notes (the C of each octave, soft, medium and loud) with the same notes from the model, in what a soundboard, room and microphone cannot change: pitch, stiffness, decay rates, and how much level and tone change from soft to loud.

Reference recordings go into `ref/`, which is not committed: `ref/iowa/` holds 24 notes of the University of Iowa's piano samples (a Steinway B; https://theremin.music.uiowa.edu/MISpiano.html), `ref/goldberg/` a variation from the Open Goldberg Variations (Kimiko Ishizaka, a Bösendorfer 290; CC0).

## Shortcuts

| Input | Action |
| --- | --- |
| Click | Draw a note (drag to set its length) · click a note to select it |
| Drag a note | Move it · drag its right end to change its length · `Alt` turns the grid off |
| `Shift` + drag | Select several notes |
| Right click | Delete a note |
| Arrows | Move the selected notes · `Shift` + up / down by an octave |
| `Backspace` | Delete the selected notes |
| `Ctrl+C/X/V/A`, `Ctrl+Z` | Clipboard, select all, undo |
| `Space` / `Enter` | Play from the cursor / from the top |
| `L` | Loop: the region dragged in the bar ruler, or the whole song |
| Wheel | Scroll · `Shift` along the time · `Ctrl` or `+` `−` zoom |

## Development

No build step and no dependencies — static files only.

```bash
python3 -m http.server 8766
```

Then open http://localhost:8766/.

The string engine, the soundboard, the player, the song format, the demos, MIDI and the comparison tools have offline tests (Node 22+, no packages; about 8 s):

```bash
node --test "test/*.test.mjs"
```

The link format: `#z…` is the song as JSON, deflated and base64url-encoded. Notes are one flat list (start after the note before, length, key, velocity; 480 ticks to a quarter note). Settings are lists by position: a new setting goes at the end, a retired one keeps its place.

## License

See [LICENSE](LICENSE).
