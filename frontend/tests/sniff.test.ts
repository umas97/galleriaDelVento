// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { sniffBytes } from '../src/lib/sniff'

const enc = (s: string) => new TextEncoder().encode(s)

function binaryStl(triangles: number): Uint8Array {
  const data = new Uint8Array(84 + 50 * triangles)
  data.set(enc('solid but actually binary facet'), 0)
  new DataView(data.buffer).setUint32(80, triangles, true)
  return data
}

describe('sniffBytes', () => {
  it('recognises a binary STL by its size, even if the header says solid', () => {
    const stl = binaryStl(12)
    expect(sniffBytes(stl.subarray(0, 4096), stl.length)).toBe('mesh')
  })
  it('recognises ASCII STL and OBJ', () => {
    expect(sniffBytes(enc('solid cube\n facet normal 0 0 1\n'), 100)).toBe('mesh')
    expect(sniffBytes(enc('# Blender\nmtllib a.mtl\no Cube\nv 1 1 1\n'), 100)).toBe('mesh')
  })
  it('recognises SVG, DXF and images', () => {
    expect(sniffBytes(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">'), 80)).toBe('svg')
    expect(sniffBytes(enc('  0\nSECTION\n  2\nHEADER\n'), 40)).toBe('dxf')
    expect(sniffBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 6)).toBe('image')
    expect(sniffBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 6)).toBe('image')
    const webp = new Uint8Array(16)
    webp.set(enc('RIFF'), 0)
    webp.set(enc('WEBP'), 8)
    expect(sniffBytes(webp, 16)).toBe('image')
  })
  it('recognises HEIC photos, to say they are not supported', () => {
    const heic = new Uint8Array(32)
    heic.set(enc('ftypheic'), 4)
    expect(sniffBytes(heic, 32)).toBe('heic')
    heic.set(enc('ftypmp42'), 4) // an MP4 video is not a photo
    expect(sniffBytes(heic, 32)).toBe('unknown')
  })
  it('says unknown for anything else', () => {
    expect(sniffBytes(enc('hello world'), 11)).toBe('unknown')
    expect(sniffBytes(new Uint8Array(200), 200)).toBe('unknown')
  })
})
