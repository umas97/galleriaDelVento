// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Parser of the binary mesh format written by backend/gdv/geometry/mesh_binary.py:
// a JSON header of HEADER_BYTES bytes padded with spaces, then float32 vertices
// and uint32 indices, little-endian and 4-byte aligned. The arrays are views on
// the downloaded buffer: no copy, so the buffer can be transferred to a worker.

export const MESH_FORMAT = 'gdv-mesh'
export const MESH_VERSION = 1
export const HEADER_BYTES = 1024

export type MeshHeader = {
  format: string
  version: number
  vertices: number
  triangles: number
  bbox_min: [number, number, number]
  bbox_max: [number, number, number]
  units: 'm'
  model_id?: string
}

export type MeshData = {
  header: MeshHeader
  positions: Float32Array
  indices: Uint32Array
  buffer: ArrayBuffer
}

export class MeshFormatError extends Error {
  name = 'MeshFormatError'
}

export function parseMesh(buffer: ArrayBuffer): MeshData {
  if (buffer.byteLength < HEADER_BYTES) throw new MeshFormatError('mesh binaria troppo corta')
  const text = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, HEADER_BYTES))
  let header: MeshHeader
  try {
    header = JSON.parse(text) as MeshHeader
  } catch {
    throw new MeshFormatError('intestazione della mesh illeggibile')
  }
  if (header.format !== MESH_FORMAT || header.version !== MESH_VERSION) {
    throw new MeshFormatError(`formato di mesh non supportato: ${header.format} v${header.version}`)
  }
  const expected = HEADER_BYTES + 12 * header.vertices + 12 * header.triangles
  if (buffer.byteLength !== expected) {
    throw new MeshFormatError(`mesh troncata: ${buffer.byteLength} byte invece di ${expected}`)
  }
  const positions = new Float32Array(buffer, HEADER_BYTES, header.vertices * 3)
  const indices = new Uint32Array(buffer, HEADER_BYTES + 12 * header.vertices, header.triangles * 3)
  return { header, positions, indices, buffer }
}
