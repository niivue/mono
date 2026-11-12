const sources = import.meta.glob<string>('../demos/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/**
 * The source of `src/demos/<name>.ts` as the docs show it: without the
 * docs-only `Demo` type, so it reads like plain NiiVue usage.
 */
export function demoSource(name: string): string {
  const source = sources[`../demos/${name}.ts`]
  if (!source) throw new Error(`No demo module src/demos/${name}.ts`)
  return source
    .replace(/^import type \{ Demo \} from '\.\/types'\n/m, '')
    .replace(/^const demo: Demo = /m, 'const demo = ')
    .trim()
}
