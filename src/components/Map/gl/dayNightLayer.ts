import * as maplibregl from 'maplibre-gl'
import { applyProjectionUniforms, createProjectionProgramCache } from './projectionProgram'
import { buildDayNightGrid, FLOATS_PER_VERTEX } from './dayNightGrid'
import { shadingDepthGlsl } from '../../../utils/solarShading'
import { guardRender } from './guardRender'
import { clearRenderFailure, reportRenderFailure } from '../../../utils/renderHealth'
import { log } from '../../../utils/logger'

// 夜の側を 1 枚の面として描く MapLibre カスタムレイヤー。
//
// **濃さは画素ごとに太陽高度から求める。** 全球を覆う固定の格子（gl/dayNightGrid.ts）を描き、
// 頂点が運ぶ経度緯度をフラグメントへ渡して、そこで太陽高度 → 濃さを計算する。太陽の位置は
// uniform なので、**時刻が進んでも作り直すものが何も無い**。
//
// 以前は太陽高度を 32 段に刻んだ帯を GeoJSON で作り、fill レイヤーで塗っていた。段を細かくしても
// 滑らかにはならず（律速は帯の幅ではなく出力色の 8bit 量子化）、面を作り直すたびに GeoJSON を
// ワーカーへ渡してタイル化する分だけフレームが飛んでいた（32 段で 22ms・128 段で 131ms の実測）。
// 段という刻みをやめたことで、その両方が消えている。
//
// 残る段差は 8bit 量子化そのものなので、**順序ディザで散らす**（下記 `DITHER_AMPLITUDE`）。

/**
 * レイヤー ID。
 *
 * **React 側も使う** —— レイヤーを載せられなかったことを知らせるのは、載せる側にしかできない
 * （載らなければ `render()` は一度も呼ばれず、下記の検出に永久に届かない）。
 */
export const DAY_NIGHT_LAYER_ID = 'day-night'
/** 描画の不調を知らせるときの表示名（`utils/renderHealth.ts`）。 */
export const DAY_NIGHT_LAYER_LABEL = '昼夜の境目'
const LYR = DAY_NIGHT_LAYER_ID
const LABEL = DAY_NIGHT_LAYER_LABEL

/** 夜の色。純黒だと地図が沈むので、わずかに青へ寄せる。 */
const NIGHT_COLOR: [number, number, number] = [10 / 255, 16 / 255, 36 / 255]

/**
 * ディザの振幅（不透明度に加える揺らぎの幅）。
 *
 * 濃さが連続でも、GPU が合成した結果は 8bit へ丸められるため、わずかな段（バンド）が残る。
 * 結果色で 1 段ぶん揺らすのに必要な不透明度の幅は `1 / |背景色 - 夜色|` で、背景が明るいほど
 * 小さくて済む。**効かせたいのは背景差が大きいところ**（明るい海の上が最も目立つ）なので、
 * そこで 1 段ぶんになる値を採る。大きすぎると今度はディザ自体がノイズとして見える。
 *
 * 値は実測で決めた（`docs/spec/map-rendering-spec.md` §18「残る段差はディザで散らす」）。
 */
const DITHER_AMPLITUDE = 1 / 96

const VERT_BODY = `
in vec2 a_pos;
in vec2 a_lonlat;
out vec2 v_lonlat;
void main() {
  v_lonlat = a_lonlat;
  gl_Position = projectTile(a_pos);
}`

/** 属性。**並び順がそのままロケーション番号になる**（gl/projectionProgram.ts）。 */
const ATTRIBS = ['a_pos', 'a_lonlat'] as const

// 4x4 の順序ディザ（Bayer）。乱数と違って画面に固定されるので、止まった絵がちらつかない。
const FRAG = `#version 300 es
precision highp float;
uniform float u_sinSunLat;
uniform float u_cosSunLat;
uniform float u_sunLonRad;
uniform float u_nightOpacity;
uniform vec3 u_color;
uniform float u_dither;
in vec2 v_lonlat;
out vec4 fragColor;

${shadingDepthGlsl()}

const float BAYER4[16] = float[16](
  0.0,  8.0,  2.0, 10.0,
 12.0,  4.0, 14.0,  6.0,
  3.0, 11.0,  1.0,  9.0,
 15.0,  7.0, 13.0,  5.0
);

float ditherOffset() {
  ivec2 p = ivec2(gl_FragCoord.xy) & 3;
  return (BAYER4[p.y * 4 + p.x] + 0.5) / 16.0 - 0.5;
}

void main() {
  float lat = radians(v_lonlat.y);
  float lon = radians(v_lonlat.x);
  // 太陽直下点からの角距離。その余角が太陽高度。
  float cosZenith = sin(lat) * u_sinSunLat + cos(lat) * u_cosSunLat * cos(lon - u_sunLonRad);
  float altitudeDeg = 90.0 - degrees(acos(clamp(cosZenith, -1.0, 1.0)));
  float depth = shadingDepth(altitudeDeg);
  float alpha = 1.0 - pow(1.0 - u_nightOpacity, depth);
  // 昼側は完全に透明。ディザを掛ける前に抜くことで、昼側へ点が散らない。
  if (alpha <= 0.0) discard;
  alpha = clamp(alpha + ditherOffset() * u_dither, 0.0, 1.0);
  fragColor = vec4(u_color * alpha, alpha);
}`

export interface DayNightLayer {
  /** MapLibre へ addLayer する custom レイヤー本体。 */
  layer: maplibregl.CustomLayerInterface
  /**
   * 太陽の位置を時刻から決め直す。**描き直しは呼び出し側の `triggerRepaint`**。
   *
   * 有限でない時刻では何も変えず `false` を返す（直前の絵が残る）。そのまま渡すと濃さが NaN に
   * なり、画面上は設定でオフにしたのと見分けが付かなくなる。**記録を残すのは呼び出し側**
   * （毎秒呼ばれる場所なので、間引きはそちらの持ち物）。
   */
  setTime(epochMs: number): boolean
  /** 夜が深まりきったところの濃さ（設定「夜側の濃さ」）。 */
  setNightOpacity(opacity: number): void
  /**
   * 表示/非表示。custom レイヤーは style spec の `visibility` を持たないため、`render()` の冒頭で
   * このフラグを見て早期リターンする。
   */
  setVisible(visible: boolean): void
}

/** 太陽直下点の緯度経度（度）から、シェーダーへ渡す値を作る。 */
function sunUniforms(latDeg: number, lonDeg: number) {
  const lat = (latDeg * Math.PI) / 180
  return { sinLat: Math.sin(lat), cosLat: Math.cos(lat), lonRad: (lonDeg * Math.PI) / 180 }
}

export function makeDayNightLayer(
  subsolarPointOf: (epochMs: number) => { lat: number; lon: number },
  initialTimeMs: number,
  initialOpacity: number,
): DayNightLayer {
  const grid = buildDayNightGrid()
  let visible = true
  let nightOpacity = initialOpacity
  let sun = sunUniforms(0, 0)

  const cache = createProjectionProgramCache({
    label: 'day-night',
    makeVertexSource: (prelude, define) => `#version 300 es
${prelude}
${define}
${VERT_BODY}`,
    fragmentSource: FRAG,
    attributes: ATTRIBS,
    uniforms: ['u_sinSunLat', 'u_cosSunLat', 'u_sunLonRad', 'u_nightOpacity', 'u_color', 'u_dither'] as const,
  })

  let vertexBuf: WebGLBuffer
  let indexBuf: WebGLBuffer
  /** 画面へ「描けていない」と出している状態か。直ったら取り下げるために持つ。 */
  let brokenReported = false
  /** シェーダーを用意できない旨をログへ残したか（毎フレーム通るので 1 度だけ）。 */
  let warnedDisabled = false
  const aPos = ATTRIBS.indexOf('a_pos')
  const aLonLat = ATTRIBS.indexOf('a_lonlat')

  const applyTime = (epochMs: number): boolean => {
    if (!Number.isFinite(epochMs)) {
      // **周期経路はここへ来ない**（呼び出し側が先に弾き、間引いて記録する）。通るのはレイヤーを
      // 作るときの 1 回だけなので、ここで残さないと太陽の位置が初期値のまま据え置かれたことが
      // どこにも出ない。
      log.warn('[day-night] 時刻が有限でないため太陽の位置を決められません', epochMs)
      return false
    }
    const point = subsolarPointOf(epochMs)
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      // 有限な時刻から有限でない位置が出るのは想定外なので、こちらは間引かずに残す。
      log.error('[day-night] 太陽の位置を計算できません', point)
      return false
    }
    sun = sunUniforms(point.lat, point.lon)
    return true
  }
  applyTime(initialTimeMs)

  const layer: maplibregl.CustomLayerInterface = {
    id: LYR,
    type: 'custom',
    onAdd(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
      // **載せ直しに備えてプログラムを捨てる。** WebGL の文脈が失われると前のプログラムは
      // 無効になるが、キャッシュは「作った」ことだけを覚えているのでそのまま返してしまう
      // （無効なプログラムへの `useProgram` は例外を投げない）。ここで捨てれば次の描画で
      // 作り直す。初回は空なので何も起きず、古い文脈のオブジェクトの削除は WebGL が黙って
      // 無視する。
      cache.dispose(gl)
      vertexBuf = gl.createBuffer() as WebGLBuffer
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuf)
      gl.bufferData(gl.ARRAY_BUFFER, grid.vertices, gl.STATIC_DRAW)
      indexBuf = gl.createBuffer() as WebGLBuffer
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.indices, gl.STATIC_DRAW)
    },
    render: guardRender(LYR, LABEL, (gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput) => {
      if (!visible) return
      const prog = cache.get(gl, args)
      if (!prog) {
        // **用意できないことを画面へ出す**（docs/spec/map-rendering-spec.md §16）。キャッシュ側が
        // 残すのはコンソールだけで、ここは例外を投げないので `guardRender` の検出にも掛からない。
        // 黙ると、夜の側が出ないまま利用者にも開発者にも痕跡が残らない。
        if (!warnedDisabled) {
          warnedDisabled = true
          log.error('[day-night] シェーダーを用意できず、夜の側の描画を止めています')
        }
        brokenReported = true
        reportRenderFailure(LYR, LABEL, 'draw')
        return
      }
      if (brokenReported) {
        // 投影が切り替わってプログラムを作り直せたら通ることがある。**直ったら画面から消す。**
        brokenReported = false
        clearRenderFailure(LYR, 'draw')
      }

      gl.useProgram(prog.program)
      applyProjectionUniforms(gl, prog.u, args)
      gl.uniform1f(prog.u.u_sinSunLat, sun.sinLat)
      gl.uniform1f(prog.u.u_cosSunLat, sun.cosLat)
      gl.uniform1f(prog.u.u_sunLonRad, sun.lonRad)
      gl.uniform1f(prog.u.u_nightOpacity, nightOpacity)
      gl.uniform3f(prog.u.u_color, NIGHT_COLOR[0], NIGHT_COLOR[1], NIGHT_COLOR[2])
      gl.uniform1f(prog.u.u_dither, DITHER_AMPLITUDE)

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied over

      const stride = FLOATS_PER_VERTEX * 4
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuf)
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0)
      gl.enableVertexAttribArray(aLonLat)
      gl.vertexAttribPointer(aLonLat, 2, gl.FLOAT, false, stride, 8)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf)
      gl.drawElements(gl.TRIANGLES, grid.indexCount, gl.UNSIGNED_SHORT, 0)

      // GL 状態を復元（CustomLayerInterface の作法）。
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
      gl.disable(gl.BLEND)
      gl.disableVertexAttribArray(aPos)
      gl.disableVertexAttribArray(aLonLat)
    }),
    onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext) {
      // **画面から外れたら不調の記録も消す**（docs/spec/map-rendering-spec.md §16）。
      clearRenderFailure(LYR, 'draw')
      // **2 つとも戻す。** 片方だけ残すと、次に載せたとき症状が変わっても包括のログが
      // 二度と出ない（詳細は `gl/projectionProgram.ts` が投影ごとに残す）。
      brokenReported = false
      warnedDisabled = false
      cache.dispose(gl)
      gl.deleteBuffer(vertexBuf)
      gl.deleteBuffer(indexBuf)
    },
  }

  return {
    layer,
    setTime(epochMs: number): boolean {
      return applyTime(epochMs)
    },
    setNightOpacity(opacity: number): void {
      nightOpacity = opacity
    },
    setVisible(v: boolean): void {
      visible = v
    },
  }
}
