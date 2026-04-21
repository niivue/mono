import type { LUT } from "@/NVTypes"

export const extensions = ["STC"]

export type LayerReadResult = {
  values: Float32Array
  nFrame4D: number
  colormapLabel?: LUT | null
}

/**
 * Read MNE-Python source estimation (STC) format.
 * https://github.com/mne-tools/mne-python/blob/main/mne/source_estimate.py
 * All values are big-endian.
 */
export function read(buffer: ArrayBuffer, nVert: number): LayerReadResult {
  const reader = new DataView(buffer)
  // Header: 12 bytes
  // float32 epoch_begin_latency (unused)
  // float32 sample_period (unused)
  const nVertex = reader.getInt32(8, false)
  if (nVertex !== nVert) {
    throw new Error(`STC overlay has ${nVertex} vertices, expected ${nVert}`)
  }
  // Skip vertex IDs (4 bytes each)
  let pos = 12 + nVertex * 4
  // Number of time points
  const nTime = reader.getUint32(pos, false)
  pos += 4
  const f32 = new Float32Array(nTime * nVertex)
  for (let i = 0; i < nTime * nVertex; i++) {
    f32[i] = reader.getFloat32(pos, false)
    pos += 4
  }
  return { values: f32, nFrame4D: nTime }
}
