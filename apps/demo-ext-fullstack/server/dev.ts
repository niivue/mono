/**
 * Run the niimath server and the Vite dev server together.
 *
 * If either child exits, take the other down with it before exiting
 * ourselves — otherwise an early crash (e.g. EADDRINUSE) leaves an
 * orphaned vite/bun bound to a port and the next `bun server/dev.ts`
 * will fail mysteriously.
 */
import { type ChildProcess, spawn } from 'node:child_process'

const children = new Map<string, ChildProcess>()
let shuttingDown = false

function start(name: string, cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  children.set(name, child)
  child.on('exit', (code, signal) => {
    children.delete(name)
    console.log(
      `[${name}] exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
    )
    if (!shuttingDown) shutdown(code ?? 0)
  })
  return child
}

function shutdown(code = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const [name, c] of children) {
    if (!c.killed) {
      try {
        c.kill('SIGTERM')
      } catch (err) {
        console.error(`[${name}] kill failed:`, err)
      }
    }
  }
  // Give children a beat to flush, then exit. If they refuse to die in
  // 2s, force-kill them and leave.
  setTimeout(() => {
    for (const [, c] of children) if (!c.killed) c.kill('SIGKILL')
    process.exit(code)
  }, 2000).unref()
}

start('server', 'bun', ['server/server.ts'])
start('vite', 'bunx', ['--bun', 'vite', '--open', '/index.html'])

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
