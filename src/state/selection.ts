// @ts-nocheck
// Per-frame selection state. drawnKeys is rebuilt every animation frame from
// selectedKeys + the current layout-shift delta — see lessons.md (selection
// state is per-frame, recomputed via layout-shift delta).

export let selectedKeys = new Set();
export let drawnKeys = [];

export function setSelectedKeys(s) { selectedKeys = s; }
export function setDrawnKeys(arr) { drawnKeys = arr; }
