"""Minimal PNG writer (stdlib) and slice-overlay helper."""
import struct
import zlib

import numpy as np


def write_png(path, rgb):
  h, w, _ = rgb.shape
  raw = b''.join(b'\x00' + rgb[y].tobytes() for y in range(h))
  def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
  png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
  open(path, 'wb').write(png)


def overlay(hu, masks, axis=2, fracs=(0.3, 0.5, 0.7)):
  """masks: [(bool volume, (r,g,b)), ...] painted in order. Returns tiled uint8 image."""
  tiles = []
  for f in fracs:
    k = int(f * hu.shape[axis])
    sl = np.take(hu, k, axis=axis).T[::-1]
    g = np.clip((sl + 200) / 800, 0, 1) * 255
    rgb = np.stack([g, g, g], -1)
    for m, col in masks:
      rgb[np.take(m, k, axis=axis).T[::-1]] = col
    tiles.append(rgb.astype(np.uint8))
  return np.concatenate(tiles, 1)
