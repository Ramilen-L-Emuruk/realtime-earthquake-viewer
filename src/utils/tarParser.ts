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

    // サイズが読めないヘッダに当たったら、そこで打ち切らず必ず投げる。
    // 黙って続けると offset が NaN に汚染され、次の while 判定が常に false になって
    // ジェネレータが正常終了と区別つかない形で終わる（＝以降の全エントリが無言で消える）。
    if (Number.isNaN(size)) {
      throw new Error(`tar 破損: サイズヘッダを解析できない (offset=${offset - HEADER}, name="${name}")`)
    }

    if ((typeFlag === '0' || typeFlag === '\0') && name) {
      yield { name, content: bytes.subarray(offset, offset + size) }
    }

    offset += Math.ceil(size / HEADER) * HEADER
  }
}
