// Dropped files and folders as one File list. Entry files have no
// webkitRelativePath, so a folder's files get their path within the drop set
// on it: fileKey (nv-ext-tile) keys by it, keeping same-named files distinct.
async function walk(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    // One unreadable file (moved, no permission) must not lose the rest.
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    ).catch((err) => {
      console.warn(`Skipped ${entry.fullPath}:`, err)
      return null
    })
    if (!file) return []
    const path = entry.fullPath.replace(/^\//, '')
    if (path !== file.name)
      Object.defineProperty(file, 'webkitRelativePath', { value: path })
    return [file]
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const out: File[] = []
  // readEntries returns at most ~100 entries a call; an empty batch ends it.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (!batch.length) return out
    for (const files of await Promise.all(batch.map(walk))) out.push(...files)
  }
}

export async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  // Take every item before the first await: the list empties once the drop
  // event returns. A script-made DataTransfer has no entries, only files.
  const items = [...dt.items].filter((i) => i.kind === 'file')
  const sources = items.map((i) => i.webkitGetAsEntry() ?? i.getAsFile())
  const lists = await Promise.all(
    sources.map((s) => (s instanceof File ? [s] : s ? walk(s) : [])),
  )
  return lists.flat()
}
