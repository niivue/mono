import {
  fileKey,
  type IndexOptions,
  indexDicomWsiOnThread,
  type SlideIndex,
} from './dicomIndex'

/**
 * Index the DICOM-WSI instances among `files` (e.g. an `<input webkitdirectory>`
 * selection). Files that are not tiled, compressed, explicit-VR DICOM, or that
 * fail to parse, are listed in `skipped`; they never cost the other files their
 * slides. Only VOLUME instances make levels; each optical path and focal plane
 * is its own slide; label, overview and thumbnail images are in `associated`.
 * Runs in a worker (inlined) in a page, else, or when the worker fails to start
 * (e.g. a CSP without `worker-src blob:`), on this thread. `signal` rejects with
 * its reason and stops the work; `onProgress` reports files done.
 */
export async function indexDicomWsi(
  files: readonly File[],
  options: IndexOptions = {},
): Promise<SlideIndex> {
  options.signal?.throwIfAborted()
  // Keys are taken here: a File's webkitRelativePath need not survive the clone.
  const keys = files.map(fileKey)
  const onThread = () => indexDicomWsiOnThread(files, keys, undefined, options)
  if (typeof window === 'undefined' || typeof Worker === 'undefined')
    return onThread()
  try {
    return await inWorker(files, keys, options)
  } catch {
    if (options.signal?.aborted) throw options.signal.reason
    return onThread()
  }
}

async function inWorker(
  files: readonly File[],
  keys: string[],
  { signal, onProgress }: IndexOptions,
): Promise<SlideIndex> {
  // Listening before the worker module loads, so an abort during that load
  // rejects at once rather than after the worker starts.
  let worker: Worker | undefined
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {}) // settled by a race, or never
  try {
    const { default: DicomIndexWorker } = await Promise.race([
      import('./dicomIndex.worker?worker&inline'),
      aborted,
    ])
    signal?.throwIfAborted()
    const w = new DicomIndexWorker()
    worker = w
    return await Promise.race([
      new Promise<SlideIndex>((resolve, reject) => {
        w.onmessage = (e) => {
          const { progress, index, error } = e.data
          if (progress) onProgress?.(progress[0], progress[1])
          else if (index) resolve(index)
          else reject(new Error(error))
        }
        w.onerror = reject
        w.postMessage({ files, keys })
      }),
      aborted,
    ])
  } finally {
    signal?.removeEventListener('abort', onAbort)
    worker?.terminate()
  }
}
