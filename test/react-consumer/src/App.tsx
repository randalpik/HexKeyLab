import { useEffect, useState } from 'react';
import * as engine from '@hexkeylab/engine';
import type { InstrumentDef } from '@hexkeylab/engine';
import { synthSineWav } from './synthWav';

type Step = { label: string; ok: boolean; detail?: string };

const SAMPLE_FILE = 'tone.wav';
// A just-intonation major triad on A3: 1/1, 5/4, 3/2.
const ROOT = 220;
const THIRD = 220 * (5 / 4);
const FIFTH = 220 * (3 / 2);

function instrumentDef(): InstrumentDef {
  return {
    name: 'SmokeTone',
    source: 'hki',          // bytes come from instrumentProvider — zero network
    loop: true,             // exercise the click-free segment-loop crossfade path
    releaseTime: 0.15,
    samples: [
      { name: 'A3', freq: ROOT, file: SAMPLE_FILE, segments: [{ a: 0.05, b: 0.45 }] },
    ],
  };
}

let ctx: AudioContext | null = null;

/** Wire the engine + load the synthetic instrument once. Safe while the
 *  AudioContext is suspended (decode + scheduling populate state regardless). */
async function setup(): Promise<void> {
  if (ctx) return;
  const wav = synthSineWav(ROOT, 0.5);
  ctx = new AudioContext();
  (window as any).__smokeCtx = ctx;
  engine.init(ctx, ctx.destination, {
    velocityToGain: (v) => v / 127,
    instrumentProvider: async () => ({ [SAMPLE_FILE]: wav }),
  });
  await engine.loadInstrument('tone', instrumentDef());
  engine.setInstrument('tone');
}

function triad(): void {
  engine.sNoteOn('root', ROOT, 90);
  engine.sNoteOn('third', THIRD, 90);
  engine.sNoteOn('fifth', FIFTH, 90);
}

export default function App() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [pass, setPass] = useState<boolean | null>(null);

  useEffect(() => {
    const acc: Step[] = [];
    const push = (label: string, ok: boolean, detail?: string) => {
      acc.push({ label, ok, detail });
      setSteps([...acc]);
    };
    (async () => {
      try {
        push('import @hexkeylab/engine', typeof engine.init === 'function',
          `${Object.keys(engine).length} exports`);
        await setup();
        push('init() against real AudioContext', !!ctx, `ctx.state=${ctx?.state}`);
        push('loadInstrument() + decodeAudioData', engine.isInstrumentLoaded('tone'));
        triad();
        const n = Object.keys(engine.getActiveVoices()).length;
        push('play JI major triad', n === 3, `${n} active voices`);
        const retuned = engine.sRampFreq('third', THIRD * 1.01, 0.3);
        push('sRampFreq() real-time retune', retuned !== false);

        const ok = acc.every((s) => s.ok);
        setPass(ok);
        (window as any).__SMOKE_RESULT = { pass: ok, steps: acc };
      } catch (e) {
        push('ERROR', false, String(e));
        setPass(false);
        (window as any).__SMOKE_RESULT = { pass: false, steps: acc, error: String(e) };
      }
    })();
  }, []);

  // By-ear controls for manual runs (audio needs a user gesture to start).
  const playAudible = async () => {
    await setup();
    await ctx!.resume();
    engine.sStopAll();
    triad();
  };
  const retuneThird = () => engine.sRampFreq('third', THIRD * 1.01, 0.5);
  const stop = () => engine.sStopAll();

  const banner =
    pass === null ? '#888' : pass ? '#1a7f37' : '#cf222e';

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '40px auto', padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>@hexkeylab/engine — React consumer smoke</h1>
      <p style={{ color: '#555' }}>
        Imports the <b>built</b> package, runs <code>init()</code> against a real
        <code> AudioContext</code>, decodes a synthetic sample, plays a
        just-intonation triad, and retunes the third in real time.
      </p>
      <div style={{
        background: banner, color: 'white', padding: '8px 12px', borderRadius: 6,
        fontWeight: 600, marginBottom: 16,
      }}>
        {pass === null ? 'running…' : pass ? 'PASS' : 'FAIL'}
      </div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {steps.map((s, i) => (
          <li key={i} style={{ padding: '4px 0', color: s.ok ? '#1a7f37' : '#cf222e' }}>
            {s.ok ? '✓' : '✗'} {s.label}
            {s.detail ? <span style={{ color: '#888' }}> — {s.detail}</span> : null}
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button onClick={playAudible}>▶ Play triad (audible)</button>
        <button onClick={retuneThird}>↻ Retune third</button>
        <button onClick={stop}>■ Stop</button>
      </div>
    </div>
  );
}
