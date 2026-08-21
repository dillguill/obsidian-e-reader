// esbuild.config.mjs loads this exact file as raw text (its default export
// is the worker script's source as a string) via a dedicated plugin — see
// that file's pdfWorkerAsText plugin. tsc has no way to know that on its
// own, since pdfjs-dist ships no .d.ts for this path.
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  const workerSource: string;
  export default workerSource;
}
