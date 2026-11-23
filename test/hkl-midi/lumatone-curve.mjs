// Hardware-free gate for the Lumatone velocity curve.
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/lumatone-curve.mjs
//
// The curve is the piano's own law in the device's units. On a piano the peak
// amplitude of a tone is proportional to the hammer's velocity (Palmer & Brown, JASA
// 1991); on the Lumatone the speed of a press is 1 ÷ its press time. So
//   gain = (fullTicks ÷ ticks)^gamma, never above 1
// with gamma 1 the measured piano, no floor, and one calibration constant: `full`,
// the input velocity at which a press reaches full loudness (fullTicks is its press
// time). The press time is the key's own, after its per-key scale. The gain is then
// turned into the musical velocity that the house curve plays at that gain; the
// house curve's quietest note is the bottom.
// Checks the law, the ends, the two scalars, Max's anchors of 2026-11-22, the two
// routes into the curve (a strike, and an input velocity as the Calibrate Keys graph
// passes it), and the one-time reset of settings saved for the previous curve.
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
globalThis.location = { search: '' }; // savePrefs reads it (the ?overlay build saves nothing)
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k),
};

/* What a profile saved before this curve holds: velocityCal v6, the press-time curve
   with a floor, a ceiling and its own gamma. */
localStorage.setItem('hkl.prefs.v1', JSON.stringify({ velocityCal: {
  version: 6, floor: 0.05, ceiling: 1, gamma: 1.5, keyScale: { '4,18': 2.5 },
  inputCurve: { floor: 0.12, ceiling: 0.9, gamma: 0.7 },
  intervalCurve: { low: 1, high: 127, gamma: 1 },
} }));

const { velocityCal, DEFAULT_INPUT_CURVE } = await import('../../apps/hkl/src/audio/velocityCal.ts');
const stored = () => JSON.parse(localStorage.getItem('hkl.prefs.v1')).velocityCal;

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };
const near = (a, b, tol, label) => assert.equal(Math.abs(a - b) <= tol, true, label + ': ' + a + ' vs ' + b + ' (±' + tol + ')');
const dB = (g) => 20 * Math.log10(g);

// ── A: settings saved for the previous curve are replaced once ──
assert.equal(velocityCal.inputCurveGamma, 1, 'the default gamma is the piano\'s, 1');
assert.equal(DEFAULT_INPUT_CURVE.gamma, 1);
assert.equal(velocityCal.inputCurveFull, DEFAULT_INPUT_CURVE.full);
assert.equal(stored().version, 7);
assert.deepEqual(stored().inputCurve, { full: DEFAULT_INPUT_CURVE.full, gamma: 1 }, 'no floor or ceiling is saved any more');
assert.deepEqual(stored().keyScale, { '4,18': 2.5 }, 'the key scales are untouched');
ok('saved v6 prefs: the curve becomes full ' + DEFAULT_INPUT_CURVE.full + ' / gamma 1, key scales kept, stored as v7');

velocityCal.resetInputCurve();
velocityCal.resetIntervalCurve(); // thresholds 1…127: input velocity = 128 − ticks
const table = velocityCal.buildIntervalTable();
const firmwareRaw = (ticks) => {
  let bin = 127;
  for (let i = 0; i < 127; i++) if (ticks <= table[i]) { bin = i; break; }
  return Math.max(1, 127 - bin);
};
const fullTicks = () => 128 - velocityCal.inputCurveFull;
/* The house curve (floor 0.05, ceiling 1, gamma 1.5), inverted: the musical velocity
   that plays at a gain. */
const musicalAt = (gain) => gain <= 0.05 ? 1 : Math.max(1, Math.min(127, Math.round(127 * Math.pow((gain - 0.05) / 0.95, 1 / 1.5))));

// ── B: the law: amplitude proportional to speed ──
for (let t = 1; t <= 126; t++) {
  const want = Math.min(1, fullTicks() / t);
  near(velocityCal.targetGainForTicks(t), want, 1e-12, t + ' ticks');
  assert.equal(velocityCal.musicalForTicks(t), musicalAt(want), t + ' ticks → musical velocity');
  /* No stacking: played back through the house curve, that musical velocity sounds at
     the curve's own gain, to within the rounding of a whole velocity (half a step is
     at most 0.006 of gain). Under the house curve's quietest note it sounds at that. */
  near(velocityCal.curveGain(velocityCal.musicalForTicks(t)), Math.max(want, velocityCal.curveGain(1)), 0.006,
    t + ' ticks plays at the curve\'s gain through the house curve');
}
for (const t of [3, 5, 8, 13, 21, 40]) {
  near(dB(velocityCal.targetGainForTicks(t)) - dB(velocityCal.targetGainForTicks(2 * t)), 20 * Math.log10(2), 1e-9,
    'doubling ' + t + ' ticks costs 6.02 dB');
}
ok('gain = fullTicks ÷ ticks, 6.02 dB per doubling; through the house curve the note sounds at that gain');

// ── C: the ends: nothing above full, no floor, the house curve\'s quietest note below ──
assert.equal(velocityCal.targetGainForTicks(fullTicks()), 1, 'the full press time is full');
assert.equal(velocityCal.targetGainForTicks(1), 1, 'and so is anything faster');
assert.equal(velocityCal.targetGainForTicks(0), 1);
assert.equal(velocityCal.musicalForTicks(1), 127);
near(velocityCal.targetGainForTicks(1e6), 0, 1e-5, 'no floor: a very slow press tends to silence');
assert.equal(velocityCal.musicalForTicks(1e6), 1, 'which plays as the quietest note');
let prev = Infinity;
for (let t = 0; t <= 600; t++) {
  const m = velocityCal.musicalForTicks(t / 2);
  assert.equal(m <= prev && m >= 1 && m <= 127, true, 'a slower press is never louder (' + t / 2 + ' ticks)');
  prev = m;
}
ok('full at the full press time and faster; no floor; a slower press is never louder');

// ── D: Max\'s anchors (2026-11-22, input velocities with min lo 3) on the defaults ──
/* f v123, p v105, ppp under v80. The default `full` is the one that puts v80 on the
   house curve\'s quietest note (velocity 1, −25.9 dB). */
near(dB(velocityCal.targetGainForTicks(128 - 123)), -6.4, 0.05, 'f, input velocity 123');
near(dB(velocityCal.targetGainForTicks(128 - 105)), -19.6, 0.05, 'p, input velocity 105');
near(dB(velocityCal.targetGainForTicks(128 - 80)), -26.0, 0.05, 'ppp, input velocity 80');
assert.equal(velocityCal.applyInputCurve(80), 1, 'ppp plays as the quietest note');
assert.equal(velocityCal.applyInputCurve(60), 1, 'and so does anything softer');
assert.equal(velocityCal.applyInputCurve(81) >= 1 && velocityCal.applyInputCurve(86) > 1, true, 'the curve rises from there');
assert.equal(velocityCal.applyInputCurve(127), 127);
assert.equal(velocityCal.applyInputCurve(126), 127, 'two ticks is full on the defaults');
ok('defaults: f −6.4 dB, p −19.6 dB, ppp at the quietest note, full by input velocity ' + DEFAULT_INPUT_CURVE.full);

// ── E: the two scalars ──
velocityCal.setInputCurveFull(123);
assert.equal(velocityCal.targetGainForTicks(5), 1, 'full at 123: a 5-tick press is full');
near(dB(velocityCal.targetGainForTicks(10)), -6.02, 0.01, 'and 10 ticks is one doubling under it');
velocityCal.setInputCurveFull(127);
assert.equal(velocityCal.targetGainForTicks(1), 1);
near(dB(velocityCal.targetGainForTicks(2)), -6.02, 0.01, 'full at 127: only the fastest bin is full');
velocityCal.resetInputCurve();
const piano = [5, 10, 20, 40].map((t) => velocityCal.targetGainForTicks(t));
velocityCal.setInputCurveGamma(1.5);
const steep = [5, 10, 20, 40].map((t) => velocityCal.targetGainForTicks(t));
for (let i = 0; i < 4; i++) near(steep[i], Math.pow(piano[i], 1.5), 1e-12, 'gamma is an exponent on the piano law');
assert.equal(velocityCal.targetGainForTicks(fullTicks()), 1, 'full does not move with gamma');
velocityCal.resetInputCurve();
assert.equal(velocityCal.inputCurveGamma, 1);
assert.equal(velocityCal.inputCurveFull, DEFAULT_INPUT_CURVE.full);
assert.deepEqual(stored().inputCurve, { full: DEFAULT_INPUT_CURVE.full, gamma: 1 });
ok('`full` moves where full loudness sits; gamma bends the law around it and is 1 for a piano');

// ── F: a strike: the key\'s own press time, scaled, straight into the curve ──
assert.equal(velocityCal.lumatoneVelocity('1,0', 0), 0, 'velocity 0 stays a note-off');
for (let raw = 1; raw <= 127; raw++) {
  assert.equal(velocityCal.lumatoneVelocity('1,0', raw), velocityCal.musicalForTicks(velocityCal.ticksOf(raw)), 'unscaled key, raw ' + raw);
}
for (let t = 1; t <= 40; t++) {
  assert.equal(velocityCal.lumatoneVelocity('4,18', firmwareRaw(t)), velocityCal.musicalForTicks(t * 2.5), 'scaled key at ' + t + ' ticks');
}
assert.equal(velocityCal.lumatoneVelocity('4,18', firmwareRaw(4)), velocityCal.lumatoneVelocity('3,10', firmwareRaw(10)),
  'a key scaled 2.5 at 4 ticks = an unscaled key at 10');
ok('a strike plays at the curve\'s value for its scaled press time');

// ── G: an input velocity (the graph\'s axis) takes the same curve ──
for (const [low, high] of [[1, 127], [1, 128], [3, 50]]) {
  velocityCal.setIntervalCurveLow(low);
  velocityCal.setIntervalCurveHigh(high);
  for (let raw = 1; raw <= 127; raw++) {
    assert.equal(velocityCal.applyInputCurve(raw), velocityCal.lumatoneVelocity('1,0', raw), low + '…' + high + ', raw ' + raw);
  }
}
velocityCal.resetIntervalCurve();
assert.equal(velocityCal.applyInputCurve(0), 0);
for (const k of ['1,0', '4,18']) {
  for (let t = 1; t <= 50; t++) {
    near(velocityCal.applyInputCurve(velocityCal.applyKeyScale(k, firmwareRaw(t))), velocityCal.lumatoneVelocity(k, firmwareRaw(t)), 1,
      k + ' at ' + t + ' ticks: the input velocity and the strike agree');
  }
}
ok('applyInputCurve(v) is the strike\'s value at every whole input velocity, on three interval tables');

console.log('\nlumatone-curve: ' + checks + ' checks passed');
