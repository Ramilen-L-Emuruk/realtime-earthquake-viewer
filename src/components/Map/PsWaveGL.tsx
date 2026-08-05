import { useEffect, useRef } from 'react'
import type { CustomLayerInterface } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { PsWaveCircle } from '../../services/kyoshin'
import { computeSWaveRadiusAtTime, computeSWaveTravelTimeSec } from '../../hooks/usePsWaveCalc'
import { calcShakingDurationSec, S_WAVE_FALLBACK_KM_PER_SEC } from '../../utils/eew'
import { addOrderedLayer } from './gl/layerOrder'

// 緊急地震速報の予報円（S波=塗りつぶし＋後端フェード / P波=破線外周）を描画する MapLibre 版
// （Leaflet 版 PsWaveLayer 相当）。円弧・グラデーションは Canvas2D で描く方が素直なため、
// 素の <canvas> にこれまで通り 2D で描画したうえで、MapLibre の CustomLayerInterface として
// GL レイヤースタックに登録し、毎フレームその canvas を WebGL テクスチャとして全画面クアッドに
// 貼り付ける。DOM の上に直接 <canvas> を重ねる方式（旧実装）だと GL キャンバス全体より必ず
// 前面に出てしまい、観測点ドットやラベル文字より前に予報円が乗ってしまうため、
// MAP_LAYER_ORDER の pswave スロット（tsunami-lines より前面・観測点よりは背面）へ
// 正しく差し込めるこの方式に変更した。

// 後端フェード（揺れ継続時間を過ぎた領域）の幅パラメータ（Leaflet 版と一致）。
const TRAILING_EDGE_FADE_RATIO = 0.2
const TRAILING_EDGE_FADE_MIN_KM = 15
const LYR = 'pswave'

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = (aPos + 1.0) * 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vUv);
}`

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type) as WebGLShader
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  return shader
}

function buildProgram(gl: WebGLRenderingContext): WebGLProgram {
  const program = gl.createProgram() as WebGLProgram
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERT_SRC))
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC))
  gl.linkProgram(program)
  return program
}

interface Props {
  psWave: PsWaveCircle[]
}

export function PsWaveGL({ psWave }: Props) {
  const map = useMapGL()
  const psWaveRef = useRef<PsWaveCircle[]>(psWave)
  const triggerRef = useRef<(() => void) | null>(null)
  psWaveRef.current = psWave

  useEffect(() => {
    if (!map) return

    // 予報円そのものは DOM に置かず、GL テクスチャの供給源としてのみ使う。
    const canvas2d = document.createElement('canvas')
    const ctx2d = canvas2d.getContext('2d') as CanvasRenderingContext2D

    const draw2d = () => {
      const container = map.getContainer()
      const w = container.clientWidth
      const h = container.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      if (canvas2d.width !== w * dpr || canvas2d.height !== h * dpr) {
        canvas2d.width = w * dpr
        canvas2d.height = h * dpr
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx2d.clearRect(0, 0, w, h)

      for (const c of psWaveRef.current) {
        const center = map.project([c.lng, c.lat])
        // 東方向（同一緯度）で km→px 変換（北方向だと Mercator のスケール係数が緯度で変動するため）。
        const cosLat = Math.cos((c.lat * Math.PI) / 180)

        if (c.sRadius > 0) {
          const durationSec = calcShakingDurationSec(c.magnitude, c.sRadius)
          let sInnerRadiusKm = 0
          if (c.depth !== undefined) {
            const tNow = computeSWaveTravelTimeSec(c.sRadius, c.depth)
            const tTrailing = tNow - durationSec
            sInnerRadiusKm = tTrailing > 0 ? computeSWaveRadiusAtTime(tTrailing, c.depth) : 0
          } else {
            sInnerRadiusKm = Math.max(0, c.sRadius - S_WAVE_FALLBACK_KM_PER_SEC * durationSec)
          }

          const lonOffsetS = (c.sRadius * 1000) / (111320 * cosLat)
          const edgeS = map.project([c.lng + lonOffsetS, c.lat])
          const sPx = Math.abs(edgeS.x - center.x)

          ctx2d.setLineDash([])
          ctx2d.strokeStyle = '#ff3c00'
          ctx2d.lineWidth = 2

          if (sInnerRadiusKm > 0 && sInnerRadiusKm < c.sRadius) {
            const lonOffsetInner = (sInnerRadiusKm * 1000) / (111320 * cosLat)
            const edgeInner = map.project([c.lng + lonOffsetInner, c.lat])
            const innerPx = Math.abs(edgeInner.x - center.x)
            const fadeWidthKm = Math.max(TRAILING_EDGE_FADE_MIN_KM, c.sRadius * TRAILING_EDGE_FADE_RATIO)
            const lonOffsetFadeOuter = ((sInnerRadiusKm + fadeWidthKm) * 1000) / (111320 * cosLat)
            const edgeFadeOuter = map.project([c.lng + lonOffsetFadeOuter, c.lat])
            const fadeOuterPx = Math.min(Math.abs(edgeFadeOuter.x - center.x), sPx)
            const gradient = ctx2d.createRadialGradient(center.x, center.y, innerPx, center.x, center.y, fadeOuterPx)
            gradient.addColorStop(0, 'rgba(255, 60, 0, 0)')
            gradient.addColorStop(1, 'rgba(255, 60, 0, 0.12)')
            ctx2d.fillStyle = gradient
          } else {
            ctx2d.fillStyle = 'rgba(255, 60, 0, 0.12)'
          }

          ctx2d.beginPath()
          ctx2d.arc(center.x, center.y, sPx, 0, Math.PI * 2)
          ctx2d.fill()
          ctx2d.stroke()
        }

        if (c.pRadius > 0) {
          const lonOffsetP = (c.pRadius * 1000) / (111320 * cosLat)
          const edgeP = map.project([c.lng + lonOffsetP, c.lat])
          const pPx = Math.abs(edgeP.x - center.x)
          ctx2d.setLineDash([4, 4])
          ctx2d.strokeStyle = '#38bdf8'
          ctx2d.lineWidth = 2
          ctx2d.beginPath()
          ctx2d.arc(center.x, center.y, pPx, 0, Math.PI * 2)
          ctx2d.stroke()
        }
      }
    }

    let program: WebGLProgram | null = null
    let posBuffer: WebGLBuffer | null = null
    let texture: WebGLTexture | null = null
    let uTexLoc: WebGLUniformLocation | null = null
    let aPosLoc = -1

    const customLayer: CustomLayerInterface = {
      id: LYR,
      type: 'custom',
      renderingMode: '2d',
      onAdd(_m, gl) {
        program = buildProgram(gl)
        aPosLoc = gl.getAttribLocation(program, 'aPos')
        uTexLoc = gl.getUniformLocation(program, 'uTex')
        posBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
        texture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      },
      render(gl) {
        if (!program || !texture || !posBuffer) return
        draw2d()
        if (canvas2d.width === 0 || canvas2d.height === 0) return

        gl.useProgram(program)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        // キャンバス上端（行0）を画面上端に正しく合わせる（既定は下端基準のため反転させる）。
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas2d)
        gl.uniform1i(uTexLoc, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer)
        gl.enableVertexAttribArray(aPosLoc)
        gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.disableVertexAttribArray(aPosLoc)
        gl.disable(gl.BLEND)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      },
      onRemove(_m, gl) {
        if (program) gl.deleteProgram(program)
        if (posBuffer) gl.deleteBuffer(posBuffer)
        if (texture) gl.deleteTexture(texture)
        program = null
        posBuffer = null
        texture = null
      },
    }

    addOrderedLayer(map, customLayer)
    const requestRepaint = () => map.triggerRepaint()
    triggerRef.current = requestRepaint
    map.on('move', requestRepaint)
    map.on('resize', requestRepaint)
    requestRepaint()

    return () => {
      map.off('move', requestRepaint)
      map.off('resize', requestRepaint)
      triggerRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
    }
  }, [map])

  // データ更新時にも再描画をリクエスト（CustomLayer の render は camera 変化時にしか
  // 自動で呼ばれないため、triggerRepaint で明示的に次フレームの描画を予約する）。
  useEffect(() => {
    triggerRef.current?.()
  }, [psWave])

  return null
}
