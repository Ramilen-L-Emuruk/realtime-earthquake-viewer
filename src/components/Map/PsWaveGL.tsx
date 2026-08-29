import { useEffect, useRef } from 'react'
import type { CustomLayerInterface } from 'maplibre-gl'
import { applyProjectionUniforms, createProjectionProgramCache } from './gl/projectionProgram'
import { useMapGL } from './mapGLContext'
import type { PsWaveCircle } from '../../services/kyoshin'
import { computeSWaveRadiusAtTime, computeSWaveTravelTimeSec } from '../../hooks/usePsWaveCalc'
import { calcShakingDurationSec } from '../../utils/eew'
import { addOrderedLayer } from './gl/layerOrder'
import { log } from '../../utils/logger'

// 緊急地震速報の予報円（S波=塗りつぶし＋後端フェード / P波=破線外周）を描画する MapLibre 版。
//
// **円は地面に貼り付く。** 単位円のグリッド（角度 × 正規化半径）を静的な頂点バッファに持ち、
// 頂点シェーダーで「その方位へ r×半径 km 進んだ地点」の Mercator 座標を求めてから MapLibre の
// 行列を掛ける。半径は毎フレーム変わるが uniform で渡すだけなので、バッファは作り直さない。
//
// この方式にしている理由は、地図が傾き・回転できるため（docs/spec/map-rendering-spec.md §6）。
// 画面座標で半径を測って真円を描く方式（旧実装）だと、回転で cos(bearing) 倍に縮み（90 度で
// 消える）、傾ければ地面の円と画面の円が一致しなくなる。頂点を地理座標で置けば、傾きも回転も
// MapLibre の行列が面倒を見る。
//
// 描画順は MAP_LAYER_ORDER の pswave スロット（tsunami-lines より前面・観測点よりは背面）。

// 後端フェード（揺れ継続時間を過ぎた領域）の幅パラメータ（Leaflet 版と一致）。
const TRAILING_EDGE_FADE_RATIO = 0.2
const TRAILING_EDGE_FADE_MIN_KM = 15
const LYR = 'pswave'

// 単位円グリッドの分割数。
// 角度方向は円の滑らかさ、半径方向は測地変換の非線形性（頂点間は線形補間される）を吸収する。
const RING_SEGMENTS = 128
const RADIAL_SEGMENTS = 8

// 縁の太さ（CSS px）。Canvas2D 版の lineWidth と揃える。
// **シェーダーへ渡すときは devicePixelRatio を掛ける。** フラグメントシェーダーの `fwidth` は
// フレームバッファの物理ピクセル単位で動くため、そのまま渡すと Hi-DPI 端末で 1/dpr の細さになる
// （旧実装は Canvas2D 側で setTransform(dpr, ...) して吸収していた）。gl/subThresholdLayer.ts と同じ規約。
const STROKE_PX = 2
// P 波の破線の 1 周期あたりの画面長（px）。Canvas2D 版の setLineDash([4,4]) と揃える。
const DASH_PERIOD_PX = 8

const S_FILL: readonly [number, number, number] = [255 / 255, 60 / 255, 0]
const S_FILL_ALPHA = 0.12
const S_STROKE: readonly [number, number, number] = [255 / 255, 60 / 255, 0]
const P_STROKE: readonly [number, number, number] = [56 / 255, 189 / 255, 248 / 255]

// 頂点シェーダーの本体。座標変換は MapLibre が配る投影シェーダーに任せる（gl/projectionProgram.ts）ため、
// `#version` と prelude はプログラム生成側で前置きする。
// **`PI` は prelude が宣言している**ので、ここで宣言し直すと再定義エラーになる。
const VERT_BODY = `
precision highp float;
// x = 角度（0〜1 が一周） / y = 正規化半径（0〜1）
in vec2 a_ring;
uniform vec2 u_center;     // 震央 (経度, 緯度) 度
uniform float u_radiusKm;  // この描画での外周半径
out float v_r;
out float v_theta;

// 緯度 1 度あたりの距離（km）。旧実装の 111320m/度 と揃える。
const float KM_PER_DEG_LAT = 111.32;

// MapLibre の MercatorCoordinate と同じ式（geo/mercator_coordinate.ts）。
vec2 mercator(vec2 lngLat) {
  float x = (180.0 + lngLat.x) / 360.0;
  float y = (180.0 - (180.0 / PI) * log(tan(PI / 4.0 + lngLat.y * PI / 360.0))) / 360.0;
  return vec2(x, y);
}

void main() {
  float theta = a_ring.x * 2.0 * PI;
  float km = a_ring.y * u_radiusKm;
  // 経度方向の 1 度は緯度で縮む。旧実装と同じく**震央の緯度**で割る（円の内部で cos を変えると
  // 大きな円が歪むが、旧実装の見た目を保つことを優先する）。
  float dLat = (km * cos(theta)) / KM_PER_DEG_LAT;
  float dLng = (km * sin(theta)) / (KM_PER_DEG_LAT * cos(radians(u_center.y)));
  v_r = a_ring.y;
  v_theta = a_ring.x;
  gl_Position = projectTile(mercator(u_center + vec2(dLng, dLat)));
}`

/** 属性。**並び順がロケーション番号になる**（gl/projectionProgram.ts）。 */
const RING_ATTRIBS = ['a_ring'] as const

const FRAG_SRC = `#version 300 es
precision highp float;
in float v_r;
in float v_theta;
uniform vec4 u_fill;       // 塗り色（rgb, a）。a=0 なら塗らない
uniform vec4 u_stroke;     // 縁の色（rgb, a）
uniform float u_innerR;    // 後端フェードの開始（正規化半径）
uniform float u_fadeOuterR;// 後端フェードの終端（正規化半径）
uniform float u_strokePx;  // 縁の太さ（px）
uniform float u_dashCount; // 破線の周期数（0 なら実線）
uniform float u_opacity;   // 全体の不透明度
out vec4 fragColor;

void main() {
  // v_r の画面上の勾配。1px あたり v_r がどれだけ変わるかを表すので、px 指定の太さを
  // v_r 空間へ持ち込める。傾けて奥ほど密になっても、縁の太さは画面上で一定に保たれる。
  float grad = fwidth(v_r);

  // 塗り: 内円までは透明、そこからフェード終端まで線形に立ち上げ、以降は一定。
  float fill = 0.0;
  if (u_fill.a > 0.0) {
    float band = max(u_fadeOuterR - u_innerR, 1e-5);
    fill = clamp((v_r - u_innerR) / band, 0.0, 1.0);
    // 外周の外側は塗らない（縁の分だけアンチエイリアスを掛ける）。
    fill *= 1.0 - smoothstep(1.0 - grad, 1.0 + grad, v_r);
    fill *= u_fill.a;
  }

  // 縁: v_r = 1 の等値線を px 幅の帯として描く。
  float halfPx = u_strokePx * grad * 0.5;
  float edge = 1.0 - smoothstep(0.0, halfPx + grad, abs(v_r - 1.0));
  if (u_dashCount > 0.0) {
    // 破線は角度方向の周期で切る。1 周期の半分を描いて半分を空ける。
    edge *= step(fract(v_theta * u_dashCount), 0.5);
  }
  edge *= u_stroke.a;

  // 縁を塗りの上に載せる。edge は縁の被覆率（0〜1）なので、そのまま混色の係数に使う。
  // **塗りの量（fill）を係数へ混ぜないこと。** 分母に入れると over 合成としても正しくならず、
  // 塗り色と縁色を別々にした瞬間に境界へ中間色が滲む（いまは同色なので見えないだけ）。
  vec3 rgb = mix(u_fill.rgb, u_stroke.rgb, edge);
  float a = (fill * (1.0 - edge) + edge) * u_opacity;
  if (a <= 0.0) discard;
  fragColor = vec4(rgb * a, a); // premultiplied
}`

/**
 * 単位円のグリッド（角度 × 正規化半径）を作る。半径が変わっても作り直さない静的バッファ。
 *
 * 頂点は (角度 0〜1, 正規化半径 0〜1)。中心（r=0）は角度の数だけ重複するが、頂点数が
 * 千点規模なので潰さずそのまま持つ（インデックスの組み立てが単純になる）。
 */
function buildRingMesh(): { verts: Float32Array; indices: Uint16Array } {
  const cols = RING_SEGMENTS + 1
  const rows = RADIAL_SEGMENTS + 1
  const verts = new Float32Array(cols * rows * 2)
  let p = 0
  for (let j = 0; j < rows; j++) {
    const r = j / RADIAL_SEGMENTS
    for (let i = 0; i < cols; i++) {
      verts[p++] = i / RING_SEGMENTS
      verts[p++] = r
    }
  }
  const indices = new Uint16Array(RING_SEGMENTS * RADIAL_SEGMENTS * 6)
  let q = 0
  for (let j = 0; j < RADIAL_SEGMENTS; j++) {
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a = j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      indices[q++] = a; indices[q++] = c; indices[q++] = b
      indices[q++] = b; indices[q++] = c; indices[q++] = d
    }
  }
  return { verts, indices }
}

interface Props {
  psWave: PsWaveCircle[]
  /** リアルタイム震度モードのとき不透明、それ以外は半透明（EEW 震源×印と同じ扱い）。 */
  fullOpacity: boolean
}

export function PsWaveGL({ psWave, fullOpacity }: Props) {
  const map = useMapGL()
  const psWaveRef = useRef<PsWaveCircle[]>(psWave)
  const fullOpacityRef = useRef(fullOpacity)
  const triggerRef = useRef<(() => void) | null>(null)
  psWaveRef.current = psWave
  fullOpacityRef.current = fullOpacity

  useEffect(() => {
    if (!map) return

    // 投影ごとにプログラムを持つ（globe と Mercator を行き来する）。**リンクに失敗したら
    // 描かない**——未リンクのプログラムで `useProgram` すると、直前の別レイヤーのシェーダーが
    // 残ったまま描画が走る（キャッシュ側が null を返して防いでいる）。
    const cache = createProjectionProgramCache({
      label: 'PsWaveGL',
      makeVertexSource: (prelude, define) => `#version 300 es
${prelude}
${define}
${VERT_BODY}`,
      fragmentSource: FRAG_SRC,
      attributes: RING_ATTRIBS,
      uniforms: [
        'u_center', 'u_radiusKm', 'u_fill', 'u_stroke',
        'u_innerR', 'u_fadeOuterR', 'u_strokePx', 'u_dashCount', 'u_opacity',
      ] as const,
    })
    let vao: WebGLVertexArrayObject | null = null
    let vbo: WebGLBuffer | null = null
    let ibo: WebGLBuffer | null = null
    let indexCount = 0

    /**
     * 破線の周期数。画面上の 1 周期を DASH_PERIOD_PX に近づけるため、円周の画面長から求める。
     *
     * 傾けると円周上の px 密度は場所によって変わるので、**震央から東へ半径ぶん進んだ点**で
     * 代表させる（旧実装が半径 px を測っていたのと同じ点）。厳密な等長にはならないが、
     * 破線の見た目を保つには足りる。
     */
    const dashCountFor = (lng: number, lat: number, radiusKm: number): number => {
      const cosLat = Math.cos((lat * Math.PI) / 180)
      const center = map.project([lng, lat])
      const edge = map.project([lng + (radiusKm * 1000) / (111320 * cosLat), lat])
      const rPx = Math.hypot(edge.x - center.x, edge.y - center.y)
      // **`Math.max` は NaN を素通しする。** 投影が有限値を返さない位置（極域など）で
      // `rPx` が NaN になると下限 4 が効かず、`u_dashCount` へ NaN が渡って破線が壊れる。
      if (!Number.isFinite(rPx)) return 4
      return Math.max(4, Math.round((2 * Math.PI * rPx) / DASH_PERIOD_PX))
    }

    const customLayer: CustomLayerInterface = {
      id: LYR,
      type: 'custom',
      renderingMode: '2d',
      onAdd(_m, gl2) {
        const gl = gl2 as WebGL2RenderingContext
        // **プログラムはここでは作らない。** どの投影のシェーダーが要るかは render の引数で
        // 初めて分かるうえ、途中で切り替わる。属性の番号は固定してあるので VAO は 1 つで足りる。
        const { verts, indices } = buildRingMesh()
        indexCount = indices.length
        vao = gl.createVertexArray()
        gl.bindVertexArray(vao)
        vbo = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW)
        const loc = RING_ATTRIBS.indexOf('a_ring')
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
        ibo = gl.createBuffer()
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
        gl.bindVertexArray(null)
      },
      render(gl2, args) {
        const gl = gl2 as WebGL2RenderingContext
        if (!vao) return
        const circles = psWaveRef.current
        if (circles.length === 0) return
        const prog = cache.get(gl, args)
        if (!prog) return
        const u = prog.u

        gl.useProgram(prog.program)
        gl.bindVertexArray(vao)
        gl.enable(gl.BLEND)
        // premultiplied alpha（フラグメントで rgb に a を掛けている）。
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        applyProjectionUniforms(gl, u, args)
        const dpr = window.devicePixelRatio || 1
        gl.uniform1f(u.u_strokePx, STROKE_PX * dpr)
        const opacity = fullOpacityRef.current ? 1 : 0.4
        gl.uniform1f(u.u_opacity, opacity)

        for (const c of circles) {
          gl.uniform2f(u.u_center, c.lng, c.lat)

          if (c.sRadius > 0) {
            const durationSec = calcShakingDurationSec(c.magnitude, c.sRadius)
            const tNow = computeSWaveTravelTimeSec(c.sRadius, c.depth)
            const tTrailing = tNow - durationSec
            const sInnerKm = tTrailing > 0 ? computeSWaveRadiusAtTime(tTrailing, c.depth) : 0
            const fadeWidthKm = Math.max(TRAILING_EDGE_FADE_MIN_KM, c.sRadius * TRAILING_EDGE_FADE_RATIO)
            const innerR = sInnerKm > 0 && sInnerKm < c.sRadius ? sInnerKm / c.sRadius : 0
            const fadeOuterR = innerR > 0 ? Math.min((sInnerKm + fadeWidthKm) / c.sRadius, 1) : 0

            gl.uniform1f(u.u_radiusKm, c.sRadius)
            gl.uniform4f(u.u_fill, S_FILL[0], S_FILL[1], S_FILL[2], S_FILL_ALPHA)
            gl.uniform4f(u.u_stroke, S_STROKE[0], S_STROKE[1], S_STROKE[2], 1)
            gl.uniform1f(u.u_innerR, innerR)
            gl.uniform1f(u.u_fadeOuterR, fadeOuterR)
            gl.uniform1f(u.u_dashCount, 0)
            gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0)
          }

          if (c.pRadius > 0) {
            gl.uniform1f(u.u_radiusKm, c.pRadius)
            gl.uniform4f(u.u_fill, 0, 0, 0, 0)
            gl.uniform4f(u.u_stroke, P_STROKE[0], P_STROKE[1], P_STROKE[2], 1)
            gl.uniform1f(u.u_innerR, 0)
            gl.uniform1f(u.u_fadeOuterR, 0)
            gl.uniform1f(u.u_dashCount, dashCountFor(c.lng, c.lat, c.pRadius))
            gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0)
          }
        }

        gl.bindVertexArray(null)
        gl.disable(gl.BLEND)
      },
      onRemove(_m, gl2) {
        const gl = gl2 as WebGL2RenderingContext
        cache.dispose(gl)
        if (vbo) gl.deleteBuffer(vbo)
        if (ibo) gl.deleteBuffer(ibo)
        if (vao) gl.deleteVertexArray(vao)
        vbo = null
        ibo = null
        vao = null
      },
    }


    addOrderedLayer(map, customLayer)
    const requestRepaint = () => map.triggerRepaint()
    triggerRef.current = requestRepaint
    map.on('move', requestRepaint)
    map.on('resize', requestRepaint)
    // MAP-1: WebGL context lost/restored 時に MapLibre は custom layer を復元しない
    // （公式コードが console.warn で明示）ため、restore で手動再追加する。
    // customLayer は同一オブジェクトを再利用し、onAdd の中で新しい gl コンテキストから
    // program/buffer/VAO 参照を作り直す（onAdd は addLayer 内部で再度呼ばれる）。
    //
    // 重要（v6 タイミング設計）: `_contextRestored` は `setStyle(..., {diff:false})` を呼んだ直後、
    // 同じ同期実行内で `webglcontextrestored` を発火する。この時点で新 Style は `_loaded=false` のため、
    // ここで即 addLayer すると `_checkLoaded` が `Error: Style is not done loading.` を投げる。
    // さらに `Evented.fire` はリスナー単位で try/catch しないため、例外が後続リスナーを止める。
    // → `map.isStyleLoaded()` が false の間は `map.once('style.load', ...)` で待ってから追加し、
    //    各コンポーネントが try/catch で例外を隔離する。
    const readdLayer = () => {
      try {
        if (!map.getLayer(LYR)) addOrderedLayer(map, customLayer)
        requestRepaint()
      } catch (err) {
        log.error('[PsWaveGL] custom layer re-add failed', err)
      }
    }
    const onRestored = () => {
      log.warn('[PsWaveGL] WebGL context restored, re-adding custom layer')
      if (map.isStyleLoaded()) readdLayer()
      else map.once('style.load', readdLayer)
    }
    map.on('webglcontextrestored', onRestored)
    requestRepaint()

    return () => {
      map.off('move', requestRepaint)
      map.off('resize', requestRepaint)
      map.off('webglcontextrestored', onRestored)
      // 登録されていない fn への off は no-op のため、常に呼んで cleanup を対称にする。
      map.off('style.load', readdLayer)
      triggerRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
    }
  }, [map])

  // データ更新時にも再描画をリクエスト（CustomLayer の render は camera 変化時にしか
  // 自動で呼ばれないため、triggerRepaint で明示的に次フレームの描画を予約する）。
  useEffect(() => {
    triggerRef.current?.()
  }, [psWave, fullOpacity])

  return null
}
