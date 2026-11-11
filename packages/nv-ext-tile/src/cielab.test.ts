import { expect, test } from 'bun:test'
import { dicomLabToSrgb } from './cielab'

const enc = (L: number, a: number, b: number) => [
  (L / 100) * 0xffff,
  ((a + 128) / 255) * 0xffff,
  ((b + 128) / 255) * 0xffff,
]

test('DICOM CIELab (D50) to sRGB', () => {
  expect(dicomLabToSrgb([0xffff, 0x8080, 0x8080])).toEqual([255, 255, 255])
  expect(dicomLabToSrgb(enc(100, 0, 0))).toEqual([255, 255, 255])
  expect(dicomLabToSrgb([0, 0x8080, 0x8080])).toEqual([0, 0, 0])
  // sRGB primaries in D50 Lab (Lindbloom, Bradford): tells D50 from D65 white.
  expect(dicomLabToSrgb(enc(54.29, 80.8, 69.89))).toEqual([255, 0, 0])
  expect(dicomLabToSrgb(enc(29.57, 68.29, -112.03))).toEqual([0, 0, 255])
  // Mid grey: L* 53.39 is sRGB 128.
  expect(dicomLabToSrgb(enc(53.39, 0, 0))).toEqual([128, 128, 128])
})
