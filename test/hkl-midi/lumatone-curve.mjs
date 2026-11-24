// Hardware-free gate for the Lumatone velocity curve.
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/lumatone-curve.mjs
//
// The curve is the piano's own law in the device's units, run up to full loudness,
// with the corner where the two meet rounded. On a piano the peak amplitude of a tone
// is proportional to the hammer's velocity (Palmer & Brown, JASA 1991); on the
// Lumatone the speed of a press is 1 ÷ its press time. So the piano line is
//   line = (F ÷ ticks)^gamma
// with gamma 1 the measured piano, no floor, and one calibration constant: `full`,
// the input velocity whose press time F is where the line reaches full loudness.
// Above that the gain is 1. `corner` rounds the point where the line meets that
// ceiling, and nothing else: it is how many dB under the corner point the curve
// passes, 0 being the hard corner, and away from the corner the curve is the line or
// the ceiling. The press time is the key's own, after its per-key scale. The gain is
// then turned into the musical velocity that the house curve plays at that gain; the
// house curve's quietest note is the bottom.
// The press time is in ticks, one scan of the board each, and it is the device's count
// plus one: the board's counter starts at 0 on the first scan that finds the key between
// its thresholds (docs/lessons.md → "A tick is one scan of the board"). HKL's interval
// table starts at 0 so that every count has its own velocity, and then the press time is
// 128 − the input velocity.
// Checks the law, that only the corner is rounded, the three scalars, Max's anchors of
// 2026-11-22, the two routes into the curve (a strike, and an input velocity as the
// Calibrate Keys graph passes it), that the law runs on count + 1, and the one-time
// resets of settings saved before the piano law and before the zero-based table.
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
assert.equal(stored().version, 8);
assert.deepEqual(stored().inputCurve, { full: DEFAULT_INPUT_CURVE.full, gamma: 1, corner: DEFAULT_INPUT_CURVE.corner }, 'no floor or ceiling is saved any more');
assert.deepEqual(stored().keyScale, { '4,18': 2.5 }, 'the key scales are untouched');
/* The saved interval table (1…127) read the device's count as the press time; it
   becomes the zero-based one, on which the press time is 128 − the velocity. */
assert.deepEqual(stored().intervalCurve, { low: 0, high: 126, gamma: 1 }, 'a saved interval table becomes 0…126');
assert.deepEqual([velocityCal.intervalCurveLow, velocityCal.intervalCurveHigh], [0, 126]);
ok('saved v6 prefs: the curve becomes full ' + DEFAULT_INPUT_CURVE.full + ' / gamma 1 and the interval table 0…126, key scales kept, stored as v8');

velocityCal.resetInputCurve();
velocityCal.resetIntervalCurve(); // thresholds 0…126: input velocity = 128 − ticks
const table = velocityCal.buildIntervalTable();
/* The device: the board sends a count, and the controller's bin is the first threshold
   the count does not exceed. A press seen in the zone on `ticks` scans sends ticks − 1. */
const deviceRaw = (count) => {
  let bin = 127;
  for (let i = 0; i < 127; i++) if (count <= table[i]) { bin = i; break; }
  return Math.max(1, 127 - bin);
};
const firmwareRaw = (ticks) => deviceRaw(ticks - 1);
const fullTicks = () => 128 - velocityCal.inputCurveFull;
/* The house curve (floor 0.05, ceiling 1, gamma 1.5), inverted: the musical velocity
   that plays at a gain. */
const musicalAt = (gain) => gain <= 0.05 ? 1 : Math.max(1, Math.min(127, Math.round(127 * Math.pow((gain - 0.05) / 0.95, 1 / 1.5))));

// ── B: the law: the piano line, its ceiling, and a rounded corner between them ──
/* line = F ÷ ticks. With k = 6.02 ÷ corner, gain = line ÷ (1 + line^k)^(1/k): the line
   where the line is under 1, 1 where it is over, and `corner` dB under both where they
   meet. */
const K = () => 20 * Math.log10(2) / velocityCal.inputCurveCorner;
const rounded = (x, k) => x / Math.pow(1 + Math.pow(x, k), 1 / k);
const hard = (t) => Math.min(1, fullTicks() / t); // the piano line run into a hard ceiling
assert.equal(velocityCal.inputCurveCorner, DEFAULT_INPUT_CURVE.corner);
assert.equal(DEFAULT_INPUT_CURVE.corner, 1, 'the default corner passes 1 dB under the corner point');
for (let t = 1; t <= 126; t++) {
  const want = rounded(fullTicks() / t, K());
  near(velocityCal.targetGainForTicks(t), want, 1e-12, t + ' ticks');
  assert.equal(velocityCal.musicalForTicks(t), musicalAt(want), t + ' ticks → musical velocity');
  /* No stacking: played back through the house curve, that musical velocity sounds at
     the curve's own gain, to within the rounding of a whole velocity (half a step is
     at most 0.006 of gain). Under the house curve's quietest note it sounds at that. */
  near(velocityCal.curveGain(velocityCal.musicalForTicks(t)), Math.max(want, velocityCal.curveGain(1)), 0.006,
    t + ' ticks plays at the curve\'s gain through the house curve');
}
ok('gain = line ÷ (1 + line^k)^(1/k); through the house curve the note sounds at that gain');

// ── C: only the corner is rounded: the ramp and the ceiling are where they were ──
near(dB(velocityCal.targetGainForTicks(fullTicks())), -1, 1e-9, 'at the corner the curve is `corner` dB under it');
/* Away from the corner it is the hard-topped line: within 0.12 dB once the press time
   is half again longer or shorter than the corner's (0.1204 at exactly half again, which
   the default `full`, 3 ticks, puts on a whole tick), within 0.03 dB at double or half. */
for (let t = 0.25; t <= 400; t += 0.25) {
  const off = dB(velocityCal.targetGainForTicks(t)) - dB(hard(t));
  assert.equal(off <= 1e-12 && off >= -1.0001, true, t + ' ticks: never above the line or its ceiling, never more than the corner under');
  const ratio = Math.max(t / fullTicks(), fullTicks() / t);
  if (ratio >= 1.5) assert.equal(off >= -0.1205, true, t + ' ticks is on the hard-topped line (' + off.toFixed(3) + ' dB)');
  if (ratio >= 2) assert.equal(off >= -0.03, true, t + ' ticks: ' + off.toFixed(4) + ' dB');
}
/* From 8 ticks down: 5 ticks is within the rounding of a 3-tick corner (5.96 dB). */
for (const t of [8, 13, 23, 48, 100]) {
  near(dB(velocityCal.targetGainForTicks(t)) - dB(velocityCal.targetGainForTicks(2 * t)), 6.02, 0.02, 'doubling ' + t + ' ticks costs 6 dB');
}
near(dB(velocityCal.targetGainForTicks(1)), 0, 0.01, 'the fastest bin is full');
assert.equal(velocityCal.musicalForTicks(1), 127);
assert.equal(velocityCal.targetGainForTicks(0), 1, 'a press too fast to time is full');
near(velocityCal.targetGainForTicks(1e6), 0, 1e-5, 'no floor: a very slow press tends to silence');
assert.equal(velocityCal.musicalForTicks(1e6), 1, 'which plays as the quietest note');
let prev = Infinity;
for (let t = 0; t <= 600; t++) {
  const m = velocityCal.musicalForTicks(t / 2);
  assert.equal(m <= prev && m >= 1 && m <= 127, true, 'a slower press is never louder (' + t / 2 + ' ticks)');
  prev = m;
}
ok('1 dB under the corner point, on the hard-topped line to 0.12 dB half again away from it; full at the top, no floor');

// ── D: the default curve by input velocity, and Max\'s anchors on it ──
/* The default `full`, 125.0, is 3 ticks: the line reaches the house curve\'s quietest
   note (velocity 1, −25.9 dB) at 59 ticks, input velocity 69. The rounded corner moves
   nothing away from the corner. */
near(dB(velocityCal.targetGainForTicks(128 - 123)), -4.5, 0.05, 'input velocity 123');
near(dB(velocityCal.targetGainForTicks(128 - 105)), -17.7, 0.05, 'input velocity 105');
near(dB(velocityCal.targetGainForTicks(128 - 80)), -24.1, 0.05, 'input velocity 80');
/* Max\'s f, p and ppp of 2026-11-22 (min lo 3) were device counts of 5, 23 and 48,
   which the 1…127 table of that day showed as input velocities 123, 105 and 80. They
   are 6, 24 and 49 ticks: input velocities 122, 104 and 79. */
for (const [name, count, level] of [['f', 5, -6.0], ['p', 23, -18.1], ['ppp', 48, -24.3]]) {
  assert.equal(deviceRaw(count), 127 - count, name + ': a count of ' + count + ' is input velocity ' + (127 - count));
  near(dB(velocityCal.targetGainForTicks(velocityCal.ticksOf(deviceRaw(count)))), level, 0.05, name + ', a count of ' + count);
}
near(dB(velocityCal.targetGainForTicks(2)), -0.1, 0.05, 'two ticks, above the corner');
near(dB(velocityCal.targetGainForTicks(3)), -1.0, 0.05, 'three ticks, the corner itself (the hard corner: full)');
near(dB(velocityCal.targetGainForTicks(4)), -2.7, 0.05, 'four ticks, below it (the hard corner: −2.5)');
assert.equal(velocityCal.applyInputCurve(79), 7, 'ppp plays above the quietest note');
assert.equal(velocityCal.applyInputCurve(69), 1, 'a 59-tick press plays as the quietest note');
assert.equal(velocityCal.applyInputCurve(60), 1, 'and so does anything softer');
assert.equal(velocityCal.applyInputCurve(70) > 1, true, 'the curve rises from there');
assert.equal(velocityCal.applyInputCurve(127), 127);
ok('defaults: −4.5 dB at input velocity 123, the quietest note at 69; Max\'s f, p and ppp at −6.0, −18.1 and −24.3 dB');

// ── E: the three scalars ──
/* `corner`: 0 is the hard corner exactly; larger is rounder, and still only near it. */
velocityCal.setInputCurveCorner(0);
for (let t = 0.5; t <= 200; t += 0.5) assert.equal(velocityCal.targetGainForTicks(t), hard(t), 'corner 0 is the hard-topped line at ' + t + ' ticks');
velocityCal.setInputCurveCorner(3);
near(dB(velocityCal.targetGainForTicks(fullTicks())), -3, 1e-9, 'corner 3: 3 dB under the corner point');
near(velocityCal.targetGainForTicks(5), rounded(fullTicks() / 5, K()), 1e-12);
/* p, 23 ticks: 0.07 dB under the line with a 3 dB corner at 3 ticks. */
assert.equal(dB(velocityCal.targetGainForTicks(23)) - dB(hard(23)) > -0.1, true, 'and p is still on the line, to 0.1 dB');
velocityCal.resetInputCurve();
assert.equal(velocityCal.inputCurveCorner, 1);
/* `full` is where the piano line reaches full: the corner sits there. */
const softBefore = velocityCal.targetGainForTicks(400), defaultFullTicks = fullTicks();
velocityCal.setInputCurveFull(120);
near(dB(velocityCal.targetGainForTicks(8)), -1, 1e-9, 'full at 120: the corner is at 8 ticks');
near(dB(velocityCal.targetGainForTicks(4)), 0, 0.03, 'presses well above it are full');
near(dB(velocityCal.targetGainForTicks(16)), -6.02, 0.03, 'and well below it the line');
near(dB(velocityCal.targetGainForTicks(400)) - dB(softBefore), 20 * Math.log10(8 / defaultFullTicks), 0.01, 'the soft end follows the line');
velocityCal.resetInputCurve();
velocityCal.setInputCurveGamma(1.5);
for (const t of [1, 2, 3, 5, 10, 20, 40]) {
  near(velocityCal.targetGainForTicks(t), rounded(Math.pow(fullTicks() / t, 1.5), K()), 1e-12, 'gamma is an exponent on the line, under the same corner');
}
velocityCal.resetInputCurve();
assert.equal(velocityCal.inputCurveGamma, 1);
assert.equal(velocityCal.inputCurveFull, DEFAULT_INPUT_CURVE.full);
assert.deepEqual(stored().inputCurve, { full: DEFAULT_INPUT_CURVE.full, gamma: 1, corner: 1 });
ok('`corner` 0 is the hard corner and 3 a rounder one; `full` places the line and its corner; gamma is an exponent on the line');

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
for (const [low, high] of [[0, 126], [1, 127], [1, 128], [3, 50]]) {
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
ok('applyInputCurve(v) is the strike\'s value at every whole input velocity, on four interval tables');

// ── H: the piano law runs on the press time, the device\'s count plus one ──
/* A count of c is c + 1 scans, so the amplitude is proportional to 1 ÷ (c + 1): well
   under the corner, counts of 7 and 15 (8 and 16 ticks) are 6.02 dB apart, and so are
   23 and 47. Read as the time itself, the count would put 7 and 15 at 6.6 dB. */
for (let count = 0; count <= 125; count++) {
  assert.equal(velocityCal.ticksOf(deviceRaw(count)), count + 1, 'a count of ' + count + ' is ' + (count + 1) + ' ticks');
}
const gainAtCount = (count) => velocityCal.targetGainForTicks(velocityCal.ticksOf(deviceRaw(count)));
near(dB(gainAtCount(7)) - dB(gainAtCount(15)), 6.02, 0.02, 'counts 7 and 15 are 8 and 16 ticks: 6 dB');
near(dB(gainAtCount(23)) - dB(gainAtCount(47)), 6.02, 0.02, 'counts 23 and 47 are 24 and 48 ticks: 6 dB');
assert.equal(deviceRaw(0), 127, 'one scan seen in the zone is velocity 127');
assert.equal(deviceRaw(1), 126, 'two scans seen is its own velocity, 126');
assert.equal(velocityCal.lumatoneVelocity('1,0', deviceRaw(0)) >= velocityCal.lumatoneVelocity('1,0', deviceRaw(1)), true);
near(dB(velocityCal.targetGainForTicks(velocityCal.keyTicks('4,18', deviceRaw(1)))), dB(gainAtCount(4)), 1e-9,
  'a key scaled 2.5 at a count of 1 (2 ticks) is an unscaled key at 5 ticks, a count of 4');
ok('amplitude ∝ 1 ÷ (count + 1): counts 0 and 1 are separate velocities, and a key\'s scale multiplies the ticks');

console.log('\nlumatone-curve: ' + checks + ' checks passed');
