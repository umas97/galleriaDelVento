// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// What kind of file the user dropped, from its *content* (SPEC §12.1): the
// extension is only a tie-breaker. The backend checks again on its side.

export type FileKind = 'mesh' | 'svg' | 'dxf' | 'image' | 'heic' | 'unknown'

const MESH_TOKENS = new Set(['v', 'vn', 'vt', 'f', 'o', 'g', 'mtllib', 'usemtl', 's'])
// ISO-BMFF brands of HEIC/HEIF photos (iPhone): recognised to say they are not supported.
const HEIF_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'heim', 'hevc'])

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b)
}

/** Classify `head` (the first few KB of a file of `size` bytes). */
export function sniffBytes(head: Uint8Array, size: number): FileKind {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image' // JPEG
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'image' // PNG
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image' // WebP
  if (head.length >= 12) {
    const box = new TextDecoder('latin1').decode(head.subarray(4, 12))
    if (box.startsWith('ftyp') && HEIF_BRANDS.has(box.slice(4))) return 'heic'
  }
  if (head.length >= 84 && size >= 84) {
    const count = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(80, true)
    if (84 + 50 * count === size) return 'mesh' // binary STL
  }
  const text = new TextDecoder('latin1').decode(head.subarray(0, 4096))
  const trimmed = text.trimStart().toLowerCase()
  if (trimmed.startsWith('solid') && trimmed.includes('facet')) return 'mesh'
  if (/<svg[\s>]/i.test(text)) return 'svg'
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i] === '0' && /^(SECTION|EOF)$/.test(lines[i + 1])) return 'dxf'
  }
  for (const line of lines) {
    const token = line.split(/\s+/, 1)[0]
    if (MESH_TOKENS.has(token)) return 'mesh'
  }
  return 'unknown'
}

export async function sniffFile(file: File): Promise<FileKind> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  return sniffBytes(head, file.size)
}
