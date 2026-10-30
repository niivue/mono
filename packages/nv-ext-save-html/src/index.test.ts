import { expect, test } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { generateHTML } from './index'

// The controller cannot load under Bun, so a stand-in serializes the matcap
// it holds at the moment generateHTML serializes the scene.
const fakeNiiVue = (matcap: string) => {
  const model = { volume: { matcap } }
  return {
    model,
    serializeDocument: () => new TextEncoder().encode(model.volume.matcap),
  }
}

const embeddedDocument = async (html: string): Promise<string> => {
  const match = html.match(/id="__nvd_data__" type="text\/plain">\s*(\S+)/)
  if (!match) throw new Error('no embedded document')
  const stream = new Blob([Buffer.from(match[1], 'base64')])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

test('exported HTML keeps the scene matcap', async () => {
  const matcap = 'https://example.org/matcaps/Gold.jpg'
  const nv = fakeNiiVue(matcap)
  const html = await generateHTML(nv as unknown as NiiVue, {
    niivueBundleSource: 'export default {}',
  })
  expect(await embeddedDocument(html)).toBe(matcap)
  // The page does not replace the document's matcap after loading it.
  expect(html).not.toContain('loadMatcap')
})
