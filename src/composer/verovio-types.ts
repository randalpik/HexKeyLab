// Minimal type declarations for Verovio's WASM toolkit, scoped to the methods
// HKL Composer uses. The Verovio CDN script puts `verovio` on `window`; this
// file teaches TypeScript what's there.

export interface VerovioToolkit {
  loadData(mei: string): boolean;
  renderToSVG(pageNo: number, options?: object): string;
  renderToMIDI(): string;
  setOptions(options: object): boolean;
  getOptions(): string;
  getMEI(options?: object): string;
  getElementAttr(xmlId: string): string;
  getElementsAtTime(timeMs: number): { page: number; notes: string[] };
  getTimeForElement(xmlId: string): number;
  getVersion(): string;
  redoLayout(options?: object): void;
  select(options: object): boolean;
  getPageCount(): number;
}

export interface VerovioGlobal {
  module: { onRuntimeInitialized: () => void };
  toolkit: new () => VerovioToolkit;
}

declare global {
  interface Window {
    verovio?: VerovioGlobal;
  }
}
