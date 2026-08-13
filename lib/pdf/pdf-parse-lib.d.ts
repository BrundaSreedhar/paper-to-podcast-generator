// @types/pdf-parse only declares the package entrypoint, not the internal
// module we import to sidestep pdf-parse's debug-path behavior.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdf(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdf;
}
