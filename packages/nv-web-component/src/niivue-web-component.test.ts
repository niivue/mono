import { describe, expect, test } from 'bun:test'

import { defaultElementName } from './niivue-web-component'

describe('defaultElementName', () => {
  test('uses the expected default custom element name', () => {
    expect(defaultElementName).toBe('niivue-viewer')
  })
})
