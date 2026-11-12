#!/usr/bin/env python3
"""Synthetic DICOM-WSI instances for nv-ext-tile's index tests (pydicom >= 3).

Licence-clean: no image data. Each frame's payload is a recognisable byte
string, FF D8 + a label + FF D9, so tests can check exact bytes and spans
without a decoder. Run from this directory: python3 make_fixtures.py

colors.dcm is the exception: a sparse slide whose tiles are
real solid-colour JPEGs (encoded by cjpeg), for the browser e2e test in
apps/demo-ext-tile.

Some instances also get a PS3.18 DICOM JSON sibling (name.json) for the parity
test, formatted by Biome as the repo is.
"""

import json
import subprocess

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


def save(ds: Dataset, frames: list[bytes], path: str, *, bot=True, eot=False, per_frame=1, json_bulk=None) -> None:
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
    if json_bulk is not None:
        save_json(ds, path, json_bulk)


def save_json(ds: Dataset, path: str, bulk: bool) -> None:
    """File meta included for its TransferSyntaxUID. Binary values become
    BulkDataURIs, or InlineBinary when not `bulk`."""
    uri = lambda e: f'bulk/{ds.SOPInstanceUID}/{e.tag:08X}'
    meta = ds.file_meta.to_json_dict()
    body = ds.to_json_dict(bulk_data_threshold=1 if bulk else 1 << 20, bulk_data_element_handler=uri)
    out = path.replace('.dcm', '.json')
    with open(out, 'w') as f:
        json.dump({**meta, **body}, f, indent=2)
    subprocess.run(['bunx', 'biome', 'format', '--write', out], capture_output=True, check=True)


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


def second_path(ds: Dataset) -> None:
    op = Dataset()
    op.OpticalPathIdentifier = '2'
    ds.OpticalPathSequence.append(op)
    ds.NumberOfOpticalPaths = 2


# TILED_FULL 3 x 2 (40 x 30 in 16-px tiles), with a 2 x 1 coarser level beside it.
ds, fr = full('bot', '1.2.3.10')
save(ds, fr, 'bot.dcm', json_bulk=True)
ds, fr = full('bot', '1.2.3.11', w=20, h=15)
save(ds, fr, 'bot-l1.dcm', json_bulk=True)
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
save(ds, fr, 'sparse.dcm', json_bulk=True)
ds, fr = sparse('dup', '1.2.3.41', [(0, 0), (1, 0), (1, 0)])
ds.SeriesInstanceUID = series_uid('dup')
save(ds, fr, 'dup.dcm', json_bulk=True)

# Two optical paths, TILED_FULL: frames 1-6 path 1, 7-12 path 2.
ds, fr = full('paths', '1.2.3.50', path_count=2)
ds.SeriesInstanceUID = series_uid('paths')
save(ds, fr, 'paths.dcm', json_bulk=True)

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
    save(d, fr[lo:hi], f'concat-{part}.dcm', json_bulk=True)

# Two focal planes by per-frame ZOffset, the higher first, so the stated ZOffsets
# (not the implicit TILED_FULL plane order) decide which is plane 0; spacing per
# frame only; and binary values (ICC profile, pixel data) inline in its JSON.
ds, fr = full('planes', '1.2.3.90')
ds.SeriesInstanceUID = series_uid('planes')
ds.TotalPixelMatrixFocalPlanes = 2
ds.NumberOfFrames = 12
measures = ds.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence
del ds.SharedFunctionalGroupsSequence
items = []
for f in range(12):
    pos = Dataset()
    pos.ZOffsetInSlideCoordinateSystem = 2.5 if f < 6 else 0.0
    item = Dataset()
    item.PlanePositionSlideSequence = Sequence([pos])
    item.PixelMeasuresSequence = measures
    items.append(item)
ds.PerFrameFunctionalGroupsSequence = Sequence(items)
save(ds, [payload(f'planes f{f + 1}') for f in range(12)], 'planes.dcm', json_bulk=False)

# MONOCHROME2 12-bit JPEG-LS, spacing only from ImagedVolumeWidth/Height (mm), no ICC;
# the top-level PixelSpacing is the [1,1] placeholder WSI files often carry.
ds, fr = full('mono12', '1.2.3.91')
ds.SeriesInstanceUID = series_uid('mono12')
ds.file_meta.TransferSyntaxUID = UID('1.2.840.10008.1.2.4.80')
ds.PhotometricInterpretation = 'MONOCHROME2'
ds.SamplesPerPixel = 1
ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 12, 11
ds.ImagedVolumeWidth, ds.ImagedVolumeHeight = 0.02, 0.015
ds.PixelSpacing = [1, 1]
del ds.SharedFunctionalGroupsSequence
del ds.OpticalPathSequence[0].ICCProfile
# Its frames name the second of two optical paths, per frame.
second_path(ds)
items = []
for f in range(6):
    item = Dataset()
    item.OpticalPathIdentificationSequence = Sequence([Dataset()])
    item.OpticalPathIdentificationSequence[0].OpticalPathIdentifier = '2'
    items.append(item)
ds.PerFrameFunctionalGroupsSequence = Sequence(items)
save(ds, fr, 'mono12.dcm', json_bulk=True)

# No DimensionOrganizationType and no per-frame positions: implicit TILED_FULL;
# spacing only from the top-level PixelSpacing.
ds, fr = full('noorg', '1.2.3.92')
ds.SeriesInstanceUID = series_uid('noorg')
del ds.DimensionOrganizationType
ds.PixelSpacing = [0.0005, 0.00025]
# Its frames name the second of two optical paths, in the shared group.
second_path(ds)
ident = Dataset()
ident.OpticalPathIdentifier = '2'
ds.SharedFunctionalGroupsSequence[0] = Dataset()
ds.SharedFunctionalGroupsSequence[0].OpticalPathIdentificationSequence = Sequence([ident])
save(ds, fr, 'noorg.dcm', json_bulk=True)

# Browser e2e: TILED_SPARSE 3 x 2 with real JPEG tiles, one colour each, two holes.
COLORS = {(0, 0): (220, 30, 30), (2, 0): (30, 160, 40), (1, 1): (40, 60, 220), (2, 1): (230, 200, 30)}


def jpeg(rgb: tuple[int, int, int]) -> bytes:
    ppm = b'P6 %d %d 255\n' % (TILE, TILE) + bytes(rgb) * (TILE * TILE)
    return subprocess.run(['cjpeg', '-quality', '95'], input=ppm, capture_output=True, check=True).stdout


ds, _ = sparse('colors', '1.2.3.80', list(COLORS))
ds.SeriesInstanceUID = series_uid('colors')
save(ds, [jpeg(c) for c in COLORS.values()], 'colors.dcm')

# Associated images of the 'bot' specimen (same study, series and container):
# a native RGB label (16 x 8, red rising along x), a real-JPEG overview, and a
# thumbnail of one payload split in two fragments.
EXPLICIT = UID('1.2.840.10008.1.2.1')
d, _ = full('bot', '1.2.3.12', w=16, h=8)
d.file_meta.TransferSyntaxUID = EXPLICIT
d.ImageType = ['ORIGINAL', 'PRIMARY', 'LABEL', 'NONE']
d.Rows, d.Columns = 8, 16
d.NumberOfFrames = 1
d.PhotometricInterpretation = 'RGB'
d.PlanarConfiguration = 0
d.PixelData = bytes(v for y in range(8) for x in range(16) for v in (x * 16, y * 32, 7))
d['PixelData'].VR = 'OB'
d.save_as('label.dcm', enforce_file_format=True)
d, _ = full('bot', '1.2.3.13', w=16, h=16)
d.ImageType = ['ORIGINAL', 'PRIMARY', 'OVERVIEW', 'NONE']
d.NumberOfFrames = 1
save(d, [jpeg((10, 120, 200))], 'overview.dcm')
d, _ = full('bot', '1.2.3.14', w=16, h=16)
d.ImageType = ['DERIVED', 'PRIMARY', 'THUMBNAIL', 'RESAMPLED']
d.NumberOfFrames = 1
save(d, [payload('bot thumb')], 'thumbnail.dcm', per_frame=2)

# Signed MONOCHROME2 8-bit JPEG with a rescale: every tile stores grey 200, a
# signed -56 (data value 2 * -56 - 10 = -122).
def grey_jpeg(v: int) -> bytes:
    pgm = b'P5 %d %d 255\n' % (TILE, TILE) + bytes([v]) * (TILE * TILE)
    return subprocess.run(['cjpeg', '-quality', '100', '-grayscale'], input=pgm, capture_output=True, check=True).stdout


ds, _ = full('monosigned', '1.2.3.93')
ds.SeriesInstanceUID = series_uid('monosigned')
ds.PhotometricInterpretation = 'MONOCHROME2'
ds.SamplesPerPixel = 1
ds.PixelRepresentation = 1
ds.RescaleSlope, ds.RescaleIntercept = 2, -10
del ds.OpticalPathSequence[0].ICCProfile
save(ds, [grey_jpeg(200)] * 6, 'monosigned.dcm', json_bulk=True)

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
