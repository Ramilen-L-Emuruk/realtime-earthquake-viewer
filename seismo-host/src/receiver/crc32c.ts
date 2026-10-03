// CRC-32C（Castagnoli）。miniSEED 3 がレコードごとに要求する検査値（RFC 3309 の定義）。
//
// **Node の `zlib.crc32` は使えない。** あちらは別の多項式（CRC-32・0x04C11DB7）で、
// 値は通るのに中身が違う —— 読む側は全レコードを「壊れている」として捨てる。

/** 反転した多項式 0x82F63B78 の表。 */
const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
