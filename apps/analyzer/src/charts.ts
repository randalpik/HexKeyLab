// Charts — thin TS adapter around analyzer/analyzer-visualization.js.
//
// HKLViz draws the per-sample diagnostic canvas (envelope, slope, segments,
// candidates, pitch, tilt, tilt-slope panels) plus a textual diagnostic
// summary. The visualization module owns the rendering logic; this wrapper
// just constructs the entry shape it expects and forwards calls.
//
// Reuse — not rewrite — is the parity bar for retiring the dev sidecar.

// @ts-ignore .js module
import { HKLViz } from '../analysis/analyzer-visualization.js';
import type { SampleSlot, AnalysisResult } from './state.js';

interface HKLVizEntry {
  graphCanvas: HTMLCanvasElement;
  graphInfo: HTMLElement;
  rawRes: AnalysisResult | null;
  sample: { name: string; freq: number };
  result: AnalysisResult | null;
  failReason?: string;
}

/** Draw the diagnostic graph for a slot into the given canvas + info host.
 *  No-op if the slot's result has no diag (analysis failed early). */
export function drawSlotChart(slot: SampleSlot, canvas: HTMLCanvasElement, info: HTMLElement): void {
  const entry: HKLVizEntry = {
    graphCanvas: canvas,
    graphInfo: info,
    rawRes: slot.result ?? null,
    sample: { name: slot.name, freq: slot.freq },
    result: slot.result ?? null,
    failReason: slot.result?.failReason,
  };
  (HKLViz as { renderGraphForEntry: (e: HKLVizEntry) => void }).renderGraphForEntry(entry);
}

/** Build the status text for a slot via HKLViz.buildStatusText. Used by
 *  the sample table for the Status column. Returns empty string if there's
 *  no analyzer result yet. */
export function statusTextFor(slot: SampleSlot): string {
  if (!slot.result) return slot.status ?? '';
  return (HKLViz as { buildStatusText: (res: AnalysisResult) => string }).buildStatusText(slot.result);
}
