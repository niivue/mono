import { invoke } from '@tauri-apps/api/core'

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
