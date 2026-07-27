// 【PoC専用・使い捨て】§8「実行時メモリ（RAM 4GB 実機）」の検証。
//
// performance.memory は JS ヒープのみで、WebGL バッファ（頂点/インデックス）・テクスチャ
// （タイル・グリフアトラス・FBO 用等）・レンダーバッファを含まない。ブラウザには WebGL の
// メモリ使用量を直接取得する標準APIが無いため、WebGLコンテキストの確保系呼び出し
// （bufferData/texImage2D/renderbufferStorage 等）をプロキシで横取りし、確保・解放された
// バイト数を自前で積算して推定する。
//
// MapLibre は Map コンストラクタ内部で <canvas> を生成し、そこから自分で
// getContext('webgl2', ...) を呼ぶ（外部から既存 canvas/context を注入するオプションは無い）。
// そのため Map インスタンス生成より前に HTMLCanvasElement.prototype.getContext を
// モンキーパッチしておき、MapLibre が内部生成する canvas に対しても捕捉できるようにする
// （本モジュールを import した時点でパッチが当たる。呼び出し順序に注意）。
//
// 精度の割り切り: テクスチャユニット単位の厳密な bind 追跡（activeTexture 併用）はせず、
// target（TEXTURE_2D 等）ごとに「最後に bindTexture されたオブジェクト」を記録するだけの
// 簡易実装。bufferData/renderbufferStorage も internalformat からの概算。目的は「軸を振ったとき
// 推定値が単調に反応するか」の確認であり、絶対値の厳密さではない。

export interface WebglMemorySnapshot {
  bufferBytes: number
  textureBytes: number
  renderbufferBytes: number
  totalBytes: number
  /** webgl2 コンテキストを一度でも捕捉できたか。false なら totalBytes=0 は「計測できていない」
   * ことを意味し、「WebGLを使っていない」の意味ではない（レビュー LOW: webgl1 環境では
   * getContext パッチが type==='webgl2' にしか反応せず、静かに 0 を返し続けるため区別が必要）。 */
  tracked: boolean
}

let bufferBytes = 0
let textureBytes = 0
let renderbufferBytes = 0
let tracked = false

let bufferSizes = new WeakMap<WebGLBuffer, number>()
let textureSizes = new WeakMap<WebGLTexture, number>()
let renderbufferSizes = new WeakMap<WebGLRenderbuffer, number>()

// target(TEXTURE_2D 等)/(ARRAY_BUFFER 等) ごとに最後にバインドされたオブジェクトを覚える簡易表。
const boundTextureByTarget = new Map<number, WebGLTexture | null>()
const boundBufferByTarget = new Map<number, WebGLBuffer | null>()
let boundRenderbuffer: WebGLRenderbuffer | null = null

// context lost 時、失われた側のオブジェクトは delete*() が呼ばれないまま無効化されるため
// カウンタが減算されず残る（レビュー HIGH: 実機の RAM 4GB 機で context lost が起きた場合、
// 見かけ上のリークになりうる）。'webglcontextlost' でカウンタ・WeakMap・bind状態を丸ごと
// リセットする。'webglcontextrestored' 後に MapLibre が張り直すリソースは、
// installWebglMemoryTracker() の getContext パッチが新しいコンテキストを自動で
// 再ラップするため、0 から積算し直される。
function resetTrackerState(): void {
  bufferBytes = 0
  textureBytes = 0
  renderbufferBytes = 0
  bufferSizes = new WeakMap()
  textureSizes = new WeakMap()
  renderbufferSizes = new WeakMap()
  boundTextureByTarget.clear()
  boundBufferByTarget.clear()
  boundRenderbuffer = null
}

function cubeMapFaceToTarget(gl: WebGL2RenderingContext, target: number): number {
  return target >= gl.TEXTURE_CUBE_MAP_POSITIVE_X && target <= gl.TEXTURE_CUBE_MAP_NEGATIVE_Z
    ? gl.TEXTURE_CUBE_MAP
    : target
}

// パックされた型は 1 ピクセルあたり固定バイト数（components 計算を経由しない）。
function packedTypeBytes(gl: WebGL2RenderingContext, type: number): number | null {
  const table: Record<number, number> = {
    [gl.UNSIGNED_SHORT_5_6_5]: 2,
    [gl.UNSIGNED_SHORT_4_4_4_4]: 2,
    [gl.UNSIGNED_SHORT_5_5_5_1]: 2,
    [gl.UNSIGNED_INT_2_10_10_10_REV]: 4,
    [gl.UNSIGNED_INT_24_8]: 4,
    [gl.UNSIGNED_INT_5_9_9_9_REV]: 4,
    [gl.UNSIGNED_INT_10F_11F_11F_REV]: 4,
  }
  return table[type] ?? null
}

function componentsForFormat(gl: WebGL2RenderingContext, format: number): number {
  switch (format) {
    case gl.RGBA:
    case gl.RGBA_INTEGER:
      return 4
    case gl.RGB:
    case gl.RGB_INTEGER:
      return 3
    case gl.LUMINANCE_ALPHA:
    case gl.RG:
    case gl.RG_INTEGER:
      return 2
    case gl.ALPHA:
    case gl.LUMINANCE:
    case gl.RED:
    case gl.RED_INTEGER:
    case gl.DEPTH_COMPONENT:
    case gl.DEPTH_STENCIL:
      return 1
    default:
      return 4 // 不明フォーマットは安全側（過大）に倒す
  }
}

function bytesPerComponent(gl: WebGL2RenderingContext, type: number): number {
  switch (type) {
    case gl.BYTE:
    case gl.UNSIGNED_BYTE:
      return 1
    case gl.SHORT:
    case gl.UNSIGNED_SHORT:
    case gl.HALF_FLOAT:
      return 2
    case gl.INT:
    case gl.UNSIGNED_INT:
    case gl.FLOAT:
      return 4
    default:
      return 1
  }
}

function bytesPerPixel(gl: WebGL2RenderingContext, format: number, type: number): number {
  const packed = packedTypeBytes(gl, type)
  if (packed != null) return packed
  return componentsForFormat(gl, format) * bytesPerComponent(gl, type)
}

// sized internalformat（renderbufferStorage・texStorage2D 共通）から 1px あたりの
// バイト数を概算する。
function bytesPerPixelForSizedFormat(gl: WebGL2RenderingContext, internalformat: number): number {
  const table: Record<number, number> = {
    [gl.RGBA8]: 4,
    [gl.RGB8]: 3,
    [gl.RGBA4]: 2,
    [gl.RGB565]: 2,
    [gl.RGB5_A1]: 2,
    [gl.RGBA16F]: 8,
    [gl.RGB16F]: 6,
    [gl.RGBA32F]: 16,
    [gl.RGB32F]: 12,
    [gl.R8]: 1,
    [gl.RG8]: 2,
    [gl.SRGB8_ALPHA8]: 4,
    [gl.DEPTH_COMPONENT16]: 2,
    [gl.DEPTH_COMPONENT24]: 4,
    [gl.DEPTH_COMPONENT32F]: 4,
    [gl.DEPTH24_STENCIL8]: 4,
    [gl.STENCIL_INDEX8]: 1,
  }
  return table[internalformat] ?? 4
}

function setTextureSize(tex: WebGLTexture | null, bytes: number): void {
  if (!tex) return
  const prev = textureSizes.get(tex) ?? 0
  textureBytes += bytes - prev
  textureSizes.set(tex, bytes)
}

function setBufferSize(buf: WebGLBuffer | null, bytes: number): void {
  if (!buf) return
  const prev = bufferSizes.get(buf) ?? 0
  bufferBytes += bytes - prev
  bufferSizes.set(buf, bytes)
}

function setRenderbufferSize(rb: WebGLRenderbuffer | null, bytes: number): void {
  if (!rb) return
  const prev = renderbufferSizes.get(rb) ?? 0
  renderbufferBytes += bytes - prev
  renderbufferSizes.set(rb, bytes)
}

function wrapContext(gl: WebGL2RenderingContext): void {
  tracked = true
  gl.canvas.addEventListener('webglcontextlost', resetTrackerState)

  const origBindTexture = gl.bindTexture.bind(gl)
  gl.bindTexture = (target: number, texture: WebGLTexture | null) => {
    boundTextureByTarget.set(cubeMapFaceToTarget(gl, target), texture)
    return origBindTexture(target, texture)
  }

  const origBindBuffer = gl.bindBuffer.bind(gl)
  gl.bindBuffer = (target: number, buffer: WebGLBuffer | null) => {
    boundBufferByTarget.set(target, buffer)
    return origBindBuffer(target, buffer)
  }

  const origBindRenderbuffer = gl.bindRenderbuffer.bind(gl)
  gl.bindRenderbuffer = (target: number, rb: WebGLRenderbuffer | null) => {
    boundRenderbuffer = rb
    return origBindRenderbuffer(target, rb)
  }

  const origTexImage2D = gl.texImage2D.bind(gl)
  // オーバーロードが多いため引数は unknown[] で受け、実行時に判別する。
  gl.texImage2D = ((...args: unknown[]) => {
    try {
      const target = args[0] as number
      const tex = boundTextureByTarget.get(cubeMapFaceToTarget(gl, target)) ?? null
      if (args.length >= 9) {
        // texImage2D(target, level, internalformat, width, height, border, format, type, pixels)
        const width = args[3] as number
        const height = args[4] as number
        const format = args[6] as number
        const type = args[7] as number
        setTextureSize(tex, width * height * bytesPerPixel(gl, format, type))
      } else if (args.length >= 6) {
        // texImage2D(target, level, internalformat, format, type, source)
        // レビューで確認済み: maplibre-gl v6.0.0 の実呼び出しは全て9引数版のみで、
        // この6引数分岐は現状のMapLibre利用では実行されない（動作未検証のまま残る）。
        const format = args[3] as number
        const type = args[4] as number
        const source = args[5] as { width?: number; height?: number } | null
        const width = source?.width ?? 0
        const height = source?.height ?? 0
        setTextureSize(tex, width * height * bytesPerPixel(gl, format, type))
      }
    } catch {
      // 推定に失敗しても描画自体は継続させる（PoC のため実害より継続性を優先）
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origTexImage2D as any)(...args)
  }) as typeof gl.texImage2D

  const origBufferData = gl.bufferData.bind(gl)
  gl.bufferData = ((...args: unknown[]) => {
    try {
      const target = args[0] as number
      const buf = boundBufferByTarget.get(target) ?? null
      const sizeArg = args[1]
      let bytes = 0
      if (typeof sizeArg === 'number') {
        bytes = sizeArg
      } else if (sizeArg instanceof ArrayBuffer) {
        bytes = sizeArg.byteLength
      } else if (ArrayBuffer.isView(sizeArg)) {
        // WebGL2 の5引数版 bufferData(target, srcData, usage, srcOffset, length) は
        // 未対応（length 未考慮で srcData.byteLength をそのまま使うため、部分アップロード時に
        // 過大評価しうる）。レビューで確認済み: maplibre-gl v6.0.0 の実呼び出しは全て
        // 3引数版のみのため現状は実害なし。将来のバージョンアップで5引数版が使われ始めると
        // 静かに不正確化するリスクがある。
        bytes = sizeArg.byteLength
      }
      setBufferSize(buf, bytes)
    } catch {
      // noop（上記と同じ理由）
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origBufferData as any)(...args)
  }) as typeof gl.bufferData

  const origRenderbufferStorage = gl.renderbufferStorage.bind(gl)
  gl.renderbufferStorage = (target: number, internalformat: number, width: number, height: number) => {
    setRenderbufferSize(boundRenderbuffer, width * height * bytesPerPixelForSizedFormat(gl, internalformat))
    return origRenderbufferStorage(target, internalformat, width, height)
  }

  // MapLibre はタイル・グリフアトラス等の主要テクスチャを texImage2D ではなく
  // texStorage2D（不変ストレージ確保）+ texSubImage2D（データ転送のみ）で確保する
  // （実際に node_modules/maplibre-gl のソースで確認: RGBA8 の texStorage2D 呼び出しが
  // タイル用テクスチャの生成箇所にある）。texImage2D だけをフックすると計測値が
  // 常時ゼロになる（開発機で実際に踏んだ）ため、texStorage2D も同様にフックする。
  const origTexStorage2D = gl.texStorage2D.bind(gl)
  gl.texStorage2D = (
    target: number,
    levels: number,
    internalformat: number,
    width: number,
    height: number,
  ) => {
    const tex = boundTextureByTarget.get(cubeMapFaceToTarget(gl, target)) ?? null
    // ミップレベルは考慮せず level0 サイズのみで近似する（PoC のため十分）。
    setTextureSize(tex, width * height * bytesPerPixelForSizedFormat(gl, internalformat))
    return origTexStorage2D(target, levels, internalformat, width, height)
  }

  const origDeleteTexture = gl.deleteTexture.bind(gl)
  gl.deleteTexture = (tex: WebGLTexture | null) => {
    if (tex) setTextureSize(tex, 0)
    return origDeleteTexture(tex)
  }
  const origDeleteBuffer = gl.deleteBuffer.bind(gl)
  gl.deleteBuffer = (buf: WebGLBuffer | null) => {
    if (buf) setBufferSize(buf, 0)
    return origDeleteBuffer(buf)
  }
  const origDeleteRenderbuffer = gl.deleteRenderbuffer.bind(gl)
  gl.deleteRenderbuffer = (rb: WebGLRenderbuffer | null) => {
    if (rb) setRenderbufferSize(rb, 0)
    return origDeleteRenderbuffer(rb)
  }
}

let installed = false

/** Map インスタンス生成より前に一度だけ呼ぶ。 */
export function installWebglMemoryTracker(): void {
  if (installed) return
  installed = true
  const proto = HTMLCanvasElement.prototype
  // bind(proto) すると this がプロトタイプ自体に固定され、実際の canvas 要素から呼ばれた際に
  // ネイティブ実装が "Illegal invocation" を投げる（実機投入前に開発機で踏んだ）。
  // bind せず元の関数を保持し、呼び出し時の実際の this（本物の canvas 要素）で call する。
  const origGetContext = proto.getContext
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(proto as any).getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (origGetContext as any).call(this, type, ...rest)
    if (ctx && type === 'webgl2') {
      wrapContext(ctx as WebGL2RenderingContext)
    }
    return ctx
  }
}

export function snapshotWebglMemory(): WebglMemorySnapshot {
  return {
    bufferBytes,
    textureBytes,
    renderbufferBytes,
    totalBytes: bufferBytes + textureBytes + renderbufferBytes,
    tracked,
  }
}
