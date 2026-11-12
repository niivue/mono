# Writes fixtures/zarr-variants: one small 2D OME-Zarr image in the encodings
# of the milestone-13 set (omezarr2d/variants), written by zarr-python, plus
# expected.json with per-level, per-channel sums. Re-run only to change it:
#   uv run --with 'zarr>=3.1,<4' --with numpy python scripts/make-zarr-variants.py
import json
import shutil
from pathlib import Path

import numcodecs
import numpy as np
import zarr
from zarr.codecs import BloscCodec, ZstdCodec

OUT = Path(__file__).resolve().parent.parent / 'fixtures' / 'zarr-variants'
C, H, W, TILE = 2, 96, 160, 32

y, x = np.mgrid[0:H, 0:W]
level0 = np.stack([(x * 7 + y * 13 + c * 1000) % 4096 for c in range(C)]).astype('u2')
levels = [level0]
while levels[-1].shape[1] > 24:
    a = levels[-1].astype('u4')
    levels.append(((a[:, 0::2, 0::2] + a[:, 1::2, 0::2] + a[:, 0::2, 1::2] + a[:, 1::2, 1::2]) // 4).astype('u2'))


def multiscales(version):
    return [{
        'version': version,
        'axes': [
            {'name': 'c', 'type': 'channel'},
            {'name': 'y', 'type': 'space', 'unit': 'micrometer'},
            {'name': 'x', 'type': 'space', 'unit': 'micrometer'},
        ],
        'datasets': [
            {'path': str(i), 'coordinateTransformations': [{'type': 'scale', 'scale': [1, 2**i, 2**i]}]}
            for i in range(len(levels))
        ],
    }]


def v3(name, **kw):
    group = zarr.open_group(OUT / f'{name}.ome.zarr', mode='w', zarr_format=3)
    group.attrs['ome'] = {'version': '0.5', 'multiscales': multiscales('0.5')}
    if kw.get('attribution'):
        group.attrs['attribution'] = {'title': 'Synthetic ramp', 'license': 'CC0-1.0'}
    for i, data in enumerate(levels):
        shards = kw.get('shards')
        arr = group.create_array(
            str(i),
            shape=data.shape,
            dtype=data.dtype,
            chunks=(kw.get('c_chunk', 1), TILE, TILE),
            shards=(C, -(-data.shape[1] // TILE) * TILE, -(-data.shape[2] // TILE) * TILE) if shards == 'level' else shards,
            compressors=kw.get('compressors', 'auto'),
        )
        arr[:] = data


def v2(name, dtype, compressor, separator):
    group = zarr.open_group(OUT / f'{name}.ome.zarr', mode='w', zarr_format=2)
    group.attrs['multiscales'] = multiscales('0.4')
    for i, data in enumerate(levels):
        arr = group.create_array(
            str(i),
            shape=data.shape,
            dtype=dtype,
            chunks=(1, TILE, TILE),
            compressors=compressor,
            chunk_key_encoding={'name': 'v2', 'separator': separator},
        )
        arr[:] = data


shutil.rmtree(OUT, ignore_errors=True)
OUT.mkdir(parents=True)
v3('v3-shard-per-level', shards='level', attribution=True)
v3('v3-shard-64', shards=(1, 64, 64))
v3('v3-chunks-blosc-zstd', compressors=BloscCodec(cname='zstd', clevel=5))
v3('v3-chunks-zstd', compressors=ZstdCodec(level=3))
v3('v3-c-spanning', c_chunk=2, compressors=ZstdCodec(level=3))
v2('v2-blosc-lz4-slash', '<u2', numcodecs.Blosc(cname='lz4'), '/')
v2('v2-zlib-dot-bigendian', '>u2', numcodecs.Zlib(level=5), '.')
(OUT / 'expected.json').write_text(json.dumps({
    'levels': [
        {'shape': list(d.shape), 'sum_per_channel': [int(d[c].astype('u8').sum()) for c in range(C)]}
        for d in levels
    ],
    'tile': TILE,
}, indent=1) + '\n')
