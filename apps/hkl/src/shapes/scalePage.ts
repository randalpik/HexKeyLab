// A key on a layout, as a page: what it takes to play in it (./profile.ts).
// Entry point of scales.html, the page the Guide's Scales tab shows; laid out
// for print like the shape guide (./page.ts), with which it shares its query
// and its pictures (./pageParts.ts).
//
//   /scales.html?mapping=…&mode=…&root=…&scale=…
//     scale: a key profile's id (@hkl/shared/keyProfiles.js). On offer are
//     the keys whose scale the layout plays as a run from the reference key
//     (for a minor key, one of its three), whatever it plays of their chords.
//     One that is not on offer, or none, falls back to the first that is.
//
// The page tells whoever framed it which keys are on offer and which it
// shows: in <body data-scales data-scale>, and to its parent as a message
// { type: 'hkl-scales', scales, scale }. The Guide may not import HKL, so that
// is how its Scales tab fills its dropdown.
//
// After the title: the footprint, starting from the scale and growing with
// each tier of chords, drawn as a scale is, from the reference key; then the
// chords of each tier, each in root position from its root's key there, and
// under them the numerals of those the layout cannot play so. A chord the
// catalog lacks is named as HKL names its keys. No note is named in text
// (Max, 2026-11-19):
// plain text cannot spell arrows, hooks and stacked accidentals, so the keys
// say which notes they are.

import { TUNING_LABELS } from '@hkl/shared/freq.js';
import { mappingLabel } from '@hkl/shared/mapping.js';
import { tonicLabel } from '@hkl/shared/tonic.js';
import { setHexSize, setRotation } from '../layout/geometry.js';
import { combinedRatio } from './catalog.js';
import { PROFILES, TIERS, TIER_NAMES, chordName, chordShape, footprintSteps, keyPlace, profileOf, type KeyPlace, type KeyProfile, type ProfileChord, type Step, type Tier } from './profile.js';
import { room, rowsOf, type Fit } from './rows.js';
import { GUIDE_ALIGNMENT, GUIDE_ROTATION, type Shape } from './solve.js';
import { capital, dark, el, layout, mapping, mode, picture, query, ref, root } from './pageParts.js';

/* "a", "a and b", "a, b and c" */
const listed = (xs: ReadonlyArray<string>): string => (xs.length < 3 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
const fitOf = (width: number): Fit => (width <= room(3) ? 3 : width <= room(2) ? 2 : 1);
/* entries in rows, as many to a row as fit */
function rows(section: HTMLElement, made: ReadonlyArray<{ box: HTMLElement; fit: Fit }>): void {
  for (const r of rowsOf(made.map((m) => m.fit))) {
    const row = el('div', 'row');
    row.dataset.columns = String(r.columns);
    row.append(...made.slice(r.start, r.start + r.count).map((m) => m.box));
    section.append(row);
  }
}

/** The footprint: the scale, then the scale with each tier's notes, a picture
 *  to each step that adds a key (steps that draw the same keys share one).
 *  Under a picture's name: how many notes it has (of how many, where the
 *  octave above the reference key lacks some), and what of its steps the layout cannot play
 *  (`unplayable`: a scale by name, a chord by numeral). */
function footprintSection(profile: KeyProfile, place: KeyPlace, unplayable: ReadonlyMap<Step, ReadonlyArray<string>>): HTMLElement {
  const section = el('section', 'section');
  section.dataset.part = 'footprint';
  section.append(el('h2', '', 'Footprint'));
  const scaleName = profile.scales.length === 1 ? profile.scales[0]!.name : `${profile.name} scales`;
  /* a key's scales are named under its first picture only where one is of another flavor than
     the key (Max, 2026-11-19): Semiditonal minor, whose natural form is the Pythagorean one */
  const flavor = profile.name.split(' ')[0]!.toLowerCase();
  const mixed = profile.scales.some((x) => x.name.split(' ')[0]!.toLowerCase() !== flavor);
  const made = footprintSteps(profile, layout, ref, place).map((f) => {
    const box = el('article', 'entry');
    box.id = 'f' + f.steps[0];
    box.dataset.steps = f.steps.join(' ');
    const what = listed(f.steps.map((s) => (s === 0 ? scaleName : TIER_NAMES[s])));
    box.append(el('h3', 'name', f.steps[0]! <= 1 ? capital(what) : 'With the ' + what));
    box.append(el('p', 'facts', f.drawn === f.pitches ? `${f.pitches} notes` : `${f.drawn} of ${f.pitches} notes`));
    if (f.steps[0] === 0 && mixed) box.append(el('p', 'intervals', capital(profile.scales.map((x) => x.name.replace(/ scale$/, '')).join(', '))));
    const no = f.steps.flatMap((s) => unplayable.get(s) ?? []);
    if (no.length) box.append(el('p', 'unplayed', 'Unplayable: ' + no.join(', ')));
    const { img, width } = picture(f.shape, `${profile.name}: ${what}`);
    box.append(img);
    return { box, fit: fitOf(width) };
  });
  rows(section, made);
  return section;
}

/** One chord of the key that the layout plays: its numeral, name and ratio,
 *  and its picture, in root position from its root's key. */
function chordEntry(c: ProfileChord, n: number, shape: Shape): { box: HTMLElement; fit: Fit } {
  const box = el('article', 'entry');
  box.id = 'c' + n;
  box.dataset.label = c.label;
  const head = el('h3', 'name'), name = chordName(c, shape, layout);
  head.append(el('span', 'numeral', c.label), ' ' + capital(name));
  box.append(head, el('p', 'facts', combinedRatio(c.members)));
  const { img, width } = picture(shape, `${c.label}: ${name}`);
  box.append(img);
  return { box, fit: fitOf(width) };
}

async function main(): Promise<void> {
  setHexSize('medium');
  setRotation(GUIDE_ROTATION, mapping, GUIDE_ALIGNMENT);
  await document.fonts.load('12px BravuraText');
  const page = document.getElementById('guide')!;
  page.style.setProperty('--indent', '0px');
  const start = tonicLabel(root), where = `${mappingLabel(mapping)} mapping, ${TUNING_LABELS[mode]} tuning`;

  /* the keys this layout offers, and the one to show */
  const places = new Map(PROFILES.map((p) => [p, keyPlace(p, layout, ref, root)]));
  const offered = PROFILES.filter((p) => places.get(p));
  const asked = profileOf(query.get('scale'));
  const profile = asked && offered.includes(asked) ? asked : offered[0] ?? null;
  const scales = offered.map((p) => p.id);
  document.body.dataset.scales = scales.join(',');
  document.body.dataset.scale = profile?.id ?? '';
  if (window.parent !== window) window.parent.postMessage({ type: 'hkl-scales', scales, scale: profile?.id ?? null }, location.origin);

  if (!profile) {
    const title = `No key on ${start}: ${where}`;
    document.title = title;
    page.append(el('h1', '', title), el('p', 'legend', `This layout plays the scale of none of the keys on offer from ${start}, with the reference note set to the unaltered ${start}.`));
    document.body.dataset.ready = 'none';
    return;
  }
  const title = `${start} ${profile.name}: ${where}`;
  document.title = title;
  page.append(el('h1', '', title));
  page.append(el('p', 'legend',
    `What it takes to play in ${start} ${profile.name} on the Lumatone in this layout, with the reference note set to the unaltered ${start}. `
    + 'The footprint is every note the key needs, in the octave of its scale: the scale, then the notes each kind of chord adds. '
    + 'Each chord is drawn in root position from its root in that octave, in its closest reachable arrangement; the chords the layout cannot play so are named under their section. '
    + 'Solid keys are the notes of a shape; faint keys only show the way between them. '
    + `A heavy ${dark ? 'white' : 'black'} line is a band seam.`));

  /* what the layout plays: the scales by name, the chords by numeral */
  const place = places.get(profile)!;
  const shapes = new Map(profile.chords.map((c) => [c, chordShape(c, layout, ref, place, root)]));
  const unplayable = new Map<Step, string[]>([[0, profile.scales.filter((_, i) => !place.runs[i]).map((x) => capital(x.name))]]);
  for (const tier of TIERS) unplayable.set(tier, profile.chords.filter((c) => c.tier === tier && !shapes.get(c)).map((c) => c.label));
  page.append(footprintSection(profile, place, unplayable));

  let n = 0;
  const played: Partial<Record<Tier, string>> = {};
  for (const tier of TIERS) {
    const chords = profile.chords.filter((c) => c.tier === tier);
    if (!chords.length) continue;
    const section = el('section', 'section');
    const made = chords.flatMap((c) => { const shape = shapes.get(c); return shape ? [chordEntry(c, ++n, shape)] : []; });
    played[tier] = `${made.length}/${chords.length}`;
    section.dataset.tier = String(tier);
    section.append(el('h2', '', `${capital(TIER_NAMES[tier])} (${made.length} of ${chords.length} on this layout)`));
    rows(section, made);
    const no = unplayable.get(tier)!;
    if (no.length) section.append(el('p', 'unplayed', 'Unplayable on this layout: ' + no.join(', ')));
    page.append(section);
  }
  document.body.dataset.played = TIERS.map((t) => played[t] ?? '0/0').join(' ');
  document.body.dataset.ready = String(n);
}

void main();
