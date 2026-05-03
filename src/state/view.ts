// @ts-nocheck
// Canvas viewport metrics. CH/kbMinW/kbOffY are constant after the load-time
// IIFE in render/canvas.ts populates them from baseKeys. CW changes on window
// resize via sizeCanvas. Read these as live bindings from any module.

export let CW = 0;
export let CH = 0;
export let kbMinW = 0;
export let kbOffY = 0;

export function setCW(v) { CW = v; }
export function setCH(v) { CH = v; }
export function setKbMinW(v) { kbMinW = v; }
export function setKbOffY(v) { kbOffY = v; }
