// Worker-scope postMessage with Transferable[] support
export const post = (
  self as unknown as {
    postMessage: (msg: unknown, transfer?: Transferable[]) => void
  }
).postMessage.bind(self) as (msg: unknown, transfer?: Transferable[]) => void
