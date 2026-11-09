#!/usr/bin/env python3
"""Fixtures for tests/standalone.e2e.mjs: two tiny DICOM-WSI slides whose tiles
need dcm2niix, and a tiny OME-Zarr store. Synthetic, about 4 KB in all.

- jp2k.dcm: JPEG 2000 lossless (opj_compress), 2 x 1 tiles of 16 px, red and
  yellow, with an ICC profile that rotates the channels (device R shows as sRGB
  blue, G as red, B as green), so colour management visibly applies it.
- jls.dcm: JPEG-LS lossless (DCMTK dcmcjpls), green and blue, no profile.
- tiny.ome.zarr: OME-Zarr 0.4 (Zarr v2, uncompressed), one 4 x 3 x 2 uint8
  level holding 0..23.

Needs pydicom >= 3, numpy, opj_compress and dcmcjpls. Run from this directory.
"""
import json
import os
import shutil
import struct
import subprocess
import tempfile

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.sequence import Sequence
from pydicom.uid import UID, ExplicitVRLittleEndian

WSI = UID('1.2.840.10008.5.1.4.1.1.77.1.6')
TILE = 16


def s15(v):
    return struct.pack('>i', round(v * 65536))


def xyz(x, y, z):
    return b'XYZ ' + b'\0' * 4 + s15(x) + s15(y) + s15(z)


def swap_profile():
    """ICC v2 RGB matrix/TRC display profile whose colorants are sRGB's, rotated:
    device R has sRGB blue's XYZ, G red's, B green's."""
    r, g, b = (0.4361, 0.2225, 0.0139), (0.3851, 0.7169, 0.0971), (0.1431, 0.0606, 0.7141)
    desc_text = b'channel swap\0'
    desc = b'desc' + b'\0' * 4 + struct.pack('>I', len(desc_text)) + desc_text + b'\0' * 12 + b'\0' * 67
    curv = b'curv' + b'\0' * 4 + struct.pack('>IH', 1, 0x0233) + b'\0\0'  # gamma 2.2
    tags = [
        (b'desc', desc),
        (b'wtpt', xyz(0.9642, 1.0, 0.8249)),
        (b'rXYZ', xyz(*b)),
        (b'gXYZ', xyz(*r)),
        (b'bXYZ', xyz(*g)),
        (b'rTRC', curv),
        (b'gTRC', curv),
        (b'bTRC', curv),
        (b'cprt', b'text' + b'\0' * 4 + b'CC0\0'),
    ]
    offset = 128 + 4 + 12 * len(tags)
    table, data = b'', b''
    for sig, body in tags:
        body += b'\0' * (-len(body) % 4)
        table += sig + struct.pack('>II', offset + len(data), len(body))
        data += body
    size = offset + len(data)
    header = bytearray(128)
    header[0:4] = struct.pack('>I', size)
    header[8:12] = bytes([2, 0x10, 0, 0])
    header[12:16], header[16:20], header[20:24] = b'mntr', b'RGB ', b'XYZ '
    header[36:40] = b'acsp'
    header[68:80] = s15(0.9642) + s15(1.0) + s15(0.8249)
    return bytes(header) + struct.pack('>I', len(tags)) + table + data


def slide(name, sop, tiles, ts):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ts
    ds.file_meta.MediaStorageSOPClassUID = WSI
    ds.file_meta.MediaStorageSOPInstanceUID = sop
    ds.SOPClassUID, ds.SOPInstanceUID = WSI, sop
    ds.ImageType = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE']
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = '1.2.4.1', sop + '.1', '1.2.4.3'
    ds.ContainerIdentifier = name
    ds.Rows = ds.Columns = TILE
    ds.TotalPixelMatrixColumns, ds.TotalPixelMatrixRows = TILE * tiles, TILE
    ds.NumberOfFrames = tiles
    ds.DimensionOrganizationType = 'TILED_FULL'
    ds.PhotometricInterpretation = 'RGB'
    ds.SamplesPerPixel = 3
    ds.PlanarConfiguration = 0
    ds.BitsAllocated = ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.NumberOfOpticalPaths = 1
    ds.TotalPixelMatrixFocalPlanes = 1
    measures = Dataset()
    measures.PixelSpacing = [0.00025, 0.00025]
    shared = Dataset()
    shared.PixelMeasuresSequence = Sequence([measures])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])
    op = Dataset()
    op.OpticalPathIdentifier = '1'
    ds.OpticalPathSequence = Sequence([op])
    return ds


def rgb_tile(c):
    return np.full((TILE, TILE, 3), c, np.uint8)


def j2k(c):
    with tempfile.TemporaryDirectory() as tmp:
        ppm, out = os.path.join(tmp, 't.ppm'), os.path.join(tmp, 't.j2k')
        with open(ppm, 'wb') as f:
            f.write(b'P6\n%d %d\n255\n' % (TILE, TILE) + rgb_tile(c).tobytes())
        subprocess.run(['opj_compress', '-i', ppm, '-o', out, '-mct', '0', '-n', '3'], check=True, stdout=subprocess.DEVNULL)
        return open(out, 'rb').read()


ds = slide('jp2k', '1.2.4.10', 2, UID('1.2.840.10008.1.2.4.90'))
ds.OpticalPathSequence[0].ICCProfile = swap_profile()
ds.PixelData = encapsulate([j2k((255, 0, 0)), j2k((255, 255, 0))], has_bot=True)
ds['PixelData'].VR = 'OB'
ds['PixelData'].is_undefined_length = True
ds.save_as('jp2k.dcm', enforce_file_format=True)

# dcmcjpls encodes an uncompressed copy, keeping the WSI attributes.
ds = slide('jls', '1.2.4.20', 2, ExplicitVRLittleEndian)
ds.PixelData = rgb_tile((0, 255, 0)).tobytes() + rgb_tile((0, 0, 255)).tobytes()
with tempfile.TemporaryDirectory() as tmp:
    raw = os.path.join(tmp, 'raw.dcm')
    ds.save_as(raw, enforce_file_format=True)
    subprocess.run(['dcmcjpls', '+el', raw, 'jls.dcm'], check=True)

store = 'tiny.ome.zarr'
shutil.rmtree(store, ignore_errors=True)
os.makedirs(f'{store}/0')
json.dump({'zarr_format': 2}, open(f'{store}/.zgroup', 'w'))
json.dump({'multiscales': [{'version': '0.4', 'axes': [{'name': a, 'type': 'space', 'unit': 'micrometer'} for a in 'zyx'],
                            'datasets': [{'path': '0', 'coordinateTransformations': [{'type': 'scale', 'scale': [1, 1, 1]}]}]}]},
          open(f'{store}/.zattrs', 'w'))
json.dump({'zarr_format': 2, 'shape': [2, 3, 4], 'chunks': [2, 3, 4], 'dtype': '|u1', 'compressor': None,
           'fill_value': 0, 'order': 'C', 'filters': None, 'dimension_separator': '/'}, open(f'{store}/0/.zarray', 'w'))
os.makedirs(f'{store}/0/0/0')
open(f'{store}/0/0/0/0', 'wb').write(bytes(range(24)))
print('wrote jp2k.dcm, jls.dcm,', store, pydicom.__version__)
