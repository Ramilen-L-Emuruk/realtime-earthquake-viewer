import * as maplibregl from 'maplibre-gl'
import type { OrderedCustomLayer } from './layerOrder'
import { applyProjectionUniforms, createProjectionProgramCache } from './projectionProgram'
import { guardRender } from './guardRender'
import { clearRenderFailure, clearRenderFailuresFor, reportRenderFailure } from '../../../utils/renderHealth'
import { log, createLogThrottle } from '../../../utils/logger'
import { profileSpan } from '../../../utils/frameProfiler'
import {
  rasterizeEstimatedIntensity,
  buildEstimatedIntensityMesh,
  SI_RANGE,
  type EstimatedIntensityRaster,
} from './estimatedIntensityRaster'
import type { JMAEstimatedIntensity } from '../../../types/earthquake'

// 気象庁の推計震度分布図（IXAC41）を面として描く MapLibre カスタムレイヤー。
//
// **テクスチャを地理座標へ固定して貼る。** 電文を受け取ったときに一度だけ焼き、以後は
// 地図がどう動いても同じテクスチャを貼り直すだけ。**画面の解像度で常に正しく描かれる**ので、
// 手で拡縮しても回しても傾けても、自動フィットで飛んでいる最中もぼけない。
//
// 以前は canvas source（`type: 'canvas'` のラスタ）へ視野ぶんだけ焼いていた。あの作りには
// 2 つの限界があった。
//
// - **移動が終わるまで描き直せない。** 焼くのに数十 ms かかるので毎フレームは走れず、
//   `moveend` まで前の視野の画像を引き伸ばすことになる（飛行中ずっとぼける）
// - **焼いた解像度で頭打ちになる。** 短辺 512px 固定だったので、着地した後も画面へ
//   2 倍以上に拡大して貼られていた
//
// 色付けをシェーダーへ移した理由と、メッシュを細かく割る理由は
// `gl/estimatedIntensityRaster.ts` の冒頭に書いてある。
//
// **仕様書は docs/spec/map-rendering-spec.md §19（描き方）と quake-spec.md §9（出す条件）。**

const LYR = 'quake-estimated-intensity'
const LABEL = '推計震度分布図'

/** 面の濃さ。観測点バッジと地形が透けて見える程度（自前の面と揃える）。 */
const SURFACE_OPACITY = 0.62

/**
 * テクスチャ 1 辺の上限（自前の値）。実際には GPU の `MAX_TEXTURE_SIZE` との小さいほうを使う。
 *
 * 250m メッシュなので、4096 は 1000km 四方あまりを 1 セル 1 画素で覆える。これを超える広さの
 * 分布は縮めて焼くが、**そこまで引いた画ではメッシュ 1 つが 1 画素にも満たない**ので、
 * 細かさが失われても画面には現れない。RG8 で 4096² は 33MB。
 */
const MAX_TEXTURE_PX = 4096

/** 異常の記録を間引く間隔。 */
const ANOMALY_LOG_INTERVAL_MS = 30_000

/**
 * 描けなかった理由。**記録（ログ）を間引く単位としてだけ使う。**
 *
 * **画面へ出すかどうかの判定には使わない。** そちらは「結果」から決める（`syncHealth`）——
 * 理由ごとの状態を持つと、経路が増えるたびに更新漏れができる。実際にレビューで 3 度、
 * 別々の経路で同じ型の穴が見つかった（GL リソースの失敗・投影シェーダーの失敗・焼き込みの
 * 途中の例外。いずれも「描けていないのに状態が正常のまま」だった）。
 */
type AnomalyKind =
  /** GL のリソース（テクスチャ・バッファ）を作れなかった。 */
  | 'gl-resources'
  /** 投影シェーダーを用意できなかった。 */
  | 'no-program'
  /** セルが無い、または範囲が退化している（電文の読み取りが防いでいるはずの状態）。 */
  | 'degenerate-data'
  /** セルはあるが、いずれも計測震度 0 で塗る対象が無い。 */
  | 'no-cell-drawn'
  /** 焼けているのに、凡例に当たる値が 1 画素も無い。 */
  | 'no-legend-hit'
  /** 焼き込みの途中で例外が出た（GL の転送・ラスタ化のどちらも）。 */
  | 'bake-error'

function createAnomalyLog(): (kind: AnomalyKind, emit: () => void) => void {
  // **間引きは種別ごとに独立させる**（1 個を共有すると最初の理由が残りを隠す）。
  const throttles = new Map<AnomalyKind, (emit: () => void) => void>()
  return (kind, emit) => {
    let t = throttles.get(kind)
    if (!t) {
      t = createLogThrottle(ANOMALY_LOG_INTERVAL_MS)
      throttles.set(kind, t)
    }
    t(emit)
  }
}

// 頂点シェーダーの本体。座標変換は MapLibre が配る投影シェーダーへ任せる
// （`gl/projectionProgram.ts`）ため、`#version` と prelude はプログラム生成側が前置きする。
const VS_BODY = `
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = projectTile(a_pos);
}`

/** 属性名。**並び順がそのままロケーション番号になる。** */
const ATTRIBS = ['a_pos', 'a_uv'] as const

// フラグメントシェーダー。**値を補間してから階級へ写す**のがこのレイヤーの要点。
//
// - `u_value` は線形補間で引く（メッシュの矩形が立たない）
// - `u_legend` は最近傍で引く（階級の境目が混ざらない）
//
// **`highp` を明示する。** `mediump` は相対精度が 2^-10 ほどしかなく、計測震度へ戻すために
// 255 を掛ける時点で階級 1 段ぶんに届く誤差が乗りうる。
const FS = `#version 300 es
precision highp float;
uniform sampler2D u_value;
uniform sampler2D u_legend;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2 s = texture(u_value, v_uv).rg;
  // セルが無いところ。縁は半セル外側で切れる（G を線形補間しているため）。
  if (s.g < 0.5) discard;
  float si = s.r * 255.0;
  // 場は 7 ビットなので 128 以上は現れない。壊れた値を CLAMP_TO_EDGE で
  // 最上位の階級として描かないよう弾く。
  if (si > 127.5) discard;
  // 画素の中心を指す。最近傍で引くので、ここが階級への写し（四捨五入）も兼ねる。
  vec4 c = texture(u_legend, vec2((si + 0.5) / ${SI_RANGE}.0, 0.5));
  // 凡例のどの範囲にも入らない計測震度（震度4未満）は塗らない。
  if (c.a < 0.5) discard;
  fragColor = vec4(c.rgb * u_opacity, u_opacity);
}`

export interface EstimatedIntensityLayer {
  /** MapLibre へ addLayer する custom レイヤー本体。 */
  layer: OrderedCustomLayer
  /**
   * 描く分布を差し替える。**焼き直しは次の描画で行う**（GL の文脈はそのときしか触れない）。
   * 反映には呼び出し側の `triggerRepaint` が必要。
   */
  setData(data: JMAEstimatedIntensity | null): void
  /**
   * 表示/非表示。custom レイヤーは style spec の `visibility` を持たないため、
   * `render()` の冒頭でこのフラグを見る自前実装で代替する。
   */
  setVisible(visible: boolean): void
}

export function makeEstimatedIntensityLayer(): EstimatedIntensityLayer {
  const anomalyLog = createAnomalyLog()

  let data: JMAEstimatedIntensity | null = null
  /** 次の描画で焼き直すか。文脈を失って `onAdd` が再度走ったときも立てる。 */
  let dirty = false
  let raster: EstimatedIntensityRaster | null = null
  let visible = false
  let indexCount = 0

  /** いま画面へ出しているか。同じ内容を毎フレーム報告し直さないための覚え。 */
  let brokenReported = false

  /**
   * 「描けていない」を**結果から**判定して、画面への報告を合わせる。
   *
   * **理由ごとの状態を持たない。** `raster` は焼き込みが最後まで通ったときだけ立つので、
   * **どの経路で失敗しても null のまま**——GL リソースを作れなかった・投影シェーダーが
   * 無い・セルが無い・凡例に当たらない・途中で例外が出た、のどれでも同じように拾える。
   * 理由ごとにフラグを持つ作りでは、経路を足すたびに更新漏れができた。
   *
   * **「描くものが無い」は不調ではない。** 分布をまだ受け取っていない状態は正常なので、
   * バナーにも出さない。
   *
   * **取り下げは `clearRenderFailure`（自分の鍵だけ）を使う。** まとめて消す版
   * （`clearRenderFailuresFor`）は `gl/guardRender.ts` が別の鍵で持つ例外の記録まで
   * 巻き込み、あちらは消されたことに気づけないまま「報告済み」を覚え続ける
   * （`utils/renderHealth.ts`）。使うのは画面から外すときだけ。
   *
   * @param hasProgram 投影シェーダーを用意できたか（`render` の中でしか判らない）
   */
  const syncHealth = (hasProgram: boolean): void => {
    const want = visible && data !== null && (!hasProgram || raster === null)
    if (want === brokenReported) return
    brokenReported = want
    if (want) reportRenderFailure(LYR, LABEL, 'draw')
    else clearRenderFailure(LYR, 'draw')
  }

  /**
   * 描けなかった理由を記録に残す。**画面へ出すかどうかはここでは決めない**
   * （`syncHealth` が結果から決める）。記録は種別ごとに間引く。
   */
  const note = (kind: AnomalyKind, reason: string): void => {
    anomalyLog(kind, () => log.warn(`[map] 推計震度分布図を描けなかった: ${reason}`))
  }

  let maxTextureSize = MAX_TEXTURE_PX
  let valueTex: WebGLTexture | null = null
  let legendTex: WebGLTexture | null = null
  let posBuf: WebGLBuffer | null = null
  let uvBuf: WebGLBuffer | null = null
  let idxBuf: WebGLBuffer | null = null

  /** 属性は番号を固定してあるので、投影が切り替わっても設定は変わらない。 */
  const aPos = ATTRIBS.indexOf('a_pos')
  const aUv = ATTRIBS.indexOf('a_uv')

  const programCache = createProjectionProgramCache({
    label: 'estimated-intensity',
    makeVertexSource: (prelude, define) => `#version 300 es
${prelude}
${define}
${VS_BODY}`,
    fragmentSource: FS,
    attributes: ATTRIBS,
    uniforms: ['u_value', 'u_legend', 'u_opacity'] as const,
  })

  /**
   * 確保した GL リソースを解放する。**一部だけ作れて諦めるときにも通す**——
   * 参照を捨ててから作り直すと、作れていた分が GPU 側に残る。
   */
  const releaseGl = (gl: WebGL2RenderingContext): void => {
    if (valueTex) gl.deleteTexture(valueTex)
    if (legendTex) gl.deleteTexture(legendTex)
    if (posBuf) gl.deleteBuffer(posBuf)
    if (uvBuf) gl.deleteBuffer(uvBuf)
    if (idxBuf) gl.deleteBuffer(idxBuf)
    valueTex = null
    legendTex = null
    posBuf = null
    uvBuf = null
    idxBuf = null
    raster = null
    indexCount = 0
  }

  /** 焼いた結果を GL へ載せる。載せるものが無ければ `raster` を null にして描画を止める。 */
  const upload = (gl: WebGL2RenderingContext): void => {
    raster = null
    indexCount = 0
    if (!data) {
      // 分布を持っていないだけ。**正常な状態なので画面へは出さない**（`syncHealth`）。
      return
    }
    if (!valueTex || !legendTex || !posBuf || !uvBuf || !idxBuf) {
      // `onAdd` が作れていない。そちらでも記録するが、文脈を失った直後など
      // ここへ先に来る経路があるので両方で見る。
      note('gl-resources', 'GL のテクスチャ・バッファが用意できていない')
      return
    }

    const baked = profileSpan('gl:estimated-intensity-bake', () =>
      rasterizeEstimatedIntensity(data as JMAEstimatedIntensity, Math.min(MAX_TEXTURE_PX, maxTextureSize)),
    )
    if (!baked) {
      // 電文の読み取りが 0 セルを弾いているので、ここへ来ること自体が異常。
      note('degenerate-data', 'セルが無い、または範囲が退化している')
      return
    }
    if (baked.painted === 0) {
      note('no-cell-drawn', `セル ${data.count} 件がいずれも計測震度 0 だった`)
      return
    }
    if (baked.colored === 0) {
      // セルは焼けているのに 1 画素も色が付かない＝凡例とセルの値が噛み合っていない。
      // 全面が透明になるので、黙って「表示中」を名乗らせない。
      note(
        'no-legend-hit',
        `${baked.painted} 画素あるが、凡例（${data.grades.length} 段）に当たる値が無い`,
      )
      return
    }
    if (baked.scaled) {
      log.debug(
        `[map] 推計震度分布図: 上限 ${Math.min(MAX_TEXTURE_PX, maxTextureSize)}px に収めるため ${baked.width}x${baked.height} へ縮めた`,
      )
    }

    // **1 画素 2 バイトの値テクスチャは、行の詰め方を 1 バイト境界へ直してから渡す。**
    // WebGL の既定（`UNPACK_ALIGNMENT` = 4）では 1 行が 4 バイトの倍数になっていることを
    // 要求されるので、**幅が奇数だと「渡された配列が足りない」として転送ごと拒否される**
    // （実測: 3x3 と 57x40 が `INVALID_OPERATION`、58x40 は通る。高さ 1 は末尾行に詰め物が
    // 要らないため通る）。拒否は**例外ではなく GL 内部のエラー**なので `try`/`catch` にも
    // `gl/guardRender.ts` にも掛からず、焼き込みは成功した顔で終わる —— 初回なら何も描かれず、
    // 2 回目以降なら**前の地震の分布が地図に残り続ける**。
    //
    // 幅の偶奇は分布の広がりで決まるので、どの地震で起きるかは分布ごとに変わる。
    //
    // 凡例（RGBA8）は 1 画素 4 バイトなのでどの境界でも通るが、同じ区間で転送するため
    // 一緒に囲ってある。**値は元へ戻す**——MapLibre 自身や他のレイヤーの転送が、
    // ここで変えた値を前提にしていない形にする（`CustomLayerInterface` の作法）。
    const prevUnpackAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    try {
      gl.bindTexture(gl.TEXTURE_2D, valueTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, baked.width, baked.height, 0, gl.RG, gl.UNSIGNED_BYTE, baked.pixels)
      gl.bindTexture(gl.TEXTURE_2D, legendTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SI_RANGE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, baked.legend)
    } finally {
      // 途中で例外が出ても戻す（戻し忘れると、以後この文脈の全レイヤーが 1 バイト境界で動く）。
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevUnpackAlignment)
      gl.bindTexture(gl.TEXTURE_2D, null)
    }

    const mesh = buildEstimatedIntensityMesh(baked)
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    raster = baked
    indexCount = mesh.indices.length
  }

  const layer: OrderedCustomLayer = {
    id: LYR,
    type: 'custom',
    onAdd(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
      // 文脈を作り直した場合もここを通る。焼いたものは失われているので次の描画で焼き直す。
      // **リソースを作る前に立てる** —— 途中で諦めても、次の描画が結果（`raster === null`）
      // から不調を拾えるようにしておく。
      dirty = true
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
      valueTex = gl.createTexture()
      legendTex = gl.createTexture()
      posBuf = gl.createBuffer()
      uvBuf = gl.createBuffer()
      idxBuf = gl.createBuffer()
      if (!valueTex || !legendTex || !posBuf || !uvBuf || !idxBuf) {
        // **WebGL の生成関数は失敗しても例外を投げず null を返す**（文脈を失っているとき等）。
        // 黙って進むと、以後どの経路でも何も描かないまま痕跡が残らない。
        releaseGl(gl)
        note('gl-resources', 'GL のテクスチャ・バッファを作成できなかった')
        return
      }
      // 値は線形補間で引く（メッシュの矩形を立てない）。
      gl.bindTexture(gl.TEXTURE_2D, valueTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      // 凡例は最近傍。**補間すると階級の境目が混ざる**（このレイヤーの要点が消える）。
      gl.bindTexture(gl.TEXTURE_2D, legendTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindTexture(gl.TEXTURE_2D, null)
    },
    render: guardRender(LYR, LABEL, (gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput) => {
      // **隠している間は画面から取り下げる**（docs/spec/map-rendering-spec.md §16）。
      // 表示へ戻せば、次の描画が結果から判定し直して報告する。
      if (!visible) {
        syncHealth(true)
        return
      }
      const prog = programCache.get(gl, args)
      if (!prog) {
        // **シェーダーを作れなかったことは画面にも出す。** `programCache` は記録を
        // `console` へ出すだけで、失敗を覚えて二度と作り直さない（そこは意図した設計）。
        // ここで黙ると、件数だけが正しく出たまま地図が空になる。
        //
        // 投影が切り替わって作り直せたら、次の描画でそのまま解ける（状態を持たない）。
        note('no-program', '投影シェーダーを用意できない')
        syncHealth(false)
        return
      }
      if (dirty) {
        // **先に消費する。** `upload` が投げたときに毎フレーム焼き直しへ入るのを防ぐ。
        // 次に分布が変わるまで再試行しない。
        dirty = false
        try {
          upload(gl)
        } catch (e) {
          // 画面へ出すかどうかは `syncHealth` が結果から決める——`upload` は途中で
          // 抜けても `raster` を null のままにするので、例外でも「描けていない」に映る。
          // ここで残すのは理由の記録だけ。
          note('bake-error', `焼き込みの途中で例外が出た: ${String(e)}`)
          log.error('[map] 推計震度分布図の焼き込みで例外', e)
          // `upload` の途中で抜けたので、掴んだままのものを外す（この後の描画は
          // `raster` が null で早期 return するが、他のレイヤーへ持ち越さない）。
          gl.bindTexture(gl.TEXTURE_2D, null)
          gl.bindBuffer(gl.ARRAY_BUFFER, null)
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
        }
      }
      syncHealth(true)
      if (!raster || indexCount === 0 || !valueTex || !legendTex) return

      gl.useProgram(prog.program)
      applyProjectionUniforms(gl, prog.u, args)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, valueTex)
      gl.uniform1i(prog.u.u_value, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, legendTex)
      gl.uniform1i(prog.u.u_legend, 1)
      gl.uniform1f(prog.u.u_opacity, SURFACE_OPACITY)

      gl.enable(gl.BLEND)
      // 出力を不透明度で掛けてあるので premultiplied over。
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
      gl.enableVertexAttribArray(aUv)
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0)

      // GL 状態を復元（CustomLayerInterface の作法）。
      gl.disableVertexAttribArray(aPos)
      gl.disableVertexAttribArray(aUv)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.disable(gl.BLEND)
    }),
    onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
      // **画面から外れたら不調の記録も消す**（docs/spec/map-rendering-spec.md §16）。
      // ここだけは**まとめて消す版**を使う——`gl/guardRender.ts` が別の鍵で持つ例外の
      // 記録は、外した後は `render()` が呼ばれないのであちらに消す機会が無い。
      brokenReported = false
      clearRenderFailuresFor(LYR)
      programCache.dispose(gl)
      releaseGl(gl)
    },
  }

  return {
    layer,
    setData(next: JMAEstimatedIntensity | null): void {
      if (data === next) return
      data = next
      dirty = true
    },
    setVisible(v: boolean): void {
      if (visible === v) return
      visible = v
      // **ここでは画面へ出さない。** 判定の材料（焼き込みの成否・投影シェーダー）は
      // 描画の中でしか揃わないため、呼び出し側の `triggerRepaint` で走る次の
      // `render()` に任せる。
    },
  }
}
