import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export type NiimathOperation = 'smooth' | 'threshold' | 'upperThreshold' | 'binarize' | 'mask'

export interface NiimathTaskRequest {
  sourcePath: string
  operation: NiimathOperation
  operand?: number
  maskPath?: string
}

export interface NiimathTaskResult {
  operation: NiimathOperation
  sourcePath: string
  outputPath: string
  volumeId: string
  argv: string[]
  stdout: string
  stderr: string
}

export function runNiimathTask(request: NiimathTaskRequest): Promise<NiimathTaskResult> {
  return invoke<NiimathTaskResult>('run_niimath_task', { request })
}

export async function pickNiimathMaskPath(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    title: 'Select niimath mask volume',
    filters: [
      {
        name: 'NIfTI volumes',
        extensions: ['nii', 'gz']
      }
    ]
  })
  if (!selected || Array.isArray(selected)) return null
  return invoke<string>('validate_niimath_mask_path', { path: selected })
}
