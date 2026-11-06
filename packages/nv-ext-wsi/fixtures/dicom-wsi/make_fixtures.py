#!/usr/bin/env python3
"""Synthetic DICOM-WSI instances for nv-ext-wsi's index tests (pydicom >= 3).

Licence-clean: no image data. Each frame's payload is a recognisable byte
string, FF D8 + a label + FF D9, so tests can check exact bytes and spans
without a decoder. Run from this directory: python3 make_fixtures.py

colors.dcm is the exception: a sparse slide whose tiles are
real solid-colour JPEGs (encoded by cjpeg), for the browser e2e test in
apps/demo-ext-wsi.
"""

import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate, encapsulate_extended
from pydicom.sequence import Sequence
from pydicom.uid import UID

JPEG = UID('1.2.840.10008.1.2.4.50')
WSI = UID('1.2.840.10008.5.1.4.1.1.77.1.6')
STUDY, SERIES, FOR = '1.2.3.1', '1.2.3.2', '1.2.3.3'
TILE = 16


def series_uid(name: str) -> str:
    return '1.2.3.2.' + str(sum(map(ord, name)))


def payload(label: str) -> bytes:
    # FF D8 starts a JPEG codestream; a COM segment carries the label; FF D9 ends it.
    body = label.encode()
    if len(body) % 2:
        body += b' '
    return b'\xff\xd8\xff\xfe' + (len(body) + 2).to_bytes(2, 'big') + body + b'\xff\xd9'


def icc_profile() -> bytes:
    p = bytearray(128)
    p[0:4] = (128).to_bytes(4, 'big')
    p[36:40] = b'acsp'
    return bytes(p)


def base(name: str, width: int, height: int, frames: int, *, sop: str, org='TILED_FULL', paths=1) -> Dataset:
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = JPEG
    ds.file_meta.MediaStorageSOPClassUID = WSI
    ds.file_meta.MediaStorageSOPInstanceUID = sop
    ds.SOPClassUID = WSI
    ds.SOPInstanceUID = sop
    ds.ImageType = ['DERIVED', 'PRIMARY', 'VOLUME', 'NONE']
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = STUDY, SERIES, FOR
    ds.ContainerIdentifier = name
    ds.Rows = ds.Columns = TILE
    ds.TotalPixelMatrixColumns, ds.TotalPixelMatrixRows = width, height
    ds.NumberOfFrames = frames
    ds.DimensionOrganizationType = org
    ds.PhotometricInterpretation = 'YBR_FULL_422'
    ds.SamplesPerPixel = 3
    ds.BitsAllocated = ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.NumberOfOpticalPaths = paths
    ds.TotalPixelMatrixFocalPlanes = 1
    measures = Dataset()
    measures.PixelSpacing = [0.0005, 0.00025]  # row, column (mm)
    shared = Dataset()
    shared.PixelMeasuresSequence = Sequence([measures])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])
    paths_seq = []
    for i in range(paths):
        op = Dataset()
        op.OpticalPathIdentifier = str(i + 1)
        if i == 0:
            op.ICCProfile = icc_profile()
            op.ColorSpace = 'SRGB'
        paths_seq.append(op)
    ds.OpticalPathSequence = Sequence(paths_seq)
    return ds


def save(ds: Dataset, frames: list[bytes], path: str, *, bot=True, eot=False, per_frame=1) -> None:
    if eot:
        data, offsets, lengths = encapsulate_extended(frames)
        ds.ExtendedOffsetTable = offsets
        ds.ExtendedOffsetTableLengths = lengths
    else:
        data = encapsulate(frames, fragments_per_frame=per_frame, has_bot=bot)
    ds.PixelData = data
    ds['PixelData'].VR = 'OB'
    ds['PixelData'].is_undefined_length = True
    ds.save_as(path, enforce_file_format=True)


def full(name: str, sop: str, w=40, h=30, path_count=1) -> tuple[Dataset, list[bytes]]:
    cols, rows = -(-w // TILE), -(-h // TILE)
    n = cols * rows * path_count
    ds = base(name, w, h, n, sop=sop, paths=path_count)
    return ds, [payload(f'{name} f{f + 1}') for f in range(n)]


def sparse(name: str, sop: str, positions: list[tuple[int, int]]) -> tuple[Dataset, list[bytes]]:
    ds = base(name, 40, 30, len(positions), sop=sop, org='TILED_SPARSE')
    items = []
    for x, y in positions:
        pos = Dataset()
        pos.ColumnPositionInTotalImagePixelMatrix = x * TILE + 1
        pos.RowPositionInTotalImagePixelMatrix = y * TILE + 1
        pos.ZOffsetInSlideCoordinateSystem = 0.0
        ident = Dataset()
        ident.OpticalPathIdentifier = '1'
        item = Dataset()
        item.PlanePositionSlideSequence = Sequence([pos])
        item.OpticalPathIdentificationSequence = Sequence([ident])
        items.append(item)
    ds.PerFrameFunctionalGroupsSequence = Sequence(items)
    return ds, [payload(f'{name} x{x}y{y}') for x, y in positions]


# TILED_FULL 3 x 2 (40 x 30 in 16-px tiles), with a 2 x 1 coarser level beside it.
ds, fr = full('bot', '1.2.3.10')
save(ds, fr, 'bot.dcm')
ds, fr = full('bot', '1.2.3.11', w=20, h=15)
save(ds, fr, 'bot-l1.dcm')
for name, kw in (('nobot', {'bot': False}), ('eot', {'eot': True, 'bot': False})):
    ds, fr = full(name, f'1.2.3.2{len(name)}')
    ds.SeriesInstanceUID = series_uid(name)
    save(ds, fr, f'{name}.dcm', **kw)

# Multi-fragment frames (2 fragments each), with and without a BOT.
for name, bot in (('frag-bot', True), ('frag-walk', False)):
    ds, fr = full(name, f'1.2.3.3{int(bot)}')
    ds.SeriesInstanceUID = series_uid(name)
    save(ds, fr, f'{name}.dcm', bot=bot, per_frame=2)

# TILED_SPARSE: 4 of 6 tiles; and one with a duplicated position.
ds, fr = sparse('sparse', '1.2.3.40', [(0, 0), (2, 0), (1, 1), (2, 1)])
ds.SeriesInstanceUID = series_uid('sparse')
save(ds, fr, 'sparse.dcm')
ds, fr = sparse('dup', '1.2.3.41', [(0, 0), (1, 0), (1, 0)])
ds.SeriesInstanceUID = series_uid('dup')
save(ds, fr, 'dup.dcm')

# Two optical paths, TILED_FULL: frames 1-6 path 1, 7-12 path 2.
ds, fr = full('paths', '1.2.3.50', path_count=2)
ds.SeriesInstanceUID = series_uid('paths')
save(ds, fr, 'paths.dcm')

# One level concatenated across two SOPs: frames 1-4, then 5-6.
ds, fr = full('concat', '1.2.3.60')
for part, (sop, lo, hi) in enumerate((('1.2.3.61', 0, 4), ('1.2.3.62', 4, 6)), start=1):
    d, _ = full('concat', sop)
    d.SeriesInstanceUID = series_uid('concat')
    d.NumberOfFrames = hi - lo
    d.ConcatenationUID = '1.2.3.69'
    d.InConcatenationNumber = part
    d.InConcatenationTotalNumber = 2
    d.ConcatenationFrameOffsetNumber = lo
    save(d, fr[lo:hi], f'concat-{part}.dcm')

# Browser e2e: TILED_SPARSE 3 x 2 with real JPEG tiles, one colour each, two holes.
import subprocess
COLORS = {(0, 0): (220, 30, 30), (2, 0): (30, 160, 40), (1, 1): (40, 60, 220), (2, 1): (230, 200, 30)}


def jpeg(rgb: tuple[int, int, int]) -> bytes:
    ppm = b'P6 %d %d 255\n' % (TILE, TILE) + bytes(rgb) * (TILE * TILE)
    return subprocess.run(['cjpeg', '-quality', '95'], input=ppm, capture_output=True, check=True).stdout


ds, _ = sparse('colors', '1.2.3.80', list(COLORS))
ds.SeriesInstanceUID = series_uid('colors')
save(ds, [jpeg(c) for c in COLORS.values()], 'colors.dcm')

# Refused transfer syntaxes, and a file that is not DICOM.
for name, ts in (('implicit', '1.2.840.10008.1.2'), ('bigendian', '1.2.840.10008.1.2.2'), ('deflated', '1.2.840.10008.1.2.1.99')):
    d = Dataset()
    d.file_meta = FileMetaDataset()
    d.file_meta.TransferSyntaxUID = UID(ts)
    d.file_meta.MediaStorageSOPClassUID = WSI
    d.file_meta.MediaStorageSOPInstanceUID = f'1.2.3.7{len(name)}'
    d.SOPClassUID = WSI
    d.SOPInstanceUID = f'1.2.3.7{len(name)}'
    d.Rows = d.Columns = TILE
    d.SamplesPerPixel = 1
    d.BitsAllocated = d.BitsStored = 8
    d.HighBit = 7
    d.PixelRepresentation = 0
    d.PixelData = b'\0' * (TILE * TILE)
    d.save_as(f'{name}.dcm', enforce_file_format=True)
with open('not-dicom.dcm', 'w') as f:
    f.write('not a DICOM file\n')
