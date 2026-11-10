export type CopyPlan =
  | null
  | { empty: true }
  | {
      empty: false
      doff: number
      soff: number
      lens: number[]
      dsteps: number[]
      ssteps: number[]
    }
export declare function planCopy(
  destStride: number[],
  srcStride: number[],
  projections: ReadonlyArray<{ from: unknown; to: unknown }>,
): CopyPlan
export declare function runCopy(
  destBuf: ArrayBufferLike,
  destByteOffset: number,
  srcBuf: ArrayBufferLike,
  srcByteOffset: number,
  srcByteLength: number,
  elemSize: number,
  plan: CopyPlan,
): void
