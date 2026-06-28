export interface TarEntry {
  name: string
  content: Uint8Array
}

const HEADER = 512
const dec = new TextDecoder()

export function* parseTar(bytes: Uint8Array): Generator<TarEntry> {
  let offset = 0
  while (offset + HEADER <= bytes.length) {
    const header = bytes.subarray(offset, offset + HEADER)
    if (header.every((b) => b === 0)) break

    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*/, '')
    const sizeOctal = dec.decode(header.subarray(124, 136)).replace(/\0.*/, '').trim()
    const size = parseInt(sizeOctal, 8)
    const typeFlag = String.fromCharCode(header[156])

    offset += HEADER

    if ((typeFlag === '0' || typeFlag === '\0') && name && !isNaN(size)) {
      yield { name, content: bytes.subarray(offset, offset + size) }
    }

    offset += Math.ceil(size / HEADER) * HEADER
  }
}
