// The key profiles the Guide's Scales tab offers, by id and label: a major and
// a minor key in each of four flavors. Pure data, so the Guide can list and
// validate them without importing HKL; what a profile is made of lives in
// apps/hkl/src/shapes/profile.ts.

export const KEY_PROFILE_IDS = [
  'ptolemaic-major', 'semiditonal-major', 'pythagorean-major', 'septimal-major',
  'ptolemaic-minor', 'semiditonal-minor', 'pythagorean-minor', 'septimal-minor',
] as const;
export type KeyProfileId = (typeof KEY_PROFILE_IDS)[number];

export const KEY_PROFILE_LABELS: Readonly<Record<KeyProfileId, string>> = {
  'ptolemaic-major': 'Ptolemaic major', 'semiditonal-major': 'Semiditonal major',
  'pythagorean-major': 'Pythagorean major', 'septimal-major': 'Septimal major',
  'ptolemaic-minor': 'Ptolemaic minor', 'semiditonal-minor': 'Semiditonal minor',
  'pythagorean-minor': 'Pythagorean minor', 'septimal-minor': 'Septimal minor',
};

export const isKeyProfileId = (x: unknown): x is KeyProfileId => typeof x === 'string' && (KEY_PROFILE_IDS as ReadonlyArray<string>).includes(x);
