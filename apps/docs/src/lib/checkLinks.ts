// Fails the build when a page links to a page, file or #anchor of this site
// that the build did not produce, as Docusaurus's onBrokenLinks: 'throw' did.
// The guides link to gallery pages whose slugs come from
// packages/niivue/examples/index.html, so renaming an example is caught here.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(dir, f))
}

export function checkLinks(base: string): AstroIntegration {
  return {
    name: 'niivue-check-links',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const root = fileURLToPath(dir)
        const ids = new Map<string, Set<string>>()
        const idsIn = (file: string) => {
          let set = ids.get(file)
          if (!set) {
            const html = readFileSync(file, 'utf8')
            set = new Set(
              [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]),
            )
            ids.set(file, set)
          }
          return set
        }
        const broken: string[] = []
        for (const file of htmlFiles(root)) {
          const html = readFileSync(file, 'utf8')
          for (const [, link] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
            const [, linkPath, hash] =
              /^([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/.exec(link) ?? []
            if (linkPath === undefined) continue
            let target = file
            if (linkPath) {
              if (!linkPath.startsWith(base)) continue
              const local = path.join(
                root,
                decodeURIComponent(linkPath.slice(base.length)),
              )
              target =
                existsSync(local) && statSync(local).isDirectory()
                  ? path.join(local, 'index.html')
                  : local
            }
            const missing = !existsSync(target)
            const missingAnchor =
              !missing &&
              hash &&
              target.endsWith('.html') &&
              !idsIn(target).has(decodeURIComponent(hash))
            if (missing || missingAnchor) {
              broken.push(`${path.relative(root, file)}: ${link}`)
            }
          }
        }
        if (broken.length > 0) {
          throw new Error(`Broken links:\n  ${broken.join('\n  ')}`)
        }
        logger.info('All internal links resolve.')
      },
    },
  }
}
