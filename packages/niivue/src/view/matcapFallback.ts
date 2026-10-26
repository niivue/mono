import { log } from '@/logger'

/**
 * Load a matcap with `load`, falling back so a matcap that fails (a 404, a
 * path from another server) never fails the volume upload: the requested
 * matcap, then the instance default, then `load('')`, which both backends turn
 * into plain white.
 */
export async function loadMatcapOrDefault<T>(
  matcap: string,
  defaultMatcap: string,
  load: (url: string) => Promise<T>,
): Promise<T> {
  try {
    return await load(matcap)
  } catch {
    log.warn(
      `Failed to load matcap ${matcap.slice(0, 80)}; drawing the default matcap`,
    )
  }
  if (defaultMatcap && defaultMatcap !== matcap) {
    try {
      return await load(defaultMatcap)
    } catch {
      log.warn(
        `Failed to load the default matcap ${defaultMatcap.slice(0, 80)}`,
      )
    }
  }
  return load('')
}
