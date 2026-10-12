import { describe, expect, test } from 'bun:test'
import type { NVMesh } from '@/NVTypes'
import {
  isMeshUploadCurrent,
  mergeMeshRebuild,
  meshUploadStamp,
  planMeshSync,
  type StampedMeshGpu,
  stampAfterVertexWrite,
} from '@/view/meshGpuSync'

function mesh(name: string): NVMesh {
  return {
    name,
    positions: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    colors: new Uint32Array(3),
    opacity: 1,
  } as unknown as NVMesh
}

/** A backend's resource map after uploading `meshes`. */
function uploaded(...meshes: NVMesh[]): Map<NVMesh, StampedMeshGpu> {
  return new Map(meshes.map((m) => [m, { uploadStamp: meshUploadStamp(m) }]))
}

describe('planMeshSync', () => {
  test("'all' frees and re-uploads every mesh", () => {
    const [a, b] = [mesh('a'), mesh('b')]
    expect(planMeshSync(uploaded(a, b), [a, b], 'all')).toEqual({
      free: [a, b],
      upload: [a, b],
    })
  })

  test("'none' touches nothing, even with a stale mesh", () => {
    const a = mesh('a')
    const res = uploaded(a)
    a._dataVersion = 1
    expect(planMeshSync(res, [a, mesh('new')], 'none')).toEqual({
      free: [],
      upload: [],
    })
  })

  test('a volume-only update rebuilds no mesh', () => {
    const meshes = [mesh('a'), mesh('b'), mesh('c')]
    expect(planMeshSync(uploaded(...meshes), meshes, 'changed')).toEqual({
      free: [],
      upload: [],
    })
  })

  test('adding a mesh uploads only that mesh', () => {
    const [a, b, added] = [mesh('a'), mesh('b'), mesh('added')]
    expect(planMeshSync(uploaded(a, b), [a, b, added], 'changed')).toEqual({
      free: [],
      upload: [added],
    })
  })

  test('removing a mesh frees only that mesh', () => {
    const [a, removed, b] = [mesh('a'), mesh('removed'), mesh('b')]
    expect(planMeshSync(uploaded(a, removed, b), [a, b], 'changed')).toEqual({
      free: [removed],
      upload: [],
    })
  })

  test('a draw-time change (opacity, shader) re-uploads nothing', () => {
    const [a, b] = [mesh('a'), mesh('b')]
    const res = uploaded(a, b)
    a.opacity = 0.3
    a.shaderType = 'toon'
    expect(planMeshSync(res, [a, b], 'changed')).toEqual({
      free: [],
      upload: [],
    })
  })

  test('an in-place vertex data edit re-uploads only that mesh', () => {
    const [a, b] = [mesh('a'), mesh('b')]
    const res = uploaded(a, b)
    a.colors.fill(0xff0000ff)
    a._dataVersion = 1
    expect(planMeshSync(res, [a, b], 'changed')).toEqual({
      free: [a],
      upload: [a],
    })
  })

  test('replaced geometry arrays (retessellation) re-upload the mesh', () => {
    const [a, b] = [mesh('a'), mesh('b')]
    const res = uploaded(a, b)
    b.positions = new Float32Array(12)
    b.indices = new Uint32Array([0, 1, 2, 1, 2, 3])
    b.colors = new Uint32Array(4)
    expect(planMeshSync(res, [a, b], 'changed')).toEqual({
      free: [b],
      upload: [b],
    })
  })

  test('a mesh listed twice is planned once', () => {
    const a = mesh('a')
    expect(planMeshSync(new Map(), [a, a], 'changed').upload).toEqual([a])
    expect(planMeshSync(new Map(), [a, a], 'all').upload).toEqual([a])
  })

  test('resources without a stamp are treated as stale', () => {
    const a = mesh('a')
    const res = new Map<NVMesh, StampedMeshGpu>([[a, {}]])
    expect(planMeshSync(res, [a], 'changed')).toEqual({
      free: [a],
      upload: [a],
    })
  })
})

describe('isMeshUploadCurrent', () => {
  test('tracks the data version and array identities', () => {
    const a = mesh('a')
    const stamp = meshUploadStamp(a)
    expect(isMeshUploadCurrent(stamp, a)).toBe(true)
    expect(isMeshUploadCurrent(undefined, a)).toBe(false)
    a._dataVersion = 2
    expect(isMeshUploadCurrent(stamp, a)).toBe(false)
    expect(isMeshUploadCurrent(meshUploadStamp(a), a)).toBe(true)
  })
})

describe('position edits', () => {
  test('an in-place position edit (_positionsVersion) re-uploads the mesh', () => {
    const [a, b] = [mesh('a'), mesh('b')]
    const res = uploaded(a, b)
    a.positions[0] = 5
    a._positionsVersion = 1
    expect(planMeshSync(res, [a, b], 'changed')).toEqual({
      free: [a],
      upload: [a],
    })
  })

  test('a vertex write refreshes only the position fields of the stamp', () => {
    const a = mesh('a')
    const stamp = meshUploadStamp(a)
    a._positionsVersion = 3
    const written = stampAfterVertexWrite(stamp, a)
    expect(isMeshUploadCurrent(written, a)).toBe(true)
    // The index buffer was not rewritten: an index or colour change made
    // before the write still re-uploads.
    a.indices = new Uint32Array([2, 1, 0])
    a._dataVersion = 1
    const stale = stampAfterVertexWrite(stamp, a)
    expect(stale?.indices).toBe(stamp.indices)
    expect(stale?.dataVersion).toBe(0)
    expect(isMeshUploadCurrent(stale, a)).toBe(false)
  })

  test('a vertex write leaves a missing stamp missing (stale)', () => {
    expect(stampAfterVertexWrite(undefined, mesh('a'))).toBeUndefined()
  })
})

describe('mergeMeshRebuild', () => {
  test('coalesced updates take the widest mesh rebuild', () => {
    expect(mergeMeshRebuild('none', 'none')).toBe('none')
    expect(mergeMeshRebuild('none', 'changed')).toBe('changed')
    expect(mergeMeshRebuild('changed', 'none')).toBe('changed')
    expect(mergeMeshRebuild('changed', 'all')).toBe('all')
    expect(mergeMeshRebuild('all', 'none')).toBe('all')
  })
})
