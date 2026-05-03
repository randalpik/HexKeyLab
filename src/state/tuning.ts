// @ts-nocheck
// Tuning-mode state. Read these as live ES-module bindings from any module;
// mutate via the setters so importers see the updated value.

export let curLayout = 1;
export let septimalEnabled = false;
export let equalEnabled = false;
export let septimalShift = 0;
/* band width: alternating A/B regions along lattice r axis */
export const septimalW = 3;

export function setCurLayout(v) { curLayout = v; }
export function setSeptimalEnabled(v) { septimalEnabled = v; }
export function setEqualEnabled(v) { equalEnabled = v; }
export function setSeptimalShift(v) { septimalShift = v; }
