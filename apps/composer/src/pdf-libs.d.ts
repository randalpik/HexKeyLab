/* Minimal ambient types for the browser PDF stack (no @types ship for these).
 * Only the surface downloadPdf() uses. */
declare module 'pdfkit/js/pdfkit.standalone.js' {
  interface PDFPageOptions { size?: string | [number, number]; margin?: number; layout?: 'portrait' | 'landscape' }
  class PDFDocument {
    constructor(opts?: PDFPageOptions & { autoFirstPage?: boolean });
    on(event: 'data', cb: (chunk: Uint8Array) => void): this;
    on(event: 'end', cb: () => void): this;
    addPage(opts?: PDFPageOptions): this;
    registerFont(name: string, src: ArrayBuffer | Uint8Array | string): this;
    end(): void;
  }
  export default PDFDocument;
}

declare module 'svg-to-pdfkit' {
  interface SVGtoPDFOptions {
    width?: number;
    height?: number;
    preserveAspectRatio?: string;
    assumePt?: boolean;
    fontCallback?: (family: string, bold: boolean, italic: boolean) => string;
  }
  function SVGtoPDF(doc: unknown, svg: string | Element, x?: number, y?: number, options?: SVGtoPDFOptions): void;
  export default SVGtoPDF;
}
