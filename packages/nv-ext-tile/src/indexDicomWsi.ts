import { fileKey, indexDicomWsiOnThread, type SlideIndex } from './dicomIndex'

/**
 * Index the DICOM-WSI instances among `files` (e.g. an `<input webkitdirectory>`
 * selection). Files that are not tiled, compressed, explicit-VR DICOM, or that
 * fail to parse, are listed in `skipped`; they never cost the other files their
 * slides. Only VOLUME instances make levels; each optical path and focal plane
 * is its own slide. Runs in a worker (inlined) in a page, else, or when the
 * worker fails to start (e.g. a CSP without `worker-src blob:`), on this thread.
 */
export async function indexDicomWsi(
  files: readonly File[],
): Promise<SlideIndex> {
  // Keys are taken here: a File's webkitRelativePath need not survive the clone.
  const keys = files.map(fileKey)
  if (typeof window === 'undefined' || typeof Worker === 'undefined')
    return indexDicomWsiOnThread(files, keys)
  try {
    return await inWorker(files, keys)
  } catch {
    return indexDicomWsiOnThread(files, keys)
  }
}

async function inWorker(
  files: readonly File[],
  keys: string[],
): Promise<SlideIndex> {
  const { default: DicomIndexWorker } = await import(
    './dicomIndex.worker?worker&inline'
  )
  const worker = new DicomIndexWorker()
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (e) =>
        e.data.index ? resolve(e.data.index) : reject(new Error(e.data.error))
      worker.onerror = reject
      worker.postMessage({ files, keys })
    })
  } finally {
    worker.terminate()
  }
}
