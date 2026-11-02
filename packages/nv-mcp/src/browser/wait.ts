/** Whether `promise` settled (resolved or rejected) before the timeout. */
export function within(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    const settled = () => {
      clearTimeout(timer)
      resolve(true)
    }
    promise.then(settled, settled)
  })
}
