import { log } from '@/logger'
import type { MZ3 } from '@/NVTypes'

export const extensions = ['WRL']
export const type = 'mz3'

export async function read(buffer: ArrayBuffer): Promise<MZ3> {
  const wrlText = new TextDecoder('utf-8').decode(buffer)
  const coordRegex = /coord\s+Coordinate\s*\{\s*point\s*\[([\s\S]*?)\]/
  const indexRegex = /coordIndex\s*\[([\s\S]*?)\]/
  const colorRegex = /color\s+Color\s*\{\s*color\s*\[([\s\S]*?)\]/
  const coordMatch = coordRegex.exec(wrlText)
  const indexMatch = indexRegex.exec(wrlText)
  const colorMatch = colorRegex.exec(wrlText)

  if (!coordMatch || !indexMatch) {
    throw new Error('Invalid WRL file: Could not find vertices or indices.')
  }
  const positions = new Float32Array(
    coordMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number),
  )
  let colors: Float32Array | null = null
  if (colorMatch) {
    colors = new Float32Array(
      colorMatch[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number),
    )
    const nVert = positions.length / 3
    if (colors.length !== nVert * 3) {
      log.warn(
        `Unexpected color count: expected ${nVert * 3}, got ${colors.length}`,
      )
      colors = null
    }
  }
  const indices = new Uint32Array(
    indexMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((v) => v !== -1),
  )
  const out: MZ3 = { positions, indices }
  if (colors) {
    out.colors = colors
  }
  return out
}
