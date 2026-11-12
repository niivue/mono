// Indexes a File list off the page for indexDicomWsi (indexDicomWsi.ts).
import { blockReader, indexDicomWsiOnThread } from './dicomIndex'

// Worker-only, so not in lib DOM.
declare const FileReaderSync: new () => {
  readAsArrayBuffer(blob: Blob): ArrayBuffer
}

const reader = new FileReaderSync()
const read = blockReader(
  (file, offset, length) =>
    new Uint8Array(
      reader.readAsArrayBuffer(file.slice(offset, offset + length)),
    ),
)

self.onmessage = async (e: MessageEvent<{ files: File[]; keys: string[] }>) => {
  try {
    const { files, keys } = e.data
    const onProgress = (done: number, total: number) =>
      self.postMessage({ progress: [done, total] })
    self.postMessage({
      index: await indexDicomWsiOnThread(files, keys, read, { onProgress }),
    })
  } catch (err) {
    self.postMessage({ error: String(err) })
  }
}
