import { invoke } from '@tauri-apps/api/core'

export type Backend = 'webgl2' | 'webgpu'
export type Axis = 'axial' | 'coronal' | 'sagittal'

export interface WorldRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopVolumeLevel {
  level: number
  factor?: number
  shape: [number, number, number]
  spacing?: [number, number, number]
  ready?: boolean
  bytes?: number | null
  raw?: string
}

export interface DesktopItem {
  id: string
  type: string
  label: string
  role?: 'source' | 'derived'
  index: number
  bounds: WorldRect
  format: string
  shape: [number, number, number]
  spacing: [number, number, number]
  dtype: string
  manifest: string
  metadata: string
  preview: {
    axis: Axis
    slice: number
    service: string
    image: string
  }
  levels: DesktopVolumeLevel[]
  brickTemplate?: string
  sliceServices?: Record<Axis, string>
  derivedFrom?: string | null
  derivation?: VolumeDerivation | null
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface JsonSidecar {
  kind: 'json'
  name: string
  path?: string
  metadata: JsonValue
}

export interface VolumeMetadata {
  id: string
  label?: string
  role?: 'source' | 'derived'
  format?: string
  shape?: [number, number, number]
  spacing?: [number, number, number]
  dtype?: string
  sourcePath?: string | null
  derivedFrom?: string | null
  derivation?: VolumeDerivation | null
  sidecars?: JsonSidecar[]
  [key: string]: JsonValue | JsonSidecar[] | VolumeDerivation | undefined
}

export interface VolumeDerivation {
  operation: string
  sourcePath: string
  outputPath: string
}

export interface DesktopManifest {
  type: 'VolumeDesktop'
  id: string
  label: string
  profile: string
  tileSize: number
  gap: number
  world: {
    width: number
    height: number
    units: string
    columns: number
    rows: number
  }
  itemCount: number
  items: DesktopItem[]
}

export interface ServerInfo {
  url: string
  port: number
  volumeCount: number
  datasetRoot?: string | null
  cacheRoot?: string
}

export interface DatasetOpenResult {
  url: string
  port: number
  volumeCount: number
  datasetRoot: string
  cacheRoot: string
}

export interface ClipPlane {
  id: string
  label: string
  enabled: boolean
  depth: number
  azimuth: number
  elevation: number
}

const BROWSER_REFERENCE_SERVER = 'http://127.0.0.1:8087'

export async function resolveServerInfo(): Promise<ServerInfo | null> {
  try {
    const info = await invoke<ServerInfo>('neurovue_server_info')
    return {
      ...info,
      url: trimTrailingSlash(info.url)
    }
  } catch {
    return null
  }
}

export async function resolveServerUrl(): Promise<string> {
  const queryUrl = new URLSearchParams(window.location.search).get('server')
  if (queryUrl) return trimTrailingSlash(queryUrl)

  return (await resolveServerInfo())?.url ?? BROWSER_REFERENCE_SERVER
}

export async function fetchDesktopManifest(serverUrl: string): Promise<DesktopManifest> {
  const response = await fetch(`${trimTrailingSlash(serverUrl)}/iiif/desktop/neuro/manifest`)
  if (!response.ok) {
    throw new Error(`Desktop manifest request failed with HTTP ${response.status}.`)
  }
  return response.json() as Promise<DesktopManifest>
}

export async function fetchVolumeMetadata(item: DesktopItem): Promise<VolumeMetadata> {
  const response = await fetch(item.metadata)
  if (!response.ok) {
    throw new Error(`Volume metadata request failed with HTTP ${response.status}.`)
  }
  return response.json() as Promise<VolumeMetadata>
}

export function rawVolumeUrl(item: DesktopItem): string {
  return item.levels.find((level) => level.level === 0)?.raw ?? item.levels[0]?.raw ?? item.manifest
}

export async function openDatasetDirectory(): Promise<DatasetOpenResult | null> {
  const result = await invoke<DatasetOpenResult | null>('open_dataset_directory')
  return result
    ? {
        ...result,
        url: trimTrailingSlash(result.url)
      }
    : null
}

export async function openDatasetByPath(path: string): Promise<DatasetOpenResult> {
  const result = await invoke<DatasetOpenResult>('open_dataset_path', { path })
  return {
    ...result,
    url: trimTrailingSlash(result.url)
  }
}

export function defaultClipPlanes(): ClipPlane[] {
  return [
    {
      id: 'anterior',
      label: 'Anterior',
      enabled: true,
      depth: 0,
      azimuth: 180,
      elevation: 0
    },
    {
      id: 'inferior',
      label: 'Inferior',
      enabled: true,
      depth: 0,
      azimuth: 0,
      elevation: -90
    },
    {
      id: 'right',
      label: 'Right',
      enabled: false,
      depth: 0,
      azimuth: 90,
      elevation: 0
    }
  ]
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
