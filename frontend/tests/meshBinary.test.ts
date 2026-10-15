// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { HEADER_BYTES, MeshFormatError, parseMesh } from '../src/lib/meshBinary'

/** The same layout as backend/gdv/geometry/mesh_binary.py:encode. */
function encode(vertices: number[], indices: number[], header: Record<string, unknown> = {}): ArrayBuffer {
  const n = vertices.length / 3
  const m = indices.length / 3
  const json = JSON.stringify({
    format: 'gdv-mesh',
    version: 1,
    vertices: n,
    triangles: m,
    bbox_min: [0, 0, 0],
    bbox_max: [1, 1, 1],
    units: 'm',
    ...header,
  }).padEnd(HEADER_BYTES, ' ')
  const buffer = new ArrayBuffer(HEADER_BYTES + 12 * n + 12 * m)
  new Uint8Array(buffer).set(new TextEncoder().encode(json), 0)
  new Float32Array(buffer, HEADER_BYTES, 3 * n).set(vertices)
  new Uint32Array(buffer, HEADER_BYTES + 12 * n, 3 * m).set(indices)
  return buffer
}

describe('parseMesh', () => {
  it('views positions and indices without copying', () => {
    const buffer = encode([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], { model_id: 'abc' })
    const mesh = parseMesh(buffer)
    expect(mesh.header.model_id).toBe('abc')
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2])
    expect(mesh.positions.buffer).toBe(buffer)
  })
  it('rejects other versions and truncated files', () => {
    expect(() => parseMesh(encode([0, 0, 0], [], { version: 2 }))).toThrow(MeshFormatError)
    const good = encode([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2])
    expect(() => parseMesh(good.slice(0, good.byteLength - 4))).toThrow(/troncata/)
    expect(() => parseMesh(new ArrayBuffer(10))).toThrow(MeshFormatError)
  })
})
