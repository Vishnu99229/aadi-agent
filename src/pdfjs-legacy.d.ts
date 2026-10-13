declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export function getDocument(source: {
    data: Uint8Array;
    disableWorker?: boolean;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
  }): { promise: Promise<PdfJsDocument> };

  interface PdfJsDocument {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfJsPage>;
  }

  interface PdfJsPage {
    getTextContent(): Promise<{ items: unknown[] }>;
  }
}
