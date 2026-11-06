import { expect, test } from 'bun:test'
import NiiVue from '@/index'

// Issues #442 and #443: the constructor, the volumeMatcap setter and
// loadMatcap resolve a matcap name the same way, case-insensitively, to the
// URL in opts.matcaps. With no canvas attached nothing fetches the image, so
// any URL will do.

test('setter and loadMatcap resolve mixed-case matcap names to their URL', async () => {
  // The default instance knows only cortex; register a second matcap.
  const matcaps = {
    cortex: '/matcaps/Cortex.jpg',
    shiny: '/matcaps/Shiny.jpg',
  }
  const fromOption = new NiiVue({ matcaps, volumeMatcap: 'Shiny' }).volumeMatcap

  const nv = new NiiVue({ matcaps })
  const changes: unknown[] = []
  nv.addEventListener('change', (e) => {
    if (e.detail.property === 'volumeMatcap') changes.push(e.detail.value)
  })
  nv.volumeMatcap = 'SHINY'
  const fromSetter = nv.volumeMatcap
  nv.volumeMatcap = 'cortex'
  await nv.loadMatcap('Shiny')
  const fromLoad = nv.volumeMatcap

  expect(fromOption).toBe('/matcaps/Shiny.jpg')
  expect(fromSetter).toBe(fromOption)
  expect(fromLoad).toBe(fromOption)
  // loadMatcap emits the same change event as the setter (#460).
  expect(changes).toEqual([fromOption, '/matcaps/Cortex.jpg', fromOption])
})
