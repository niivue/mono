import { describe, expect, test } from 'bun:test'
import { safeCssColor, svgNumber } from './NVSvg'

describe('svgNumber', () => {
  test('rounds to two decimals', () => {
    expect(svgNumber(1.23456)).toBe('1.23')
    expect(svgNumber(-1.2367)).toBe('-1.24')
    expect(svgNumber(10)).toBe('10')
    // Negative zero must not serialize as '-0'.
    expect(svgNumber(-0.001)).toBe('0')
  })

  test('uses the fallback for non-finite values when given', () => {
    // stroke-width 0 is invisible; SVG's initial value is 1.
    expect(svgNumber(Number.NaN, 1)).toBe('1')
    expect(svgNumber(Number.POSITIVE_INFINITY, 1)).toBe('1')
    expect(svgNumber(2.5, 1)).toBe('2.5')
  })

  test('collapses non-finite values to 0', () => {
    // An NaN in a path `d` or viewBox makes the document unrenderable.
    expect(svgNumber(Number.NaN)).toBe('0')
    expect(svgNumber(Number.POSITIVE_INFINITY)).toBe('0')
    expect(svgNumber(Number.NEGATIVE_INFINITY)).toBe('0')
  })
})

describe('safeCssColor', () => {
  test('accepts hex colors of 3, 4, 6 and 8 digits', () => {
    expect(safeCssColor('#fff')).toBe('#fff')
    expect(safeCssColor('#ffff')).toBe('#ffff')
    expect(safeCssColor('#e62d37')).toBe('#e62d37')
    expect(safeCssColor('#e62d37ff')).toBe('#e62d37ff')
  })

  test('accepts rgb/rgba/hsl/hsla with numeric arguments', () => {
    expect(safeCssColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)')
    expect(safeCssColor('rgba(1,2,3,0.5)')).toBe('rgba(1,2,3,0.5)')
    expect(safeCssColor('hsl(210 50% 40%)')).toBe('hsl(210 50% 40%)')
    expect(safeCssColor('hsla(210 50% 40% / 0.5)')).toBe(
      'hsla(210 50% 40% / 0.5)',
    )
  })

  test('accepts named colors', () => {
    expect(safeCssColor('red')).toBe('red')
    expect(safeCssColor('transparent')).toBe('transparent')
  })

  test('trims surrounding whitespace', () => {
    expect(safeCssColor('  red  ')).toBe('red')
  })

  test('rejects an attribute-escaping payload', () => {
    // The value that motivated this: it would close `stroke="` and inject markup.
    expect(safeCssColor('#fff" onload="alert(1)')).toBe('none')
    expect(safeCssColor('red"><script>alert(1)</script>')).toBe('none')
    expect(safeCssColor("red' onmouseover='x")).toBe('none')
  })

  test('rejects css that could smuggle a url or expression', () => {
    expect(safeCssColor('url(http://evil/x)')).toBe('none')
    expect(safeCssColor('rgb(1,2,3);behavior:url(x)')).toBe('none')
  })

  test('rejects non-string input and honors the fallback', () => {
    expect(safeCssColor(undefined as unknown as string)).toBe('none')
    expect(safeCssColor('', 'black')).toBe('black')
    expect(safeCssColor('#zzz', 'black')).toBe('black')
  })
})
