import { afterEach, describe, expect, it, jest } from 'bun:test'
import { sharedTask, sharedTaskCount } from './sharedTask'

const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('sharedTask', () => {
  it('starts once per key and broadcasts progress, replaying the last to late callers', async () => {
    jest.useFakeTimers()
    const d = deferred<string>()
    let starts = 0
    let report!: (n: number) => void
    const start = (_s: AbortSignal, onProgress: (n: number) => void) => {
      starts++
      report = onProgress
      return d.promise
    }
    const seenA: number[] = []
    const seenB: number[] = []
    const a = sharedTask('k1', start, {
      onProgress: (n: number) => seenA.push(n),
    })
    report(1)
    const b = sharedTask('k1', start, {
      onProgress: (n: number) => seenB.push(n),
    })
    report(2)
    d.resolve('nii')
    expect(await a).toBe('nii')
    expect(await b).toBe('nii')
    expect(starts).toBe(1)
    expect(seenA).toEqual([1, 2])
    expect(seenB).toEqual([1, 2])
  })

  it('aborts the task only after every holder released, one macrotask later', () => {
    jest.useFakeTimers()
    const before = sharedTaskCount()
    let taskSignal!: AbortSignal
    const start = (s: AbortSignal) => {
      taskSignal = s
      return new Promise<never>(() => {})
    }
    const c1 = new AbortController()
    const c2 = new AbortController()
    const ignore = () => {}
    sharedTask('k2', start, { signal: c1.signal }).catch(ignore)
    sharedTask('k2', start, { signal: c2.signal }).catch(ignore)
    c1.abort()
    jest.advanceTimersByTime(60_000)
    expect(taskSignal.aborted).toBe(false)
    // A remount in the same task (React commit) re-holds before eviction.
    c2.abort()
    const c3 = new AbortController()
    sharedTask('k2', start, { signal: c3.signal }).catch(ignore)
    jest.advanceTimersByTime(60_000)
    expect(taskSignal.aborted).toBe(false)
    c3.abort()
    expect(taskSignal.aborted).toBe(false)
    jest.advanceTimersByTime(0)
    expect(taskSignal.aborted).toBe(true)
    expect(sharedTaskCount()).toBe(before)
  })

  it('rejects a caller on its own abort while others keep the task', async () => {
    jest.useFakeTimers()
    let taskSignal!: AbortSignal
    const d = deferred<string>()
    const start = (s: AbortSignal) => {
      taskSignal = s
      return d.promise
    }
    const c1 = new AbortController()
    const a = sharedTask('k4', start, { signal: c1.signal })
    const b = sharedTask('k4', start)
    c1.abort(new Error('cancelled'))
    await expect(a).rejects.toThrow('cancelled')
    jest.advanceTimersByTime(0)
    expect(taskSignal.aborted).toBe(false)
    d.resolve('nii')
    expect(await b).toBe('nii')
    const pre = new AbortController()
    pre.abort(new Error('early'))
    await expect(
      sharedTask('k4', start, { signal: pre.signal }),
    ).rejects.toThrow('early')
  })

  it('releases a call without a signal once it settles', async () => {
    jest.useFakeTimers()
    const before = sharedTaskCount()
    expect(await sharedTask('k5', () => Promise.resolve('nii'))).toBe('nii')
    jest.advanceTimersByTime(0)
    expect(sharedTaskCount()).toBe(before)
  })

  it('drops a rejected task so the next call retries', async () => {
    let starts = 0
    const start = () =>
      starts++ === 0 ? Promise.reject(new Error('net')) : Promise.resolve('ok')
    await expect(sharedTask('k3', start)).rejects.toThrow('net')
    expect(await sharedTask('k3', start)).toBe('ok')
    expect(starts).toBe(2)
  })
})
