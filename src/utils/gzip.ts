// gzip 展開の単一実装。DMDATA の電文は WebSocket 経由（base64 + gzip）と
// archive 経由（tar.gz）の 2 系統で届き、どちらも同じ展開処理を必要とする。
//
// 実装を 1 箇所に集約している理由: 以前は両者が別々に書かれており、archive 側だけが
// writer/reader を自前で回す形になっていた。そちらに「例外を確実に捕まえる」目的で
// `await writer.write()` が足された結果、バックプレッシャによる相互待ちで永久に
// resolve しなくなり、リプレイが無言で固まる事故が起きた（v4.10.1 で修正）。
// 同じロジックが 2 箇所にあると、片方だけが壊れても気づけない。

/**
 * gzip バイト列をブラウザネイティブの `DecompressionStream` で展開する。
 *
 * `pipeThrough` + `Response` に委ねることで、書き込みと読み出しのポンプ処理は
 * ブラウザ側が持つ。自前で `getWriter()` / `getReader()` を直列に回したときのような
 * 相互待ちが構造的に起きない。
 *
 * @param bytes gzip 圧縮されたバイト列
 * @returns 展開後のバイト列
 * @throws 展開に失敗した場合（破損 gzip・途中切断等）。呼び出し元の try/catch で捕捉すること。
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
