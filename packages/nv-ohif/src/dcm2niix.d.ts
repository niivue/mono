/**
 * Ambient types for `@niivue/dcm2niix` (no `.d.ts` shipped upstream).
 *
 * Covers the surface this wrapper actually uses. The full Processor
 * has dozens of chainable command setters — they all share the same
 * signature, so we model that with an index signature.
 */
declare module '@niivue/dcm2niix' {
  export interface Dcm2niixProcessor {
    /** Run the conversion and resolve to the output files. */
    run(): Promise<File[]>
    /** Any chainable dcm2niix command flag (`compressionLevel`, `bids`, ...). */
    [command: string]: (
      ...args: unknown[]
    ) => Dcm2niixProcessor | Promise<File[]>
  }

  export class Dcm2niix {
    constructor()
    /** Underlying Web Worker. Null before {@link init}; available after. */
    worker: Worker | null
    /** Boot the WebAssembly worker. Resolves when ready. */
    init(): Promise<true>
    /** Standard `<input webkitdirectory>` `FileList` or `File[]`. */
    input(files: FileList | File[]): Dcm2niixProcessor
    /** Alias for {@link input}, for clarity at the call site. */
    inputFromWebkitDirectory(files: FileList | File[]): Dcm2niixProcessor
    /** Files harvested from a drop event (see `traverseDataTransferItems`). */
    inputFromDropItems(files: File[]): Dcm2niixProcessor
  }
}
