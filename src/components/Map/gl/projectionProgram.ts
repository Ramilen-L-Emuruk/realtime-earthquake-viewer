import type { CustomRenderMethodInput } from 'maplibre-gl'
import { log } from '../../../utils/logger'

// MapLibre の投影シェーダーを取り込んだ WebGL プログラムを、投影ごとに用意して使い回す。
//
// **地図は投影を 1 つに固定できない。** 地球儀（globe）で表示していても、寄っていくと MapLibre が
// 自動で Mercator へ切り替える（実測では zoom 11 前後）。切り替わると `shaderData` の中身が丸ごと
// 変わるため、`u_projection_matrix` に行列を入れるだけの実装は、どちらか片方でしか正しく描けない。
//
// MapLibre はこれを見越して、custom レイヤーへ**投影ごとの GLSL 断片**（`vertexShaderPrelude`）を
// 渡してくる。これを頂点シェーダーの先頭へ貼ると `projectTile()` と `projectTileFor3D()` が
// 使えるようになり、投影の違いは MapLibre 側が吸収する。どの断片が来たかは `variantName` で
// 見分けられるので、ここではそれをキーにプログラムを作り分けて保持する。
//
// **注意: `projectTileFor3D` の elevation の単位は投影で違う。**
// globe では「メートル」、Mercator では「Mercator 座標系の z」。呼び出す側が `#ifdef GLOBE` で
// 出し分けること（gl/depthPointLayer.ts が実例）。

/**
 * `vertexShaderPrelude` が宣言する uniform。
 *
 * Mercator では `u_projection_matrix` しか宣言されないため、残り 4 つの
 * `getUniformLocation` は null になる。**null 宛ての `uniform*` 呼び出しは WebGL の仕様上
 * 何もしないので、投影ごとに送り分ける必要はない。**
 */
export const PROJECTION_UNIFORMS = [
  'u_projection_matrix',
  'u_projection_tile_mercator_coords',
  'u_projection_clipping_plane',
  'u_projection_transition',
  'u_projection_fallback_matrix',
] as const

export type ProjectionUniform = (typeof PROJECTION_UNIFORMS)[number]

/** uniform 名 → ロケーション。見つからなければ null（Mercator では 4 つが null になる）。 */
export type UniformLocations<K extends string> = Record<K, WebGLUniformLocation | null>

/** 投影シェーダーを取り込んだプログラムと、その uniform ロケーション。 */
export interface ProjectionProgram<K extends string> {
  program: WebGLProgram
  u: UniformLocations<K | ProjectionUniform>
}

export interface ProjectionProgramSpec<K extends string> {
  /** ログに出す識別子。どのレイヤーで失敗したかを追えるようにする。 */
  label: string
  /**
   * 頂点シェーダーを組み立てる。`prelude` と `define` をそのまま先頭へ貼ること。
   *
   * **prelude は `const float PI` を宣言する。** 同じ名前を自前で宣言すると再定義エラーになる。
   */
  makeVertexSource(prelude: string, define: string): string
  fragmentSource: string
  /**
   * 属性名。**並び順がそのままロケーション番号になる**（リンク前に固定する）。
   *
   * 投影が切り替わるとプログラムは別物になるが、ここで番号を固定しておけば
   * **VAO を投影ごとに作り直さずに済む**。
   */
  attributes: readonly string[]
  /** 自前の uniform 名。投影側の 5 つは自動で加わる。 */
  uniforms: readonly K[]
}

/**
 * 投影ごとのプログラムを抱えるキャッシュ。
 *
 * 失敗した場合も結果（null）を覚える。**覚えないと毎フレーム作り直しに行き、
 * コンパイルエラーのログでコンソールが埋まる。**
 */
export interface ProjectionProgramCache<K extends string> {
  /** いまの投影に合うプログラムを返す。用意できなければ null。 */
  get(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): ProjectionProgram<K> | null
  /** 抱えているプログラムをすべて解放する（`onRemove` で呼ぶ）。 */
  dispose(gl: WebGL2RenderingContext): void
}

function compile(gl: WebGL2RenderingContext, label: string, type: number, src: string): WebGLShader {
  const s = gl.createShader(type) as WebGLShader
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    // **ソースも残す。** 頂点シェーダーは投影ごとに組み立てるため、どの断片と繋いだ結果が
    // 落ちたのかが判らないと再現できない。
    log.error(`[${label}] shader compile failed`, gl.getShaderInfoLog(s), src)
  }
  return s
}

export function createProjectionProgramCache<K extends string>(
  spec: ProjectionProgramSpec<K>,
): ProjectionProgramCache<K> {
  const byVariant = new Map<string, ProjectionProgram<K> | null>()

  return {
    get(gl, args) {
      const { variantName, vertexShaderPrelude, define } = args.shaderData
      const cached = byVariant.get(variantName)
      if (cached !== undefined) return cached

      const tag = `${spec.label}:${variantName}`
      const vs = compile(gl, tag, gl.VERTEX_SHADER, spec.makeVertexSource(vertexShaderPrelude, define))
      const fs = compile(gl, tag, gl.FRAGMENT_SHADER, spec.fragmentSource)
      const program = gl.createProgram() as WebGLProgram
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      // **リンク前に属性の番号を固定する。** 投影が切り替わるとプログラムは別物になるが、
      // 番号が揃っていれば VAO はそのまま使える。
      spec.attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name))
      gl.linkProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        // **リンクに失敗したプログラムを返してはならない。** WebGL は未リンクのプログラムへの
        // `useProgram` で例外を投げず、直前の別レイヤーのシェーダーが残ったまま描画が走る。
        log.error(`[${tag}] program link failed`, gl.getProgramInfoLog(program))
        gl.deleteProgram(program)
        byVariant.set(variantName, null)
        return null
      }

      const u = {} as UniformLocations<K | ProjectionUniform>
      // 投影側の 5 つは Mercator で 4 つが null になるのが正常なので、黙って引く。
      for (const name of PROJECTION_UNIFORMS) u[name] = gl.getUniformLocation(program, name)
      // **呼び出し側の uniform が null なら記録する。** 名前が GLSL と 1 文字でも食い違うと
      // `getUniformLocation` は静かに null を返し、以後の `uniform*` は何もしない——
      // コンパイルもリンクも通るのに、その値だけが既定のまま効かなくなる。
      // （GLSL 側で最適化により消えた場合も null になるため、常に不具合とは限らない）
      for (const name of spec.uniforms) {
        const loc = gl.getUniformLocation(program, name)
        if (loc === null) log.warn(`[${tag}] uniform ${name} が見つかりません（名前の食い違いか未使用）`)
        u[name] = loc
      }
      const built: ProjectionProgram<K> = { program, u }
      byVariant.set(variantName, built)
      return built
    },

    dispose(gl) {
      for (const p of byVariant.values()) if (p) gl.deleteProgram(p.program)
      byVariant.clear()
    },
  }
}

// 行列は Float64Array で来ることがある（ProjectionMatrix = Mat4f32 | Mat4f64）。
// WebGL へ渡せるのは Float32Array なので、毎回の確保を避けて使い回す。
const mainScratch = new Float32Array(16)
const fallbackScratch = new Float32Array(16)

/** 投影側の uniform をまとめて送る。プログラムを `useProgram` した後に呼ぶ。 */
export function applyProjectionUniforms(
  gl: WebGL2RenderingContext,
  u: UniformLocations<ProjectionUniform>,
  args: CustomRenderMethodInput,
): void {
  const d = args.defaultProjectionData
  mainScratch.set(d.mainMatrix)
  gl.uniformMatrix4fv(u.u_projection_matrix, false, mainScratch)
  gl.uniform4fv(u.u_projection_tile_mercator_coords, d.tileMercatorCoords)
  gl.uniform4fv(u.u_projection_clipping_plane, d.clippingPlane)
  gl.uniform1f(u.u_projection_transition, d.projectionTransition)
  fallbackScratch.set(d.fallbackMatrix)
  gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, fallbackScratch)
}
