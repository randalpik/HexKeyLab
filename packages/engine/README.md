# @hexkeylab/engine (HKLE)

The HexKeyLab audio engine: sample-based, just-intonation playback with
**click-free looping**. It never uses `AudioBufferSourceNode.loop`; sustained
notes loop by crossfading discrete one-shot sources at analyzer-computed segment
seams on the audio clock. Pitch glides and real-time retuning are first-class.

It is **environment-agnostic**: you bring a Web Audio `AudioContext` and a few
host hooks; the engine has no DOM, MIDI, storage, or framework coupling. That
makes it usable in a browser app, or in React Native via
[`react-native-audio-api`](https://github.com/software-mansion/react-native-audio-api)
(a Web Audio implementation).

Zero runtime dependencies.

## Install

```sh
npm install @hexkeylab/engine
```

## Quick start

```ts
import { init, loadInstrument, sNoteOn, sNoteOff, sRampFreq } from '@hexkeylab/engine';

const ctx = new AudioContext();

// 1. Wire the engine to your audio graph + inject host hooks.
init(ctx, ctx.destination, {
  // Velocity (0–127) → linear gain. Defaults to v/127.
  velocityToGain: (v) => v / 127,
  // Supply bytes for an .hki bundle instrument, keyed by sample filename.
  // (Return null for CDN-style instruments, which fetch by URL instead.)
  instrumentProvider: async (key) => myHkiBytesFor(key),
  // Optional: override URL loading (e.g. resolve expo-asset URIs in RN).
  // audioFetch: (url) => fetch(url).then((r) => r.arrayBuffer()),
});

// 2. Load an instrument definition (see InstrumentDef).
await loadInstrument('viola', violaInstrumentDef);

// 3. Play and retune in real time. Instrument is per-voice — several
//    instruments can sound at once, no global mode to set.
sNoteOn('voice-1', 220, 100, 'viola'); // voiceKey, freq (Hz), velocity, instrument
sRampFreq('voice-1', 247.5, 0.2);      // glide to a JI-tuned pitch over 200 ms
sNoteOff('voice-1');
```

## API surface

- **`init(audioCtx, destNode, config?)`** — connect the engine and inject
  `instrumentProvider` / `velocityToGain` / `onSeamEvent` / `audioFetch`.
- **`loadInstrument(key, instrDef, onProgress?)`** — decode + cache an
  `InstrumentDef`'s samples (CDN URLs or `.hki` bytes).
- **Voice lifecycle** — `sNoteOn(voiceKey, freq, velocity, instrumentKey, startAt?)`,
  `sNoteOff`, `sRampFreq`, `sNoteOnFaded`, `sSlideAndFadeOut`, `sHardStop`,
  `sHardStopAll`, `sStopAll`. Instrument is specified per note; each voice
  remembers it, so simultaneous different instruments just work.
- **Expression** — `sSetAftertouch`, `sSetVoiceDamperDepth`.
- **State** — `getActiveVoices`, `isInstrumentLoaded`, `unloadInstrument`, `tapMaster`.
- **`startSegmentLooper(opts)`** — standalone single-voice segment looper
  (audition / preview), independent of the voice manager.
- **Types** — `InstrumentDef`, `SampleDef`, `SampleEngineConfig`, `SeamEvent`,
  `PaRampState`, `SegmentLooperOpts`, `SegmentLooper`.

## `.hki` instruments

Click-free looping depends on good loop segments. The HexKeyLab analyzer produces
`.hki` bundles (sustained samples + zero-crossing-matched `{a, b}` segment pairs).
Feed their bytes through `instrumentProvider`; the engine handles decode, trim,
trend-normalization, and seam scheduling.

## License

MIT
