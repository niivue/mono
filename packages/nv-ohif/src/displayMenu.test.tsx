import { expect, test } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { VOLUME_RENDER_MODE } from '@niivue/niivue'
import { renderToStaticMarkup } from 'react-dom/server'
import { RenderingOptions } from './displayMenu'

// The lighting inputs' disabled and max attributes, in render order.
function lighting(volumeRenderMode: number, ambient = 0.3) {
  const nv = {
    volumes: [],
    volumeSampleRate: 1,
    volumeIllumination: 0,
    volumeRenderMode,
    volumeCinematic: { ambient, volumetricDiffuse: 0.5, specular: 1 },
  } as unknown as NiiVue
  const html = renderToStaticMarkup(
    <RenderingOptions nv={nv} redraw={() => {}} />,
  )
  return [...html.matchAll(/<input aria-label="Volume lighting [^>]*>/g)].map(
    ([tag]) => ({
      disabled: tag.includes('disabled'),
      max: /max="([^"]+)"/.exec(tag)?.[1],
    }),
  )
}

test('lighting sliders: enabled only in 3D Cinematic, and keep a 0..2 range that shows any value', () => {
  expect(lighting(VOLUME_RENDER_MODE.COMPOSITE).every((s) => s.disabled)).toBe(
    true,
  )
  const cinematic = lighting(VOLUME_RENDER_MODE.CINEMATIC, 2)
  expect(cinematic.map((s) => s.disabled)).toEqual([false, false, false])
  expect(cinematic.map((s) => s.max)).toEqual(['2', '2', '2'])
  expect(lighting(VOLUME_RENDER_MODE.CINEMATIC, 3)[0]?.max).toBe('3')
})
