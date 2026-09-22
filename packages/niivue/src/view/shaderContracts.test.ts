import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { depthPickFragmentShader } from '../gl/depthPickShader'
import { fragmentShader as glRenderShader } from '../gl/renderShader'
import { fragmentPreamble as glPreamble } from '../gl/volumeShaderLib'
import { volumeDepthPickFragment } from '../wgpu/depthPick'
import { volumeShaderPreamble as wgslPreamble } from '../wgpu/volumeShaderLib'

/**
 * The volume shaders are written twice, in GLSL and WGSL, and several of the
 * defects this file pins were one backend drifting from the other or the pick
 * drifting from the render. Source-level checks catch that without a GPU.
 */

const wgslRender = readFileSync(
  new URL('../wgpu/render.wgsl', import.meta.url),
  'utf8',
)
const count = (src: string, needle: string | RegExp): number =>
  (src.match(needle instanceof RegExp ? needle : new RegExp(needle, 'g')) ?? [])
    .length

describe('matcap orientation', () => {
  // The matcap is looked up with the view-space normal's x mirrored; the
  // unmirrored form lights the volume from the wrong side and, worse, lit the
  // two backends differently.
  test('both GLSL matcap taps mirror the normal x', () => {
    expect(count(glRenderShader, /vec2\(-n\.x, n\.y\) \* 0\.5 \+ 0\.5/g)).toBe(
      2,
    )
    expect(glRenderShader).not.toMatch(/vec2\(n\.x, n\.y\) \* 0\.5 \+ 0\.5/)
  })

  test('both WGSL matcap taps mirror the normal x', () => {
    expect(count(wgslRender, /vec2f\(-n\.x, n\.y\) \* 0\.5 \+ 0\.5/g)).toBe(2)
    expect(wgslRender).not.toMatch(/vec2f\(n\.x, n\.y\) \* 0\.5 \+ 0\.5/)
  })
})

describe('PAQD easing', () => {
  // One definition per backend, in the preamble, so the render and the depth
  // pick cannot disagree about which label is drawn.
  test('each preamble defines paqdEaseAlpha exactly once', () => {
    expect(count(glPreamble, /float paqdEaseAlpha\(/g)).toBe(1)
    expect(count(wgslPreamble, /fn paqdEaseAlpha\(/g)).toBe(1)
  })

  test('the render shaders use it rather than redefining it', () => {
    // The GLSL render shader string starts with the preamble.
    expect(glRenderShader.startsWith(glPreamble)).toBe(true)
    expect(glRenderShader.slice(glPreamble.length)).not.toMatch(
      /float paqdEaseAlpha\(/,
    )
    expect(glRenderShader).toMatch(/paqdEaseAlpha\(raw\.b, paqdUniforms\)/)
    expect(wgslRender).not.toMatch(/fn paqdEaseAlpha\(/)
    expect(wgslRender).toMatch(/paqdEaseAlpha\(raw\.b, params\.paqdUniforms\)/)
  })

  test('the ramp is the same in both languages', () => {
    const body = (src: string, head: RegExp): string => {
      const m = src.match(head)
      if (!m || m.index === undefined) throw new Error('paqdEaseAlpha missing')
      return src.slice(m.index + m[0].length).split('}\n')[0]
    }
    const glsl = body(
      glPreamble,
      /float paqdEaseAlpha\(float alpha, vec4 u\) \{/,
    )
    const wgsl = body(
      wgslPreamble,
      /fn paqdEaseAlpha\(alpha: f32, u: vec4f\) -> f32 \{/,
    )
    // Strip the declaration keywords the two languages differ in.
    const norm = (s: string): string =>
      s
        .replace(/\b(float|let)\s/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    expect(norm(wgsl)).toBe(norm(glsl))
  })
})

describe('SLICES depth pick', () => {
  // sampleSlice paints a PAQD label or a drawing voxel on a plane even where
  // the base and overlay are transparent (clip dark). A pick that tested only
  // those two discarded the plane there, so a click on a visible label did not
  // move the crosshair. Both pick shaders now take the same plane test.
  const glSlices = depthPickFragmentShader.split(
    'isRenderMode(RENDER_MODE_SLICES)',
  )[1]
  const wgslSlices = volumeDepthPickFragment.split(
    'isRenderMode(RENDER_MODE_SLICES)',
  )[1]

  test('both pick shaders have a SLICES branch', () => {
    expect(glSlices).toBeDefined()
    expect(wgslSlices).toBeDefined()
  })

  test('the GLSL plane test reads the base, overlay, PAQD and drawing', () => {
    expect(glSlices).toMatch(/isAlphaClipDark <= 0\.5/)
    expect(glSlices).toMatch(
      /texture\(volume, chunkTexCoord\(pos\)\)\.a > 0\.0/,
    )
    expect(glSlices).toMatch(
      /texture\(overlay, chunkTexCoord\(pos\)\)\.a > 0\.0/,
    )
    expect(glSlices).toMatch(/planeLayerVisible\(chunkTexCoord\(pos\)\)/)
    expect(depthPickFragmentShader).toMatch(/uniform sampler3D paqd;/)
    expect(depthPickFragmentShader).toMatch(/uniform sampler3D drawing;/)
    expect(depthPickFragmentShader).toMatch(/uniform vec4 paqdUniforms;/)
  })

  test('the WGSL plane test reads the base, overlay, PAQD and drawing', () => {
    expect(wgslSlices).toMatch(/!alphaClipDark\(\)/)
    expect(wgslSlices).toMatch(
      /textureSampleLevel\(volume, tex_sampler, chunkTexCoord\(pos\), 0\.0\)\.a > 0\.0/,
    )
    expect(wgslSlices).toMatch(
      /textureSampleLevel\(overlay, tex_sampler, chunkTexCoord\(pos\), 0\.0\)\.a > 0\.0/,
    )
    expect(wgslSlices).toMatch(/planeLayerVisible\(chunkTexCoord\(pos\)\)/)
  })

  test('the layer test takes the thresholds sampleSlice draws with', () => {
    for (const src of [depthPickFragmentShader, volumeDepthPickFragment]) {
      const layer = src.split('planeLayerVisible(')[1]
      expect(layer).toMatch(/raw\.b \+ raw\.a > 0\.004/)
      expect(layer).toMatch(
        /paqdEaseAlpha\(raw\.b, (params\.)?paqdUniforms\) > 0\.0/,
      )
      expect(layer).toMatch(/dc\.a > 0\.0/)
    }
    // And those are the render's thresholds, not a second opinion.
    expect(glRenderShader).toMatch(/total > 0\.004/)
    expect(wgslRender).toMatch(/total > 0\.004/)
    expect(glRenderShader).toMatch(/if \(dc\.a > 0\.0\)/)
    expect(wgslRender).toMatch(/if \(dc\.a > 0\.0\)/)
  })
})
