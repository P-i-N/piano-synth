# Strike variation: no two strikes the same

## Intent

The same key hit again gives the same sound, sample for sample. A real piano does not: the hammer, the felt, the strings and the action differ a little on every blow. This change makes every strike different. It is for listening pleasure in a hobby project; the amounts are estimates set by ear, not fitted (the Iowa recordings have one take per note and dynamic).

The flanger in the bass, the rubbery bass and the too-clean treble are separate, later changes.

## Goals

- A key hit several times at the same velocity sounds a little different each time: attack, tone, beating, knock.
- On average the note stays where it is fitted: level, tone change with velocity, decay, knock level (`test/sympathy.test.mjs`, `test/tone.test.mjs`, `test/engine.test.mjs` keep passing).

## Non-goals

- Reproducible renders. Every render and WAV export differs. Determinism can come back later by giving the app a seeded source.
- Changes to the tuning of a key: the detuning of its strings stays fixed by key. It is the same piano every time.
- A new setting in the UI.

## Constraints

- The engine takes its random source as a constructor argument, a function returning 0..1. The app gives `Math.random`; the tests give `mulberry32` with a fixed seed, so they stay deterministic.
- The worklet runs in real time: nothing allocated per sample, cost per strike only, or a few operations per sample during hammer contact.

## Approaches

1. Vary the existing parameters on each strike. Cheap; fits stay correct on average.
2. Option 1, plus new noise sources (noisy knock, noise in the felt force). The most character; the knock must be matched again.
3. Velocity jitter in the player only. Does not reach keys clicked by hand.

**Chosen: 2.** Reason given: this is a fun project, not a serious one.

## What varies (option 2)

Per strike, in `Voice.strike` and `PianoEngine.handle`:

- hammer speed: about ±3 %
- felt stiffness: about ±5 %
- how the hammer force is shared among the strings: drawn again on each strike (today fixed per key by `PIANO.uneven`)
- a delay of a few tens of microseconds between the strings a tilted hammer meets first and last
- the knock: amplitude about ±20 %, length about ±20 %

New noise:

- the knock is the present push and pull with band-limited noise added under the same envelope. Its level from 100 to 600 Hz is matched again to the recorded C6–C8 (`knockLevel`, the test in `test/sympathy.test.mjs` holds it). Under the "Action noise" setting, as today.
- felt noise: while the hammer is on the strings, its stiffness is multiplied by 1 + a little low-passed noise. Not under "Action noise": it is part of the note.

All amounts are one table in `PIANO` (`vary`), with a comment that they are estimates.

Dropped from the earlier proposal: strings that never start from rest. A residue quiet enough to be realistic is not heard; the varied shares and delays already change the beating from strike to strike.

## Left to the builder

- The exact amounts, by ear, within the bounds above.
- The noise filter for the knock and for the felt.
- The tests: one test that two strikes of the same key and velocity differ, and that the mean level of several strikes stays within 0.5 dB of the level without variation.
- README: the "How the sound is made" section gets one entry on the variation.
