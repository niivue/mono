export declare function setWasmUrl(
  url: string | URL | Uint8Array | ArrayBuffer,
): void
export declare function loadModule(): Promise<WebAssembly.Module>
export declare function isModuleLoaded(): boolean
export declare class WasmDecodeError extends Error {}
export declare class Decoder {
  static create(module?: WebAssembly.Module): Promise<Decoder>
  decode(
    spec: string,
    bytes: Uint8Array,
  ): { buffer: ArrayBuffer; stride: number[] }
  decodeInto(spec: string, bytes: Uint8Array, target: DecodeTarget): void
}
export interface DecodeTarget {
  buffer: ArrayBufferLike
  byteOffset: number
  elemSize: number
  stride: number[]
  mapping: ReadonlyArray<{ from: unknown; to: unknown }>
}
