import type { NVConnectomeNode } from '@/NVTypes'
import type { ConnectomeFileData } from '../fileData'
import { defaultConnectomeOptions } from '../fileData'
import * as jcon from './jcon'

// `.json` is generic, so the content decides: a FreeSurfer pointset (Freeview
// control points, `data_type: 'fs_pointset'`) or a JCON connectome saved as
// `.json`. Anything else is not a connectome.
export const extensions = ['JSON']

type FsPoint = {
  coordinates?: { x?: number; y?: number; z?: number }
  comments?: { text?: string }[]
}

/** True for a parsed FreeSurfer pointset (`data_type: 'fs_pointset'`). */
export function isFsPointset(json: unknown): boolean {
  const j = json as { data_type?: unknown; points?: unknown }
  return j?.data_type === 'fs_pointset' && Array.isArray(j.points)
}

/**
 * Read a FreeSurfer pointset as a connectome of nodes (no edges), as NiiVue
 * 0.x's `loadFreeSurferConnectome` did: one node per point, named by its first
 * comment.
 */
export async function read(
  buffer: ArrayBufferLike,
): Promise<ConnectomeFileData> {
  const json = JSON.parse(new TextDecoder().decode(buffer)) as Record<
    string,
    unknown
  >
  if (!isFsPointset(json)) {
    if ('nodes' in json) return jcon.read(buffer)
    throw new Error(
      'JSON is neither a FreeSurfer pointset (data_type "fs_pointset") nor a connectome',
    )
  }
  const nodes: NVConnectomeNode[] = (json.points as FsPoint[]).map((p) => ({
    name: p.comments?.[0]?.text ?? '',
    x: p.coordinates?.x ?? 0,
    y: p.coordinates?.y ?? 0,
    z: p.coordinates?.z ?? 0,
    colorValue: 1,
    sizeValue: 1,
  }))
  return {
    data: { nodes, edges: [] },
    options: {
      ...defaultConnectomeOptions,
      nodeColormap: 'warm',
      edgeColormap: 'warm',
    },
  }
}
